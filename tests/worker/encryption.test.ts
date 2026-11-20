/**
 * End-to-end encryption, server side: the keyring, refusing plaintext once it's on, the one-time
 * conversion (seal endpoints) and wiping the search index. The Worker never decrypts; it checks shapes.
 */
import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { cipher, del, get, keyringData, newFolder, newNote, patch, post, resetLibrary, sealedFields, testId, turnOnEncryption } from './helpers';

beforeEach(resetLibrary);

/** Every word the full-text index still holds anywhere, including its internal tables. */
async function indexHolds(word: string): Promise<boolean> {
  const rows = await env.DB.prepare('SELECT block FROM notes_fts_data').all<{ block: ArrayBuffer }>();
  const needle = new TextEncoder().encode(word);
  return rows.results.some(({ block }) => {
    const bytes = new Uint8Array(block);
    outer: for (let i = 0; i + needle.length <= bytes.length; i++) {
      for (let j = 0; j < needle.length; j++) if (bytes[i + j] !== needle[j]) continue outer;
      return true;
    }
    return false;
  });
}

describe('keyring', () => {
  it('starts empty, then stores one keyring, replaced only on top of the one read', async () => {
    expect((await get('/keyring')).body.keyring).toBeNull();
    expect((await post('/keyring', { data: { v: 1 } })).status).toBe(400);
    expect((await post('/keyring', { data: { ...keyringData(), pad: 'x'.repeat(20_000) } })).status).toBe(400);
    const first = await turnOnEncryption();
    const stale = await post('/keyring', { data: keyringData(), replaces: null });
    expect(stale.status).toBe(409);
    expect(stale.body.error).toBe('keyring_changed');
    const next = await post('/keyring', { data: keyringData(), replaces: first.id });
    expect(next.status).toBe(201);
    const rows = await env.DB.prepare('SELECT COUNT(*) AS n FROM keyring').first<{ n: number }>();
    expect(rows?.n).toBe(1);
    expect((await get('/keyring')).body.keyring.id).toBe(next.body.keyring.id);
  });
});

