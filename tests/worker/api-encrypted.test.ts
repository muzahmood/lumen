/**
 * An encrypted library, server side: nothing readable is stored by any write once encryption is on,
 * every write of ciphertext needs the current key generation, and the routes the app uses to encrypt
 * a library (seal) and to encrypt it again after the key is replaced (rekey) only ever change what
 * they should.
 */
import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  call,
  cipher,
  get,
  keyringData,
  newFolder,
  newNote,
  patch,
  post,
  resetLibrary,
  sealedFields,
  testId,
  turnOnEncryption,
  type Reply,
} from './helpers';
import { bytes, count, encFolder, encNote, put, replaceKey, row, saveDrawing, uploadPlain, uploadSealed, whereStored } from './api-helpers';

beforeEach(resetLibrary);

/** Everything D1 holds for the library, to compare before and after a refused request. */
async function dump() {
  const parts: string[] = [];
  for (const table of ['notes', 'note_versions', 'folders', 'files', 'drawings']) {
    parts.push(JSON.stringify((await env.DB.prepare(`SELECT * FROM ${table} ORDER BY 1`).all()).results));
  }
  parts.push(JSON.stringify(await row("SELECT value FROM kb_meta WHERE key = 'settings'")));
  return parts.join('\n');
}

const versionOf = async (id: string) => (await row<{ version: number }>('SELECT version FROM notes WHERE id = ?', id))!.version;

describe('nothing readable is stored once encryption is on', () => {
  const WORD = 'qzxcanary';

  it('ignores readable text sent alongside ciphertext, and stores none from refused writes', async () => {
    await turnOnEncryption();
    const readable = { title: `Title ${WORD}`, tags: [WORD], excerpt: WORD, info: { w: WORD }, name: WORD, text: WORD };
    const note = await encNote({ ...readable });
    const accepted = [
      await post('/notes', { id: testId(), enc: true, restore: true, content: cipher(), sealed: sealedFields(), created_at: 1, updated_at: 2, ...readable }),
      await post('/notes', { id: note.id, enc: true, restore: true, content: cipher(), sealed: sealedFields(), created_at: 1, updated_at: 2, ...readable }),
      await patch(`/notes/${note.id}`, { enc: true, content: cipher(), sealed: { t: cipher() }, snapshot: true, ...readable }),
      await post('/folders', { id: testId('f'), enc: true, sealed: cipher(), ...readable }),
      await saveDrawing(testId('d'), 'rev0001', { enc: true, sealed: cipher(32), kgen: 0, ...readable }),
      await uploadSealed(testId('f'), 0, { 'x-file-name': encodeURIComponent(`${WORD}.pdf`), 'content-type': `text/${WORD}` }),
      await post('/notes/previews', { notes: [{ id: note.id, version: await versionOf(note.id), p: cipher(), title: WORD }] }),
      await post('/notes/seal', { notes: [{ id: note.id, version: await versionOf(note.id), content: cipher(), sealed: sealedFields(), title: WORD }] }),
    ];
    for (const r of accepted) expect(r.status, JSON.stringify(r.body)).toBeLessThan(300);
    const folder = (accepted[3].body as { id: string }).id;
    expect((await patch(`/folders/${folder}`, { sealed: cipher(), name: WORD })).status).toBe(200);

    const refused = [
      await post('/notes', { title: WORD, content: WORD, tags: [WORD] }),
      await post('/notes', { id: testId(), enc: false, restore: true, title: WORD, content: WORD }),
      await post('/notes', { id: testId(), enc: 'true', title: WORD, content: WORD }),
      await patch(`/notes/${note.id}`, { title: WORD, content: WORD }),
      await patch(`/notes/${note.id}`, { enc: false, tags: [WORD] }),
      await post('/folders', { name: WORD }),
      await patch(`/folders/${folder}`, { name: WORD }),
      await put('/settings', { enc: false, data: JSON.stringify({ theme: WORD }), base: 0 }),
      await uploadPlain(bytes(WORD), `${WORD}.txt`),
      // A readable drawing is refused at its first part, before anything reaches storage.
      await call('PUT', `/drawings/${testId('d')}/blob/scene?rev=rev0002`, bytes(`{"text":"${WORD}"}`), { headers: { 'content-type': 'application/json' } }),
    ];
    for (const r of refused) expect([r.status, r.body.error]).toEqual([409, 'encryption_required']);

    expect(await whereStored(WORD)).toEqual([]);
  });

  it('leaves no trace of a converted library’s text anywhere in D1 once the pass is done', async () => {
    const WORD2 = 'zqvplainword';
    const folder = await newFolder(`Folder ${WORD2}`);
    const a = await newNote({ title: `Title ${WORD2}`, content: `Body ${WORD2}`, tags: [WORD2], folder_id: folder.id });
    await patch(`/notes/${a.id}`, { content: `Edited ${WORD2}` });
    const b = await newNote({ title: WORD2, content: WORD2 });
    await post(`/notes/${b.id}/trash`);
    const file = (await uploadPlain(bytes('file bytes'), `${WORD2}.txt`)).body as { id: string };
    const drawing = testId('d');
    await saveDrawing(drawing, 'rev0001', { text: `Drawing ${WORD2}` });
    const settings = await put('/settings', { enc: false, data: JSON.stringify({ workspaceName: WORD2 }), base: 0 });
    expect(await whereStored(WORD2)).not.toEqual([]);

    await turnOnEncryption();
    await post('/folders/seal', { folders: [{ id: folder.id, sealed: cipher(), name: WORD2 }] });
    const notes = [a, b].map(async (n) => ({ id: n.id, version: await versionOf(n.id), content: cipher(), sealed: sealedFields(), title: WORD2 }));
    expect((await post('/notes/seal', { notes: await Promise.all(notes) })).body.sealed).toBe(2);
    const plain = (await get('/versions/plain')).body.versions as Array<{ id: number }>;
    expect(plain).toHaveLength(1);
    await post('/versions/seal', { versions: plain.map((v) => ({ id: v.id, content: cipher(), sealed: { t: cipher() }, title: WORD2 })) });
    const sealedFile = await call('PUT', `/files/${file.id}/seal`, bytes('c'.repeat(40)), { headers: { 'x-kb-sealed': cipher(48), 'x-kb-kgen': '0' } });
    expect(sealedFile.body.sealed).toBe(true);
    expect((await saveDrawing(drawing, 'rev0002', { enc: true, sealed: cipher(32), kgen: 0 })).status).toBe(200);
    expect((await put('/settings', { enc: true, data: cipher(40), kgen: 0, base: settings.body.at })).body.ok).toBe(true);
    expect((await post('/encryption/finish')).status).toBe(200);

    expect(await whereStored(WORD2)).toEqual([]);
  });
});

