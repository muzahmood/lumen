/** Uploads and drawings: storage, safe serving, idempotent retries, clean-up of unused files. */
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { call, cipher, del, fetchPath, get, newNote, post, resetLibrary, sealedFields, testId, turnOnEncryption } from './helpers';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

async function upload(bytes: Uint8Array | string, name: string, type: string, extra: Record<string, string> = {}) {
  const body = typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes;
  return call('POST', '/files', body, { headers: { 'content-type': type, 'x-file-name': encodeURIComponent(name), ...extra } });
}

describe('uploads', () => {
  it('stores a file and serves it back inline, sandboxed and immutable', async () => {
    const res = await upload(PNG, 'photo one.png', 'image/png');
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ name: 'photo-one.png', mime: 'image/png', size: PNG.length, storage: 'kv' });
    expect(res.body.url).toBe(`/api/files/${res.body.id}/photo-one.png`);
    const file = await fetchPath(res.body.url);
    expect(file.status).toBe(200);
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(PNG);
    expect(file.headers.get('content-type')).toBe('image/png');
    expect(file.headers.get('content-disposition')).toMatch(/^inline;/);
    expect(file.headers.get('content-security-policy')).toContain('sandbox');
    expect(file.headers.get('x-content-type-options')).toBe('nosniff');
    expect(file.headers.get('cache-control')).toBe('private, max-age=31536000, immutable');
    const again = await fetchPath(res.body.url, { headers: { 'if-none-match': file.headers.get('etag')! } });
    expect(again.status).toBe(304);
  });

  it('never serves uploaded HTML, script or unknown types as something the browser runs', async () => {
    for (const [name, type] of [
      ['page.html', 'text/html'],
      ['app.js', 'text/javascript'],
      ['x.xml', 'application/xml'],
      ['weird', 'text/html; charset=utf-8'],
      ['list', 'image/png, text/html'],
    ]) {
      const up = await upload('<script>alert(1)</script>', name, type);
      const file = await fetchPath(up.body.url);
      expect(file.headers.get('content-type'), type).toBe('application/octet-stream');
      expect(file.headers.get('content-disposition')).toMatch(/^attachment;/);
      await file.body?.cancel();
    }
  });

  it('serves SVG inline only under a policy that blocks its scripts', async () => {
    const up = await upload('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>', 'x.svg', 'image/svg+xml');
    const file = await fetchPath(up.body.url);
    expect(file.headers.get('content-type')).toBe('image/svg+xml');
    expect(file.headers.get('content-security-policy')).toMatch(/default-src 'none'.*sandbox/);
    await file.body?.cancel();
  });

  it('answers a video player’s request for part of a file with just those bytes (Safari plays nothing otherwise)', async () => {
    const video = new Uint8Array(100).map((_, i) => i);
    const up = await upload(video, 'clip.mp4', 'video/mp4');
    const part = (range: string, extra: Record<string, string> = {}) => fetchPath(up.body.url, { headers: { range, ...extra } });

    const whole = await fetchPath(up.body.url);
    expect(whole.status).toBe(200);
    expect(whole.headers.get('accept-ranges')).toBe('bytes');
    const etag = whole.headers.get('etag')!;
    await whole.body?.cancel();

    for (const [range, start, end] of [
      ['bytes=10-19', 10, 19],
      ['bytes=95-', 95, 99],
      ['bytes=-5', 95, 99],
      ['bytes=90-500', 90, 99],
      ['bytes=0-0', 0, 0],
    ] as const) {
      const res = await part(range);
      expect(res.status, range).toBe(206);
      expect(res.headers.get('content-range'), range).toBe(`bytes ${start}-${end}/100`);
      expect(res.headers.get('content-length'), range).toBe(String(end - start + 1));
      expect(res.headers.get('content-type')).toBe('video/mp4');
      expect(res.headers.get('content-security-policy')).toContain('sandbox');
      expect([...new Uint8Array(await res.arrayBuffer())], range).toEqual([...video.slice(start, end + 1)]);
    }

    // Past the end: nothing to send, and the size, so the player can ask again.
    for (const range of ['bytes=100-', 'bytes=200-300', 'bytes=-0']) {
      const res = await part(range);
      expect(res.status, range).toBe(416);
      expect(res.headers.get('content-range'), range).toBe('bytes */100');
    }
    // Several parts, nonsense, or a copy that has changed since (If-Range): the whole file.
    for (const [range, extra] of [
      ['bytes=0-1,5-6', {}],
      ['bytes=20-10', {}],
      ['items=0-5', {}],
      ['bytes=0-9', { 'if-range': '"something else"' }],
    ] as const) {
      const res = await part(range, extra);
      expect(res.status, range).toBe(200);
      expect((await res.arrayBuffer()).byteLength, range).toBe(100);
    }
    const same = await part('bytes=0-9', { 'if-range': etag });
    expect(same.status).toBe(206);
    await same.body?.cancel();
  });

  it('sends an encrypted file whole, whatever part is asked for (the app decrypts it whole)', async () => {
    await turnOnEncryption();
    const id = testId();
    const body = new Uint8Array(64).fill(7);
    const up = await call('POST', '/files', body, {
      headers: { 'content-type': 'application/octet-stream', 'x-kb-enc': '1', 'x-file-id': id, 'x-kb-sealed': cipher(48), 'x-kb-kgen': '0' },
    });
    expect(up.status).toBe(201);
    const res = await fetchPath(`/api/files/${id}`, { headers: { range: 'bytes=0-9' } });
    expect(res.status).toBe(200);
    expect(res.headers.get('accept-ranges')).toBeNull();
    expect((await res.arrayBuffer()).byteLength).toBe(64);
    await resetLibrary();
  });

  it('offers a download when asked', async () => {
    const up = await upload(PNG, 'a.png', 'image/png');
    const file = await fetchPath(`${up.body.url}?download`);
    expect(file.headers.get('content-disposition')).toMatch(/^attachment;/);
    await file.body?.cancel();
  });

  it('makes file names safe', async () => {
    const res = await upload(PNG, '../../etc/pa"ss wd<>.png', 'image/png');
    expect(res.body.name).toMatch(/^[\w.-]+$/);
    expect(res.body.name).toContain('etcpass-wd.png');
    expect((await upload(PNG, '%%%', 'image/png')).body.name).toBe('file');
  });

  it('treats a retried upload with the same id as the same file', async () => {
    const id = testId('f');
    const first = await upload(PNG, 'a.png', 'image/png', { 'x-file-id': id });
    const second = await upload(PNG, 'a.png', 'image/png', { 'x-file-id': id });
    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(second.body.id).toBe(id);
    const rows = await env.DB.prepare('SELECT COUNT(*) AS n FROM files WHERE id = ?').bind(id).first<{ n: number }>();
    expect(rows?.n).toBe(1);
    expect((await upload(PNG, 'a.png', 'image/png', { 'x-file-id': 'bad id' })).status).toBe(400);
  });

  it('refuses empty and oversized uploads', async () => {
    expect((await upload(new Uint8Array(0), 'e.txt', 'text/plain')).status).toBe(400);
    const tooBig = await upload(new Uint8Array(25 * 1024 * 1024 + 1), 'big.bin', 'application/octet-stream');
    expect(tooBig.status).toBe(413);
  });

  it('deletes a file and its stored bytes', async () => {
    const up = await upload(PNG, 'a.png', 'image/png');
    expect((await del(`/files/${up.body.id}`)).status).toBe(200);
    expect((await fetchPath(up.body.url)).status).toBe(404);
    expect(await env.FILES_KV!.get(`files/${up.body.id}`)).toBeNull();
    expect((await del(`/files/${up.body.id}`)).status).toBe(404);
  });

  it('lists files', async () => {
    const up = await upload(PNG, 'listed.png', 'image/png');
    const list = (await get('/files')).body.files;
    expect(list.find((f: { id: string }) => f.id === up.body.id)?.url).toBe(up.body.url);
  });
});

