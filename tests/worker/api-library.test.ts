/**
 * Library-wide reads: the bootstrap every load starts with, the counts in Settings, the export a backup
 * is made from, the notes each device fetches for its own copy, and the backup reminder.
 */
import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { cipher, del, get, newFolder, newNote, patch, post, resetLibrary, sealedFields, testId, turnOnEncryption } from './helpers';
import { bytes, encFolder, encNote, put, replaceKey, saveDrawing, uploadPlain, uploadSealed } from './api-helpers';

beforeEach(resetLibrary);

const META_KEYS = ['created_at', 'deleted_at', 'enc', 'excerpt', 'folder_id', 'id', 'info', 'pinned', 'sealed', 'tags', 'title', 'updated_at', 'version'];

describe('the bootstrap', () => {
  it('says who is signed in and how files are stored, as /me does', async () => {
    const boot = (await get('/bootstrap')).body;
    expect(boot.me).toEqual({ email: null, verified: false, via: 'local', accessConfigured: false, storage: 'kv', maxUploadBytes: 25 * 1024 * 1024 });
    expect((await get('/me')).body).toEqual(boot.me);
  });

  it('gives the server’s clock', async () => {
    const before = Date.now();
    const { serverTime } = (await get('/bootstrap')).body;
    expect(serverTime).toBeGreaterThanOrEqual(before);
    expect(serverTime).toBeLessThanOrEqual(Date.now());
  });

  it('lists each folder with its encryption state and key generation', async () => {
    const parent = await newFolder('Plans', { sort: 3 });
    const child = await newFolder('Sub', { parent_id: parent.id });
    const folders = (await get('/bootstrap')).body.folders;
    expect(folders).toHaveLength(2);
    expect(folders.find((f: { id: string }) => f.id === parent.id)).toEqual({
      id: parent.id,
      parent_id: null,
      name: 'Plans',
      sort: 3,
      created_at: expect.any(Number),
      updated_at: expect.any(Number),
      enc: false,
      sealed: '',
      kgen: 0,
    });
    expect(folders.find((f: { id: string }) => f.id === child.id)).toMatchObject({ parent_id: parent.id, enc: false });
  });

  it('lists every note’s details and preview but not its full text', async () => {
    const folder = await newFolder();
    const note = await newNote({ title: 'Shopping', content: `eggs and flour ${'filler '.repeat(200)}tailword`, folder_id: folder.id, tags: ['home'], pinned: true });
    const notes = (await get('/bootstrap')).body.notes;
    const listed = notes.find((n: { id: string }) => n.id === note.id);
    expect(Object.keys(listed).sort()).toEqual(META_KEYS);
    expect(listed).toMatchObject({ title: 'Shopping', folder_id: folder.id, tags: ['home'], pinned: true, enc: false, sealed: {}, version: 1, deleted_at: null });
    expect(listed.excerpt).toMatch(/^eggs and flour/);
    expect(JSON.stringify(listed)).not.toContain('tailword');
  });

  it('reports encryption as on with nothing left to do in a library encrypted from the start', async () => {
    await turnOnEncryption();
    await encNote();
    await encFolder();
    const { encryption } = (await get('/bootstrap')).body;
    expect(encryption).toEqual({
      on: true,
      pending: { notes: 0, versions: 0, folders: 0 },
      attachments: { files: 0, drawings: 0 },
      gen: 0,
      rekey: { notes: 0, versions: 0, folders: 0, files: 0, drawings: 0 },
    });
  });

  it('counts what is still unencrypted, including notes in the trash and their history', async () => {
    const kept = await newNote({ content: 'one' });
    const trashed = await newNote({ content: 'two' });
    await patch(`/notes/${trashed.id}`, { content: 'two, edited' });
    await post(`/notes/${trashed.id}/trash`);
    await newFolder('Plain');
    await uploadPlain(bytes('hello'), 'a.txt');
    await saveDrawing(testId('d'), 'rev0001', { text: 'words' });
    await turnOnEncryption();
    const { encryption } = (await get('/bootstrap')).body;
    expect(encryption.pending).toEqual({ notes: 2, versions: 1, folders: 1 });
    expect(encryption.attachments).toEqual({ files: 1, drawings: 1 });
    expect(kept.id).toBeTruthy();
  });

  it('counts what is still under an earlier key after the key is replaced, trash and every kind included', async () => {
    await turnOnEncryption();
    const a = await encNote({ content: cipher(80) });
    await patch(`/notes/${a.id}`, { enc: true, content: cipher(), snapshot: true });
    const b = await encNote();
    await post(`/notes/${b.id}/trash`);
    await encFolder();
    expect((await uploadSealed(testId('f'))).status).toBe(201);
    expect((await saveDrawing(testId('d'), 'rev0001', { enc: true, sealed: cipher(32), kgen: 0 })).status).toBe(200);
    await replaceKey();
    const { encryption } = (await get('/bootstrap')).body;
    expect(encryption.gen).toBe(1);
    expect(encryption.rekey).toEqual({ notes: 2, versions: 1, folders: 1, files: 1, drawings: 1 });
    expect(encryption.pending).toEqual({ notes: 0, versions: 0, folders: 0 });
  });

  it('shows an encrypted library with nothing readable in the note list or folder names', async () => {
    await turnOnEncryption();
    const folder = await encFolder();
    const note = await encNote({ folder_id: folder.id, pinned: true });
    const boot = (await get('/bootstrap')).body;
    const listed = boot.notes.find((n: { id: string }) => n.id === note.id);
    expect(listed).toMatchObject({ title: '', excerpt: '', tags: [], info: {}, enc: true, pinned: true, folder_id: folder.id });
    expect(Object.keys(listed.sealed).sort()).toEqual(['g', 'p', 't']);
    expect(boot.folders.find((f: { id: string }) => f.id === folder.id)).toMatchObject({ name: '', enc: true, sealed: folder.sealed, kgen: 0 });
  });

  it('treats a last-backup time it can’t read as no backup at all', async () => {
    await env.DB.prepare("INSERT INTO kb_meta (key, value) VALUES ('last_backup', 'garbage')").run();
    expect((await get('/bootstrap')).body.lastBackup).toBeNull();
  });

  it('treats stored settings it can’t read as none, rather than failing to load', async () => {
    for (const value of ['not json', '{"at":"soon","data":"{}"}', '{"at":5}', '[]']) {
      await env.DB.prepare("INSERT INTO kb_meta (key, value) VALUES ('settings', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
        .bind(value)
        .run();
      const res = await get('/bootstrap');
      expect(res.status, value).toBe(200);
      expect(res.body.settings, value).toBeNull();
    }
  });
});

describe('counts for Settings', () => {
  it('counts active and trashed notes, their stored text, files and drawings', async () => {
    await newNote({ content: 'abc' });
    const gone = await newNote({ content: 'defgh' });
    await post(`/notes/${gone.id}/trash`);
    expect((await uploadPlain(bytes('twelve bytes'), 'a.txt')).status).toBe(201);
    expect((await saveDrawing(testId('d'), 'rev0001', { size: 30 })).status).toBe(200);
    const res = await get('/stats');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      notes: { active: 1, trashed: 1, chars: 8 },
      files: { count: 1, bytes: 12 },
      drawings: { count: 1, bytes: 30 },
      storage: 'kv',
    });
  });
});