describe('every write of ciphertext needs the current key', () => {
  it('refuses writes from a device on a replaced (or unknown) key, changing nothing, and takes them on the current one', async () => {
    // Things to encrypt, from before encryption was on.
    const plainNote = await newNote({ content: 'plain' });
    await patch(`/notes/${plainNote.id}`, { content: 'plain, edited' });
    const plainFolder = await newFolder('Plain');
    const plainFile = (await uploadPlain(bytes('plain bytes'), 'a.txt')).body as { id: string };
    await turnOnEncryption();
    // Things encrypted under the first key.
    const note = await encNote({ content: cipher(80) });
    await patch(`/notes/${note.id}`, { enc: true, content: cipher(), snapshot: true });
    const folder = await encFolder();
    const fileId = testId('f');
    await uploadSealed(fileId, 0);
    const drawingId = testId('d');
    await saveDrawing(drawingId, 'rev0001', { enc: true, sealed: cipher(32), kgen: 0 });
    const settings = await put('/settings', { enc: true, data: cipher(40), kgen: 0, base: 0 });
    await replaceKey();

    const plainVersion = (await row<{ id: number }>('SELECT id FROM note_versions WHERE enc = 0'))!.id;
    const encVersion = (await row<{ id: number }>('SELECT id FROM note_versions WHERE enc = 1'))!.id;
    const header = (k: unknown) => (k === undefined ? {} : { 'x-kb-kgen': String(k) });
    const writes: Array<[string, (k: unknown) => Promise<Reply>]> = [
      ['a new note', (k) => post('/notes', { id: testId(), enc: true, content: cipher(), sealed: sealedFields(), kgen: k })],
      ['a restored note', (k) => post('/notes', { id: note.id, enc: true, restore: true, content: cipher(), sealed: sealedFields(), created_at: 1, updated_at: 2, kgen: k })],
      ['an edit', (k) => patch(`/notes/${note.id}`, { enc: true, content: cipher(), kgen: k })],
      ['a rename', (k) => patch(`/notes/${note.id}`, { enc: true, sealed: { t: cipher() }, kgen: k })],
      ['a preview', async (k) => post('/notes/previews', { kgen: k, notes: [{ id: note.id, version: await versionOf(note.id), p: cipher() }] })],
      ['sealing a note', (k) => post('/notes/seal', { kgen: k, notes: [{ id: plainNote.id, version: 2, content: cipher(), sealed: sealedFields() }] })],
      ['sealing a snapshot', (k) => post('/versions/seal', { kgen: k, versions: [{ id: plainVersion, content: cipher(), sealed: { t: cipher() } }] })],
      ['a new folder', (k) => post('/folders', { id: testId('f'), enc: true, sealed: cipher(), kgen: k })],
      ['renaming a folder', (k) => patch(`/folders/${folder.id}`, { sealed: cipher(), kgen: k })],
      ['sealing a folder', (k) => post('/folders/seal', { kgen: k, folders: [{ id: plainFolder.id, sealed: cipher() }] })],
      ['re-encrypting a note', async (k) => post('/rekey/notes', { kgen: k, notes: [{ id: note.id, version: await versionOf(note.id), content: cipher(), sealed: sealedFields() }] })],
      ['re-encrypting a snapshot', (k) => post('/rekey/versions', { kgen: k, versions: [{ id: encVersion, content: cipher(), sealed: { t: cipher() } }] })],
      ['re-encrypting a folder', (k) => post('/rekey/folders', { kgen: k, folders: [{ id: folder.id, sealed: cipher() }] })],
      ['re-wrapping a file key', (k) => post('/rekey/files', { kgen: k, items: [{ id: fileId, sealed: cipher(48) }] })],
      ['re-wrapping a drawing key', (k) => post('/rekey/drawings', { kgen: k, items: [{ id: drawingId, sealed: cipher(32) }] })],
      ['an upload', (k) => call('POST', '/files', bytes('y'.repeat(40)), { headers: { 'x-kb-enc': '1', 'x-file-id': testId('f'), 'x-kb-sealed': cipher(48), ...header(k) } })],
      ['sealing an upload', (k) => call('PUT', `/files/${plainFile.id}/seal`, bytes('z'.repeat(40)), { headers: { 'x-kb-sealed': cipher(48), ...header(k) } })],
      ['a drawing', (k) => saveDrawing(drawingId, `rev${Math.random().toString(36).slice(2, 10)}`, { enc: true, sealed: cipher(32), kgen: k })],
      ['settings', (k) => put('/settings', { enc: true, data: cipher(40), kgen: k, base: settings.body.at })],
    ];

    const before = await dump();
    for (const [name, write] of writes) {
      for (const stale of [0, 2, undefined, 'one']) {
        const res = await write(stale);
        expect([res.status, res.body.error], `${name} with kgen ${stale}`).toEqual([409, 'key_changed']);
      }
    }
    expect(await dump()).toBe(before);

    for (const [name, write] of writes) {
      const res = await write(1);
      expect(res.status, `${name}: ${JSON.stringify(res.body)}`).toBeLessThan(300);
    }
  });

  it('lets moves, pins and trash through from a device on the old key, since they carry no ciphertext', async () => {
    await turnOnEncryption();
    const folder = await encFolder();
    const other = await encFolder();
    const note = await encNote();
    await replaceKey();
    expect((await patch(`/notes/${note.id}`, { enc: true, pinned: true, folder_id: folder.id, kgen: 0 })).status).toBe(200);
    expect((await patch(`/folders/${other.id}`, { parent_id: folder.id, sort: 2, kgen: 0 })).status).toBe(200);
    expect((await post(`/notes/${note.id}/trash`)).status).toBe(200);
    expect((await post(`/notes/${note.id}/restore`)).status).toBe(200);
  });
});

