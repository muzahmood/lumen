// @vitest-environment jsdom
/**
 * Autosave (src/lib/saver.ts) with the app's real API client and store, against a stand-in server
 * that keeps notes and versions the way the Worker does: edits wait for a pause and go in one save,
 * drafts stay on the device (per tab) until the server confirms them, a note changed elsewhere stops
 * for a choice, and edits to a note deleted elsewhere become a new note.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { decryptText, encryptText, newMasterKey } from '../../src/lib/crypto';

window.matchMedia ??= ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;

const NOW = 1_700_000_000_000;

let saver: typeof import('../../src/lib/saver');
let store: typeof import('../../src/lib/store');
let apiMod: typeof import('../../src/lib/api');
let tab: string;
let tabSeq = 0;
let key: CryptoKey | null = null;

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
  /** Ids of the saves that changed its text, as the Worker keeps them (migration 6). */
  saves?: string[];
}
interface Req {
  method: string;
  path: string;
  query: URLSearchParams;
  body: Record<string, any> | undefined;
  keepalive?: boolean;
}

const rows = new Map<string, Row>();
/** Text the server kept in a note's history when a save replaced it. */
const history: Array<{ id: string; content: string }> = [];
/** Versions a device asked the server to keep (POST /api/notes/:id/versions), as sent. */
const kept: Array<{ id: string; body: Record<string, any> }> = [];
let log: Req[] = [];
let created = 0;
/** Stands between the app and the server: answer instead (a Response), throw (connection dropped), or undefined to let the server answer. */
let intercept: ((req: Req, serve: (req: Req) => Response) => Promise<Response | undefined>) | null = null;

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const metaOf = ({ content: _c, saves: _s, ...meta }: Row) => meta;
const noteOf = ({ saves: _s, ...note }: Row) => note;

function serve(req: Req): Response {
  const m = /^\/api\/notes\/([^/]+)$/.exec(req.path);
  const b = req.body ?? {};
  const keep = /^\/api\/notes\/([^/]+)\/versions$/.exec(req.path);
  if (keep && req.method === 'POST') {
    if (!rows.has(keep[1])) return json(404, { error: 'not_found', message: 'Note not found.' });
    kept.push({ id: keep[1], body: b });
    return json(201, { ok: true, id: kept.length });
  }
  if (req.method === 'POST' && req.path === '/api/notes') {
    const id = (b.id as string) ?? `srv${++created}`;
    // As the Worker: an id that's taken is refused (a restore replaces the note instead).
    if (rows.has(id) && !b.restore) return json(409, { error: 'exists', message: 'A note with this id already exists.' });
    const row: Row = {
      id,
      folder_id: b.folder_id ?? null,
      title: b.title ?? '',
      excerpt: '',
      info: {},
      tags: b.tags ?? [],
      pinned: !!b.pinned,
      version: 1,
      created_at: Date.now(),
      updated_at: Date.now(),
      deleted_at: null,
      content: b.content ?? '',
      ...(b.enc ? { enc: true, sealed: b.sealed, kgen: b.kgen } : {}),
    };
    rows.set(id, row);
    return json(200, metaOf(row));
  }
  if (m && req.method === 'PATCH') {
    const row = rows.get(m[1]);
    if (!row) return json(404, { error: 'not_found', message: 'Note not found.' });
    const textChanged =
      (typeof b.content === 'string' && b.content !== row.content) ||
      (typeof b.title === 'string' && b.title !== row.title) ||
      (b.sealed?.t !== undefined && b.sealed.t !== row.sealed?.t);
    if (textChanged && typeof b.baseVersion === 'number' && b.baseVersion !== row.version && b.force !== true) {
      return json(409, { error: 'conflict', message: 'Changed on another device.', note: noteOf(row), saves: row.saves ?? [], now: Date.now() });
    }
    if (textChanged && b.force === true) history.push({ id: row.id, content: row.content });
    if (textChanged && typeof b.saveId === 'string') row.saves = [...(row.saves ?? []), b.saveId].slice(-16);
    if (typeof b.content === 'string') row.content = b.content;
    if (typeof b.title === 'string') row.title = b.title;
    if (b.tags) row.tags = b.tags;
    if ('folder_id' in b) row.folder_id = b.folder_id;
    if ('pinned' in b) row.pinned = b.pinned;
    if (b.sealed) row.sealed = { ...row.sealed, ...b.sealed };
    if (textChanged) {
      row.version++;
      row.updated_at = Date.now();
    }
    return json(200, metaOf(row));
  }
  if (m && req.method === 'GET') {
    const row = rows.get(m[1]);
    return row ? json(200, noteOf(row)) : json(404, { error: 'not_found', message: 'Note not found.' });
  }
  return json(404, { error: 'no_route', message: 'No such route.' });
}

async function fakeFetch(input: string, init: RequestInit = {}) {
  const url = new URL(input, 'http://localhost');
  const req: Req = {
    method: init.method ?? 'GET',
    path: url.pathname,
    query: url.searchParams,
    body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
    keepalive: init.keepalive,
  };
  log.push(req);
  const answer = intercept ? await intercept(req, serve) : undefined;
  return answer ?? serve(req);
}

const patches = () => log.filter((r) => r.method === 'PATCH').map((r) => r.body!);
const creates = () => log.filter((r) => r.method === 'POST' && r.path === '/api/notes').map((r) => r.body!);
const dropped = () => Promise.reject(new TypeError('Failed to fetch'));

/** Requests held until the test lets them through, in order. */
let held: Array<() => void> = [];
const hold = () => new Promise<undefined>((resolve) => held.push(() => resolve(undefined)));

/** Lets real async work (WebCrypto, reading a response) finish: fake timers don't cover it. */
async function settle(rounds = 40) {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setImmediate(r));
}

/** Waits for the save on its way to end, without sending anything itself (flush would send what's left). */
async function whileSaving(id: string) {
  for (let i = 0; i < 500 && saver.statusOf(id) === 'saving'; i++) await new Promise((r) => setImmediate(r));
}

/* ------------------------------------------------------- the device --- */

const at = (id: string, f: string) => `lumen/1/note/${id}/${f}`;

/** A note on the server, and open on this device as NoteView opens one (store, cache, autosave). */
async function openNote(id: string, init: { title?: string; content?: string; tags?: string[]; folder_id?: string | null; version?: number } = {}) {
  const note = {
    id,
    folder_id: init.folder_id ?? null,
    title: init.title ?? 'Plan',
    excerpt: '',
    info: {},
    tags: init.tags ?? [],
    pinned: false,
    version: init.version ?? 1,
    created_at: NOW,
    updated_at: NOW,
    deleted_at: null,
    content: init.content ?? 'first',
  };
  if (key) {
    rows.set(id, {
      ...note,
      title: '',
      tags: [],
      content: await encryptText(key, note.content, at(id, 'content')),
      enc: true,
      kgen: 0,
      sealed: {
        t: await encryptText(key, note.title, at(id, 'title')),
        g: await encryptText(key, JSON.stringify(note.tags), at(id, 'tags')),
        p: await encryptText(key, JSON.stringify({ v: 6, e: note.content, i: {}, l: { n: [], w: [] } }), at(id, 'preview')),
      },
    });
  } else {
    rows.set(id, { ...note });
  }
  const { content: _c, ...meta } = note;
  store.upsertMeta(meta);
  store.noteCache.set(id, note);
  return { note, shown: saver.track(note) };
}

/** Another device saves new text into the note. */
async function savedElsewhere(id: string, content: string) {
  const row = rows.get(id)!;
  row.content = key ? await encryptText(key, content, at(id, 'content')) : content;
  row.version++;
}

const serverText = async (id: string) => {
  const row = rows.get(id)!;
  return key && row.enc ? decryptText(key, row.content, at(id, 'content')) : row.content;
};

const draftKey = (id: string, owner = tab) => `kb.draft.${id}~${owner}`;
const draftOf = (id: string, owner = tab) => JSON.parse(localStorage.getItem(draftKey(id, owner)) ?? 'null');
const toasts = () => store.useApp.getState().toasts.map((t) => t.message);

async function encrypted() {
  key = await newMasterKey();
  const e2ee = await import('../../src/lib/e2ee');
  apiMod.setKeyGen(0);
  apiMod.setCodec(e2ee.createCodec(key));
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'], now: NOW });
  localStorage.clear();
  sessionStorage.clear();
  tab = `tab${++tabSeq}x`;
  sessionStorage.setItem('kb.tab-id', tab);
  // One tab at a time in these tests (a channel would also reach the copies loaded for earlier tests).
  vi.stubGlobal('BroadcastChannel', undefined);
  vi.stubGlobal('fetch', fakeFetch);
  rows.clear();
  history.length = 0;
  kept.length = 0;
  log = [];
  held = [];
  intercept = null;
  key = null;
  vi.resetModules();
  apiMod = await import('../../src/lib/api');
  store = await import('../../src/lib/store');
  saver = await import('../../src/lib/saver');
});

