/**
 * Keeping the library consistent: saves from two devices, history, trash and deleting for good, and
 * folders, including what happens when they meet (a folder deleted with notes and history inside it).
 */
import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { cipher, del, get, newFolder, newNote, patch, post, resetLibrary, sealedFields, testId, turnOnEncryption } from './helpers';
import { count, encNote, row } from './api-helpers';

beforeEach(resetLibrary);

/** The texts kept in a note's history, newest first. */
async function history(id: string): Promise<string[]> {
  const versions = (await get(`/notes/${id}/versions`)).body.versions as Array<{ id: number }>;
  return Promise.all(versions.map(async (v) => (await get(`/versions/${v.id}`)).body.content as string));
}

describe('saving from two devices', () => {
  it('treats a title change as a change to the text, so a stale one conflicts', async () => {
    const note = await newNote({ title: 'First', content: 'body' });
    await patch(`/notes/${note.id}`, { content: 'body, edited', baseVersion: 1 });
    const stale = await patch(`/notes/${note.id}`, { title: 'Renamed elsewhere', baseVersion: 1 });
    expect(stale.status).toBe(409);
    expect(stale.body.note).toMatchObject({ title: 'First', content: 'body, edited', version: 2 });
    expect((await get(`/notes/${note.id}`)).body.title).toBe('First');
  });

  it('answers a save based on a version the server never had with a conflict', async () => {
    const note = await newNote({ content: 'body' });
    const res = await patch(`/notes/${note.id}`, { content: 'from the future', baseVersion: 7 });
    expect(res.status).toBe(409);
    expect((await get(`/notes/${note.id}`)).body).toMatchObject({ content: 'body', version: 1 });
  });

  it('lets a save that changes no text through, whatever version it was based on', async () => {
    const note = await newNote({ title: 'Same', content: 'same' });
    await patch(`/notes/${note.id}`, { content: 'moved on', baseVersion: 1 });
    const res = await patch(`/notes/${note.id}`, { title: 'Same', content: 'moved on', baseVersion: 1 });
    expect([res.status, res.body.version]).toEqual([200, 2]);
  });

  it('keeps no history from a save it refused', async () => {
    const note = await newNote({ content: 'one' });
    await patch(`/notes/${note.id}`, { content: 'two', baseVersion: 1 });
    expect(await history(note.id)).toEqual(['one']);
    const stale = await patch(`/notes/${note.id}`, { content: 'three', baseVersion: 1, snapshot: true });
    expect(stale.status).toBe(409);
    expect(await history(note.id)).toEqual(['one']);
  });

  it('keeps no history from the saves that lost a race', async () => {
    const note = await newNote({ content: 'start' });
    const results = await Promise.all(['a', 'b', 'c', 'd'].map((content) => patch(`/notes/${note.id}`, { content, baseVersion: 1 })));
    expect(results.map((r) => r.status).sort()).toEqual([200, 409, 409, 409]);
    expect(await history(note.id)).toEqual(['start']);
  });

  it('keeps the text a forced save ("Keep mine") replaces in history, even if it changed after the save read it', async () => {
    const note = await newNote({ content: 'original' });
    await patch(`/notes/${note.id}`, { content: 'A text', baseVersion: 1 });
    // Device A saves again while device B, which saw the conflict on version 1, chooses Keep mine.
    const [a, b] = await Promise.all([
      patch(`/notes/${note.id}`, { content: 'A newer', baseVersion: 2 }),
      patch(`/notes/${note.id}`, { content: 'B text', baseVersion: 1, force: true }),
    ]);
    expect(b.status).toBe(200);
    expect((await get(`/notes/${note.id}`)).body.content).toBe('B text');
    // Whichever order they land in, the text Keep mine replaced is in history. (When A lands first, its
    // "A newer" replaced its own "A text" within the snapshot interval, which keeps no snapshot by design.)
    const kept = ['B text', ...(await history(note.id))];
    const saved = a.status === 200 ? ['original', 'A newer'] : ['original', 'A text'];
    expect(saved.filter((text) => !kept.includes(text))).toEqual([]);
  });

  it('keeps another device’s new tags when this one saves a new title of an encrypted note', async () => {
    await turnOnEncryption();
    const note = await encNote({ kgen: 0 });
    const tags = cipher(8);
    const title = cipher(16);
    // Tags don't move the version, so the title save isn't refused, whichever lands first.
    const [a, b] = await Promise.all([
      patch(`/notes/${note.id}`, { enc: true, kgen: 0, sealed: { g: tags } }),
      patch(`/notes/${note.id}`, { enc: true, kgen: 0, sealed: { t: title }, baseVersion: 1 }),
    ]);
    expect([a.status, b.status]).toEqual([200, 200]);
    const stored = JSON.parse((await env.DB.prepare('SELECT sealed FROM notes WHERE id = ?').bind(note.id).first<{ sealed: string }>())!.sealed);
    expect(stored).toMatchObject({ g: tags, t: title });
  });

  it('keeps the replaced text when a forced save sends no base version', async () => {
    const note = await newNote({ content: 'one' });
    await patch(`/notes/${note.id}`, { content: 'two' });
    await patch(`/notes/${note.id}`, { content: 'mine', force: true });
    expect(await history(note.id)).toEqual(['two', 'one']);
  });

  it('lets exactly one of two simultaneous saves to an encrypted note through, and answers the other with the ciphertext', async () => {
    await turnOnEncryption();
    const note = await encNote();
    const contents = [cipher(), cipher(), cipher()];
    const results = await Promise.all(contents.map((content) => patch(`/notes/${note.id}`, { enc: true, content, baseVersion: 1 })));
    expect(results.map((r) => r.status).sort()).toEqual([200, 409, 409]);
    const conflict = results.find((r) => r.status === 409)!.body.note;
    const winner = contents[results.findIndex((r) => r.status === 200)];
    expect(conflict).toMatchObject({ id: note.id, enc: true, content: winner, version: 2, title: '', tags: [] });
    expect(Object.keys(conflict.sealed).sort()).toEqual(['g', 'p', 't']);
  });
});

