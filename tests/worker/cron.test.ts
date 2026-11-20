/** The daily clean-up: notes in the trash for more than 30 days are deleted with their history. */
import { createExecutionContext, createScheduledController, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { expect, it } from 'vitest';
import worker from '../../worker/index';
import { get, newNote, patch, post } from './helpers';

const DAY = 24 * 60 * 60 * 1000;

it('purges notes trashed over 30 days ago, and nothing else', async () => {
  const old = await newNote({ content: 'a' });
  await patch(`/notes/${old.id}`, { content: 'b' });
  const recent = await newNote();
  const active = await newNote();
  await post(`/notes/${old.id}/trash`);
  await post(`/notes/${recent.id}/trash`);
  await env.DB.prepare('UPDATE notes SET deleted_at = ? WHERE id = ?').bind(Date.now() - 31 * DAY, old.id).run();
  await env.DB.prepare('UPDATE notes SET deleted_at = ? WHERE id = ?').bind(Date.now() - 29 * DAY, recent.id).run();

  const ctx = createExecutionContext();
  await worker.scheduled(createScheduledController({ scheduledTime: Date.now(), cron: '17 3 * * *' }), env, ctx);
  await waitOnExecutionContext(ctx);

  expect((await get(`/notes/${old.id}`)).status).toBe(404);
  expect((await get(`/notes/${recent.id}`)).status).toBe(200);
  expect((await get(`/notes/${active.id}`)).status).toBe(200);
  const versions = await env.DB.prepare('SELECT COUNT(*) AS n FROM note_versions WHERE note_id = ?').bind(old.id).first<{ n: number }>();
  expect(versions?.n).toBe(0);
});
