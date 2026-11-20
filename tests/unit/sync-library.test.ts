// @vitest-environment jsdom
/**
 * The copy of every note on this device (src/lib/library.ts, src/lib/localStore.ts): in memory
 * decrypted, on disk (IndexedDB "lumen-notes") exactly as the server sent it, and only for an
 * encrypted library, only in the current key. A new session asks the server only for notes whose
 * version moved on. Also what's built on it: changing a note's text from outside its editor
 * (src/lib/liveEdit.ts) never pairs older text with a newer version.
 */
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { encryptText, newMasterKey } from '../../src/lib/crypto';

window.matchMedia ??= ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;

const NOW = 1_700_000_000_000;

let apiMod: typeof import('../../src/lib/api');
let store: typeof import('../../src/lib/store');
let saver: typeof import('../../src/lib/saver');
let library: typeof import('../../src/lib/library');
let local: typeof import('../../src/lib/localStore');
let liveEdit: typeof import('../../src/lib/liveEdit');
let e2ee: typeof import('../../src/lib/e2ee');
let key: CryptoKey;
let otherKey: CryptoKey;
let tabSeq = 0;

/* --------------------------------------------------- stand-in server --- */

interface Row {
  id: string;
  folder_id: string | null;
  title: string;
  excerpt: string;
  info: Record<string, unknown>;
  tags: string[];
  pinned: boolean;
  version: number;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
  content: string;
  enc?: boolean;
  sealed?: Record<string, string>;
  kgen?: number;
}
interface Req {
  method: string;
  path: string;
  body: Record<string, any> | undefined;
}

const rows = new Map<string, Row>();
let log: Req[] = [];
let intercept: ((req: Req) => Promise<Response | undefined>) | null = null;

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const metaOf = ({ content: _c, ...meta }: Row) => meta;
const raw = (r: Row) => ({ ...r, ...(r.enc ? { kgen: r.kgen ?? 0 } : {}) });

function serve(req: Req): Response {
  const b = req.body ?? {};
  const one = /^\/api\/notes\/([^/]+)$/.exec(req.path);
  if (req.method === 'POST' && req.path === '/api/notes/batch') {
    return json(200, { notes: (b.ids as string[]).filter((id) => rows.has(id)).map((id) => raw(rows.get(id)!)) });
  }
  if (req.method === 'GET' && req.path === '/api/bootstrap') {
    return json(200, {
      me: {},
      notes: [...rows.values()].map((r) => metaOf(raw(r))),
      folders: [],
      encryption: { on: true, gen: 0, pending: { notes: 0, versions: 0, folders: 0 }, rekey: { notes: 0, versions: 0, folders: 0 } },
    });
  }
  if (one && req.method === 'GET') {
    const row = rows.get(one[1]);
    return row ? json(200, raw(row)) : json(404, { error: 'not_found', message: 'Note not found.' });
  }
  if (one && req.method === 'PATCH') {
    const row = rows.get(one[1]);
    if (!row) return json(404, { error: 'not_found', message: 'Note not found.' });
    const textChanged = typeof b.content === 'string' || b.sealed?.t !== undefined;
    if (textChanged && typeof b.baseVersion === 'number' && b.baseVersion !== row.version && !b.force) {
      return json(409, { error: 'conflict', message: 'Changed on another device.', note: raw(row) });
    }
    if (typeof b.content === 'string') row.content = b.content;
    if (b.sealed) row.sealed = { ...row.sealed, ...b.sealed };
    if (textChanged) row.version++;
    return json(200, metaOf(row));
  }
  return json(404, { error: 'no_route', message: 'No such route.' });
}

async function fakeFetch(input: string, init: RequestInit = {}) {
  const url = new URL(input, 'http://localhost');
  const req: Req = { method: init.method ?? 'GET', path: url.pathname, body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined };
  log.push(req);
  return (intercept ? await intercept(req) : undefined) ?? serve(req);
}

const batches = () => log.filter((r) => r.path === '/api/notes/batch').map((r) => r.body!.ids as string[]);
const fetchedIds = () => batches().flat().sort();