describe('export, a page at a time', () => {
  it('includes notes in the trash, with their text and every detail', async () => {
    const folder = await newFolder();
    const note = await newNote({ title: 'Kept', content: 'the body', folder_id: folder.id, tags: ['t'] });
    await post(`/notes/${note.id}/trash`);
    const [exported] = (await get('/export/notes')).body.notes;
    expect(exported).toMatchObject({ id: note.id, title: 'Kept', content: 'the body', tags: ['t'], folder_id: folder.id, deleted_at: expect.any(Number) });
  });

  it('sends encrypted notes exactly as stored, ciphertext only', async () => {
    await turnOnEncryption();
    const content = cipher(90);
    const sealed = sealedFields();
    const note = await encNote({ content, sealed });
    const [exported] = (await get('/export/notes')).body.notes;
    expect(exported).toMatchObject({ id: note.id, enc: true, content, sealed, title: '', tags: [], excerpt: '', info: {} });
  });

  it('walks every note once, in the order they were made, and says when it is done', async () => {
    const made: string[] = [];
    for (let i = 0; i < 5; i++) made.push((await newNote({ title: `N${i}` })).id);
    const seen: string[] = [];
    let after = 0;
    for (let page = 0; page < 10; page++) {
      const res = (await get(`/export/notes?after=${after}&limit=2`)).body;
      seen.push(...res.notes.map((n: { id: string }) => n.id));
      if (res.next === null) break;
      after = res.next;
    }
    expect(seen).toEqual(made);
    expect((await get(`/export/notes?after=${after + 1000}`)).body).toEqual({ notes: [], next: null });
  });

  it('keeps pages between 1 and 200 notes', async () => {
    const now = Date.now();
    const statements = Array.from({ length: 205 }, (_, i) =>
      env.DB.prepare('INSERT INTO notes (id, title, content, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').bind(`bulk${String(i).padStart(4, '0')}`, `B${i}`, 'x', now, now),
    );
    await env.DB.batch(statements);
    const big = (await get('/export/notes?limit=1000')).body;
    expect(big.notes).toHaveLength(200);
    expect(big.next).toEqual(expect.any(Number));
    expect((await get('/export/notes?limit=-3')).body.notes).toHaveLength(1);
    expect((await get('/export/notes?limit=abc')).body.notes).toHaveLength(100);
    expect((await get('/export/notes?after=abc&limit=1')).body.notes[0].id).toBe('bulk0000');
  });
});

