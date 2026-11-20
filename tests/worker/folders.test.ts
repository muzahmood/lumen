/** Folders: create, rename, nest, move without cycles, and delete with everything inside. */
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { del, get, newFolder, newNote, patch, post, testId } from './helpers';

/** Walks parent links from `id`; true if they loop. */
async function hasCycle(id: string) {
  const seen = new Set<string>();
  let cur: string | null = id;
  while (cur) {
    if (seen.has(cur)) return true;
    seen.add(cur);
    const row: { parent_id: string | null } | null = await env.DB.prepare('SELECT parent_id FROM folders WHERE id = ?').bind(cur).first();
    cur = row?.parent_id ?? null;
  }
  return false;
}

describe('folders', () => {
  it('creates, renames and nests', async () => {
    const parent = await newFolder('  Projects \n');
    expect(parent.name).toBe('Projects');
    const child = await newFolder('Child', { parent_id: parent.id });
    expect(child.parent_id).toBe(parent.id);
    const renamed = await patch(`/folders/${child.id}`, { name: 'Renamed' });
    expect(renamed.body.name).toBe('Renamed');
    expect((await patch(`/folders/${child.id}`, { parent_id: null })).body.parent_id).toBeNull();
  });

  it('requires a name and a valid id', async () => {
    expect((await post('/folders', { name: '   ' })).status).toBe(400);
    expect((await post('/folders', { name: 'x', id: 'bad id' })).status).toBe(400);
    const f = await newFolder();
    expect((await patch(`/folders/${f.id}`, { name: '' })).status).toBe(400);
    expect((await patch(`/folders/${f.id}`, {})).status).toBe(400);
    expect((await patch('/folders/missingfolder', { name: 'x' })).status).toBe(404);
  });

  it('refuses to put a folder inside itself or its own subfolder', async () => {
    const a = await newFolder('A');
    const b = await newFolder('B', { parent_id: a.id });
    const c = await newFolder('C', { parent_id: b.id });
    expect((await patch(`/folders/${a.id}`, { parent_id: a.id })).status).toBe(400);
    expect((await patch(`/folders/${a.id}`, { parent_id: c.id })).status).toBe(400);
    expect(await hasCycle(a.id)).toBe(false);
  });

  it('never forms a loop when two devices move folders into each other at once', async () => {
    const a = await newFolder('A');
    const b = await newFolder('B');
    const [one, two] = await Promise.all([
      patch(`/folders/${a.id}`, { parent_id: b.id }),
      patch(`/folders/${b.id}`, { parent_id: a.id }),
    ]);
    expect([one.status, two.status].sort()).toEqual([200, 400]);
    expect(await hasCycle(a.id)).toBe(false);
  });

  it('never forms a loop through a create that reuses an existing id', async () => {
    const a = await newFolder('A');
    const b = await newFolder('B', { parent_id: a.id });
    const res = await post('/folders', { id: a.id, name: 'A again', parent_id: b.id });
    expect(res.status).toBe(400);
    expect(await hasCycle(a.id)).toBe(false);
  });

  it('deletes a folder with its subfolders, sending their notes to the trash', async () => {
    const a = await newFolder('A');
    const b = await newFolder('B', { parent_id: a.id });
    const other = await newFolder('Other');
    const inA = await newNote({ folder_id: a.id });
    const inB = await newNote({ folder_id: b.id });
    const outside = await newNote({ folder_id: other.id });
    const res = await del(`/folders/${a.id}`);
    expect(res.body).toEqual({ ok: true, trashed: 2 });
    for (const n of [inA, inB]) {
      const back = await get(`/notes/${n.id}`);
      expect(back.body.folder_id).toBeNull();
      expect(back.body.deleted_at).toEqual(expect.any(Number));
    }
    expect((await get(`/notes/${outside.id}`)).body.deleted_at).toBeNull();
    const folders = (await get('/bootstrap')).body.folders.map((f: { id: string }) => f.id);
    expect(folders).not.toContain(a.id);
    expect(folders).not.toContain(b.id);
    expect(folders).toContain(other.id);
  });

  it('keeps the first trash date of a note already in the trash when its folder goes', async () => {
    const a = await newFolder('A');
    const n = await newNote({ folder_id: a.id });
    const first = (await post(`/notes/${n.id}/trash`)).body.deleted_at;
    await del(`/folders/${a.id}`);
    expect((await get(`/notes/${n.id}`)).body.deleted_at).toBe(first);
  });

  it('can still delete folders that already loop (data from before the guard)', async () => {
    const x = testId('f');
    const y = testId('f');
    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare('INSERT INTO folders (id, parent_id, name, sort, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?)').bind(x, y, 'X', now, now),
      env.DB.prepare('INSERT INTO folders (id, parent_id, name, sort, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?)').bind(y, x, 'Y', now, now),
    ]);
    const res = await del(`/folders/${x}`);
    expect(res.status).toBe(200);
    const left = await env.DB.prepare('SELECT COUNT(*) AS n FROM folders WHERE id IN (?, ?)').bind(x, y).first<{ n: number }>();
    expect(left?.n).toBe(0);
  });
});
