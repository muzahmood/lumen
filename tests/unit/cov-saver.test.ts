// @vitest-environment jsdom
/**
 * Autosave's less travelled paths (src/lib/saver.ts), beyond sync-saver.test.ts: a reply that comes
 * back after the note was deleted or the device signed out, reopening a note whose edits are still on
 * their way, drafts that can't be read, a conflict with this device's own save while the title changed
 * too, the actions offered for notes that aren't open, storage that refuses writes, and the page
 * being hidden.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { json, NOW, plainRow, polyfillMatchMedia, settle, standInServer, type Req, type StandIn } from './cov-helpers';

polyfillMatchMedia();

let saver: typeof import('../../src/lib/saver');
let store: typeof import('../../src/lib/store');
let apiMod: typeof import('../../src/lib/api');
let server: StandIn;
let tab: string;
let tabSeq = 0;

const patches = () => server.requests('PATCH', /^\/api\/notes\//).map((r) => r.body);
const draftsOf = (id: string) => Object.keys(localStorage).filter((k) => k.startsWith(`kb.draft.${id}~`));

/** Requests held until the test lets them through. */
function holdNext(method: string, path: RegExp) {
  let release!: (fn?: (req: Req) => Response | undefined) => void;
  const gate = new Promise<((req: Req) => Response | undefined) | undefined>((r) => (release = r));
  let used = false;
  server.on(method, path, async (req) => {
    if (used) return undefined;
    used = true;
    const answer = await gate;
    return answer?.(req);
  });
  return (fn?: (req: Req) => Response | undefined) => release(fn);
}

function seed(id: string, fields: Partial<ReturnType<typeof plainRow>> = {}) {
  const row = plainRow(id, { title: 'Title', content: 'Saved text', ...fields });
  server.rows.set(id, row);
  const { content, ...meta } = row;
  store.upsertMeta(meta as never);
  store.noteCache.set(id, { ...meta, content } as never);
  return row;
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'], now: NOW });
  vi.stubGlobal('BroadcastChannel', undefined);
  localStorage.clear();
  sessionStorage.clear();
  tab = `savetab${++tabSeq}`;
  sessionStorage.setItem('kb.tab-id', tab);
  server = standInServer();
  vi.resetModules();
  apiMod = await import('../../src/lib/api');
  store = await import('../../src/lib/store');
  saver = await import('../../src/lib/saver');
  store.useApp.setState({ status: 'ready', notes: {}, toasts: [], noteId: null });
});

