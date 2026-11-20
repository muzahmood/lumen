// @vitest-environment jsdom
/**
 * The note list (src/lib/store.ts) with the app's real API client, against a stand-in server: changes
 * to several notes at once (shown at once, saved a few at a time, put back where they fail), the trash,
 * renaming, merging and removing tags with Undo, the cached text of open notes, and the clean-up of a
 * new note left empty.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { decryptText, encryptText, newMasterKey } from '../../src/lib/crypto';

window.matchMedia ??= ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;

const NOW = 1_700_000_000_000;

let store: typeof import('../../src/lib/store');
let saver: typeof import('../../src/lib/saver');
let apiMod: typeof import('../../src/lib/api');
let key: CryptoKey | null = null;
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
  query: URLSearchParams;
  body: Record<string, any> | undefined;
}

const rows = new Map<string, Row>();
let folders: Array<{ id: string; parent_id: string | null; name: string; sort: number; created_at: number; updated_at: number }> = [];
let log: Req[] = [];
let created = 0;
let intercept: ((req: Req) => Promise<Response | undefined>) | null = null;

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const metaOf = ({ content: _c, ...meta }: Row) => meta;
const missing = () => json(404, { error: 'not_found', message: 'Note not found.' });

function serve(req: Req): Response {
  const b = req.body ?? {};
  const one = /^\/api\/notes\/([^/]+)$/.exec(req.path);
  const act = /^\/api\/notes\/([^/]+)\/(trash|restore)$/.exec(req.path);
  if (req.method === 'GET' && req.path === '/api/bootstrap') {
    return json(200, { me: {}, notes: [...rows.values()].map(metaOf), folders, serverTime: Date.now() });
  }
  if (req.method === 'POST' && req.path === '/api/notes') {
    const id = (b.id as string) ?? `srv${++created}`;
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
  if (req.method === 'POST' && req.path === '/api/trash/empty') {
    const gone = [...rows.values()].filter((r) => r.deleted_at);
    gone.forEach((r) => rows.delete(r.id));
    return json(200, { ok: true, deleted: gone.length });
  }
  if (act && req.method === 'POST') {
    const row = rows.get(act[1]);
    if (!row) return missing();
    row.deleted_at = act[2] === 'trash' ? Date.now() : null;
    return json(200, metaOf(row));
  }
  if (one && req.method === 'GET') {
    const row = rows.get(one[1]);
    return row ? json(200, row) : missing();
  }
  if (one && req.method === 'DELETE') {
    const row = rows.get(one[1]);
    const ifVersion = req.query.get('ifVersion');
    const deleted = !!row && (ifVersion === null || Number(ifVersion) === row.version);
    if (deleted) rows.delete(one[1]);
    return json(200, { ok: true, deleted });
  }
  if (one && req.method === 'PATCH') {
    const row = rows.get(one[1]);
    if (!row) return missing();
    if (b.folder_id && !folders.some((f) => f.id === b.folder_id)) {
      return json(409, { error: 'folder_missing', message: 'That folder no longer exists. It may have been deleted on another device.' });
    }
    const textChanged = (typeof b.content === 'string' && b.content !== row.content) || (typeof b.title === 'string' && b.title !== row.title);
    if (typeof b.content === 'string') row.content = b.content;
    if (typeof b.title === 'string') row.title = b.title;
    if (Array.isArray(b.tags)) row.tags = b.tags;
    if ('folder_id' in b) row.folder_id = b.folder_id;
    if ('pinned' in b) row.pinned = !!b.pinned;
    if (b.sealed) row.sealed = { ...row.sealed, ...b.sealed };
    if (textChanged) row.version++;
    row.updated_at = Date.now();
    return json(200, metaOf(row));
  }
  return json(404, { error: 'no_route', message: 'No such route.' });
}

async function fakeFetch(input: string, init: RequestInit = {}) {
  const url = new URL(input, 'http://localhost');
  const req: Req = { method: init.method ?? 'GET', path: url.pathname, query: url.searchParams, body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined };
  log.push(req);
  return (intercept ? await intercept(req) : undefined) ?? serve(req);
}

/** Requests held until the test lets them through. */
let held: Array<() => void> = [];
const hold = () => new Promise<undefined>((resolve) => held.push(() => resolve(undefined)));
const failFor = (id: string, status = 500, error = 'internal', message = 'Something broke.') => {
  intercept = async (req) => (req.path.startsWith(`/api/notes/${id}`) && req.method !== 'GET' ? json(status, { error, message }) : undefined);
};

