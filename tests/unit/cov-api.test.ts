// @vitest-environment jsdom
/**
 * The API client's edges (src/lib/api.ts), beyond sync-api.test.ts: the shared keepalive budget
 * measured exactly for long text, every kind of reply that isn't the JSON asked for, answers about the
 * wrong item, and the encrypted and unencrypted forms of uploads, drawings, folders and settings.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { encryptText, newMasterKey } from '../../src/lib/crypto';
import { json, NOW, plainRow, polyfillMatchMedia, sealedRow, settle, standInServer, type StandIn } from './cov-helpers';

polyfillMatchMedia();

let apiMod: typeof import('../../src/lib/api');
let e2ee: typeof import('../../src/lib/e2ee');
let key: CryptoKey;
let otherKey: CryptoKey;
let server: StandIn;

beforeAll(async () => {
  key = await newMasterKey();
  otherKey = await newMasterKey();
});

beforeEach(async () => {
  vi.stubGlobal('BroadcastChannel', undefined);
  localStorage.clear();
  server = standInServer();
  vi.resetModules();
  apiMod = await import('../../src/lib/api');
  e2ee = await import('../../src/lib/e2ee');
});

afterEach(() => {
  apiMod.setCodec(null);
  vi.unstubAllGlobals();
});

const unlock = () => apiMod.setCodec(e2ee.createCodec(key));

describe('keepalive (requests that outlive the page)', () => {
  /** Holds every PATCH until released, so several are in flight together. */
  function holdPatches() {
    const waiting: Array<() => void> = [];
    server.on('PATCH', /^\/api\/notes\//, async (req) => {
      await new Promise<void>((r) => waiting.push(r));
      return json(200, plainRow(req.path.split('/').pop()!));
    });
    return () => waiting.splice(0).forEach((r) => r());
  }
  const keepalives = () => server.requests('PATCH', /^\/api\/notes\//).map((r) => r.keepalive);

  it('measures long text exactly, so a 30,000-character save still fits the 60 KB budget', async () => {
    const release = holdPatches();
    const saving = apiMod.api.updateNote('a1', { content: 'a'.repeat(30_000) }, { keepalive: true });
    await settle(5);
    expect(keepalives()).toEqual([true]);
    release();
    await saving;
  });

  it('shares the budget between requests in flight, and frees it when each ends', async () => {
    const release = holdPatches();
    const first = apiMod.api.updateNote('a1', { content: 'a'.repeat(30_000) }, { keepalive: true });
    const second = apiMod.api.updateNote('a2', { content: 'b'.repeat(30_000) }, { keepalive: true });
    // Two bytes per character: 25,000 é is 50 KB, which wouldn't fit beside either.
    const third = apiMod.api.updateNote('a3', { content: 'é'.repeat(25_000) }, { keepalive: true });
    await settle(5);
    expect(keepalives()).toEqual([true, false, false]);
    release();
    await Promise.all([first, second, third]);
    const fourth = apiMod.api.updateNote('a4', { content: 'é'.repeat(25_000) }, { keepalive: true });
    await settle(5);
    expect(keepalives()[3]).toBe(true);
    release();
    await fourth;
  });

  it('never sends a file upload as keepalive, and doesn’t time it out', async () => {
    server.on('POST', '/api/files', () => json(201, { id: 'file01', name: 'a.txt', mime: 'text/plain', url: '/api/files/file01/a.txt' }));
    await apiMod.api.uploadFile(new Blob(['hi'], { type: 'text/plain' }), 'a.txt');
    const [up] = server.requests('POST', '/api/files');
    expect(up.keepalive).toBe(false);
    expect(up.signal).toBeUndefined();
    // Everything else gets a time limit.
    await apiMod.api.me().catch(() => undefined);
    expect(server.requests('GET', '/api/me')[0].signal).toBeInstanceOf(AbortSignal);
  });
});

