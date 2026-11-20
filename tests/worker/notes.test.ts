/** Notes: creating, reading, saving with conflict detection, history snapshots, trash, limits, export. */
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { del, get, newFolder, newNote, patch, post, testId } from './helpers';

const BIG = 1_800_000;

describe('creating and reading notes', () => {
  it('cleans the title and tags and derives the list preview', async () => {
    const note = await newNote({
      title: '  Line one\nline two\t ',
      content: '# Heading\n\n- [x] done\n- [ ] todo\n\n![pic](/api/files/abcdefgh/p.png)\n\n```mermaid\ngraph TD\n```\n\nSome **bold** words.',
      tags: ['#Work', 'work', 'two words', '', 7, 'x'.repeat(80)],
    });
    expect(note.title).toBe('Line one line two');
    expect(note.tags).toEqual(['Work', 'two-words', 'x'.repeat(60)]);
    expect(note.version).toBe(1);
    expect(note.excerpt).toBe('Heading done todo Some bold words.');
    expect(note.info).toMatchObject({ th: '/api/files/abcdefgh/p.png', t: [1, 2], d: 1 });
    expect(note.title.length).toBeLessThanOrEqual(300);
  });

  it('caps titles at 300 characters', async () => {
    const note = await newNote({ title: 'y'.repeat(1000) });
    expect(note.title).toHaveLength(300);
  });

  it('uses an id the app chose, and refuses a duplicate', async () => {
    const id = testId();
    expect((await post('/notes', { id, title: 'A' })).status).toBe(201);
    const again = await post('/notes', { id, title: 'B' });
    expect(again.status).toBe(409);
    expect(again.body.error).toBe('exists');
    expect((await get(`/notes/${id}`)).body.title).toBe('A');
  });

  it('files a note under no folder when its folder is gone', async () => {
    const note = await newNote({ folder_id: 'missingfolder' });
    expect(note.folder_id).toBeNull();
    const folder = await newFolder('Real');
    expect((await newNote({ folder_id: folder.id })).folder_id).toBe(folder.id);
  });

  it('validates ids in paths', async () => {
    expect((await get('/notes/abc')).status).toBe(400);
    expect((await get('/notes/has%20space')).status).toBe(400);
    expect((await get('/notes/doesnotexist1')).status).toBe(404);
    expect((await post('/notes', { id: '../../etc' })).status).toBe(400);
  });

  it('refuses notes over the size limit', async () => {
    expect((await post('/notes', { content: 'a'.repeat(BIG + 1) })).status).toBe(413);
    // Multi-byte text is measured in bytes, not characters.
    expect((await post('/notes', { content: 'é'.repeat(BIG / 2 + 1) })).status).toBe(413);
    expect((await post('/notes', { content: 'a'.repeat(BIG) })).status).toBe(201);
  });
});