async function settle(rounds = 30) {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setImmediate(r));
}

/* ------------------------------------------------------- the device --- */

const at = (id: string, f: string) => `lumen/1/note/${id}/${f}`;

/** A note on the server and in this device's note list (as bootstrap would list it). */
async function seed(id: string, init: Partial<Row> = {}) {
  const note: Row = {
    id,
    folder_id: null,
    title: `Note ${id}`,
    excerpt: '',
    info: {},
    tags: [],
    pinned: false,
    version: 1,
    created_at: NOW,
    updated_at: NOW,
    deleted_at: null,
    content: `text of ${id}`,
    ...init,
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
        p: await encryptText(key, JSON.stringify({ v: 6, e: '', i: {}, l: { n: [], w: [] } }), at(id, 'preview')),
      },
    });
  } else {
    rows.set(id, { ...note });
  }
  store.upsertMeta(metaOf(note));
  return note;
}

const listed = (id: string) => store.useApp.getState().notes[id];
const tagsOf = (id: string) => listed(id)?.tags;
const toasts = () => store.useApp.getState().toasts;
const lastToast = () => toasts().at(-1);
const patches = () => log.filter((r) => r.method === 'PATCH');

/** Answers the confirmation dialog that's up. */
function answer(value: boolean) {
  const d = store.useApp.getState().dialog;
  if (!d) throw new Error('No dialog is up');
  store.useApp.setState({ dialog: null });
  d.resolve(value);
}

const serverTags = async (id: string) => {
  const row = rows.get(id)!;
  return key && row.enc ? JSON.parse(await decryptText(key, row.sealed!.g, at(id, 'tags'))) : row.tags;
};

async function encrypted() {
  key = await newMasterKey();
  const e2ee = await import('../../src/lib/e2ee');
  apiMod.setKeyGen(0);
  apiMod.setCodec(e2ee.createCodec(key));
}

beforeEach(async () => {
  localStorage.clear();
  sessionStorage.clear();
  sessionStorage.setItem('kb.tab-id', `storetab${++tabSeq}`);
  vi.stubGlobal('BroadcastChannel', undefined);
  vi.stubGlobal('fetch', fakeFetch);
  rows.clear();
  folders = [];
  log = [];
  held = [];
  intercept = null;
  key = null;
  window.history.replaceState(null, '', '/');
  vi.resetModules();
  apiMod = await import('../../src/lib/api');
  store = await import('../../src/lib/store');
  saver = await import('../../src/lib/saver');
});

afterEach(() => {
  saver.discardAll();
  apiMod.setCodec(null);
  vi.unstubAllGlobals();
});

/* ------------------------------------------------------------ tests --- */

describe('the cached text of notes', () => {
  it('keeps a note’s cached text when its details change at the same version', async () => {
    const n = await seed('a');
    store.noteCache.set('a', { ...metaOf(n), content: 'cached' } as never);
    store.upsertMeta({ ...metaOf(n), pinned: true } as never);
    expect(store.noteCache.get('a')).toMatchObject({ content: 'cached', pinned: true });
  });

  it('drops a note’s cached text once the list has another version of it', async () => {
    const n = await seed('a');
    store.noteCache.set('a', { ...metaOf(n), content: 'cached' } as never);
    store.upsertMeta({ ...metaOf(n), version: 2 } as never);
    expect(store.noteCache.has('a')).toBe(false);
  });

  it('duplicates the newest text, not text cached before another device changed the note', async () => {
    const n = await seed('a', { content: 'old text' });
    store.noteCache.set('a', { ...metaOf(n), content: 'old text' } as never);
    // Another device saves; this device hears of it when it refreshes the list (returning to the tab).
    Object.assign(rows.get('a')!, { content: 'new text', version: 2 });
    await store.loadAll(true);
    expect(listed('a').version).toBe(2);
    await store.duplicateNote('a');
    const copy = [...rows.values()].find((r) => r.id !== 'a')!;
    expect(copy.content).toBe('new text');
  });

  it('keeps unchanged notes, and an unchanged list, as the same objects on a refresh', async () => {
    await seed('a');
    await seed('b');
    store.useApp.setState({ status: 'ready' });
    await store.loadAll(true);
    const before = store.useApp.getState().notes;
    await store.loadAll(true);
    expect(store.useApp.getState().notes).toBe(before);
    rows.get('b')!.pinned = true;
    await store.loadAll(true);
    const after = store.useApp.getState().notes;
    expect(after).not.toBe(before);
    expect(after.a).toBe(before.a);
    expect(after.b.pinned).toBe(true);
  });

  it('keeps showing the list when a quiet refresh fails', async () => {
    await seed('a');
    await store.loadAll(true);
    intercept = async () => Promise.reject(new TypeError('Failed to fetch'));
    await store.loadAll(true);
    expect(store.useApp.getState().status).toBe('ready');
    expect(listed('a')).toBeTruthy();
  });
});