describe('replies that aren’t the JSON asked for', () => {
  it('a JSON error without a code or message still names the status', async () => {
    server.on('GET', '/api/me', () => json(500, {}));
    await expect(apiMod.api.me()).rejects.toMatchObject({ status: 500, code: 'error', message: 'Request failed (500).' });
  });

  it('an error page from Cloudflare itself is a passing server problem, not a signed-out session', async () => {
    const expired = vi.fn();
    apiMod.onAuthExpired(expired);
    server.on('GET', '/api/me', () => new Response('<html>502 Bad gateway</html>', { status: 502, headers: { 'content-type': 'text/html' } }));
    await expect(apiMod.api.me()).rejects.toMatchObject({ status: 502, code: 'http' });
    expect(expired).not.toHaveBeenCalled();
  });

  it('a sign-in page instead of JSON means the session ended', async () => {
    const expired = vi.fn();
    apiMod.onAuthExpired(expired);
    server.on('GET', '/api/me', () => new Response('<html>Sign in</html>', { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } }));
    await expect(apiMod.api.me()).rejects.toMatchObject({ status: 401, code: 'auth' });
    expect(expired).toHaveBeenCalledTimes(1);
  });

  it('Cloudflare’s page for a used-up daily allowance (error 1027, or any 429) says so, not that the session ended', async () => {
    const expired = vi.fn();
    apiMod.onAuthExpired(expired);
    const page = '<html><title>Worker exceeded free tier daily request limit</title><h1>Error 1027</h1></html>';
    for (const res of [
      () => new Response(page, { status: 429, headers: { 'content-type': 'text/html' } }),
      () => new Response(page, { status: 503, headers: { 'content-type': 'text/html' } }),
      () => json(429, { error: 'quota_exceeded', message: 'From the Worker.', resetAt: 1 }),
    ]) {
      server.on('GET', '/api/me', res);
      const err = await apiMod.api.me().catch((e: unknown) => e);
      expect(err).toMatchObject({ status: 429, code: 'quota_exceeded', message: expect.stringMatching(/today’s Cloudflare free allowance.*in about \d+ hours?\)\.$/) });
      expect((err as { data: { resetAt: number } }).data.resetAt).toBe(apiMod.quotaResetAt());
    }
    expect(expired).not.toHaveBeenCalled();
  });

  it('Access’s refusal page (403) still means signing in again; another page (404) is just an error', async () => {
    const expired = vi.fn();
    apiMod.onAuthExpired(expired);
    server.on('GET', '/api/me', () => new Response('<html>Forbidden</html>', { status: 403, headers: { 'content-type': 'text/html' } }));
    await expect(apiMod.api.me()).rejects.toMatchObject({ status: 401, code: 'auth' });
    expect(expired).toHaveBeenCalledTimes(1);
    server.on('GET', '/api/me', () => new Response('<html>Not here</html>', { status: 404, headers: { 'content-type': 'text/html' } }));
    await expect(apiMod.api.me()).rejects.toMatchObject({ status: 404, code: 'http' });
    expect(expired).toHaveBeenCalledTimes(1);
  });

  it('a reply with no type at all is an error with its status', async () => {
    server.on('GET', '/api/me', () => new Response(null, { status: 204 }));
    await expect(apiMod.api.me()).rejects.toMatchObject({ status: 204, code: 'http' });
  });

  it('a reply cut off partway through counts as the connection dropping', async () => {
    server.on('GET', '/api/me', () => new Response('{"email":"me@exa', { headers: { 'content-type': 'application/json' } }));
    await expect(apiMod.api.me()).rejects.toBeInstanceOf(apiMod.NetworkError);
  });

  it('the service worker’s offline answer marks the server unreachable, and the next real one reachable again', async () => {
    const heard: boolean[] = [];
    apiMod.onReachabilityChange((r) => heard.push(r));
    server.on('GET', '/api/me', () => json(503, { error: 'offline', message: 'Offline.' }, { 'x-kb-offline': '1' }));
    await expect(apiMod.api.me()).rejects.toMatchObject({ code: 'offline' });
    server.on('GET', '/api/me', () => json(200, { email: null }));
    await apiMod.api.me();
    expect(heard).toEqual([false, true]);
  });

  it('a request the app cancelled stays cancelled, and doesn’t mark the server unreachable', async () => {
    const heard: boolean[] = [];
    apiMod.onReachabilityChange((r) => heard.push(r));
    server.on('GET', '/api/search', () => Promise.reject(new DOMException('The user aborted a request.', 'AbortError')));
    await expect(apiMod.api.searchServer('x', 5, new AbortController().signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(heard).toEqual([]);
  });

  it('errorMessage has words for anything thrown', () => {
    expect(apiMod.errorMessage(new apiMod.ApiError(409, 'conflict', 'Changed elsewhere.'))).toBe('Changed elsewhere.');
    expect(apiMod.errorMessage(new Error('plain'))).toBe('plain');
    expect(apiMod.errorMessage('a string')).toBe('Something went wrong.');
  });
});