async function saveDrawing(id: string, rev: string, svg = '<svg xmlns="http://www.w3.org/2000/svg"/>', fields: Record<string, unknown> = {}) {
  // As the app sends them: ciphertext as octet-stream, readable parts as JSON and SVG.
  const type = (plain: string) => ({ headers: { 'content-type': fields.enc ? 'application/octet-stream' : plain } });
  const scene = await call('PUT', `/drawings/${id}/blob/scene?rev=${rev}`, new TextEncoder().encode('{"elements":[]}'), type('application/json'));
  const image = await call('PUT', `/drawings/${id}/blob/svg?rev=${rev}`, new TextEncoder().encode(svg), type('image/svg+xml'));
  expect([scene.status, image.status]).toEqual([200, 200]);
  return call('PUT', `/drawings/${id}`, { rev, size: 10, text: 'label words', ...fields });
}

describe('drawings', () => {
  it('serves its picture and scene for this browser only, checked again each time (never a shared cache)', async () => {
    const id = testId('d');
    await saveDrawing(id, 'rev0001');
    for (const path of [`/api/drawings/${id}.svg`, `/api/drawings/${id}/scene`]) {
      expect((await fetchPath(path)).headers.get('cache-control'), path).toBe('private, no-cache');
    }
  });

  it('saves a drawing in revisions and serves its picture and scene', async () => {
    const id = testId('d');
    const first = await saveDrawing(id, 'rev0001');
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ id, rev: 'rev0001', text: 'label words' });
    const svg = await fetchPath(`/api/drawings/${id}.svg`);
    expect(svg.headers.get('content-type')).toBe('image/svg+xml');
    expect(svg.headers.get('content-security-policy')).toContain('sandbox');
    expect(svg.headers.get('etag')).toBe('"rev0001"');
    await svg.body?.cancel();
    expect((await fetchPath(`/api/drawings/${id}.svg`, { headers: { 'if-none-match': '"rev0001"' } })).status).toBe(304);
    const scene = await get(`/drawings/${id}/scene`);
    expect(scene.body).toEqual({ elements: [] });
  });

  it('drops the previous revision once a new one is in place', async () => {
    const id = testId('d');
    await saveDrawing(id, 'rev0001');
    await saveDrawing(id, 'rev0002');
    // The old revision is removed after the reply (waitUntil); give it a moment.
    await new Promise((r) => setTimeout(r, 50));
    expect(await env.FILES_KV!.get(`drawings/${id}/rev0001.svg`)).toBeNull();
    expect(await env.FILES_KV!.get(`drawings/${id}/rev0002.svg`)).not.toBeNull();
    expect((await get(`/drawings/${id}`)).body.rev).toBe('rev0002');
  });

  it('refuses to save over a revision saved elsewhere since the editor opened', async () => {
    const id = testId('d');
    expect((await saveDrawing(id, 'rev0001', undefined, { base_rev: null })).status).toBe(200);
    // Device B saves on top of rev0001.
    expect((await saveDrawing(id, 'rev0002', undefined, { base_rev: 'rev0001' })).status).toBe(200);
    // Device A, still on rev0001, is refused, and its uploaded files are dropped.
    const stale = await saveDrawing(id, 'rev0003', undefined, { base_rev: 'rev0001' });
    expect(stale.status).toBe(409);
    expect(stale.body.error).toBe('drawing_conflict');
    expect(stale.body.drawing.rev).toBe('rev0002');
    await new Promise((r) => setTimeout(r, 50));
    expect(await env.FILES_KV!.get(`drawings/${id}/rev0003.svg`)).toBeNull();
    expect((await get(`/drawings/${id}`)).body.rev).toBe('rev0002');
    // "Replace theirs": on top of the revision just reported.
    expect((await saveDrawing(id, 'rev0004', undefined, { base_rev: 'rev0002' })).status).toBe(200);
    // A new drawing's id that already exists is a conflict too.
    expect((await saveDrawing(id, 'rev0005', undefined, { base_rev: null })).status).toBe(409);
    // Older app versions send no base revision and save as before.
    expect((await saveDrawing(id, 'rev0006')).status).toBe(200);
    expect((await call('PUT', `/drawings/${id}`, { rev: 'rev0007', base_rev: '../x' })).status).toBe(400);
  });

  it('validates revisions and parts', async () => {
    const id = testId('d');
    expect((await call('PUT', `/drawings/${id}/blob/scene?rev=BAD!`, 'x')).status).toBe(400);
    expect((await call('PUT', `/drawings/${id}/blob/html?rev=rev0001`, 'x')).status).toBe(400);
    expect((await call('PUT', `/drawings/${id}`, { rev: '../x' })).status).toBe(400);
  });

  it('deletes a drawing with its stored data', async () => {
    const id = testId('d');
    await saveDrawing(id, 'rev0001');
    expect((await del(`/drawings/${id}`)).status).toBe(200);
    expect(await env.FILES_KV!.get(`drawings/${id}/rev0001.excalidraw`)).toBeNull();
    expect((await get(`/drawings/${id}`)).status).toBe(404);
  });
});

