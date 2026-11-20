// @vitest-environment jsdom
/**
 * Uploads and drawings in an encrypted library (src/lib/e2ee.ts, src/lib/api.ts): encrypting those
 * saved before encryption (encryptAttachments), each one's own key bound to its id (and a drawing's to
 * one save), and a device that has seen them all encrypted refusing any that arrive unencrypted. The
 * basics of sealing and opening one file are in attachments.test.ts; this goes further. A stand-in
 * server keeps files and drawings in memory.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { decryptText, encryptBytes, encryptText, newMasterKey, toBase64Url } from '../../src/lib/crypto';
import type { Codec } from '../../src/lib/api';

let apiMod: typeof import('../../src/lib/api');
let e2ee: typeof import('../../src/lib/e2ee');
let key: CryptoKey;
let codec: Codec;

const NOW = 1_700_000_000_000;
const utf8 = new TextEncoder();
const text = (b: Uint8Array) => new TextDecoder().decode(b);

interface SFile {
  id: string;
  name: string;
  mime: string;
  enc: boolean;
  sealed?: string;
  kgen?: number;
  body: Uint8Array | null;
}
interface SDrawing {
  id: string;
  rev: string;
  enc: boolean;
  sealed?: string;
  scene: Uint8Array | null;
  svg: Uint8Array | null;
}

let files: SFile[];
let drawings: SDrawing[];
/** Uploaded parts of drawing revisions not yet committed. */
let parts: Map<string, Uint8Array>;
let on: boolean;
const calls = new Map<string, number>();
let breakAt: Map<string, number>;
let before: (route: string) => void;
const writes: Array<{ route: string; headers: Record<string, string>; body: unknown }> = [];

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const notFound = () => json({ error: 'not_found', message: 'Not found.' }, 404);
const bytesOf = async (body: unknown) => (body instanceof Blob ? new Uint8Array(await body.arrayBuffer()) : utf8.encode(String(body)));

async function server(path: string, init: RequestInit = {}): Promise<Response> {
  const url = new URL(path, 'http://localhost');
  const method = init.method ?? 'GET';
  const p = url.pathname;
  const headers = (init.headers ?? {}) as Record<string, string>;
  const shape = p.replace(/\/api\/(files|drawings)\/[A-Za-z0-9_-]+/, '/api/$1/:id');
  const route = `${method} ${shape}`;
  const n = (calls.get(route) ?? 0) + 1;
  calls.set(route, n);
  if (breakAt.get(route) === n) throw new TypeError('Failed to fetch');
  before(route);
  if (method !== 'GET') writes.push({ route: `${method} ${p}`, headers, body: init.body });

  if (route === 'GET /api/bootstrap') {
    return json({
      me: {},
      notes: [],
      folders: [],
      encryption: on
        ? { on: true, pending: { notes: 0, versions: 0, folders: 0 }, gen: 0, attachments: { files: files.filter((f) => !f.enc).length, drawings: drawings.filter((d) => !d.enc).length } }
        : { on: false, pending: null },
      serverTime: NOW,
    });
  }
  if (route === 'GET /api/files') {
    return json({ files: files.map((f) => ({ id: f.id, note_id: null, name: f.enc ? '' : f.name, mime: f.enc ? 'application/octet-stream' : f.mime, size: f.body?.length ?? 0, storage: 'kv', created_at: NOW, enc: f.enc, sealed: f.sealed, url: `/api/files/${f.id}` })) });
  }
  const fileId = /^\/api\/files\/([A-Za-z0-9_-]+)/.exec(p)?.[1];
  if (fileId && method === 'GET') {
    const f = files.find((x) => x.id === fileId);
    if (!f?.body) return notFound();
    const h: Record<string, string> = { 'content-type': f.enc ? 'application/octet-stream' : f.mime };
    if (f.enc) h['x-kb-key'] = f.sealed!;
    else h['content-disposition'] = `inline; filename*=UTF-8''${encodeURIComponent(f.name)}`;
    return new Response(f.body as BodyInit, { headers: h });
  }
  if (fileId && method === 'PUT' && p.endsWith('/seal')) {
    const f = files.find((x) => x.id === fileId);
    if (!f) return notFound();
    if (f.enc) return json({ sealed: false });
    Object.assign(f, { enc: true, sealed: headers['x-kb-sealed'], kgen: Number(headers['x-kb-kgen']), body: await bytesOf(init.body), name: '', mime: 'application/octet-stream' });
    return json({ sealed: true });
  }
  if (fileId && method === 'DELETE') {
    files = files.filter((x) => x.id !== fileId);
    return json({ ok: true });
  }
  if (route === 'GET /api/drawings') {
    return json({ drawings: drawings.map((d) => ({ id: d.id, note_id: null, rev: d.rev, storage: 'kv', size: 1, created_at: NOW, updated_at: NOW, enc: d.enc })) });
  }
  const drawing = /^\/api\/drawings\/([A-Za-z0-9_-]+)(\.svg|\/scene|\/blob\/(scene|svg))?$/.exec(p);
  if (drawing && method === 'GET') {
    const d = drawings.find((x) => x.id === drawing[1]);
    const part = drawing[2] === '.svg' ? d?.svg : d?.scene;
    if (!d || !part) return notFound();
    return new Response(part as BodyInit, { headers: { 'content-type': 'application/octet-stream', ...(d.enc ? { 'x-kb-key': d.sealed! } : {}) } });
  }
  if (drawing?.[3] && method === 'PUT') {
    parts.set(`${drawing[1]}:${url.searchParams.get('rev')}:${drawing[3]}`, await bytesOf(init.body));
    return json({ ok: true });
  }
  if (drawing && !drawing[2] && method === 'PUT') {
    const body = JSON.parse(init.body as string);
    const d = drawings.find((x) => x.id === drawing[1]);
    if (on && body.enc !== true) return json({ error: 'encryption_required', message: 'Encrypted only.' }, 409);
    if (d && 'base_rev' in body && body.base_rev !== d.rev) return json({ error: 'drawing_conflict', message: 'Saved elsewhere.' }, 409);
    const next: SDrawing = { id: drawing[1], rev: body.rev, enc: body.enc === true, sealed: body.sealed, scene: parts.get(`${drawing[1]}:${body.rev}:scene`)!, svg: parts.get(`${drawing[1]}:${body.rev}:svg`)! };
    drawings = [...drawings.filter((x) => x.id !== next.id), next];
    return json({ id: next.id, rev: next.rev, enc: next.enc });
  }
  if (drawing && method === 'DELETE') {
    drawings = drawings.filter((x) => x.id !== drawing[1]);
    return json({ ok: true });
  }
  if (route === 'POST /api/cache/clear') return json({ ok: true });
  return notFound();
}