describe('changing several notes at once', () => {
  it('shows the change at once, saves each note, and says which were saved', async () => {
    for (const id of ['a', 'b', 'c']) await seed(id);
    folders = [{ id: 'fold1', parent_id: null, name: 'Work', sort: 0, created_at: NOW, updated_at: NOW }];
    intercept = async (req) => (req.method === 'PATCH' ? hold() : undefined);
    const done = store.updateNotesMeta(['a', 'b', 'c'].map((id) => ({ id, patch: { folder_id: 'fold1' } })));
    expect(['a', 'b', 'c'].map((id) => listed(id).folder_id)).toEqual(['fold1', 'fold1', 'fold1']);
    await settle();
    held.splice(0).forEach((go) => go());
    expect((await done).sort()).toEqual(['a', 'b', 'c']);
    expect(['a', 'b', 'c'].map((id) => rows.get(id)!.folder_id)).toEqual(['fold1', 'fold1', 'fold1']);
    expect(toasts()).toEqual([]);
  });

  it('saves at most four at a time', async () => {
    const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
    for (const id of ids) await seed(id);
    let open = 0;
    let most = 0;
    intercept = async (req) => {
      if (req.method !== 'PATCH') return undefined;
      most = Math.max(most, ++open);
      await hold();
      open--;
      return undefined;
    };
    const done = store.updateNotesMeta(ids.map((id) => ({ id, patch: { pinned: true } })));
    while ((await Promise.race([done.then(() => true), settle(5).then(() => false)])) === false) held.splice(0).forEach((go) => go());
    expect(most).toBe(4);
    expect(patches()).toHaveLength(7);
  });

  it('puts back only the notes that didn’t save, and says how many', async () => {
    for (const id of ['a', 'b', 'c']) await seed(id, { tags: ['old'] });
    failFor('b');
    const saved = await store.updateNotesMeta(['a', 'b', 'c'].map((id) => ({ id, patch: { tags: ['new'] } })));
    expect(saved.sort()).toEqual(['a', 'c']);
    expect([tagsOf('a'), tagsOf('b'), tagsOf('c')]).toEqual([['new'], ['old'], ['new']]);
    expect(lastToast()).toMatchObject({ kind: 'error', message: 'A note couldn’t be changed: Something broke.' });
  });

  it('refreshes the list when the folder was deleted on another device', async () => {
    await seed('a');
    folders = [];
    const saved = await store.updateNotesMeta([{ id: 'a', patch: { folder_id: 'goneFolder' } }]);
    expect(saved).toEqual([]);
    expect(listed('a').folder_id).toBeNull();
    await settle();
    expect(log.some((r) => r.path === '/api/bootstrap')).toBe(true);
  });

  it('puts back only what it changed when a save of the note’s text landed meanwhile', async () => {
    const n = await seed('a', { tags: ['old'] });
    store.noteCache.set('a', { ...metaOf(n), content: 'text of a' } as never);
    // The tag change will fail, after a while.
    intercept = async (req) => {
      if (req.method !== 'PATCH') return undefined;
      await hold();
      return json(500, { error: 'internal', message: 'Something broke.' });
    };
    const done = store.updateNotesMeta([{ id: 'a', patch: { tags: ['new'] } }]);
    await settle();
    // Meanwhile the open note's autosave lands: version 2, new title (saver.flush → upsertMeta, noteCache).
    Object.assign(rows.get('a')!, { title: 'Renamed', content: 'typed', version: 2 });
    store.upsertMeta({ ...listed('a'), version: 2, title: 'Renamed' });
    store.noteCache.set('a', { ...listed('a'), content: 'typed' } as never);
    held.splice(0).forEach((go) => go());
    await done;
    expect(listed('a')).toMatchObject({ tags: ['old'], version: 2, title: 'Renamed' });
    expect(store.noteCache.get('a')).toMatchObject({ content: 'typed', version: 2 });
  });

  it('in an encrypted library, never sends a tag in plaintext', async () => {
    await encrypted();
    await seed('a', { tags: ['secret-project'] });
    await store.updateNotesMeta([{ id: 'a', patch: { tags: ['secret-project', 'clients'] } }]);
    expect(JSON.stringify(patches()[0].body)).not.toMatch(/secret-project|clients/);
    expect(await serverTags('a')).toEqual(['secret-project', 'clients']);
    expect(tagsOf('a')).toEqual(['secret-project', 'clients']);
  });
});

