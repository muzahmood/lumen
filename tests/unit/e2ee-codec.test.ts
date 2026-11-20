// @vitest-environment jsdom
/**
 * The codec (createCodec in src/lib/e2ee.ts) and the API client around it (src/lib/api.ts): every kind
 * of item encrypted and opened again, each ciphertext bound to its item and field (and to the key it was
 * written with), and every answer checked to be for the item asked for. A stubbed server stands in for
 * the Worker.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encryptText, newMasterKey } from '../../src/lib/crypto';
import type { Codec } from '../../src/lib/api';
import type { Folder, Note, Version } from '../../src/lib/types';

let apiMod: typeof import('../../src/lib/api');
let e2ee: typeof import('../../src/lib/e2ee');
let key: CryptoKey;
let codec: Codec;
let handle: (path: string, init: RequestInit, body: any) => Response | Promise<Response>;
const sent: Array<{ path: string; method: string; body: any }> = [];

const NOW = 1_700_000_000_000;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const notFound = () => json({ error: 'not_found', message: 'Not found.' }, 404);

const TEXT = '# Packing\n\n- [ ] passport\n- [x] tickets\n\nSee [[Packing List|the list]] and [other](/note/note000002).';

/** A note as the server stores and returns it, from what the codec sends. */
function row(body: Record<string, unknown>, extra: Record<string, unknown> = {}): Note & { kgen?: number } {
  return {
    folder_id: null,
    title: '',
    excerpt: '',
    info: {},
    tags: [],
    pinned: false,
    version: 1,
    created_at: NOW,
    updated_at: NOW,
    deleted_at: null,
    ...body,
    ...extra,
  } as Note & { kgen?: number };
}

const sealNote = async (id: string, title: string, content: string, tags: string[] = [], c: Codec = codec) =>
  row(await c.sealNew({ id, title, content, tags }));

beforeEach(async () => {
  localStorage.clear();
  vi.resetModules();
  apiMod = await import('../../src/lib/api');
  e2ee = await import('../../src/lib/e2ee');
  key = await newMasterKey();
  codec = e2ee.createCodec(key);
  apiMod.setCodec(codec);
  sent.length = 0;
  handle = () => notFound();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (path: string, init: RequestInit = {}) => {
      const body = typeof init.body === 'string' ? JSON.parse(init.body) : init.body;
      sent.push({ path, method: init.method ?? 'GET', body });
      return handle(path, init, body);
    }),
  );
});

afterEach(() => {
  apiMod.setCodec(null);
  vi.unstubAllGlobals();
});