describe('once encryption is on', () => {
  it('refuses plaintext notes and folder names, in every way they could arrive', async () => {
    const plainNote = await newNote({ content: 'before' });
    const plainFolder = await newFolder('Before');
    await turnOnEncryption();
    const refusals = [
      await post('/notes', { title: 'x', content: 'plain' }),
      await post('/notes', { id: testId(), title: 'x', content: 'plain', restore: true }),
      await patch(`/notes/${plainNote.id}`, { content: 'still plain' }),
      await post('/folders', { name: 'Plain' }),
      await patch(`/folders/${plainFolder.id}`, { name: 'Plain' }),
    ];
    for (const r of refusals) expect([r.status, r.body.error]).toEqual([409, 'encryption_required']);
    // Removing the keyring row doesn't switch it off while anything encrypted exists.
    await post('/notes', { id: testId(), enc: true, content: cipher(), sealed: sealedFields() });
    await env.DB.prepare('DELETE FROM keyring').run();
    expect((await post('/notes', { content: 'plain' })).status).toBe(409);
  });

  it('accepts only well-formed ciphertext, under an id the app chose', async () => {
    await turnOnEncryption();
    const bad = [
      { enc: true, content: cipher(), sealed: sealedFields() },
      { id: testId(), enc: true, content: 'plain words', sealed: sealedFields() },
      { id: testId(), enc: true, content: cipher(), sealed: { ...sealedFields(), t: 'plain title' } },
      { id: testId(), enc: true, content: cipher(), sealed: { t: cipher() } },
      { id: testId(), enc: true, content: cipher(), sealed: { ...sealedFields(), extra: cipher() } },
    ];
    for (const body of bad) expect((await post('/notes', body)).status).toBe(400);
    const id = testId();
    const ok = await post('/notes', { id, enc: true, title: 'leak?', tags: ['leak'], content: cipher(), sealed: sealedFields() });
    expect(ok.status).toBe(201);
    const row = await env.DB.prepare('SELECT title, tags, excerpt, info FROM notes WHERE id = ?').bind(id).first();
    expect(row).toEqual({ title: '', tags: '[]', excerpt: '', info: '{}' });
  });

  it('saves encrypted notes with conflict detection and keeps their history encrypted', async () => {
    await turnOnEncryption();
    const id = testId();
    const sealed = sealedFields();
    await post('/notes', { id, enc: true, content: cipher(), sealed });
    const saved = await patch(`/notes/${id}`, { enc: true, content: cipher(), baseVersion: 1, snapshot: true });
    expect(saved.status).toBe(200);
    expect(saved.body.version).toBe(2);
    const stale = await patch(`/notes/${id}`, { enc: true, content: cipher(), baseVersion: 1 });
    expect(stale.status).toBe(409);
    expect((await patch(`/notes/${id}`, { content: 'plain', baseVersion: 2 })).status).toBe(409);
    expect((await patch(`/notes/${id}`, { enc: true, content: 'plain', baseVersion: 2 })).status).toBe(400);
    // A tags-only change (sealed g) doesn't conflict or bump the version.
    const tags = await patch(`/notes/${id}`, { enc: true, sealed: { g: cipher() }, baseVersion: 0 });
    expect(tags.body.version).toBe(2);
    const v = await env.DB.prepare('SELECT enc, title, sealed FROM note_versions WHERE note_id = ?').bind(id).first<{ enc: number; title: string; sealed: string }>();
    expect(v).toMatchObject({ enc: 1, title: '' });
    expect(JSON.parse(v!.sealed)).toEqual({ t: sealed.t });
  });

  it('replaces an encrypted note’s preview alone, only at the version the app read', async () => {
    await turnOnEncryption();
    const id = testId();
    const sealed = sealedFields();
    const made = (await post('/notes', { id, enc: true, content: cipher(), sealed })).body;
    const newP = cipher(40);
    const res = await post('/notes/previews', { notes: [{ id, version: made.version, p: newP }, { id: testId(), version: 1, p: cipher() }] });
    expect(res.body.updated).toEqual([id]);
    const row = await env.DB.prepare('SELECT sealed, version, updated_at FROM notes WHERE id = ?').bind(id).first<{ sealed: string; version: number; updated_at: number }>();
    expect(JSON.parse(row!.sealed)).toEqual({ ...sealed, p: newP });
    expect([row!.version, row!.updated_at]).toEqual([made.version, made.updated_at]);
    // Edited since: left alone.
    await patch(`/notes/${id}`, { enc: true, content: cipher(), baseVersion: made.version });
    expect((await post('/notes/previews', { notes: [{ id, version: made.version, p: cipher() }] })).body.updated).toEqual([]);
    // Plaintext and malformed input are refused.
    expect((await post('/notes/previews', { notes: [{ id, version: 2, p: 'plain preview' }] })).status).toBe(400);
    expect((await post('/notes/previews', { notes: [] })).status).toBe(400);
  });

  it('keeps a device’s older edits of an encrypted note in its history only encrypted, in the current key', async () => {
    await turnOnEncryption();
    const id = testId();
    await post('/notes', { id, enc: true, content: cipher(), sealed: sealedFields() });
    const t = cipher(16);
    const content = cipher();
    const refusals = [
      await post(`/notes/${id}/versions`, { title: 'plain title', content: 'plain text' }),
      await post(`/notes/${id}/versions`, { enc: true, content: 'plain text', sealed: { t } }),
      await post(`/notes/${id}/versions`, { enc: true, content, sealed: { t: 'plain title' } }),
      await post(`/notes/${id}/versions`, { enc: true, content, sealed: { t, g: cipher() } }),
      await post(`/notes/${id}/versions`, { enc: true, content, sealed: { t }, kgen: 5 }),
    ];
    expect(refusals.map((r) => [r.status, r.body.error])).toEqual([
      [409, 'encryption_required'],
      [400, 'bad_cipher'],
      [400, 'bad_cipher'],
      [400, 'bad_cipher'],
      [409, 'key_changed'],
    ]);
    const ok = await post(`/notes/${id}/versions`, { enc: true, content, sealed: { t }, kgen: 0 });
    expect(ok.status).toBe(201);
    const v = await env.DB.prepare('SELECT enc, title, content, sealed FROM note_versions WHERE id = ?').bind(ok.body.id).first<{ enc: number; title: string; content: string; sealed: string }>();
    expect(v).toMatchObject({ enc: 1, title: '', content });
    expect(JSON.parse(v!.sealed)).toEqual({ t });
    // A plaintext note in a library that's now encrypted takes no plaintext version either.
    await env.DB.prepare(`INSERT INTO notes (id, title, content, version, created_at, updated_at) VALUES ('plainleft1', 'Old', 'old', 1, 0, 0)`).run();
    expect((await post('/notes/plainleft1/versions', { title: 'x', content: 'plain' })).body.error).toBe('encryption_required');
  });

  it('never indexes encrypted notes for search', async () => {
    await turnOnEncryption();
    const content = cipher();
    await post('/notes', { id: testId(), enc: true, content, sealed: sealedFields() });
    expect(await indexHolds(content.slice(3, 20))).toBe(false);
  });
});