describe('encrypting a library that has plaintext', () => {
  it('encrypts notes in the trash too, without touching their version or dates', async () => {
    const note = await newNote({ content: 'binned' });
    await post(`/notes/${note.id}/trash`);
    const before = await row<Record<string, unknown>>('SELECT version, updated_at, deleted_at FROM notes WHERE id = ?', note.id);
    await turnOnEncryption();
    expect((await post('/notes/seal', { notes: [{ id: note.id, version: 1, content: cipher(), sealed: sealedFields() }] })).body.sealed).toBe(1);
    expect(await row('SELECT version, updated_at, deleted_at FROM notes WHERE id = ?', note.id)).toEqual(before);
  });

  it('never overwrites a note that is already encrypted', async () => {
    await turnOnEncryption();
    const content = cipher();
    const note = await encNote({ content });
    const res = await post('/notes/seal', { notes: [{ id: note.id, version: 1, content: cipher(), sealed: sealedFields() }] });
    expect(res.body.sealed).toBe(0);
    expect((await get(`/notes/${note.id}`)).body.content).toBe(content);
  });

  it('refuses a whole batch if any note in it isn’t properly encrypted', async () => {
    const good = await newNote({ content: 'good' });
    const bad = await newNote({ content: 'bad' });
    await turnOnEncryption();
    const cases = [
      { id: bad.id, version: 1, content: cipher(), sealed: { t: cipher(), g: cipher() } },
      { id: bad.id, version: 1, content: cipher(), sealed: { ...sealedFields(), t: 'readable' } },
      { id: bad.id, content: cipher(), sealed: sealedFields() },
      { id: 'no', version: 1, content: cipher(), sealed: sealedFields() },
      { id: bad.id, version: 1, content: 'e1:short', sealed: sealedFields() },
    ];
    for (const item of cases) {
      const res = await post('/notes/seal', { notes: [{ id: good.id, version: 1, content: cipher(), sealed: sealedFields() }, item] });
      expect(res.status, JSON.stringify(item)).toBe(400);
    }
    expect(await row('SELECT enc, content FROM notes WHERE id = ?', good.id)).toEqual({ enc: 0, content: 'good' });
  });

  it('refuses a note too large to store once encrypted', async () => {
    const note = await newNote({ content: 'x' });
    await turnOnEncryption();
    const huge = `e1:${'A'.repeat(1_800_000)}`;
    const res = await post('/notes/seal', { notes: [{ id: note.id, version: 1, content: huge, sealed: sealedFields() }] });
    expect(res.status).toBe(413);
  });

  it('lists unencrypted snapshots in order, 50 at a time, with what is needed to encrypt them', async () => {
    const note = await newNote({ title: 'Snap', content: 'v0' });
    const now = Date.now();
    await env.DB.batch(
      Array.from({ length: 53 }, (_, i) =>
        env.DB.prepare('INSERT INTO note_versions (note_id, title, content, created_at) VALUES (?, ?, ?, ?)').bind(note.id, 'Snap', `v${i}`, now + i),
      ),
    );
    await turnOnEncryption();
    await encNote({ snapshot: true });
    const first = (await get('/versions/plain')).body;
    expect(first.versions).toHaveLength(50);
    expect(first.versions[0]).toEqual({ id: expect.any(Number), note_id: note.id, title: 'Snap', content: 'v0' });
    expect(first.next).toBe(first.versions[49].id);
    const second = (await get(`/versions/plain?after=${first.next}`)).body;
    expect(second.versions.map((v: { content: string }) => v.content)).toEqual(['v50', 'v51', 'v52']);
    expect(second.next).toBeNull();
    const ids = [...first.versions, ...second.versions].map((v: { id: number }) => v.id);
    expect(ids).toEqual([...ids].sort((x, y) => x - y));
  });

  it('only ever drops or seals snapshots that are still unencrypted', async () => {
    const plain = await newNote({ content: 'one' });
    await patch(`/notes/${plain.id}`, { content: 'two' });
    await turnOnEncryption();
    const enc = await encNote({ content: cipher(80) });
    await patch(`/notes/${enc.id}`, { enc: true, content: cipher(), snapshot: true });
    const encVersion = await row<{ id: number; content: string }>('SELECT id, content FROM note_versions WHERE enc = 1');
    const res = await post('/versions/seal', {
      versions: [
        { id: encVersion!.id, drop: true },
        { id: encVersion!.id, content: cipher(), sealed: { t: cipher() } },
      ],
    });
    expect(res.body.sealed).toBe(0);
    expect(await row('SELECT id, content FROM note_versions WHERE enc = 1')).toEqual(encVersion);
  });

  it('stores a sealed snapshot with no readable title, under the current key generation', async () => {
    const note = await newNote({ title: 'Old title', content: 'one' });
    await patch(`/notes/${note.id}`, { content: 'two' });
    await turnOnEncryption();
    await replaceKey();
    const [v] = (await get('/versions/plain')).body.versions;
    const t = cipher();
    expect((await post('/versions/seal', { kgen: 1, versions: [{ id: v.id, content: cipher(), sealed: { t } }] })).body.sealed).toBe(1);
    const stored = await row<{ title: string; enc: number; sealed: string; kgen: number }>('SELECT title, enc, sealed, kgen FROM note_versions WHERE id = ?', v.id);
    expect(stored).toMatchObject({ title: '', enc: 1, kgen: 1 });
    expect(JSON.parse(stored!.sealed)).toEqual({ t });
  });

  it('refuses snapshots with anything but an encrypted title, and batches with a bad item', async () => {
    const note = await newNote({ content: 'one' });
    await patch(`/notes/${note.id}`, { content: 'two' });
    await turnOnEncryption();
    const [v] = (await get('/versions/plain')).body.versions;
    for (const sealed of [{ t: cipher(), g: cipher() }, {}, { t: 'plain' }, null]) {
      expect((await post('/versions/seal', { versions: [{ id: v.id, content: cipher(), sealed }] })).status, JSON.stringify(sealed)).toBe(400);
    }
    expect((await post('/versions/seal', { versions: [{ id: v.id, content: 'plain', sealed: { t: cipher() } }] })).status).toBe(400);
    expect((await post('/versions/seal', { versions: [{ id: String(v.id), content: cipher(), sealed: { t: cipher() } }] })).status).toBe(400);
    expect((await post('/versions/seal', { versions: Array.from({ length: 101 }, () => ({ id: v.id, drop: true })) })).status).toBe(400);
    expect((await post('/versions/seal', { versions: [] })).status).toBe(400);
    expect(await count('SELECT COUNT(*) AS n FROM note_versions WHERE enc = 0')).toBe(1);
  });

  it('needs encryption to be on before sealing anything', async () => {
    const note = await newNote({ content: 'one' });
    const folder = await newFolder();
    await patch(`/notes/${note.id}`, { content: 'two' });
    const v = (await get('/versions/plain')).body.versions[0];
    const attempts = [
      await post('/versions/seal', { versions: [{ id: v.id, content: cipher(), sealed: { t: cipher() } }] }),
      await post('/folders/seal', { folders: [{ id: folder.id, sealed: cipher() }] }),
      await post('/encryption/finish'),
    ];
    for (const r of attempts) expect([r.status, r.body.error]).toEqual([409, 'no_keyring']);
    expect(await count('SELECT COUNT(*) AS n FROM folders WHERE enc = 1')).toBe(0);
  });

  it('seals only folders still in plaintext, keeping a name encrypted (or renamed) since', async () => {
    const a = await newFolder('A');
    const b = await newFolder('B');
    await turnOnEncryption();
    const renamed = cipher();
    await patch(`/folders/${b.id}`, { sealed: renamed });
    const res = await post('/folders/seal', { folders: [{ id: a.id, sealed: cipher() }, { id: b.id, sealed: cipher() }] });
    expect(res.body.sealed).toBe(1);
    expect(await row('SELECT name, enc FROM folders WHERE id = ?', a.id)).toEqual({ name: '', enc: 1 });
    expect(await row('SELECT sealed FROM folders WHERE id = ?', b.id)).toEqual({ sealed: renamed });
    const bad = await post('/folders/seal', { folders: [{ id: testId('f'), sealed: cipher() }, { id: a.id, sealed: 'Readable name' }] });
    expect(bad.status).toBe(400);
    expect((await post('/folders/seal', { folders: Array.from({ length: 101 }, () => ({ id: a.id, sealed: cipher() })) })).status).toBe(400);
  });

  it('finishes by itself once the last item is sealed: the index and drawing text are emptied', async () => {
    const note = await newNote({ content: 'last words' });
    await saveDrawing(testId('d'), 'rev0001', { text: 'drawing words' });
    await turnOnEncryption();
    expect(await count("SELECT COUNT(*) AS n FROM kb_meta WHERE key = 'plaintext_wiped'")).toBe(0);
    await post('/notes/seal', { notes: [{ id: note.id, version: 1, content: cipher(), sealed: sealedFields() }] });
    expect(await count("SELECT COUNT(*) AS n FROM kb_meta WHERE key = 'plaintext_wiped'")).toBe(1);
    expect(await count("SELECT COUNT(*) AS n FROM drawings WHERE text != ''")).toBe(0);
    expect(await whereStored('words')).toEqual([]);
    // Asking again is harmless.
    expect((await post('/encryption/finish')).body).toEqual({ ok: true });
    expect((await post('/encryption/finish')).body).toEqual({ ok: true });
  });

  it('counts the readable text a restore keeps in history mid-pass, so the pass still encrypts it', async () => {
    const note = await newNote({ title: 'Mid', content: 'readable before the pass' });
    await turnOnEncryption();
    const restored = await post('/notes', { id: note.id, enc: true, restore: true, content: cipher(), sealed: sealedFields(), created_at: 1, updated_at: 2 });
    expect(restored.body).toMatchObject({ enc: true, title: '', excerpt: '' });
    expect((await get('/bootstrap')).body.encryption.pending).toEqual({ notes: 0, versions: 1, folders: 0 });
    const [v] = (await get('/versions/plain')).body.versions;
    expect(v).toMatchObject({ note_id: note.id, content: 'readable before the pass' });
    await post('/versions/seal', { versions: [{ id: v.id, content: cipher(), sealed: { t: cipher() } }] });
    expect(await whereStored('readable')).toEqual([]);
  });

  it('stays on while anything encrypted exists, even with the keyring gone', async () => {
    await turnOnEncryption();
    await encFolder();
    await env.DB.prepare('DELETE FROM keyring').run();
    expect((await post('/notes', { content: 'plain' })).body.error).toBe('encryption_required');
    expect((await post('/folders', { name: 'Plain' })).body.error).toBe('encryption_required');
    expect((await get('/bootstrap')).body.encryption.on).toBe(true);
  });
});

