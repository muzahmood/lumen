/**
 * The Worker's fallbacks and error paths (worker/index.ts, worker/gate.ts): search and backlinks when
 * the full-text index can't answer, turning on encryption on an SQLite without secure-delete, and
 * what an unexpected failure looks like from outside (a plain 500, no details, the usual headers).
 */
import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { withEnv } from './api-helpers';
import { callWith, divertedDb } from './cov-helpers';
import { get, keyringData, LOCAL, newNote, post, resetLibrary } from './helpers';
import { secureResponse } from '../../worker/gate';

const ftsDown = () => divertedDb((sql) => sql.includes('notes_fts MATCH'), new Error('SQLITE_ERROR: fts5: syntax error near "secret"'));

beforeEach(async () => {
  await resetLibrary();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('when the full-text index can’t answer', () => {
  it('search falls back to plain matching on titles and text, still leaving out the trash', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const live = await newNote({ title: 'Harbour plans', content: 'Two tug boats and a crane' });
    const trashed = await newNote({ title: 'Old tug notes', content: 'scrapped' });
    await post(`/notes/${trashed.id}/trash`);
    const byTitle = await newNote({ title: 'Tugboat rota', content: 'Mondays' });
    const res = await withEnv({ DB: ftsDown() }, `${LOCAL}/api/search?q=tug`);
    expect(res.status).toBe(200);
    const ids = res.body.results.map((r: { id: string }) => r.id).sort();
    expect(ids).toEqual([live.id, byTitle.id].sort());
    expect(res.body.results.find((r: { id: string }) => r.id === live.id)).toMatchObject({ title: 'Harbour plans', tags: [], snippet: expect.any(String) });
    expect(warn).toHaveBeenCalledWith('FTS query failed, falling back to LIKE', expect.any(Error));
  });

  it('the fallback copes with a % in what’s searched for', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await newNote({ title: 'Budget', content: 'Rent is 40% of income' });
    await newNote({ title: 'Other', content: 'nothing to see' });
    const pct = await withEnv({ DB: ftsDown() }, `${LOCAL}/api/search?q=${encodeURIComponent('40%')}`);
    expect(pct.body.results.map((r: { title: string }) => r.title)).toEqual(['Budget']);
  });

  it('the fallback matches %, _ and \\ as typed, not as wildcards or left out', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await newNote({ title: 'Score', content: 'Passed with 100% on the test' });
    await newNote({ title: 'Orchard', content: '1000 apples picked' });
    await newNote({ title: 'Config', content: 'Set file_name in the header' });
    await newNote({ title: 'Typo', content: 'the filename is wrong' });
    await newNote({ title: 'Path', content: 'Saved under C:\\notes\\today' });
    const titles = async (q: string) =>
      (await withEnv({ DB: ftsDown() }, `${LOCAL}/api/search?q=${encodeURIComponent(q)}`)).body.results.map((r: { title: string }) => r.title).sort();
    expect(await titles('100%')).toEqual(['Score']);
    expect(await titles('file_name')).toEqual(['Config']);
    expect(await titles('le_n')).toEqual(['Config']);
    expect(await titles('C:\\notes')).toEqual(['Path']);
  });

  it('backlinks answer with none rather than an error', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const target = await newNote({ title: 'Target' });
    await newNote({ title: 'Linker', content: 'See [[Target]]' });
    const ok = await get(`/notes/${target.id}/backlinks`);
    expect(ok.body.backlinks).toHaveLength(1);
    const res = await withEnv({ DB: ftsDown() }, `${LOCAL}/api/notes/${target.id}/backlinks`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ backlinks: [] });
    expect(warn).toHaveBeenCalledWith('backlink search failed', expect.any(Error));
  });
});

describe('turning on encryption', () => {
  it('still works on an SQLite without secure-delete, saying so in the logs', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const db = divertedDb((sql) => sql.includes('secure-delete'), new Error('SQLITE_ERROR: unknown special query'));
    const res = await callWith({ DB: db }, 'POST', '/keyring', { data: keyringData(), replaces: null });
    expect(res.status).toBe(201);
    expect(res.body.keyring.id).toEqual(expect.any(Number));
    expect(warn).toHaveBeenCalledWith('FTS secure-delete unavailable', expect.any(Error));
    expect((await get('/bootstrap')).body.encryption.on).toBe(true);
  });
});