describe('answers about another item', () => {
  it('refuses a folder update answered for another folder', async () => {
    server.on('PATCH', '/api/folders/fold1', () => json(200, { id: 'fold2', name: 'Other', parent_id: null, sort: 0 }));
    await expect(apiMod.api.updateFolder('fold1', { name: 'Mine' })).rejects.toMatchObject({ status: 502, code: 'wrong_item' });
  });

  it('keeps only the notes asked for from a batch', async () => {
    server.rows.set('n1', plainRow('n1'));
    server.rows.set('n2', plainRow('n2'));
    server.on('POST', '/api/notes/batch', () => json(200, { notes: [plainRow('n1'), plainRow('n2'), null, { id: 5 }] }));
    expect((await apiMod.api.rawNotes(['n1'])).map((n) => n.id)).toEqual(['n1']);
    expect(await apiMod.api.rawNotes([])).toEqual([]);
  });

  it('in a conflict, leaves out a saved note that isn’t the one being saved, or that can’t be decrypted', async () => {
    unlock();
    const intruder = await sealedRow(key, 'other1', { content: 'another note’s text' });
    server.on('PATCH', '/api/notes/mine1', () => json(409, { error: 'conflict', message: 'Changed on another device.', note: intruder }));
    const wrong = await apiMod.api.updateNote('mine1', { content: 'x', baseVersion: 1 }).catch((e) => e);
    expect(wrong).toMatchObject({ code: 'conflict', data: { note: undefined } });

    const unreadable = await sealedRow(otherKey, 'mine2', { content: 'under a key this device doesn’t have' });
    server.on('PATCH', '/api/notes/mine2', () => json(409, { error: 'conflict', message: 'Changed on another device.', note: unreadable }));
    const locked = await apiMod.api.updateNote('mine2', { content: 'x', baseVersion: 1 }).catch((e) => e);
    expect(locked).toMatchObject({ code: 'conflict', data: { note: undefined } });

    const theirs = await sealedRow(key, 'mine3', { title: 'Theirs', content: 'their text', version: 4 });
    server.on('PATCH', '/api/notes/mine3', () => json(409, { error: 'conflict', message: 'Changed on another device.', note: theirs }));
    const readable = await apiMod.api.updateNote('mine3', { content: 'x', baseVersion: 1 }).catch((e) => e);
    expect(readable.data.note).toMatchObject({ id: 'mine3', title: 'Theirs', content: 'their text', version: 4 });
  });
});