afterEach(() => {
  saver.discardAll();
  apiMod.setCodec(null);
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/* ------------------------------------------------------------ tests --- */

describe('saving as you type', () => {
  it('waits for a pause in typing, then sends every edit since in one save', async () => {
    await openNote('note1');
    saver.edit('note1', { content: 'fi' });
    await vi.advanceTimersByTimeAsync(500);
    saver.edit('note1', { content: 'fir' });
    await vi.advanceTimersByTimeAsync(800);
    expect(patches()).toHaveLength(0);
    expect(saver.statusOf('note1')).toBe('pending');

    await vi.advanceTimersByTimeAsync(100);
    await saver.flush('note1');
    expect(patches()).toEqual([expect.objectContaining({ content: 'fir', baseVersion: 1 })]);
    expect(saver.statusOf('note1')).toBe('saved');
    expect(saver.baseVersionOf('note1')).toBe(2);
    expect(rows.get('note1')).toMatchObject({ content: 'fir', version: 2 });
  });

  it('sends a title and text edited together in the same save', async () => {
    await openNote('note1');
    saver.edit('note1', { title: 'New plan' });
    saver.edit('note1', { content: 'second' });
    await vi.advanceTimersByTimeAsync(900);
    await saver.flush('note1');
    expect(patches()).toEqual([expect.objectContaining({ title: 'New plan', content: 'second', baseVersion: 1 })]);
    // The cached copy and the list now hold the saved note at its new version.
    expect(store.noteCache.get('note1')).toMatchObject({ title: 'New plan', content: 'second', version: 2 });
    expect(store.useApp.getState().notes.note1.version).toBe(2);
  });

  it('sends edits made while a save is on its way after it, on top of the version it made, one save at a time', async () => {
    await openNote('note1');
    let open = 0;
    let most = 0;
    intercept = async (req) => {
      if (req.method !== 'PATCH') return undefined;
      most = Math.max(most, ++open);
      await hold();
      open--;
      return undefined;
    };
    saver.edit('note1', { content: 'one' });
    await vi.advanceTimersByTimeAsync(900);
    expect(patches()).toHaveLength(1);
    expect(saver.statusOf('note1')).toBe('saving');

    saver.edit('note1', { content: 'one two' });
    await vi.advanceTimersByTimeAsync(900);
    void saver.flush('note1');
    void saver.flush('note1');
    await vi.advanceTimersByTimeAsync(0);
    expect(patches()).toHaveLength(1);
    expect(saver.hasUnsaved()).toBe(true);

    held.shift()!();
    await settle();
    expect(held).toHaveLength(1);
    expect(patches()[1]).toMatchObject({ content: 'one two', baseVersion: 2 });
    held.shift()!();
    await saver.flush('note1');
    expect(patches()).toHaveLength(2);
    expect(most).toBe(1);
    expect(rows.get('note1')).toMatchObject({ content: 'one two', version: 3 });
    expect(saver.statusOf('note1')).toBe('saved');
    expect(saver.hasUnsaved()).toBe(false);
  });

  it('saves a change made from outside the editor on top of the version its text came from', async () => {
    await openNote('note1');
    await savedElsewhere('note1', 'newer');
    // The Tasks view read the newer text (version 2) and changed it; nothing of the note is unsaved here.
    saver.edit('note1', { content: 'newer, ticked' }, 2);
    await vi.advanceTimersByTimeAsync(900);
    await saver.flush('note1');
    expect(patches()).toEqual([expect.objectContaining({ content: 'newer, ticked', baseVersion: 2 })]);
    expect(saver.statusOf('note1')).toBe('saved');
  });

  it('keeps the version of edits already on their way rather than one passed in from outside', async () => {
    await openNote('note1');
    intercept = async (req) => (req.method === 'PATCH' ? hold() : undefined);
    saver.edit('note1', { content: 'typed' });
    await vi.advanceTimersByTimeAsync(900);
    // An outside change made from an older copy of the note, while the save above is on its way.
    saver.edit('note1', { content: 'typed, ticked' }, 1);
    held.shift()!();
    await settle();
    await vi.advanceTimersByTimeAsync(900);
    expect(held).toHaveLength(1);
    expect(patches()[1]).toMatchObject({ content: 'typed, ticked', baseVersion: 2 });
    held.shift()!();
    await saver.flush('note1');
    expect(saver.statusOf('note1')).toBe('saved');
  });

  it('sends what’s unsaved as the page closes, in a request that can outlive it', async () => {
    await openNote('note1');
    saver.edit('note1', { content: 'last words' });
    window.dispatchEvent(new Event('pagehide'));
    await vi.advanceTimersByTimeAsync(0);
    await saver.flush('note1');
    expect(log.filter((r) => r.method === 'PATCH')).toEqual([expect.objectContaining({ keepalive: true })]);
    expect(rows.get('note1')!.content).toBe('last words');
    // The tab no longer counts as open, so the next tab may take any drafts it left.
    expect(localStorage.getItem(`kb.tab.${tab}`)).toBeNull();
  });
});

describe('drafts on this device', () => {
  it('keeps a draft of every edit at once, under this tab’s own name, until the server has it', async () => {
    await openNote('note1');
    saver.edit('note1', { content: 'draft text' });
    expect(draftOf('note1')).toMatchObject({ content: 'draft text', baseVersion: 1 });
    expect(Object.keys(localStorage).filter((k) => k.startsWith('kb.draft.'))).toEqual([draftKey('note1')]);
    await vi.advanceTimersByTimeAsync(900);
    await saver.flush('note1');
    expect(localStorage.getItem(draftKey('note1'))).toBeNull();
  });

  it('keeps the text on its way in the draft, with edits made since on top, until the save is confirmed', async () => {
    await openNote('note1');
    intercept = async (req) => (req.method === 'PATCH' ? hold() : undefined);
    saver.edit('note1', { title: 'Sent title' });
    await vi.advanceTimersByTimeAsync(900);
    saver.edit('note1', { content: 'typed after' });
    expect(draftOf('note1')).toMatchObject({ title: 'Sent title', content: 'typed after' });
    expect(saver.unsavedPatch('note1')).toEqual({ title: 'Sent title', content: 'typed after' });
    expect(saver.pendingText('note1')).toEqual({ content: 'typed after' });
    held.shift()!();
    // (Edits while saving show as 'pending', so wait for the reply itself.)
    await settle();
    // The title is saved; the text still waits.
    expect(draftOf('note1')).toMatchObject({ content: 'typed after' });
    expect(draftOf('note1').title).toBeUndefined();
    await vi.advanceTimersByTimeAsync(900);
    held.shift()!();
    await whileSaving('note1');
    expect(localStorage.getItem(draftKey('note1'))).toBeNull();
  });

  it('keeps edits made offline on the device and sends them once back online', async () => {
    await openNote('note1');
    intercept = () => dropped();
    saver.edit('note1', { content: 'on the train' });
    await vi.advanceTimersByTimeAsync(900);
    await whileSaving('note1');
    expect(saver.statusOf('note1')).toBe('offline');
    expect(draftOf('note1')).toMatchObject({ content: 'on the train', baseVersion: 1 });
    expect(store.useApp.getState().online).toBe(false);

    intercept = null;
    window.dispatchEvent(new Event('online'));
    await vi.advanceTimersByTimeAsync(0);
    await saver.flush('note1');
    expect(saver.statusOf('note1')).toBe('saved');
    expect(rows.get('note1')!.content).toBe('on the train');
    expect(localStorage.getItem(draftKey('note1'))).toBeNull();
  });

  it('tries again by itself while offline', async () => {
    await openNote('note1');
    intercept = () => dropped();
    saver.edit('note1', { content: 'on the train' });
    await vi.advanceTimersByTimeAsync(900);
    await whileSaving('note1');
    expect(patches()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(10_000);
    await whileSaving('note1');
    expect(patches()).toHaveLength(2);
    intercept = null;
    await vi.advanceTimersByTimeAsync(10_000);
    await whileSaving('note1');
    expect(saver.statusOf('note1')).toBe('saved');
    expect(rows.get('note1')!.content).toBe('on the train');
  });

  it('retries a server error after a while, and says why it failed meanwhile', async () => {
    await openNote('note1');
    intercept = async (req) => (req.method === 'PATCH' ? json(500, { error: 'internal', message: 'Something broke.' }) : undefined);
    saver.edit('note1', { content: 'x' });
    await vi.advanceTimersByTimeAsync(900);
    await whileSaving('note1');
    expect(saver.statusOf('note1')).toBe('error');
    expect(saver.errorOf('note1')).toBe('Something broke.');
    intercept = null;
    await vi.advanceTimersByTimeAsync(20_000);
    await saver.flush('note1');
    expect(saver.statusOf('note1')).toBe('saved');
    expect(saver.errorOf('note1')).toBeNull();
  });

  it('tells the service worker each save as the server has it, so its offline copies are current at once', async () => {
    const posted: unknown[] = [];
    vi.stubGlobal('navigator', { ...navigator, serviceWorker: { controller: { postMessage: (m: unknown) => posted.push(m) } } });
    await openNote('note1', { version: 2 });
    saver.edit('note1', { content: 'saved text' });
    await vi.advanceTimersByTimeAsync(900);
    await whileSaving('note1');
    expect(posted).toEqual([{ type: 'note-saved', meta: expect.objectContaining({ id: 'note1', version: 3 }), content: 'saved text', base: 2 }]);
  });

  it('takes up the unsent edits of a tab that closes while this one stays open', async () => {
    // A note only the other tab had open (this one never tracked it).
    rows.set('note2', { id: 'note2', folder_id: null, title: 'Other', excerpt: '', info: {}, tags: [], pinned: false, version: 1, created_at: NOW, updated_at: NOW, deleted_at: null, content: 'before' });
    localStorage.setItem('kb.tab.othertab', String(Date.now()));
    localStorage.setItem(draftKey('note2', 'othertab'), JSON.stringify({ content: 'typed in the other tab', baseVersion: 1, at: Date.now() }));
    // Still open: its edits are its own to send.
    window.dispatchEvent(new StorageEvent('storage', { key: 'kb.tab.othertab', newValue: String(Date.now()) }));
    await vi.advanceTimersByTimeAsync(5000);
    expect(rows.get('note2')!.content).toBe('before');
    // It goes (its mark goes with it, which this tab hears about), without having sent them.
    localStorage.removeItem('kb.tab.othertab');
    window.dispatchEvent(new StorageEvent('storage', { key: 'kb.tab.othertab', newValue: null }));
    await vi.advanceTimersByTimeAsync(1500 + 1500 + 900);
    await whileSaving('note2');
    expect(rows.get('note2')!.content).toBe('typed in the other tab');
    expect(saver.statusOf('note2')).toBe('saved');
  });

  it('waits twice as long after each server error in a row, to 15 minutes, and starts again once one lands', async () => {
    await openNote('note1');
    intercept = async (req) => (req.method === 'PATCH' ? json(500, { error: 'internal', message: 'Something broke.' }) : undefined);
    saver.edit('note1', { content: 'x' });
    await vi.advanceTimersByTimeAsync(900);
    await whileSaving('note1');
    const sentAt = () => patches().length;
    // Each wait is twice the one before: 20 s, 40 s, 80 s, …, then 15 minutes at most.
    const waits: number[] = [];
    let last = Date.now();
    while (waits.length < 8) {
      const before = sentAt();
      await vi.advanceTimersByTimeAsync(1000);
      await settle(5);
      if (sentAt() > before) {
        waits.push(Math.round((Date.now() - last) / 1000));
        last = Date.now();
      }
    }
    expect(waits).toEqual([20, 40, 80, 160, 320, 640, 900, 900]);
    // A day of it is now about a hundred tries, not 4,300.
    intercept = null;
    await vi.advanceTimersByTimeAsync(900_000);
    await whileSaving('note1');
    expect(saver.statusOf('note1')).toBe('saved');
    // Back to 20 s for the next failure.
    intercept = async (req) => (req.method === 'PATCH' ? json(500, { error: 'internal', message: 'Something broke.' }) : undefined);
    saver.edit('note1', { content: 'y' });
    await vi.advanceTimersByTimeAsync(900);
    await whileSaving('note1');
    const before = sentAt();
    await vi.advanceTimersByTimeAsync(20_000);
    await settle(5);
    expect(sentAt()).toBe(before + 1);
  });

  it('when today’s Cloudflare allowance is used up, says so once and sends nothing more until it resets', async () => {
    await openNote('note1');
    await openNote('note2');
    intercept = async (req) => (req.method === 'PATCH' ? json(429, { error: 'quota_exceeded', message: 'Used up.', resetAt: 0 }) : undefined);
    saver.edit('note1', { content: 'one' });
    await vi.advanceTimersByTimeAsync(900);
    await whileSaving('note1');
    expect(saver.statusOf('note1')).toBe('error');
    expect(saver.errorOf('note1')).toMatch(/today’s Cloudflare free allowance/);
    expect(toasts().filter((t) => /free allowance/.test(t))).toHaveLength(1);
    const sent = patches().length;
    // More typing, on this note and another, the connection coming back, Ctrl/⌘ S: nothing is sent.
    saver.edit('note1', { content: 'one, more' });
    saver.edit('note2', { content: 'second' });
    await vi.advanceTimersByTimeAsync(5_000);
    window.dispatchEvent(new Event('online'));
    await saver.flush('note1');
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(patches()).toHaveLength(sent);
    expect(saver.statusOf('note2')).toBe('error');
    expect(saver.errorOf('note2')).toMatch(/free allowance/);
    expect(toasts().filter((t) => /free allowance/.test(t))).toHaveLength(1);
    // The edits wait on the device.
    expect(draftOf('note1')).toMatchObject({ content: 'one, more' });
    // Just after midnight UTC (within a minute's spread), everything goes.
    intercept = null;
    const midnight = apiMod.quotaResetAt(NOW);
    await vi.advanceTimersByTimeAsync(midnight - Date.now() + 61_000);
    await whileSaving('note1');
    await whileSaving('note2');
    expect(rows.get('note1')!.content).toBe('one, more');
    expect(rows.get('note2')!.content).toBe('second');
  });

  it('doesn’t keep resending a save that would only be refused again, until the next edit', async () => {
    await openNote('note1');
    store.openNote('other');
    intercept = async (req) => (req.method === 'PATCH' ? json(413, { error: 'too_large', message: 'Note is too large.' }) : undefined);
    saver.edit('note1', { content: 'huge' });
    await vi.advanceTimersByTimeAsync(900);
    await whileSaving('note1');
    expect(saver.statusOf('note1')).toBe('failed');
    // Not open: the person is told, with a way to open it.
    expect(toasts().some((t) => t.includes('couldn’t be saved: Note is too large.'))).toBe(true);
    await vi.advanceTimersByTimeAsync(60_000);
    await saver.flushAll();
    expect(patches()).toHaveLength(1);
    expect(draftOf('note1')).toMatchObject({ content: 'huge' });

    intercept = null;
    saver.edit('note1', { content: 'smaller' });
    await vi.advanceTimersByTimeAsync(900);
    await saver.flush('note1');
    expect(saver.statusOf('note1')).toBe('saved');
    expect(rows.get('note1')!.content).toBe('smaller');
  });

  it('leaves an ended session to its own banner rather than a message about the note', async () => {
    await openNote('note1');
    store.openNote('other');
    intercept = async (req) => (req.method === 'PATCH' ? new Response('', { status: 401 }) : undefined);
    saver.edit('note1', { content: 'x' });
    await vi.advanceTimersByTimeAsync(900);
    await whileSaving('note1');
    expect(saver.statusOf('note1')).toBe('failed');
    expect(store.useApp.getState().authExpired).toBe(true);
    expect(toasts()).toEqual([]);
    expect(draftOf('note1')).toMatchObject({ content: 'x' });
  });

  it('makes room for a draft by dropping the drawing editor’s crash copy when storage is full', async () => {
    await openNote('note1');
    localStorage.setItem('kb.drawing-backup', 'big');
    const real = Storage.prototype.setItem;
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, k: string, v: string) {
      if (k.startsWith('kb.draft.') && localStorage.getItem('kb.drawing-backup') !== null) throw new DOMException('full', 'QuotaExceededError');
      real.call(this, k, v);
    });
    saver.edit('note1', { content: 'kept' });
    spy.mockRestore();
    expect(localStorage.getItem('kb.drawing-backup')).toBeNull();
    expect(draftOf('note1')).toMatchObject({ content: 'kept' });
    expect(toasts()).toEqual([]);
  });

  it('says once, not on every keystroke, when storage is too full for drafts', async () => {
    await openNote('note1');
    const real = Storage.prototype.setItem;
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, k: string, v: string) {
      if (k.startsWith('kb.draft.')) throw new DOMException('full', 'QuotaExceededError');
      real.call(this, k, v);
    });
    saver.edit('note1', { content: 'a' });
    saver.edit('note1', { content: 'ab' });
    spy.mockRestore();
    expect(toasts().filter((t) => t.includes('storage is full'))).toHaveLength(1);
    // Still saved to the server.
    await vi.advanceTimersByTimeAsync(900);
    await saver.flush('note1');
    expect(rows.get('note1')!.content).toBe('ab');
  });
});