/* ------------------------------------------------------- the device --- */

const at = (id: string, f: string) => `lumen/1/note/${id}/${f}`;

/** An encrypted note on the server (in `k`, at key generation `kgen`), listed on this device. */
async function seed(id: string, content: string, opts: { title?: string; version?: number; kgen?: number; k?: CryptoKey; plain?: boolean; tags?: string[]; folder_id?: string | null } = {}) {
  const title = opts.title ?? `Note ${id}`;
  const k = opts.k ?? key;
  const base: Row = {
    id,
    folder_id: opts.folder_id ?? null,
    title: '',
    excerpt: '',
    info: {},
    tags: [],
    pinned: false,
    version: opts.version ?? 1,
    created_at: NOW,
    updated_at: NOW,
    deleted_at: null,
    content,
  };
  rows.set(
    id,
    opts.plain
      ? { ...base, title, tags: opts.tags ?? [], enc: false }
      : {
          ...base,
          enc: true,
          kgen: opts.kgen ?? 0,
          content: await encryptText(k, content, at(id, 'content')),
          sealed: {
            t: await encryptText(k, title, at(id, 'title')),
            g: await encryptText(k, JSON.stringify(opts.tags ?? []), at(id, 'tags')),
            p: await encryptText(k, JSON.stringify({ v: 6, e: content.slice(0, 40), i: {}, l: { n: [], w: [] } }), at(id, 'preview')),
          },
        },
  );
  // As the note list shows it once decrypted.
  store.upsertMeta({ ...metaOf(base), title, tags: opts.tags ?? [], excerpt: content.slice(0, 40) } as never);
}

/** Another device saved new text into a note; the list here has heard of the new version. */
async function savedElsewhere(id: string, content: string) {
  const row = rows.get(id)!;
  row.content = await encryptText(key, content, at(id, 'content'));
  row.version++;
  store.upsertMeta({ ...store.useApp.getState().notes[id], version: row.version });
}

const docText = (id: string) => library.libraryDocs().get(id)?.content;
const onDisk = async () => new Map((await local.readAll()).map((r) => [r.id, r]));

async function loadModules() {
  apiMod = await import('../../src/lib/api');
  store = await import('../../src/lib/store');
  saver = await import('../../src/lib/saver');
  local = await import('../../src/lib/localStore');
  library = await import('../../src/lib/library');
  liveEdit = await import('../../src/lib/liveEdit');
  e2ee = await import('../../src/lib/e2ee');
}

/** Unlocks this device (a codec for `k`, at key generation `gen`) and marks the list loaded. */
function unlock(k: CryptoKey = key, gen = 0, older: CryptoKey[] = []) {
  apiMod.setKeyGen(gen);
  apiMod.setCodec(e2ee.createCodec(k, older));
  store.useApp.setState({ status: 'ready' });
}

/** A new session on this device: everything reloaded, the disk copy kept. */
async function newSession() {
  const notes = store.useApp.getState().notes;
  saver.discardAll();
  apiMod.setCodec(null);
  vi.resetModules();
  await loadModules();
  store.useApp.setState({ notes });
  log = [];
}

async function settle(rounds = 60) {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setImmediate(r));
}

/**
 * Settles until `check` passes, for work that runs in the background with real WebCrypto: on a busy
 * machine (the build server, with the suite running alongside) it outlasts any fixed number of rounds.
 * Real time (Date isn't faked here), up to 15 s.
 */
async function settleUntil(check: () => void) {
  const start = Date.now();
  for (;;) {
    await settle(10);
    try {
      check();
      return;
    } catch (err) {
      if (Date.now() - start > 15_000) throw err;
    }
  }
}

beforeAll(async () => {
  key = await newMasterKey();
  otherKey = await newMasterKey();
});