describe('notes, encrypted and opened again', () => {
  it('round-trip with title, tags, text and preview, and nothing readable is sent', async () => {
    const body = await codec.sealNew({ id: 'note000001', title: '  Trip\nplan ', content: TEXT, tags: ['#travel', 'Travel', 'family plans'], folder_id: 'fold000001', pinned: true });
    expect(body).toMatchObject({ id: 'note000001', folder_id: 'fold000001', pinned: true, enc: true });
    expect(body.content).toMatch(/^e1:/);
    expect(Object.values(body.sealed as object).every((v) => typeof v === 'string' && v.startsWith('e1:'))).toBe(true);
    expect(JSON.stringify(body)).not.toMatch(/Packing|passport|travel|family plans/);

    const note = await codec.openNote(row(body));
    expect(note).toMatchObject({
      id: 'note000001',
      title: 'Trip plan',
      content: TEXT,
      tags: ['travel', 'family-plans'],
      info: { t: [1, 2] },
      links: { n: ['note000002'], w: ['packing list'] },
      pv: 6,
    });
    expect(note.excerpt).toContain('passport');
    expect(note).not.toHaveProperty('sealed');
    expect(note).not.toHaveProperty('tagsUnreadable');
  });

  it('choose the note’s id on the device when none is given, and bind the text to it', async () => {
    const body = await codec.sealNew({ title: 'Untitled thought', content: '' });
    expect(body.id).toMatch(/^[A-Za-z0-9_-]{6,64}$/);
    const note = await codec.openNote(row(body));
    expect([note.title, note.content]).toEqual(['Untitled thought', '']);
    await expect(codec.openNote(row(body, { id: 'note000009' }))).rejects.toMatchObject({ status: 422, code: 'undecryptable' });
  });

  it('encrypt only the fields an edit changes', async () => {
    expect(await codec.sealPatch('note000001', { pinned: true, baseVersion: 3 })).toEqual({ pinned: true, baseVersion: 3 });
    const title = await codec.sealPatch('note000001', { title: 'Renamed', baseVersion: 3 });
    expect(title).toMatchObject({ enc: true, baseVersion: 3 });
    expect(Object.keys(title.sealed as object)).toEqual(['t']);
    expect(title).not.toHaveProperty('content');
    const text = await codec.sealPatch('note000001', { content: 'new words' });
    expect(Object.keys(text.sealed as object).sort()).toEqual(['p']);
    expect(text.content).toMatch(/^e1:/);
    const tags = await codec.sealPatch('note000001', { tags: ['a', 'A', ''] });
    expect(Object.keys(tags.sealed as object)).toEqual(['g']);

    const opened = await codec.openNote(row({ id: 'note000001', enc: true, content: text.content, sealed: { ...title.sealed as object, ...tags.sealed as object, ...text.sealed as object } }));
    expect(opened).toMatchObject({ title: 'Renamed', content: 'new words', tags: ['a'], excerpt: 'new words' });
  });

  it('predict their ciphertext’s length, and refuse a note too large to store before sending it', async () => {
    for (const n of [0, 1, 2, 3, 40, 1000]) expect((await encryptText(key, 'x'.repeat(n), 'ctx')).length).toBe(e2ee.cipherLength(n));
    // The largest text that fits under the server's 1,800,000-character cap, and one byte more.
    expect(e2ee.cipherLength(1_349_969)).toBeLessThanOrEqual(1_800_000);
    expect(e2ee.cipherLength(1_349_970)).toBeGreaterThan(1_800_000);
    await expect(codec.sealNew({ id: 'note000001', content: 'a'.repeat(1_349_969) })).resolves.toMatchObject({ enc: true });
    await expect(codec.sealNew({ id: 'note000001', content: 'a'.repeat(1_349_970) })).rejects.toMatchObject({ status: 413, code: 'too_large' });
    await expect(codec.sealPatch('note000001', { content: 'é'.repeat(700_000) })).rejects.toMatchObject({ code: 'too_large' });
  });
});