describe('the trash', () => {
  it('moves several notes to the trash, leaves the open one, and offers Undo', async () => {
    for (const id of ['a', 'b']) await seed(id);
    store.openNote('a');
    await store.trashNotes(['a', 'b']);
    expect(listed('a').deleted_at).toBeTruthy();
    expect(listed('b').deleted_at).toBeTruthy();
    expect(store.useApp.getState().noteId).toBeNull();
    const t = lastToast()!;
    expect(t.message).toBe('Moved 2 notes to the trash');
    t.action!.run();
    await settle();
    expect(listed('a').deleted_at).toBeNull();
    expect(listed('b').deleted_at).toBeNull();
    expect(lastToast()!.message).toBe('Restored 2 notes');
  });

  it('when some can’t be trashed, says so, and Undo restores only those that were', async () => {
    for (const id of ['a', 'b', 'c']) await seed(id);
    await store.restoreNotes([]); // nothing to do: no message
    expect(toasts()).toEqual([]);
    failFor('b');
    await store.trashNotes(['a', 'b', 'c']);
    expect(listed('b').deleted_at).toBeNull();
    expect(toasts().map((t) => t.message)).toEqual(['Something broke.', 'Moved 2 notes to the trash']);
    intercept = null;
    log = [];
    lastToast()!.action!.run();
    await settle();
    expect(log.filter((r) => r.path.endsWith('/restore')).map((r) => r.path).sort()).toEqual(['/api/notes/a/restore', '/api/notes/c/restore']);
  });

  it('deletes for good only notes in the trash, after asking once', async () => {
    await seed('a', { deleted_at: NOW });
    await seed('b');
    const done = store.deleteNotesForever(['a', 'b']);
    expect(store.useApp.getState().dialog?.title).toBe('Delete 1 note forever?');
    answer(true);
    expect(await done).toBe(true);
    expect(rows.has('a')).toBe(false);
    expect(rows.has('b')).toBe(true);
    expect(listed('a')).toBeUndefined();
    expect(log.filter((r) => r.method === 'DELETE').map((r) => r.path)).toEqual(['/api/notes/a']);
  });

  it('deletes nothing when the question is declined', async () => {
    await seed('a', { deleted_at: NOW });
    const done = store.deleteNotesForever(['a']);
    answer(false);
    expect(await done).toBe(false);
    expect(rows.has('a')).toBe(true);
    expect(log.filter((r) => r.method === 'DELETE')).toEqual([]);
  });

  it('keeps a note restored while the question was up', async () => {
    await seed('a', { deleted_at: NOW });
    await seed('b', { deleted_at: NOW });
    const done = store.deleteNotesForever(['a', 'b']);
    await store.restoreNotes(['b']);
    answer(true);
    await done;
    expect(rows.has('a')).toBe(false);
    expect(rows.has('b')).toBe(true);
    expect(listed('b').deleted_at).toBeNull();
  });

  it('says how many were deleted and how many couldn’t be', async () => {
    for (const id of ['a', 'b', 'c']) await seed(id, { deleted_at: NOW });
    failFor('b');
    const done = store.deleteNotesForever(['a', 'b', 'c']);
    answer(true);
    await done;
    expect(listed('b')).toBeTruthy();
    expect(listed('a')).toBeUndefined();
    expect(lastToast()).toMatchObject({ kind: 'error', message: 'Deleted 2 notes forever; 1 note couldn’t be: Something broke.' });
  });

  it('drops unsent edits and drafts of notes deleted for good, so they’re never sent or rescued', async () => {
    const n = await seed('a', { deleted_at: NOW });
    saver.track({ ...metaOf(n), content: n.content } as never);
    saver.edit('a', { content: 'typed in the trash' });
    expect(Object.keys(localStorage).some((k) => k.startsWith('kb.draft.a~'))).toBe(true);
    const done = store.deleteNotesForever(['a']);
    answer(true);
    await done;
    expect(saver.pendingText('a')).toBeNull();
    expect(Object.keys(localStorage).some((k) => k.startsWith('kb.draft.a~'))).toBe(false);
    await saver.flushAll();
    expect(patches()).toEqual([]);
    expect(log.filter((r) => r.method === 'POST' && r.path === '/api/notes')).toEqual([]);
  });

  it('doesn’t bring a note deleted for good back as a new note when a save of it was on its way', async () => {
    const n = await seed('a', { deleted_at: NOW });
    saver.track({ ...metaOf(n), content: n.content } as never);
    intercept = async (req) => (req.method === 'PATCH' ? hold() : undefined);
    saver.edit('a', { content: 'typed just before' });
    const saving = saver.flush('a');
    await settle();
    expect(held).toHaveLength(1);
    const done = store.deleteNotesForever(['a']);
    answer(true);
    await done;
    expect(rows.has('a')).toBe(false);
    // The save reaches the server after the delete: the note is gone (404).
    held.shift()!();
    await saving;
    await settle();
    expect(log.filter((r) => r.method === 'POST' && r.path === '/api/notes')).toEqual([]);
    expect(rows.size).toBe(0);
    expect(toasts().map((t) => t.message)).not.toContain('This note was deleted on another device, so your edits here were saved as a new note.');
  });

  it('empties the trash, forgetting what was unsent for those notes', async () => {
    const n = await seed('a', { deleted_at: NOW });
    await seed('b');
    saver.track({ ...metaOf(n), content: n.content } as never);
    saver.edit('a', { content: 'typed in the trash' });
    const done = store.emptyTrash();
    answer(true);
    await done;
    expect(Object.keys(store.useApp.getState().notes)).toEqual(['b']);
    expect(saver.pendingText('a')).toBeNull();
  });
});

