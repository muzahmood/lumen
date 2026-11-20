/**
 * What the API does with requests the app would never send: malformed or oddly typed bodies, bad ids,
 * oversized fields, unknown routes and methods. Plus the headers on sign-out, and how the app's own
 * files are served (the Worker runs before every static file).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { accessToken, call, cipher, fetchPath, get, LOCAL, newFolder, newNote, patch, post, PUBLIC, resetLibrary, sealedFields, testId, turnOnEncryption } from './helpers';
import { encNote, put, rawJson, withEnv } from './api-helpers';

beforeEach(resetLibrary);

/** Every route that reads a JSON body, as [method, path]; `:note` and `:folder` are filled in. */
const JSON_ROUTES: Array<[string, string]> = [
  ['POST', '/notes'],
  ['PATCH', '/notes/:note'],
  ['POST', '/notes/batch'],
  ['POST', '/notes/seal'],
  ['POST', '/notes/previews'],
  ['POST', '/versions/seal'],
  ['POST', '/folders'],
  ['PATCH', '/folders/:folder'],
  ['POST', '/folders/seal'],
  ['POST', '/rekey/notes'],
  ['POST', '/rekey/versions'],
  ['POST', '/rekey/folders'],
  ['POST', '/rekey/files'],
  ['POST', '/rekey/drawings'],
  ['POST', '/keyring'],
  ['PUT', '/drawings/:note'],
  ['PUT', '/settings'],
];

async function jsonRoutes() {
  const note = await newNote();
  const folder = await newFolder();
  await turnOnEncryption();
  return JSON_ROUTES.map(([method, path]) => [method, path.replace(':note', note.id).replace(':folder', folder.id)] as const);
}

describe('request bodies', () => {
  it('answers a body that isn’t JSON with bad_json on every route that reads one', async () => {
    for (const [method, path] of await jsonRoutes()) {
      for (const body of ['{oops', '', '{"a":1']) {
        const res = await rawJson(method, path, body);
        expect([res.status, res.body.error], `${method} ${path} ${JSON.stringify(body)}`).toEqual([400, 'bad_json']);
      }
    }
  });

  it('never answers JSON that isn’t an object with a server error', async () => {
    const failures: string[] = [];
    // Clean-up treats a body it can't parse as a dry run, but reads whatever JSON it gets.
    for (const [method, path] of [...(await jsonRoutes()), ['POST', '/files/cleanup'] as const]) {
      for (const body of ['null', '"text"', '[]', '7']) {
        const res = await rawJson(method, path, body);
        if (res.status >= 500) failures.push(`${method} ${path} ${body} → ${res.status}`);
      }
    }
    expect(failures).toEqual([]);
  });

  it('refuses a list item that isn’t an object as a bad request, never a server error', async () => {
    await turnOnEncryption();
    const lists: Array<[string, string]> = [
      ['/versions/seal', 'versions'],
      ['/notes/seal', 'notes'],
      ['/notes/previews', 'notes'],
      ['/folders/seal', 'folders'],
      ['/rekey/notes', 'notes'],
      ['/rekey/versions', 'versions'],
      ['/rekey/folders', 'folders'],
      ['/rekey/files', 'items'],
      ['/rekey/drawings', 'items'],
    ];
    const failures: string[] = [];
    for (const [path, field] of lists) {
      for (const item of [null, 7, 'text', ['id']]) {
        const res = await post(path, { [field]: [item], kgen: 0 });
        if (res.status !== 400) failures.push(`${path} [${JSON.stringify(item)}] → ${res.status} ${JSON.stringify(res.body)}`);
      }
    }
    expect(failures).toEqual([]);
  });

  it('turns fields of the wrong type into safe values instead of storing them as sent', async () => {
    const folder = await newFolder();
    const note = await post('/notes', { title: 42, content: { text: 'x' }, tags: 'work', folder_id: 7, pinned: 'yes', id: undefined });
    expect(note.status).toBe(201);
    expect(note.body).toMatchObject({ title: '', excerpt: '', tags: [], folder_id: null, pinned: true });
    const made = await post('/folders', { name: 'Sorted', sort: '3', parent_id: 99 });
    expect(made.body).toMatchObject({ name: 'Sorted', sort: 0, parent_id: null });
    expect((await patch(`/notes/${note.body.id}`, { folder_id: 12 })).body.error).toBe('bad_folder');
    expect((await patch(`/notes/${note.body.id}`, { content: 12 })).body.version).toBe(1);
    expect((await patch(`/folders/${folder.id}`, { name: 12 })).body.error).toBe('bad_name');
  });

  it('refuses encrypted text too large to store', async () => {
    await turnOnEncryption();
    const huge = `e1:${'A'.repeat(1_800_000)}`;
    const id = testId();
    expect((await post('/notes', { id, enc: true, content: huge, sealed: sealedFields() })).status).toBe(413);
    const note = await encNote();
    expect((await patch(`/notes/${note.id}`, { enc: true, content: huge })).status).toBe(413);
    const bigField = `e1:${'A'.repeat(200_001)}`;
    expect((await post('/notes', { id, enc: true, content: cipher(), sealed: { ...sealedFields(), p: bigField } })).status).toBe(400);
    expect((await patch(`/notes/${note.id}`, { enc: true, sealed: { t: bigField } })).status).toBe(400);
    const bigName = `e1:${'A'.repeat(4000)}`;
    expect((await post('/folders', { id: testId('f'), enc: true, sealed: bigName })).status).toBe(400);
    const folder = (await post('/folders', { id: testId('f'), enc: true, sealed: cipher() })).body;
    expect((await patch(`/folders/${folder.id}`, { sealed: bigName })).status).toBe(400);
    expect((await put('/settings', { enc: true, data: `e1:${'A'.repeat(16_000)}`, kgen: 0, base: 0 })).status).toBe(400);
    expect((await get(`/notes/${id}`)).status).toBe(404);
  });

  it('refuses an encrypted note or folder without the id its ciphertext is bound to', async () => {
    await turnOnEncryption();
    const note = await post('/notes', { enc: true, content: cipher(), sealed: sealedFields() });
    expect([note.status, note.body.error]).toEqual([400, 'bad_id']);
    const folder = await post('/folders', { enc: true, sealed: cipher() });
    expect([folder.status, folder.body.error]).toEqual([400, 'bad_id']);
  });
});