describe('trash and deleting for good', () => {
  it('restores a note into its folder when the folder is still there', async () => {
    const folder = await newFolder();
    const note = await newNote({ folder_id: folder.id });
    await post(`/notes/${note.id}/trash`);
    expect((await post(`/notes/${note.id}/restore`)).body).toMatchObject({ deleted_at: null, folder_id: folder.id });
  });

  it('deletes a note in the trash for good, with its history, so it can’t come back', async () => {
    const note = await newNote({ content: 'one' });
    await patch(`/notes/${note.id}`, { content: 'two' });
    await post(`/notes/${note.id}/trash`);
    expect((await del(`/notes/${note.id}?ifVersion=2`)).body).toEqual({ ok: true, deleted: true });
    expect((await post(`/notes/${note.id}/restore`)).status).toBe(404);
    expect((await post(`/notes/${note.id}/trash`)).status).toBe(404);
    expect((await patch(`/notes/${note.id}`, { content: 'three' })).status).toBe(404);
    expect(await count('SELECT COUNT(*) AS n FROM note_versions WHERE note_id = ?', note.id)).toBe(0);
    expect((await del(`/notes/${note.id}`)).body).toEqual({ ok: true, deleted: false });
  });

  it('empties the trash along with the history of what was in it, and only that', async () => {
    const kept = await newNote({ content: 'kept one' });
    await patch(`/notes/${kept.id}`, { content: 'kept two' });
    const gone = await newNote({ content: 'gone one' });
    await patch(`/notes/${gone.id}`, { content: 'gone two' });
    await post(`/notes/${gone.id}/trash`);
    expect((await post('/trash/empty')).body).toEqual({ ok: true, deleted: 1 });
    expect(await history(kept.id)).toEqual(['kept one']);
    expect(await count('SELECT COUNT(*) AS n FROM note_versions WHERE note_id = ?', gone.id)).toBe(0);
    expect((await post('/trash/empty')).body).toEqual({ ok: true, deleted: 0 });
  });

  it('sends the notes of a whole folder tree to the trash with their history, ready to restore', async () => {
    const top = await newFolder('Top');
    const mid = await newFolder('Mid', { parent_id: top.id });
    const leaf = await newFolder('Leaf', { parent_id: mid.id });
    const deep = await newNote({ content: 'deep one', folder_id: leaf.id });
    await patch(`/notes/${deep.id}`, { content: 'deep two' });
    const shallow = await newNote({ folder_id: top.id });
    expect((await del(`/folders/${top.id}`)).body).toEqual({ ok: true, trashed: 2 });
    expect(await count('SELECT COUNT(*) AS n FROM folders')).toBe(0);
    expect(await history(deep.id)).toEqual(['deep one']);
    for (const n of [deep, shallow]) {
      expect((await post(`/notes/${n.id}/restore`)).body).toMatchObject({ deleted_at: null, folder_id: null });
    }
  });

  it('deletes a folder that is already gone without touching anything', async () => {
    const note = await newNote();
    expect((await del('/folders/neverexisted')).body).toEqual({ ok: true, trashed: 0 });
    expect((await get(`/notes/${note.id}`)).body.deleted_at).toBeNull();
  });

  it('lets a note in the trash be moved and pinned, and it stays in the trash', async () => {
    const folder = await newFolder();
    const note = await newNote();
    const trashed = (await post(`/notes/${note.id}/trash`)).body;
    const moved = await patch(`/notes/${note.id}`, { folder_id: folder.id, pinned: true });
    expect(moved.body).toMatchObject({ folder_id: folder.id, pinned: true, deleted_at: trashed.deleted_at });
  });

  it('keeps an encrypted note’s history encrypted when a backup is restored over it', async () => {
    await turnOnEncryption();
    const sealed = sealedFields();
    const old = cipher(80);
    const note = await encNote({ content: old, sealed });
    const restored = await post('/notes', { id: note.id, enc: true, restore: true, content: cipher(), sealed: sealedFields(), created_at: 1, updated_at: 2 });
    expect(restored.body).toMatchObject({ version: 2, created_at: 1, updated_at: 2, enc: true });
    const v = await row<{ enc: number; title: string; content: string; sealed: string; kgen: number }>(
      'SELECT enc, title, content, sealed, kgen FROM note_versions WHERE note_id = ?',
      note.id,
    );
    expect(v).toMatchObject({ enc: 1, title: '', content: old, kgen: 0 });
    expect(JSON.parse(v!.sealed)).toEqual({ t: sealed.t });
  });
});

