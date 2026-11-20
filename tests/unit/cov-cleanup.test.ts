// @vitest-environment jsdom
/**
 * What only the device can work out once notes are encrypted (src/lib/e2ee.ts): which uploads and
 * drawings are still in use, for "remove unused files" (a file missed here is offered for deletion),
 * and which notes link to a note (backlinks). Runs the app's real API client, store, on-device copy and
 * codec against a stand-in server.
 */
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { encryptText, newMasterKey, toBase64Url } from '../../src/lib/crypto';
import { json, NOW, plainRow, polyfillMatchMedia, sealedRow, standInServer, type StandIn } from './cov-helpers';

polyfillMatchMedia();

let apiMod: typeof import('../../src/lib/api');
let store: typeof import('../../src/lib/store');
let saver: typeof import('../../src/lib/saver');
let e2ee: typeof import('../../src/lib/e2ee');
let key: CryptoKey;
let otherKey: CryptoKey;
let server: StandIn;
let tabSeq = 0;

beforeAll(async () => {
  key = await newMasterKey();
  otherKey = await newMasterKey();
});

beforeEach(async () => {
  vi.stubGlobal('indexedDB', new IDBFactory());
  vi.stubGlobal('BroadcastChannel', undefined);
  localStorage.clear();
  sessionStorage.clear();
  sessionStorage.setItem('kb.tab-id', `covtab${++tabSeq}`);
  server = standInServer({ encryption: true });
  vi.resetModules();
  apiMod = await import('../../src/lib/api');
  store = await import('../../src/lib/store');
  saver = await import('../../src/lib/saver');
  await import('../../src/lib/library');
  e2ee = await import('../../src/lib/e2ee');
});

afterEach(() => {
  saver.discardAll();
  apiMod.setCodec(null);
  vi.unstubAllGlobals();
});

function unlock() {
  apiMod.setKeyGen(0);
  apiMod.setCodec(e2ee.createCodec(key));
}

async function add(id: string, opts: Parameters<typeof sealedRow>[2] = {}) {
  server.rows.set(id, await sealedRow(key, id, opts));
}

/** An encrypted upload's wrapped key, with its name and type, as the app makes it. */
async function sealedFileMeta(id: string, name: string, mime: string) {
  const k = toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
  return encryptText(key, JSON.stringify({ k, n: name, t: mime }), `lumen/1/file/${id}/meta`);
}

/* --------------------------------------------- remove unused files --- */