describe('uploads and drawings without encryption', () => {
  it('sends a file’s name, type, note and id as headers', async () => {
    server.on('POST', '/api/files', () => json(201, { id: 'file01', name: 'x', mime: 'image/png', url: '/api/files/file01/x' }));
    await apiMod.api.uploadFile(new Blob(['png'], { type: 'image/png' }), 'Résumé photo.png', { noteId: 'note01', id: 'file01' });
    await apiMod.api.uploadFile(new Blob(['?']), 'blob');
    const [named, bare] = server.requests('POST', '/api/files').map((r) => r.headers);
    expect(named).toMatchObject({ 'content-type': 'image/png', 'x-file-name': encodeURIComponent('Résumé photo.png'), 'x-note-id': 'note01', 'x-file-id': 'file01' });
    expect(bare['content-type']).toBe('application/octet-stream');
    expect(bare['x-note-id']).toBeUndefined();
    expect(bare['x-file-id']).toBeUndefined();
  });

  it('saves a drawing’s parts as JSON and SVG, with its text for search, and the revision checked', async () => {
    server.on('PUT', /^\/api\/drawings\//, () => json(200, { ok: true }));
    await apiMod.api.saveDrawing('draw01', { scene: '{"elements":[]}', svg: '<svg/>', noteId: 'note01', text: 'label', baseRev: null });
    const [scene, svg, commit] = server.requests('PUT', /^\/api\/drawings\//);
    expect(scene.headers['content-type']).toBe('application/json');
    expect(svg.headers['content-type']).toBe('image/svg+xml');
    expect(scene.query.get('rev')).toBe(svg.query.get('rev'));
    expect(commit.body).toMatchObject({ rev: scene.query.get('rev'), note_id: 'note01', text: 'label', size: 21, base_rev: null });
    expect(commit.body.enc).toBeUndefined();
  });

  it('saves an encrypted drawing as ciphertext, sending none of its text', async () => {
    unlock();
    server.on('PUT', /^\/api\/drawings\//, () => json(200, { ok: true }));
    await apiMod.api.saveDrawing('draw02', { scene: '{"secret":true}', svg: '<svg>secret</svg>', noteId: null, text: 'secret label' });
    const [scene, svg, commit] = server.requests('PUT', /^\/api\/drawings\//);
    expect(scene.headers['content-type']).toBe('application/octet-stream');
    expect(svg.headers['content-type']).toBe('application/octet-stream');
    expect(commit.body).toMatchObject({ text: '', enc: true, kgen: 0, sealed: expect.stringMatching(/^e1:/) });
    expect('base_rev' in commit.body).toBe(false);
    const sent = await (scene.rawBody as Blob).text();
    expect(sent).not.toContain('secret');
  });

  it('a drawing that’s encrypted can’t be shown while the device is locked', async () => {
    server.on('GET', '/api/drawings/draw03.svg', () => new Response('ciphertext', { headers: { 'x-kb-key': 'e1:abc', 'content-type': 'application/octet-stream' } }));
    await expect(apiMod.api.drawingPart('draw03', 'svg')).rejects.toMatchObject({ status: 423, code: 'locked' });
  });

  it('reads any other address as it is', async () => {
    server.on('GET', '/icons/logo.svg', () => new Response('<svg>logo</svg>', { headers: { 'content-type': 'image/svg+xml' } }));
    expect(new TextDecoder().decode(await apiMod.api.assetBytes('/icons/logo.svg'))).toBe('<svg>logo</svg>');
  });
});

describe('folders and settings with encryption on', () => {
  it('encrypts a new folder’s name under an id chosen here, and decrypts the reply', async () => {
    unlock();
    server.on('POST', '/api/folders', (req) => json(201, { id: req.body.id, parent_id: null, sort: 0, name: '', enc: true, sealed: req.body.sealed, created_at: NOW, updated_at: NOW }));
    const folder = await apiMod.api.createFolder({ name: '  Taxes 2026 ' });
    const [sent] = server.requests('POST', '/api/folders');
    expect(sent.body).toMatchObject({ id: folder.id, enc: true, kgen: 0 });
    expect(sent.body.name).toBeUndefined();
    expect(JSON.stringify(sent.body)).not.toContain('Taxes');
    expect(folder.name).toBe('Taxes 2026');
  });

  it('moving an encrypted folder sends no name at all', async () => {
    unlock();
    const sealed = await encryptText(key, 'Work', 'lumen/1/folder/fold1/name');
    server.on('PATCH', '/api/folders/fold1', () => json(200, { id: 'fold1', parent_id: 'fold2', sort: 0, name: '', enc: true, sealed }));
    const moved = await apiMod.api.updateFolder('fold1', { parent_id: 'fold2' });
    expect(server.requests('PATCH', '/api/folders/fold1')[0].body).toEqual({ parent_id: 'fold2', kgen: 0 });
    expect(moved.name).toBe('Work');
  });

  it('opens settings only in the form the library is in', async () => {
    expect(await apiMod.api.openSettings({ enc: false, data: '{"theme":"dark"}', at: 1, kgen: 0 } as never)).toBe('{"theme":"dark"}');
    // Encrypted, while locked: nothing to read them with.
    expect(await apiMod.api.openSettings({ enc: true, data: 'e1:abc', at: 1, kgen: 0 } as never)).toBeNull();
    // Unencrypted once the library is known to be encrypted: not the person's own.
    localStorage.setItem('kb.vault.sealed', '1');
    expect(await apiMod.api.openSettings({ enc: false, data: '{"theme":"dark"}', at: 1, kgen: 0 } as never)).toBeNull();
  });
});