describe('folders', () => {
  it('refuses to put a folder anywhere inside itself, however deep', async () => {
    const a = await newFolder('A');
    const b = await newFolder('B', { parent_id: a.id });
    const c = await newFolder('C', { parent_id: b.id });
    const d = await newFolder('D', { parent_id: c.id });
    for (const target of [b, c, d]) {
      const res = await patch(`/folders/${a.id}`, { parent_id: target.id });
      expect([res.status, res.body.error]).toEqual([400, 'cycle']);
    }
    expect(await row('SELECT parent_id FROM folders WHERE id = ?', a.id)).toEqual({ parent_id: null });
    // Moving within the tree in the other direction is fine.
    expect((await patch(`/folders/${d.id}`, { parent_id: a.id })).body.parent_id).toBe(a.id);
  });

  it('applies nothing from a move it refused, not even the rename sent with it', async () => {
    const a = await newFolder('A');
    const b = await newFolder('B', { parent_id: a.id });
    expect((await patch(`/folders/${a.id}`, { name: 'Renamed', parent_id: b.id, sort: 9 })).status).toBe(400);
    expect(await row('SELECT name, sort, parent_id FROM folders WHERE id = ?', a.id)).toEqual({ name: 'A', sort: 0, parent_id: null });
  });

  it('answers a move of a folder deleted elsewhere as not found', async () => {
    const target = await newFolder();
    const res = await patch('/folders/deletedfolder', { parent_id: target.id });
    expect([res.status, res.body.error]).toEqual([404, 'not_found']);
  });

  it('refuses parents that aren’t folder ids', async () => {
    const f = await newFolder();
    for (const parent_id of [5, 'bad id', '', ['x'], { id: 'abcdefgh' }]) {
      const res = await patch(`/folders/${f.id}`, { parent_id });
      expect([res.status, res.body.error], JSON.stringify(parent_id)).toEqual([400, 'bad_parent']);
    }
  });

  it('keeps sort order and name apart: a reorder doesn’t rename and a rename doesn’t reorder', async () => {
    const f = await newFolder('Name', { sort: 4 });
    expect((await patch(`/folders/${f.id}`, { sort: 1 })).body).toMatchObject({ name: 'Name', sort: 1 });
    expect((await patch(`/folders/${f.id}`, { name: 'Other' })).body).toMatchObject({ name: 'Other', sort: 1 });
    expect((await patch(`/folders/${f.id}`, { sort: '2' })).status).toBe(400);
  });

  it('files a note created in a folder deleted at the same moment under no folder', async () => {
    const folder = await newFolder();
    const id = testId();
    await Promise.all([del(`/folders/${folder.id}`), post('/notes', { id, title: 'Racing', folder_id: folder.id })]);
    // Whichever came first, the note never points at a folder that doesn't exist.
    expect(await row('SELECT folder_id FROM notes WHERE id = ?', id)).toEqual({ folder_id: null });
  });
});