function plainAttachments(nFiles: number, nDrawings: number) {
  files = Array.from({ length: nFiles }, (_, i) => ({ id: `file00000${i}`, name: `passport scan ${i}.png`, mime: 'image/png', enc: false, body: utf8.encode(`PNG passport bytes ${i}`) }));
  drawings = Array.from({ length: nDrawings }, (_, i) => ({ id: `draw00000${i}`, rev: `rev${i}`, enc: false, scene: utf8.encode(`{"secret floor plan":${i}}`), svg: utf8.encode(`<svg>secret floor plan ${i}</svg>`) }));
}

const PLAIN = /passport|secret floor plan/;
const stored = () => [...files.map((f) => f.body), ...drawings.flatMap((d) => [d.scene, d.svg])].map((b) => (b ? text(b) : '')).join('\n');

beforeEach(async () => {
  localStorage.clear();
  vi.resetModules();
  apiMod = await import('../../src/lib/api');
  e2ee = await import('../../src/lib/e2ee');
  key = await newMasterKey();
  codec = e2ee.createCodec(key);
  apiMod.setCodec(codec);
  files = [];
  drawings = [];
  parts = new Map();
  on = true;
  calls.clear();
  breakAt = new Map();
  before = () => undefined;
  writes.length = 0;
  vi.stubGlobal('fetch', vi.fn(server));
});

afterEach(() => {
  apiMod.setCodec(null);
  vi.unstubAllGlobals();
});