describe('encrypting everything again after the key is replaced', () => {
  it('has nothing to do before the key was ever replaced', async () => {
    await turnOnEncryption();
    const note = await encNote();
    await patch(`/notes/${note.id}`, { enc: true, content: cipher(), snapshot: true });
    for (const path of ['/rekey/notes', '/rekey/versions']) {
      const body = (await get(path)).body;
      expect(Object.values(body)[0], path).toEqual([]);
      expect(body.next).toBeNull();
    }
    expect((await get('/rekey/files')).body).toEqual({ items: [], next: null });
    expect((await get('/rekey/drawings')).body).toEqual({ items: [], next: null });
    const res = await post('/rekey/notes', { kgen: 0, notes: [{ id: note.id, version: 2, content: cipher(), sealed: sealedFields() }] });
    expect(res.body.rekeyed).toBe(0);
  });

  it('pages through notes and snapshots 50 at a time', async () => {
    await turnOnEncryption();
    const now = Date.now();
    const sealed = JSON.stringify(sealedFields());
    await env.DB.batch(
      Array.from({ length: 53 }, (_, i) =>
        env.DB.prepare('INSERT INTO notes (id, content, created_at, updated_at, enc, sealed) VALUES (?, ?, ?, ?, 1, ?)').bind(`renc${String(i).padStart(4, '0')}`, cipher(), now, now, sealed),
      ),
    );
    await env.DB.batch(
      Array.from({ length: 51 }, () =>
        env.DB.prepare('INSERT INTO note_versions (note_id, title, content, created_at, enc, sealed) VALUES (?, ?, ?, ?, 1, ?)').bind('renc0000', '', cipher(), now, JSON.stringify({ t: cipher() })),
      ),
    );
    await replaceKey();
    const first = (await get('/rekey/notes')).body;
    expect(first.notes).toHaveLength(50);
    expect(first.notes[0]).toEqual({ id: 'renc0000', version: 1, updated_at: now, content: expect.any(String), sealed: JSON.parse(sealed) });
    const second = (await get(`/rekey/notes?after=${first.next}`)).body;
    expect(second.notes.map((n: { id: string }) => n.id)).toEqual(['renc0050', 'renc0051', 'renc0052']);
    expect(second.next).toBeNull();
    const v1 = (await get('/rekey/versions')).body;
    expect(v1.versions).toHaveLength(50);
    const v2 = (await get(`/rekey/versions?after=${v1.next}`)).body;
    expect([v2.versions.length, v2.next]).toEqual([1, null]);
  });

  it('covers everything from every earlier key after two replacements', async () => {
    await turnOnEncryption();
    const first = await encNote();
    await replaceKey();
    const second = await encNote({ kgen: 1 });
    await replaceKey();
    expect((await get('/bootstrap')).body.encryption).toMatchObject({ gen: 2, rekey: { notes: 2 } });
    const listed = (await get('/rekey/notes')).body.notes.map((n: { id: string }) => n.id);
    expect(listed.sort()).toEqual([first.id, second.id].sort());
    const res = await post('/rekey/notes', { kgen: 2, notes: [first, second].map((n) => ({ id: n.id, version: 1, content: cipher(), sealed: sealedFields() })) });
    expect(res.body.rekeyed).toBe(2);
    expect(await count('SELECT COUNT(*) AS n FROM notes WHERE kgen = 2')).toBe(2);
    expect((await get('/bootstrap')).body.encryption.rekey.notes).toBe(0);
  });

  it('keeps a note’s version and dates, so edits waiting on a device still apply', async () => {
    await turnOnEncryption();
    const note = await encNote();
    const before = await row('SELECT version, updated_at, created_at FROM notes WHERE id = ?', note.id);
    await replaceKey();
    expect((await post('/rekey/notes', { kgen: 1, notes: [{ id: note.id, version: 1, content: cipher(), sealed: sealedFields() }] })).body.rekeyed).toBe(1);
    expect(await row('SELECT version, updated_at, created_at FROM notes WHERE id = ?', note.id)).toEqual(before);
    expect((await patch(`/notes/${note.id}`, { enc: true, content: cipher(), baseVersion: 1, kgen: 1 })).status).toBe(200);
  });

  it('doesn’t write old tags or an old title back over ones changed since the note was read', async () => {
    await turnOnEncryption();
    const note = await encNote();
    await replaceKey();
    const read = (await get('/rekey/notes')).body.notes.find((n: { id: string }) => n.id === note.id);
    expect(read.updated_at).toEqual(expect.any(Number));
    // Meanwhile (on another device, already on the new key): new tags. The version stays as it was.
    await new Promise((r) => setTimeout(r, 2));
    const tags = cipher();
    expect((await patch(`/notes/${note.id}`, { enc: true, sealed: { g: tags }, kgen: 1 })).status).toBe(200);
    expect(await versionOf(note.id)).toBe(read.version);
    // The pass carries on with what it read: refused for that note, which comes up again.
    const stale = await post('/rekey/notes', { kgen: 1, notes: [{ id: note.id, version: read.version, updated_at: read.updated_at, content: cipher(), sealed: sealedFields() }] });
    expect(stale.body.rekeyed).toBe(0);
    expect(JSON.parse((await row<{ sealed: string }>('SELECT sealed FROM notes WHERE id = ?', note.id))!.sealed).g).toBe(tags);
    const again = (await get('/rekey/notes')).body.notes.find((n: { id: string }) => n.id === note.id);
    expect(again.updated_at).not.toBe(read.updated_at);
    const fresh = await post('/rekey/notes', { kgen: 1, notes: [{ id: note.id, version: again.version, updated_at: again.updated_at, content: cipher(), sealed: sealedFields() }] });
    expect(fresh.body.rekeyed).toBe(1);
  });

  it('writes nothing twice: what is already under the current key is left alone', async () => {
    await turnOnEncryption();
    const note = await encNote();
    const folder = await encFolder();
    await replaceKey();
    const content = cipher();
    await post('/rekey/notes', { kgen: 1, notes: [{ id: note.id, version: 1, content, sealed: sealedFields() }] });
    await post('/rekey/folders', { kgen: 1, folders: [{ id: folder.id, sealed: cipher() }] });
    const again = await post('/rekey/notes', { kgen: 1, notes: [{ id: note.id, version: 1, content: cipher(), sealed: sealedFields() }] });
    expect(again.body.rekeyed).toBe(0);
    expect((await get(`/notes/${note.id}`)).body.content).toBe(content);
    expect((await post('/rekey/folders', { kgen: 1, folders: [{ id: folder.id, sealed: cipher() }] })).body.rekeyed).toBe(0);
  });

  it('leaves unencrypted rows alone, so re-encryption can’t mark plaintext as encrypted', async () => {
    const note = await newNote({ content: 'plain' });
    const folder = await newFolder('Plain');
    await turnOnEncryption();
    await replaceKey();
    expect((await post('/rekey/notes', { kgen: 1, notes: [{ id: note.id, version: 1, content: cipher(), sealed: sealedFields() }] })).body.rekeyed).toBe(0);
    expect((await post('/rekey/folders', { kgen: 1, folders: [{ id: folder.id, sealed: cipher() }] })).body.rekeyed).toBe(0);
    expect(await row('SELECT enc, content FROM notes WHERE id = ?', note.id)).toEqual({ enc: 0, content: 'plain' });
    expect(await row('SELECT enc, name FROM folders WHERE id = ?', folder.id)).toEqual({ enc: 0, name: 'Plain' });
  });

  it('keeps a note edited under the new key on its old generation until it is re-encrypted whole', async () => {
    await turnOnEncryption();
    const note = await encNote();
    await replaceKey();
    await patch(`/notes/${note.id}`, { enc: true, sealed: { t: cipher() }, kgen: 1 });
    expect(await row('SELECT kgen FROM notes WHERE id = ?', note.id)).toEqual({ kgen: 0 });
    expect((await get('/rekey/notes')).body.notes.map((n: { id: string }) => n.id)).toEqual([note.id]);
  });

  it('refuses a whole batch if any item isn’t properly encrypted', async () => {
    await turnOnEncryption();
    const a = await encNote();
    const folder = await encFolder();
    await encNote({ snapshot: true });
    await patch(`/notes/${a.id}`, { enc: true, content: cipher(), snapshot: true });
    const v = (await row<{ id: number }>('SELECT id FROM note_versions'))!.id;
    await replaceKey();
    const good = { id: a.id, version: 2, content: cipher(), sealed: sealedFields() };
    const bad: Array<[string, unknown]> = [
      ['/rekey/notes', { notes: [good, { ...good, sealed: { t: cipher() } }] }],
      ['/rekey/notes', { notes: [good, { ...good, version: '2' }] }],
      ['/rekey/notes', { notes: [good, { ...good, content: 'readable' }] }],
      ['/rekey/versions', { versions: [{ id: v, content: cipher(), sealed: { t: cipher(), g: cipher() } }] }],
      ['/rekey/versions', { versions: [{ id: v, content: cipher(), sealed: {} }] }],
      ['/rekey/folders', { folders: [{ id: folder.id, sealed: 'Readable' }] }],
      ['/rekey/files', { items: [{ id: 'bad id', sealed: cipher() }] }],
      ['/rekey/drawings', { items: [{ id: testId('d'), sealed: cipher(5000) }] }],
    ];
    for (const [path, body] of bad) {
      const res = await post(path, { kgen: 1, ...(body as object) });
      expect(res.status, `${path} ${JSON.stringify(body).slice(0, 80)}`).toBe(400);
    }
    for (const [path, key] of [['/rekey/notes', 'notes'], ['/rekey/versions', 'versions'], ['/rekey/folders', 'folders'], ['/rekey/files', 'items'], ['/rekey/drawings', 'items']]) {
      expect((await post(path, { kgen: 1, [key]: [] })).status, path).toBe(400);
      expect((await post(path, { kgen: 1, [key]: Array.from({ length: 101 }, () => ({})) })).status, path).toBe(400);
    }
    expect(await count('SELECT COUNT(*) AS n FROM notes WHERE kgen = 1')).toBe(0);
  });

  it('lists file and drawing keys after a given id, 100 at a time', async () => {
    await turnOnEncryption();
    const ids = ['faaaaaaa', 'fbbbbbbb', 'fccccccc'];
    for (const id of ids) await uploadSealed(id, 0);
    await replaceKey();
    expect((await get('/rekey/files')).body.items.map((f: { id: string }) => f.id)).toEqual(ids);
    expect((await get('/rekey/files?after=fbbbbbbb')).body).toEqual({ items: [{ id: 'fccccccc', sealed: expect.any(String) }], next: null });
  });
});

