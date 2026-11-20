// @vitest-environment jsdom
/**
 * Bringing notes in (src/lib/backup.ts): Markdown files made by Lumen or any other app (front matter,
 * a first heading, or the file name for the title), into the folder being viewed and encrypted like any
 * other when the library is; restoring a backup whose .zip isn't quite as expected; and the header of
 * an encrypted backup file (src/lib/sealedBackup.ts).
 */
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { strToU8, zipSync } from 'fflate';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { decryptText, newMasterKey } from '../../src/lib/crypto';
import { json, NOW, polyfillMatchMedia, standInServer, type StandIn } from './cov-helpers';

polyfillMatchMedia();

let backup: typeof import('../../src/lib/backup');
let sealedBackup: typeof import('../../src/lib/sealedBackup');
let apiMod: typeof import('../../src/lib/api');
let store: typeof import('../../src/lib/store');
let saver: typeof import('../../src/lib/saver');
let e2ee: typeof import('../../src/lib/e2ee');
let server: StandIn;
let key: CryptoKey;

const md = (name: string, text: string) => new File([text], name, { type: 'text/markdown' });
const created = () => server.requests('POST', '/api/notes').map((r) => r.body);

beforeAll(async () => {
  key = await newMasterKey();
});

beforeEach(async () => {
  vi.stubGlobal('indexedDB', new IDBFactory());
  vi.stubGlobal('BroadcastChannel', undefined);
  localStorage.clear();
  sessionStorage.clear();
  server = standInServer();
  server.on('POST', '/api/folders', (req) => json(201, { id: req.body.id, name: req.body.name, parent_id: req.body.parent_id ?? null, sort: 0, created_at: NOW, updated_at: NOW }));
  vi.resetModules();
  apiMod = await import('../../src/lib/api');
  store = await import('../../src/lib/store');
  saver = await import('../../src/lib/saver');
  e2ee = await import('../../src/lib/e2ee');
  backup = await import('../../src/lib/backup');
  sealedBackup = await import('../../src/lib/sealedBackup');
});

afterEach(() => {
  saver.discardAll();
  apiMod.setCodec(null);
  vi.unstubAllGlobals();
});

describe('importing Markdown files', () => {
  it('takes the title and tags from front matter, as other apps write it', async () => {
    const n = await backup.importMarkdownFiles(
      [md('ignored.md', '---\ntitle: \'Trip plan\'\ntags: [#travel, "2026", \'summer\']\naliases: [x]\n---\nPack light.\n')],
      () => undefined,
    );
    expect(n).toBe(1);
    expect(created()[0]).toMatchObject({ title: 'Trip plan', content: 'Pack light.\n', tags: ['travel', '2026', 'summer'] });
  });

  it('reads back the front matter Lumen itself writes, quotes and backslashes included', async () => {
    const note = { title: 'Say "hi" to C:\\Temp', tags: ['work'], created_at: NOW, updated_at: NOW };
    await backup.importMarkdownFiles([md('x.md', `${backup.frontMatter(note)}Body text\n`)], () => undefined);
    expect(created()[0]).toMatchObject({ title: 'Say "hi" to C:\\Temp', tags: ['work'], content: 'Body text\n' });
  });

  it('without front matter, a first heading becomes the title, and else the file name does', async () => {
    await backup.importMarkdownFiles(
      [md('Shopping.md', '\r\n# Groceries\r\n\r\n- [ ] milk\r\n- [ ] eggs\r\n'), md('Plain notes.TXT', 'no heading here\nsecond line')],
      () => undefined,
    );
    const [first, second] = created();
    expect(first).toMatchObject({ title: 'Groceries', content: '- [ ] milk\n- [ ] eggs\n', tags: [] });
    expect(second).toMatchObject({ title: 'Plain notes', content: 'no heading here\nsecond line' });
  });

  it('files the notes in the folder being viewed, telling the progress as it goes', async () => {
    store.useApp.setState({ filter: { kind: 'folder', id: 'fold1' } });
    const progress: Array<[string, number | undefined]> = [];
    await backup.importMarkdownFiles([md('a.md', 'a'), md('b.md', 'b')], (m, f) => progress.push([m, f]));
    expect(created().map((b) => b.folder_id)).toEqual(['fold1', 'fold1']);
    expect(progress).toEqual([
      ['Imported 1 of 2', 0.5],
      ['Imported 2 of 2', 1],
    ]);
    // The note list is refreshed afterwards.
    expect(server.requests('GET', '/api/bootstrap')).toHaveLength(1);
  });

  it('encrypts what it imports when the library is encrypted', async () => {
    apiMod.setCodec(e2ee.createCodec(key));
    await backup.importMarkdownFiles([md('secret.md', '---\ntitle: Diary\ntags: [private]\n---\nDear diary')], () => undefined);
    const [body] = created();
    expect(body).toMatchObject({ enc: true, kgen: 0 });
    expect(JSON.stringify(body)).not.toMatch(/Diary|diary|private/);
    expect(await decryptText(key, body.sealed.t, `lumen/1/note/${body.id}/title`)).toBe('Diary');
    expect(await decryptText(key, body.content, `lumen/1/note/${body.id}/content`)).toBe('Dear diary');
  });
});