describe('finding unused files (Settings → Data → Remove unused files)', () => {
  let cleanupBodies: Array<{ dryRun: boolean; referenced: string[]; confirm?: { files: string[]; drawings: string[] } }>;
  let versions: Array<Record<string, unknown>>;
  let cleanup: typeof import('../../src/lib/cleanup');

  beforeEach(async () => {
    cleanupBodies = [];
    versions = [];
    cleanup = await import('../../src/lib/cleanup');
    server.on('POST', '/api/files/cleanup', async (req) => {
      cleanupBodies.push(req.body);
      return json(200, {
        dryRun: req.body.dryRun,
        files: [
          { id: 'unusedA1', name: '', size: 10, enc: true, sealed: await sealedFileMeta('unusedA1', 'holiday.jpg', 'image/jpeg') },
          { id: 'unusedB1', name: '', size: 20, enc: true, sealed: 'e1:not-a-real-ciphertext' },
          { id: 'plainC1', name: 'old.txt', size: 3 },
        ],
        drawings: [{ id: 'drawX1', size: 5 }],
        bytes: 38,
      });
    });
    server.on('GET', '/api/versions/export', () => json(200, { versions, next: null }));
  });

  /** A saved version of `noteId`, encrypted as the app keeps one (the note's own contexts). */
  async function sealedVersion(id: number, noteId: string, content: string, k = key) {
    return {
      id,
      note_id: noteId,
      title: '',
      created_at: NOW,
      enc: true,
      content: await encryptText(k, content, `lumen/1/note/${noteId}/content`),
      sealed: { t: await encryptText(k, 'Old title', `lumen/1/note/${noteId}/title`) },
    };
  }

  it('sends every file and drawing any note links to, trashed notes and unsent edits included', async () => {
    unlock();
    await add('n1', { content: 'A photo ![a](/api/files/fileAAA1/a.png) and ![sketch](/api/drawings/drawAAA1.svg?v=3)' });
    await add('n2', { content: 'Old invoice [pdf](/api/files/fileTRASH1/x.pdf)', deleted_at: NOW });
    await add('n3', { content: 'Scene link /api/drawings/drawSCN1/scene in text' });
    await add('n4', { content: 'Nothing attached here' });
    // An edit not yet sent, left by another tab.
    localStorage.setItem('kb.draft.n4~othertab', JSON.stringify({ content: 'Now with ![new](/api/files/fileDRAFT1/new.png)', baseVersion: 1, at: NOW }));

    const result = await cleanup.findUnusedFiles();
    expect(cleanupBodies).toHaveLength(1);
    expect(cleanupBodies[0].dryRun).toBe(true);
    expect([...cleanupBodies[0].referenced].sort()).toEqual(['drawAAA1', 'drawSCN1', 'fileAAA1', 'fileDRAFT1', 'fileTRASH1']);
    // What the server offers to remove, with encrypted names decrypted here.
    expect(result.files.map((f) => f.name)).toEqual(['holiday.jpg', 'Encrypted file', 'old.txt']);
    expect(result.drawings).toEqual([{ id: 'drawX1', size: 5 }]);
  });

  it('counts what saved versions link to, decrypting encrypted ones here', async () => {
    unlock();
    await add('n1', { content: 'Now without the picture' });
    versions = [
      await sealedVersion(1, 'n1', 'Before: ![old](/api/files/fileOLDV1/old.png)'),
      // One stored readable (put there some other way): what it links to is kept all the same.
      { id: 2, note_id: 'n1', title: 'x', content: '[a](/api/files/filePLAINV1/a.txt)', created_at: NOW, enc: false, sealed: {} },
    ];
    const found = await cleanup.findUnusedFiles();
    expect([...cleanupBodies[0].referenced].sort()).toEqual(['fileOLDV1', 'filePLAINV1']);
    expect(found.inVersions.sort()).toEqual(['fileOLDV1', 'filePLAINV1']);
  });

  it('removes nothing when a saved version can’t be read, saying so', async () => {
    unlock();
    await add('n1', { content: 'fine' });
    versions = [await sealedVersion(1, 'n1', '![x](/api/files/fileLOST1/x.png)', otherKey)];
    await expect(cleanup.findUnusedFiles()).rejects.toThrow(
      'A saved version of a note couldn’t be read, so Lumen can’t tell which files it uses. Nothing was removed.',
    );
    expect(cleanupBodies).toEqual([]);
  });

  it('reads notes from the server for it, not from text it already had', async () => {
    unlock();
    await add('n1', { content: 'first ![a](/api/files/fileOLD1/a.png)' });
    store.useApp.setState({ status: 'ready' });
    await store.loadAll(true);
    await e2ee.createCodec(key).search({ words: ['first'], phrases: [], without: [] } as never, 10);
    // The note changed on another device; the note list here hasn't heard yet.
    server.rows.set('n1', await sealedRow(key, 'n1', { content: 'second ![b](/api/files/fileNEW1/b.png)', version: 2 }));
    await cleanup.findUnusedFiles();
    expect(cleanupBodies[0].referenced).toEqual(['fileNEW1']);
  });

  it('removes nothing when a note can’t be read, saying how many', async () => {
    unlock();
    await add('n1', { content: '![a](/api/files/fileAAA1/a.png)' });
    server.rows.set('bad1', await sealedRow(otherKey, 'bad1', { content: '![b](/api/files/fileBBB1/b.png)' }));
    await expect(cleanup.findUnusedFiles()).rejects.toThrow('A note couldn’t be read, so Lumen can’t tell which files it uses. Nothing was removed.');
    server.rows.set('bad2', await sealedRow(otherKey, 'bad2', { content: 'more' }));
    await expect(cleanup.findUnusedFiles()).rejects.toThrow('2 notes couldn’t be read, so Lumen can’t tell which files they use. Nothing was removed.');
    expect(cleanupBodies).toEqual([]);
  });

  it('removes nothing when the connection drops while reading notes', async () => {
    unlock();
    await add('n1', { content: '![a](/api/files/fileAAA1/a.png)' });
    await add('n2', { content: '![b](/api/files/fileBBB1/b.png)' });
    server.on('POST', '/api/notes/batch', () => Promise.reject(new TypeError('Failed to fetch')));
    await expect(cleanup.findUnusedFiles()).rejects.toThrow('2 notes couldn’t be read');
    expect(cleanupBodies).toEqual([]);
  });

  it('reads a library that isn’t encrypted here too: its notes, saved versions and unsent edits', async () => {
    server.state.encryption = false;
    server.on('GET', '/api/export/notes', () =>
      json(200, {
        notes: [plainRow('p1', { content: '![a](/api/files/fileAAA1/a.png)' }), plainRow('p2', { content: 'in the trash /api/drawings/drawT1.svg', deleted_at: NOW })],
        next: null,
      }),
    );
    versions = [{ id: 1, note_id: 'p1', title: 'x', content: '![v](/api/files/fileVER1/v.png)', created_at: NOW, enc: false, sealed: {} }];
    localStorage.setItem('kb.draft.p1~tab', JSON.stringify({ content: '![d](/api/files/fileDRF1/d.png)', baseVersion: 1, at: NOW }));
    const result = await cleanup.findUnusedFiles();
    expect([...cleanupBodies[0].referenced].sort()).toEqual(['drawT1', 'fileAAA1', 'fileDRF1', 'fileVER1']);
    expect(server.requests('POST', '/api/notes/batch')).toEqual([]);
    expect(result.files.map((f) => f.name)).toEqual(['Encrypted file', 'Encrypted file', 'old.txt']);
  });

  it('deletes only what was offered, reading the notes again for one saved meanwhile', async () => {
    unlock();
    await add('n1', { content: 'nothing yet' });
    versions = [await sealedVersion(1, 'n1', '![v](/api/files/fileVER1/v.png)')];
    const found = await cleanup.findUnusedFiles();
    // Meanwhile a note starts using one of the files offered.
    server.rows.set('n1', await sealedRow(key, 'n1', { content: 'now ![a](/api/files/unusedA1/a.jpg)', version: 2 }));
    await cleanup.deleteUnusedFiles(found);
    const sent = cleanupBodies[1];
    expect(sent.dryRun).toBe(false);
    expect(sent.confirm).toEqual({ files: ['unusedA1', 'unusedB1', 'plainC1'], drawings: ['drawX1'] });
    expect([...sent.referenced].sort()).toEqual(['fileVER1', 'unusedA1']);
    // The versions, which never change, aren't read twice.
    expect(server.requests('GET', '/api/versions/export')).toHaveLength(1);
  });
});