describe('drafts and other tabs', () => {
  const leave = (id: string, owner: string | null, draft: Record<string, unknown>) =>
    localStorage.setItem(owner ? `kb.draft.${id}~${owner}` : `kb.draft.${id}`, JSON.stringify({ baseVersion: 1, at: NOW - 1000, ...draft }));

  it('takes over the draft a closed tab left, shows it, and sends it', async () => {
    leave('note1', 'gone', { content: 'from a closed tab' });
    const { shown } = await openNote('note1');
    expect(shown).toEqual({ title: 'Plan', content: 'from a closed tab', fromDraft: true });
    expect(localStorage.getItem(draftKey('note1', 'gone'))).toBeNull();
    expect(draftOf('note1')).toMatchObject({ content: 'from a closed tab', baseVersion: 1 });
    await vi.advanceTimersByTimeAsync(50);
    await saver.flush('note1');
    expect(patches()).toEqual([expect.objectContaining({ content: 'from a closed tab', baseVersion: 1 })]);
    expect(localStorage.getItem(draftKey('note1'))).toBeNull();
  });

  it('leaves alone the drafts of a tab that’s still open', async () => {
    localStorage.setItem('kb.tab.other', String(NOW - 60_000));
    leave('note1', 'other', { content: 'the other tab’s' });
    const { shown } = await openNote('note1');
    expect(shown).toEqual({ title: 'Plan', content: 'first', fromDraft: false });
    saver.recoverDrafts();
    await vi.advanceTimersByTimeAsync(2000);
    expect(patches()).toHaveLength(0);
    expect(draftOf('note1', 'other')).toMatchObject({ content: 'the other tab’s' });
  });

  it('counts a tab not heard from for over three minutes as closed', async () => {
    localStorage.setItem('kb.tab.other', String(NOW - 4 * 60_000));
    leave('note1', 'other', { content: 'the other tab’s' });
    const { shown } = await openNote('note1');
    expect(shown.fromDraft).toBe(true);
    expect(shown.content).toBe('the other tab’s');
  });

  it('takes the newest of the drafts closed tabs left, and removes the older ones', async () => {
    leave('note1', 'old', { content: 'older', at: NOW - 5000 });
    leave('note1', 'new', { content: 'newer', at: NOW - 100 });
    leave('note1', null, { content: 'oldest, from before drafts had owners', at: NOW - 9000 });
    const { shown } = await openNote('note1');
    expect(shown.content).toBe('newer');
    expect(Object.keys(localStorage).filter((k) => k.startsWith('kb.draft.'))).toEqual([draftKey('note1')]);
  });

  it('drops a draft that matches the saved note', async () => {
    leave('note1', 'gone', { content: 'first', title: 'Plan' });
    const { shown } = await openNote('note1');
    expect(shown.fromDraft).toBe(false);
    expect(Object.keys(localStorage).filter((k) => k.startsWith('kb.draft.'))).toEqual([]);
    await vi.advanceTimersByTimeAsync(2000);
    expect(patches()).toHaveLength(0);
  });

  it('sends drafts left from an earlier session when the app starts, but not an open tab’s', async () => {
    rows.set('note1', { id: 'note1', folder_id: null, title: 'Plan', excerpt: '', info: {}, tags: [], pinned: false, version: 1, created_at: NOW, updated_at: NOW, deleted_at: null, content: 'first' });
    rows.set('note2', { ...rows.get('note1')!, id: 'note2' });
    leave('note1', tab, { content: 'mine, from before a reload' });
    localStorage.setItem('kb.tab.other', String(NOW));
    leave('note2', 'other', { content: 'still being typed in another tab' });
    saver.recoverDrafts();
    await vi.advanceTimersByTimeAsync(1500);
    await saver.flush('note1');
    expect(patches()).toEqual([expect.objectContaining({ content: 'mine, from before a reload', baseVersion: 1 })]);
    expect(rows.get('note2')!.content).toBe('first');
    expect(draftOf('note2', 'other')).toBeTruthy();
  });

  it('tidies away the marks of tabs gone for over a day', () => {
    localStorage.setItem('kb.tab.ancient', String(NOW - 2 * 86_400_000));
    localStorage.setItem('kb.tab.recent', String(NOW - 3_600_000));
    saver.recoverDrafts();
    expect(localStorage.getItem('kb.tab.ancient')).toBeNull();
    expect(localStorage.getItem('kb.tab.recent')).not.toBeNull();
  });
});