afterEach(() => {
  saver.discardAll();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('a reply that arrives too late to matter', () => {
  it('after the note was deleted for good, doesn’t bring it back to the list or leave a draft', async () => {
    seed('gone1');
    const release = holdNext('PATCH', /^\/api\/notes\/gone1$/);
    saver.track(store.noteCache.get('gone1')!);
    saver.edit('gone1', { content: 'typed just before deleting' });
    const saving = saver.flush('gone1');
    await settle();
    // Deleted forever from this device while the save was on its way.
    saver.forget('gone1');
    store.removeMeta('gone1');
    release();
    await saving;
    await settle();
    expect(store.useApp.getState().notes.gone1).toBeUndefined();
    expect(draftsOf('gone1')).toEqual([]);
    expect(saver.statusOf('gone1')).toBe('saved');
  });

  it('after signing out in another tab, writes no draft back, even when the save failed', async () => {
    seed('so1');
    const release = holdNext('PATCH', /^\/api\/notes\/so1$/);
    saver.track(store.noteCache.get('so1')!);
    saver.edit('so1', { content: 'unsent' });
    const saving = saver.flush('so1');
    await settle();
    saver.discardAll();
    localStorage.clear(); // what signing out does to this browser's storage
    release(() => json(500, { error: 'server_error', message: 'Try again' }));
    await saving;
    await settle();
    expect(draftsOf('so1')).toEqual([]);
    expect(saver.hasUnsaved()).toBe(false);
  });
});

describe('reopening a note', () => {
  it('while its edits are still waiting to go shows those edits, not the saved text', async () => {
    seed('re1');
    saver.track(store.noteCache.get('re1')!);
    saver.edit('re1', { title: 'New title', content: 'Not sent yet' });
    // The editor closes and opens the note again before the save goes.
    expect(saver.track(store.noteCache.get('re1')!)).toEqual({ title: 'New title', content: 'Not sent yet', fromDraft: true });
    expect(saver.pendingText('re1')).toEqual({ title: 'New title', content: 'Not sent yet' });
  });

  it('ignores a draft it can’t read (encrypted while the device was locked) and keeps it', async () => {
    seed('lk1');
    localStorage.setItem(`kb.draft.lk1~${tab}`, 'e1:sealed-draft-ciphertext');
    expect(saver.track(store.noteCache.get('lk1')!)).toEqual({ title: 'Title', content: 'Saved text', fromDraft: false });
    expect(localStorage.getItem(`kb.draft.lk1~${tab}`)).toBe('e1:sealed-draft-ciphertext');
    expect(saver.statusOf('lk1')).toBe('saved');
    expect(saver.readDraft('lk1')).toBeNull();
  });

  it('readDraft names this tab’s own draft first, then the newest one a closed tab left', () => {
    localStorage.setItem('kb.draft.rd1~closedA', JSON.stringify({ content: 'older closed', baseVersion: 1, at: NOW - 5000 }));
    localStorage.setItem('kb.draft.rd1~closedB', JSON.stringify({ content: 'newer closed', baseVersion: 1, at: NOW - 1000 }));
    expect(saver.readDraft('rd1')?.content).toBe('newer closed');
    localStorage.setItem(`kb.draft.rd1~${tab}`, JSON.stringify({ content: 'mine', baseVersion: 1, at: NOW - 9000 }));
    expect(saver.readDraft('rd1')?.content).toBe('mine');
    // An open tab's draft is that tab's own.
    localStorage.setItem('kb.tab.openC', String(NOW));
    localStorage.setItem('kb.draft.rd2~openC', JSON.stringify({ content: 'theirs', baseVersion: 1, at: NOW }));
    expect(saver.readDraft('rd2')).toBeNull();
  });
});

describe('a conflict with this device’s own save', () => {
  it('sends only what’s still different: a title changed since, not the text that already landed', async () => {
    seed('own1', { version: 3 });
    saver.track(store.noteCache.get('own1')!);
    // The first save lands, but its reply is lost.
    server.on('PATCH', '/api/notes/own1', async (req) => {
      if (req.body.content !== 'Landed text' || req.body.title !== undefined) return undefined;
      const row = server.rows.get('own1')!;
      row.content = 'Landed text';
      row.version = 4;
      throw new TypeError('Failed to fetch');
    });
    saver.edit('own1', { content: 'Landed text' });
    await saver.flush('own1');
    expect(saver.statusOf('own1')).toBe('offline');
    saver.edit('own1', { title: 'Renamed meanwhile' });
    await saver.flush('own1');
    await vi.advanceTimersByTimeAsync(100);
    await settle();
    expect(saver.statusOf('own1')).toBe('saved');
    expect(saver.conflictOf('own1')).toBeNull();
    expect(patches().at(-1)).toEqual({ title: 'Renamed meanwhile', baseVersion: 4, saveId: expect.any(String) });
    expect(server.rows.get('own1')).toMatchObject({ title: 'Renamed meanwhile', content: 'Landed text', version: 5 });
  });
});

describe('answering a conflict', () => {
  it('“theirs” when theirs couldn’t be read keeps the edits here in history, then drops them and asks nothing more', async () => {
    seed('cf1', { version: 2 });
    saver.track({ ...store.noteCache.get('cf1')!, version: 1 });
    server.on('PATCH', '/api/notes/cf1', () => json(409, { error: 'conflict', message: 'Changed on another device.' }));
    server.on('POST', '/api/notes/cf1/versions', () => json(201, { ok: true, id: 1 }));
    saver.edit('cf1', { content: 'mine' });
    await saver.flush('cf1');
    expect(saver.statusOf('cf1')).toBe('conflict');
    expect(saver.conflictOf('cf1')).toBeNull();
    expect(await saver.resolveConflict('cf1', 'theirs')).toBeNull();
    expect(server.requests('POST', '/api/notes/cf1/versions').map((r) => r.body)).toEqual([expect.objectContaining({ content: 'mine' })]);
    expect(saver.statusOf('cf1')).toBe('saved');
    expect(saver.pendingText('cf1')).toBeNull();
    expect(draftsOf('cf1')).toEqual([]);
  });

  it('for a note with nothing tracked does nothing', async () => {
    expect(await saver.resolveConflict('nobody', 'mine')).toBeNull();
    expect(server.log).toEqual([]);
  });
});

describe('notes that aren’t open', () => {
  it('saved into a note trashed on another device: says so, and Restore brings it back', async () => {
    seed('tr1');
    saver.track(store.noteCache.get('tr1')!);
    server.rows.get('tr1')!.deleted_at = NOW - 1000;
    saver.edit('tr1', { content: 'edits into the trash' });
    await saver.flush('tr1');
    const t = store.useApp.getState().toasts.find((x) => x.message.includes('was moved to the trash on another device'));
    expect(t?.message).toBe('“Title” was moved to the trash on another device. Your edits were saved in it.');
    t!.action!.run();
    await settle();
    expect(server.requests('POST', '/api/notes/tr1/restore')).toHaveLength(1);
    expect(store.useApp.getState().notes.tr1.deleted_at).toBeNull();
  });

  it('a conflict in the background offers to open the note', async () => {
    seed('bg1', { title: 'Background note', version: 5, content: 'Their text' });
    // This device last had version 4, before the other device changed the same line.
    saver.track({ ...store.noteCache.get('bg1')!, version: 4, content: 'Saved text' });
    store.useApp.setState({ noteId: 'someother' });
    saver.edit('bg1', { content: 'mine' });
    await saver.flush('bg1');
    const t = store.useApp.getState().toasts.find((x) => x.message.startsWith('“Background note”'));
    expect(t?.message).toBe('“Background note” was changed on another device. Open it to choose which version to keep.');
    t!.action!.run();
    expect(store.useApp.getState().noteId).toBe('bg1');
  });

  it('edits to a note deleted elsewhere, saved as a new note, can be opened from the message', async () => {
    seed('del1', { title: 'Deleted elsewhere' });
    saver.track(store.noteCache.get('del1')!);
    server.rows.delete('del1');
    saver.edit('del1', { content: 'rescue me' });
    await saver.flush('del1');
    await settle();
    const copy = [...server.rows.values()].find((r) => r.content === 'rescue me');
    expect(copy).toMatchObject({ title: 'Deleted elsewhere' });
    const t = store.useApp.getState().toasts.find((x) => x.message.startsWith('This note was deleted on another device'));
    expect(t?.action?.label).toBe('Open');
    t!.action!.run();
    expect(store.useApp.getState().noteId).toBe(copy!.id);
  });
});

describe('storage that refuses writes', () => {
  it('when it isn’t full (private mode), says nothing and still saves', async () => {
    seed('pm1');
    saver.track(store.noteCache.get('pm1')!);
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('The operation is insecure.', 'SecurityError');
    });
    saver.edit('pm1', { content: 'kept in memory' });
    expect(store.useApp.getState().toasts).toEqual([]);
    await saver.flush('pm1');
    expect(server.rows.get('pm1')!.content).toBe('kept in memory');
    expect(saver.statusOf('pm1')).toBe('saved');
  });
});

