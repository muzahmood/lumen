// @vitest-environment jsdom
/**
 * Encrypting a library for the first time (encryptLibrary) and encrypting it again after the key was
 * replaced (rekeyLibrary), both in src/lib/e2ee.ts, against an in-memory stand-in for the Worker that
 * pages, refuses and skips the way the real one does (worker/index.ts): writes only change rows still
 * plaintext (or still on an earlier key), notes only at the version read, and every write names the
 * key generation it was made with.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { decryptBytes, decryptText, encryptText, newMasterKey } from '../../src/lib/crypto';
import type { Codec } from '../../src/lib/api';
import type { Sealed } from '../../src/lib/types';

let apiMod: typeof import('../../src/lib/api');
let e2ee: typeof import('../../src/lib/e2ee');

const NOW = 1_700_000_000_000;

/* ------------------------------------------------------- the stand-in server --- */

interface SNote {
  seq: number;
  id: string;
  version: number;
  title: string;
  content: string;
  tags: string[];
  folder_id: string | null;
  enc: boolean;
  sealed: Sealed;
  kgen: number;
  /** Moved by a title or tag change, which leaves the version as it is (NOW when not set). */
  updated_at?: number;
}
interface SVersion {
  id: number;
  note_id: string;
  title: string;
  content: string;
  enc: boolean;
  sealed: Sealed;
  kgen: number;
}
interface SFolder {
  id: string;
  name: string;
  enc: boolean;
  sealed?: string;
  kgen: number;
}
interface SAttachment {
  id: string;
  enc: boolean;
  sealed: string;
  kgen: number;
  /** Stored bytes: a file's body, or a drawing's scene and svg. */
  body?: Uint8Array;
  scene?: Uint8Array;
  svg?: Uint8Array;
}

let db: { notes: SNote[]; versions: SVersion[]; folders: SFolder[]; files: SAttachment[]; drawings: SAttachment[]; gen: number; on: boolean; finished: boolean };
const calls = new Map<string, number>();
/** Requests that fail as a dropped connection: "METHOD /path" → which call (1-based). */
let breakAt: Map<string, number>;
/** Runs before the server handles a request (to change things "meanwhile"). */
let before: (route: string, body: any) => void;
const writes: Array<{ route: string; body: any }> = [];

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const keyChanged = () => json({ error: 'key_changed', message: 'Your encryption key was replaced on another device.' }, 409);
const isCipher = (v: unknown) => typeof v === 'string' && v.startsWith('e1:');

function plainLeft() {
  return { notes: db.notes.filter((n) => !n.enc).length, versions: db.versions.filter((v) => !v.enc).length, folders: db.folders.filter((f) => !f.enc).length };
}
function rekeyLeft() {
  const old = (x: { enc: boolean; kgen: number }) => x.enc && x.kgen < db.gen;
  return {
    notes: db.notes.filter(old).length,
    versions: db.versions.filter(old).length,
    folders: db.folders.filter(old).length,
    files: db.files.filter(old).length,
    drawings: db.drawings.filter(old).length,
  };
}