describe('a duplicated tab', () => {
  /** BroadcastChannel between the copies of the app loaded in one test (each copy is a tab). */
  class Channel {
    static open: Channel[] = [];
    listeners: Array<(e: { data: unknown }) => void> = [];
    constructor(public name: string) {
      Channel.open.push(this);
    }
    addEventListener(_type: string, fn: (e: { data: unknown }) => void) {
      this.listeners.push(fn);
    }
    postMessage(data: unknown) {
      for (const c of Channel.open) if (c !== this && c.name === this.name) queueMicrotask(() => c.listeners.forEach((fn) => fn({ data })));
    }
  }

  it('takes a new id of its own, so the two tabs never share drafts', async () => {
    Channel.open = [];
    vi.stubGlobal('BroadcastChannel', Channel);
    vi.resetModules();
    const first = await import('../../src/lib/saver');
    // "Duplicate tab" copies session storage, the tab's id included.
    vi.resetModules();
    const copy = await import('../../src/lib/saver');
    await settle(5);
    first.edit('note1', { content: 'first tab' }, 1);
    copy.edit('note1', { content: 'duplicated tab' }, 1);
    const drafts = Object.keys(localStorage).filter((k) => k.startsWith('kb.draft.note1~'));
    expect(drafts).toHaveLength(2);
    expect(drafts).toContain(draftKey('note1', tab));
    expect(sessionStorage.getItem('kb.tab-id')).not.toBe(tab);
    first.discardAll();
    copy.discardAll();
  });
});