describe('saving', () => {
  it('bumps the version and updated time when the text changes', async () => {
    const note = await newNote();
    const res = await patch(`/notes/${note.id}`, { content: 'New body with [link](https://x.test)', baseVersion: 1 });
    expect(res.status).toBe(200);
    expect(res.body.version).toBe(2);
    expect(res.body.updated_at).toBeGreaterThanOrEqual(note.updated_at);
    expect(res.body.excerpt).toBe('New body with link');
  });

  it('treats tag, pin and folder changes as not changing the text', async () => {
    const note = await newNote();
    const folder = await newFolder();
    const tags = await patch(`/notes/${note.id}`, { tags: ['a'] });
    expect(tags.body.version).toBe(1);
    expect(tags.body.tags).toEqual(['a']);
    const pinned = await patch(`/notes/${note.id}`, { pinned: true, folder_id: folder.id });
    expect(pinned.body).toMatchObject({ version: 1, pinned: true, folder_id: folder.id, updated_at: tags.body.updated_at });
    // With a stale base version, a change that isn't to the text still applies.
    expect((await patch(`/notes/${note.id}`, { pinned: false, baseVersion: 0 })).status).toBe(200);
  });

  it('answers a save based on an old version with a conflict and the current note', async () => {
    const note = await newNote({ content: 'original' });
    await patch(`/notes/${note.id}`, { content: 'from device A', baseVersion: 1 });
    const stale = await patch(`/notes/${note.id}`, { content: 'from device B', baseVersion: 1 });
    expect(stale.status).toBe(409);
    expect(stale.body.error).toBe('conflict');
    expect(stale.body.note).toMatchObject({ content: 'from device A', version: 2 });
    const forced = await patch(`/notes/${note.id}`, { content: 'from device B', baseVersion: 1, force: true });
    expect(forced.status).toBe(200);
    expect(forced.body.version).toBe(3);
  });

  it('keeps the text a forced save ("Keep mine") replaces in history, however recent the last snapshot', async () => {
    const note = await newNote({ content: 'original' });
    await patch(`/notes/${note.id}`, { content: 'from device A', baseVersion: 1 });
    await patch(`/notes/${note.id}`, { content: 'A again', baseVersion: 2 });
    await patch(`/notes/${note.id}`, { content: 'from device B', baseVersion: 1, force: true });
    const versions = (await get(`/notes/${note.id}/versions`)).body.versions;
    const texts = await Promise.all(versions.map(async (v: { id: number }) => (await get(`/versions/${v.id}`)).body.content));
    expect(texts).toContain('A again');
  });

  it('remembers the ids of the last saves that changed the text, and lists them (with its clock) in a conflict', async () => {
    const note = await newNote({ content: 'original' });
    await patch(`/notes/${note.id}`, { content: 'from the phone', baseVersion: 1, saveId: 'phone-save-1' });
    // Not a change to the text, and an id that isn't one: neither is listed.
    await patch(`/notes/${note.id}`, { pinned: true, saveId: 'pin-save-01' });
    await patch(`/notes/${note.id}`, { content: 'from the computer', baseVersion: 2, saveId: 'bad id!' });
    await patch(`/notes/${note.id}`, { content: 'from the computer, more', baseVersion: 3, saveId: 'computer-save-1' });
    const before = Date.now();
    const stale = await patch(`/notes/${note.id}`, { content: 'from the phone again', baseVersion: 1, saveId: 'phone-save-2' });
    expect(stale.status).toBe(409);
    expect(stale.body.saves).toEqual(['phone-save-1', 'computer-save-1']);
    expect(stale.body.now).toBeGreaterThanOrEqual(before);
    expect(stale.body.note).toMatchObject({ content: 'from the computer, more', version: 4 });
    // Never part of the note itself, or the list.
    expect(stale.body.note.saves).toBeUndefined();
    expect((await get(`/notes/${note.id}`)).body.saves).toBeUndefined();
    expect((await get('/bootstrap')).body.notes.find((n: { id: string }) => n.id === note.id).saves).toBeUndefined();
  });

  it('keeps only the last 16 save ids, and forgets them when a backup is restored over the note', async () => {
    const note = await newNote({ content: 'v1' });
    for (let v = 1; v <= 20; v++) await patch(`/notes/${note.id}`, { content: `v${v + 1}`, baseVersion: v, saveId: `save-${String(v).padStart(3, '0')}` });
    const stale = await patch(`/notes/${note.id}`, { content: 'late', baseVersion: 1 });
    expect(stale.body.saves).toHaveLength(16);
    expect(stale.body.saves[0]).toBe('save-005');
    expect(stale.body.saves.at(-1)).toBe('save-020');
    await post('/notes', { id: note.id, title: 'Note', content: 'from a backup', restore: true });
    expect((await patch(`/notes/${note.id}`, { content: 'late', baseVersion: 1 })).body.saves).toEqual([]);
  });

  it('lets exactly one of two simultaneous saves through', async () => {
    const note = await newNote({ content: 'start' });
    const results = await Promise.all(
      ['one', 'two', 'three'].map((content) => patch(`/notes/${note.id}`, { content, baseVersion: 1 })),
    );
    expect(results.map((r) => r.status).sort()).toEqual([200, 409, 409]);
    expect((await get(`/notes/${note.id}`)).body.version).toBe(2);
  });

  it('returns the note unchanged when nothing changed', async () => {
    const note = await newNote({ content: 'same' });
    const res = await patch(`/notes/${note.id}`, { content: 'same', title: 'Note' });
    expect(res.status).toBe(200);
    expect(res.body.version).toBe(1);
  });

  it('refuses moving a note into a folder deleted elsewhere', async () => {
    const note = await newNote();
    const res = await patch(`/notes/${note.id}`, { folder_id: 'gonefolder1' });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('folder_missing');
    expect((await patch(`/notes/${note.id}`, { folder_id: 'bad id!' })).status).toBe(400);
    expect((await patch(`/notes/${note.id}`, { folder_id: null })).status).toBe(200);
  });

  it('refuses an oversized save', async () => {
    const note = await newNote();
    expect((await patch(`/notes/${note.id}`, { content: 'a'.repeat(BIG + 1) })).status).toBe(413);
  });

  it('404s for a note deleted elsewhere', async () => {
    expect((await patch('/notes/neverexisted', { content: 'x' })).status).toBe(404);
  });
});

