// @vitest-environment jsdom
/**
 * End-to-end encryption of uploads and drawings (src/lib/e2ee.ts, src/lib/api.ts): each is encrypted
 * under a key of its own, bound to its id and part, and the server only ever receives ciphertext.
 * Runs the app's real API client and codec against a stubbed server.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { newMasterKey } from '../../src/lib/crypto';
import type { Codec } from '../../src/lib/api';

let apiModule: typeof import('../../src/lib/api');
let codec: Codec;
let key: CryptoKey;
let respond: (path: string, init: RequestInit) => Response;
const calls: Array<{ path: string; init: RequestInit }> = [];

const bytes = (...values: number[]) => new Uint8Array(values);
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

beforeEach(async () => {
  localStorage.clear();
  vi.resetModules();
  apiModule = await import('../../src/lib/api');
  const e2ee = await import('../../src/lib/e2ee');
  key = await newMasterKey();
  codec = e2ee.createCodec(key);
  apiModule.setCodec(codec);
  calls.length = 0;
  respond = () => json({ error: 'not_found', message: 'Not found.' }, 404);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (path: string, init: RequestInit = {}) => {
      calls.push({ path, init });
      return respond(path, init);
    }),
  );
});

afterEach(() => {
  apiModule.setCodec(null);
  vi.unstubAllGlobals();
});

describe('the codec', () => {
  it('encrypts a file under its own key and opens it with its name and type', async () => {
    const plain = bytes(1, 2, 3, 4, 5);
    const { body, sealed } = await codec.sealFile('file123456', plain, { name: 'scan.pdf', mime: 'application/pdf' });
    expect(body.length).toBe(plain.length + 28);
    expect(sealed).toMatch(/^e1:/);
    expect(await codec.openFileMeta('file123456', sealed)).toEqual({ name: 'scan.pdf', mime: 'application/pdf' });
    const opened = await codec.openFile('file123456', sealed, body);
    expect(opened).toEqual({ bytes: plain, name: 'scan.pdf', mime: 'application/pdf' });
  });

  it('won’t open a file as another one, or one that was changed', async () => {
    const { body, sealed } = await codec.sealFile('file123456', bytes(1, 2, 3), { name: 'a.png', mime: 'image/png' });
    await expect(codec.openFile('other12345', sealed, body)).rejects.toMatchObject({ code: 'undecryptable' });
    const tampered = body.slice();
    tampered[20] ^= 1;
    await expect(codec.openFile('file123456', sealed, tampered)).rejects.toMatchObject({ code: 'undecryptable' });
    expect(await codec.openFileMeta('other12345', sealed)).toBeNull();
  });

  it('encrypts a drawing’s parts under one key, each bound to its part', async () => {
    const sealed = await codec.sealDrawing('draw123456', { scene: '{"elements":[]}', svg: '<svg/>' });
    expect(await codec.openDrawing('draw123456', 'scene', sealed.sealed, sealed.scene)).toBe('{"elements":[]}');
    expect(await codec.openDrawing('draw123456', 'svg', sealed.sealed, sealed.svg)).toBe('<svg/>');
    await expect(codec.openDrawing('draw123456', 'svg', sealed.sealed, sealed.scene)).rejects.toMatchObject({ code: 'undecryptable' });
    await expect(codec.openDrawing('other12345', 'svg', sealed.sealed, sealed.svg)).rejects.toMatchObject({ code: 'undecryptable' });
  });
});

describe('uploading and opening files', () => {
  it('sends only ciphertext, with no name or type, and gets back the name for the note’s link', async () => {
    respond = (_path, init) => {
      const h = init.headers as Record<string, string>;
      return json({ id: h['x-file-id'], note_id: null, name: '', mime: 'application/octet-stream', size: 33, storage: 'kv', created_at: 1, enc: true, sealed: h['x-kb-sealed'], url: `/api/files/${h['x-file-id']}` }, 201);
    };
    const file = new Blob([bytes(7, 7, 7, 7, 7)], { type: 'image/png' });
    const info = await apiModule.api.uploadFile(file, 'holiday.png', { noteId: 'note123456' });
    const sent = calls[0];
    const headers = sent.init.headers as Record<string, string>;
    expect(headers['x-kb-enc']).toBe('1');
    expect(headers['x-file-name']).toBeUndefined();
    expect(headers['content-type']).toBe('application/octet-stream');
    const body = new Uint8Array(await (sent.init.body as Blob).arrayBuffer());
    expect(body.length).toBe(5 + 28);
    expect(Array.from(body.slice(12, 17))).not.toEqual([7, 7, 7, 7, 7]);
    expect(info).toMatchObject({ name: 'holiday.png', mime: 'image/png', url: `/api/files/${info.id}/holiday.png` });
  });

  it('decrypts a file it opens, asking for it by id alone', async () => {
    const { body, sealed } = await codec.sealFile('file123456', bytes(9, 8, 7), { name: 'x.txt', mime: 'text/plain' });
    respond = () => new Response(body as BodyInit, { headers: { 'content-type': 'application/octet-stream', 'x-kb-key': sealed } });
    const got = await apiModule.api.fileBlob('file123456');
    expect(calls[0].path).toBe('/api/files/file123456');
    expect(got.name).toBe('x.txt');
    expect(got.blob.type).toBe('text/plain');
    expect(new Uint8Array(await got.blob.arrayBuffer())).toEqual(bytes(9, 8, 7));
  });

  it('once every file is known to be encrypted, refuses one that isn’t (after asking the server once more)', async () => {
    respond = (path) =>
      path === '/api/bootstrap'
        ? json({ me: {}, notes: [], folders: [], encryption: { on: true, pending: { notes: 0, versions: 0, folders: 0 }, attachments: { files: 0, drawings: 0 } }, serverTime: 1 })
        : new Response(bytes(1, 2, 3) as BodyInit, { headers: { 'content-type': 'image/png' } });
    const told = vi.fn();
    apiModule.onAttachmentsEncrypted(told);
    await apiModule.api.bootstrap();
    expect(apiModule.attachmentsEncrypted()).toBe(true);
    expect(told).toHaveBeenCalledTimes(1);
    await expect(apiModule.api.fileBlob('file123456')).rejects.toMatchObject({ code: 'unencrypted' });
    expect(calls.filter((c) => c.path.startsWith('/api/files/')).map((c) => c.path.split('?')[1] ?? '')).toEqual(['', expect.stringMatching(/^fresh=/)]);
    await expect(apiModule.api.drawingPart('draw123456', 'svg')).rejects.toMatchObject({ code: 'unencrypted' });
  });

  it('still shows unencrypted files while some are left to encrypt', async () => {
    respond = () => new Response(bytes(1, 2, 3) as BodyInit, { headers: { 'content-type': 'image/png', 'content-disposition': "inline; filename*=UTF-8''pic.png" } });
    const got = await apiModule.api.fileBlob('file123456');
    expect(got).toMatchObject({ name: 'pic.png', mime: 'image/png' });
  });

  it('saves a drawing encrypted, with its wrapped key and no text', async () => {
    const bodies: Record<string, unknown> = {};
    respond = (path, init) => {
      bodies[path.split('?')[0]] = init.body;
      return json(path.includes('/blob/') ? { ok: true } : { id: 'draw123456', rev: 'r1' });
    };
    await apiModule.api.saveDrawing('draw123456', { scene: '{"secret":1}', svg: '<svg>secret</svg>', noteId: null, text: 'secret words' });
    const svg = new TextDecoder().decode(await (bodies['/api/drawings/draw123456/blob/svg'] as Blob).arrayBuffer());
    expect(svg).not.toContain('secret');
    const final = JSON.parse(bodies['/api/drawings/draw123456'] as string);
    expect(final).toMatchObject({ enc: true, text: '', kgen: 0 });
    expect(final.sealed).toMatch(/^e1:/);
  });
});