function server(path: string, init: RequestInit = {}): Response {
  const url = new URL(path, 'http://localhost');
  const method = init.method ?? 'GET';
  const route = `${method} ${url.pathname}`;
  const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
  const n = (calls.get(route) ?? 0) + 1;
  calls.set(route, n);
  if (breakAt.get(route) === n) throw new TypeError('Failed to fetch');
  before(route, body);
  if (method !== 'GET') writes.push({ route, body });
  const after = url.searchParams.get('after') ?? '';
  const stale = () => (body?.kgen ?? 0) !== db.gen;

  switch (route) {
    case 'GET /api/bootstrap':
      return json({
        me: {},
        notes: db.notes.map(({ seq: _s, content: _c, kgen: _k, ...m }) => ({ ...m, excerpt: '', info: {}, pinned: false, created_at: NOW, updated_at: NOW, deleted_at: null })),
        folders: db.folders.map((f) => ({ ...f, parent_id: null, sort: 0, created_at: NOW, updated_at: NOW })),
        encryption: db.on
          ? { on: true, pending: plainLeft(), gen: db.gen, rekey: rekeyLeft(), attachments: { files: db.files.filter((f) => !f.enc).length, drawings: db.drawings.filter((d) => !d.enc).length } }
          : { on: false, pending: null },
        serverTime: NOW,
      });
    case 'GET /api/export/notes': {
      const page = db.notes.filter((x) => x.seq > Number(after)).slice(0, 100);
      return json({
        notes: page.map(({ seq: _s, kgen: _k, ...x }) => ({ ...x, excerpt: '', info: {}, pinned: false, created_at: NOW, updated_at: NOW, deleted_at: null })),
        next: page.length === 100 ? page[99].seq : null,
      });
    }
    case 'POST /api/folders/seal': {
      if (stale()) return keyChanged();
      let sealed = 0;
      for (const item of body.folders) {
        const f = db.folders.find((x) => x.id === item.id && !x.enc);
        if (!f || !isCipher(item.sealed)) continue;
        Object.assign(f, { enc: true, name: '', sealed: item.sealed, kgen: db.gen });
        sealed++;
      }
      return json({ sealed });
    }
    case 'POST /api/notes/seal': {
      if (stale()) return keyChanged();
      let sealed = 0;
      for (const item of body.notes) {
        const x = db.notes.find((r) => r.id === item.id && !r.enc && r.version === item.version);
        if (!x) continue;
        expect(isCipher(item.content) && isCipher(item.sealed.t) && isCipher(item.sealed.g) && isCipher(item.sealed.p)).toBe(true);
        Object.assign(x, { enc: true, content: item.content, sealed: item.sealed, title: '', tags: [], kgen: db.gen });
        sealed++;
      }
      return json({ sealed });
    }
    case 'GET /api/versions/plain': {
      const page = db.versions.filter((v) => !v.enc && v.id > Number(after)).slice(0, 50);
      return json({ versions: page.map(({ id, note_id, title, content }) => ({ id, note_id, title, content })), next: page.length === 50 ? page[49].id : null });
    }
    case 'POST /api/versions/seal': {
      if (stale()) return keyChanged();
      let sealed = 0;
      for (const item of body.versions) {
        const i = db.versions.findIndex((v) => v.id === item.id && !v.enc);
        if (i === -1) continue;
        if (item.drop === true) db.versions.splice(i, 1);
        else Object.assign(db.versions[i], { enc: true, content: item.content, sealed: item.sealed, title: '', kgen: db.gen });
        sealed++;
      }
      return json({ sealed });
    }
    case 'POST /api/encryption/finish': {
      const left = plainLeft();
      if (left.notes || left.versions || left.folders) return json({ error: 'pending', pending: left }, 409);
      db.finished = true;
      return json({ ok: true });
    }
    case 'GET /api/rekey/notes': {
      const page = db.notes.filter((x) => x.enc && x.kgen < db.gen && x.seq > Number(after)).slice(0, 50);
      return json({
        notes: page.map(({ id, version, updated_at, content, sealed }) => ({ id, version, updated_at: updated_at ?? NOW, content, sealed })),
        next: page.length === 50 ? page[49].seq : null,
      });
    }
    case 'POST /api/rekey/notes': {
      if (stale()) return keyChanged();
      let rekeyed = 0;
      for (const item of body.notes) {
        const x = db.notes.find(
          (r) => r.id === item.id && r.enc && r.version === item.version && r.kgen < db.gen && (item.updated_at === undefined || item.updated_at === (r.updated_at ?? NOW)),
        );
        if (!x) continue;
        expect(isCipher(item.content) && isCipher(item.sealed.t) && isCipher(item.sealed.g) && isCipher(item.sealed.p)).toBe(true);
        Object.assign(x, { content: item.content, sealed: item.sealed, kgen: db.gen });
        rekeyed++;
      }
      return json({ rekeyed });
    }
    case 'GET /api/rekey/versions': {
      const page = db.versions.filter((v) => v.enc && v.kgen < db.gen && v.id > Number(after)).slice(0, 50);
      return json({ versions: page.map(({ id, note_id, content, sealed }) => ({ id, note_id, content, sealed })), next: page.length === 50 ? page[49].id : null });
    }
    case 'POST /api/rekey/versions': {
      if (stale()) return keyChanged();
      let rekeyed = 0;
      for (const item of body.versions) {
        const v = db.versions.find((r) => r.id === item.id && r.enc && r.kgen < db.gen);
        if (!v) continue;
        Object.assign(v, { content: item.content, sealed: item.sealed, kgen: db.gen });
        rekeyed++;
      }
      return json({ rekeyed });
    }
    case 'POST /api/rekey/folders': {
      if (stale()) return keyChanged();
      let rekeyed = 0;
      for (const item of body.folders) {
        const f = db.folders.find((r) => r.id === item.id && r.enc && r.kgen < db.gen);
        if (!f) continue;
        Object.assign(f, { sealed: item.sealed, kgen: db.gen });
        rekeyed++;
      }
      return json({ rekeyed });
    }
    case 'GET /api/rekey/files':
    case 'GET /api/rekey/drawings': {
      const list = route.endsWith('files') ? db.files : db.drawings;
      const page = list.filter((a) => a.enc && a.kgen < db.gen && a.id > after).sort((a, b) => (a.id < b.id ? -1 : 1)).slice(0, 100);
      return json({ items: page.map(({ id, sealed }) => ({ id, sealed })), next: page.length === 100 ? page[99].id : null });
    }
    case 'POST /api/rekey/files':
    case 'POST /api/rekey/drawings': {
      if (stale()) return keyChanged();
      const list = route.endsWith('files') ? db.files : db.drawings;
      let rekeyed = 0;
      for (const item of body.items) {
        const a = list.find((r) => r.id === item.id && r.enc && r.kgen < db.gen);
        if (!a || !isCipher(item.sealed)) continue;
        Object.assign(a, { sealed: item.sealed, kgen: db.gen });
        rekeyed++;
      }
      return json({ rekeyed });
    }
  }
  return json({ error: 'not_found', message: `No route ${route}` }, 404);
}

