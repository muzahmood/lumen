// @vitest-environment jsdom
/**
 * Once a device has seen the whole library encrypted, nothing the server sends unencrypted is taken
 * as the person's own (src/lib/api.ts, src/lib/e2ee.ts), and every answer must be for the item asked
 * for. Runs the app's real API client and codec against a stubbed server.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encryptText, newMasterKey } from '../../src/lib/crypto';

// Loaded afresh for each test: what the device remembers is also kept in memory by api.ts.
let api: typeof import('../../src/lib/api')['api'];
let libraryEncrypted: typeof import('../../src/lib/api')['libraryEncrypted'];
let setCodec: typeof import('../../src/lib/api')['setCodec'];
let encryptLibrary: typeof import('../../src/lib/e2ee')['encryptLibrary'];

const NOW = 1_700_000_000_000;
let key: CryptoKey;
let routes: Record<string, unknown>;

const meta = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  folder_id: null,
  title: '',
  excerpt: '',
  info: {},
  tags: [],
  pinned: false,
  version: 1,
  created_at: NOW,
  updated_at: NOW,
  deleted_at: null,
  ...extra,
});

/** An encrypted note as the server stores it. */
async function sealedNote(id: string, title: string, content: string) {
  const at = (f: string) => `lumen/1/note/${id}/${f}`;
  return meta(id, {
    enc: true,
    content: await encryptText(key, content, at('content')),
    sealed: {
      t: await encryptText(key, title, at('title')),
      g: await encryptText(key, '[]', at('tags')),
      p: await encryptText(key, JSON.stringify({ e: content, i: {}, l: { n: [], w: [] } }), at('preview')),
    },
  });
}

const plainNote = (id: string) => meta(id, { title: 'Pay this invoice', excerpt: 'Send money to…', tags: ['urgent'], content: 'Send money to…', enc: false });

function bootstrap(pending: { notes: number; versions: number; folders: number }, notes: unknown[], folders: unknown[] = []) {
  return { me: {}, notes, folders, encryption: { on: true, pending, gen: 0, rekey: { notes: 0, versions: 0, folders: 0 } }, serverTime: NOW };
}

const done = { notes: 0, versions: 0, folders: 0 };

beforeEach(async () => {
  localStorage.clear();
  vi.resetModules();
  ({ api, libraryEncrypted, setCodec } = await import('../../src/lib/api'));
  const e2ee = await import('../../src/lib/e2ee');
  encryptLibrary = e2ee.encryptLibrary;
  key = await newMasterKey();
  setCodec(e2ee.createCodec(key));
  routes = {};
  vi.stubGlobal(
    'fetch',
    vi.fn(async (path: string) => {
      const body = routes[path.split('?')[0]];
      if (body === undefined) return new Response(JSON.stringify({ error: 'not_found', message: 'Not found.' }), { status: 404, headers: { 'content-type': 'application/json' } });
      return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
    }),
  );
});

afterEach(() => {
  setCodec(null);
  vi.unstubAllGlobals();
});

describe('a library being encrypted for the first time', () => {
  it('still shows plaintext notes while some are left to encrypt', async () => {
    routes['/api/bootstrap'] = bootstrap({ notes: 1, versions: 0, folders: 0 }, [plainNote('plain1')]);
    routes['/api/notes/plain1'] = plainNote('plain1');
    const boot = await api.bootstrap();
    expect(libraryEncrypted()).toBe(false);
    expect(boot.notes[0].title).toBe('Pay this invoice');
    expect((await api.getNote('plain1')).content).toBe('Send money to…');
  });
});

describe('once the library was seen fully encrypted', () => {
  async function seenEncrypted() {
    routes['/api/bootstrap'] = bootstrap(done, [await sealedNote('real1', 'Mine', 'my text')]);
    await api.bootstrap();
    expect(libraryEncrypted()).toBe(true);
  }

  it('remembers it in this browser', async () => {
    await seenEncrypted();
    expect(localStorage.getItem('kb.vault.sealed')).toBe('1');
  });

  it('lists an unencrypted note with nothing of it shown, and won’t open it', async () => {
    await seenEncrypted();
    // The server now reports plaintext again (rows slipped in after encryption was finished).
    routes['/api/bootstrap'] = bootstrap({ notes: 1, versions: 0, folders: 1 }, [await sealedNote('real1', 'Mine', 'my text'), plainNote('fake1')], [
      { id: 'fold1', parent_id: null, name: 'Bills', sort: 0, created_at: NOW, updated_at: NOW, enc: false },
    ]);
    const boot = await api.bootstrap();
    const real = boot.notes.find((n) => n.id === 'real1');
    const fake = boot.notes.find((n) => n.id === 'fake1');
    expect(real?.title).toBe('Mine');
    expect(fake).toMatchObject({ title: 'Unencrypted note', excerpt: '', tags: [], info: {}, links: { n: [], w: [] } });
    expect(boot.folders[0].name).toBe('Unencrypted folder');
    // Still remembered, though the server no longer says everything is encrypted.
    expect(libraryEncrypted()).toBe(true);

    routes['/api/notes/fake1'] = plainNote('fake1');
    await expect(api.getNote('fake1')).rejects.toMatchObject({ code: 'unencrypted' });
  });

  it('won’t open or list an unencrypted version as one', async () => {
    await seenEncrypted();
    routes['/api/notes/real1/versions'] = { versions: [{ id: 7, title: 'Old', size: 10, created_at: NOW, enc: false }] };
    routes['/api/versions/7'] = { id: 7, note_id: 'real1', title: 'Old', content: 'injected', created_at: NOW, enc: false };
    const { versions } = await api.versions('real1');
    expect(versions[0].title).toBe('Unencrypted version');
    await expect(api.version(7, 'real1')).rejects.toMatchObject({ code: 'unencrypted' });
  });

  it('won’t run the first-time encryption over plaintext the server reports', async () => {
    await seenEncrypted();
    routes['/api/bootstrap'] = bootstrap({ notes: 1, versions: 0, folders: 0 }, [plainNote('fake1')]);
    await expect(encryptLibrary(key, () => undefined)).rejects.toThrow('already encrypted');
  });
});

describe('answers for a different item', () => {
  it('refuses another note sent in place of the one asked for, even a genuine one', async () => {
    // b's ciphertext is valid (bound to b), so decrypting alone wouldn't catch the swap.
    routes['/api/notes/a'] = await sealedNote('b', 'Other note', 'other text');
    await expect(api.getNote('a')).rejects.toMatchObject({ code: 'wrong_item' });
  });

  it('refuses another version sent in place of the one asked for', async () => {
    routes['/api/versions/7'] = { id: 8, note_id: 'a', title: '', content: 'x', created_at: NOW, enc: false };
    await expect(api.version(7, 'a')).rejects.toMatchObject({ code: 'wrong_item' });
  });
});
