/**
 * The nightly clean-up (worker/index.ts, scheduled) beyond cron.test.ts: it may be the very first
 * thing to touch a new database, so it sets up the schema itself; and it purges encrypted notes the
 * same way, without touching the search index or anything that isn't an old trashed note.
 */
import { createExecutionContext, createScheduledController, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import worker from '../../worker/index';
import { count, encNote } from './api-helpers';
import { get, newNote, patch, post, resetLibrary, turnOnEncryption } from './helpers';

const DAY = 24 * 60 * 60 * 1000;

async function runCron() {
  const ctx = createExecutionContext();
  await worker.scheduled(createScheduledController({ scheduledTime: Date.now(), cron: '17 3 * * *' }), env, ctx);
  await waitOnExecutionContext(ctx);
}

const trashedDaysAgo = (id: string, days: number) => env.DB.prepare('UPDATE notes SET deleted_at = ? WHERE id = ?').bind(Date.now() - days * DAY, id).run();

describe('the nightly clean-up', () => {
  // Must stay first: nothing in this file has touched the database before it.
  it('sets up the schema when it’s the first thing to run on a new database', async () => {
    await runCron();
    const version = await env.DB.prepare(`SELECT value FROM kb_meta WHERE key = 'schema_version'`).first<{ value: string }>();
    expect(version?.value).toBe('7');
    expect(await count('SELECT COUNT(*) AS n FROM notes')).toBe(0);
  });

  it('purges old trashed plaintext notes from the search index too, and keeps the rest searchable', async () => {
    await resetLibrary();
    const old = await newNote({ title: 'Quarry', content: 'granite blocks' });
    const kept = await newNote({ title: 'Garden', content: 'granite path' });
    await post(`/notes/${old.id}/trash`);
    await trashedDaysAgo(old.id, 45);
    await runCron();
    expect((await get('/search?q=granite')).body.results.map((r: { id: string }) => r.id)).toEqual([kept.id]);
    expect((await get(`/notes/${old.id}`)).status).toBe(404);
  });

  it('purges old trashed encrypted notes with their history, and leaves files and drawings for the file clean-up', async () => {
    await resetLibrary();
    await turnOnEncryption();
    const old = await encNote();
    const recent = await encNote();
    // Two saves a while apart leave a version in history.
    await env.DB.prepare(`INSERT INTO note_versions (note_id, title, content, created_at, enc, sealed, kgen) VALUES (?, '', ?, ?, 1, '{}', 0)`)
      .bind(old.id, 'e1:' + 'A'.repeat(60), Date.now() - 40 * DAY)
      .run();
    await env.DB.prepare(`INSERT INTO files (id, note_id, name, mime, size, storage, created_at) VALUES ('keepfile1', ?, '', 'application/octet-stream', 4, 'kv', ?)`)
      .bind(old.id, Date.now())
      .run();
    await post(`/notes/${old.id}/trash`);
    await post(`/notes/${recent.id}/trash`);
    await trashedDaysAgo(old.id, 31);
    await trashedDaysAgo(recent.id, 29);
    await runCron();
    expect((await get(`/notes/${old.id}`)).status).toBe(404);
    expect((await get(`/notes/${recent.id}`)).status).toBe(200);
    expect(await count('SELECT COUNT(*) AS n FROM note_versions WHERE note_id = ?', old.id)).toBe(0);
    expect(await count(`SELECT COUNT(*) AS n FROM files WHERE id = 'keepfile1'`)).toBe(1);
  });

  it('leaves a note restored from the trash alone, however long it was there', async () => {
    await resetLibrary();
    const note = await newNote({ content: 'back again' });
    await post(`/notes/${note.id}/trash`);
    await trashedDaysAgo(note.id, 60);
    await post(`/notes/${note.id}/restore`);
    await patch(`/notes/${note.id}`, { pinned: true });
    await runCron();
    expect((await get(`/notes/${note.id}`)).body).toMatchObject({ id: note.id, deleted_at: null, pinned: true });
  });
});