describe('the notes a device fetches for its own copy', () => {
  it('sends notes in the trash with their trash date, and leaves out notes deleted for good', async () => {
    const trashed = await newNote({ content: 'in the bin' });
    await post(`/notes/${trashed.id}/trash`);
    const gone = await newNote();
    await del(`/notes/${gone.id}`);
    const { notes } = (await post('/notes/batch', { ids: [trashed.id, gone.id] })).body;
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ id: trashed.id, content: 'in the bin', deleted_at: expect.any(Number) });
  });

  it('sends encrypted notes as stored, saying which key generation wrote each', async () => {
    const plain = await newNote({ content: 'before' });
    await turnOnEncryption();
    const content = cipher(70);
    const enc = await encNote({ content });
    await replaceKey();
    const fresh = await encNote({ kgen: 1 });
    const { notes } = (await post('/notes/batch', { ids: [plain.id, enc.id, fresh.id] })).body;
    const byId = new Map(notes.map((n: { id: string }) => [n.id, n]));
    expect(byId.get(enc.id)).toMatchObject({ enc: true, content, kgen: 0, title: '' });
    expect(byId.get(fresh.id)).toMatchObject({ enc: true, kgen: 1 });
    expect(byId.get(plain.id)).toMatchObject({ enc: false, content: 'before' });
    expect(byId.get(plain.id)).not.toHaveProperty('kgen');
  });

  it('takes up to 90 distinct ids, ignoring malformed ones and repeats', async () => {
    const note = await newNote();
    const ninety = Array.from({ length: 89 }, (_, i) => `miss${String(i).padStart(6, '0')}`).concat(note.id);
    const ok = await post('/notes/batch', { ids: [...ninety, ...ninety, 'bad id', 42, null] });
    expect(ok.status).toBe(200);
    expect(ok.body.notes.map((n: { id: string }) => n.id)).toEqual([note.id]);
  });

  it('refuses a request without a list of ids', async () => {
    for (const body of [{}, { ids: 'abcdefgh' }, { ids: { 0: 'abcdefgh' } }, { ids: ['bad id', 7] }]) {
      const res = await post('/notes/batch', body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(res.body.error).toBe('bad_request');
    }
  });
});