describe('ciphertext bound to its note and field', () => {
  it('a note’s text moved onto another note won’t open', async () => {
    const a = await sealNote('notea00001', 'Diary', 'dear diary');
    const b = await sealNote('noteb00001', 'Shopping', 'milk');
    await expect(codec.openNote({ ...b, content: a.content })).rejects.toMatchObject({ code: 'undecryptable' });
    const meta = await codec.openMeta({ ...b, sealed: a.sealed });
    expect(meta).toMatchObject({ title: 'Can’t decrypt this note', tags: [], excerpt: '', info: {}, links: { n: [], w: [] }, tagsUnreadable: true });
  });

  it('a field moved into another field of the same note won’t open', async () => {
    const a = await sealNote('notea00001', 'Diary', 'dear diary', ['private']);
    const s = a.sealed!;
    const shuffled = await codec.openMeta({ ...a, sealed: { t: s.p, g: s.t, p: s.g } });
    expect(shuffled).toMatchObject({ title: 'Can’t decrypt this note', tags: [], tagsUnreadable: true, excerpt: '' });
    await expect(codec.openNote({ ...a, content: s.t! })).rejects.toMatchObject({ code: 'undecryptable' });
    await expect(codec.openNote({ ...a, sealed: { ...s, t: a.content } })).resolves.toMatchObject({ title: 'Can’t decrypt this note', content: 'dear diary' });
  });

  it('a field already decrypted once still has to decrypt again wherever it’s moved', async () => {
    const a = await sealNote('notea00001', 'Diary', 'dear diary');
    const b = await sealNote('noteb00001', 'Shopping', 'milk');
    expect((await codec.openMeta(a)).title).toBe('Diary');
    expect((await codec.openMeta({ ...b, sealed: { ...b.sealed, t: a.sealed!.t } })).title).toBe('Can’t decrypt this note');
    expect((await codec.openFolder({ id: 'notea00001', enc: true, sealed: a.sealed!.t } as Folder)).name).toBe('Locked folder');
  });

  it('a folder name opens only as that folder’s', async () => {
    const created = await codec.sealFolder('', { name: '  Taxes\n2024 ', parent_id: null, sort: 3 });
    expect(created).toMatchObject({ enc: true, parent_id: null, sort: 3 });
    expect(created).not.toHaveProperty('name');
    expect(JSON.stringify(created)).not.toContain('Taxes');
    const id = created.id as string;
    const folder = (extra: Partial<Folder>) => ({ id, parent_id: null, name: '', sort: 3, created_at: NOW, updated_at: NOW, enc: true, sealed: created.sealed as string, ...extra });
    expect(await codec.openFolder(folder({}))).toMatchObject({ id, name: 'Taxes 2024' });
    expect((await codec.openFolder(folder({}))).sealed).toBeUndefined();
    expect((await codec.openFolder(folder({ id: 'fold000002' }))).name).toBe('Locked folder');
    // A note's title can't stand in for a folder name either.
    const n = await sealNote(id, 'Not a folder', '');
    expect((await codec.openFolder(folder({ sealed: n.sealed!.t }))).name).toBe('Locked folder');
    await expect(codec.sealFolder(id, { name: '  \n ' })).rejects.toMatchObject({ code: 'bad_name' });
    // A move without a new name sends no ciphertext.
    expect(await codec.sealFolder(id, { parent_id: 'fold000003' })).toEqual({ parent_id: 'fold000003' });
  });

  it('a history snapshot opens only as one of the note it’s asked for', async () => {
    const a = await sealNote('notea00001', 'Diary', 'dear diary');
    const b = await sealNote('noteb00001', 'Shopping', 'milk');
    const version = (note: Note, sealedTitle = note.sealed!.t): Version => ({ id: 7, note_id: note.id, title: '', content: note.content, created_at: NOW, enc: true, sealed: { t: sealedTitle } });
    expect(await codec.openVersion(version(a), 'notea00001')).toMatchObject({ id: 7, note_id: 'notea00001', title: 'Diary', content: 'dear diary' });
    // Whatever note the server names, it's opened as the one asked for.
    await expect(codec.openVersion(version(a), 'noteb00001')).rejects.toMatchObject({ code: 'undecryptable' });
    await expect(codec.openVersion({ ...version(a), note_id: 'noteb00001' }, 'noteb00001')).rejects.toMatchObject({ code: 'undecryptable' });
    const mixed = await codec.openVersion(version(a, b.sealed!.t), 'notea00001');
    expect(mixed).toMatchObject({ title: '', titleUnreadable: true, content: 'dear diary' });
  });

  it('a version listing shows a title only for the note asked for, and roughly the text’s size', async () => {
    const a = await sealNote('notea00001', 'Diary', 'x'.repeat(500));
    const info = { id: 7, title: '', size: a.content.length, created_at: NOW, enc: true, sealed: { t: a.sealed!.t } };
    expect(await codec.openVersionInfo('notea00001', info)).toEqual({ id: 7, title: 'Diary', size: 500, created_at: NOW, enc: true });
    expect((await codec.openVersionInfo('noteb00001', info)).title).toBe('');
  });

  it('synced settings open only as settings', async () => {
    const sealed = await codec.sealSettings('{"theme":"dark"}');
    expect(sealed).toMatch(/^e1:/);
    expect(await codec.openSettings(sealed)).toBe('{"theme":"dark"}');
    const a = await sealNote('notea00001', '{"theme":"light"}', '');
    expect(await codec.openSettings(a.sealed!.t!)).toBeNull();
    expect((await codec.openMeta({ ...a, sealed: { ...a.sealed, t: sealed } })).title).toBe('Can’t decrypt this note');
  });
});

