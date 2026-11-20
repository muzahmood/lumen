// @vitest-environment jsdom
/**
 * The app's state and its one-note actions (src/lib/store.ts), beyond sync-store.test.ts (which covers
 * changing many notes at once): the welcome note, loading failing, one note's folder, tags or pin not
 * saving, the trash and deleting forever, folders, and getting around.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { json, NOW, plainRow, polyfillMatchMedia, settle, standInServer, type StandIn } from './cov-helpers';

polyfillMatchMedia();

let store: typeof import('../../src/lib/store');
let saver: typeof import('../../src/lib/saver');
let apiMod: typeof import('../../src/lib/api');
let server: StandIn;

const folder = (id: string, parent: string | null = null, name = id) => ({ id, name, parent_id: parent, sort: 0, created_at: NOW, updated_at: NOW });
const toasts = () => store.useApp.getState().toasts;

async function answer(value: unknown) {
  await vi.waitFor(() => expect(store.useApp.getState().dialog).not.toBeNull());
  const d = store.useApp.getState().dialog!;
  store.useApp.setState({ dialog: null });
  d.resolve(value as never);
  return d;
}

function seed(id: string, fields: Partial<ReturnType<typeof plainRow>> = {}) {
  const row = plainRow(id, { content: 'text', ...fields });
  server.rows.set(id, row);
  const { content: _c, ...meta } = row;
  store.upsertMeta(meta as never);
  return row;
}

beforeEach(async () => {
  vi.stubGlobal('BroadcastChannel', undefined);
  localStorage.clear();
  sessionStorage.clear();
  history.replaceState(null, '', '/');
  server = standInServer();
  vi.resetModules();
  apiMod = await import('../../src/lib/api');
  store = await import('../../src/lib/store');
  saver = await import('../../src/lib/saver');
  store.useApp.setState({ toasts: [], dialog: null });
});

afterEach(() => {
  saver.discardAll();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('the welcome note', () => {
  it('is made once, for an empty library, pinned and tagged as a guide', async () => {
    await store.loadAll();
    const made = server.requests('POST', '/api/notes');
    expect(made).toHaveLength(1);
    expect(made[0].body).toMatchObject({ title: 'Welcome to Lumen', tags: ['guide'], pinned: true });
    expect(Object.values(store.useApp.getState().notes).map((n) => n.title)).toEqual(['Welcome to Lumen']);
    // Deleted later, it isn't made again on the next load.
    server.rows.clear();
    await store.loadAll();
    expect(server.requests('POST', '/api/notes')).toHaveLength(1);
  });

  it('isn’t made on a quiet refresh, or when the library has folders', async () => {
    await store.loadAll(true);
    expect(server.requests('POST', '/api/notes')).toEqual([]);
    server.folders.push(folder('fold1'));
    await store.loadAll();
    expect(server.requests('POST', '/api/notes')).toEqual([]);
  });

  it('failing to be made doesn’t stop the library loading', async () => {
    server.on('POST', '/api/notes', () => json(500, { error: 'server_error', message: 'Try again' }));
    await store.loadAll();
    expect(store.useApp.getState().status).toBe('ready');
    expect(store.useApp.getState().notes).toEqual({});
  });
});

describe('loading', () => {
  it('that fails shows why, unless it was a quiet refresh of a list already showing', async () => {
    server.on('GET', '/api/bootstrap', () => Promise.reject(new TypeError('Failed to fetch')));
    await store.loadAll();
    expect(store.useApp.getState()).toMatchObject({ status: 'error', loadError: 'Can’t reach the server. Check your connection.' });
  });

  it('shares one request between calls made together', async () => {
    await Promise.all([store.loadAll(true), store.loadAll(true), store.loadAll(true)]);
    expect(server.requests('GET', '/api/bootstrap')).toHaveLength(1);
  });

  it('refreshes when the tab comes back after more than 10 seconds, and not sooner', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: NOW });
    await store.loadAll(true);
    const visible = () => document.dispatchEvent(new Event('visibilitychange'));
    vi.setSystemTime(NOW + 5_000);
    visible();
    await settle();
    expect(server.requests('GET', '/api/bootstrap')).toHaveLength(1);
    vi.setSystemTime(NOW + 15_000);
    visible();
    await settle();
    expect(server.requests('GET', '/api/bootstrap')).toHaveLength(2);
  });

  it('refreshes when the window gets focus again, or the connection comes back', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: NOW });
    await store.loadAll(true);
    vi.setSystemTime(NOW + 15_000);
    window.dispatchEvent(new Event('focus'));
    await settle();
    expect(server.requests('GET', '/api/bootstrap')).toHaveLength(2);
    vi.setSystemTime(NOW + 30_000);
    window.dispatchEvent(new Event('online'));
    await settle();
    expect(server.requests('GET', '/api/bootstrap')).toHaveLength(3);
  });

  it('refreshes on the first touch after a minute without one (a window that kept focus meanwhile)', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: NOW });
    await store.loadAll(true);
    const touch = () => window.dispatchEvent(new Event('pointerdown'));
    touch();
    vi.setSystemTime(NOW + 30_000);
    touch();
    await settle();
    expect(server.requests('GET', '/api/bootstrap')).toHaveLength(1);
    vi.setSystemTime(NOW + 100_000);
    touch();
    await settle();
    expect(server.requests('GET', '/api/bootstrap')).toHaveLength(2);
  });
});

describe('changing one note’s folder, tags or pin', () => {
  it('shows the change at once and keeps it when it saves', async () => {
    seed('n1');
    await store.updateNoteMeta('n1', { pinned: true });
    expect(store.useApp.getState().notes.n1.pinned).toBe(true);
    expect(server.rows.get('n1')!.pinned).toBe(true);
  });

  it('puts back only what it changed when the save fails, and says why', async () => {
    seed('n1', { tags: ['a'] });
    server.on('PATCH', '/api/notes/n1', () => json(500, { error: 'server_error', message: 'Something went wrong on the server.' }));
    const saving = store.updateNoteMeta('n1', { tags: ['a', 'b'] });
    expect(store.useApp.getState().notes.n1.tags).toEqual(['a', 'b']);
    // A save of the note's text landed meanwhile.
    store.upsertMeta({ ...store.useApp.getState().notes.n1, title: 'Newer title', version: 2 });
    await saving;
    expect(store.useApp.getState().notes.n1).toMatchObject({ tags: ['a'], title: 'Newer title', version: 2 });
    expect(toasts().map((t) => t.message)).toEqual(['Something went wrong on the server.']);
  });

  it('refreshes the list when the folder it was moved to was deleted elsewhere', async () => {
    seed('n1');
    server.on('PATCH', '/api/notes/n1', () => json(404, { error: 'folder_missing', message: 'That folder no longer exists.' }));
    await store.updateNoteMeta('n1', { folder_id: 'gone1' });
    await settle();
    expect(store.useApp.getState().notes.n1.folder_id).toBeNull();
    expect(server.requests('GET', '/api/bootstrap')).toHaveLength(1);
  });
});

describe('the trash', () => {
  it('trashing the open note goes home, with Undo to bring it back and open it', async () => {
    seed('n1');
    store.openNote('n1');
    await store.trashNote('n1');
    expect(store.useApp.getState().noteId).toBeNull();
    expect(store.useApp.getState().notes.n1.deleted_at).not.toBeNull();
    const t = toasts().find((x) => x.message === 'Moved to trash')!;
    t.action!.run();
    await settle();
    expect(store.useApp.getState().notes.n1.deleted_at).toBeNull();
    expect(store.useApp.getState().noteId).toBe('n1');
  });

  it('“Delete forever” from that message asks first, then deletes the note and its unsent edits', async () => {
    seed('n1');
    await store.trashNote('n1');
    saver.track({ ...plainRow('n1'), version: 1 } as never);
    saver.edit('n1', { content: 'never to be sent' });
    toasts().find((x) => x.message === 'Moved to trash')!.more![0].run();
    const d = await answer(true);
    expect(d).toMatchObject({ title: 'Delete this note forever?', danger: true });
    await vi.waitFor(() => expect(server.rows.has('n1')).toBe(false));
    await settle();
    expect(store.useApp.getState().notes.n1).toBeUndefined();
    expect(saver.pendingText('n1')).toBeNull();
    await saver.flushAll();
    expect(server.requests('PATCH', '/api/notes/n1')).toEqual([]);
    expect(server.requests('POST', '/api/notes')).toEqual([]);
    expect(Object.keys(localStorage).filter((k) => k.startsWith('kb.draft.n1'))).toEqual([]);
  });

  it('deleting forever does nothing when declined, and says why when it fails', async () => {
    seed('n1', { deleted_at: NOW });
    const declined = store.deleteNoteForever('n1');
    await answer(false);
    await declined;
    expect(server.requests('DELETE', '/api/notes/n1')).toEqual([]);
    server.on('DELETE', '/api/notes/n1', () => Promise.reject(new TypeError('Failed to fetch')));
    const failing = store.deleteNoteForever('n1');
    await answer(true);
    await failing;
    expect(store.useApp.getState().notes.n1).toBeDefined();
    expect(toasts().map((t) => t.message)).toContain('Can’t reach the server. Check your connection.');
  });

  it('offline, a note list from the service worker’s copy loses no note known here and takes none back a version', async () => {
    seed('a1', { version: 3, title: 'Newer here' });
    seed('b1', { version: 1 });
    await store.loadAll(true);
    seed('made1', { title: 'Made this session' });
    store.useApp.setState({ folders: [folder('fold1', null, 'Made today')] });
    const lastSync = store.useApp.getState().lastSync;
    // The copy kept from when the list was last fetched: a1 two versions back, no made1, no fold1.
    const stale = { ...plainRow('a1', { version: 1, title: 'Old' }) } as Record<string, unknown>;
    delete stale.content;
    server.on('GET', '/api/bootstrap', () =>
      json(200, { me: {}, notes: [stale, { ...plainRow('b1'), content: undefined }], folders: [], encryption: { on: false, pending: null } }, { 'x-kb-offline': '1' }),
    );
    await store.loadAll(true);
    const s = store.useApp.getState();
    expect(s.notes.a1).toMatchObject({ version: 3, title: 'Newer here' });
    expect(s.notes.made1).toBeDefined();
    expect(s.folders.map((f) => f.id)).toEqual(['fold1']);
    expect(s.offlineList).toBe(true);
    // The server wasn't heard from.
    expect(s.lastSync).toBe(lastSync);

    // Back online: the server's list is the list again.
    server.on('GET', '/api/bootstrap', () => json(200, { me: {}, notes: [{ ...plainRow('b1'), content: undefined }], folders: [], encryption: { on: false, pending: null } }));
    await store.loadAll(true);
    expect(Object.keys(store.useApp.getState().notes)).toEqual(['b1']);
    expect(store.useApp.getState().offlineList).toBe(false);
  });

  it('deleting forever offers to remove the files only those notes used, when they had any', async () => {
    seed('plain1', { deleted_at: NOW, info: {} });
    seed('pics1', { deleted_at: NOW, info: { im: 2, th: '/api/files/abcdef12/a.png' } });
    server.on('DELETE', /^\/api\/notes\//, () => json(200, { ok: true }));
    const plain = store.deleteNoteForever('plain1');
    await answer(true);
    await plain;
    expect(toasts().at(-1)).toMatchObject({ message: 'Note deleted forever' });
    expect(toasts().at(-1)!.action).toBeUndefined();

    const pics = store.deleteNoteForever('pics1');
    await answer(true);
    await pics;
    const offer = toasts().at(-1)!;
    expect(offer.message).toBe('Note deleted forever');
    expect(offer.action?.label).toBe('Remove unused files');
    // Chosen: the same check and question as Settings → Data.
    server.on('GET', '/api/export/notes', () => json(200, { notes: [], next: null }));
    server.on('GET', '/api/versions/export', () => json(200, { versions: [], next: null }));
    server.on('POST', '/api/files/cleanup', (req) =>
      json(200, { dryRun: req.body.dryRun, files: [{ id: 'abcdef12', name: 'a.png', size: 2048 }], drawings: [], bytes: 2048 }),
    );
    offer.action!.run();
    const question = await answer(true);
    expect(question.title).toBe('Delete 1 unused file?');
    await vi.waitFor(() => expect(toasts().map((t) => t.message)).toContain('Freed 2.0 KB'));
    expect(server.requests('POST', '/api/files/cleanup').map((r) => r.body.confirm)).toEqual([undefined, { files: ['abcdef12'], drawings: [] }]);
  });

  it('restoring says so, or why it couldn’t', async () => {
    seed('n1', { deleted_at: NOW });
    await store.restoreNote('n1');
    expect(toasts().map((t) => t.message)).toContain('Note restored');
    server.on('POST', '/api/notes/n2/restore', () => json(404, { error: 'not_found', message: 'Note not found.' }));
    await store.restoreNote('n2');
    expect(toasts().map((t) => t.message)).toContain('Note not found.');
  });
});

describe('folders', () => {
  beforeEach(() => {
    server.on('POST', '/api/folders', (req) => json(201, folder(req.body.id ?? 'newf1', req.body.parent_id ?? null, req.body.name)));
    server.on('PATCH', /^\/api\/folders\//, (req) => {
      const id = req.path.split('/').pop()!;
      const f = store.useApp.getState().folders.find((x) => x.id === id)!;
      return json(200, { ...f, ...req.body });
    });
    server.on('DELETE', /^\/api\/folders\//, () => json(200, { ok: true, trashed: 2 }));
  });

  it('a new one is named first; a blank name makes none', async () => {
    const none = store.createFolder();
    await answer('   ');
    expect(await none).toBeNull();
    const made = store.createFolder('parent1');
    const d = await answer('  Receipts ');
    expect(d).toMatchObject({ title: 'New subfolder' });
    expect(await made).toMatchObject({ name: 'Receipts', parent_id: 'parent1' });
    expect(store.useApp.getState().folders.map((f) => f.name)).toEqual(['Receipts']);
  });

  it('renaming to the same name or nothing sends nothing; a new name is saved', async () => {
    store.useApp.setState({ folders: [folder('f1', null, 'Work')] });
    const f1 = store.useApp.getState().folders[0];
    const same = store.renameFolder(f1);
    await answer('Work');
    await same;
    expect(server.requests('PATCH', '/api/folders/f1')).toEqual([]);
    const renamed = store.renameFolder(f1);
    await answer('Projects');
    await renamed;
    expect(store.useApp.getState().folders[0].name).toBe('Projects');
    await store.moveFolder(store.useApp.getState().folders[0], 'p9');
    expect(store.useApp.getState().folders[0].parent_id).toBe('p9');
  });

  it('deleting one counts the notes in it and its subfolders, leaves it if open, and refreshes', async () => {
    store.useApp.setState({ folders: [folder('top'), folder('sub', 'top'), folder('other')] });
    seed('a', { folder_id: 'top' });
    seed('b', { folder_id: 'sub' });
    seed('c', { folder_id: 'sub', deleted_at: NOW });
    seed('d', { folder_id: 'other' });
    store.setFilter({ kind: 'folder', id: 'sub' });
    const deleting = store.deleteFolder(store.useApp.getState().folders[0]);
    const d = await answer(true);
    await deleting;
    expect(d.message).toBe('2 notes move to the trash, along with any subfolders.');
    expect(store.useApp.getState().filter).toEqual({ kind: 'all' });
    expect(server.requests('GET', '/api/bootstrap')).toHaveLength(1);
  });

  it('deleting an empty one says it’s empty, and nothing happens when declined', async () => {
    store.useApp.setState({ folders: [folder('empty1')] });
    const deleting = store.deleteFolder(store.useApp.getState().folders[0]);
    const d = await answer(false);
    await deleting;
    expect(d.message).toBe('The folder is empty. Any subfolders are removed too.');
    expect(server.requests('DELETE', '/api/folders/empty1')).toEqual([]);
  });

  it('a folder’s path stops on a loop rather than going round it forever', () => {
    const loop = [folder('a', 'b'), folder('b', 'a')];
    expect(store.folderPath(loop, 'a').length).toBeLessThanOrEqual(51);
    expect(store.folderPath([folder('x'), folder('y', 'x'), folder('z', 'y')], 'z').map((f) => f.id)).toEqual(['x', 'y', 'z']);
    expect(store.folderPath([], null)).toEqual([]);
  });
});

describe('getting around', () => {
  it('opens a note at a heading, with the address kept encoded', () => {
    store.openNote('n1', { hash: '#h-%C3%A9t%C3%A9' });
    expect(location.pathname).toBe('/note/n1');
    expect(store.useApp.getState()).toMatchObject({ noteId: 'n1', anchor: 'h-été' });
    // Opening the same place again adds no history entry.
    const length = history.length;
    store.openNote('n1', { hash: '#h-été' });
    expect(history.length).toBe(length);
  });

  it('Back leaves the app’s own pages, or goes home when there’s nothing to go back to', () => {
    history.replaceState(null, '', '/note/x1');
    store.goBack();
    expect(location.pathname).toBe('/');
    expect(store.useApp.getState().noteId).toBeNull();
  });

  it('Tasks and Home are pages of their own', () => {
    store.openTasks();
    expect(location.pathname).toBe('/tasks');
    expect(store.useApp.getState()).toMatchObject({ screen: 'tasks', noteId: null });
    store.goHome();
    expect(location.pathname).toBe('/');
    expect(store.useApp.getState()).toMatchObject({ screen: 'home', mobileTab: 'home' });
  });

  it('a view chosen for a new note is used only right away', () => {
    vi.useFakeTimers({ toFake: ['Date'], now: NOW });
    store.preferredMode.set('n1', 'read');
    expect(store.preferredMode.get('n1')).toBe('read');
    vi.setSystemTime(NOW + 5000);
    expect(store.preferredMode.get('n1')).toBeUndefined();
    expect(store.preferredMode.get('never')).toBeUndefined();
  });

  it('knows an offline error from any other', () => {
    expect(store.isOfflineError(new apiMod.NetworkError('x'))).toBe(true);
    expect(store.isOfflineError(new Error('x'))).toBe(false);
  });
});