describe('version history', () => {
  it('snapshots the previous text at most every 10 minutes, or when asked', async () => {
    const note = await newNote({ title: 'T', content: 'v1' });
    await patch(`/notes/${note.id}`, { content: 'v2' });
    await patch(`/notes/${note.id}`, { content: 'v3' });
    let versions = (await get(`/notes/${note.id}/versions`)).body.versions;
    expect(versions).toHaveLength(1);
    await patch(`/notes/${note.id}`, { content: 'v4', snapshot: true });
    versions = (await get(`/notes/${note.id}/versions`)).body.versions;
    expect(versions).toHaveLength(2);
    const contents = await Promise.all(versions.map(async (v: { id: number }) => (await get(`/versions/${v.id}`)).body.content));
    expect(contents.sort()).toEqual(['v1', 'v3']);
  });

  it('never snapshots an empty note', async () => {
    const note = await newNote({ content: '   ' });
    await patch(`/notes/${note.id}`, { content: 'first words' });
    expect((await get(`/notes/${note.id}/versions`)).body.versions).toHaveLength(0);
  });

  it('keeps the newest 50 snapshots per note', async () => {
    const note = await newNote({ content: 'v0' });
    for (let i = 1; i <= 55; i++) await patch(`/notes/${note.id}`, { content: `v${i}`, snapshot: true });
    const versions = (await get(`/notes/${note.id}/versions`)).body.versions;
    expect(versions).toHaveLength(50);
    const oldest = await get(`/versions/${versions[versions.length - 1].id}`);
    expect(oldest.body.content).toBe('v5');
  });

  it('validates version ids', async () => {
    expect((await get('/versions/abc')).status).toBe(400);
    expect((await get('/versions/0')).status).toBe(400);
    expect((await get('/versions/999999')).status).toBe(404);
  });
});

describe('keeping a device’s older edits in history', () => {
  it('adds them as a version, at the time they were made, without changing the note', async () => {
    const note = await newNote({ title: 'Plan', content: 'current text' });
    const made = Date.now() - 3_600_000;
    const res = await post(`/notes/${note.id}/versions`, { title: '  Plan from the phone ', content: 'older text from the phone', at: made });
    expect(res.status).toBe(201);
    const versions = (await get(`/notes/${note.id}/versions`)).body.versions;
    expect(versions).toEqual([expect.objectContaining({ id: res.body.id, title: 'Plan from the phone', created_at: made })]);
    expect((await get(`/versions/${res.body.id}`)).body).toMatchObject({ note_id: note.id, content: 'older text from the phone' });
    expect((await get(`/notes/${note.id}`)).body).toMatchObject({ content: 'current text', version: 1 });
  });

  it('dates them no later than now, and no earlier than a year ago', async () => {
    const note = await newNote();
    const future = await post(`/notes/${note.id}/versions`, { title: 'x', content: 'x', at: Date.now() + 86_400_000 });
    const ancient = await post(`/notes/${note.id}/versions`, { title: 'x', content: 'x', at: 0 });
    const byId = new Map(((await get(`/notes/${note.id}/versions`)).body.versions as Array<{ id: number; created_at: number }>).map((v) => [v.id, v.created_at]));
    expect(byId.get(future.body.id)).toBeLessThanOrEqual(Date.now());
    expect(byId.get(ancient.body.id)).toBeGreaterThan(Date.now() - 366 * 86_400_000);
  });

  it('keeps the newest 50 versions, refuses one too large, and 404s for a note that’s gone', async () => {
    const note = await newNote();
    for (let i = 0; i < 52; i++) await post(`/notes/${note.id}/versions`, { title: 't', content: `kept ${i}` });
    const versions = (await get(`/notes/${note.id}/versions`)).body.versions;
    expect(versions).toHaveLength(50);
    expect((await post(`/notes/${note.id}/versions`, { title: 't', content: 'x'.repeat(BIG + 1) })).status).toBe(413);
    expect((await post(`/notes/${testId()}/versions`, { title: 't', content: 'x' })).status).toBe(404);
  });
});