describe('ciphertext bound to the key it was written with', () => {
  it('text under a replaced key opens only while that key is kept as an earlier one', async () => {
    const oldKey = await newMasterKey();
    const newKey = await newMasterKey();
    const old = await sealNote('notea00001', 'Before', 'old text', ['t'], e2ee.createCodec(oldKey));

    const onlyNew = e2ee.createCodec(newKey);
    await expect(onlyNew.openNote(old)).rejects.toMatchObject({ code: 'undecryptable' });
    expect((await onlyNew.openMeta(old)).title).toBe('Can’t decrypt this note');

    const both = e2ee.createCodec(newKey, [oldKey]);
    expect(await both.openNote(old)).toMatchObject({ title: 'Before', content: 'old text', tags: ['t'] });
    // What it writes is under the current key alone.
    const fresh = await sealNote('noteb00001', 'After', 'new text', [], both);
    await expect(e2ee.createCodec(oldKey).openNote(fresh)).rejects.toMatchObject({ code: 'undecryptable' });
    expect((await onlyNew.openNote(fresh)).content).toBe('new text');
    expect(await onlyNew.openSettings(await both.sealSettings('{}'))).toBe('{}');
  });

  it('a version, folder or setting under an earlier key opens through the keys kept', async () => {
    const oldKey = await newMasterKey();
    const old = e2ee.createCodec(oldKey);
    const both = e2ee.createCodec(await newMasterKey(), [await newMasterKey(), oldKey]);
    const n = await sealNote('notea00001', 'Before', 'old text', [], old);
    const f = await old.sealFolder('fold000001', { name: 'Old folder' });
    expect((await both.openVersion({ id: 1, note_id: n.id, title: '', content: n.content, created_at: NOW, enc: true, sealed: { t: n.sealed!.t } }, n.id)).content).toBe('old text');
    expect((await both.openFolder({ id: 'fold000001', enc: true, sealed: f.sealed } as Folder)).name).toBe('Old folder');
    expect(await both.openSettings(await old.sealSettings('{"a":1}'))).toBe('{"a":1}');
  });
});