describe('encrypting files and drawings saved before encryption', () => {
  it('encrypts each under its own id, sending only ciphertext, and they open as they were', async () => {
    plainAttachments(3, 2);
    const progress: Array<[number, number]> = [];
    expect(await e2ee.encryptAttachments((d, t) => void progress.push([d, t]))).toEqual({ missing: 0 });
    expect(files.every((f) => f.enc) && drawings.every((d) => d.enc)).toBe(true);
    expect(stored()).not.toMatch(PLAIN);
    for (const w of writes) expect(JSON.stringify(w.headers) + (typeof w.body === 'string' ? w.body : '')).not.toMatch(PLAIN);
    expect(progress.at(-1)).toEqual([1, 1]);

    for (const [i, f] of files.entries()) {
      const got = await apiMod.api.fileBlob(f.id);
      expect(got).toMatchObject({ name: `passport scan ${i}.png`, mime: 'image/png' });
      expect(text(new Uint8Array(await got.blob.arrayBuffer()))).toBe(`PNG passport bytes ${i}`);
    }
    expect(await apiMod.api.drawingPart('draw000001', 'svg')).toBe('<svg>secret floor plan 1</svg>');
    expect(await apiMod.api.getDrawingScene('draw000000')).toEqual({ 'secret floor plan': 0 });
    // Each under a key of its own.
    const keys = await Promise.all(files.map(async (f) => JSON.parse(await decryptText(key, f.sealed!, `lumen/1/file/${f.id}/meta`)).k));
    expect(new Set(keys).size).toBe(3);
    // Once nothing is left unencrypted the device remembers it.
    await apiMod.api.bootstrap();
    expect(apiMod.attachmentsEncrypted()).toBe(true);
  });

  it('removes and counts a file whose bytes were already gone, but not one another device encrypted meanwhile', async () => {
    plainAttachments(3, 0);
    files[0].body = null;
    let raced = false;
    before = (route) => {
      // Another device encrypts file 1 just after this one listed it.
      if (route === 'GET /api/files/:id' && !raced && calls.get(route) === 2) {
        raced = true;
        Object.assign(files.find((f) => f.id === 'file000001')!, { enc: true, sealed: 'e1:fromotherdevice', body: null });
      }
    };
    expect(await e2ee.encryptAttachments(() => undefined)).toEqual({ missing: 1 });
    expect(files.map((f) => f.id)).toEqual(['file000001', 'file000002']);
    expect(files[0].sealed).toBe('e1:fromotherdevice');
    expect(files[1].enc).toBe(true);
  });

  it('picks up where it left off after an interruption', async () => {
    plainAttachments(4, 1);
    breakAt.set('PUT /api/files/:id/seal', 3);
    await expect(e2ee.encryptAttachments(() => undefined)).rejects.toThrow(/reach the server/);
    expect(files.map((f) => f.enc)).toEqual([true, true, false, false]);
    writes.length = 0;
    await e2ee.encryptAttachments(() => undefined);
    expect(writes.filter((w) => w.route.endsWith('/seal')).map((w) => w.route)).toEqual(['PUT /api/files/file000002/seal', 'PUT /api/files/file000003/seal']);
    expect(stored()).not.toMatch(PLAIN);
  });

  it('leaves a drawing saved meanwhile on another device as that device saved it', async () => {
    plainAttachments(0, 1);
    const theirs = await codec.sealDrawing('draw000000', { scene: '{"theirs":1}', svg: '<svg>theirs</svg>' });
    before = (route) => {
      if (route === 'PUT /api/drawings/:id' && !drawings[0].enc) {
        drawings[0] = { id: 'draw000000', rev: 'theirs1', enc: true, sealed: theirs.sealed, scene: theirs.scene, svg: theirs.svg };
      }
    };
    await e2ee.encryptAttachments(() => undefined);
    expect(drawings[0].rev).toBe('theirs1');
    expect(await apiMod.api.drawingPart('draw000000', 'svg')).toBe('<svg>theirs</svg>');
  });

  it('needs the library unlocked, and encryption on', async () => {
    plainAttachments(1, 0);
    on = false;
    await expect(e2ee.encryptAttachments(() => undefined)).rejects.toThrow(/isn’t on/);
    apiMod.setCodec(null);
    await expect(e2ee.encryptAttachments(() => undefined)).rejects.toThrow('Locked');
    expect(files[0].enc).toBe(false);
  });
});