beforeEach(async () => {
  // The library's background pass waits 4 s: only when a test moves the clock on.
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  vi.stubGlobal('indexedDB', new IDBFactory());
  vi.stubGlobal('BroadcastChannel', undefined);
  vi.stubGlobal('fetch', fakeFetch);
  localStorage.clear();
  sessionStorage.clear();
  sessionStorage.setItem('kb.tab-id', `libtab${++tabSeq}`);
  rows.clear();
  log = [];
  intercept = null;
  vi.resetModules();
  await loadModules();
});

afterEach(() => {
  saver.discardAll();
  apiMod.setCodec(null);
  store.useApp.setState({ status: 'loading', notes: {} });
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/* ------------------------------------------------------------ tests --- */

describe('the first pass in an encrypted library', () => {
  it('fetches every note a batch of at most 90 at a time, and has each one’s text decrypted', async () => {
    unlock();
    for (let i = 0; i < 95; i++) await seed(`n${String(i).padStart(3, '0')}`, `text ${i}`);
    await library.syncLibrary();
    expect(batches().map((b) => b.length)).toEqual([90, 5]);
    expect(library.libraryDocs().size).toBe(95);
    expect(docText('n042')).toBe('text 42');
  });

  it('keeps on disk exactly what the server sent: ciphertext, never the text', async () => {
    unlock();
    await seed('a', 'my secret plans', { title: 'Secret' });
    await library.syncLibrary();
    await settle();
    const disk = await onDisk();
    expect(disk.get('a')).toEqual(raw(rows.get('a')!));
    expect(JSON.stringify([...disk.values()])).not.toMatch(/secret plans|Secret/);
  });

  it('takes the text of a note open in this session from memory instead of fetching it', async () => {
    unlock();
    await seed('a', 'server text');
    store.noteCache.set('a', { ...store.useApp.getState().notes.a, content: 'opened text' });
    await library.syncLibrary();
    expect(batches()).toEqual([]);
    expect(docText('a')).toBe('opened text');
  });

  it('stops quietly offline with what it has, and finishes later', async () => {
    unlock();
    await seed('a', 'one');
    store.noteCache.set('a', { ...store.useApp.getState().notes.a, content: 'one' });
    await seed('b', 'two');
    intercept = async () => Promise.reject(new TypeError('Failed to fetch'));
    await expect(library.syncLibrary()).resolves.toBeUndefined();
    expect(docText('a')).toBe('one');
    expect(docText('b')).toBeUndefined();
    intercept = null;
    await library.syncLibrary();
    expect(docText('b')).toBe('two');
  });
});

describe('what’s kept on disk', () => {
  it('is nothing at all for a library that isn’t encrypted, and leftovers from before are removed', async () => {
    // A copy left by an encrypted session.
    unlock();
    await seed('a', 'sealed');
    await library.syncLibrary();
    await settle();
    expect((await onDisk()).size).toBe(1);
    // The library is no longer encrypted (a device that never had the key, say).
    await newSession();
    rows.clear();
    await seed('b', 'plain text', { plain: true });
    store.useApp.setState({ status: 'ready', notes: { b: store.useApp.getState().notes.b } });
    await library.syncLibrary();
    await settle();
    expect(docText('b')).toBe('plain text');
    expect((await onDisk()).size).toBe(0);
  });

  it('never includes an unencrypted row, even while unlocked', async () => {
    unlock();
    await seed('a', 'sealed');
    await seed('p', 'plaintext mid-encryption', { plain: true });
    await library.syncLibrary();
    await settle();
    expect([...(await onDisk()).keys()]).toEqual(['a']);
    // Its text is still readable here, since the library isn’t known to be fully encrypted yet.
    expect(docText('p')).toBe('plaintext mid-encryption');
  });

  it('never includes a row in a key older than the current one', async () => {
    unlock(key, 2, [otherKey]);
    await seed('cur', 'current key', { kgen: 2 });
    await seed('old', 'replaced key', { kgen: 1, k: otherKey });
    await library.syncLibrary();
    await settle();
    expect([...(await onDisk()).keys()]).toEqual(['cur']);
    // Still read (with the older key), just not kept.
    expect(docText('old')).toBe('replaced key');
  });

  it('drops a row of an older key found on disk, and fetches the note again', async () => {
    unlock(key, 2, [otherKey]);
    await seed('a', 'text');
    // A stale row written by an older version of the app, at the note's version but in key generation 1.
    await local.setMeta('gen', 2);
    await local.putMany([{ ...raw(rows.get('a')!), kgen: 1 } as never]);
    rows.get('a')!.kgen = 2;
    await library.syncLibrary();
    expect(fetchedIds()).toEqual(['a']);
    await settle();
    expect((await onDisk()).get('a')!.kgen).toBe(2);
  });

  it('is cleared when the encryption key was replaced since it was written', async () => {
    unlock(key, 0);
    await seed('a', 'text');
    await library.syncLibrary();
    await settle();
    await newSession();
    unlock(otherKey, 1, [key]);
    rows.get('a')!.kgen = 1;
    rows.get('a')!.content = await encryptText(otherKey, 'text', at('a', 'content'));
    await library.syncLibrary();
    expect(fetchedIds()).toEqual(['a']);
    expect(await local.getMeta('gen')).toBe(1);
  });

  it('drops notes that left the list, from memory and from disk', async () => {
    unlock();
    await seed('a', 'stays');
    await seed('b', 'goes');
    await library.syncLibrary();
    await settle();
    store.removeMeta('b');
    await library.syncLibrary();
    await settle();
    expect(docText('b')).toBeUndefined();
    expect([...(await onDisk()).keys()]).toEqual(['a']);
  });

  it('keeps notes the list doesn’t name while the list is the offline copy (it may lack notes made since)', async () => {
    unlock();
    await seed('a', 'listed');
    await seed('b', 'made after the offline list was fetched');
    await library.syncLibrary();
    await settle();
    store.useApp.setState({ offlineList: true });
    store.removeMeta('b');
    await library.syncLibrary();
    await settle();
    expect([...(await onDisk()).keys()].sort()).toEqual(['a', 'b']);
    store.useApp.setState({ offlineList: false });
    await library.syncLibrary();
    await settle();
    expect([...(await onDisk()).keys()]).toEqual(['a']);
  });

  it('never has a newer copy replaced by an older one (a slow answer, the service worker’s offline copy)', async () => {
    unlock();
    await seed('a', 'v1');
    await library.syncLibrary();
    await settle();
    const v1 = (await onDisk()).get('a')!;
    await savedElsewhere('a', 'v2');
    await apiMod.api.getNote('a');
    await settle();
    expect((await onDisk()).get('a')!.version).toBe(2);
    await local.putMany([v1]);
    expect((await onDisk()).get('a')!.version).toBe(2);
  });

  it('opens the copy on disk instead of the service worker’s offline copy when that one is older', async () => {
    unlock();
    await seed('a', 'v1');
    await library.syncLibrary();
    await settle();
    const swCopy = raw(rows.get('a')!);
    await savedElsewhere('a', 'saved since the offline copy was kept');
    await apiMod.api.getNote('a');
    await settle();
    // Offline: the service worker answers with the copy it kept from before.
    intercept = async (req) =>
      req.path === '/api/notes/a'
        ? new Response(JSON.stringify(swCopy), { headers: { 'content-type': 'application/json', 'x-kb-offline': '1' } })
        : undefined;
    expect(await apiMod.api.getNote('a')).toMatchObject({ version: 2, content: 'saved since the offline copy was kept' });
  });

  it('is updated when a note is fetched to be opened', async () => {
    unlock();
    await seed('a', 'v1');
    await library.syncLibrary();
    await settle();
    await savedElsewhere('a', 'v2');
    expect(await apiMod.api.getNote('a')).toMatchObject({ content: 'v2', version: 2 });
    await settle();
    expect((await onDisk()).get('a')!.version).toBe(2);
  });

  it('is gone after signing out of the device', async () => {
    unlock();
    await seed('a', 'text');
    await library.syncLibrary();
    await settle();
    await local.deleteLocalNotes();
    expect(await local.readAll()).toEqual([]);
  });

  it('is deleted by signing out in one tab even while another tab has it open', async () => {
    unlock();
    await seed('a', 'text');
    await library.syncLibrary();
    await settle();
    const otherTab = local;
    expect((await otherTab.readAll()).map((r) => r.id)).toEqual(['a']);
    // The signing-out tab: its own copy of the module, its own connection.
    vi.resetModules();
    const signingOut = await import('../../src/lib/localStore');
    expect((await signingOut.readAll()).map((r) => r.id)).toEqual(['a']);
    await signingOut.deleteLocalNotes();
    const names = (await indexedDB.databases()).map((d) => d.name);
    expect(names).not.toContain('lumen-notes');
  });
});

describe('a new session', () => {
  it('reads the notes it has from disk and fetches only those whose version moved on', async () => {
    unlock();
    for (const id of ['a', 'b', 'c']) await seed(id, `text of ${id}`);
    await library.syncLibrary();
    await settle();
    await savedElsewhere('b', 'b, changed elsewhere');
    await seed('d', 'new note');
    await newSession();
    unlock();
    await library.syncLibrary();
    expect(fetchedIds()).toEqual(['b', 'd']);
    expect(['a', 'b', 'c', 'd'].map(docText)).toEqual(['text of a', 'b, changed elsewhere', 'text of c', 'new note']);
  });

  it('starts again from disk when unlocked anew, without fetching', async () => {
    unlock();
    await seed('a', 'text');
    await library.syncLibrary();
    await settle();
    log = [];
    // Locked and unlocked again: a new codec, same key.
    unlock();
    await library.syncLibrary();
    expect(batches()).toEqual([]);
    expect(docText('a')).toBe('text');
  });

  it('opens a note offline from the copy on disk, with its folder and tags from the list', async () => {
    unlock();
    await seed('a', 'offline text', { title: 'Trip' });
    await library.syncLibrary();
    await settle();
    await newSession();
    unlock();
    store.upsertMeta({ ...store.useApp.getState().notes.a, folder_id: 'fold1', tags: ['travel'], pinned: true });
    intercept = async () => Promise.reject(new TypeError('Failed to fetch'));
    expect(await apiMod.api.getNote('a')).toMatchObject({ id: 'a', content: 'offline text', title: 'Trip', folder_id: 'fold1', tags: ['travel'], pinned: true, version: 1 });
  });

  it('opening an older copy offline, keeps that copy’s own version and title', async () => {
    unlock();
    await seed('a', 'old text', { title: 'Old title' });
    await library.syncLibrary();
    await settle();
    await newSession();
    unlock();
    store.upsertMeta({ ...store.useApp.getState().notes.a, version: 3, title: 'New title' });
    intercept = async () => Promise.reject(new TypeError('Failed to fetch'));
    expect(await apiMod.api.getNote('a')).toMatchObject({ content: 'old text', title: 'Old title', version: 1 });
  });
});

describe('notes that can’t be read', () => {
  it('are named, kept off the disk, and not fetched again until they change', async () => {
    unlock();
    await seed('good', 'fine');
    await seed('bad', 'in a key this device never had', { k: otherKey, title: 'Mystery' });
    store.upsertMeta({ ...store.useApp.getState().notes.bad, title: 'Mystery' });
    await library.syncLibrary();
    await settle();
    expect(library.unreadableNotes()).toEqual(['Mystery']);
    expect([...(await onDisk()).keys()]).toEqual(['good']);
    log = [];
    store.upsertMeta({ ...store.useApp.getState().notes.good, pinned: true });
    await library.syncLibrary();
    expect(batches()).toEqual([]);
    // Saved again (now readable): fetched at its new version.
    rows.get('bad')!.content = await encryptText(key, 'fixed', at('bad', 'content'));
    rows.get('bad')!.version = 2;
    store.upsertMeta({ ...store.useApp.getState().notes.bad, version: 2 });
    await library.syncLibrary();
    expect(fetchedIds()).toEqual(['bad']);
    expect(docText('bad')).toBe('fixed');
    expect(library.unreadableNotes()).toEqual([]);
  });

  it('include a plaintext note once the library is known to be fully encrypted', async () => {
    localStorage.setItem('kb.vault.sealed', '1');
    unlock();
    await seed('fake', 'slipped in unencrypted', { plain: true });
    await library.syncLibrary();
    expect(docText('fake')).toBeUndefined();
    expect(library.unreadableNotes()).toHaveLength(1);
  });
});

describe('notes saved from this device', () => {
  it('have their text here at the new version once the save is confirmed', async () => {
    unlock();
    await seed('a', 'before');
    await library.syncLibrary();
    store.noteCache.delete('a');
    saver.edit('a', { content: 'after' }, 1);
    await vi.advanceTimersByTimeAsync(900);
    await saver.flush('a');
    expect(library.libraryDocs().get('a')).toMatchObject({ version: 2, content: 'after' });
    log = [];
    await library.syncLibrary();
    expect(batches()).toEqual([]);
  });

  it('a save that didn’t change the text moves the text here to the new version only if it was the one saved on', async () => {
    unlock();
    await seed('a', 'body');
    await seed('b', 'body b');
    await library.syncLibrary();
    // Title-only saves: a's text here is at the version saved on; b's text here is older than that.
    saver.edit('a', { title: 'New a' }, 1);
    rows.get('b')!.version = 3;
    saver.edit('b', { title: 'New b' }, 3);
    await vi.advanceTimersByTimeAsync(900);
    await saver.flush('a');
    await saver.flush('b');
    expect(library.libraryDocs().get('a')).toMatchObject({ version: 2, content: 'body' });
    expect(library.libraryDocs().get('b')).toMatchObject({ version: 1, content: 'body b' });
  });
});

describe('keeping up in the background', () => {
  it('brings the copy up to date a few seconds after the list changes, then says so', async () => {
    unlock();
    await seed('a', 'text');
    const synced = vi.fn();
    library.onLibrarySynced(synced);
    store.useApp.setState({ notes: { ...store.useApp.getState().notes } });
    await vi.advanceTimersByTimeAsync(3900);
    expect(batches()).toEqual([]);
    await vi.advanceTimersByTimeAsync(100);
    await settleUntil(() => expect(synced).toHaveBeenCalledTimes(1));
    expect(docText('a')).toBe('text');
  });

  it('runs no background pass for a library that isn’t encrypted', async () => {
    store.useApp.setState({ status: 'ready' });
    await seed('a', 'plain', { plain: true });
    await vi.advanceTimersByTimeAsync(10_000);
    await settle();
    expect(batches()).toEqual([]);
  });

  it('makes another pass when the list changes during one, so waiting callers get current texts', async () => {
    unlock();
    await seed('a', 'one');
    let first = true;
    intercept = async (req) => {
      if (req.path !== '/api/notes/batch' || !first) return undefined;
      first = false;
      // Answered with version 1; by the time the answer is read, the list has version 2.
      const answer = serve(req);
      await savedElsewhere('a', 'two');
      return answer;
    };
    await library.syncLibrary();
    expect(batches()).toHaveLength(2);
    expect(docText('a')).toBe('two');
  });
});

describe('changing a note from outside its editor', () => {
  const meta = (id: string, version: number) => ({ id, folder_id: null, title: 'T', excerpt: '', info: {}, tags: [], pinned: false, version, created_at: NOW, updated_at: NOW, deleted_at: null });

  it('works from the newest text this device has, at that text’s own version', async () => {
    unlock();
    await seed('a', 'v1 text');
    await library.syncLibrary();
    // The open-note cache has an older copy than the library.
    store.noteCache.set('a', { ...meta('a', 1), content: 'v1 text' });
    await savedElsewhere('a', 'v2 text');
    await library.syncLibrary();
    store.noteCache.set('a', { ...meta('a', 1), content: 'v1 text' });
    expect(liveEdit.knownText('a')).toEqual({ content: 'v2 text', version: 2 });
    // And the other way round.
    store.noteCache.set('a', { ...meta('a', 3), content: 'v3 text' });
    expect(liveEdit.knownText('a')).toEqual({ content: 'v3 text', version: 3 });
  });

  it('works on top of unsaved edits, the one on its way included, at their base version', async () => {
    unlock();
    await seed('a', 'saved');
    store.noteCache.set('a', { ...meta('a', 1), content: 'saved' });
    saver.track(store.noteCache.get('a')!);
    saver.edit('a', { content: 'typed' });
    expect(liveEdit.knownText('a')).toEqual({ content: 'typed', version: 1 });
  });

  it('knows nothing of a note this device has no text of, and changes nothing then', async () => {
    unlock();
    const fn = vi.fn((s: string) => `${s}!`);
    expect(liveEdit.knownText('nope')).toBeNull();
    expect(liveEdit.changeNoteText('nope', fn)).toBe(false);
    expect(fn).not.toHaveBeenCalled();
  });

  it('saves nothing when the change leaves the text as it was', async () => {
    unlock();
    await seed('a', 'same');
    await library.syncLibrary();
    expect(liveEdit.changeNoteText('a', (s) => s)).toBe(true);
    expect(saver.pendingText('a')).toBeNull();
  });

  it('goes through the note’s open view when there is one, and only that view can unregister itself', async () => {
    const first = vi.fn();
    const second = vi.fn();
    const offFirst = liveEdit.registerLiveView('a', first);
    const offSecond = liveEdit.registerLiveView('a', second);
    offFirst(); // the first view's late clean-up mustn't remove the second
    const fn = (s: string) => s;
    expect(liveEdit.changeNoteText('a', fn)).toBe(true);
    expect(second).toHaveBeenCalledWith(fn);
    expect(first).not.toHaveBeenCalled();
    offSecond();
    expect(liveEdit.changeNoteText('a', fn)).toBe(false);
  });

  it('a change made on top of newer text leaves no older title or text cached for the new version', async () => {
    unlock();
    await seed('a', 'A', { title: 'Old' });
    // Opened earlier in this session.
    store.noteCache.set('a', { ...store.useApp.getState().notes.a, content: 'A' });
    // Another device renames it and changes its text; this device hears of it when its list refreshes.
    Object.assign(rows.get('a')!, { version: 2 });
    rows.get('a')!.content = await encryptText(key, 'B', at('a', 'content'));
    rows.get('a')!.sealed!.t = await encryptText(key, 'New', at('a', 'title'));
    await store.loadAll(true);
    expect(store.useApp.getState().notes.a).toMatchObject({ title: 'New', version: 2 });
    await library.syncLibrary();
    // A task ticked in the Tasks view: made on the newest text this device has (version 2).
    liveEdit.changeNoteText('a', (s) => `${s}!`);
    await vi.advanceTimersByTimeAsync(900);
    await saver.flush('a');
    expect(store.useApp.getState().notes.a).toMatchObject({ title: 'New', version: 3 });
    const cached = store.noteCache.get('a');
    // Either nothing cached (fetched again when opened) or the note as saved.
    expect(cached && { title: cached.title, content: cached.content, version: cached.version }).toEqual(cached && { title: 'New', content: 'B!', version: 3 });
  });

  it('a change made from the copy here conflicts with newer text saved elsewhere, rather than overwriting it', async () => {
    unlock();
    await seed('a', '- [ ] task');
    await library.syncLibrary();
    // Another device saved; the list here hasn't heard yet.
    rows.get('a')!.content = await encryptText(key, '- [ ] task\n- [ ] another', at('a', 'content'));
    rows.get('a')!.version = 2;
    liveEdit.changeNoteText('a', (s) => s.replace('[ ]', '[x]'));
    await vi.advanceTimersByTimeAsync(900);
    await saver.flush('a');
    await settleUntil(() => expect(saver.statusOf('a')).toBe('conflict'));
    expect(saver.conflictOf('a')).toMatchObject({ content: '- [ ] task\n- [ ] another' });
  });
});