describe('a new note left empty', () => {
  it('is deleted only while still at the version it was left at, and leaves the list', async () => {
    await seed('a', { title: '', content: '' });
    await store.discardEmptyNote('a', 1);
    expect(log.find((r) => r.method === 'DELETE')?.query.get('ifVersion')).toBe('1');
    expect(rows.has('a')).toBe(false);
    expect(listed('a')).toBeUndefined();
  });

  it('stays when another device saved text into it meanwhile', async () => {
    await seed('a', { title: '', content: '' });
    Object.assign(rows.get('a')!, { content: 'typed on the phone', version: 2 });
    await store.discardEmptyNote('a', 1);
    expect(rows.get('a')!.content).toBe('typed on the phone');
    expect(listed('a')).toBeTruthy();
  });

  it('stays when there’s unsaved text for it on this device', async () => {
    const n = await seed('a', { title: '', content: '' });
    saver.track({ ...metaOf(n), content: '' } as never);
    saver.edit('a', { content: 'just typed' });
    await store.discardEmptyNote('a', 1);
    expect(log.filter((r) => r.method === 'DELETE')).toEqual([]);
    expect(listed('a')).toBeTruthy();
  });

  it('stays when it can’t be deleted (offline), with nothing said', async () => {
    await seed('a', { title: '', content: '' });
    intercept = async () => Promise.reject(new TypeError('Failed to fetch'));
    await store.discardEmptyNote('a', 1);
    expect(listed('a')).toBeTruthy();
    expect(toasts()).toEqual([]);
  });

  it('a note that had text and was emptied keeps its history: it isn’t deleted at its first version', async () => {
    await seed('a', { title: '', content: '', version: 3 });
    // Whatever version the clean-up is asked for that isn't the note's own, the server keeps it.
    await store.discardEmptyNote('a', 1);
    expect(rows.has('a')).toBe(true);
  });
});