describe('a file’s own key', () => {
  async function upload(id: string, content: string, name: string) {
    const { body, sealed } = await codec.sealFile(id, utf8.encode(content), { name, mime: 'text/plain' });
    files.push({ id, name: '', mime: 'application/octet-stream', enc: true, sealed, body });
  }

  it('opens only the file it was made for: a key or body served for another file opens nothing', async () => {
    await upload('filea00001', 'alpha', 'a.txt');
    await upload('fileb00001', 'bravo', 'b.txt');
    const [a, b] = files;
    // The server swaps the wrapped keys (and names) of two files.
    [a.sealed, b.sealed] = [b.sealed, a.sealed];
    await expect(apiMod.api.fileBlob('filea00001')).rejects.toMatchObject({ code: 'undecryptable' });
    // Or serves b's whole file (key and bytes) for a.
    [a.sealed, b.sealed] = [b.sealed, a.sealed];
    const aBody = a.body;
    a.body = b.body;
    a.sealed = b.sealed;
    await expect(apiMod.api.fileBlob('filea00001')).rejects.toMatchObject({ code: 'undecryptable' });
    a.body = aBody;
    expect((await apiMod.api.listFiles()).files.find((f) => f.id === 'filea00001')).toMatchObject({ name: 'Encrypted file' });
  });

  it('must be a 256-bit key', async () => {
    const weak = crypto.getRandomValues(new Uint8Array(16));
    const k = await crypto.subtle.importKey('raw', weak, 'AES-GCM', false, ['encrypt']);
    const body = await encryptBytes(k, utf8.encode('weakly encrypted'), 'lumen/1/file/filew00001/body');
    const sealed = await encryptText(key, JSON.stringify({ k: toBase64Url(weak), n: 'w.txt', t: 'text/plain' }), 'lumen/1/file/filew00001/meta');
    await expect(codec.openFile('filew00001', sealed, body)).rejects.toMatchObject({ code: 'undecryptable' });
  });

  it('can’t be opened while the device is locked', async () => {
    await upload('filea00001', 'alpha', 'a.txt');
    apiMod.setCodec(null);
    await expect(apiMod.api.fileBlob('filea00001')).rejects.toMatchObject({ status: 423, code: 'locked' });
    await expect(apiMod.api.drawingPart('filea00001', 'svg')).rejects.toMatchObject({ status: 404 });
  });
});

describe('a drawing’s own key', () => {
  it('is new with every save, so the parts of different saves don’t open together', async () => {
    const first = await codec.sealDrawing('draw000001', { scene: '{"v":1}', svg: '<svg>1</svg>' });
    const second = await codec.sealDrawing('draw000001', { scene: '{"v":2}', svg: '<svg>2</svg>' });
    const k1 = JSON.parse(await decryptText(key, first.sealed, 'lumen/1/drawing/draw000001/key')).k;
    const k2 = JSON.parse(await decryptText(key, second.sealed, 'lumen/1/drawing/draw000001/key')).k;
    expect(k1).not.toBe(k2);
    expect(await codec.openDrawing('draw000001', 'svg', second.sealed, second.svg)).toBe('<svg>2</svg>');
    await expect(codec.openDrawing('draw000001', 'svg', first.sealed, second.svg)).rejects.toMatchObject({ code: 'undecryptable' });
    await expect(codec.openDrawing('draw000001', 'scene', second.sealed, first.scene)).rejects.toMatchObject({ code: 'undecryptable' });
  });

  it('isn’t a file’s key: one can’t be passed off as the other', async () => {
    const d = await codec.sealDrawing('same000001', { scene: '{}', svg: '<svg/>' });
    const f = await codec.sealFile('same000001', utf8.encode('<svg/>'), { name: 'x.svg', mime: 'image/svg+xml' });
    expect(await codec.openFileMeta('same000001', d.sealed)).toBeNull();
    await expect(codec.openDrawing('same000001', 'svg', f.sealed, f.body)).rejects.toMatchObject({ code: 'undecryptable' });
  });
});

describe('once every file and drawing is known to be encrypted', () => {
  it('the device remembers it across page loads and refuses one that arrives unencrypted', async () => {
    plainAttachments(1, 1);
    await e2ee.encryptAttachments(() => undefined);
    await apiMod.api.bootstrap();
    expect(localStorage.getItem('kb.vault.attachments')).toBe('1');

    // A page load later, the server serves plaintext again.
    vi.resetModules();
    apiMod = await import('../../src/lib/api');
    e2ee = await import('../../src/lib/e2ee');
    apiMod.setCodec(e2ee.createCodec(key));
    plainAttachments(1, 1);
    await expect(apiMod.api.fileBlob('file000000')).rejects.toMatchObject({ code: 'unencrypted' });
    await expect(apiMod.api.drawingPart('draw000000', 'scene')).rejects.toMatchObject({ code: 'unencrypted' });
    expect((await apiMod.api.assetBytes('/api/files/file000000/x.png').catch((e) => e)).code).toBe('unencrypted');
  });

  it('a device that hasn’t seen them all encrypted still shows the ones left', async () => {
    plainAttachments(1, 0);
    files.push({ id: 'filex00001', name: '', mime: 'application/octet-stream', enc: true, sealed: 'e1:x', body: utf8.encode('x') });
    await apiMod.api.bootstrap();
    expect(apiMod.attachmentsEncrypted()).toBe(false);
    expect((await apiMod.api.fileBlob('file000000')).name).toBe('passport scan 0.png');
  });
});