describe('history', () => {
  it('lists a note’s snapshots newest first, with their size but not their text', async () => {
    const note = await newNote({ title: 'T', content: 'first text' });
    await patch(`/notes/${note.id}`, { content: 'second text, longer' });
    await patch(`/notes/${note.id}`, { content: 'third', snapshot: true });
    const { versions } = (await get(`/notes/${note.id}/versions`)).body;
    expect(versions).toHaveLength(2);
    expect(versions[0]).toEqual({ id: expect.any(Number), title: 'T', enc: false, sealed: {}, size: 'second text, longer'.length, created_at: expect.any(Number) });
    expect(versions[0].created_at).toBeGreaterThanOrEqual(versions[1].created_at);
    expect(await history(note.id)).toEqual(['second text, longer', 'first text']);
  });

  it('says which note a snapshot belongs to, so a device can check it got the one it asked for', async () => {
    const note = await newNote({ content: 'one' });
    await patch(`/notes/${note.id}`, { content: 'two' });
    const [v] = (await get(`/notes/${note.id}/versions`)).body.versions;
    expect((await get(`/versions/${v.id}`)).body).toMatchObject({ id: v.id, note_id: note.id, content: 'one', enc: false });
  });

  it('has none for a note that doesn’t exist', async () => {
    expect((await get('/notes/missingnote1/versions')).body).toEqual({ versions: [] });
  });

  it('snapshots an empty encrypted note never, and a non-empty one with its sealed title', async () => {
    await turnOnEncryption();
    const empty = await encNote({ content: `e1:${'A'.repeat(38)}` });
    await patch(`/notes/${empty.id}`, { enc: true, content: cipher(), snapshot: true });
    expect(await count('SELECT COUNT(*) AS n FROM note_versions WHERE note_id = ?', empty.id)).toBe(0);
    await patch(`/notes/${empty.id}`, { enc: true, content: cipher(), snapshot: true });
    expect(await count('SELECT COUNT(*) AS n FROM note_versions WHERE note_id = ?', empty.id)).toBe(1);
  });

  it('never deletes another note’s history when a note is deleted', async () => {
    const a = await newNote({ content: 'a1' });
    await patch(`/notes/${a.id}`, { content: 'a2' });
    const b = await newNote({ content: 'b1' });
    await patch(`/notes/${b.id}`, { content: 'b2' });
    await del(`/notes/${b.id}`);
    expect(await history(a.id)).toEqual(['a1']);
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM note_versions').first('n')).toBe(1);
  });
});