describe('the copy kept for reading offline', () => {
  it('is fetched once more a few seconds after a burst of saves, so it isn’t left behind', async () => {
    vi.stubGlobal('navigator', Object.assign(Object.create(navigator), { serviceWorker: { controller: {} } }));
    await openNote('note1');
    for (const text of ['one', 'one two', 'one two three']) {
      saver.edit('note1', { content: text });
      await vi.advanceTimersByTimeAsync(900);
      await saver.flush('note1');
      await vi.advanceTimersByTimeAsync(1000);
    }
    const gets = () => log.filter((r) => r.method === 'GET' && r.path === '/api/notes/note1');
    expect(gets()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(3000);
    expect(gets()).toHaveLength(1);
  });
});

describe('a note changed on another device meanwhile', () => {
  async function conflicted() {
    await openNote('note1', { content: 'base' });
    await savedElsewhere('note1', 'theirs');
    saver.edit('note1', { content: 'mine' });
    await vi.advanceTimersByTimeAsync(900);
    await saver.flush('note1');
    await settle();
  }

  it('stops and holds both versions instead of overwriting', async () => {
    await conflicted();
    expect(saver.statusOf('note1')).toBe('conflict');
    expect(saver.conflictOf('note1')).toMatchObject({ id: 'note1', content: 'theirs', version: 2 });
    expect(await serverText('note1')).toBe('theirs');
    // Further edits wait for the choice, kept on the device.
    saver.edit('note1', { content: 'mine, more' });
    await vi.advanceTimersByTimeAsync(30_000);
    await saver.flushAll();
    expect(patches()).toHaveLength(1);
    expect(saver.statusOf('note1')).toBe('conflict');
    expect(draftOf('note1')).toMatchObject({ content: 'mine, more' });
  });

  it('Keep mine saves the note as shown here over theirs, keeping theirs in its history', async () => {
    await conflicted();
    await saver.resolveConflict('note1', 'mine', { title: 'Plan', content: 'mine' });
    expect(patches()[1]).toMatchObject({ title: 'Plan', content: 'mine', force: true });
    expect(rows.get('note1')).toMatchObject({ content: 'mine', version: 3 });
    expect(history).toEqual([{ id: 'note1', content: 'theirs' }]);
    expect(saver.statusOf('note1')).toBe('saved');
    expect(saver.conflictOf('note1')).toBeNull();
    expect(saver.baseVersionOf('note1')).toBe(3);
    expect(localStorage.getItem(draftKey('note1'))).toBeNull();
    // The next edit saves normally on top of it.
    saver.edit('note1', { content: 'mine again' });
    await vi.advanceTimersByTimeAsync(900);
    await saver.flush('note1');
    expect(patches()[2]).toMatchObject({ baseVersion: 3 });
    expect(patches()[2].force).toBeUndefined();
  });

  it('Use theirs drops the edits here and continues from the saved version', async () => {
    await conflicted();
    const theirs = await saver.resolveConflict('note1', 'theirs');
    expect(theirs).toMatchObject({ content: 'theirs', version: 2 });
    expect(patches()).toHaveLength(1);
    expect(saver.statusOf('note1')).toBe('saved');
    expect(saver.pendingText('note1')).toBeNull();
    expect(localStorage.getItem(draftKey('note1'))).toBeNull();
    expect(store.noteCache.get('note1')).toMatchObject({ content: 'theirs', version: 2 });
    saver.edit('note1', { content: 'theirs, and more' });
    await vi.advanceTimersByTimeAsync(900);
    await saver.flush('note1');
    expect(saver.statusOf('note1')).toBe('saved');
    expect(rows.get('note1')).toMatchObject({ content: 'theirs, and more', version: 3 });
  });

  it('tells the person when a note they aren’t looking at needs a choice', async () => {
    store.openNote('somewhere-else');
    await conflicted();
    expect(toasts()).toEqual(['“Plan” was changed on another device. Open it to choose which version to keep.']);
  });

  it('says nothing extra when the note is the one open (its own banner shows it)', async () => {
    store.openNote('note1');
    await conflicted();
    expect(toasts()).toEqual([]);
  });

  it('in an encrypted library, shows the other device’s text decrypted, and Keep mine sends it encrypted', async () => {
    await encrypted();
    await conflicted();
    expect(saver.statusOf('note1')).toBe('conflict');
    expect(saver.conflictOf('note1')).toMatchObject({ content: 'theirs', title: 'Plan', version: 2 });
    await saver.resolveConflict('note1', 'mine', { title: 'Plan', content: 'mine' });
    const sent = patches()[1];
    expect(sent).toMatchObject({ enc: true, force: true });
    expect(JSON.stringify(sent)).not.toContain('mine');
    expect(await serverText('note1')).toBe('mine');
    expect(saver.statusOf('note1')).toBe('saved');
  });
});

describe('a save whose reply never came back', () => {
  it('isn’t mistaken for another device’s when the retry meets it, and only the newer typing is sent', async () => {
    await openNote('note1');
    let lose = true;
    intercept = async (req, srv) => {
      if (req.method === 'PATCH' && lose) {
        lose = false;
        srv(req); // the server saved it…
        throw new TypeError('Failed to fetch'); // …but the connection dropped before the reply
      }
      return undefined;
    };
    saver.edit('note1', { content: 'ab' });
    await vi.advanceTimersByTimeAsync(900);
    await whileSaving('note1');
    expect(saver.statusOf('note1')).toBe('offline');
    saver.edit('note1', { content: 'abc' });
    await vi.advanceTimersByTimeAsync(900);
    await whileSaving('note1');
    await vi.advanceTimersByTimeAsync(50);
    await whileSaving('note1');
    expect(saver.statusOf('note1')).toBe('saved');
    expect(saver.conflictOf('note1')).toBeNull();
    expect(rows.get('note1')).toMatchObject({ content: 'abc', version: 3 });
    expect(patches().at(-1)).toMatchObject({ content: 'abc', baseVersion: 2 });
    expect(localStorage.getItem(draftKey('note1'))).toBeNull();
  });

  it('in an encrypted library, is recognised from its decrypted text', async () => {
    await encrypted();
    await openNote('note1');
    let lose = true;
    intercept = async (req, srv) => {
      if (req.method === 'PATCH' && lose) {
        lose = false;
        srv(req);
        throw new TypeError('Failed to fetch');
      }
      return undefined;
    };
    saver.edit('note1', { content: 'sealed edit' });
    await vi.advanceTimersByTimeAsync(900);
    await whileSaving('note1');
    expect(saver.statusOf('note1')).toBe('offline');
    // The retry's ciphertext differs from what landed, so the server reports a conflict: with our own text.
    intercept = null;
    await saver.flushAll();
    await settle();
    expect(saver.statusOf('note1')).toBe('saved');
    expect(saver.conflictOf('note1')).toBeNull();
    expect(saver.baseVersionOf('note1')).toBe(2);
    expect(await serverText('note1')).toBe('sealed edit');
  });
});

describe('notes not synced yet', () => {
  it('are listed (for the sidebar) while offline, failing or waiting for a choice, and leave the list once saved', async () => {
    const { createElement } = await import('react');
    const { act } = await import('react');
    const { createRoot } = await import('react-dom/client');
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const seen: Array<Array<{ id: string; status: string }>> = [];
    function Probe() {
      seen.push(saver.useUnsynced());
      return null;
    }
    const root = createRoot(document.createElement('div'));
    await act(async () => root.render(createElement(Probe)));
    const latest = () => seen.at(-1)!;

    await openNote('note1');
    await openNote('note2', { content: 'base' });
    intercept = async (req) => (req.path === '/api/notes/note1' ? Promise.reject(new TypeError('Failed to fetch')) : undefined);
    await savedElsewhere('note2', 'theirs');
    await act(async () => {
      saver.edit('note1', { content: 'offline edit' });
      saver.edit('note2', { content: 'mine' });
      await vi.advanceTimersByTimeAsync(900);
      await whileSaving('note1');
      await whileSaving('note2');
    });
    expect(latest()).toEqual([
      { id: 'note1', status: 'offline' },
      { id: 'note2', status: 'conflict' },
    ]);
    const before = latest();
    // Nothing changed: the same list, so the sidebar doesn't redraw.
    await act(async () => saver.edit('note2', { content: 'mine, more' }));
    expect(latest()).toBe(before);

    intercept = null;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
      await whileSaving('note1');
      await saver.resolveConflict('note2', 'theirs');
    });
    expect(latest()).toEqual([]);
    act(() => root.unmount());
  });
});

describe('a page closed while a save was on its way', () => {
  it('with more typed after it: the next session doesn’t take its own save for another device’s', async () => {
    await openNote('note1', { content: 'a' });
    // The save lands on the server, but the page closes before the reply.
    intercept = async (req, srv) => {
      if (req.method !== 'PATCH') return undefined;
      srv(req);
      await hold();
      throw new TypeError('Failed to fetch');
    };
    saver.edit('note1', { content: 'ab' });
    await vi.advanceTimersByTimeAsync(900);
    saver.edit('note1', { content: 'abc' });
    expect(draftOf('note1')).toMatchObject({ content: 'abc', baseVersion: 1 });

    // The page reloads (same tab, its drafts kept) and opens the note as the server has it now.
    saver.discardAll();
    vi.resetModules();
    apiMod = await import('../../src/lib/api');
    store = await import('../../src/lib/store');
    saver = await import('../../src/lib/saver');
    intercept = null;
    const { content: _c, ...meta } = rows.get('note1')!;
    expect(meta.version).toBe(2);
    store.upsertMeta(meta);
    store.noteCache.set('note1', { ...rows.get('note1')! });
    expect(saver.track({ ...rows.get('note1')! }).content).toBe('abc');
    await vi.advanceTimersByTimeAsync(50);
    await whileSaving('note1');
    await vi.advanceTimersByTimeAsync(50);
    await whileSaving('note1');
    expect(saver.statusOf('note1')).toBe('saved');
    expect(rows.get('note1')).toMatchObject({ content: 'abc', version: 3 });
  });

  it('with nothing typed after it: the draft matching the saved note is dropped', async () => {
    await openNote('note1', { content: 'a' });
    intercept = async (req, srv) => {
      if (req.method !== 'PATCH') return undefined;
      srv(req);
      await hold();
      throw new TypeError('Failed to fetch');
    };
    saver.edit('note1', { content: 'ab' });
    await vi.advanceTimersByTimeAsync(900);
    saver.discardAll();
    vi.resetModules();
    apiMod = await import('../../src/lib/api');
    store = await import('../../src/lib/store');
    saver = await import('../../src/lib/saver');
    intercept = null;
    expect(saver.track({ ...rows.get('note1')! })).toMatchObject({ content: 'ab', fromDraft: false });
    expect(localStorage.getItem(draftKey('note1'))).toBeNull();
  });
});