describe('the keyring', () => {
  it('lets only one of two devices turn encryption on at the same moment', async () => {
    const results = await Promise.all([1, 2].map(() => post('/keyring', { data: keyringData(), replaces: null })));
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(await count('SELECT COUNT(*) AS n FROM keyring')).toBe(1);
  });

  it('lets only one of two simultaneous changes through, and never one based on an older keyring', async () => {
    const first = await turnOnEncryption();
    const results = await Promise.all([1, 2].map(() => post('/keyring', { data: keyringData(), replaces: first.id })));
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    const winner = results.find((r) => r.status === 201)!.body.keyring;
    expect((await get('/keyring')).body.keyring.id).toBe(winner.id);
    expect((await post('/keyring', { data: keyringData(), replaces: first.id })).body.error).toBe('keyring_changed');
    expect((await post('/keyring', { data: keyringData(), replaces: String(winner.id) })).status).toBe(409);
    expect(await count('SELECT COUNT(*) AS n FROM keyring')).toBe(1);
  });

  it('gives back what was stored, with the key generation and the earlier keys', async () => {
    await turnOnEncryption();
    await replaceKey();
    const { keyring } = (await get('/keyring')).body;
    expect(keyring).toMatchObject({ id: expect.any(Number), created_at: expect.any(Number), data: { v: 1, gen: 1 } });
    expect(keyring.data.prev).toHaveLength(1);
  });

  it('refuses keyrings that are malformed or out of step', async () => {
    const ring = await turnOnEncryption();
    const prevKey = { iv: cipher(4), key: cipher(32) };
    const bad: unknown[] = [
      null,
      [],
      'keyring',
      { ...keyringData(), v: 2 },
      { ...keyringData(), kdf: { salt: 5 } },
      { ...keyringData(), pass: null },
      { ...keyringData(), gen: '1' },
      { ...keyringData(), gen: 1.5 },
      { ...keyringData(), gen: -1 },
      { ...keyringData(), gen: 1, prev: Array.from({ length: 21 }, () => prevKey) },
      { ...keyringData(), gen: 1, prev: [{ iv: 'a' }] },
      { ...keyringData(), gen: 1, prev: [null] },
    ];
    for (const data of bad) {
      const res = await post('/keyring', { data, replaces: ring.id });
      expect([res.status, res.body.error], JSON.stringify(data)?.slice(0, 60)).toEqual([400, 'bad_keyring']);
    }
    expect((await get('/keyring')).body.keyring.id).toBe(ring.id);
    const ok = await post('/keyring', { data: { ...keyringData(), gen: 1, prev: Array.from({ length: 20 }, () => prevKey) }, replaces: ring.id });
    expect(ok.status).toBe(201);
  });
});