describe('replacing the encryption key', () => {
  async function replaceKey(from: number) {
    const current = (await get('/keyring')).body.keyring;
    const res = await post('/keyring', { data: { ...keyringData(), gen: from + 1, prev: [{ iv: 'a', key: 'b' }] }, replaces: current.id });
    expect(res.status).toBe(201);
  }

  it('moves the key generation up one step at a time, never back', async () => {
    const first = await turnOnEncryption();
    expect((await post('/keyring', { data: { ...keyringData(), gen: 2 }, replaces: first.id })).status).toBe(400);
    await replaceKey(0);
    const now = (await get('/keyring')).body.keyring;
    expect((await post('/keyring', { data: { ...keyringData(), gen: 0 }, replaces: now.id })).status).toBe(400);
    expect((await post('/keyring', { data: { ...keyringData(), gen: 1, prev: 'nope' }, replaces: now.id })).status).toBe(400);
    // A passphrase change keeps the generation.
    expect((await post('/keyring', { data: { ...keyringData(), gen: 1 }, replaces: now.id })).status).toBe(201);
  });

  it('refuses ciphertext from a device still on the old key', async () => {
    await turnOnEncryption();
    const id = testId();
    await post('/notes', { id, enc: true, content: cipher(), sealed: sealedFields() });
    const folder = (await post('/folders', { id: testId('f'), enc: true, sealed: cipher() })).body;
    await replaceKey(0);
    const stale = [
      await post('/notes', { id: testId(), enc: true, content: cipher(), sealed: sealedFields() }),
      await patch(`/notes/${id}`, { enc: true, content: cipher() }),
      await patch(`/folders/${folder.id}`, { sealed: cipher() }),
      await post('/notes/previews', { notes: [{ id, version: 1, p: cipher() }] }),
    ];
    for (const r of stale) expect([r.status, r.body.error]).toEqual([409, 'key_changed']);
    // Moving and pinning carry no ciphertext, so they still work.
    expect((await patch(`/notes/${id}`, { pinned: true })).status).toBe(200);
    const fresh = await post('/notes', { id: testId(), enc: true, content: cipher(), sealed: sealedFields(), kgen: 1 });
    expect(fresh.status).toBe(201);
    const row = await env.DB.prepare('SELECT kgen FROM notes WHERE id = ?').bind(fresh.body.id).first<{ kgen: number }>();
    expect(row?.kgen).toBe(1);
    // Reading a note says which key generation wrote it; an older one is still on the old key.
    expect((await get(`/notes/${fresh.body.id}`)).body.kgen).toBe(1);
    expect((await get(`/notes/${id}`)).body.kgen).toBe(0);
  });

  it('lists what is left under the old key and takes it back re-encrypted, skipping notes edited since', async () => {
    await turnOnEncryption();
    const a = testId();
    const b = testId();
    await post('/notes', { id: a, enc: true, content: cipher(), sealed: sealedFields() });
    await post('/notes', { id: b, enc: true, content: cipher(), sealed: sealedFields() });
    await patch(`/notes/${a}`, { enc: true, content: cipher(), snapshot: true });
    const folder = (await post('/folders', { id: testId('f'), enc: true, sealed: cipher() })).body;
    await replaceKey(0);

    let boot = (await get('/bootstrap')).body.encryption;
    expect(boot).toMatchObject({ gen: 1, rekey: { notes: 2, versions: 1, folders: 1 } });

    const notes = (await get('/rekey/notes')).body.notes as Array<{ id: string; version: number }>;
    expect(notes.map((n) => n.id).sort()).toEqual([a, b].sort());
    // Note b is edited (on this, current-key device) after the pass read it.
    await patch(`/notes/${b}`, { enc: true, content: cipher(), kgen: 1 });
    const wrote = await post('/rekey/notes', { kgen: 1, notes: notes.map((n) => ({ id: n.id, version: n.version, content: cipher(), sealed: sealedFields() })) });
    expect(wrote.body.rekeyed).toBe(1);
    expect((await post('/rekey/notes', { notes: [{ id: a, version: 2, content: cipher(), sealed: sealedFields() }] })).status).toBe(409);

    // Two snapshots under the old key: note a's, and the one note b's edit just made of its old text.
    const versions = (await get('/rekey/versions')).body.versions as Array<{ id: number }>;
    expect(versions).toHaveLength(2);
    await post('/rekey/versions', { kgen: 1, versions: versions.map((v) => ({ id: v.id, content: cipher(), sealed: { t: cipher() } })) });
    await post('/rekey/folders', { kgen: 1, folders: [{ id: folder.id, sealed: cipher() }] });

    boot = (await get('/bootstrap')).body.encryption;
    expect(boot.rekey).toEqual({ notes: 1, versions: 0, folders: 0, files: 0, drawings: 0 });
    // Note b comes up again at its new version, and then everything is done.
    const [again] = (await get('/rekey/notes')).body.notes;
    expect(again.id).toBe(b);
    await post('/rekey/notes', { kgen: 1, notes: [{ id: b, version: again.version, content: cipher(), sealed: sealedFields() }] });
    expect((await get('/bootstrap')).body.encryption.rekey).toEqual({ notes: 0, versions: 0, folders: 0, files: 0, drawings: 0 });
  });

  it('keeps a snapshot under the key its text was written with', async () => {
    await turnOnEncryption();
    const id = testId();
    await post('/notes', { id, enc: true, content: cipher(), sealed: sealedFields() });
    await replaceKey(0);
    await patch(`/notes/${id}`, { enc: true, content: cipher(), kgen: 1, snapshot: true });
    const v = await env.DB.prepare('SELECT kgen FROM note_versions WHERE note_id = ?').bind(id).first<{ kgen: number }>();
    expect(v?.kgen).toBe(0);
    expect((await get('/rekey/versions')).body.versions).toHaveLength(1);
  });
});