/* ---------------------------------------------------------------- helpers --- */

const id = (prefix: string, i: number) => `${prefix}${String(i).padStart(6, '0')}`;
const ctx = {
  content: (nid: string) => `lumen/1/note/${nid}/content`,
  title: (nid: string) => `lumen/1/note/${nid}/title`,
  tags: (nid: string) => `lumen/1/note/${nid}/tags`,
  preview: (nid: string) => `lumen/1/note/${nid}/preview`,
  folder: (fid: string) => `lumen/1/folder/${fid}/name`,
};

/** A plaintext library: `notes` notes (each with a snapshot or two), and folders. */
function plainLibrary(notes: number, versions: number) {
  let seq = 0;
  db = {
    notes: Array.from({ length: notes }, (_, i) => ({
      seq: ++seq,
      id: id('note', i),
      version: 1,
      title: `Title ${i}`,
      content: `secret body ${i} [[Title ${i + 1}]]`,
      tags: [`tag.${i}`],
      folder_id: i % 2 ? 'folder0000' : null,
      enc: false,
      sealed: {},
      kgen: 0,
    })),
    versions: Array.from({ length: versions }, (_, i) => ({ id: i + 1, note_id: id('note', i % notes), title: `Old title ${i}`, content: `old body ${i}`, enc: false, sealed: {}, kgen: 0 })),
    folders: [
      { id: 'folder0000', name: 'Medical', enc: false, kgen: 0 },
      { id: 'folder0001', name: '  Tax\nreturns ', enc: false, kgen: 0 },
      { id: 'folder0002', name: '', enc: false, kgen: 0 },
    ],
    files: [],
    drawings: [],
    gen: 0,
    on: true,
    finished: false,
  };
}

// Each with a character base64url never produces, so ciphertext can't match by chance.
const plaintextWords = /secret body|Old title|old body|Title \d|tag\.\d|Medical|Tax returns/;

function progressLog() {
  const log: Array<[number, number]> = [];
  return { log, fn: (done: number, total: number) => void log.push([done, total]) };
}

/** Expects every item on the server to open with `key` alone, under its own id and field. */
async function expectAllUnder(key: CryptoKey, original: { notes: Map<string, string>; versions: Map<number, string> }) {
  for (const n of db.notes) {
    expect(await decryptText(key, n.content, ctx.content(n.id))).toBe(original.notes.get(n.id));
    await decryptText(key, n.sealed.t!, ctx.title(n.id));
    await decryptText(key, n.sealed.g!, ctx.tags(n.id));
    expect(JSON.parse(await decryptText(key, n.sealed.p!, ctx.preview(n.id)))).toHaveProperty('l');
  }
  for (const v of db.versions) {
    expect(await decryptText(key, v.content, ctx.content(v.note_id))).toBe(original.versions.get(v.id));
    await decryptText(key, v.sealed.t!, ctx.title(v.note_id));
  }
  for (const f of db.folders) await decryptText(key, f.sealed!, ctx.folder(f.id));
}