describe('clean-up of unused files', () => {
  /** Made over a week ago: anything newer is never offered for deletion. */
  const WEEK_AGO = () => Date.now() - 8 * 86_400_000;
  const agedFile = (id: string) => env.DB.prepare('UPDATE files SET created_at = ? WHERE id = ?').bind(WEEK_AGO(), id).run();
  const agedDrawing = (id: string) => env.DB.prepare('UPDATE drawings SET created_at = ?, updated_at = ? WHERE id = ?').bind(WEEK_AGO(), WEEK_AGO(), id).run();

  it('keeps what the app says is linked to, and deletes only what was agreed to', async () => {
    const used = await upload(PNG, 'used.png', 'image/png');
    const unused = await upload(PNG, 'unused.png', 'image/png');
    const notAgreed = await upload(PNG, 'later.png', 'image/png');
    const drawingId = testId('d');
    await saveDrawing(drawingId, 'rev0001');
    for (const f of [used, unused, notAgreed]) await agedFile(f.body.id);
    await agedDrawing(drawingId);

    // Without the app's list (a copy of the app from before this), nothing is guessed.
    const blind = await post('/files/cleanup', { dryRun: true });
    expect([blind.status, blind.body.error]).toEqual([409, 'needs_client']);

    const dry = await post('/files/cleanup', { dryRun: true, referenced: [used.body.id] });
    const ids = dry.body.files.map((f: { id: string }) => f.id);
    expect(ids).toEqual(expect.arrayContaining([unused.body.id, notAgreed.body.id]));
    expect(ids).not.toContain(used.body.id);
    expect(dry.body.drawings.map((d: { id: string }) => d.id)).toContain(drawingId);
    expect((await fetchPath(unused.body.url)).status).toBe(200);

    // Only what was agreed to goes: the file and drawing left out of the answer stay.
    const res = await post('/files/cleanup', { dryRun: false, referenced: [used.body.id], confirm: { files: [unused.body.id], drawings: [] } });
    expect(res.body.files.map((f: { id: string }) => f.id)).toEqual([unused.body.id]);
    expect((await fetchPath(unused.body.url)).status).toBe(404);
    expect((await fetchPath(used.body.url)).status).toBe(200);
    expect((await fetchPath(notAgreed.body.url)).status).toBe(200);
    expect((await get(`/drawings/${drawingId}`)).status).toBe(200);
    // Deleted from storage too, so nothing is left on the list to delete.
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM blob_gc').first<{ n: number }>())!.n).toBe(0);
    // Deleting needs the list of what was agreed to.
    expect((await post('/files/cleanup', { dryRun: false, referenced: [] })).status).toBe(400);
  });

  it('never offers what was added or changed in the last week (a note linking to it may not have arrived yet)', async () => {
    const fresh = await upload(PNG, 'fresh.png', 'image/png');
    const drawingId = testId('d');
    await saveDrawing(drawingId, 'rev0002');
    const dry = await post('/files/cleanup', { dryRun: true, referenced: [] });
    expect(dry.body.files.map((f: { id: string }) => f.id)).not.toContain(fresh.body.id);
    expect(dry.body.drawings.map((d: { id: string }) => d.id)).not.toContain(drawingId);
  });
});