describe('a note deleted on another device', () => {
  beforeEach(() => {
    store.useApp.setState({ folders: [{ id: 'fold1', parent_id: null, name: 'Work', sort: 0, created_at: NOW, updated_at: NOW }] });
  });

  async function deletedWhileEditing(edit: { title?: string; content?: string }, init: Parameters<typeof openNote>[1] = {}) {
    await openNote('note1', { tags: ['work'], folder_id: 'fold1', ...init });
    rows.delete('note1');
    saver.edit('note1', edit);
    await vi.advanceTimersByTimeAsync(900);
    await saver.flush('note1');
    await settle();
  }

  it('saves the edits made here as a new note, in the same folder with the same tags', async () => {
    store.openNote('somewhere-else');
    await deletedWhileEditing({ content: 'rescued text' });
    expect(creates()).toEqual([expect.objectContaining({ title: 'Plan', content: 'rescued text', folder_id: 'fold1', tags: ['work'] })]);
    const copy = [...rows.values()][0];
    expect(copy.content).toBe('rescued text');
    const notes = store.useApp.getState().notes;
    expect(notes.note1).toBeUndefined();
    expect(notes[copy.id]).toMatchObject({ title: 'Plan', folder_id: 'fold1' });
    expect(store.noteCache.get(copy.id)).toMatchObject({ content: 'rescued text' });
    // Nothing more is sent for the deleted note, and no draft of it stays.
    expect(saver.pendingText('note1')).toBeNull();
    expect(Object.keys(localStorage).filter((k) => k.startsWith('kb.draft.'))).toEqual([]);
    expect(toasts()).toEqual(['This note was deleted on another device, so your edits here were saved as a new note.']);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(patches()).toHaveLength(1);
  });

  it('opens the copy, ready to type in, when the deleted note was the one being edited', async () => {
    store.openNote('note1');
    await deletedWhileEditing({ content: 'rescued text' });
    const copy = [...rows.values()][0];
    expect(store.useApp.getState().noteId).toBe(copy.id);
    expect(window.location.pathname).toBe(`/note/${copy.id}`);
    expect(store.preferredMode.get(copy.id)).toBe('edit');
  });

  it('keeps the note’s text when only its title was edited', async () => {
    await deletedWhileEditing({ title: 'Renamed' });
    expect(creates()).toEqual([expect.objectContaining({ title: 'Renamed', content: 'first' })]);
  });

  it('puts the copy at the top level when its folder is gone too', async () => {
    store.useApp.setState({ folders: [] });
    await deletedWhileEditing({ content: 'rescued text' });
    expect(creates()[0].folder_id).toBeNull();
  });

  it('makes one copy when the reply to making it is lost, however often it’s sent again', async () => {
    await openNote('note1', { tags: ['work'], folder_id: 'fold1' });
    rows.delete('note1');
    let lost = 0;
    intercept = async (req, real) => {
      if (req.method === 'POST' && req.path === '/api/notes' && lost < 2) {
        lost++;
        real(req); // it lands…
        return dropped(); // …but the reply never comes back
      }
      return undefined;
    };
    saver.edit('note1', { content: 'rescued once' });
    await vi.advanceTimersByTimeAsync(900);
    await whileSaving('note1');
    expect(saver.statusOf('note1')).toBe('offline');
    for (let i = 0; i < 3; i++) {
      await vi.advanceTimersByTimeAsync(10_000);
      await saver.flush('note1');
      await settle();
    }
    expect(creates().length).toBeGreaterThanOrEqual(3);
    expect([...rows.values()].map((r) => r.content)).toEqual(['rescued once']);
    const [copy] = [...rows.values()];
    expect(store.useApp.getState().notes[copy.id]).toMatchObject({ title: 'Plan', folder_id: 'fold1' });
    expect(store.useApp.getState().notes.note1).toBeUndefined();
    expect(Object.keys(localStorage).filter((k) => k.startsWith('kb.draft.'))).toEqual([]);
  });

  it('keeps both when another device already saved its own edits to the same deleted note', async () => {
    await openNote('note1');
    rows.delete('note1');
    // The other device's copy, under the id made from the deleted note's, with its own text.
    serve({ method: 'POST', path: '/api/notes', body: { id: 'note1_kept', title: 'Plan', content: 'their edits' }, query: new URLSearchParams() } as Req);
    saver.edit('note1', { content: 'my edits' });
    await vi.advanceTimersByTimeAsync(900);
    await saver.flush('note1');
    await settle();
    expect([...rows.values()].map((r) => r.content).sort()).toEqual(['my edits', 'their edits']);
    expect(rows.get('note1_kept')!.content).toBe('their edits');
  });

  it('keeps the edits and tries again when the copy can’t be made offline', async () => {
    await openNote('note1');
    rows.delete('note1');
    intercept = async (req) => (req.method === 'POST' ? dropped() : undefined);
    saver.edit('note1', { content: 'rescued later' });
    await vi.advanceTimersByTimeAsync(900);
    await whileSaving('note1');
    expect(saver.statusOf('note1')).toBe('offline');
    expect(draftOf('note1')).toMatchObject({ content: 'rescued later' });
    intercept = null;
    await vi.advanceTimersByTimeAsync(10_000);
    await saver.flush('note1');
    expect([...rows.values()].map((r) => r.content)).toEqual(['rescued later']);
    expect(store.useApp.getState().notes.note1).toBeUndefined();
  });

  it('sends what was typed while the copy was being made to the copy as well', async () => {
    await openNote('note1');
    rows.delete('note1');
    intercept = async (req) => (req.method === 'POST' ? hold() : undefined);
    saver.edit('note1', { content: 'rescued' });
    await vi.advanceTimersByTimeAsync(900);
    await settle();
    expect(held).toHaveLength(1);
    saver.edit('note1', { content: 'rescued, and more' });
    held.shift()!();
    await saver.flush('note1');
    const copy = [...rows.values()][0];
    await vi.advanceTimersByTimeAsync(900);
    await saver.flush(copy.id);
    expect(rows.get(copy.id)!.content).toBe('rescued, and more');
    expect(patches().filter((p) => p.content === 'rescued, and more')).toHaveLength(1);
  });

  it('in an encrypted library, saves the copy encrypted under a new id', async () => {
    await encrypted();
    await deletedWhileEditing({ content: 'secret rescue' });
    const body = creates()[0];
    expect(body).toMatchObject({ enc: true, kgen: 0 });
    expect(JSON.stringify(body)).not.toContain('secret rescue');
    const copy = rows.get(body.id)!;
    expect(await decryptText(key!, copy.content, at(copy.id, 'content'))).toBe('secret rescue');
    expect(store.useApp.getState().notes[copy.id]).toMatchObject({ title: 'Plan', tags: ['work'] });
  });

  it('makes no copy when nothing would be in it', async () => {
    await openNote('note1', { title: '', content: '' });
    rows.delete('note1');
    saver.edit('note1', { content: '   ' });
    await vi.advanceTimersByTimeAsync(900);
    await saver.flush('note1');
    expect(creates()).toEqual([]);
    expect(store.useApp.getState().notes.note1).toBeUndefined();
  });

  it('doesn’t take a 404 that isn’t the server saying the note is gone for a deletion', async () => {
    await openNote('note1');
    intercept = async (req) => (req.method === 'PATCH' ? json(404, { error: 'no_route', message: 'Not here.' }) : undefined);
    saver.edit('note1', { content: 'x' });
    await vi.advanceTimersByTimeAsync(900);
    await whileSaving('note1');
    expect(creates()).toEqual([]);
    expect(store.useApp.getState().notes.note1).toBeTruthy();
    expect(saver.pendingText('note1')).toEqual({ content: 'x' });
  });

  it('saves edits to a note moved to the trash elsewhere into it, and offers to restore it', async () => {
    await openNote('note1');
    rows.get('note1')!.deleted_at = NOW;
    saver.edit('note1', { content: 'still mine' });
    await vi.advanceTimersByTimeAsync(900);
    await saver.flush('note1');
    expect(rows.get('note1')!.content).toBe('still mine');
    const t = store.useApp.getState().toasts.at(-1)!;
    expect(t.message).toContain('was moved to the trash on another device');
    expect(t.action?.label).toBe('Restore');
  });
});

describe('stopping', () => {
  it('writes drafts one last time when the device locks, then sends and rewrites nothing', async () => {
    await openNote('note1');
    intercept = async (req) => (req.method === 'PATCH' ? hold() : undefined);
    saver.edit('note1', { content: 'on its way' });
    await vi.advanceTimersByTimeAsync(900);
    saver.edit('note1', { content: 'on its way, and more' });
    saver.freezeDrafts();
    expect(draftOf('note1')).toMatchObject({ content: 'on its way, and more' });
    // The vault now encrypts the drafts in place.
    localStorage.setItem(draftKey('note1'), 'SEALED');
    held.shift()!();
    await vi.advanceTimersByTimeAsync(30_000);
    await saver.flush('note1');
    saver.edit('note1', { content: 'typed while locking' });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(patches()).toHaveLength(1);
    expect(localStorage.getItem(draftKey('note1'))).toBe('SEALED');
  });

  it('leaves the draft of a save that fails while locking as it was sealed', async () => {
    await openNote('note1');
    intercept = async (req) => {
      if (req.method !== 'PATCH') return undefined;
      await hold();
      throw new TypeError('Failed to fetch');
    };
    saver.edit('note1', { content: 'secret' });
    await vi.advanceTimersByTimeAsync(900);
    saver.freezeDrafts();
    localStorage.setItem(draftKey('note1'), 'SEALED');
    held.shift()!();
    await vi.advanceTimersByTimeAsync(0);
    await saver.flush('note1');
    expect(localStorage.getItem(draftKey('note1'))).toBe('SEALED');
  });

  it('sends nothing more once signed out in another tab', async () => {
    await openNote('note1');
    saver.edit('note1', { content: 'x' });
    saver.discardAll();
    await vi.advanceTimersByTimeAsync(30_000);
    window.dispatchEvent(new Event('online'));
    await vi.advanceTimersByTimeAsync(0);
    expect(patches()).toHaveLength(0);
    expect(saver.statusOf('note1')).toBe('saved');
    expect(saver.hasUnsaved()).toBe(false);
  });

  it('once signed out in another tab, a save already on its way writes no draft back when it fails', async () => {
    await openNote('note1');
    intercept = async (req) => {
      if (req.method !== 'PATCH') return undefined;
      await hold();
      throw new TypeError('Failed to fetch');
    };
    saver.edit('note1', { content: 'private words' });
    await vi.advanceTimersByTimeAsync(900);
    saver.discardAll();
    // The signing-out tab clears this browser's storage.
    localStorage.clear();
    held.shift()!();
    await settle();
    expect(Object.keys(localStorage).filter((k) => k.startsWith('kb.draft.'))).toEqual([]);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(patches()).toHaveLength(1);
  });

  it('forgets a note’s queued edits and its drafts when it’s deleted on purpose', async () => {
    await openNote('note1');
    saver.edit('note1', { content: 'x' });
    saver.forget('note1');
    await vi.advanceTimersByTimeAsync(30_000);
    expect(patches()).toHaveLength(0);
    expect(localStorage.getItem(draftKey('note1'))).toBeNull();
  });
});