describe('ids', () => {
  const BAD = ['abc', 'a'.repeat(65), 'bad%20id', '%C3%A9t%C3%A9-note', 'a.b.c.d.e', '..%2F..%2Fx'];

  it('refuses a malformed id in every path that takes one', async () => {
    await turnOnEncryption();
    const routes: Array<[string, (id: string) => string]> = [
      ['GET', (id) => `/notes/${id}`],
      ['PATCH', (id) => `/notes/${id}`],
      ['DELETE', (id) => `/notes/${id}`],
      ['POST', (id) => `/notes/${id}/trash`],
      ['POST', (id) => `/notes/${id}/restore`],
      ['GET', (id) => `/notes/${id}/versions`],
      ['GET', (id) => `/notes/${id}/backlinks`],
      ['PATCH', (id) => `/folders/${id}`],
      ['DELETE', (id) => `/folders/${id}`],
      ['GET', (id) => `/files/${id}`],
      ['GET', (id) => `/files/${id}/name.png`],
      ['DELETE', (id) => `/files/${id}`],
      ['PUT', (id) => `/files/${id}/seal`],
      ['GET', (id) => `/drawings/${id}`],
      ['GET', (id) => `/drawings/${id}/scene`],
      ['PUT', (id) => `/drawings/${id}`],
      ['PUT', (id) => `/drawings/${id}/blob/svg?rev=rev0001`],
      ['DELETE', (id) => `/drawings/${id}`],
    ];
    for (const [method, path] of routes) {
      for (const id of BAD) {
        const res = await call(method, path(id), method === 'GET' || method === 'DELETE' ? undefined : { name: 'x' });
        expect([res.status, res.body.error], `${method} ${path(id)}`).toEqual([400, 'bad_id']);
      }
    }
  });

  it('accepts ids of 6 to 64 letters, digits, - and _', async () => {
    for (const id of ['abc-_1', 'A'.repeat(64), 'Zz09_-Zz09']) {
      expect((await post('/notes', { id, title: 'Edge' })).status, id).toBe(201);
      expect((await get(`/notes/${id}`)).body.id).toBe(id);
    }
  });

  it('refuses malformed history ids and delete-if-version values', async () => {
    for (const vid of ['-1', '1.5', 'abc', '0']) {
      expect((await get(`/versions/${vid}`)).status, vid).toBe(400);
    }
    const note = await newNote();
    for (const v of ['1.5', 'one', 'NaN']) {
      expect((await call('DELETE', `/notes/${note.id}?ifVersion=${v}`)).status, v).toBe(400);
    }
    expect((await get(`/notes/${note.id}`)).status).toBe(200);
  });
});