/** An encrypted upload as the app sends it: ciphertext bytes, its own id, and the wrapped key. */
function uploadSealed(id: string, bytes = PNG, extra: Record<string, string> = {}) {
  return call('POST', '/files', bytes, {
    headers: { 'content-type': 'application/octet-stream', 'x-kb-enc': '1', 'x-file-id': id, 'x-kb-sealed': cipher(48), 'x-kb-kgen': '0', ...extra },
  });
}

const kvKeys = async (prefix: string) => (await env.FILES_KV.list({ prefix })).keys.map((k) => k.name);

describe('clean-up with encrypted notes', () => {
  it('refuses to guess, since the server can’t read what encrypted notes link to', async () => {
    await resetLibrary();
    await turnOnEncryption();
    const keptId = testId('f');
    expect((await uploadSealed(keptId)).status).toBe(201);
    await post('/notes', { id: testId(), enc: true, content: cipher(), sealed: sealedFields() });
    const blind = await post('/files/cleanup', { dryRun: false });
    expect(blind.status).toBe(409);
    expect(blind.body.error).toBe('needs_client');
    const told = await post('/files/cleanup', { dryRun: true, referenced: [keptId] });
    expect(told.body.files.map((f: { id: string }) => f.id)).not.toContain(keptId);
  });
});

