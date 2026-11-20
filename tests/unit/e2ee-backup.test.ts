// @vitest-environment jsdom
/**
 * Encrypted backups end to end (exportBackup and restoreBackup in src/lib/backup.ts, with the vault and
 * codec): a .lumenbackup made on one device holds nothing readable, opens on that device without
 * asking, opens elsewhere with the passphrase or recovery key from when it was made, and goes back into
 * an encrypted library encrypted again with that library's key. The file format alone is covered in
 * backup.test.ts. A stand-in server keeps one library in memory; each "device" has its own storage.
 */
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Keyring } from '../../src/lib/types';

vi.mock('../../src/lib/crypto', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/lib/crypto')>()),
  PBKDF2_ITERATIONS: 2000,
}));
vi.mock('../../src/lib/saver', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/lib/saver')>()),
  flushAll: async () => undefined,
  freezeDrafts: () => undefined,
}));

window.matchMedia ??= ((query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;

const NOW = 1_700_000_000_000;
const PASS = 'home library passphrase';
const FILE_ID = 'scanfile000001';
const DRAWING_ID = 'floorplan00001';
const SECRETS = /secret diagnosis|Diagnosis|scan\.png|PNG scan bytes|floor plan|Medical|health/;

let apiMod: typeof import('../../src/lib/api');
let vault: typeof import('../../src/lib/vault');
let backup: typeof import('../../src/lib/backup');
let c: typeof import('../../src/lib/crypto');

/* ----------------------------------------------------------- the server --- */

interface Library {
  keyring: Keyring | null;
  nextId: number;
  notes: Map<string, Record<string, unknown>>;
  folders: Map<string, Record<string, unknown>>;
  files: Map<string, { info: Record<string, unknown>; body: Uint8Array }>;
  drawings: Map<string, { info: Record<string, unknown>; sealed: string; scene: Uint8Array; svg: Uint8Array }>;
  parts: Map<string, Uint8Array>;
}
const emptyLibrary = (): Library => ({ keyring: null, nextId: 1, notes: new Map(), folders: new Map(), files: new Map(), drawings: new Map(), parts: new Map() });
let lib: Library;
const writes: string[] = [];

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const bytesOf = async (body: unknown) => (body instanceof Blob ? new Uint8Array(await body.arrayBuffer()) : new TextEncoder().encode(String(body)));
const meta = ({ content: _c, ...row }: Record<string, unknown>) => row;

async function server(path: string, init: RequestInit = {}): Promise<Response> {
  const url = new URL(path, 'http://localhost');
  const method = init.method ?? 'GET';
  const p = url.pathname;
  const headers = (init.headers ?? {}) as Record<string, string>;
  const body = typeof init.body === 'string' ? JSON.parse(init.body) : init.body;
  if (method !== 'GET' && p !== '/api/keyring') writes.push(`${method} ${p}`);
  const gen = lib.keyring?.data.gen ?? 0;

  if (p === '/api/keyring' && method === 'GET') return json({ keyring: lib.keyring });
  if (p === '/api/keyring' && method === 'POST') {
    if (body.replaces !== (lib.keyring?.id ?? null)) return json({ error: 'keyring_changed', message: 'Changed.' }, 409);
    lib.keyring = { id: lib.nextId++, created_at: NOW, data: body.data };
    return json({ keyring: lib.keyring }, 201);
  }
  if (p === '/api/bootstrap') {
    return json({
      me: {},
      notes: [...lib.notes.values()].map(meta),
      folders: [...lib.folders.values()],
      encryption: { on: !!lib.keyring, pending: { notes: 0, versions: 0, folders: 0 }, attachments: { files: 0, drawings: 0 }, gen, rekey: { notes: 0, versions: 0, folders: 0 } },
      serverTime: NOW,
    });
  }
  // The server refuses anything unencrypted, and anything under an old key.
  if (method !== 'GET' && body && typeof body === 'object' && !(body instanceof Blob) && 'kgen' in body && body.kgen !== gen) {
    return json({ error: 'key_changed', message: 'Replaced.' }, 409);
  }
  if (p === '/api/notes' && method === 'POST') {
    expect(body.enc).toBe(true);
    const row = { folder_id: null, title: '', excerpt: '', info: {}, tags: [], pinned: false, version: 1, created_at: NOW, updated_at: NOW, deleted_at: null, ...body, kgen: undefined, restore: undefined };
    lib.notes.set(body.id, row);
    return json(meta(row), 201);
  }
  if (p === '/api/export/notes') return json({ notes: [...lib.notes.values()], next: null });
  if (p === '/api/folders' && method === 'POST') {
    expect(body.enc).toBe(true);
    const folder = { parent_id: null, name: '', sort: 0, created_at: NOW, updated_at: NOW, ...body, kgen: gen };
    lib.folders.set(body.id, folder);
    return json(folder, 201);
  }
  if (p === '/api/files' && method === 'GET') return json({ files: [...lib.files.values()].map((f) => f.info) });
  if (p === '/api/files' && method === 'POST') {
    expect(headers['x-kb-enc']).toBe('1');
    const id = headers['x-file-id'];
    const fileBody = await bytesOf(init.body);
    const info = { id, note_id: headers['x-note-id'] ?? null, name: '', mime: 'application/octet-stream', size: fileBody.length, storage: 'kv', created_at: NOW, enc: true, sealed: headers['x-kb-sealed'], url: `/api/files/${id}` };
    lib.files.set(id, { info, body: fileBody });
    return json(info, 201);
  }
  const file = /^\/api\/files\/([A-Za-z0-9_-]+)$/.exec(p);
  if (file && method === 'GET') {
    const f = lib.files.get(file[1]);
    if (!f) return json({ error: 'not_found', message: 'Not found.' }, 404);
    return new Response(f.body as BodyInit, { headers: { 'content-type': 'application/octet-stream', 'x-kb-key': f.info.sealed as string } });
  }
  if (p === '/api/drawings' && method === 'GET') return json({ drawings: [...lib.drawings.values()].map((d) => d.info) });
  const drawing = /^\/api\/drawings\/([A-Za-z0-9_-]+)(\.svg|\/scene|\/blob\/(scene|svg))?$/.exec(p);
  if (drawing?.[3] && method === 'PUT') {
    lib.parts.set(`${drawing[1]}:${url.searchParams.get('rev')}:${drawing[3]}`, await bytesOf(init.body));
    return json({ ok: true });
  }
  if (drawing && !drawing[2] && method === 'PUT') {
    expect(body.enc).toBe(true);
    const info = { id: drawing[1], note_id: body.note_id, rev: body.rev, storage: 'kv', size: body.size, created_at: NOW, updated_at: NOW, enc: true };
    lib.drawings.set(drawing[1], { info, sealed: body.sealed, scene: lib.parts.get(`${drawing[1]}:${body.rev}:scene`)!, svg: lib.parts.get(`${drawing[1]}:${body.rev}:svg`)! });
    return json(info);
  }
  if (drawing && method === 'GET') {
    const d = lib.drawings.get(drawing[1]);
    if (!d) return json({ error: 'not_found', message: 'Not found.' }, 404);
    return new Response((drawing[2] === '.svg' ? d.svg : d.scene) as BodyInit, { headers: { 'content-type': 'application/octet-stream', 'x-kb-key': d.sealed } });
  }
  if (p === '/api/backups/made') return json({ ok: true, at: NOW });
  return json({ error: 'not_found', message: `No route ${method} ${p}` }, 404);
}

/* ------------------------------------------------------------- devices --- */

class QuietChannel {
  postMessage() {}
  addEventListener() {}
  close() {}
}

const devices = new Map<string, { storage: Record<string, string>; idb: IDBFactory }>();
let here: string | null = null;

async function openOn(name: string) {
  if (here) {
    const storage: Record<string, string> = {};
    for (let i = 0; i < localStorage.length; i++) storage[localStorage.key(i)!] = localStorage.getItem(localStorage.key(i)!)!;
    devices.get(here)!.storage = storage;
  }
  const d = devices.get(name) ?? { storage: {}, idb: new IDBFactory() };
  devices.set(name, d);
  localStorage.clear();
  for (const [k, v] of Object.entries(d.storage)) localStorage.setItem(k, v);
  vi.stubGlobal('indexedDB', d.idb);
  here = name;
  vi.resetModules();
  apiMod = await import('../../src/lib/api');
  vault = await import('../../src/lib/vault');
  backup = await import('../../src/lib/backup');
  c = await import('../../src/lib/crypto');
  await vault.initVault();
}

/** Turns encryption on for the current library from this device; returns the recovery key. */
async function setUp(passphrase: string) {
  const prepared = await vault.prepareSetup(passphrase);
  await prepared.commit();
  return prepared.recoveryKey;
}

/** A note in a folder, with an image and a drawing, all saved through the app (so all encrypted). */
async function addContent() {
  const folder = await apiMod.api.createFolder({ name: 'Medical' });
  await apiMod.api.uploadFile(new Blob(['PNG scan bytes'], { type: 'image/png' }), 'scan.png', { id: FILE_ID });
  await apiMod.api.saveDrawing(DRAWING_ID, { scene: '{"floor plan":1}', svg: '<svg>floor plan</svg>', noteId: null, text: '' });
  await apiMod.api.createNote({
    id: 'diagnosis0001',
    title: 'Diagnosis',
    content: `secret diagnosis\n\n![scan](/api/files/${FILE_ID}/scan.png)\n\n![](/api/drawings/${DRAWING_ID}.svg)`,
    folder_id: folder.id,
    tags: ['health'],
  });
}

async function makeBackup(): Promise<File> {
  const { blob, filename, missing } = await backup.exportBackup(() => undefined, { encrypted: true });
  expect(filename).toMatch(/\.lumenbackup$/);
  expect(missing).toEqual([]);
  return new File([await blob.arrayBuffer()], filename);
}

/** What the server now holds, opened by the app on this device: the restored library. */
async function expectRestored() {
  const boot = await apiMod.api.bootstrap();
  expect(boot.folders.map((f) => f.name)).toEqual(['Medical']);
  const note = await apiMod.api.exportNotes(0);
  expect(note.notes[0]).toMatchObject({ id: 'diagnosis0001', title: 'Diagnosis', tags: ['health'], folder_id: boot.folders[0].id });
  expect(note.notes[0].content).toContain('secret diagnosis');
  const file = await apiMod.api.fileBlob(FILE_ID);
  expect(file).toMatchObject({ name: 'scan.png', mime: 'image/png' });
  expect(await file.blob.text()).toBe('PNG scan bytes');
  expect(await apiMod.api.drawingPart(DRAWING_ID, 'svg')).toBe('<svg>floor plan</svg>');
  // Stored as ciphertext only.
  const stored = JSON.stringify([...lib.notes.values(), ...lib.folders.values()]) + [...lib.files.values()].map((f) => new TextDecoder().decode(f.body)).join('');
  expect(stored).not.toMatch(SECRETS);
}

/** Empties the library on the server (as if restoring into a fresh one), keeping its keyring. */
function wipeContent() {
  const keyring = lib.keyring;
  const nextId = lib.nextId;
  lib = { ...emptyLibrary(), keyring, nextId };
}

beforeEach(() => {
  lib = emptyLibrary();
  writes.length = 0;
  devices.clear();
  here = null;
  vi.stubGlobal('fetch', vi.fn(server));
  vi.stubGlobal('BroadcastChannel', QuietChannel);
  vi.stubGlobal('location', { origin: 'http://localhost', protocol: 'http:', host: 'localhost', href: 'http://localhost/', pathname: '/', search: '', hash: '', reload() {}, replace() {} });
});

afterEach(() => {
  apiMod?.setCodec(null);
  vi.unstubAllGlobals();
});

describe('an encrypted backup', () => {
  it('holds nothing readable, and opens on the device that made it without asking', async () => {
    await openOn('laptop');
    await setUp(PASS);
    await addContent();
    const file = await makeBackup();
    const bytes = new Uint8Array(await file.arrayBuffer());
    expect(new TextDecoder().decode(bytes)).not.toMatch(SECRETS);
    expect(c.isCiphertext(new TextDecoder().decode(bytes))).toBe(false);

    wipeContent();
    const ask = vi.fn(async () => null);
    expect(await backup.restoreBackup(file, () => undefined, ask)).toEqual({ notes: 1, files: 1, drawings: 1, keptDrawings: 0, failed: [] });
    expect(ask).not.toHaveBeenCalled();
    await expectRestored();
  });

  it('opens on a new device with the passphrase from when it was made, and goes in under the new library’s key', async () => {
    await openOn('laptop');
    await setUp(PASS);
    await addContent();
    const file = await makeBackup();
    const oldKey = vault.vaultKey()!;

    // A brand-new library, encrypted with a key and passphrase of its own.
    lib = emptyLibrary();
    await openOn('new laptop');
    await setUp('a different passphrase');
    const asked: boolean[] = [];
    const answers = ['not the passphrase', PASS];
    const ask = vi.fn(async (retry: boolean) => {
      asked.push(retry);
      return answers.shift() ?? null;
    });
    expect(await backup.restoreBackup(file, () => undefined, ask)).toEqual({ notes: 1, files: 1, drawings: 1, keptDrawings: 0, failed: [] });
    expect(asked).toEqual([false, true]);
    await expectRestored();
    const row = lib.notes.get('diagnosis0001')!;
    await expect(c.decryptText(oldKey, row.content as string, 'lumen/1/note/diagnosis0001/content')).rejects.toThrow();
    expect(await c.decryptText(vault.vaultKey()!, row.content as string, 'lumen/1/note/diagnosis0001/content')).toContain('secret diagnosis');
  });

  it('opens with the recovery key from when it was made, even pasted with stray spaces', async () => {
    await openOn('laptop');
    const recoveryKey = await setUp(PASS);
    await addContent();
    const file = await makeBackup();
    lib = emptyLibrary();
    await openOn('new laptop');
    await setUp('a different passphrase');
    const ask = vi.fn(async () => ` ${recoveryKey.toLowerCase()} `);
    await backup.restoreBackup(file, () => undefined, ask);
    expect(ask).toHaveBeenCalledTimes(1);
    await expectRestored();
  });

  it('restores nothing when the person gives up after a wrong secret', async () => {
    await openOn('laptop');
    await setUp(PASS);
    await addContent();
    const file = await makeBackup();
    lib = emptyLibrary();
    await openOn('new laptop');
    await setUp('a different passphrase');
    writes.length = 0;
    const answers = ['wrong', 'also wrong', null];
    const ask = vi.fn(async () => answers.shift() ?? null);
    expect(await backup.restoreBackup(file, () => undefined, ask)).toBeNull();
    expect(ask).toHaveBeenCalledTimes(3);
    expect(writes).toEqual([]);
  });

  it('is refused, with nothing restored, when its contents were changed', async () => {
    await openOn('laptop');
    await setUp(PASS);
    await addContent();
    const bytes = new Uint8Array(await (await makeBackup()).arrayBuffer());
    bytes[bytes.length - 40] ^= 1;
    wipeContent();
    writes.length = 0;
    await expect(backup.restoreBackup(new File([bytes], 'x.lumenbackup'), () => undefined)).rejects.toThrow(/damaged/);
    expect(writes).toEqual([]);
  });

  // The right passphrase opens the file's encryption settings but not its changed key: that's a damaged
  // file, said once, not a wrong passphrase asked for again and again.
  it('whose key was changed is reported damaged once the right passphrase is given', async () => {
    await openOn('laptop');
    await setUp(PASS);
    await addContent();
    const bytes = new Uint8Array(await (await makeBackup()).arrayBuffer());
    const length = new DataView(bytes.buffer).getUint32(8);
    const header = JSON.parse(new TextDecoder().decode(bytes.subarray(12, 12 + length)));
    const k = c.fromBase64Url(header.key);
    k[k.length - 1] ^= 1;
    header.key = c.toBase64Url(k);
    const head = new TextEncoder().encode(JSON.stringify(header));
    const out = new Uint8Array(12 + head.length + bytes.length - 12 - length);
    out.set(bytes.subarray(0, 8));
    new DataView(out.buffer).setUint32(8, head.length);
    out.set(head, 12);
    out.set(bytes.subarray(12 + length), 12 + head.length);
    // A wrong passphrase first is still just asked for again; the right one then reports the damage.
    const answers = ['not it', PASS, null];
    const ask = vi.fn(async () => answers.shift() ?? null);
    writes.length = 0;
    await expect(backup.restoreBackup(new File([out], 'x.lumenbackup'), () => undefined, ask)).rejects.toThrow(/damaged.*passphrase or recovery key is right/);
    expect(ask.mock.calls).toEqual([[false], [true]]);
    expect(writes).toEqual([]);
    // A key field that isn't even base64 is damaged too, not a crash.
    header.key = '%%%';
    const head2 = new TextEncoder().encode(JSON.stringify(header));
    const out2 = new Uint8Array(12 + head2.length + bytes.length - 12 - length);
    out2.set(bytes.subarray(0, 8));
    new DataView(out2.buffer).setUint32(8, head2.length);
    out2.set(head2, 12);
    out2.set(bytes.subarray(12 + length), 12 + head2.length);
    await expect(backup.restoreBackup(new File([out2], 'x.lumenbackup'), () => undefined, async () => PASS)).rejects.toThrow(/damaged/);
  });

  it('made before the key was replaced still opens without asking on devices holding the new key', async () => {
    await openOn('laptop');
    await setUp(PASS);
    await addContent();
    const file = await makeBackup();
    await (await vault.prepareKeyReplacement(PASS)).commit();
    expect(apiMod.currentKeyGen()).toBe(1);
    wipeContent();
    const ask = vi.fn(async () => null);
    await backup.restoreBackup(file, () => undefined, ask);
    expect(ask).not.toHaveBeenCalled();
    await expectRestored();

    // Another device unlocking after the replacement holds the earlier key too.
    await openOn('phone');
    await vault.unlockWithPassphrase(PASS);
    wipeContent();
    await backup.restoreBackup(file, () => undefined, ask);
    expect(ask).not.toHaveBeenCalled();
    // Restored text goes in under the current key.
    const row = lib.notes.get('diagnosis0001')!;
    expect(await c.decryptText(vault.vaultKey()!, row.content as string, 'lumen/1/note/diagnosis0001/content')).toContain('secret diagnosis');
  });

  // README (Backups): it opens with the passphrase "you had when you made it".
  it('made before a passphrase change opens elsewhere with the old passphrase, not the new one', async () => {
    await openOn('laptop');
    await setUp(PASS);
    await addContent();
    const file = await makeBackup();
    await vault.changePassphrase(PASS, 'changed passphrase');
    lib = emptyLibrary();
    await openOn('new laptop');
    await setUp('another library');
    const answers = ['changed passphrase', PASS];
    const ask = vi.fn(async () => answers.shift() ?? null);
    await backup.restoreBackup(file, () => undefined, ask);
    expect(ask).toHaveBeenCalledTimes(2);
    await expectRestored();
  });

  it('needs this device unlocked to be made', async () => {
    await openOn('laptop');
    await setUp(PASS);
    await openOn('phone');
    writes.length = 0;
    await expect(backup.exportBackup(() => undefined, { encrypted: true })).rejects.toThrow(/Unlock Lumen/);
    expect(writes).toEqual([]);
  });

  it('leaves out a note that can’t be decrypted, names it, and holds everything else', async () => {
    await openOn('laptop');
    await setUp(PASS);
    await addContent();
    // Saved by the app (its title opens), then its text replaced with text under another key.
    await apiMod.api.createNote({ id: 'broken000001', title: 'Unlucky note', content: 'x', folder_id: null, tags: [] });
    const other = await c.newMasterKey();
    lib.notes.set('broken000001', { ...lib.notes.get('broken000001')!, content: await c.encryptText(other, 'x', 'lumen/1/note/broken000001/content') });

    const { blob, filename, missing, unreadable } = await backup.exportBackup(() => undefined, { encrypted: true });
    expect(missing).toEqual([]);
    expect(unreadable).toEqual(['Unlucky note']);

    wipeContent();
    const file = new File([await blob.arrayBuffer()], filename);
    expect(await backup.restoreBackup(file, () => undefined, async () => null)).toEqual({ notes: 1, files: 1, drawings: 1, keptDrawings: 0, failed: [] });
    await expectRestored();
  });

  it('a readable copy leaves out a note that can’t be decrypted too', async () => {
    await openOn('laptop');
    await setUp(PASS);
    await addContent();
    await apiMod.api.createNote({ id: 'broken000002', title: 'Another unlucky one', content: 'x', folder_id: null, tags: [] });
    const other = await c.newMasterKey();
    lib.notes.set('broken000002', { ...lib.notes.get('broken000002')!, content: await c.encryptText(other, 'x', 'lumen/1/note/broken000002/content') });
    const { filename, unreadable } = await backup.exportBackup(() => undefined);
    expect(filename).toMatch(/\.zip$/);
    expect(unreadable).toEqual(['Another unlucky one']);
  });
});