describe('note previews', () => {
  it('only replace an encrypted note’s preview, keeping its title and tags', async () => {
    const plain = await newNote({ content: 'readable' });
    await turnOnEncryption();
    const sealed = sealedFields();
    const enc = await encNote({ sealed });
    const p = cipher(50);
    const res = await post('/notes/previews', {
      notes: [
        { id: plain.id, version: 1, p: cipher() },
        { id: enc.id, version: 1, p },
        { id: 'missingnote1', version: 1, p: cipher() },
      ],
    });
    expect(res.body.updated).toEqual([enc.id]);
    expect(JSON.parse((await row<{ sealed: string }>('SELECT sealed FROM notes WHERE id = ?', enc.id))!.sealed)).toEqual({ ...sealed, p });
    expect(await row('SELECT sealed, excerpt FROM notes WHERE id = ?', plain.id)).toEqual({ sealed: '{}', excerpt: 'readable' });
  });

  it('refuse previews that are too large or not encrypted, and malformed batches', async () => {
    await turnOnEncryption();
    const note = await encNote();
    for (const item of [
      { id: note.id, version: 1, p: `e1:${'A'.repeat(200_001)}` },
      { id: note.id, version: 1 },
      { id: note.id, version: 1.5, p: cipher() },
      { id: 'x', version: 1, p: cipher() },
    ]) {
      expect((await post('/notes/previews', { notes: [item] })).status, JSON.stringify(item).slice(0, 60)).toBe(400);
    }
    expect((await post('/notes/previews', { notes: Array.from({ length: 101 }, () => ({ id: note.id, version: 1, p: cipher() })) })).status).toBe(400);
  });
});