describe('trash', () => {
  it('trashes and restores, and a restored note whose folder is gone goes to no folder', async () => {
    const folder = await newFolder();
    const note = await newNote({ folder_id: folder.id });
    const trashed = await post(`/notes/${note.id}/trash`);
    expect(trashed.body.deleted_at).toEqual(expect.any(Number));
    await del(`/folders/${folder.id}`);
    const restored = await post(`/notes/${note.id}/restore`);
    expect(restored.body).toMatchObject({ deleted_at: null, folder_id: null });
  });

  it('deletes forever, with history', async () => {
    const note = await newNote({ content: 'a' });
    await patch(`/notes/${note.id}`, { content: 'b' });
    expect((await del(`/notes/${note.id}`)).status).toBe(200);
    expect((await get(`/notes/${note.id}`)).status).toBe(404);
    const left = await env.DB.prepare('SELECT COUNT(*) AS n FROM note_versions WHERE note_id = ?').bind(note.id).first<{ n: number }>();
    expect(left?.n).toBe(0);
  });

  it('deletes an empty note only if no other device has saved into it since', async () => {
    const note = await newNote({ title: '', content: '' });
    await patch(`/notes/${note.id}`, { content: 'typed on the phone' });
    const stale = await del(`/notes/${note.id}?ifVersion=1`);
    expect(stale.body).toEqual({ ok: true, deleted: false });
    expect((await get(`/notes/${note.id}`)).body.content).toBe('typed on the phone');
    const fresh = await newNote({ title: '', content: '' });
    expect((await del(`/notes/${fresh.id}?ifVersion=1`)).body).toEqual({ ok: true, deleted: true });
    expect((await get(`/notes/${fresh.id}`)).status).toBe(404);
    expect((await del(`/notes/${fresh.id}?ifVersion=abc`)).status).toBe(400);
  });

  it('keeps a note’s history when a conditional delete is refused', async () => {
    const note = await newNote({ content: 'a' });
    await patch(`/notes/${note.id}`, { content: 'b' });
    await del(`/notes/${note.id}?ifVersion=1`);
    expect((await get(`/notes/${note.id}/versions`)).body.versions).toHaveLength(1);
  });

  it('empties only the trash', async () => {
    const keep = await newNote();
    const gone = await newNote();
    await post(`/notes/${gone.id}/trash`);
    const res = await post('/trash/empty');
    expect(res.body.deleted).toBe(1);
    expect((await get(`/notes/${keep.id}`)).status).toBe(200);
    expect((await get(`/notes/${gone.id}`)).status).toBe(404);
  });
});

describe('restoring from a backup', () => {
  it('keeps the original dates and replaces a note with the same id', async () => {
    const id = testId();
    const first = await post('/notes', { id, title: 'Old', content: 'x', restore: true, created_at: 1000, updated_at: 2000 });
    expect(first.body).toMatchObject({ created_at: 1000, updated_at: 2000 });
    const again = await post('/notes', { id, title: 'New', content: 'y', restore: true, created_at: 1000, updated_at: 3000, deleted_at: 4000 });
    expect(again.status).toBe(201);
    expect(again.body).toMatchObject({ title: 'New', updated_at: 3000, deleted_at: 4000, version: 2 });
  });

  it('keeps the newer text in history when an older backup is restored over it', async () => {
    const id = testId();
    await post('/notes', { id, title: 'T', content: 'written after the backup' });
    await post('/notes', { id, title: 'T', content: 'from the backup', restore: true, created_at: 1, updated_at: 2 });
    const versions = (await get(`/notes/${id}/versions`)).body.versions;
    expect(versions).toHaveLength(1);
    expect((await get(`/versions/${versions[0].id}`)).body.content).toBe('written after the backup');
    // Restoring the same text again adds nothing.
    await post('/notes', { id, title: 'T', content: 'from the backup', restore: true, created_at: 1, updated_at: 2 });
    expect((await get(`/notes/${id}/versions`)).body.versions).toHaveLength(1);
  });

  it('ignores backup dates outside a restore', async () => {
    const note = await newNote({ created_at: 5, updated_at: 5, deleted_at: 5 });
    expect(note.created_at).toBeGreaterThan(5);
    expect(note.deleted_at).toBeNull();
  });
});