describe('restoring a backup that isn’t quite as expected', () => {
  const zipOf = (entries: Record<string, string | Uint8Array>) =>
    new File([zipSync(Object.fromEntries(Object.entries(entries).map(([k, v]) => [k, typeof v === 'string' ? strToU8(v) : v]))) as BlobPart], 'backup.zip');
  const manifest = (m: Record<string, unknown>) => JSON.stringify({ format: 'kb-backup', version: 1, exported_at: NOW, folders: [], notes: [], files: [], drawings: [], ...m });

  it('says so when the .zip isn’t a Lumen backup at all', async () => {
    await expect(backup.restoreBackup(zipOf({ 'notes/a.md': 'hi' }), () => undefined)).rejects.toThrow('This zip isn’t a Lumen backup (kb-backup.json is missing).');
    await expect(backup.restoreBackup(zipOf({ 'kb-backup.json': JSON.stringify({ format: 'other' }) }), () => undefined)).rejects.toThrow('Unrecognised backup format.');
    expect(created()).toEqual([]);
  });

  it('refuses, before unpacking anything, a .zip that says it unpacks to more than a browser can hold', async () => {
    const zip = zipSync({ 'kb-backup.json': strToU8(manifest({})), 'files/big0001-x.bin': [strToU8('x'.repeat(64)), { level: 0 }] }) as Uint8Array;
    // The central directory's record of the file now claims 4 GB (a "zip bomb" states its real size).
    const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
    let patched = 0;
    for (let i = 0; i + 4 <= zip.length; i++) {
      if (view.getUint32(i, true) !== 0x02014b50) continue;
      const nameLength = view.getUint16(i + 28, true);
      const name = new TextDecoder().decode(zip.subarray(i + 46, i + 46 + nameLength));
      if (name === 'files/big0001-x.bin') {
        view.setUint32(i + 24, 0xfffffff0, true);
        patched++;
      }
    }
    expect(patched).toBe(1);
    await expect(backup.restoreBackup(new File([zip as BlobPart], 'bomb.zip'), () => undefined)).rejects.toThrow(
      'This backup unpacks to more than Lumen can restore in a browser (over 2 GB, or a file over 512 MB). Nothing was restored.',
    );
    expect(created()).toEqual([]);
    expect(server.requests('POST', '/api/folders')).toEqual([]);
  });

  it('makes parent folders before their subfolders, whatever order they’re listed in, and survives a loop', async () => {
    const folder = (id: string, parent: string | null) => ({ id, name: id, parent_id: parent, sort: 0, created_at: NOW, updated_at: NOW });
    const file = zipOf({
      'kb-backup.json': manifest({ folders: [folder('grandkid', 'kid'), folder('kid', 'top'), folder('top', null), folder('loopA', 'loopB'), folder('loopB', 'loopA')] }),
    });
    const result = await backup.restoreBackup(file, () => undefined);
    expect(result).toEqual({ notes: 0, files: 0, drawings: 0, keptDrawings: 0, failed: [] });
    const order = server.requests('POST', '/api/folders').map((r) => r.body.id);
    expect(order.indexOf('top')).toBeLessThan(order.indexOf('kid'));
    expect(order.indexOf('kid')).toBeLessThan(order.indexOf('grandkid'));
    expect(order).toHaveLength(5);
  });

  it('finds a file by its id when its name was made safe differently, and skips files and drawings that aren’t there', async () => {
    server.on('POST', '/api/files', (req) => json(201, { id: req.headers['x-file-id'], name: 'x', mime: 'image/png', url: `/api/files/${req.headers['x-file-id']}` }));
    server.on('PUT', /^\/api\/drawings\//, () => json(200, { ok: true }));
    const file = zipOf({
      'kb-backup.json': manifest({
        files: [
          { id: 'fileA1', name: '写真.png', mime: 'image/png', note_id: null },
          { id: 'fileB2', name: 'gone.png', mime: 'image/png', note_id: null },
        ],
        drawings: [
          { id: 'drawA1', note_id: null, created_at: NOW },
          { id: 'drawB2', note_id: null, created_at: NOW },
        ],
        notes: [{ id: 'note1', title: 'T', content: 'c', folder_id: null, tags: [], pinned: false, created_at: NOW, updated_at: NOW, deleted_at: null }],
      }),
      // Made safe by an older version as something else.
      'files/fileA1-image.png': new Uint8Array([1, 2, 3]),
      'drawings/drawA1.excalidraw': '{"elements":[]}',
      'drawings/drawA1.svg': '<svg/>',
      'drawings/drawB2.svg': '<svg/>', // its scene is missing
    });
    const result = await backup.restoreBackup(file, () => undefined);
    expect(result).toEqual({ notes: 1, files: 1, drawings: 1, keptDrawings: 0, failed: [] });
    expect(server.requests('POST', '/api/files').map((r) => r.headers['x-file-id'])).toEqual(['fileA1']);
    expect(server.requests('PUT', /^\/api\/drawings\/[^/]+$/).map((r) => r.path)).toEqual(['/api/drawings/drawA1']);
    expect(created()[0]).toMatchObject({ restore: true, id: 'note1' });
  });
});

describe('restoring over a library that has changed since the backup', () => {
  const zipOf = (entries: Record<string, string | Uint8Array>) =>
    new File([zipSync(Object.fromEntries(Object.entries(entries).map(([k, v]) => [k, typeof v === 'string' ? strToU8(v) : v]))) as BlobPart], 'backup.zip');
  const note = (id: string, title: string) => ({ id, title, content: `${title} text`, folder_id: null, tags: [], pinned: false, created_at: NOW, updated_at: NOW, deleted_at: null });
  const drawing = (id: string, rev: string) => ({ id, rev, note_id: null, storage: 'kv', size: 1, created_at: NOW, updated_at: NOW });
  const backupWith = (m: Record<string, unknown>, extra: Record<string, string | Uint8Array> = {}) =>
    zipOf({ 'kb-backup.json': JSON.stringify({ format: 'kb-backup', version: 1, exported_at: NOW, folders: [], notes: [], files: [], drawings: [], ...m }), ...extra });
  const drawingParts = (...ids: string[]) => Object.fromEntries(ids.flatMap((id) => [[`drawings/${id}.excalidraw`, '{"elements":[]}'], [`drawings/${id}.svg`, '<svg/>']]));

  beforeEach(() => {
    server.on('POST', '/api/notes', (req) => json(201, { ...note(req.body.id, req.body.title), version: 1 }));
    server.on('POST', '/api/files', (req) => json(201, { id: req.headers['x-file-id'], name: 'x', mime: 'image/png', url: `/api/files/${req.headers['x-file-id']}` }));
    server.on('PUT', /^\/api\/drawings\//, () => json(200, { ok: true }));
  });

  it('leaves drawings changed since alone, skips unchanged ones, and puts back only missing ones (as new)', async () => {
    server.on('GET', '/api/files', () => json(200, { files: [] }));
    server.on('GET', '/api/drawings', () => json(200, { drawings: [drawing('changed1', 'rev-new'), drawing('same0001', 'rev-a')] }));
    const result = await backup.restoreBackup(
      backupWith({ drawings: [drawing('changed1', 'rev-old'), drawing('same0001', 'rev-a'), drawing('missing1', 'rev-b')] }, drawingParts('changed1', 'same0001', 'missing1')),
      () => undefined,
    );
    expect(result).toMatchObject({ drawings: 1, keptDrawings: 1, failed: [] });
    const saved = server.requests('PUT', /^\/api\/drawings\/[^/]+$/);
    expect(saved.map((r) => r.path)).toEqual(['/api/drawings/missing1']);
    // As a new drawing: one saved meanwhile under that id is kept, not replaced.
    expect(saved[0].body).toMatchObject({ base_rev: null });
    expect(backup.restoreSummary(result!).message).toBe('Restored 0 notes, 0 files and 1 drawing. A drawing changed since the backup was made was kept as it is.');
  });

  it('counts a drawing saved meanwhile (refused as a conflict) as kept, not as a failure', async () => {
    server.on('GET', '/api/files', () => json(200, { files: [] }));
    server.on('GET', '/api/drawings', () => json(200, { drawings: [] }));
    server.on('PUT', /^\/api\/drawings\/[^/]+$/, () => json(409, { error: 'drawing_conflict', message: 'Changed on another device.' }));
    const result = await backup.restoreBackup(backupWith({ drawings: [drawing('raced001', 'rev-a')] }, drawingParts('raced001')), () => undefined);
    expect(result).toMatchObject({ drawings: 0, keptDrawings: 1, failed: [] });
  });

  it('doesn’t upload again a file that’s still there', async () => {
    server.on('GET', '/api/files', () => json(200, { files: [{ id: 'kept0001', name: 'a.png', mime: 'image/png', size: 3, url: '/api/files/kept0001' }] }));
    server.on('GET', '/api/drawings', () => json(200, { drawings: [] }));
    const result = await backup.restoreBackup(
      backupWith(
        { files: [{ id: 'kept0001', name: 'a.png', mime: 'image/png', note_id: null }, { id: 'gone0001', name: 'b.png', mime: 'image/png', note_id: null }] },
        { 'files/kept0001-a.png': new Uint8Array([1]), 'files/gone0001-b.png': new Uint8Array([2]) },
      ),
      () => undefined,
    );
    expect(server.requests('POST', '/api/files').map((r) => r.headers['x-file-id'])).toEqual(['gone0001']);
    expect(result).toMatchObject({ files: 1 });
  });

  it('puts every note back first, and lists a file that couldn’t go rather than stopping', async () => {
    server.on('GET', '/api/files', () => json(200, { files: [] }));
    server.on('GET', '/api/drawings', () => json(200, { drawings: [] }));
    let uploads = 0;
    server.on('POST', '/api/files', (req) =>
      ++uploads === 1 ? json(413, { error: 'too_large', message: 'This file is too large.' }) : json(201, { id: req.headers['x-file-id'], name: 'x', mime: 'image/png', url: '' }),
    );
    const result = await backup.restoreBackup(
      backupWith(
        { notes: [note('note0001', 'One'), note('note0002', 'Two')], files: [{ id: 'big00001', name: 'big.mov', mime: 'video/mp4', note_id: null }, { id: 'ok000001', name: 'ok.png', mime: 'image/png', note_id: null }] },
        { 'files/big00001-big.mov': new Uint8Array([1]), 'files/ok000001-ok.png': new Uint8Array([2]) },
      ),
      () => undefined,
    );
    expect(result).toMatchObject({ notes: 2, files: 1, failed: ['big.mov (This file is too large.)'] });
    const order = server.log.filter((r) => r.method === 'POST' && /^\/api\/(notes|files)$/.test(r.path)).map((r) => r.path);
    expect(order).toEqual(['/api/notes', '/api/notes', '/api/files', '/api/files']);
    expect(backup.restoreSummary(result!)).toEqual({
      message: 'Restored 2 notes, 1 file and 0 drawings. Couldn’t restore big.mov (This file is too large.).',
      kind: 'error',
    });
  });

  it('stops when today’s Cloudflare allowance is used up, saying what was done and how to finish', async () => {
    server.on('GET', '/api/files', () => json(200, { files: [] }));
    server.on('GET', '/api/drawings', () => json(200, { drawings: [] }));
    server.on('POST', '/api/files', () => json(429, { error: 'quota_exceeded', message: 'Used up.' }));
    const err = await backup
      .restoreBackup(
        backupWith(
          { notes: [note('note0001', 'One')], files: ['a', 'b', 'c'].map((n) => ({ id: `file000${n}`, name: `${n}.png`, mime: 'image/png', note_id: null })) },
          { 'files/file000a-a.png': new Uint8Array([1]), 'files/file000b-b.png': new Uint8Array([1]), 'files/file000c-c.png': new Uint8Array([1]) },
        ),
        () => undefined,
      )
      .catch((e: Error) => e);
    expect((err as Error).message).toMatch(/^The restore stopped after 1 notes, 0 files and 0 drawings: Lumen has used up today’s Cloudflare free allowance\..* Restore the same backup again to finish it\.$/);
    // It stopped at the first refusal rather than trying every file.
    expect(server.requests('POST', '/api/files')).toHaveLength(1);
  });
});

describe('the header of an encrypted backup file', () => {
  const MAGIC = 'LUMENBK1';
  function fileWith(header: string, declared = header.length) {
    const head = new TextEncoder().encode(header);
    const out = new Uint8Array(12 + head.length + 4);
    out.set(new TextEncoder().encode(MAGIC));
    new DataView(out.buffer).setUint32(8, declared);
    out.set(head, 12);
    return out;
  }

  it('is recognised by its first bytes, and anything else is left for the .zip reader', () => {
    expect(sealedBackup.readSealedBackup(new Uint8Array([0x50, 0x4b, 3, 4, 0, 0, 0, 0, 0, 0, 0, 0]))).toBeNull();
    expect(sealedBackup.readSealedBackup(new Uint8Array(4))).toBeNull();
  });

  it('that’s cut short or garbled is reported damaged', () => {
    expect(() => sealedBackup.readSealedBackup(fileWith('{"format":"lumen-backup"}', 5000))).toThrow('This backup file is incomplete or damaged.');
    expect(() => sealedBackup.readSealedBackup(fileWith('{not json'))).toThrow('This backup file is incomplete or damaged.');
  });

  it('from a newer version, or missing what it needs, says so', () => {
    for (const h of [{ format: 'lumen-backup', v: 2, key: 'x', keyring: { pass: {} } }, { format: 'lumen-backup', v: 1, key: 'x', keyring: {} }, { format: 'other', v: 1 }, null]) {
      expect(() => sealedBackup.readSealedBackup(fileWith(JSON.stringify(h))), JSON.stringify(h)).toThrow('This backup was made by a newer version of Lumen, or isn’t a Lumen backup.');
    }
  });
});