/* ------------------------------------- one person, one device at a time --- */

/** Another device saves new text into the note, `ago` ms before now, as the Worker would (a save id of its own). */
async function savedOnOtherDevice(id: string, content: string, ago = 0, title?: string) {
  await savedElsewhere(id, content);
  const row = rows.get(id)!;
  if (title !== undefined) {
    if (key) row.sealed = { ...row.sealed, t: await encryptText(key, title, at(id, 'title')) };
    else row.title = title;
  }
  row.updated_at = Date.now() - ago;
  row.saves = [...(row.saves ?? []), `other${row.version}xx`];
}

/** The page reloads in the same tab: drafts stay in storage, everything in memory goes. */
async function reload() {
  saver.discardAll();
  vi.resetModules();
  apiMod = await import('../../src/lib/api');
  store = await import('../../src/lib/store');
  saver = await import('../../src/lib/saver');
  if (key) {
    const e2ee = await import('../../src/lib/e2ee');
    apiMod.setKeyGen(0);
    apiMod.setCodec(e2ee.createCodec(key));
  }
}

/** Opens the note as it is on the server now, the way NoteView does after a reload (the note fetched, then tracked). */
async function reopen(id: string) {
  const note = await apiMod.api.getNote(id);
  const { content: _c, ...meta } = note;
  store.upsertMeta(meta);
  store.noteCache.set(id, note);
  return saver.track(note);
}

/** Lets the save that's due (or the retry of one) go, and anything it leads to, finish. */
async function letSavesFinish(id: string) {
  for (let i = 0; i < 4; i++) {
    await vi.advanceTimersByTimeAsync(11_000);
    await whileSaving(id);
    await settle();
  }
}

/** Every message shown from now on, even one gone again by the time the test looks. */
function watchToasts() {
  const seen: Array<ReturnType<typeof store.useApp.getState>['toasts'][number]> = [];
  store.useApp.subscribe((s, prev) => {
    for (const t of s.toasts) if (!prev.toasts.includes(t)) seen.push(t);
  });
  return seen;
}

describe('a phone that saved as it locked, and never heard back', () => {
  /** The phone edits, its save lands as it locks, and the page is killed before the reply. */
  async function lockedMidSave(text: string) {
    await openNote('note1', { content: 'Groceries\n- milk' });
    intercept = async (req, srv) => {
      if (req.method !== 'PATCH') return undefined;
      srv(req);
      await hold();
      throw new TypeError('Failed to fetch');
    };
    saver.edit('note1', { content: text });
    await vi.advanceTimersByTimeAsync(900);
    await settle();
    expect(rows.get('note1')!.version).toBe(2);
    expect(await serverText('note1')).toBe(text);
    intercept = null;
    // Picked up on the computer later on.
    await vi.advanceTimersByTimeAsync(600_000);
  }

  it('records the save in its draft as it goes, before any reply', async () => {
    await lockedMidSave('Groceries\n- milk\n- eggs');
    const draft = draftOf('note1');
    expect(draft).toMatchObject({ content: 'Groceries\n- milk\n- eggs', baseVersion: 1, base: { title: 'Plan', content: 'Groceries\n- milk' } });
    expect(draft.sent).toEqual([expect.objectContaining({ id: patches()[0].saveId })]);
  });

  it('when reopened after the other device built on that save, shows the newer version and asks nothing', async () => {
    await lockedMidSave('Groceries\n- milk\n- eggs');
    // On the computer: the phone's line is there, and the same lines are changed further.
    await savedOnOtherDevice('note1', 'Groceries\n- oat milk\n- eggs (a dozen)\n- bread', 60_000);
    await reload();
    saver.recoverDrafts();
    const shown = await reopen('note1');
    expect(shown.content).toBe('Groceries\n- milk\n- eggs');
    await letSavesFinish('note1');
    expect(saver.statusOf('note1')).toBe('saved');
    expect(saver.conflictOf('note1')).toBeNull();
    expect(rows.get('note1')).toMatchObject({ content: 'Groceries\n- oat milk\n- eggs (a dozen)\n- bread', version: 3 });
    expect(kept).toEqual([]);
    expect(toasts()).toEqual([]);
    expect(localStorage.getItem(draftKey('note1'))).toBeNull();
    expect(store.noteCache.get('note1')).toMatchObject({ content: 'Groceries\n- oat milk\n- eggs (a dozen)\n- bread', version: 3 });
  });

  it('tells the open note to show the newer version', async () => {
    await lockedMidSave('Groceries\n- milk\n- eggs');
    await savedOnOtherDevice('note1', 'Groceries\n- oat milk\n- eggs', 60_000);
    await reload();
    const shown: Array<{ id: string; content: string }> = [];
    saver.onTextReplaced((id, t) => shown.push({ id, content: t.content }));
    await reopen('note1');
    await letSavesFinish('note1');
    expect(shown).toEqual([{ id: 'note1', content: 'Groceries\n- oat milk\n- eggs' }]);
  });

  it('with more typed after that save, keeps the newer version and adds what was typed', async () => {
    await openNote('note1', { content: 'Groceries\n- milk\n\nNotes' });
    intercept = async (req, srv) => {
      if (req.method !== 'PATCH') return undefined;
      srv(req);
      await hold();
      throw new TypeError('Failed to fetch');
    };
    saver.edit('note1', { content: 'Groceries\n- milk\n- eggs\n\nNotes' });
    await vi.advanceTimersByTimeAsync(900);
    // Typed while that save was on its way, and never sent: the page was killed.
    saver.edit('note1', { content: 'Groceries\n- milk\n- eggs\n\nNotes\nBuy on Friday' });
    expect(draftOf('note1').sent).toEqual([expect.objectContaining({ text: { content: 'Groceries\n- milk\n- eggs\n\nNotes' } })]);
    intercept = null;
    // Ten minutes later on the computer, the line next to the phone's is changed.
    await vi.advanceTimersByTimeAsync(600_000);
    await savedOnOtherDevice('note1', 'Groceries\n- oat milk\n- eggs\n\nNotes');
    await vi.advanceTimersByTimeAsync(3_000_000);
    await reload();
    saver.recoverDrafts();
    await reopen('note1');
    await letSavesFinish('note1');
    expect(saver.statusOf('note1')).toBe('saved');
    expect(rows.get('note1')!.content).toBe('Groceries\n- oat milk\n- eggs\n\nNotes\nBuy on Friday');
    expect(kept).toEqual([]);
  });

  it('in an encrypted library, the same', async () => {
    await encrypted();
    await lockedMidSave('Groceries\n- milk\n- eggs');
    await savedOnOtherDevice('note1', 'Groceries\n- oat milk\n- eggs (a dozen)', 60_000);
    await reload();
    saver.recoverDrafts();
    await reopen('note1');
    await letSavesFinish('note1');
    expect(saver.statusOf('note1')).toBe('saved');
    expect(await serverText('note1')).toBe('Groceries\n- oat milk\n- eggs (a dozen)');
    expect(kept).toEqual([]);
  });
});

describe('edits that change nothing', () => {
  it('aren’t sent, so a note changed elsewhere meanwhile meets no conflict', async () => {
    await openNote('note1', { content: 'base' });
    await savedOnOtherDevice('note1', 'theirs');
    saver.edit('note1', { content: 'base!' });
    saver.edit('note1', { content: 'base' });
    await vi.advanceTimersByTimeAsync(900);
    await saver.flush('note1');
    expect(patches()).toHaveLength(0);
    expect(saver.statusOf('note1')).toBe('saved');
    expect(localStorage.getItem(draftKey('note1'))).toBeNull();
  });

  it('left as a draft by an earlier session are dropped, whatever the note became since', async () => {
    await openNote('note1', { content: 'base' });
    intercept = async (req) => (req.method === 'PATCH' ? dropped() : undefined);
    saver.edit('note1', { content: 'base, typed' });
    // Undone before the page was closed (it never got the chance to send that).
    saver.edit('note1', { content: 'base' });
    intercept = null;
    await savedOnOtherDevice('note1', 'theirs, much later', 60_000);
    await reload();
    expect((await reopen('note1')).fromDraft).toBe(false);
    await letSavesFinish('note1');
    expect(patches()).toHaveLength(0);
    expect(Object.keys(localStorage).filter((k) => k.startsWith('kb.draft.'))).toEqual([]);
  });

  it('when recovered at start-up, are dropped without sending anything', async () => {
    await openNote('note1', { content: 'base' });
    saver.edit('note1', { content: 'base' });
    await savedOnOtherDevice('note1', 'theirs');
    await reload();
    saver.recoverDrafts();
    await letSavesFinish('note1');
    expect(patches()).toHaveLength(0);
    expect(Object.keys(localStorage).filter((k) => k.startsWith('kb.draft.'))).toEqual([]);
  });
});

