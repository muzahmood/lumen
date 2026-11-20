// @vitest-environment jsdom
/**
 * How the API client (src/lib/api.ts) reads the server's answers, apart from encryption itself: what
 * counts as offline (retried), as a refusal, or as the sign-in session ending; the shared budget for
 * requests that outlive the page; and only ever taking the item that was asked for.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encryptText, newMasterKey } from '../../src/lib/crypto';

let apiMod: typeof import('../../src/lib/api');
let api: typeof import('../../src/lib/api')['api'];

const NOW = 1_700_000_000_000;

interface Call {
  path: string;
  init: RequestInit;
}
let calls: Call[] = [];
/** The next answers, in order; a function is called with the request. */
let answers: Array<Response | Error | ((c: Call) => Promise<Response>)> = [];

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const meta = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  folder_id: null,
  title: 'T',
  excerpt: '',
  info: {},
  tags: [],
  pinned: false,
  version: 1,
  created_at: NOW,
  updated_at: NOW,
  deleted_at: null,
  ...extra,
});

beforeEach(async () => {
  localStorage.clear();
  calls = [];
  answers = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (path: string, init: RequestInit = {}) => {
      const call = { path, init };
      calls.push(call);
      const next = answers.shift();
      if (!next) return json(200, { ok: true });
      if (next instanceof Error) throw next;
      return typeof next === 'function' ? next(call) : next;
    }),
  );
  vi.resetModules();
  apiMod = await import('../../src/lib/api');
  api = apiMod.api;
});