describe('synced settings', () => {
  it('let exactly one of several devices saving at once through, and tell the others what won', async () => {
    const results = await Promise.all(['a', 'b', 'c'].map((accent) => put('/settings', { enc: false, data: JSON.stringify({ accent }), base: 0 })));
    const won = results.filter((r) => r.body.ok === true);
    expect(won).toHaveLength(1);
    const stored = (await get('/bootstrap')).body.settings;
    expect(stored.at).toBe(won[0].body.at);
    for (const lost of results.filter((r) => r.body.ok === false)) expect(lost.body.settings).toEqual(stored);
  });

  it('refuse a save that names no version once something is stored', async () => {
    await put('/settings', { enc: false, data: '{"theme":"dark"}', base: 0 });
    for (const base of [undefined, null, '1e20', 0]) {
      const res = await put('/settings', { enc: false, data: '{"theme":"light"}', base });
      expect(res.body.ok, String(base)).toBe(false);
    }
    expect((await get('/bootstrap')).body.settings.data).toBe('{"theme":"dark"}');
  });

  it('give every save a later time than the one before, even within the same millisecond', async () => {
    let base = 0;
    for (let i = 0; i < 5; i++) {
      const res = await put('/settings', { enc: false, data: JSON.stringify({ i }), base });
      expect(res.body.ok).toBe(true);
      expect(res.body.at).toBeGreaterThan(base);
      base = res.body.at;
    }
  });

  it('take settings right up to the size limit, plain or encrypted', async () => {
    const fits = JSON.stringify({ x: 'a'.repeat(16_000 - 8) });
    expect(fits.length).toBe(16_000);
    const plain = await put('/settings', { enc: false, data: fits, base: 0 });
    expect(plain.body.ok).toBe(true);
    expect((await put('/settings', { enc: false, data: JSON.stringify({ x: 'a'.repeat(16_000 - 7) }), base: plain.body.at })).status).toBe(400);
    await turnOnEncryption();
    expect((await put('/settings', { enc: true, data: `e1:${'A'.repeat(15_997)}`, kgen: 0, base: plain.body.at })).body.ok).toBe(true);
  });

  it('measure the size limit in bytes, so text in other alphabets can’t store up to three times as much', async () => {
    const multibyte = JSON.stringify({ x: 'é'.repeat(8_000) });
    expect(new TextEncoder().encode(multibyte).length).toBeGreaterThan(16_000);
    const res = await put('/settings', { enc: false, data: multibyte, base: 0 });
    expect([res.status, res.body.error]).toEqual([400, 'bad_settings']);
  });

  it('move from plaintext to encrypted on the first encrypted save, recording the key generation', async () => {
    const plain = await put('/settings', { enc: false, data: '{"theme":"dark"}', base: 0 });
    await turnOnEncryption();
    await replaceKey();
    const data = cipher(40);
    const res = await put('/settings', { enc: true, data, kgen: 1, base: plain.body.at });
    expect(res.body.ok).toBe(true);
    expect((await get('/bootstrap')).body.settings).toEqual({ at: res.body.at, enc: true, data, kgen: 1 });
  });
});

describe('the backup reminder', () => {
  it('keeps the latest backup time, whether or not the library is encrypted', async () => {
    const first = (await post('/backups/made')).body.at;
    await turnOnEncryption();
    await new Promise((r) => setTimeout(r, 5));
    const second = await post('/backups/made');
    expect(second.body).toEqual({ ok: true, at: expect.any(Number) });
    expect(second.body.at).toBeGreaterThan(first);
    expect((await get('/bootstrap')).body.lastBackup).toBe(second.body.at);
  });
});