const snapshotText = () => ({ notes: new Map(db.notes.map((n) => [n.id, n.content])), versions: new Map(db.versions.map((v) => [v.id, v.content])) });

beforeEach(async () => {
  localStorage.clear();
  vi.resetModules();
  apiMod = await import('../../src/lib/api');
  e2ee = await import('../../src/lib/e2ee');
  calls.clear();
  breakAt = new Map();
  before = () => undefined;
  writes.length = 0;
  vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => server(path, init)));
});

afterEach(() => {
  apiMod.setCodec(null);
  vi.unstubAllGlobals();
});

/* ------------------------------------------------------- encryptLibrary --- */

describe('encrypting a library for the first time', () => {
  let key: CryptoKey;
  beforeEach(async () => {
    key = await newMasterKey();
    apiMod.setCodec(e2ee.createCodec(key));
  });

  it('encrypts every folder name, note and snapshot under its own id, page after page, then finishes', async () => {
    plainLibrary(130, 70);
    const original = snapshotText();
    const titles = new Map(db.notes.map((n) => [n.id, n.title]));
    const progress = progressLog();
    await e2ee.encryptLibrary(key, progress.fn);

    expect(plainLeft()).toEqual({ notes: 0, versions: 0, folders: 0 });
    expect(db.finished).toBe(true);
    expect(JSON.stringify(db)).not.toMatch(plaintextWords);
    await expectAllUnder(key, original);
    for (const n of db.notes) {
      expect(n.version).toBe(1);
      expect(await decryptText(key, n.sealed.t!, ctx.title(n.id))).toBe(titles.get(n.id));
    }
    expect(await decryptText(key, db.folders[1].sealed!, ctx.folder('folder0001'))).toBe('Tax returns');
    expect(await decryptText(key, db.folders[2].sealed!, ctx.folder('folder0002'))).toBe('Folder');
    // Progress only goes forward, and ends complete.
    const total = 130 + 70 + 3;
    expect(progress.log[0]).toEqual([0, total]);
    expect(progress.log.at(-2)).toEqual([total, total]);
    expect(progress.log.at(-1)).toEqual([1, 1]);
    for (let i = 1; i < progress.log.length - 1; i++) expect(progress.log[i][0]).toBeGreaterThanOrEqual(progress.log[i - 1][0]);
    // The note list then opens as before.
    const boot = await apiMod.api.bootstrap();
    expect(boot.notes.find((m) => m.id === id('note', 7))).toMatchObject({ title: 'Title 7', tags: ['tag.7'], links: { n: [], w: ['title 8'] } });
    expect(boot.folders.map((f) => f.name)).toEqual(['Medical', 'Tax returns', 'Folder']);
    expect(apiMod.libraryEncrypted()).toBe(true);
  });

  it('picks up where it left off after an interruption, without encrypting anything twice', async () => {
    plainLibrary(60, 30);
    const original = snapshotText();
    breakAt.set('POST /api/notes/seal', 2);
    await expect(e2ee.encryptLibrary(key, () => undefined)).rejects.toThrow(/reach the server/);
    const doneBefore = new Set(db.notes.filter((n) => n.enc).map((n) => n.id));
    expect(doneBefore.size).toBe(25);
    expect(db.finished).toBe(false);

    writes.length = 0;
    await e2ee.encryptLibrary(key, () => undefined);
    const resent = writes.filter((w) => w.route === 'POST /api/notes/seal').flatMap((w) => w.body.notes.map((x: { id: string }) => x.id));
    expect(resent.filter((x: string) => doneBefore.has(x))).toEqual([]);
    expect(resent).toHaveLength(35);
    expect(db.finished).toBe(true);
    await expectAllUnder(key, original);
  });

  it('skips a note changed while it was being read, and encrypts it on the next pass', async () => {
    plainLibrary(5, 0);
    const original = snapshotText();
    let moved = false;
    before = (route) => {
      if (route === 'POST /api/notes/seal' && !moved) {
        moved = true;
        // Moved to another folder on another device: a new version, same text.
        Object.assign(db.notes[2], { version: 2, folder_id: 'folder0001' });
      }
    };
    await e2ee.encryptLibrary(key, () => undefined);
    expect(calls.get('GET /api/bootstrap')).toBe(3);
    expect(db.notes[2]).toMatchObject({ enc: true, version: 2 });
    await expectAllUnder(key, original);
  });

  it('gives up, saying so, when notes keep changing, leaving those still in plaintext to try again', async () => {
    plainLibrary(3, 0);
    before = (route) => {
      if (route === 'POST /api/notes/seal') db.notes[0].version++;
    };
    await expect(e2ee.encryptLibrary(key, () => undefined)).rejects.toThrow(/kept changing/);
    expect(db.notes.map((n) => n.enc)).toEqual([false, true, true]);
    expect(db.finished).toBe(false);
  });

  it('drops a snapshot too large to encrypt rather than keep it in plaintext', async () => {
    plainLibrary(2, 3);
    db.versions[1].content = 'x'.repeat(1_400_000);
    await e2ee.encryptLibrary(key, () => undefined);
    expect(db.versions.map((v) => v.id)).toEqual([1, 3]);
    expect(db.versions.every((v) => v.enc)).toBe(true);
  });

  it('stops at a note too large to encrypt, naming it, which notesTooLarge lists beforehand', async () => {
    plainLibrary(3, 0);
    Object.assign(db.notes[1], { title: 'Huge export', content: 'x'.repeat(1_400_000) });
    expect(await e2ee.notesTooLarge()).toEqual(['Huge export']);
    await expect(e2ee.encryptLibrary(key, () => undefined)).rejects.toThrow(/“Huge export” is too large/);
    expect(db.notes[1].enc).toBe(false);
    expect(db.finished).toBe(false);
  });

  it('won’t run while encryption is off', async () => {
    plainLibrary(1, 0);
    db.on = false;
    await expect(e2ee.encryptLibrary(key, () => undefined)).rejects.toThrow(/isn’t on/);
    expect(writes).toEqual([]);
  });

  it('is refused by the server, and tells the device, once the key was replaced elsewhere', async () => {
    plainLibrary(2, 0);
    db.gen = 1;
    const told = vi.fn();
    apiMod.onKeyChanged(told);
    await expect(e2ee.encryptLibrary(key, () => undefined)).rejects.toMatchObject({ code: 'key_changed' });
    expect(told).toHaveBeenCalled();
    expect(plainLeft().notes).toBe(2);
  });
});