describe('showing attachments on the device (assets.ts)', () => {
  let assets: typeof import('../../src/lib/assets');
  const blobs = new Map<string, Blob>();
  let opened: Array<{ opener: unknown; location: { href: string }; closed: boolean; close: () => void }>;
  let downloads: Array<{ href: string; name: string }>;

  beforeEach(async () => {
    assets = await import('../../src/lib/assets');
    blobs.clear();
    opened = [];
    downloads = [];
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: (b: Blob) => {
        const url = `blob:http://localhost/${blobs.size + 1}`;
        blobs.set(url, b);
        return url;
      },
    });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: () => undefined });
    vi.stubGlobal('open', () => {
      const tab = { opener: 'lumen' as unknown, location: { href: 'about:blank' }, closed: false, close: () => void (tab.closed = true) };
      opened.push(tab);
      return tab;
    });
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      downloads.push({ href: this.getAttribute('href')!, name: this.download });
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function upload(id: string, content: string, name: string, mime: string) {
    const { body, sealed } = await codec.sealFile(id, utf8.encode(content), { name, mime });
    files.push({ id, name: '', mime: 'application/octet-stream', enc: true, sealed, body });
  }

  it('decrypts an image once, by id alone, and serves later uses from memory', async () => {
    await upload('imagea0001', 'PNG pixels', 'holiday.png', 'image/png');
    const url = await assets.resolveAsset('/api/files/imagea0001/holiday.png');
    expect(await assets.resolveAsset('/api/files/imagea0001/holiday.png')).toBe(url);
    expect(calls.get('GET /api/files/:id')).toBe(1);
    expect(blobs.get(url)!.type).toBe('image/png');
    expect(await blobs.get(url)!.text()).toBe('PNG pixels');
    expect(assets.cachedAssetUrl('/api/files/imagea0001')).toBe(url);
  });

  it('leaves addresses on other sites alone', async () => {
    expect(assets.assetRef('https://elsewhere.example/api/files/imagea0001')).toBeNull();
    expect(await assets.resolveAsset('https://elsewhere.example/api/files/imagea0001')).toBe('https://elsewhere.example/api/files/imagea0001');
    expect(calls.size).toBe(0);
  });

  it('opens a decrypted PDF in a new tab cut off from Lumen', async () => {
    await upload('pdfa000001', '%PDF-1.7', 'report.pdf', 'application/pdf');
    assets.openAsset('/api/files/pdfa000001/report.pdf');
    await vi.waitFor(() => expect(opened[0]?.location.href).toMatch(/^blob:/));
    expect(opened[0].opener).toBeNull();
    expect(blobs.get(opened[0].location.href)!.type).toBe('application/pdf');
    expect(downloads).toEqual([]);
  });

  it('downloads, never opens as a page, a decrypted file that could run script, whatever its name says', async () => {
    await upload('htmla00001', '<script>steal()</script>', 'innocent.png', 'text/html');
    await upload('svga000001', '<svg onload="steal()"/>', 'logo.svg', 'image/svg+xml');
    assets.openAsset('/api/files/htmla00001/innocent.png');
    assets.openAsset('/api/files/svga000001/logo.svg');
    await vi.waitFor(() => expect(downloads).toHaveLength(2));
    expect(downloads.map((d) => d.name).sort()).toEqual(['innocent.png', 'logo.svg']);
    // The .png name opened a tab while the click counted; it closed again once the type was known.
    expect(opened).toHaveLength(1);
    expect(opened[0].closed).toBe(true);
    expect(opened[0].location.href).toBe('about:blank');
  });

  it('says why an attachment can’t be shown', async () => {
    await upload('lockeda001', 'x', 'x.png', 'image/png');
    files.push({ id: 'plaina0001', name: 'p.png', mime: 'image/png', enc: false, body: utf8.encode('p') });
    localStorage.setItem('kb.vault.attachments', '1');
    const why = (src: string) => assets.resolveAsset(src).then(() => 'shown', assets.assetError);
    expect(await why('/api/files/plaina0001')).toBe('Unencrypted file (not shown)');
    expect(await why('/api/files/missing001')).toBe('File not found');
    files[0].sealed = await encryptText(await newMasterKey(), '{}', 'lumen/1/file/lockeda001/meta');
    expect(await why('/api/files/lockeda001')).toBe('Can’t decrypt this file');
  });
});