describe('routes', () => {
  it('answers unknown paths and methods under /api with JSON, never the app shell', async () => {
    const note = await newNote();
    const attempts = [
      await fetchPath('/api'),
      await fetchPath('/api/'),
      await fetchPath(`/api/notes/${note.id}/unknown`),
      await fetchPath('/api/notes', { method: 'DELETE', headers: { 'x-kb-client': '1' } }),
      await fetchPath(`/api/notes/${note.id}`, { method: 'PUT', headers: { 'x-kb-client': '1' } }),
      await fetchPath('/api/signout'),
      await fetchPath('/api/notes/'),
    ];
    for (const res of attempts) {
      expect(res.status, res.url).toBe(404);
      expect(res.headers.get('content-type'), res.url).toContain('application/json');
      expect(res.headers.get('cache-control'), res.url).toBe('private, no-store');
      expect(await res.json()).toMatchObject({ error: 'no_route' });
    }
    expect((await get(`/notes/${note.id}`)).status).toBe(200);
  });

  it('still refuses a write to an unknown path without the client header', async () => {
    expect((await call('POST', '/nothing-here', {}, { noClientHeader: true })).status).toBe(403);
  });

  it('refuses every write without the client header, so other sites can’t make one', async () => {
    const note = await newNote();
    const writes: Array<[string, string]> = [
      ...JSON_ROUTES.map(([m, p]) => [m, p.replace(':note', note.id).replace(':folder', 'abcdefgh')] as [string, string]),
      ['POST', `/notes/${note.id}/trash`],
      ['POST', `/notes/${note.id}/restore`],
      ['DELETE', `/notes/${note.id}`],
      ['POST', '/trash/empty'],
      ['DELETE', '/folders/abcdefgh'],
      ['POST', '/files'],
      ['POST', '/files/cleanup'],
      ['POST', '/encryption/finish'],
      ['POST', '/backups/made'],
      ['POST', '/cache/clear'],
      ['POST', '/signout'],
    ];
    for (const [method, path] of writes) {
      const res = await call(method, path, {}, { noClientHeader: true });
      expect([res.status, res.body.error], `${method} ${path}`).toEqual([403, 'forbidden']);
    }
    expect((await get(`/notes/${note.id}`)).body.deleted_at).toBeNull();
  });

  it('clears only the browser cache on sign-out, and keeps the reply out of caches', async () => {
    for (const path of ['/signout', '/cache/clear']) {
      const res = await post(path);
      expect(res.body).toEqual({ ok: true });
      expect(res.headers.get('clear-site-data')).toBe('"cache"');
      expect(res.headers.get('cache-control')).toBe('private, no-store');
    }
  });

  it('answers HEAD like GET, without a body', async () => {
    const res = await fetchPath('/api/bootstrap', { method: 'HEAD' });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('');
  });
});

describe('the app’s own files', () => {
  /** Stands in for the static files binding, answering the way Workers static assets does (single-page app). */
  const ASSETS = {
    async fetch(input: RequestInfo | URL) {
      const path = new URL(input instanceof Request ? input.url : String(input)).pathname;
      const files: Record<string, [string, string]> = {
        '/assets/index-abc123.js': ['console.log(1)', 'text/javascript'],
        '/excalidraw-assets/fonts.css': ['body{}', 'text/css'],
        '/sw.js': ['self.addEventListener', 'text/javascript'],
        '/manifest.webmanifest': ['{}', 'application/manifest+json'],
      };
      const [body, type] = files[path] ?? ['<!doctype html><title>Lumen</title>', 'text/html; charset=utf-8'];
      return new Response(body, { headers: { 'content-type': type, 'cache-control': 'public, max-age=14400' } });
    },
  };
  const open = (path: string, init: RequestInit = {}, origin = LOCAL) => withEnv({ ASSETS }, `${origin}${path}`, init);

  it('serves the app for any page address under the app’s policy, revalidated every time', async () => {
    for (const path of ['/', '/note/abc123', '/share']) {
      const res = await open(path);
      expect(res.status, path).toBe(200);
      expect(res.body).toContain('<title>Lumen</title>');
      expect(res.headers.get('cache-control')).toBe('private, no-cache');
      const csp = res.headers.get('content-security-policy') ?? '';
      expect(csp).toContain("script-src 'self' 'wasm-unsafe-eval'");
      expect(csp).toContain("frame-ancestors 'none'");
      expect(res.headers.get('x-frame-options')).toBe('DENY');
    }
  });

  it('caches build files for good, privately, and drawing assets for a week', async () => {
    const script = await open('/assets/index-abc123.js');
    expect([script.status, script.headers.get('cache-control')]).toEqual([200, 'private, max-age=31536000, immutable']);
    expect(script.headers.get('content-security-policy')).toBeNull();
    const font = await open('/excalidraw-assets/fonts.css');
    expect(font.headers.get('cache-control')).toBe('private, max-age=604800');
  });

  it('answers a build file that no longer exists with a 404, never the app shell', async () => {
    for (const path of ['/assets/index-old999.js', '/excalidraw-assets/gone.js']) {
      const res = await open(path);
      expect(res.status, path).toBe(404);
      expect(res.headers.get('content-type')).toContain('text/plain');
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(res.body).not.toContain('<title>');
    }
  });

  it('revalidates the service worker and manifest every time', async () => {
    for (const path of ['/sw.js', '/manifest.webmanifest']) {
      expect((await open(path)).headers.get('cache-control'), path).toBe('private, no-cache');
    }
  });

  it('serves them on a public address only with a valid Access token', async () => {
    const token = await accessToken();
    for (const path of ['/sw.js', '/manifest.webmanifest', '/note/abc123']) {
      expect((await open(path, { headers: { 'cf-access-jwt-assertion': token } }, PUBLIC)).status, path).toBe(200);
      const refused = await open(path, {}, PUBLIC);
      expect(refused.status, path).toBe(403);
      expect(refused.body).not.toContain('self.addEventListener');
    }
  });

  it('serves nothing when there are no static files', async () => {
    const res = await withEnv({ ASSETS: undefined }, `${LOCAL}/`);
    expect(res.status).toBe(404);
  });
});