/* -------------------------------------------------------- rekeyLibrary --- */

describe('encrypting again after the key was replaced', () => {
  let oldKey: CryptoKey;
  let newKey: CryptoKey;
  let oldCodec: Codec;
  let fileBodies: Map<string, Uint8Array>;

  /** A library encrypted under `oldKey` (generation 0), with files and drawings; then the key is replaced. */
  async function encryptedThenReplaced(notes: number, versions: number, files = 3) {
    plainLibrary(notes, versions);
    oldKey = await newMasterKey();
    newKey = await newMasterKey();
    oldCodec = e2ee.createCodec(oldKey);
    apiMod.setCodec(oldCodec);
    const original = snapshotText();
    await e2ee.encryptLibrary(oldKey, () => undefined);
    fileBodies = new Map();
    for (let i = 0; i < files; i++) {
      const fid = id('file', i);
      const { body, sealed } = await oldCodec.sealFile(fid, new TextEncoder().encode(`file bytes ${i}`), { name: `scan ${i}.pdf`, mime: 'application/pdf' });
      db.files.push({ id: fid, enc: true, sealed, kgen: 0, body });
      fileBodies.set(fid, body.slice());
      const did = id('draw', i);
      const d = await oldCodec.sealDrawing(did, { scene: `{"scene":${i}}`, svg: `<svg>${i}</svg>` });
      db.drawings.push({ id: did, enc: true, sealed: d.sealed, kgen: 0, scene: d.scene, svg: d.svg });
    }
    // The replacement: generation 1, this device on the new key with the old one kept.
    db.gen = 1;
    apiMod.setKeyGen(1);
    apiMod.setCodec(e2ee.createCodec(newKey, [oldKey]));
    writes.length = 0;
    return original;
  }

  async function expectFilesUnderNewKeyOnly() {
    const onlyNew = e2ee.createCodec(newKey);
    const onlyOld = e2ee.createCodec(oldKey);
    for (const [i, f] of db.files.entries()) {
      // The bytes are as they were; only the file's own key was wrapped again.
      expect(f.body).toEqual(fileBodies.get(f.id));
      const opened = await onlyNew.openFile(f.id, f.sealed, f.body!);
      expect(new TextDecoder().decode(opened.bytes)).toBe(`file bytes ${i}`);
      expect(opened).toMatchObject({ name: `scan ${i}.pdf`, mime: 'application/pdf' });
      expect(await onlyOld.openFileMeta(f.id, f.sealed)).toBeNull();
    }
    for (const [i, d] of db.drawings.entries()) {
      expect(await onlyNew.openDrawing(d.id, 'svg', d.sealed, d.svg!)).toBe(`<svg>${i}</svg>`);
      expect(await onlyNew.openDrawing(d.id, 'scene', d.sealed, d.scene!)).toBe(`{"scene":${i}}`);
      await expect(onlyOld.openDrawing(d.id, 'svg', d.sealed, d.svg!)).rejects.toMatchObject({ code: 'undecryptable' });
    }
  }

  it('encrypts every note, snapshot and folder name again with the new key, and wraps file and drawing keys again without touching their bytes', async () => {
    const original = await encryptedThenReplaced(60, 55);
    const progress = progressLog();
    expect(await e2ee.rekeyLibrary(progress.fn)).toEqual({ unreadable: 0 });

    expect(rekeyLeft()).toEqual({ notes: 0, versions: 0, folders: 0, files: 0, drawings: 0 });
    await expectAllUnder(newKey, original);
    // Nothing current opens with the old key any more.
    for (const n of db.notes) await expect(decryptText(oldKey, n.content, ctx.content(n.id))).rejects.toThrow();
    for (const f of db.folders) await expect(decryptText(oldKey, f.sealed!, ctx.folder(f.id))).rejects.toThrow();
    await expectFilesUnderNewKeyOnly();
    // Versions are unchanged: re-encrypting isn't an edit.
    expect(db.notes.every((n) => n.version === 1)).toBe(true);
    expect(progress.log.at(-1)).toEqual([1, 1]);
    // Every write named the new generation.
    expect(writes.every((w) => w.body.kgen === 1)).toBe(true);
  });

  it('picks up where it left off after an interruption, sending nothing twice', async () => {
    const original = await encryptedThenReplaced(60, 10);
    breakAt.set('POST /api/rekey/notes', 2);
    await expect(e2ee.rekeyLibrary(() => undefined)).rejects.toThrow(/reach the server/);
    const doneBefore = new Set(db.notes.filter((n) => n.kgen === 1).map((n) => n.id));
    expect(doneBefore.size).toBe(25);
    expect(rekeyLeft().notes).toBe(35);

    writes.length = 0;
    expect(await e2ee.rekeyLibrary(() => undefined)).toEqual({ unreadable: 0 });
    const resent = writes.filter((w) => w.route === 'POST /api/rekey/notes').flatMap((w) => w.body.notes.map((x: { id: string }) => x.id));
    expect(resent.filter((x: string) => doneBefore.has(x))).toEqual([]);
    expect(writes.filter((w) => w.route === 'POST /api/rekey/folders')).toEqual([]);
    await expectAllUnder(newKey, original);
    await expectFilesUnderNewKeyOnly();
  });

  it('a note changed meanwhile comes up again at its new version', async () => {
    const original = await encryptedThenReplaced(4, 0, 0);
    let moved = false;
    before = (route) => {
      if (route === 'POST /api/rekey/notes' && !moved) {
        moved = true;
        db.notes[1].version = 5;
      }
    };
    await e2ee.rekeyLibrary(() => undefined);
    expect(db.notes[1]).toMatchObject({ version: 5, kgen: 1 });
    await expectAllUnder(newKey, original);
  });

  it('a note whose tags changed meanwhile (same version) keeps them, and comes up again', async () => {
    const original = await encryptedThenReplaced(4, 0, 0);
    const retagged = await encryptText(newKey, JSON.stringify(['renamed']), ctx.tags(db.notes[1].id));
    let changed = false;
    before = (route) => {
      if (route === 'POST /api/rekey/notes' && !changed) {
        // Renamed on another device, already on the new key: the tags move, the version doesn't.
        changed = true;
        db.notes[1].sealed = { ...db.notes[1].sealed, g: retagged };
        db.notes[1].updated_at = NOW + 1;
      }
    };
    await e2ee.rekeyLibrary(() => undefined);
    expect(JSON.parse(await decryptText(newKey, db.notes[1].sealed.g!, ctx.tags(db.notes[1].id)))).toEqual(['renamed']);
    expect(db.notes[1].kgen).toBe(1);
    await expectAllUnder(newKey, original);
  });

  it('keeps a field no key opens exactly as it is, counts its item, and still finishes', async () => {
    const original = await encryptedThenReplaced(3, 0, 1);
    const stray = await newMasterKey();
    const damagedTitle = await encryptText(stray, 'from a reset setup', ctx.title(db.notes[0].id));
    db.notes[0].sealed.t = damagedTitle;
    db.files[0].sealed = await encryptText(stray, '{"k":"AAAA"}', `lumen/1/file/${db.files[0].id}/meta`);
    const damagedFile = db.files[0].sealed;

    expect(await e2ee.rekeyLibrary(() => undefined)).toEqual({ unreadable: 2 });
    expect(rekeyLeft()).toEqual({ notes: 0, versions: 0, folders: 0, files: 0, drawings: 0 });
    expect(db.notes[0].sealed.t).toBe(damagedTitle);
    expect(db.files[0].sealed).toBe(damagedFile);
    // The note's other fields were encrypted again all the same.
    expect(await decryptText(newKey, db.notes[0].content, ctx.content(db.notes[0].id))).toBe(original.notes.get(db.notes[0].id));
    expect(await decryptText(newKey, db.notes[0].sealed.g!, ctx.tags(db.notes[0].id))).toBe('["tag.0"]');
  });

  it('opens text from two replacements ago through the keys kept, and moves it to the newest key', async () => {
    const original = await encryptedThenReplaced(3, 2);
    const middle = newKey;
    const newest = await newMasterKey();
    db.gen = 2;
    apiMod.setKeyGen(2);
    apiMod.setCodec(e2ee.createCodec(newest, [middle, oldKey]));
    expect(await e2ee.rekeyLibrary(() => undefined)).toEqual({ unreadable: 0 });
    await expectAllUnder(newest, original);
  });

  it('stops, and tells the device, when the key is replaced again while it runs', async () => {
    await encryptedThenReplaced(30, 0, 0);
    const told = vi.fn();
    apiMod.onKeyChanged(told);
    before = (route) => {
      if (route === 'POST /api/rekey/notes') db.gen = 2;
    };
    await expect(e2ee.rekeyLibrary(() => undefined)).rejects.toMatchObject({ status: 409, code: 'key_changed' });
    expect(told).toHaveBeenCalled();
    // Nothing was written under the replaced generation.
    expect(db.notes.every((n) => n.kgen === 0)).toBe(true);
  });

  it('needs the library unlocked on this device', async () => {
    vi.resetModules();
    const fresh = await import('../../src/lib/e2ee');
    await expect(fresh.rekeyLibrary(() => undefined)).rejects.toThrow('Locked');
  });

  // README ("Replacing the key"): files and drawings keep their bytes, so the per-file key doesn't change.
  it('leaves each file’s own key as it was, so the old key and a copy of the file’s old wrapped key still open its bytes', async () => {
    await encryptedThenReplaced(1, 0, 1);
    const wrappedBefore = db.files[0].sealed;
    await e2ee.rekeyLibrary(() => undefined);
    expect(db.files[0].sealed).not.toBe(wrappedBefore);
    const { k } = JSON.parse(await decryptText(oldKey, wrappedBefore, `lumen/1/file/${db.files[0].id}/meta`)) as { k: string };
    const raw = Uint8Array.from(atob(k.replace(/-/g, '+').replace(/_/g, '/')), (ch) => ch.charCodeAt(0));
    const fileKey = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['decrypt']);
    const bytes = await decryptBytes(fileKey, db.files[0].body!, `lumen/1/file/${db.files[0].id}/body`);
    expect(new TextDecoder().decode(bytes)).toBe('file bytes 0');
  });
});