describe('edits here and on another device to different parts of a note', () => {
  it('are combined and saved, without asking, and the person is told', async () => {
    await openNote('note1', { content: 'Intro\n\nMiddle\n\nEnd' });
    saver.edit('note1', { content: 'Intro, edited here\n\nMiddle\n\nEnd' });
    await savedOnOtherDevice('note1', 'Intro\n\nMiddle\n\nEnd, edited there');
    const shown: string[] = [];
    saver.onTextReplaced((_id, t) => shown.push(t.content));
    const told = watchToasts();
    await letSavesFinish('note1');
    expect(saver.statusOf('note1')).toBe('saved');
    expect(rows.get('note1')).toMatchObject({ content: 'Intro, edited here\n\nMiddle\n\nEnd, edited there', version: 3 });
    expect(shown).toEqual(['Intro, edited here\n\nMiddle\n\nEnd, edited there']);
    expect(told.map((t) => t.message)).toEqual(['“Plan” was also changed on another device. Both sets of changes are kept.']);
    expect(patches().at(-1)).toMatchObject({ baseVersion: 2 });
  });

  it('keep a title changed here with text changed there', async () => {
    await openNote('note1', { content: 'Body' });
    saver.edit('note1', { title: 'Renamed here' });
    await savedOnOtherDevice('note1', 'Body, changed there');
    await letSavesFinish('note1');
    expect(saver.statusOf('note1')).toBe('saved');
    expect(rows.get('note1')).toMatchObject({ title: 'Renamed here', content: 'Body, changed there' });
  });

  it('in an encrypted library, are combined from the decrypted text and sent encrypted', async () => {
    await encrypted();
    await openNote('note1', { content: 'one\ntwo\nthree' });
    saver.edit('note1', { content: 'ONE\ntwo\nthree' });
    await savedOnOtherDevice('note1', 'one\ntwo\nTHREE');
    await letSavesFinish('note1');
    expect(saver.statusOf('note1')).toBe('saved');
    expect(await serverText('note1')).toBe('ONE\ntwo\nTHREE');
    expect(JSON.stringify(patches())).not.toContain('ONE');
  });

  it('made from outside the editor (a task ticked in the Tasks view) are combined too', async () => {
    const { changeNoteText } = await import('../../src/lib/liveEdit');
    await openNote('note1', { content: '- [ ] one\n- [ ] two' });
    expect(changeNoteText('note1', (s) => s.replace('[ ] one', '[x] one'))).toBe(true);
    await savedOnOtherDevice('note1', '- [ ] one\n- [ ] two\n- [ ] three');
    await letSavesFinish('note1');
    expect(saver.statusOf('note1')).toBe('saved');
    expect(rows.get('note1')!.content).toBe('- [x] one\n- [ ] two\n- [ ] three');
  });
});

describe('edits that can’t be combined with a newer version', () => {
  it('made here before the other device saved: the newer version stays, and these go into history', async () => {
    await openNote('note1', { content: 'The plan' });
    intercept = async (req) => (req.method === 'PATCH' ? dropped() : undefined);
    saver.edit('note1', { content: 'The plan, from the phone' });
    await vi.advanceTimersByTimeAsync(900);
    expect(saver.statusOf('note1')).toBe('offline');
    // An hour later, on the computer, the same line is rewritten; then the phone is back online.
    await vi.advanceTimersByTimeAsync(3_600_000 - 60_000);
    await savedOnOtherDevice('note1', 'The plan, from the computer');
    intercept = null;
    const shown: string[] = [];
    saver.onTextReplaced((_id, t) => shown.push(t.content));
    const told = watchToasts();
    await letSavesFinish('note1');
    expect(saver.statusOf('note1')).toBe('saved');
    expect(saver.conflictOf('note1')).toBeNull();
    expect(rows.get('note1')!.content).toBe('The plan, from the computer');
    expect(kept).toEqual([{ id: 'note1', body: { title: 'Plan', content: 'The plan, from the phone', at: NOW } }]);
    expect(shown).toEqual(['The plan, from the computer']);
    expect(told).toHaveLength(1);
    const t = told[0];
    expect(t.message).toBe('“Plan” was changed on another device after your edits here, so it shows that newer version. Your edits are kept in its version history.');
    t.action!.run();
    expect(store.useApp.getState()).toMatchObject({ noteId: 'note1', historyFor: 'note1' });
    expect(localStorage.getItem(draftKey('note1'))).toBeNull();
  });

  it('left from a session before edits remembered their starting text: the same', async () => {
    rows.set('note1', { id: 'note1', folder_id: null, title: 'Plan', excerpt: '', info: {}, tags: [], pinned: false, version: 7, created_at: NOW, updated_at: NOW - 60_000, deleted_at: null, content: 'Newer, from the computer' });
    localStorage.setItem(draftKey('note1'), JSON.stringify({ content: 'Older, from the phone', baseVersion: 4, at: NOW - 3_600_000 }));
    store.upsertMeta(metaOf(rows.get('note1')!));
    saver.recoverDrafts();
    await letSavesFinish('note1');
    expect(saver.statusOf('note1')).toBe('saved');
    expect(rows.get('note1')!.content).toBe('Newer, from the computer');
    expect(kept.map((k) => k.body.content)).toEqual(['Older, from the phone']);
  });

  it('in an encrypted library, keeps the edits from here encrypted', async () => {
    await encrypted();
    await openNote('note1', { content: 'The plan' });
    intercept = async (req) => (req.method === 'PATCH' ? dropped() : undefined);
    saver.edit('note1', { content: 'The plan, from the phone' });
    await vi.advanceTimersByTimeAsync(900);
    await vi.advanceTimersByTimeAsync(600_000);
    await savedOnOtherDevice('note1', 'The plan, from the computer');
    intercept = null;
    await letSavesFinish('note1');
    expect(saver.statusOf('note1')).toBe('saved');
    expect(kept).toHaveLength(1);
    expect(kept[0].body).toMatchObject({ enc: true, kgen: 0, sealed: { t: expect.stringMatching(/^e1:/) } });
    expect(JSON.stringify(kept[0].body)).not.toContain('phone');
    expect(await decryptText(key!, kept[0].body.content, at('note1', 'content'))).toBe('The plan, from the phone');
  });

  it('typed here after the other device saved (on text this one hadn’t caught up with): asks', async () => {
    await openNote('note1', { content: 'The plan' });
    await savedOnOtherDevice('note1', 'The plan, from the computer', 60_000);
    saver.edit('note1', { content: 'The plan, typed just now' });
    await letSavesFinish('note1');
    expect(saver.statusOf('note1')).toBe('conflict');
    expect(saver.conflictOf('note1')).toMatchObject({ content: 'The plan, from the computer' });
    expect(kept).toEqual([]);
  });

  it('older, but the server won’t keep them in history: asks rather than lose them', async () => {
    await openNote('note1', { content: 'The plan' });
    intercept = async (req) => (req.method === 'PATCH' ? dropped() : undefined);
    saver.edit('note1', { content: 'The plan, from the phone' });
    await vi.advanceTimersByTimeAsync(900);
    await vi.advanceTimersByTimeAsync(600_000);
    await savedOnOtherDevice('note1', 'The plan, from the computer');
    intercept = async (req) => (req.method === 'POST' && req.path.endsWith('/versions') ? json(500, { error: 'boom', message: 'Broken.' }) : undefined);
    await letSavesFinish('note1');
    expect(saver.statusOf('note1')).toBe('conflict');
    expect(draftOf('note1')).toMatchObject({ content: 'The plan, from the phone' });
  });

  it('older, but typed into while they were being kept: asks, as those edits are the newest', async () => {
    await openNote('note1', { content: 'The plan' });
    intercept = async (req) => (req.method === 'PATCH' ? dropped() : undefined);
    saver.edit('note1', { content: 'The plan, from the phone' });
    await vi.advanceTimersByTimeAsync(900);
    await vi.advanceTimersByTimeAsync(600_000);
    await savedOnOtherDevice('note1', 'The plan, from the computer');
    intercept = async (req) => {
      if (req.method === 'POST' && req.path.endsWith('/versions')) {
        saver.edit('note1', { content: 'The plan, from the phone, and more' });
      }
      return undefined;
    };
    await vi.advanceTimersByTimeAsync(10_000);
    await whileSaving('note1');
    await settle();
    expect(saver.statusOf('note1')).toBe('conflict');
    expect(saver.pendingText('note1')).toMatchObject({ content: 'The plan, from the phone, and more' });
    expect(rows.get('note1')!.content).toBe('The plan, from the computer');
  });
});