describe('renaming a tag', () => {
  it('renames it on every note that has it, in any case, trashed ones too, keeping each note’s other tags', async () => {
    await seed('a', { tags: ['work', 'urgent'] });
    await seed('b', { tags: ['Work'] });
    await seed('c', { tags: ['work'], deleted_at: NOW });
    await seed('d', { tags: ['home'] });
    await store.renameTag('work', '#Job Search');
    expect([tagsOf('a'), tagsOf('b'), tagsOf('c'), tagsOf('d')]).toEqual([['Job-Search', 'urgent'], ['Job-Search'], ['Job-Search'], ['home']]);
    expect(rows.get('d')!.tags).toEqual(['home']);
    expect(patches().map((r) => r.path).sort()).toEqual(['/api/notes/a', '/api/notes/b', '/api/notes/c']);
    expect(lastToast()!.message).toBe('Renamed #work to #Job-Search in 3 notes');
  });

  it('changes only the case when that’s all that differs, without asking to merge', async () => {
    await seed('a', { tags: ['work'] });
    await store.renameTag('work', 'Work');
    expect(store.useApp.getState().dialog).toBeNull();
    expect(tagsOf('a')).toEqual(['Work']);
  });

  it('does nothing for the same name or an empty one', async () => {
    await seed('a', { tags: ['work'] });
    await store.renameTag('work', 'work');
    await store.renameTag('work', '#');
    await store.renameTag('work', '   ');
    expect(patches()).toEqual([]);
  });

  it('cleans the new name like any tag, even when typed with a space first', async () => {
    await seed('a', { tags: ['work'] });
    await store.renameTag('work', ' # ');
    expect(patches()).toEqual([]);
    await store.renameTag('work', ' #job');
    expect(patches()[0]?.body).toMatchObject({ tags: ['job'] });
    expect(lastToast()!.message).toBe('Renamed #work to #job in 1 note');
  });

  it('asks before merging into a tag that’s already used, then leaves one of it on each note', async () => {
    await seed('a', { tags: ['todo', 'tasks'] });
    await seed('b', { tags: ['todo'] });
    await seed('c', { tags: ['Tasks'] });
    const done = store.renameTag('todo', 'tasks');
    expect(store.useApp.getState().dialog).toMatchObject({ title: 'Merge #todo into #tasks?', confirmLabel: 'Merge tags' });
    answer(true);
    await done;
    expect([tagsOf('a'), tagsOf('b'), tagsOf('c')]).toEqual([['tasks'], ['tasks'], ['Tasks']]);
    expect(lastToast()!.message).toBe('Merged #todo into #tasks in 2 notes');
  });

  it('merges nothing when the question is declined', async () => {
    await seed('a', { tags: ['todo'] });
    await seed('b', { tags: ['tasks'] });
    const done = store.renameTag('todo', 'tasks');
    answer(false);
    await done;
    expect(patches()).toEqual([]);
    expect(tagsOf('a')).toEqual(['todo']);
  });

  it('Undo puts every note’s tags back as they were, a merge included', async () => {
    await seed('a', { tags: ['todo', 'tasks'] });
    await seed('b', { tags: ['todo', 'x'] });
    const done = store.renameTag('todo', 'tasks');
    answer(true);
    await done;
    lastToast()!.action!.run();
    await settle();
    expect([tagsOf('a'), tagsOf('b')]).toEqual([['todo', 'tasks'], ['todo', 'x']]);
    expect([rows.get('a')!.tags, rows.get('b')!.tags]).toEqual([['todo', 'tasks'], ['todo', 'x']]);
  });

  it('Undo leaves alone the notes the rename didn’t reach', async () => {
    await seed('a', { tags: ['work'] });
    await seed('b', { tags: ['work'] });
    failFor('b');
    await store.renameTag('work', 'job');
    const undo = toasts().find((t) => t.action?.label === 'Undo')!;
    expect(undo.message).toBe('Renamed #work to #job in 1 note');
    intercept = null;
    log = [];
    undo.action!.run();
    await settle();
    expect(patches().map((r) => r.path)).toEqual(['/api/notes/a']);
    expect([tagsOf('a'), tagsOf('b')]).toEqual([['work'], ['work']]);
  });

  it('skips notes whose tags couldn’t be decrypted, rather than saving over them', async () => {
    await seed('a', { tags: ['work'] });
    await seed('b', { tags: [] });
    store.upsertMeta({ ...listed('b'), tags: ['work'], tagsUnreadable: true } as never);
    await store.renameTag('work', 'job');
    expect(patches().map((r) => r.path)).toEqual(['/api/notes/a']);
  });

  it('keeps the list on the tag being renamed', async () => {
    await seed('a', { tags: ['work'] });
    store.setFilter({ kind: 'tag', tag: 'Work' });
    await store.renameTag('work', 'job');
    expect(store.useApp.getState().filter).toEqual({ kind: 'tag', tag: 'job' });
  });

  it('in an encrypted library, renames it without the server seeing either name', async () => {
    await encrypted();
    await seed('a', { tags: ['old-name', 'keep'] });
    await store.renameTag('old-name', 'new-name');
    expect(JSON.stringify(patches().map((r) => r.body))).not.toMatch(/old-name|new-name|keep/);
    expect(await serverTags('a')).toEqual(['new-name', 'keep']);
    expect(tagsOf('a')).toEqual(['new-name', 'keep']);
  });
});

