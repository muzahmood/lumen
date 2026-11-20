/**
 * Where uploads and drawings are kept (worker/storage.ts): R2 when a bucket is bound, KV otherwise,
 * nothing at all when neither is. A file remembers where it was stored, so adding (or losing) a bucket
 * later doesn't strand what's already there. Also the races the upload and encrypt routes guard
 * against: the same file arriving twice at once, and two devices encrypting one file together.
 */
import { createExecutionContext, createScheduledController, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../../worker/index';
import { bytes, row, uploadPlain, uploadSealed, withEnv } from './api-helpers';
import { asBucket, callWith, divertedDb, MemoryR2 } from './cov-helpers';
import { cipher, get, LOCAL, resetLibrary, testId, turnOnEncryption } from './helpers';
import { deleteBlob, getBlob, KV_MAX_BYTES, maxUploadBytes, putBlob, R2_MAX_BYTES } from '../../worker/storage';

let r2: MemoryR2;
const withR2 = () => ({ FILES_BUCKET: asBucket(r2) });
const text = async (stream: ReadableStream | null) => (stream ? new TextDecoder().decode(await new Response(stream).arrayBuffer()) : null);

beforeEach(async () => {
  await resetLibrary();
  r2 = new MemoryR2();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('with an R2 bucket bound', () => {
  it('says so, with R2’s larger upload limit', async () => {
    const me = await withEnv(withR2(), `${LOCAL}/api/me`);
    expect(me.body).toMatchObject({ storage: 'r2', maxUploadBytes: R2_MAX_BYTES });
    const stats = await withEnv(withR2(), `${LOCAL}/api/stats`);
    expect(stats.body.storage).toBe('r2');
  });

  it('stores an upload in R2 (not KV), serves it from there and deletes it from there', async () => {
    const up = await callWith(withR2(), 'POST', '/files', bytes('kept in r2'), { 'content-type': 'text/plain', 'x-file-name': 'r2.txt' });
    expect(up.status).toBe(201);
    expect(up.body.storage).toBe('r2');
    const id = up.body.id as string;
    // Each upload is stored under a key of its own (files/<id>.p…), recorded in the row.
    const key = ((await row('SELECT blob FROM files WHERE id = ?', id)) as { blob: string }).blob;
    expect(key.startsWith(`files/${id}.`)).toBe(true);
    expect(r2.text(key)).toBe('kept in r2');
    expect(r2.objects.get(key)?.type).toBe('text/plain');
    expect(await env.FILES_KV!.get(key)).toBeNull();

    const served = await withEnv(withR2(), `${LOCAL}/api/files/${id}`);
    expect(served.status).toBe(200);
    expect(served.body).toBe('kept in r2');

    const gone = await callWith(withR2(), 'DELETE', `/files/${id}`);
    expect(gone.status).toBe(200);
    expect(r2.objects.has(key)).toBe(false);
    expect(await row('SELECT id FROM files WHERE id = ?', id)).toBeNull();
  });

  it('asks the bucket for just the part a video player wants, not the whole file', async () => {
    const up = await callWith(withR2(), 'POST', '/files', bytes('0123456789abcdef'), { 'content-type': 'audio/mpeg', 'x-file-name': 'song.mp3' });
    const id = up.body.id as string;
    const res = await withEnv(withR2(), `${LOCAL}/api/files/${id}`, { headers: { range: 'bytes=4-7' } });
    expect(res.status).toBe(206);
    expect(res.body).toBe('4567');
    expect(r2.ranges).toEqual([{ offset: 4, length: 4 }]);
  });

  it('keeps serving a file stored in KV before the bucket was added', async () => {
    const up = await uploadPlain(bytes('from kv days'), 'old.txt');
    expect(up.body.storage).toBe('kv');
    const served = await withEnv(withR2(), `${LOCAL}/api/files/${up.body.id}`);
    expect(served.status).toBe(200);
    expect(served.body).toBe('from kv days');
    // Deleting it goes to KV too, where it is.
    await callWith(withR2(), 'DELETE', `/files/${up.body.id}`);
    expect(await env.FILES_KV!.get(`files/${up.body.id}`)).toBeNull();
  });

  it('answers a file whose bucket was removed since as missing, not as a server error', async () => {
    const up = await callWith(withR2(), 'POST', '/files', bytes('stranded'), { 'content-type': 'text/plain', 'x-file-name': 's.txt' });
    const served = await get(`/files/${up.body.id}`);
    expect(served.status).toBe(404);
    expect(served.body).toEqual({ error: 'not_found', message: 'File content is missing from storage.' });
  });

  it('saves a drawing’s parts in R2 and drops the KV revision it replaces', async () => {
    const id = testId('d');
    const put = (overrides: Record<string, unknown>, rev: string, scene: string, svg: string) =>
      Promise.all([
        callWith(overrides, 'PUT', `/drawings/${id}/blob/scene?rev=${rev}`, bytes(scene), { 'content-type': 'application/json' }),
        callWith(overrides, 'PUT', `/drawings/${id}/blob/svg?rev=${rev}`, bytes(svg), { 'content-type': 'image/svg+xml' }),
      ]).then(() => callWith(overrides, 'PUT', `/drawings/${id}`, { rev, size: scene.length + svg.length }));
    expect((await put({}, 'kvrev1', '{"v":1}', '<svg>1</svg>')).body.storage).toBe('kv');
    const saved = await put(withR2(), 'r2rev2', '{"v":2}', '<svg>2</svg>');
    expect(saved.status).toBe(200);
    expect(saved.body.storage).toBe('r2');
    expect(r2.text(`drawings/${id}/r2rev2.svg`)).toBe('<svg>2</svg>');
    expect(await env.FILES_KV!.get(`drawings/${id}/kvrev1.svg`)).toBeNull();
    const svg = await withEnv(withR2(), `${LOCAL}/api/drawings/${id}.svg`);
    expect(svg.body).toBe('<svg>2</svg>');
    const scene = await withEnv(withR2(), `${LOCAL}/api/drawings/${id}/scene`);
    expect(scene.body).toEqual({ v: 2 });
  });

  it('still removes a file from the list when its bytes can’t be deleted, and says so in the logs', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const up = await callWith(withR2(), 'POST', '/files', bytes('stuck'), { 'content-type': 'text/plain', 'x-file-name': 'x.txt' });
    const key = ((await row('SELECT blob FROM files WHERE id = ?', up.body.id)) as { blob: string }).blob;
    r2.failDelete = true;
    const gone = await callWith(withR2(), 'DELETE', `/files/${up.body.id}`);
    expect(gone.status).toBe(200);
    expect(await row('SELECT id FROM files WHERE id = ?', up.body.id)).toBeNull();
    expect(warn).toHaveBeenCalledWith('deleteBlob failed', key, expect.any(Error));
  });
});

describe('with no file storage bound', () => {
  const none = { FILES_KV: undefined, FILES_BUCKET: undefined };

  it('says so, and refuses uploads and drawings with a clear reason', async () => {
    const me = await withEnv(none, `${LOCAL}/api/me`);
    expect(me.body).toMatchObject({ storage: null, maxUploadBytes: KV_MAX_BYTES });
    const up = await callWith(none, 'POST', '/files', bytes('nowhere'), { 'content-type': 'text/plain' });
    expect(up.status).toBe(503);
    expect(up.body.error).toBe('no_storage');
    const part = await callWith(none, 'PUT', `/drawings/${testId('d')}/blob/svg?rev=abcd1`, bytes('<svg/>'));
    expect(part.status).toBe(503);
    expect(await row('SELECT COUNT(*) AS n FROM files')).toEqual({ n: 0 });
  });

  it('the storage helpers fail loudly on writes and quietly on reads and deletes', async () => {
    const bare = { DB: env.DB } as never;
    await expect(putBlob(bare, 'kv', 'k', 'x', 'text/plain')).rejects.toThrow('KV binding FILES_KV is missing');
    await expect(putBlob(bare, 'r2', 'k', 'x', 'text/plain')).rejects.toThrow('R2 bucket binding FILES_BUCKET is missing');
    expect(await getBlob(bare, 'kv', 'k')).toBeNull();
    expect(await getBlob(bare, 'r2', 'k')).toBeNull();
    // A delete that can't be made says so (the blob stays listed to delete, and is tried again).
    await expect(deleteBlob(bare, 'r2', 'k')).resolves.toBe(false);
    await expect(deleteBlob(bare, 'kv', 'k')).resolves.toBe(false);
    expect(maxUploadBytes(bare)).toBe(KV_MAX_BYTES);
  });

  it('the storage helpers write and read R2 through the bucket', async () => {
    const e = { DB: env.DB, FILES_BUCKET: asBucket(r2) } as never;
    await putBlob(e, 'r2', 'files/abc123', 'hello', 'text/plain');
    expect(await text(await getBlob(e, 'r2', 'files/abc123'))).toBe('hello');
    await deleteBlob(e, 'r2', 'files/abc123');
    expect(await getBlob(e, 'r2', 'files/abc123')).toBeNull();
  });
});

describe('the same file arriving twice at once (a backup restored on two devices)', () => {
  // The second upload's check for an existing row misses the first one, which lands just after it.
  const raceDb = () => divertedDb((sql) => sql === 'SELECT * FROM files WHERE id = ?', null, 1);

  it('keeps the first copy of an unencrypted file, bytes and all', async () => {
    const id = testId('f');
    const first = await uploadPlain(bytes('first copy'), 'a.txt', 'text/plain', { 'x-file-id': id });
    expect(first.status).toBe(201);
    const second = await callWith({ DB: raceDb() }, 'POST', '/files', bytes('second copy'), {
      'content-type': 'text/plain',
      'x-file-name': 'a.txt',
      'x-file-id': id,
    });
    expect(second.status).toBe(200);
    expect(second.body.id).toBe(id);
    const served = await get(`/files/${id}`);
    expect(served.status).toBe(200);
    expect(served.body).toBe('first copy');
  });

  it('keeps the first copy of an encrypted file, and drops the second one’s bytes', async () => {
    await turnOnEncryption();
    const id = testId('f');
    const first = await uploadSealed(id, 0, {}, bytes('first ciphertext bytes, 40 of them......'));
    expect(first.status).toBe(201);
    const sealedFirst = first.body.sealed;
    const second = await callWith({ DB: raceDb() }, 'POST', '/files', bytes('second ciphertext bytes, also forty.....'), {
      'content-type': 'application/octet-stream',
      'x-kb-enc': '1',
      'x-file-id': id,
      'x-kb-sealed': cipher(48),
      'x-kb-kgen': '0',
    });
    expect(second.status).toBe(200);
    const served = await get(`/files/${id}`);
    expect(served.status).toBe(200);
    expect(served.headers.get('x-kb-key')).toBe(sealedFirst);
    expect(served.body).toBe('first ciphertext bytes, 40 of them......');
    // Only the winner's bytes are left in storage.
    const keys = (await env.FILES_KV!.list({ prefix: `files/${id}` })).keys.map((k) => k.name);
    expect(keys).toHaveLength(1);
  });
});

describe('two devices encrypting the same file at once', () => {
  it('the one that finishes second leaves the first one’s ciphertext in place and deletes only its own', async () => {
    const id = testId('f');
    await uploadPlain(bytes('plain text of a file'), 'p.txt', 'text/plain', { 'x-file-id': id });
    await turnOnEncryption();
    const stale = await row('SELECT * FROM files WHERE id = ?', id);
    const sealedA = cipher(48);
    const a = await callWith({}, 'PUT', `/files/${id}/seal`, bytes('ciphertext from device A........'), {
      'content-type': 'application/octet-stream',
      'x-kb-sealed': sealedA,
      'x-kb-kgen': '0',
    });
    expect(a.body.sealed).toBe(true);
    // Device B read the row while it was still unencrypted.
    const b = await callWith({ DB: divertedDb((sql) => sql === 'SELECT * FROM files WHERE id = ?', stale, 1) }, 'PUT', `/files/${id}/seal`, bytes('ciphertext from device B........'), {
      'content-type': 'application/octet-stream',
      'x-kb-sealed': cipher(48),
      'x-kb-kgen': '0',
    });
    expect(b.status).toBe(200);
    expect(b.body).toMatchObject({ sealed: false, file: { id, enc: true, sealed: sealedA } });
    const served = await get(`/files/${id}`);
    expect(served.headers.get('x-kb-key')).toBe(sealedA);
    expect(served.body).toBe('ciphertext from device A........');
    const keys = (await env.FILES_KV!.list({ prefix: `files/${id}` })).keys.map((k) => k.name);
    expect(keys).toEqual([(await row<{ blob: string }>('SELECT blob FROM files WHERE id = ?', id))!.blob]);
  });

  it('answers with no file when it was deleted meanwhile', async () => {
    const id = testId('f');
    await uploadPlain(bytes('soon gone'), 'g.txt', 'text/plain', { 'x-file-id': id });
    await turnOnEncryption();
    const stale = await row('SELECT * FROM files WHERE id = ?', id);
    await env.DB.prepare('DELETE FROM files WHERE id = ?').bind(id).run();
    const res = await callWith({ DB: divertedDb((sql) => sql === 'SELECT * FROM files WHERE id = ?', stale, 1) }, 'PUT', `/files/${id}/seal`, bytes('late ciphertext.................'), {
      'content-type': 'application/octet-stream',
      'x-kb-sealed': cipher(48),
      'x-kb-kgen': '0',
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ sealed: false, file: null });
  });
});

describe('blobs waiting to be deleted (blob_gc)', () => {
  const listed = async () =>
    (await env.DB.prepare('SELECT key, storage, due FROM blob_gc ORDER BY key').all<{ key: string; storage: string; due: number }>()).results;
  const kvHas = async (key: string) => (await env.FILES_KV.get(key)) !== null;
  /** KV that won't delete (its 1,000 a day used up, say); everything else as it is. */
  const stuckKv = () =>
    new Proxy(env.FILES_KV, {
      get(target, prop) {
        if (prop === 'delete') return async () => Promise.reject(new Error('KV delete() limit exceeded for the day.'));
        const value = Reflect.get(target, prop);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  async function runCron() {
    const ctx = createExecutionContext();
    await worker.scheduled!(createScheduledController({ scheduledTime: Date.now(), cron: '17 3 * * *' }), env, ctx);
    await waitOnExecutionContext(ctx);
  }

  it('a delete that fails leaves the blob listed, and the nightly job deletes it', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const up = await uploadPlain(bytes('delete me'));
    const key = (await row<{ blob: string }>('SELECT blob FROM files WHERE id = ?', up.body.id))!.blob;
    expect(await kvHas(key)).toBe(true);
    expect((await callWith({ FILES_KV: stuckKv() }, 'DELETE', `/files/${up.body.id}`)).status).toBe(200);
    expect((await get(`/files/${up.body.id}`)).status).toBe(404);
    // Still in storage, but not forgotten.
    expect(await kvHas(key)).toBe(true);
    expect((await listed()).map((b) => b.key)).toEqual([key]);
    await runCron();
    expect(await kvHas(key)).toBe(false);
    expect(await listed()).toEqual([]);
  });

  it('one that keeps failing waits a day each time, so it can’t hold up the rest', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await env.DB.prepare("INSERT INTO blob_gc (key, storage, due) VALUES ('files/stuck.p1', 'r2', ?)").bind(Date.now() - 1000).run();
    // No R2 bucket is bound here, so the delete can't be made.
    await runCron();
    const [stuck] = await listed();
    expect(stuck.key).toBe('files/stuck.p1');
    expect(stuck.due).toBeGreaterThan(Date.now() + 23 * 3_600_000);
  });

  it('drawing parts are listed as they arrive, kept once the drawing is saved with them, and the parts they replace go', async () => {
    const id = testId('d');
    const part = (rev: string, name: 'scene' | 'svg') =>
      callWith({}, 'PUT', `/drawings/${id}/blob/${name}?rev=${rev}`, bytes(name === 'svg' ? '<svg/>' : '{"elements":[]}'), {
        'content-type': name === 'svg' ? 'image/svg+xml' : 'application/json',
      });
    const keyOf = (rev: string, name: 'scene' | 'svg') => `drawings/${id}/${rev}.${name === 'scene' ? 'excalidraw' : 'svg'}`;
    await part('rev0001', 'scene');
    await part('rev0001', 'svg');
    // Due a day from now: a save that's on its way isn't swept from under it.
    const waiting = await listed();
    expect(waiting.map((b) => b.key).sort()).toEqual([keyOf('rev0001', 'scene'), keyOf('rev0001', 'svg')].sort());
    for (const b of waiting) expect(b.due).toBeGreaterThan(Date.now() + 23 * 3_600_000);
    await runCron();
    expect(await kvHas(keyOf('rev0001', 'svg'))).toBe(true);

    expect((await callWith({}, 'PUT', `/drawings/${id}`, { rev: 'rev0001', size: 1, base_rev: null })).status).toBe(200);
    expect(await listed()).toEqual([]);
    // A revision in use is never written over.
    const over = await part('rev0001', 'svg');
    expect([over.status, over.body.error]).toEqual([409, 'rev_in_use']);

    await part('rev0002', 'scene');
    await part('rev0002', 'svg');
    expect((await callWith({}, 'PUT', `/drawings/${id}`, { rev: 'rev0002', size: 1, base_rev: 'rev0001' })).status).toBe(200);
    // The replaced revision's parts are deleted, and nothing is left listed.
    expect(await kvHas(keyOf('rev0001', 'scene'))).toBe(false);
    expect(await kvHas(keyOf('rev0002', 'scene'))).toBe(true);
    expect(await listed()).toEqual([]);
  });

  it('parts whose save never came are swept once they’re due', async () => {
    const id = testId('d');
    await callWith({}, 'PUT', `/drawings/${id}/blob/svg?rev=rev0003`, bytes('<svg/>'), { 'content-type': 'image/svg+xml' });
    const key = `drawings/${id}/rev0003.svg`;
    await env.DB.prepare('UPDATE blob_gc SET due = ? WHERE key = ?').bind(Date.now() - 1000, key).run();
    await runCron();
    expect(await kvHas(key)).toBe(false);
    expect(await listed()).toEqual([]);
  });

  it('a refused save’s parts go at once, but never the parts the drawing shows', async () => {
    const id = testId('d');
    const parts = (rev: string) =>
      Promise.all(
        (['scene', 'svg'] as const).map((p) =>
          callWith({}, 'PUT', `/drawings/${id}/blob/${p}?rev=${rev}`, bytes('x'), { 'content-type': p === 'svg' ? 'image/svg+xml' : 'application/json' }),
        ),
      );
    await parts('rev0004');
    expect((await callWith({}, 'PUT', `/drawings/${id}`, { rev: 'rev0004', size: 1, base_rev: null })).status).toBe(200);
    // Another device saved first: this revision's parts are dropped…
    await parts('rev0005');
    expect((await callWith({}, 'PUT', `/drawings/${id}`, { rev: 'rev0005', size: 1, base_rev: 'rev0000' })).status).toBe(409);
    expect(await kvHas(`drawings/${id}/rev0005.svg`)).toBe(false);
    // …but step 3 sent again for the revision in use (its answer lost) leaves that one alone.
    expect((await callWith({}, 'PUT', `/drawings/${id}`, { rev: 'rev0004', size: 1, base_rev: 'rev0000' })).status).toBe(409);
    expect(await kvHas(`drawings/${id}/rev0004.svg`)).toBe(true);
    expect((await get('/drawings')).body.drawings.find((d: { id: string }) => d.id === id)).toMatchObject({ rev: 'rev0004' });
  });

  it('encrypting a file lists its readable copy in the same step, so a failed delete can’t strand it', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const up = await uploadPlain(bytes('readable words'));
    const id = up.body.id as string;
    const plainKey = (await row<{ blob: string }>('SELECT blob FROM files WHERE id = ?', id))!.blob;
    await turnOnEncryption();
    const sealed = await callWith({ FILES_KV: stuckKv() }, 'PUT', `/files/${id}/seal`, new Uint8Array(40).fill(7), {
      'content-type': 'application/octet-stream',
      'x-kb-sealed': cipher(48),
      'x-kb-kgen': '0',
    });
    expect(sealed.body.sealed).toBe(true);
    expect(await kvHas(plainKey)).toBe(true);
    expect((await listed()).map((b) => b.key)).toEqual([plainKey]);
    await runCron();
    expect(await kvHas(plainKey)).toBe(false);
  });
});