/* ------------------------------------------------------- backlinks --- */

describe('backlinks in an encrypted library', () => {
  const TITLE = 'C++ (draft) notes';

  async function library(extra: () => Promise<void> = async () => undefined) {
    unlock();
    await add('tgt1', { title: TITLE, content: 'the target' });
    await add('a1', { title: 'Links by id', links: { n: ['tgt1'], w: [] } });
    await add('a2', { title: 'Links by title', links: { n: [], w: [TITLE.toLowerCase()] } });
    await add('a3', { title: 'Trashed linker', links: { n: ['tgt1'], w: [] }, deleted_at: NOW });
    await add('a4', { title: 'Links elsewhere', links: { n: ['zzz9'], w: ['other'] } });
    await extra();
    await store.loadAll(true);
  }

  it('come from the links kept in each note’s preview, without fetching any note', async () => {
    await library();
    const found = await apiMod.api.backlinks('tgt1');
    expect(found.backlinks.map((b) => b.id).sort()).toEqual(['a1', 'a2']);
    expect(found.backlinks.find((b) => b.id === 'a1')).toMatchObject({ title: 'Links by id', updated_at: NOW });
    expect(server.requests('POST', '/api/notes/batch')).toEqual([]);
  });

  it('read the text of notes whose preview predates links, matching [[links]] the way the editor writes them', async () => {
    await library(async () => {
      await add('old1', { content: `See [[${TITLE}|that one]] soon`, links: null, pv: 1 });
      await add('old2', { content: `[[c++ (draft) NOTES#Intro]]`, links: null, pv: 1 });
      await add('old3', { content: `[[${TITLE} and more]]`, links: null, pv: 1 });
      await add('old4', { content: '[open](/note/tgt1)', links: null, pv: 1 });
      await add('old5', { content: 'C++ (draft) notes, mentioned but not linked', links: null, pv: 1 });
    });
    const found = await apiMod.api.backlinks('tgt1');
    expect(found.backlinks.map((b) => b.id).sort()).toEqual(['a1', 'a2', 'old1', 'old2', 'old4']);
    // Those previews are remade once, in the background, with their links. That's real encryption,
    // which takes as long as it takes on a busy machine (a build server), so wait for the result
    // rather than for a fixed number of rounds.
    await vi.waitFor(
      () => {
        const upgraded = server.requests('POST', '/api/notes/previews').flatMap((r) => r.body.notes.map((n: { id: string }) => n.id));
        expect(upgraded.sort()).toEqual(['old1', 'old2', 'old3', 'old4', 'old5']);
      },
      { timeout: 15_000, interval: 20 },
    );
  });

  it('count only links by id for a note without a title', async () => {
    unlock();
    await add('blank1', { title: '' });
    await add('b1', { links: { n: [], w: [''] } });
    await add('b2', { links: { n: ['blank1'], w: [] } });
    await add('b3', { content: '[[]] and [[ ]]', links: null, pv: 1 });
    await store.loadAll(true);
    const found = await apiMod.api.backlinks('blank1');
    expect(found.backlinks.map((b) => b.id)).toEqual(['b2']);
  });

  it('stop at 50', async () => {
    await library(async () => {
      for (let i = 0; i < 60; i++) await add(`many${i}`, { links: { n: ['tgt1'], w: [] } });
    });
    expect((await apiMod.api.backlinks('tgt1')).backlinks).toHaveLength(50);
  });
});
