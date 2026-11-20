// @vitest-environment jsdom
/**
 * Encrypting uploads and drawings saved before encryption (encryptAttachments in src/lib/e2ee.ts),
 * where it can go wrong: only a file or drawing whose bytes are really gone is removed, never one that
 * merely couldn't be downloaded just now; a drawing saved meanwhile on another device is left to the
 * next pass; and a library that keeps changing stops with a message rather than going on forever.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { newMasterKey } from '../../src/lib/crypto';
import { json, NOW, polyfillMatchMedia, standInServer, type StandIn } from './cov-helpers';

polyfillMatchMedia();

let apiMod: typeof import('../../src/lib/api');
let e2ee: typeof import('../../src/lib/e2ee');
let server: StandIn;

interface F {
  id: string;
  name: string;
  mime: string;
  enc: boolean;
  body: string | null;
}
interface D {
  id: string;
  rev: string;
  enc: boolean;
  scene: string | null;
  svg: string | null;
}
let files: F[];
let drawings: D[];

const notFound = () => json(404, { error: 'not_found', message: 'Not found.' });

beforeEach(async () => {
  vi.stubGlobal('BroadcastChannel', undefined);
  vi.stubGlobal('caches', { keys: async () => [], delete: async () => true });
  localStorage.clear();
  files = [];
  drawings = [];
  server = standInServer({ encryption: true });
  server.on('GET', '/api/bootstrap', () =>
    json(200, {
      me: {},
      notes: [],
      folders: [],
      encryption: { on: true, gen: 0, pending: { notes: 0, versions: 0, folders: 0 }, rekey: { notes: 0, versions: 0, folders: 0 }, attachments: { files: files.filter((f) => !f.enc).length, drawings: drawings.filter((d) => !d.enc).length } },
      serverTime: NOW,
    }),
  );
  server.on('GET', '/api/files', () =>
    json(200, { files: files.map((f) => ({ id: f.id, name: f.enc ? '' : f.name, mime: f.enc ? 'application/octet-stream' : f.mime, size: 1, storage: 'kv', created_at: NOW, note_id: null, enc: f.enc, url: `/api/files/${f.id}` })) }),
  );
  server.on('GET', /^\/api\/files\/[^/]+$/, (req) => {
    const f = files.find((x) => x.id === req.path.split('/').pop());
    return f?.body ? new Response(f.body, { headers: { 'content-type': f.mime } }) : notFound();
  });
  server.on('PUT', /^\/api\/files\/[^/]+\/seal$/, (req) => {
    const f = files.find((x) => x.id === req.path.split('/')[3])!;
    f.enc = true;
    return json(200, { sealed: true });
  });
  server.on('DELETE', /^\/api\/files\//, (req) => {
    files = files.filter((x) => x.id !== req.path.split('/').pop());
    return json(200, { ok: true });
  });
  server.on('GET', '/api/drawings', () => json(200, { drawings: drawings.map((d) => ({ id: d.id, rev: d.rev, enc: d.enc, note_id: null, storage: 'kv', size: 1, created_at: NOW, updated_at: NOW })) }));
  server.on('GET', /^\/api\/drawings\/[^/]+(\.svg|\/scene)$/, (req) => {
    const id = req.path.replace(/^\/api\/drawings\//, '').replace(/(\.svg|\/scene)$/, '');
    const d = drawings.find((x) => x.id === id);
    const part = req.path.endsWith('.svg') ? d?.svg : d?.scene;
    return part ? new Response(part, { headers: { 'content-type': 'text/plain' } }) : notFound();
  });
  server.on('PUT', /^\/api\/drawings\/[^/]+\/blob\//, () => json(200, { ok: true }));
  server.on('PUT', /^\/api\/drawings\/[^/]+$/, (req) => {
    const d = drawings.find((x) => x.id === req.path.split('/').pop())!;
    if (req.body.base_rev !== d.rev) return json(409, { error: 'drawing_conflict', message: 'Changed elsewhere.', drawing: d });
    Object.assign(d, { enc: true, rev: req.body.rev });
    return json(200, { ...d });
  });
  server.on('DELETE', /^\/api\/drawings\//, (req) => {
    drawings = drawings.filter((x) => x.id !== req.path.split('/').pop());
    return json(200, { ok: true });
  });
  server.on('POST', '/api/cache/clear', () => json(200, { ok: true }));
  vi.resetModules();
  apiMod = await import('../../src/lib/api');
  e2ee = await import('../../src/lib/e2ee');
  apiMod.setCodec(e2ee.createCodec(await newMasterKey()));
});

afterEach(() => {
  apiMod.setCodec(null);
  vi.unstubAllGlobals();
});

describe('encrypting uploads saved before encryption', () => {
  it('stops, deleting nothing, when a download fails for any reason other than the file being gone', async () => {
    files = [
      { id: 'fileAAA1', name: 'a.txt', mime: 'text/plain', enc: false, body: 'a' },
      { id: 'fileBBB2', name: 'b.txt', mime: 'text/plain', enc: false, body: 'b' },
    ];
    server.on('GET', '/api/files/fileAAA1', () => Promise.reject(new TypeError('Failed to fetch')));
    await expect(e2ee.encryptAttachments(() => undefined)).rejects.toBeInstanceOf(apiMod.NetworkError);
    expect(server.requests('DELETE', /^\/api\/files\//)).toEqual([]);
    expect(files.map((f) => f.id)).toEqual(['fileAAA1', 'fileBBB2']);

    server.on('GET', '/api/files/fileAAA1', () => json(500, { error: 'server_error', message: 'Try again.' }));
    await expect(e2ee.encryptAttachments(() => undefined)).rejects.toMatchObject({ status: 500 });
    expect(server.requests('DELETE', /^\/api\/files\//)).toEqual([]);
  });

  it('removes a drawing whose parts are gone, but not one saved encrypted meanwhile on another device', async () => {
    drawings = [
      { id: 'drawGONE', rev: 'r1', enc: false, scene: null, svg: null },
      { id: 'drawRACE', rev: 'r1', enc: false, scene: null, svg: null },
      { id: 'drawOKAY', rev: 'r1', enc: false, scene: '{"elements":[]}', svg: '<svg/>' },
    ];
    // Another device encrypts drawRACE just as this one finds its old revision gone: by the time this
    // one looks again (the third listing: the first, then one look per missing drawing), it's encrypted.
    server.on('GET', '/api/drawings', () => {
      const race = drawings.find((d) => d.id === 'drawRACE');
      if (race && server.requests('GET', '/api/drawings').length > 2) Object.assign(race, { enc: true, rev: 'r2', scene: 'x', svg: 'y' });
      return json(200, { drawings: drawings.map((d) => ({ id: d.id, rev: d.rev, enc: d.enc, note_id: null, storage: 'kv', size: 1, created_at: NOW, updated_at: NOW })) });
    });
    const result = await e2ee.encryptAttachments(() => undefined);
    expect(result).toEqual({ missing: 1 });
    expect(drawings.map((d) => [d.id, d.enc])).toEqual([
      ['drawRACE', true],
      ['drawOKAY', true],
    ]);
  });

  it('leaves a drawing saved meanwhile on another device for the next pass, which encrypts it', async () => {
    drawings = [{ id: 'drawEDIT', rev: 'r1', enc: false, scene: '{"v":1}', svg: '<svg>1</svg>' }];
    let conflicts = 0;
    server.on('PUT', '/api/drawings/drawEDIT', (req) => {
      if (conflicts++ > 0) return undefined;
      // Saved again elsewhere (still unencrypted, an older copy of Lumen) while this one was reading it.
      drawings[0].rev = 'r2';
      return json(409, { error: 'drawing_conflict', message: 'Changed elsewhere.', drawing: { ...drawings[0], base: req.body.base_rev } });
    });
    expect(await e2ee.encryptAttachments(() => undefined)).toEqual({ missing: 0 });
    expect(drawings[0]).toMatchObject({ enc: true });
    expect(server.requests('PUT', '/api/drawings/drawEDIT').map((r) => r.body.base_rev)).toEqual(['r1', 'r2']);
  });

  it('stops on any other failure to save a drawing', async () => {
    drawings = [{ id: 'drawFAIL', rev: 'r1', enc: false, scene: '{}', svg: '<svg/>' }];
    server.on('PUT', '/api/drawings/drawFAIL', () => json(413, { error: 'too_large', message: 'This drawing is too large to save.' }));
    await expect(e2ee.encryptAttachments(() => undefined)).rejects.toMatchObject({ code: 'too_large' });
    expect(drawings[0].enc).toBe(false);
  });

  it('gives up with a message when files keep changing, rather than going on forever', async () => {
    files = [{ id: 'fileLOOP', name: 'l.txt', mime: 'text/plain', enc: false, body: 'l' }];
    // The server never records it as encrypted (another device keeps putting an unencrypted one back).
    server.on('PUT', /^\/api\/files\/[^/]+\/seal$/, () => json(200, { sealed: false }));
    await expect(e2ee.encryptAttachments(() => undefined)).rejects.toThrow('Some files or drawings kept changing while they were being encrypted. Try again in a moment.');
    expect(server.requests('PUT', '/api/files/fileLOOP/seal')).toHaveLength(4);
  });

  it('once everything is encrypted, drops the plaintext copies kept for offline use, once', async () => {
    const deleted: string[] = [];
    vi.stubGlobal('caches', { keys: async () => ['lumen-app', 'lumen-files', 'lumen-data'], delete: async (k: string) => (deleted.push(k), true) });
    server.state.encryption = true;
    server.on('GET', '/api/bootstrap', () =>
      json(200, { me: {}, notes: [], folders: [], encryption: { on: true, gen: 0, pending: { notes: 0, versions: 0, folders: 0 }, attachments: { files: 0, drawings: 0 } }, serverTime: NOW }),
    );
    await apiMod.api.bootstrap();
    await apiMod.api.bootstrap();
    await vi.waitFor(() => expect(server.requests('POST', '/api/cache/clear')).toHaveLength(1));
    expect(deleted.sort()).toEqual(['lumen-data', 'lumen-files']);
    expect(apiMod.attachmentsEncrypted()).toBe(true);
  });
});