describe('the one-time conversion', () => {
  it('encrypts notes in place without a snapshot, skipping notes edited since they were read', async () => {
    const a = await newNote({ title: 'Secret plan', content: 'plaintext words' });
    const b = await newNote({ content: 'other' });
    await patch(`/notes/${b.id}`, { content: 'edited after read' });
    await turnOnEncryption();
    const res = await post('/notes/seal', {
      notes: [
        { id: a.id, version: a.version, content: cipher(), sealed: sealedFields() },
        { id: b.id, version: b.version, content: cipher(), sealed: sealedFields() },
      ],
    });
    expect(res.body.sealed).toBe(1);
    const row = await env.DB.prepare('SELECT enc, title, tags, excerpt, version FROM notes WHERE id = ?').bind(a.id).first();
    expect(row).toEqual({ enc: 1, title: '', tags: '[]', excerpt: '', version: a.version });
    const versions = await env.DB.prepare('SELECT COUNT(*) AS n FROM note_versions WHERE note_id = ?').bind(a.id).first<{ n: number }>();
    expect(versions?.n).toBe(0);
  });

  it('validates what it is given', async () => {
    expect((await post('/notes/seal', { notes: [] })).status).toBe(409); // not on yet
    await turnOnEncryption();
    expect((await post('/notes/seal', { notes: [] })).status).toBe(400);
    expect((await post('/notes/seal', { notes: Array(101).fill({}) })).status).toBe(400);
    expect((await post('/notes/seal', { notes: [{ id: testId(), version: 1, content: 'plain', sealed: sealedFields() }] })).status).toBe(400);
  });

  it('encrypts history snapshots and folder names, then wipes the search index', async () => {
    const n = await newNote({ title: 'Diary', content: 'zanzibar original words' });
    await patch(`/notes/${n.id}`, { content: 'quokka newer words' });
    const folder = await newFolder('Private stuff');
    await turnOnEncryption();

    let pending = (await get('/bootstrap')).body.encryption;
    expect(pending).toMatchObject({ on: true, pending: { notes: 1, versions: 1, folders: 1 } });
    expect((await post('/encryption/finish')).status).toBe(409);

    const plain = (await get('/versions/plain')).body;
    expect(plain.versions).toHaveLength(1);
    expect(plain.versions[0].content).toBe('zanzibar original words');
    await post('/versions/seal', { versions: [{ id: plain.versions[0].id, content: cipher(), sealed: { t: cipher() } }] });
    await post('/folders/seal', { folders: [{ id: folder.id, sealed: cipher() }] });
    const current = (await get(`/notes/${n.id}`)).body;
    await post('/notes/seal', { notes: [{ id: n.id, version: current.version, content: cipher(), sealed: sealedFields() }] });

    pending = (await get('/bootstrap')).body.encryption;
    expect(pending.pending).toEqual({ notes: 0, versions: 0, folders: 0 });
    expect((await post('/encryption/finish')).status).toBe(200);
    expect(await indexHolds('quokka')).toBe(false);
    expect(await indexHolds('zanzibar')).toBe(false);
    const f = await env.DB.prepare('SELECT name, enc FROM folders WHERE id = ?').bind(folder.id).first();
    expect(f).toEqual({ name: '', enc: 1 });
  });

  it('leaves no plaintext in the search index even if the app never calls finish', async () => {
    const n = await newNote({ title: 'Ledger', content: 'wombat confidential' });
    await turnOnEncryption();
    await post('/notes/seal', { notes: [{ id: n.id, version: n.version, content: cipher(), sealed: sealedFields() }] });
    // The tab closed here, before the app's last step. The next load must not find the words.
    await get('/bootstrap');
    expect(await indexHolds('wombat')).toBe(false);
    expect(await indexHolds('ledger')).toBe(false);
  });

  it('erases each note’s words from the index as soon as it is encrypted, mid-pass', async () => {
    const first = await newNote({ content: 'pangolin alpha' });
    await newNote({ content: 'capybara beta' });
    await turnOnEncryption();
    await post('/notes/seal', { notes: [{ id: first.id, version: first.version, content: cipher(), sealed: sealedFields() }] });
    // The pass is only half done (the second note is still plaintext), yet the first note's words are gone.
    expect((await get('/bootstrap')).body.encryption.pending.notes).toBe(1);
    expect(await indexHolds('pangolin')).toBe(false);
    expect(await indexHolds('capybara')).toBe(true);
  });

  it('drops a snapshot too large to encrypt rather than keep it readable', async () => {
    const n = await newNote({ content: 'first' });
    await patch(`/notes/${n.id}`, { content: 'second' });
    await turnOnEncryption();
    const [v] = (await get('/versions/plain')).body.versions;
    await post('/versions/seal', { versions: [{ id: v.id, drop: true }] });
    expect((await get(`/versions/${v.id}`)).status).toBe(404);
  });

  it('deletes forever only what it is told to', async () => {
    await turnOnEncryption();
    const id = testId();
    await post('/notes', { id, enc: true, content: cipher(), sealed: sealedFields() });
    expect((await del(`/notes/${id}`)).status).toBe(200);
  });
});