describe('the page being hidden', () => {
  it('sends waiting edits straight away, as requests that outlive the page', async () => {
    seed('hid1');
    saver.track(store.noteCache.get('hid1')!);
    saver.edit('hid1', { content: 'phone locked mid-sentence' });
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    try {
      document.dispatchEvent(new Event('visibilitychange'));
      await settle();
    } finally {
      Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    }
    const sent = server.requests('PATCH', '/api/notes/hid1');
    expect(sent).toHaveLength(1);
    expect(sent[0].keepalive).toBe(true);
    expect(server.rows.get('hid1')!.content).toBe('phone locked mid-sentence');
  });

  it('a save confirmed tells listeners the new version, and they can stop listening', async () => {
    seed('ls1');
    saver.track(store.noteCache.get('ls1')!);
    const heard: unknown[] = [];
    const stop = saver.onNoteSaved((...args) => heard.push(args));
    saver.edit('ls1', { content: 'one' });
    await saver.flush('ls1');
    stop();
    saver.edit('ls1', { content: 'two' });
    await saver.flush('ls1');
    expect(heard).toEqual([['ls1', 2, 'one', 1]]);
  });
});

describe('an unusable answer from the API layer', () => {
  it('a save refused for a reason that would only repeat waits for the next edit, and says why', async () => {
    seed('big1', { title: 'Huge' });
    saver.track(store.noteCache.get('big1')!);
    store.useApp.setState({ noteId: 'elsewhere' });
    server.on('PATCH', '/api/notes/big1', () => json(413, { error: 'too_large', message: 'Note is too large.' }));
    saver.edit('big1', { content: 'x'.repeat(10) });
    await saver.flush('big1');
    expect(saver.statusOf('big1')).toBe('failed');
    expect(saver.errorOf('big1')).toBe('Note is too large.');
    expect(store.useApp.getState().toasts.map((t) => t.message)).toContain('“Huge” couldn’t be saved: Note is too large.');
    await saver.flushAll();
    expect(server.requests('PATCH', '/api/notes/big1')).toHaveLength(1);
    // The session ending has its own banner: no message about the note.
    seed('auth1', { title: 'Signed out' });
    saver.track(store.noteCache.get('auth1')!);
    server.on('PATCH', '/api/notes/auth1', () => json(403, { error: 'forbidden', message: 'Missing client header.' }));
    saver.edit('auth1', { content: 'y' });
    await saver.flush('auth1');
    expect(saver.statusOf('auth1')).toBe('failed');
    expect(store.useApp.getState().toasts.map((t) => t.message).some((m) => m.startsWith('“Signed out”'))).toBe(false);
    void apiMod;
  });
});