describe('an unexpected failure', () => {
  it('answers a plain 500 without any of the error’s details, kept out of caches, and logs it', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const db = divertedDb((sql) => sql.includes('SELECT id, data, created_at FROM keyring'), new Error('D1_ERROR: table keyring is locked by secret-process-42'));
    const res = await withEnv({ DB: db }, `${LOCAL}/api/keyring`);
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'server_error', message: 'Something went wrong on the server. Try again in a moment.' });
    expect(JSON.stringify(res.body)).not.toContain('secret');
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(error).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('secret-process-42') }));
  });

  it('a free-tier daily allowance used up is a 429 saying when it resets, not a 500 to retry', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    for (const message of [
      'D1_ERROR: Your account has exceeded D1’s free tier daily row read limit. Upgrade or wait until tomorrow.',
      'KV put() limit exceeded for the day.',
    ]) {
      const db = divertedDb((sql) => sql.includes('SELECT id, data, created_at FROM keyring'), new Error(message));
      const before = Date.now();
      const res = await withEnv({ DB: db }, `${LOCAL}/api/keyring`);
      expect(res.status, message).toBe(429);
      const midnight = new Date(before);
      const resetAt = Date.UTC(midnight.getUTCFullYear(), midnight.getUTCMonth(), midnight.getUTCDate() + 1);
      expect(res.body).toEqual({ error: 'quota_exceeded', message: expect.stringContaining('midnight UTC'), resetAt });
      const wait = Number(res.headers.get('retry-after'));
      expect(wait).toBeGreaterThan(0);
      expect(wait).toBeLessThanOrEqual(86_400);
    }
    // An error that only mentions a limit (not a daily one) is still a plain 500.
    const db = divertedDb((sql) => sql.includes('SELECT id, data, created_at FROM keyring'), new Error('D1_ERROR: LIKE or GLOB pattern too complex: limit 50000'));
    expect((await withEnv({ DB: db }, `${LOCAL}/api/keyring`)).status).toBe(500);
  });

  it('outside the API (serving the app itself) is a 500 with the security headers too', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const assets = { fetch: async () => Promise.reject(new Error('asset store exploded')) };
    const res = await withEnv({ ASSETS: assets }, `${LOCAL}/note/abc123`);
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'server_error', message: expect.any(String) });
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.headers.get('strict-transport-security')).toBe('max-age=31536000');
  });

  it('without the app’s files bound, pages answer 404 rather than failing', async () => {
    const res = await withEnv({ ASSETS: undefined }, `${LOCAL}/`);
    expect(res.status).toBe(404);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });
});

describe('serving the app’s own files', () => {
  const assets = (type: string | null, body = 'x') => ({
    fetch: async () => new Response(body, { headers: type ? { 'content-type': type } : {} }),
  });

  it('answers a missing build file as a 404, never as the app shell', async () => {
    for (const path of ['/assets/index-old123.js', '/excalidraw-assets/gone.js']) {
      const res = await withEnv({ ASSETS: assets('text/html; charset=utf-8', '<!doctype html>') }, `${LOCAL}${path}`);
      expect(res.status, path).toBe(404);
      expect(res.headers.get('cache-control')).toBe('no-store');
    }
  });

  it('caches build output for good, drawing assets for a week and the rest only after asking', async () => {
    const cases: Array<[string, string]> = [
      ['/assets/index-abc.js', 'private, max-age=31536000, immutable'],
      ['/excalidraw-assets/font.woff2', 'private, max-age=604800'],
      ['/sw.js', 'private, no-cache'],
    ];
    for (const [path, cache] of cases) {
      const res = await withEnv({ ASSETS: assets('application/javascript') }, `${LOCAL}${path}`);
      expect(res.headers.get('cache-control'), path).toBe(cache);
    }
    // A reply with no type at all is passed through, still with the security headers.
    const untyped = await withEnv({ ASSETS: assets(null) }, `${LOCAL}/robots.txt`);
    expect(untyped.status).toBe(200);
    expect(untyped.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('adds the security headers to a response whose headers can’t be changed, by copying it', () => {
    const locked = Response.redirect('https://kb.example.test/elsewhere', 302);
    const out = secureResponse(locked);
    expect(out).not.toBe(locked);
    expect(out.status).toBe(302);
    expect(out.headers.get('location')).toBe('https://kb.example.test/elsewhere');
    expect(out.headers.get('x-frame-options')).toBe('DENY');
  });
});

describe('creating a note with an id that’s taken', () => {
  it('is refused as a conflict, leaving the note that has it alone', async () => {
    const first = await post('/notes', { id: 'takenid1', title: 'First', content: 'kept' });
    expect(first.status).toBe(201);
    const second = await post('/notes', { id: 'takenid1', title: 'Second', content: 'not kept' });
    expect(second.status).toBe(409);
    expect(second.body.error).toBe('exists');
    expect((await get('/notes/takenid1')).body).toMatchObject({ title: 'First', content: 'kept', version: 1 });
    expect(await env.DB.prepare(`SELECT COUNT(*) AS n FROM notes WHERE id = 'takenid1'`).first()).toEqual({ n: 1 });
  });
});