describe('removing a tag', () => {
  it('takes it off every note after asking, with Undo, and the notes stay', async () => {
    await seed('a', { tags: ['draft', 'work'] });
    await seed('b', { tags: ['Draft'] });
    store.setFilter({ kind: 'tag', tag: 'draft' });
    const done = store.removeTag('draft');
    expect(store.useApp.getState().dialog).toMatchObject({ title: 'Remove #draft?', danger: true });
    answer(true);
    await done;
    expect([tagsOf('a'), tagsOf('b')]).toEqual([['work'], []]);
    expect(rows.size).toBe(2);
    expect(store.useApp.getState().filter).toEqual({ kind: 'all' });
    const t = lastToast()!;
    expect(t.message).toBe('Removed #draft from 2 notes');
    t.action!.run();
    await settle();
    expect([tagsOf('a'), tagsOf('b')]).toEqual([['draft', 'work'], ['Draft']]);
  });

  it('removes nothing when the question is declined', async () => {
    await seed('a', { tags: ['draft'] });
    const done = store.removeTag('draft');
    answer(false);
    await done;
    expect(tagsOf('a')).toEqual(['draft']);
    expect(patches()).toEqual([]);
  });
});

describe('new notes', () => {
  it('go in the folder or tag being looked at, open ready to type, with their text cached', async () => {
    folders = [{ id: 'fold1', parent_id: null, name: 'Work', sort: 0, created_at: NOW, updated_at: NOW }];
    store.setFilter({ kind: 'folder', id: 'fold1' });
    const meta = await store.createNote({ content: 'hello' });
    expect(rows.get(meta.id)).toMatchObject({ folder_id: 'fold1', content: 'hello' });
    expect(store.useApp.getState().noteId).toBe(meta.id);
    expect(store.preferredMode.get(meta.id)).toBe('edit');
    expect(store.noteCache.get(meta.id)).toMatchObject({ content: 'hello', version: 1 });
    store.setFilter({ kind: 'tag', tag: 'ideas' });
    const tagged = await store.createNote();
    expect(rows.get(tagged.id)!.tags).toEqual(['ideas']);
  });

  it('a quick capture makes its first line the title, and keeps a long first line as text', async () => {
    expect(await store.captureNote('## Call Sam\nabout the move')).toBe(true);
    expect(await store.captureNote('   ')).toBe(false);
    const long = 'x'.repeat(100);
    await store.captureNote(long);
    const made = [...rows.values()];
    expect(made[0]).toMatchObject({ title: 'Call Sam', content: 'about the move' });
    expect(made[1]).toMatchObject({ title: `${'x'.repeat(60)}…`, content: long });
    expect(store.useApp.getState().noteId).toBeNull();
  });
});