describe('library-wide reads', () => {
  it('bootstraps folders, every note (trashed too) and the encryption state', async () => {
    await newFolder('B');
    await newFolder('a', { sort: 0 });
    const trashed = await newNote();
    await post(`/notes/${trashed.id}/trash`);
    const res = await get('/bootstrap');
    expect(res.status).toBe(200);
    expect(res.body.encryption).toEqual({ on: false, pending: null });
    expect(res.body.notes.some((n: { id: string; deleted_at: number | null }) => n.id === trashed.id && n.deleted_at)).toBe(true);
    expect(res.body.notes[0]).not.toHaveProperty('content');
    expect(res.body.folders.map((f: { name: string }) => f.name).slice(0, 2)).toEqual(['a', 'B']);
    expect(typeof res.body.serverTime).toBe('number');
  });

  it('remembers when a backup was last made, for every device', async () => {
    expect((await get('/bootstrap')).body.lastBackup).toBeNull();
    const before = Date.now();
    const made = await post('/backups/made');
    expect(made.status).toBe(200);
    expect(made.body.at).toBeGreaterThanOrEqual(before);
    expect((await get('/bootstrap')).body.lastBackup).toBe(made.body.at);
    expect((await post('/backups/made', {}, { noClientHeader: true })).status).toBe(403);
  });

  it('reads the note list from its index, never from the note bodies', async () => {
    await get('/bootstrap');
    const { META_COLUMNS } = await import('../../worker/util');
    const plan = await env.DB.prepare(`EXPLAIN QUERY PLAN SELECT ${META_COLUMNS} FROM notes`).all<{ detail: string }>();
    expect(plan.results.map((r) => r.detail).join(' | ')).toMatch(/COVERING INDEX notes_list_idx/);
  });

  it('counts notes, files and drawings', async () => {
    await newNote({ content: '12345' });
    const res = await get('/stats');
    expect(res.body.notes.active).toBeGreaterThanOrEqual(1);
    expect(res.body.storage).toBe('kv');
  });

  it('exports every note a page at a time', async () => {
    for (let i = 0; i < 5; i++) await newNote({ title: `Export ${i}` });
    const seen = new Set<string>();
    let after = 0;
    for (let page = 0; page < 50; page++) {
      const res = await get(`/export/notes?after=${after}&limit=2`);
      for (const n of res.body.notes) {
        expect(n).toHaveProperty('content');
        seen.add(n.id);
      }
      if (res.body.next === null) break;
      after = res.body.next;
    }
    const total = await env.DB.prepare('SELECT COUNT(*) AS n FROM notes').first<{ n: number }>();
    expect(seen.size).toBe(total?.n);
  });

  it('sends the notes asked for, with their text, for the copy each device keeps', async () => {
    const a = await newNote({ title: 'Batch A', content: 'alpha' });
    const b = await newNote({ title: 'Batch B', content: 'beta' });
    const res = await post('/notes/batch', { ids: [a.id, b.id, a.id, 'nope!', 'missing123'] });
    expect(res.status).toBe(200);
    const byId = new Map(res.body.notes.map((n: { id: string }) => [n.id, n]));
    expect(byId.size).toBe(2);
    expect(byId.get(a.id)).toMatchObject({ title: 'Batch A', content: 'alpha', version: 1 });
    expect(byId.get(b.id)).toMatchObject({ content: 'beta' });
  });

  it('asks for between 1 and 90 ids', async () => {
    expect((await post('/notes/batch', { ids: [] })).status).toBe(400);
    const many = Array.from({ length: 91 }, (_, i) => `id${String(i).padStart(6, '0')}`);
    expect((await post('/notes/batch', { ids: many })).status).toBe(400);
    expect((await post('/notes/batch', { ids: [] }, { noClientHeader: true })).status).toBe(403);
  });
});