afterEach(() => {
  apiMod.setCodec(null);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('what counts as offline', () => {
  it('a request that never reaches the server is a dropped connection, and the app hears it’s unreachable until one gets through', async () => {
    const heard: boolean[] = [];
    apiMod.onReachabilityChange((r) => heard.push(r));
    answers = [new TypeError('Failed to fetch'), new TypeError('Failed to fetch'), json(200, { results: [] })];
    await expect(api.searchServer('x', 5)).rejects.toBeInstanceOf(apiMod.NetworkError);
    await expect(api.searchServer('x', 5)).rejects.toBeInstanceOf(apiMod.NetworkError);
    await api.searchServer('x', 5);
    expect(heard).toEqual([false, true]);
  });

  it('an answer from the offline page of the service worker counts as unreachable', async () => {
    const heard: boolean[] = [];
    apiMod.onReachabilityChange((r) => heard.push(r));
    answers = [json(200, { results: [] }, { 'x-kb-offline': '1' })];
    await api.searchServer('x', 5);
    expect(heard).toEqual([false]);
  });

  it('a reply cut off partway is a dropped connection too', async () => {
    answers = [new Response('{"id":"a","tit', { status: 200, headers: { 'content-type': 'application/json' } })];
    await expect(api.getNote('a')).rejects.toBeInstanceOf(apiMod.NetworkError);
  });

  it('a request that hangs is given up after a while as a dropped connection', async () => {
    const timer = new AbortController();
    vi.spyOn(AbortSignal, 'timeout').mockReturnValue(timer.signal);
    answers = [
      ({ init }) =>
        new Promise((_, reject) => {
          init.signal!.addEventListener('abort', () => reject(init.signal!.reason));
        }),
    ];
    const pending = api.updateNote('a', { content: 'x' });
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    timer.abort(new DOMException('timed out', 'TimeoutError'));
    await expect(pending).rejects.toBeInstanceOf(apiMod.NetworkError);
  });

  it('a request the app cancels itself stays a cancellation, and says nothing about the connection', async () => {
    const heard: boolean[] = [];
    apiMod.onReachabilityChange((r) => heard.push(r));
    const ctl = new AbortController();
    answers = [
      ({ init }) =>
        new Promise((_, reject) => {
          init.signal!.addEventListener('abort', () => reject(init.signal!.reason));
        }),
    ];
    const pending = api.searchServer('x', 5, ctl.signal);
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    ctl.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(heard).toEqual([]);
  });
});

describe('the sign-in session ending', () => {
  it('is a 401, a redirect to the sign-in page, or a sign-in page in place of JSON', async () => {
    const ended = vi.fn();
    apiMod.onAuthExpired(ended);
    answers = [
      new Response('', { status: 401 }),
      { type: 'opaqueredirect', status: 0, ok: false, headers: new Headers() } as unknown as Response,
      new Response('<html>Sign in</html>', { status: 200, headers: { 'content-type': 'text/html' } }),
    ];
    for (let i = 0; i < 3; i++) await expect(api.getNote('a')).rejects.toMatchObject({ status: 401, code: 'auth' });
    expect(ended).toHaveBeenCalledTimes(3);
  });

  it('isn’t an error page from Cloudflare itself, which is a passing server problem', async () => {
    const ended = vi.fn();
    apiMod.onAuthExpired(ended);
    answers = [new Response('<html>Bad gateway</html>', { status: 502, headers: { 'content-type': 'text/html' } })];
    await expect(api.getNote('a')).rejects.toMatchObject({ status: 502, code: 'http' });
    expect(ended).not.toHaveBeenCalled();
  });
});

describe('the server’s refusals', () => {
  it('carry its code, message and the data that came with them', async () => {
    answers = [json(409, { error: 'conflict', message: 'Changed elsewhere.', note: { ...meta('a'), content: 'theirs' } })];
    const err = await api.updateNote('a', { content: 'x', baseVersion: 1 }).catch((e) => e);
    expect(err).toBeInstanceOf(apiMod.ApiError);
    expect(err).toMatchObject({ status: 409, code: 'conflict', message: 'Changed elsewhere.' });
    expect(err.data.note.content).toBe('theirs');
  });

  it('tell the app when encryption was turned on elsewhere, or the key was replaced', async () => {
    const required = vi.fn();
    const changed = vi.fn();
    apiMod.onEncryptionRequired(required);
    apiMod.onKeyChanged(changed);
    answers = [json(403, { error: 'encryption_required', message: 'x' }), json(409, { error: 'key_changed', message: 'y' })];
    await expect(api.updateNote('a', { content: 'x' })).rejects.toMatchObject({ code: 'encryption_required' });
    await expect(api.updateNote('a', { content: 'x' })).rejects.toMatchObject({ code: 'key_changed' });
    expect(required).toHaveBeenCalledTimes(1);
    expect(changed).toHaveBeenCalledTimes(1);
  });
});

describe('requests that outlive the page', () => {
  it('share one budget: a save that doesn’t fit goes as a normal request', async () => {
    const big = 'x'.repeat(15_000); // counted as up to 45,000 bytes
    let release!: () => void;
    answers = [() => new Promise((r) => (release = () => r(json(200, meta('a'))))), json(200, meta('b'))];
    const first = api.updateNote('a', { content: big }, { keepalive: true });
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    await api.updateNote('b', { content: big }, { keepalive: true });
    expect(calls.map((c) => !!c.init.keepalive)).toEqual([true, false]);
    release();
    await first;
    // Once the first is done, its share is free again.
    answers = [json(200, meta('c'))];
    await api.updateNote('c', { content: big }, { keepalive: true });
    expect(calls[2].init.keepalive).toBe(true);
  });

  it('frees a request’s share when it fails too', async () => {
    const big = 'x'.repeat(15_000);
    answers = [new TypeError('Failed to fetch'), json(200, meta('a'))];
    await expect(api.updateNote('a', { content: big }, { keepalive: true })).rejects.toBeInstanceOf(apiMod.NetworkError);
    await api.updateNote('a', { content: big }, { keepalive: true });
    expect(calls.map((c) => !!c.init.keepalive)).toEqual([true, true]);
  });
});

describe('the item asked for, and only that', () => {
  it('takes from a batch only the notes asked for', async () => {
    answers = [json(200, { notes: [{ ...meta('a'), content: '' }, { ...meta('zzz'), content: '' }, null, { id: 7 }] })];
    expect((await api.rawNotes(['a', 'b'])).map((n) => n.id)).toEqual(['a']);
    expect(JSON.parse(calls[0].init.body as string)).toEqual({ ids: ['a', 'b'] });
  });

  it('asks nothing for an empty batch', async () => {
    expect(await api.rawNotes([])).toEqual([]);
    expect(calls).toEqual([]);
  });

  it('refuses a changed note, a trashed one or a restored one that isn’t the one asked for', async () => {
    answers = [json(200, meta('b')), json(200, meta('b')), json(200, meta('b'))];
    await expect(api.updateNote('a', { pinned: true })).rejects.toMatchObject({ code: 'wrong_item' });
    await expect(api.trashNote('a')).rejects.toMatchObject({ code: 'wrong_item' });
    await expect(api.restoreNote('a')).rejects.toMatchObject({ code: 'wrong_item' });
  });

  it('in an encrypted library, refuses a new note answered under another id than the one chosen for it', async () => {
    const e2ee = await import('../../src/lib/e2ee');
    apiMod.setCodec(e2ee.createCodec(await newMasterKey()));
    answers = [json(200, meta('someone-else'))];
    await expect(api.createNote({ title: 'x', content: 'y' })).rejects.toMatchObject({ code: 'wrong_item' });
  });

  it('in an encrypted library, doesn’t show another note’s text as the version a conflict is with', async () => {
    const k = await newMasterKey();
    const e2ee = await import('../../src/lib/e2ee');
    apiMod.setCodec(e2ee.createCodec(k));
    const other = { ...meta('b', { enc: true }), content: await encryptText(k, 'other note', 'lumen/1/note/b/content'), sealed: {} };
    answers = [json(409, { error: 'conflict', message: 'Changed elsewhere.', note: other })];
    const err = await api.updateNote('a', { content: 'x', baseVersion: 1 }).catch((e) => e);
    expect(err).toMatchObject({ code: 'conflict' });
    expect(err.data.note).toBeUndefined();
  });

  it('deletes a note left empty only at the version given', async () => {
    answers = [json(200, { ok: true, deleted: false })];
    expect(await api.deleteNote('a', { ifVersion: 1 })).toEqual({ ok: true, deleted: false });
    expect(calls[0].path).toBe('/api/notes/a?ifVersion=1');
    expect(calls[0].init.method).toBe('DELETE');
  });

  it('sends a search’s words encoded, with its limit', async () => {
    answers = [json(200, { results: [] })];
    await api.searchServer('a&b "c d" #e', 7);
    expect(calls[0].path).toBe(`/api/search?q=${encodeURIComponent('a&b "c d" #e')}&limit=7`);
  });
});

describe('opening a note offline', () => {
  it('falls back to the copy on the device only when the server can’t be reached', async () => {
    const offline = vi.fn(async (id: string) => ({ ...meta(id), content: 'kept here' }));
    apiMod.setNoteHooks({ fetched: () => undefined, offline });
    answers = [new TypeError('Failed to fetch'), json(404, { error: 'not_found', message: 'Note not found.' })];
    expect((await api.getNote('a')).content).toBe('kept here');
    await expect(api.getNote('a')).rejects.toMatchObject({ code: 'not_found' });
    expect(offline).toHaveBeenCalledTimes(1);
  });

  it('still says offline when there’s no copy on the device either', async () => {
    apiMod.setNoteHooks({ fetched: () => undefined, offline: async () => null });
    answers = [new TypeError('Failed to fetch')];
    await expect(api.getNote('a')).rejects.toBeInstanceOf(apiMod.NetworkError);
  });

  it('tells the on-device copy about every note fetched', async () => {
    const fetched = vi.fn();
    apiMod.setNoteHooks({ fetched, offline: async () => null });
    answers = [json(200, { ...meta('a'), content: 'hello' })];
    await api.getNote('a');
    expect(fetched).toHaveBeenCalledWith(expect.objectContaining({ id: 'a', content: 'hello' }));
  });
});

describe('the library’s encryption state', () => {
  const boot = (on: boolean, pending: number, gen = 0) => ({
    me: {},
    notes: [],
    folders: [],
    encryption: { on, gen, pending: { notes: pending, versions: 0, folders: 0 }, rekey: { notes: 0, versions: 0, folders: 0 } },
  });

  it('is remembered as fully encrypted only once nothing is left in plaintext', async () => {
    answers = [json(200, boot(true, 3)), json(200, boot(false, 0)), json(200, boot(true, 0))];
    await api.bootstrap();
    expect(apiMod.libraryEncrypted()).toBe(false);
    await api.bootstrap();
    expect(apiMod.libraryEncrypted()).toBe(false);
    await api.bootstrap();
    expect(apiMod.libraryEncrypted()).toBe(true);
    expect(localStorage.getItem('kb.vault.sealed')).toBe('1');
  });

  it('notices the key was replaced on another device, from the note list or a note written in a newer key', async () => {
    const e2ee = await import('../../src/lib/e2ee');
    apiMod.setCodec(e2ee.createCodec(await newMasterKey()));
    apiMod.setKeyGen(1);
    const changed = vi.fn();
    apiMod.onKeyChanged(changed);
    answers = [json(200, boot(true, 0, 2))];
    await api.bootstrap();
    expect(changed).toHaveBeenCalledTimes(1);
    await expect(api.openRaw({ ...meta('a'), enc: true, kgen: 2, content: 'e1:x' } as never)).rejects.toMatchObject({ code: 'key_changed' });
    expect(changed).toHaveBeenCalledTimes(2);
  });
});