describe('the API client while encryption is on', () => {
  it('creates a note sending only ciphertext and the key generation, and opens the answer', async () => {
    apiMod.setKeyGen(3);
    handle = (_p, _i, body) => json({ ...row(body), kgen: undefined }, 201);
    const meta = await apiMod.api.createNote({ title: 'Secret plan', content: 'step one', tags: ['plans'] });
    expect(sent[0]).toMatchObject({ path: '/api/notes', method: 'POST', body: { enc: true, kgen: 3 } });
    expect(JSON.stringify(sent[0].body)).not.toMatch(/Secret plan|step one|"plans"/);
    expect(meta).toMatchObject({ title: 'Secret plan', tags: ['plans'], excerpt: 'step one' });
  });

  it('refuses an answer for a different note, folder or file than the one written', async () => {
    const other = await sealNote('other00001', 'Other', 'other text');
    handle = () => json(other);
    await expect(apiMod.api.createNote({ id: 'mine000001', title: 'Mine' })).rejects.toMatchObject({ code: 'wrong_item' });
    await expect(apiMod.api.updateNote('mine000001', { title: 'Mine' })).rejects.toMatchObject({ code: 'wrong_item' });
    await expect(apiMod.api.trashNote('mine000001')).rejects.toMatchObject({ code: 'wrong_item' });
    await expect(apiMod.api.restoreNote('mine000001')).rejects.toMatchObject({ code: 'wrong_item' });
    handle = () => json({ id: 'fold000002', parent_id: null, name: '', sort: 0, created_at: NOW, updated_at: NOW, enc: true, sealed: 'e1:AAAA' });
    await expect(apiMod.api.createFolder({ id: 'fold000001', name: 'Mine' })).rejects.toMatchObject({ code: 'wrong_item' });
    await expect(apiMod.api.createFolder({ name: 'New' })).rejects.toMatchObject({ code: 'wrong_item' });
    await expect(apiMod.api.updateFolder('fold000001', { name: 'Mine' })).rejects.toMatchObject({ code: 'wrong_item' });
    handle = (_p, init) => json({ id: 'file000002', note_id: null, name: '', mime: 'application/octet-stream', size: 1, storage: 'kv', created_at: NOW, enc: true, sealed: (init.headers as Record<string, string>)['x-kb-sealed'], url: '' }, 201);
    await expect(apiMod.api.uploadFile(new Blob(['x']), 'a.txt', { id: 'file000001' })).rejects.toMatchObject({ code: 'wrong_item' });
  });

  it('refuses a version the server files under another note', async () => {
    const a = await sealNote('notea00001', 'Diary', 'dear diary');
    handle = () => json({ id: 7, note_id: 'noteb00001', title: '', content: a.content, created_at: NOW, enc: true, sealed: { t: a.sealed!.t } });
    await expect(apiMod.api.version(7, 'notea00001')).rejects.toMatchObject({ status: 404 });
  });

  it('keeps only the notes asked for from a batch for the on-device copy', async () => {
    handle = async () => json({ notes: [await sealNote('notea00001', 'A', ''), await sealNote('extra00001', 'B', ''), null, { id: 5 }] });
    expect((await apiMod.api.rawNotes(['notea00001'])).map((n) => n.id)).toEqual(['notea00001']);
  });

  it('decrypts the saved note in a conflict only when it is the note being saved', async () => {
    const mine = await sealNote('mine000001', 'Mine', 'saved text');
    const other = await sealNote('other00001', 'Other', 'other text');
    handle = () => json({ error: 'conflict', message: 'Changed elsewhere.', note: other }, 409);
    const err1 = await apiMod.api.updateNote('mine000001', { content: 'local', baseVersion: 1 }).catch((e) => e);
    expect(err1).toMatchObject({ code: 'conflict' });
    expect(err1.data.note).toBeUndefined();
    handle = () => json({ error: 'conflict', message: 'Changed elsewhere.', note: mine }, 409);
    const err2 = await apiMod.api.updateNote('mine000001', { content: 'local', baseVersion: 1 }).catch((e) => e);
    expect(err2.data.note).toMatchObject({ id: 'mine000001', title: 'Mine', content: 'saved text' });
  });

  it('refuses a note written with a newer key than this device holds, and says the key changed', async () => {
    const told = vi.fn();
    apiMod.onKeyChanged(told);
    const note = await sealNote('notea00001', 'A', 'text');
    handle = () => json({ ...note, kgen: 1 });
    await expect(apiMod.api.getNote('notea00001')).rejects.toMatchObject({ status: 409, code: 'key_changed' });
    expect(told).toHaveBeenCalledTimes(1);
    handle = () => json({ ...note, kgen: 0 });
    expect((await apiMod.api.getNote('notea00001')).content).toBe('text');
  });

  it('says the key changed when the note list reports a newer key generation, or a write is refused for an old one', async () => {
    const told = vi.fn();
    apiMod.onKeyChanged(told);
    handle = () => json({ me: {}, notes: [], folders: [], encryption: { on: true, pending: { notes: 0, versions: 0, folders: 0 }, gen: 2 }, serverTime: NOW });
    apiMod.setKeyGen(1);
    await apiMod.api.bootstrap();
    expect(told).toHaveBeenCalledTimes(1);
    apiMod.setKeyGen(2);
    await apiMod.api.bootstrap();
    expect(told).toHaveBeenCalledTimes(1);
    handle = () => json({ error: 'key_changed', message: 'Replaced.' }, 409);
    await expect(apiMod.api.updateNote('notea00001', { content: 'x' })).rejects.toMatchObject({ code: 'key_changed' });
    expect(told).toHaveBeenCalledTimes(2);
  });

  it('opens the note list, folders and history with the codec', async () => {
    const a = await sealNote('notea00001', 'Diary', 'dear diary', ['me']);
    const f = await codec.sealFolder('fold000001', { name: 'Journal' });
    handle = (path) => {
      if (path === '/api/bootstrap') {
        const { content: _c, ...meta } = a;
        return json({ me: {}, notes: [meta], folders: [{ id: 'fold000001', parent_id: null, name: '', sort: 0, created_at: NOW, updated_at: NOW, enc: true, sealed: f.sealed, kgen: 0 }], encryption: { on: true, pending: { notes: 0, versions: 0, folders: 0 }, gen: 0 }, serverTime: NOW });
      }
      if (path === '/api/notes/notea00001/versions') return json({ versions: [{ id: 3, title: '', size: a.content.length, created_at: NOW, enc: true, sealed: { t: a.sealed!.t } }] });
      return notFound();
    };
    const boot = await apiMod.api.bootstrap();
    expect(boot.notes[0]).toMatchObject({ title: 'Diary', tags: ['me'], excerpt: 'dear diary' });
    expect(boot.folders[0].name).toBe('Journal');
    expect((await apiMod.api.versions('notea00001')).versions[0]).toMatchObject({ title: 'Diary', size: 10 });
    // Fully encrypted: the device remembers it.
    expect(apiMod.libraryEncrypted()).toBe(true);
  });
});