describe('encrypted uploads and drawings', () => {
  it('refuses unencrypted uploads and drawings once encryption is on, dropping a refused drawing’s parts', async () => {
    await resetLibrary();
    await turnOnEncryption();
    const plain = await upload(PNG, 'plain.png', 'image/png');
    expect(plain.status).toBe(409);
    expect(plain.body.error).toBe('encryption_required');
    const id = testId('d');
    // Refused at once, part by part: nothing readable reaches storage, even if step 3 never comes.
    for (const [part, type] of [['scene', 'application/json'], ['svg', 'image/svg+xml']]) {
      const res = await call('PUT', `/drawings/${id}/blob/${part}?rev=rev0009`, new TextEncoder().encode('x'), { headers: { 'content-type': type } });
      expect([res.status, res.body.error]).toEqual([409, 'encryption_required']);
    }
    expect(await kvKeys(`drawings/${id}/`)).toEqual([]);
    // And step 3 for a readable drawing, as before.
    expect((await call('PUT', `/drawings/${id}`, { rev: 'rev0009', size: 1 })).status).toBe(409);
  });

  it('stores an encrypted upload with no name or type, and serves it as ciphertext with its wrapped key', async () => {
    const id = testId('f');
    const sealed = cipher(48);
    const res = await uploadSealed(id, PNG, { 'x-kb-sealed': sealed, 'x-file-name': encodeURIComponent('secret plans.pdf') });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ id, name: '', mime: 'application/octet-stream', enc: true, sealed, url: `/api/files/${id}` });
    expect(res.body).not.toHaveProperty('blob');
    const file = await fetchPath(`/api/files/${id}`);
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(PNG);
    expect(file.headers.get('content-type')).toBe('application/octet-stream');
    expect(file.headers.get('content-disposition')).toMatch(/^attachment;/);
    expect(file.headers.get('x-kb-key')).toBe(sealed);
    expect(file.headers.get('etag')).toBe(`"${id}.e"`);
    expect((await fetchPath(`/api/files/${id}`, { headers: { 'if-none-match': `"${id}.e"` } })).status).toBe(304);
    // Its bytes are under a key of their own, never the plaintext's.
    const keys = await kvKeys(`files/${id}`);
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatch(new RegExp(`^files/${id}\\.e`));
    const listed = (await get('/files')).body.files.find((f: { id: string }) => f.id === id);
    expect(listed).toMatchObject({ enc: true, name: '', url: `/api/files/${id}` });
  });

  it('needs the app’s id, a wrapped key and the current key generation', async () => {
    expect((await call('POST', '/files', PNG, { headers: { 'x-kb-enc': '1', 'x-kb-sealed': cipher(48) } })).status).toBe(400);
    expect((await uploadSealed(testId('f'), PNG, { 'x-kb-sealed': 'plaintext' })).status).toBe(400);
    const stale = await uploadSealed(testId('f'), PNG, { 'x-kb-kgen': '5' });
    expect(stale.status).toBe(409);
    expect(stale.body.error).toBe('key_changed');
  });

  it('encrypts a file saved before encryption in place, once, deleting the plaintext', async () => {
    await resetLibrary();
    const before = await upload(PNG, 'old photo.png', 'image/png');
    const id = before.body.id as string;
    await turnOnEncryption();
    expect((await get('/bootstrap')).body.encryption.attachments).toEqual({ files: 1, drawings: 0 });
    const ciphertext = new Uint8Array([9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 1, 2]);
    const seal = () =>
      call('PUT', `/files/${id}/seal`, ciphertext, { headers: { 'x-kb-sealed': cipher(48), 'x-kb-kgen': '0', 'content-type': 'application/octet-stream' } });
    const first = await seal();
    expect(first.body).toMatchObject({ sealed: true, file: { id, enc: true, name: '', size: ciphertext.length } });
    const second = await seal();
    expect(second.body.sealed).toBe(false);
    const served = await fetchPath(`/api/files/${id}/old-photo.png`);
    expect(new Uint8Array(await served.arrayBuffer())).toEqual(ciphertext);
    expect(served.headers.get('x-kb-key')).toBe(first.body.file.sealed);
    // An old copy's validator never gets a 304 for the encrypted file.
    expect((await fetchPath(`/api/files/${id}`, { headers: { 'if-none-match': `"${id}"` } })).status).toBe(200);
    const keys = await kvKeys(`files/${id}`);
    expect(keys).toHaveLength(1);
    expect(keys[0]).not.toBe(`files/${id}`);
    expect((await get('/bootstrap')).body.encryption.attachments).toEqual({ files: 0, drawings: 0 });
  });

  it('saves an encrypted drawing, keeping no text, and serves its parts with the wrapped key', async () => {
    const id = testId('d');
    const sealed = cipher(32);
    const res = await saveDrawing(id, 'rev0010', 'ciphertext-svg', { enc: true, sealed, kgen: 0 });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ enc: 1, sealed, text: '' });
    const svg = await fetchPath(`/api/drawings/${id}.svg`);
    expect(await svg.text()).toBe('ciphertext-svg');
    expect(svg.headers.get('content-type')).toBe('application/octet-stream');
    expect(svg.headers.get('x-kb-key')).toBe(sealed);
    const scene = await fetchPath(`/api/drawings/${id}/scene`);
    expect(scene.headers.get('x-kb-key')).toBe(sealed);
    expect((await get('/drawings')).body.drawings.find((d: { id: string }) => d.id === id)).toMatchObject({ enc: true });
    expect((await saveDrawing(id, 'rev0011', 'x', { enc: true, sealed: 'nope', kgen: 0, base_rev: 'rev0010' })).status).toBe(400);
  });

  it('re-wraps file and drawing keys after a key replacement', async () => {
    await resetLibrary();
    const ring = await turnOnEncryption();
    const fileId = testId('f');
    await uploadSealed(fileId);
    const drawingId = testId('d');
    await saveDrawing(drawingId, 'rev0012', 'c', { enc: true, sealed: cipher(32), kgen: 0 });
    const { keyringData } = await import('./helpers');
    expect((await post('/keyring', { data: { ...keyringData(), gen: 1 }, replaces: ring.id })).status).toBe(201);
    expect((await get('/bootstrap')).body.encryption.rekey).toMatchObject({ files: 1, drawings: 1 });
    const files = (await get('/rekey/files')).body.items as Array<{ id: string }>;
    expect(files.map((f) => f.id)).toEqual([fileId]);
    expect((await post('/rekey/files', { kgen: 0, items: [{ id: fileId, sealed: cipher(48) }] })).status).toBe(409);
    const fresh = cipher(48);
    expect((await post('/rekey/files', { kgen: 1, items: [{ id: fileId, sealed: fresh }] })).body.rekeyed).toBe(1);
    expect((await post('/rekey/drawings', { kgen: 1, items: [{ id: drawingId, sealed: cipher(32) }] })).body.rekeyed).toBe(1);
    expect((await get('/bootstrap')).body.encryption.rekey).toMatchObject({ files: 0, drawings: 0 });
    expect((await fetchPath(`/api/files/${fileId}`)).headers.get('x-kb-key')).toBe(fresh);
    // Uploads under the replaced key are refused.
    expect((await uploadSealed(testId('f'))).body.error).toBe('key_changed');
  });

  it('deletes an encrypted file’s bytes with it, and in clean-up', async () => {
    const id = testId('f');
    await uploadSealed(id, PNG, { 'x-kb-kgen': '1' });
    expect(await kvKeys(`files/${id}`)).toHaveLength(1);
    expect((await del(`/files/${id}`)).status).toBe(200);
    expect(await kvKeys(`files/${id}`)).toEqual([]);
    const unused = testId('f');
    await uploadSealed(unused, PNG, { 'x-kb-kgen': '1' });
    await env.DB.prepare('UPDATE files SET created_at = ? WHERE id = ?').bind(Date.now() - 8 * 86_400_000, unused).run();
    const cleaned = await post('/files/cleanup', { dryRun: false, referenced: [], confirm: { files: [unused], drawings: [] } });
    expect(cleaned.body.files.find((f: { id: string }) => f.id === unused)).toMatchObject({ enc: true });
    expect(await kvKeys(`files/${unused}`)).toEqual([]);
  });

  it('empties the browser’s HTTP cache when asked', async () => {
    const res = await post('/cache/clear');
    expect(res.headers.get('clear-site-data')).toBe('"cache"');
  });
});
