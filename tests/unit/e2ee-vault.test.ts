// @vitest-environment jsdom
/**
 * The vault (src/lib/vault.ts): turning encryption on, unlocking a device with the passphrase or the
 * recovery key, changing either, locking (by hand, automatically, or because the key was replaced on
 * another device) and signing out of a device. Each "device" here has its own browser storage and
 * IndexedDB, and loading the modules afresh plays a page load; the server is a small stand-in that
 * keeps the keyring the way the Worker does.
 */
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Keyring } from '../../src/lib/types';

// Few PBKDF2 rounds, so each passphrase costs a millisecond rather than half a second.
vi.mock('../../src/lib/crypto', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/lib/crypto')>()),
  PBKDF2_ITERATIONS: 2000,
}));

const saver = vi.hoisted(() => ({ flushAll: 0, freezeDrafts: 0, discardAll: 0 }));
vi.mock('../../src/lib/saver', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/lib/saver')>()),
  flushAll: async () => void saver.flushAll++,
  freezeDrafts: () => void saver.freezeDrafts++,
  discardAll: () => void saver.discardAll++,
}));
// Signing out asks first; here the person always says yes.
vi.mock('../../src/lib/store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/lib/store')>()),
  confirmDialog: async () => true,
}));

// jsdom has no matchMedia; settings.ts reads the system theme at load.
window.matchMedia ??= ((query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;

const NOW = 1_700_000_000_000;
const PASS = 'correct horse battery staple';

type Vault = typeof import('../../src/lib/vault');
type Api = typeof import('../../src/lib/api');

/** Text this device sealed in browser storage: its marker, then the ciphertext. */
const SEALED_HERE = /^\u0001sealed:e1:/;
type Crypto = typeof import('../../src/lib/crypto');
let vault: Vault;
let apiMod: Api;
let c: Crypto;

/* ------------------------------------------------------------ the server --- */

const server = { keyring: null as Keyring | null, nextId: 1, offline: false, encryptionOn: false };

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

async function respond(path: string, init: RequestInit = {}): Promise<Response> {
  if (server.offline) throw new TypeError('Failed to fetch');
  const method = init.method ?? 'GET';
  const url = path.split('?')[0];
  const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
  if (url === '/api/keyring' && method === 'GET') return json({ keyring: server.keyring });
  if (url === '/api/keyring' && method === 'POST') {
    // Only on top of the keyring the app read; the generation never goes back or skips one.
    if (body.replaces !== (server.keyring?.id ?? null)) return json({ error: 'keyring_changed', message: 'Changed on another device.' }, 409);
    const before = server.keyring?.data.gen ?? 0;
    const gen = body.data.gen ?? 0;
    if (gen !== before && gen !== before + 1) return json({ error: 'bad_keyring', message: 'Out of step.' }, 400);
    server.keyring = { id: server.nextId++, created_at: NOW, data: body.data };
    return json({ keyring: server.keyring }, 201);
  }
  if (url === '/api/bootstrap') {
    const on = !!server.keyring || server.encryptionOn;
    return json({
      me: {},
      notes: [],
      folders: [],
      encryption: on
        ? { on, pending: { notes: 0, versions: 0, folders: 0 }, attachments: { files: 0, drawings: 0 }, gen: server.keyring?.data.gen ?? 0, rekey: { notes: 0, versions: 0, folders: 0 } }
        : { on: false, pending: null },
      serverTime: NOW,
    });
  }
  if (url === '/api/signout') return json({ ok: true });
  return json({ error: 'not_found', message: 'Not found.' }, 404);
}

/* ----------------------------------------------- tabs, page loads, devices --- */

/** BroadcastChannel between Lumen tabs: records what this tab says, and lets a test speak as another tab. */
class FakeChannel {
  static last: FakeChannel | null = null;
  posted: unknown[] = [];
  private listeners: Array<(e: { data: unknown }) => void> = [];
  constructor(public name: string) {
    FakeChannel.last = this;
  }
  postMessage(data: unknown) {
    this.posted.push(data);
  }
  addEventListener(_type: string, fn: (e: { data: unknown }) => void) {
    this.listeners.push(fn);
  }
  close() {}
  /** A message from another tab. */
  deliver(data: unknown) {
    for (const fn of this.listeners) fn({ data });
  }
}

const nav = { reloads: 0, href: '', replaced: '' };

interface Device {
  storage: Record<string, string>;
  session: Record<string, string>;
  idb: IDBFactory;
}
const devices = new Map<string, Device>();
let here: string | null = null;

function dump(store: Storage): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < store.length; i++) {
    const k = store.key(i)!;
    out[k] = store.getItem(k)!;
  }
  return out;
}

function fill(store: Storage, values: Record<string, string>) {
  store.clear();
  for (const [k, v] of Object.entries(values)) store.setItem(k, v);
}

/** A page load: every module fresh, browser storage as it was. */
async function pageLoad() {
  vi.resetModules();
  apiMod = await import('../../src/lib/api');
  vault = await import('../../src/lib/vault');
  c = await import('../../src/lib/crypto');
}

/** Puts this device's storage away and opens Lumen on another (a new one the first time). */
async function openOn(name: string) {
  if (here) {
    const d = devices.get(here)!;
    d.storage = dump(localStorage);
    d.session = dump(sessionStorage);
  }
  let d = devices.get(name);
  if (!d) {
    d = { storage: {}, session: {}, idb: new IDBFactory() };
    devices.set(name, d);
  }
  fill(localStorage, d.storage);
  fill(sessionStorage, d.session);
  vi.stubGlobal('indexedDB', d.idb);
  here = name;
  await pageLoad();
}

/** What this browser's IndexedDB holds for the vault ("master", "older"), or null without the database. */
async function idbVault(): Promise<{ master?: CryptoKey; older?: { older: CryptoKey[]; gen: number } } | null> {
  const names = (await indexedDB.databases()).map((d) => d.name);
  if (!names.includes('lumen-vault')) return null;
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('lumen-vault', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('keys');
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const db = req.result;
      const store = db.transaction('keys', 'readonly').objectStore('keys');
      const m = store.get('master');
      const o = store.get('older');
      o.onsuccess = () => {
        db.close();
        resolve({ master: m.result, older: o.result });
      };
      o.onerror = () => reject(o.error);
    };
  });
}

/** Turns encryption on from the current device; returns the recovery key. */
async function setUp(passphrase = PASS): Promise<string> {
  await vault.initVault();
  const prepared = await vault.prepareSetup(passphrase);
  await prepared.commit();
  return prepared.recoveryKey;
}

/** Text encrypted with the key this device holds now. */
async function sealHere(text: string, context = 'lumen/1/note/n1/content') {
  return c.encryptText(vault.vaultKey()!, text, context);
}

beforeEach(async () => {
  server.keyring = null;
  server.nextId = 1;
  server.offline = false;
  server.encryptionOn = false;
  saver.flushAll = saver.freezeDrafts = saver.discardAll = 0;
  nav.reloads = 0;
  nav.href = nav.replaced = '';
  devices.clear();
  here = null;
  vi.stubGlobal('fetch', vi.fn(respond));
  vi.stubGlobal('BroadcastChannel', FakeChannel);
  vi.stubGlobal('location', {
    origin: 'http://localhost',
    protocol: 'http:',
    host: 'localhost',
    pathname: '/',
    search: '',
    hash: '',
    get href() {
      return 'http://localhost/';
    },
    set href(v: string) {
      nav.href = v;
    },
    reload: () => void nav.reloads++,
    replace: (v: string) => void (nav.replaced = v),
  });
  await openOn('laptop');
});

afterEach(() => {
  apiMod.setCodec(null);
  vi.unstubAllGlobals();
});

/* ---------------------------------------------------------------- tests --- */

describe('turning encryption on', () => {
  it('stores nothing until it’s committed, then saves the keyring and unlocks this device', async () => {
    expect(await vault.initVault()).toBe('off');
    const prepared = await vault.prepareSetup(PASS);
    expect(server.keyring).toBeNull();
    expect(prepared.recoveryKey).toMatch(/^([0-9A-HJKMNP-TV-Z]{4}-){12}[0-9A-HJKMNP-TV-Z]{4}$/);

    await prepared.commit();
    const data = server.keyring!.data;
    expect(data).toMatchObject({ v: 1, kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations: 2000 } });
    expect(data.check).toMatch(/^e1:/);
    // Neither secret is in what the server keeps.
    const stored = JSON.stringify(server.keyring);
    expect(stored).not.toContain(PASS);
    expect(stored).not.toContain(prepared.recoveryKey.replace(/-/g, ''));

    expect(vault.useVault.getState().state).toBe('unlocked');
    expect(vault.encrypting()).toBe(true);
    expect(vault.vaultKey()!.extractable).toBe(false);
    expect(apiMod.currentCodec()).not.toBeNull();
    expect(JSON.parse(localStorage.getItem('kb.keyring')!).id).toBe(server.keyring!.id);
    const idb = await idbVault();
    expect(idb?.master).toBeDefined();
    expect(idb?.master?.extractable).toBe(false);
    expect(FakeChannel.last!.posted).toContain('unlock');
  });

  it('opens with both the passphrase and the recovery key it was set up with', async () => {
    const recoveryKey = await setUp();
    const note = await sealHere('my secret');
    const byPass = await vault.keysFromSecret(server.keyring!.data, PASS);
    const byRecovery = await vault.keysFromSecret(server.keyring!.data, recoveryKey);
    expect(await c.decryptText(byPass![0], note, 'lumen/1/note/n1/content')).toBe('my secret');
    expect(await c.decryptText(byRecovery![0], note, 'lumen/1/note/n1/content')).toBe('my secret');
  });

  it('won’t set up a second key when encryption was turned on from another device', async () => {
    await vault.initVault();
    const late = await vault.prepareSetup('a passphrase of my own');
    await openOn('phone');
    await setUp();
    const first = server.keyring;
    await openOn('laptop');
    await expect(late.commit()).rejects.toThrow(/turned on from another device/);
    expect(server.keyring).toBe(first);
    expect(vault.encrypting()).toBe(false);
  });

  it('won’t set up a key while notes are encrypted under one whose keyring has gone missing', async () => {
    server.encryptionOn = true;
    const prepared = await vault.prepareSetup(PASS);
    await expect(prepared.commit()).rejects.toThrow(/another device/);
    expect(server.keyring).toBeNull();
  });
});

describe('unlocking a device', () => {
  it('with the passphrase: text encrypted on another device opens here', async () => {
    await setUp();
    const note = await sealHere('written on the laptop');
    await openOn('phone');
    expect(await vault.initVault()).toBe('locked');
    expect(vault.vaultKey()).toBeNull();
    await vault.unlockWithPassphrase(PASS);
    expect(vault.useVault.getState().state).toBe('unlocked');
    expect(await c.decryptText(vault.vaultKey()!, note, 'lumen/1/note/n1/content')).toBe('written on the laptop');
  });

  it('asks the browser to keep what this device stores, once it’s unlocked (not before, and not again once kept)', async () => {
    let kept = false;
    const persist = vi.fn(async () => (kept = true));
    vi.stubGlobal('navigator', { ...navigator, storage: { persisted: async () => kept, persist } });
    await vault.initVault();
    expect(persist).not.toHaveBeenCalled();
    await setUp();
    await vi.waitFor(() => expect(persist).toHaveBeenCalledTimes(1));
    await vault.lock();
    await pageLoad();
    await vault.initVault();
    await vault.unlockWithPassphrase(PASS);
    await new Promise((r) => setTimeout(r, 0));
    expect(persist).toHaveBeenCalledTimes(1);
  });

  it('stays unlocked across page loads without asking again, holding the key only in non-extractable form', async () => {
    await setUp();
    const note = await sealHere('still here');
    await pageLoad();
    expect(await vault.initVault()).toBe('unlocked');
    const key = vault.vaultKey()!;
    expect(key.extractable).toBe(false);
    await expect(crypto.subtle.exportKey('raw', key)).rejects.toThrow();
    expect(await c.decryptText(key, note, 'lumen/1/note/n1/content')).toBe('still here');
  });

  it('accepts the passphrase however its accented letters were typed', async () => {
    await setUp('café crème brûlée');
    await openOn('phone');
    await vault.initVault();
    await vault.unlockWithPassphrase('café crème brûlée'.normalize('NFD'));
    expect(vault.encrypting()).toBe(true);
  });

  it('refuses a wrong passphrase and stays locked, keeping nothing', async () => {
    await setUp();
    await openOn('phone');
    await vault.initVault();
    await expect(vault.unlockWithPassphrase('correct horse battery stapler')).rejects.toThrow(/didn’t unlock/);
    // The passphrase is used exactly as it was set.
    await expect(vault.unlockWithPassphrase(` ${PASS}`)).rejects.toThrow(/didn’t unlock/);
    expect(vault.vaultKey()).toBeNull();
    expect(apiMod.currentCodec()).toBeNull();
    expect(vault.useVault.getState().state).toBe('locked');
    expect((await idbVault())?.master).toBeUndefined();
  });

  it('with the recovery key, written any which way, setting a new passphrase in place of the old one', async () => {
    const recoveryKey = await setUp();
    const note = await sealHere('recovered');
    await openOn('phone');
    await vault.initVault();
    await vault.recoverWithKey(` ${recoveryKey.toLowerCase().replace(/-/g, ' ')} `, 'a brand new passphrase');
    expect(await c.decryptText(vault.vaultKey()!, note, 'lumen/1/note/n1/content')).toBe('recovered');

    await openOn('tablet');
    await vault.initVault();
    await expect(vault.unlockWithPassphrase(PASS)).rejects.toThrow(/didn’t unlock/);
    await vault.unlockWithPassphrase('a brand new passphrase');
    expect(await c.decryptText(vault.vaultKey()!, note, 'lumen/1/note/n1/content')).toBe('recovered');
  });

  it('refuses a wrong or malformed recovery key without changing the passphrase', async () => {
    await setUp();
    const before = server.keyring;
    await openOn('phone');
    await vault.initVault();
    await expect(vault.recoverWithKey(c.formatRecoveryKey(c.randomBytes(32)), 'new one')).rejects.toThrow(/didn’t unlock/);
    await expect(vault.recoverWithKey('not a recovery key', 'new one')).rejects.toThrow(/isn’t a recovery key/);
    expect(server.keyring).toBe(before);
    expect(vault.vaultKey()).toBeNull();
    await vault.unlockWithPassphrase(PASS);
  });

  it('asks to connect when this device has never seen the keyring', async () => {
    await setUp();
    await openOn('phone');
    server.offline = true;
    expect(await vault.initVault()).toBe('off');
    await expect(vault.unlockWithPassphrase(PASS)).rejects.toThrow(/Connect to the internet/);
  });

  it('unlocks offline from this device’s copy of the keyring once it has seen it', async () => {
    await setUp();
    await openOn('phone');
    await vault.initVault();
    await vault.unlockWithPassphrase(PASS);
    await vault.lock();
    await pageLoad();
    server.offline = true;
    expect(await vault.initVault()).toBe('locked');
    await vault.unlockWithPassphrase(PASS);
    expect(vault.encrypting()).toBe(true);
  });

  // Known limitation (README, "Forgot the passphrase?"): a copy of the keyring from before a change still opens.
  it('opens with the old passphrase on a device that has been offline since the passphrase was changed', async () => {
    await setUp();
    await openOn('phone');
    await vault.initVault();
    await vault.unlockWithPassphrase(PASS);
    await vault.lock();
    await openOn('laptop');
    await pageLoad();
    await vault.initVault();
    await vault.changePassphrase(PASS, 'the new passphrase');
    await openOn('phone');
    server.offline = true;
    await vault.initVault();
    await vault.unlockWithPassphrase(PASS);
    expect(vault.encrypting()).toBe(true);
    // Back online, the old passphrase opens nothing.
    await vault.lock();
    await pageLoad();
    server.offline = false;
    await vault.initVault();
    await expect(vault.unlockWithPassphrase(PASS)).rejects.toThrow(/didn’t unlock/);
  });
});

describe('changing the passphrase', () => {
  it('needs the current one, keeps the same key, and the old passphrase stops working', async () => {
    const recoveryKey = await setUp();
    const note = await sealHere('unchanged');
    const before = server.keyring!.data;
    await expect(vault.changePassphrase('not it', 'next passphrase')).rejects.toThrow(/current passphrase isn’t right/);
    expect(server.keyring!.data).toBe(before);

    await vault.changePassphrase(PASS, 'next passphrase');
    const after = server.keyring!.data;
    expect(after.kdf.salt).not.toBe(before.kdf.salt);
    expect(after.pass).not.toEqual(before.pass);
    expect([after.recovery, after.check, after.gen, after.prev]).toEqual([before.recovery, before.check, before.gen, before.prev]);
    // This device carries on, with its copy of the keyring up to date.
    expect(vault.encrypting()).toBe(true);
    expect(JSON.parse(localStorage.getItem('kb.keyring')!).data.pass).toEqual(after.pass);

    expect(await vault.keysFromSecret(after, PASS)).toBeNull();
    const keys = await vault.keysFromSecret(after, 'next passphrase');
    expect(await c.decryptText(keys![0], note, 'lumen/1/note/n1/content')).toBe('unchanged');
    // The recovery key still works.
    expect(await vault.keysFromSecret(after, recoveryKey)).not.toBeNull();
  });

  it('is refused offline', async () => {
    await setUp();
    server.offline = true;
    await expect(vault.changePassphrase(PASS, 'next')).rejects.toThrow(/Connect to the internet/);
  });
});

describe('a new recovery key', () => {
  it('needs the passphrase and replaces the old one, which then opens nothing', async () => {
    const oldRecovery = await setUp();
    const note = await sealHere('safe');
    await expect(vault.replaceRecoveryKey('wrong')).rejects.toThrow(/isn’t right/);
    const newRecovery = await vault.replaceRecoveryKey(PASS);
    expect(newRecovery).not.toBe(oldRecovery);
    expect(c.parseRecoveryKey(newRecovery)).not.toBeNull();

    await openOn('phone');
    await vault.initVault();
    await expect(vault.recoverWithKey(oldRecovery, 'another')).rejects.toThrow(/didn’t unlock/);
    await vault.recoverWithKey(newRecovery, 'another');
    expect(await c.decryptText(vault.vaultKey()!, note, 'lumen/1/note/n1/content')).toBe('safe');
  });
});

describe('locking', () => {
  it('removes the key from memory and this browser, and encrypts text kept here', async () => {
    await setUp();
    localStorage.setItem('kb.draft.n1', JSON.stringify({ content: 'unsent secret words', baseVersion: 1 }));
    localStorage.setItem('kb.capture', 'buy a ring');
    localStorage.setItem('kb.settings', JSON.stringify({ theme: 'dark' }));
    sessionStorage.setItem('kb.filter', JSON.stringify({ kind: 'tag', tag: 'divorce' }));
    await vault.lock();

    expect(vault.vaultKey()).toBeNull();
    expect(vault.deviceKeys()).toEqual([]);
    expect(await idbVault()).toEqual({ master: undefined, older: undefined });
    expect(saver.flushAll).toBe(1);
    expect(saver.freezeDrafts).toBe(1);
    for (const k of ['kb.draft.n1', 'kb.capture']) {
      expect(localStorage.getItem(k)).toMatch(SEALED_HERE);
    }
    expect(JSON.stringify(dump(localStorage))).not.toMatch(/unsent secret|buy a ring/);
    expect(localStorage.getItem('kb.settings')).toBe(JSON.stringify({ theme: 'dark' }));
    expect(sessionStorage.getItem('kb.filter')).toBeNull();
    expect(FakeChannel.last!.posted).toContain('lock');
    expect(nav.reloads).toBe(1);

    // After the reload: locked, and unlocking gives the text back.
    await pageLoad();
    expect(await vault.initVault()).toBe('locked');
    await vault.unlockWithPassphrase(PASS);
    expect(JSON.parse(localStorage.getItem('kb.draft.n1')!).content).toBe('unsent secret words');
    expect(localStorage.getItem('kb.capture')).toBe('buy a ring');
  });

  it('first lets what’s only in memory be kept (a drawing’s latest strokes), then lets nothing be written in the clear', async () => {
    await setUp();
    let asked = 0;
    vault.onBeforeLocalSeal(() => {
      asked++;
      localStorage.setItem('kb.drawing-backup', JSON.stringify({ scene: 'map to the treasure' }));
    });
    expect(vault.localTextSealed()).toBe(false);
    await vault.lock();
    expect(asked).toBe(1);
    expect(localStorage.getItem('kb.drawing-backup')).toMatch(SEALED_HERE);
    expect(JSON.stringify(dump(localStorage))).not.toContain('treasure');
    // The page is reloading to the unlock screen: its pagehide must find writing closed.
    expect(vault.localTextSealed()).toBe(true);
  });

  it('binds each piece of text kept here to where it was kept', async () => {
    await setUp();
    localStorage.setItem('kb.draft.n1', '{"content":"one"}');
    localStorage.setItem('kb.draft.n2', '{"content":"two"}');
    await vault.lock();
    const [one, two] = [localStorage.getItem('kb.draft.n1')!, localStorage.getItem('kb.draft.n2')!];
    localStorage.setItem('kb.draft.n1', two);
    localStorage.setItem('kb.draft.n2', one);
    await pageLoad();
    await vault.initVault();
    await vault.unlockWithPassphrase(PASS);
    // Swapped while locked: neither opens as the other note's.
    expect(localStorage.getItem('kb.draft.n1')).toBe(two);
    expect(localStorage.getItem('kb.draft.n2')).toBe(one);
  });

  it('encrypts text in the capture box that happens to start like ciphertext', async () => {
    await setUp();
    localStorage.setItem('kb.capture', 'e1: castle kingside, then push the h-pawn');
    await vault.lock();
    expect(localStorage.getItem('kb.capture')).not.toContain('castle kingside');
    await pageLoad();
    await vault.initVault();
    await vault.unlockWithPassphrase(PASS);
    expect(localStorage.getItem('kb.capture')).toBe('e1: castle kingside, then push the h-pawn');
  });

  it('keeps what this device knows about the library, so it still refuses unencrypted notes', async () => {
    await setUp();
    localStorage.setItem('kb.vault.sealed', '1');
    localStorage.setItem('kb.vault.attachments', '1');
    await vault.lock();
    await pageLoad();
    expect(apiMod.libraryEncrypted()).toBe(true);
    expect(apiMod.attachmentsEncrypted()).toBe(true);
  });

  it('follows a lock in another tab, without announcing it again', async () => {
    await setUp();
    const channel = FakeChannel.last!;
    channel.posted.length = 0;
    channel.deliver('lock');
    await vi.waitFor(() => expect(vault.vaultKey()).toBeNull());
    await vi.waitFor(() => expect(nav.reloads).toBe(1));
    expect(channel.posted).not.toContain('lock');
  });

  it('picks up an unlock made in another tab', async () => {
    await setUp();
    await pageLoad();
    // This tab hasn't got the key in memory yet (it loaded while the other tab was locked).
    vi.stubGlobal('indexedDB', new IDBFactory());
    await vault.initVault();
    expect(vault.useVault.getState().state).toBe('locked');
    vi.stubGlobal('indexedDB', devices.get('laptop')!.idb);
    FakeChannel.last!.deliver('unlock');
    await vi.waitFor(() => expect(vault.encrypting()).toBe(true));
  });
});

describe('locking automatically', () => {
  async function useAutoLock(minutes: number, idleMinutes: number) {
    localStorage.setItem('kb.settings', JSON.stringify({ autoLockMinutes: minutes }));
    await pageLoad();
    await setUp();
    localStorage.setItem('kb.draft.n1', JSON.stringify({ content: 'left behind' }));
    localStorage.setItem('kb.vault.active', String(Date.now() - idleMinutes * 60_000));
    await pageLoad();
  }

  it('locks when Lumen opens after the chosen time without use, encrypting what was left in this browser', async () => {
    await useAutoLock(5, 6);
    expect(await vault.initVault()).toBe('locked');
    expect(vault.vaultKey()).toBeNull();
    expect(apiMod.currentCodec()).toBeNull();
    expect((await idbVault())?.master).toBeUndefined();
    expect(localStorage.getItem('kb.draft.n1')).toMatch(SEALED_HERE);
    expect(vault.localTextSealed()).toBe(true);
    await vault.unlockWithPassphrase(PASS);
    expect(JSON.parse(localStorage.getItem('kb.draft.n1')!).content).toBe('left behind');
    // Unlocked again without a reload: the crash copies may be written once more.
    expect(vault.localTextSealed()).toBe(false);
  });

  it('at the start also drops the note list’s filter kept for the tab, as locking by hand does', async () => {
    await useAutoLock(5, 6);
    sessionStorage.setItem('kb.filter', JSON.stringify({ kind: 'tag', tag: 'divorce-lawyer' }));
    expect(await vault.initVault()).toBe('locked');
    expect(sessionStorage.getItem('kb.filter')).toBeNull();
  });

  it('stays unlocked within the time, and when it’s off', async () => {
    await useAutoLock(5, 4);
    expect(await vault.initVault()).toBe('unlocked');
    localStorage.setItem('kb.settings', JSON.stringify({ autoLockMinutes: 0 }));
    localStorage.setItem('kb.vault.active', String(Date.now() - 10 * 24 * 60 * 60_000));
    await pageLoad();
    expect(await vault.initVault()).toBe('unlocked');
  });

  it('locks a tab left open past the time', async () => {
    vi.useFakeTimers({ toFake: ['setInterval'] });
    try {
      localStorage.setItem('kb.settings', JSON.stringify({ autoLockMinutes: 1 }));
      await pageLoad();
      await setUp();
      localStorage.setItem('kb.vault.active', String(Date.now() - 2 * 60_000));
      vi.advanceTimersByTime(30_000);
      await vi.waitFor(() => expect(vault.vaultKey()).toBeNull());
      await vi.waitFor(async () => expect((await idbVault())?.master).toBeUndefined());
      expect(nav.reloads).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('when the key was replaced on another device', () => {
  it('a device holding the old key locks at its next start, keeping its unsent edits under that key, and the passphrase moves it to the new key', async () => {
    await setUp();
    const old = await sealHere('from before the replacement');
    await openOn('phone');
    await vault.initVault();
    await vault.unlockWithPassphrase(PASS);
    localStorage.setItem('kb.draft.n1', JSON.stringify({ content: 'phone edit' }));

    await openOn('laptop');
    await pageLoad();
    await vault.initVault();
    const replacement = await vault.prepareKeyReplacement(PASS);
    await replacement.commit();
    expect(server.keyring!.data.gen).toBe(1);

    await openOn('phone');
    // Unlocked straight away from this browser's key, then the check against the keyring locks it.
    expect(await vault.initVault()).toBe('unlocked');
    await vi.waitFor(() => expect(nav.reloads).toBe(1));
    expect(vault.vaultKey()).toBeNull();
    expect((await idbVault())?.master).toBeUndefined();
    expect(localStorage.getItem('kb.draft.n1')).toMatch(SEALED_HERE);

    await pageLoad();
    expect(await vault.initVault()).toBe('locked');
    expect(vault.takeLockNotice()).toMatch(/replaced on another device/);
    expect(vault.takeLockNotice()).toBeNull();
    await vault.unlockWithPassphrase(PASS);
    expect(apiMod.currentKeyGen()).toBe(1);
    expect(JSON.parse(localStorage.getItem('kb.draft.n1')!).content).toBe('phone edit');
    // The new key, with the old one kept for text from before.
    const [current, ...older] = vault.deviceKeys();
    await expect(c.decryptText(current, old, 'lumen/1/note/n1/content')).rejects.toThrow();
    expect(await c.decryptText(older[0], old, 'lumen/1/note/n1/content')).toBe('from before the replacement');
  });

  it('a write refused for an old key locks a device that’s still open', async () => {
    await setUp();
    const listener = vi.fn();
    apiMod.onKeyChanged(listener);
    vi.stubGlobal('fetch', vi.fn(async () => json({ error: 'key_changed', message: 'Replaced.' }, 409)));
    await expect(apiMod.api.sealPreviews([{ id: 'n1', version: 1, p: 'e1:x' }])).rejects.toMatchObject({ status: 409, code: 'key_changed' });
    expect(listener).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(vault.vaultKey()).toBeNull());
    expect(saver.freezeDrafts).toBe(1);
  });

  it('the device that replaced it moves to the new key, keeping every earlier one', async () => {
    const firstRecovery = await setUp();
    const gen0 = await sealHere('generation 0');
    await (await vault.prepareKeyReplacement(PASS)).commit();
    const gen1 = await sealHere('generation 1');
    const prepared = await vault.prepareKeyReplacement(PASS);
    await prepared.commit();
    expect(FakeChannel.last!.posted).toContain('rekeyed');
    expect(server.keyring!.data.gen).toBe(2);
    expect(server.keyring!.data.prev).toHaveLength(2);
    expect(apiMod.currentKeyGen()).toBe(2);

    // The old recovery key opens nothing current; the new one, and the passphrase, open all three keys.
    expect(await vault.keysFromSecret(server.keyring!.data, firstRecovery)).toBeNull();
    for (const secret of [PASS, prepared.recoveryKey]) {
      const keys = (await vault.keysFromSecret(server.keyring!.data, secret))!;
      expect(keys).toHaveLength(3);
      expect(await c.decryptText(keys[2], gen0, 'lumen/1/note/n1/content')).toBe('generation 0');
      expect(await c.decryptText(keys[1], gen1, 'lumen/1/note/n1/content')).toBe('generation 1');
    }

    // Another device unlocking now gets every key, in non-extractable form.
    await openOn('phone');
    await vault.initVault();
    await vault.unlockWithPassphrase(PASS);
    const keys = vault.deviceKeys();
    expect(keys).toHaveLength(3);
    expect(keys.every((k) => !k.extractable)).toBe(true);
    expect(await c.decryptText(keys[2], gen0, 'lumen/1/note/n1/content')).toBe('generation 0');
    // And keeps them across a page load.
    await pageLoad();
    await vault.initVault();
    expect(vault.deviceKeys()).toHaveLength(3);
    expect(apiMod.currentKeyGen()).toBe(2);
  });

  it('needs the passphrase and the connection', async () => {
    await setUp();
    await expect(vault.prepareKeyReplacement('wrong')).rejects.toThrow(/isn’t right/);
    server.offline = true;
    await expect(vault.prepareKeyReplacement(PASS)).rejects.toThrow(/Connect to the internet/);
  });
});

describe('a keyring missing from the server', () => {
  it('is put back from this device’s copy, rather than encryption being turned off', async () => {
    await setUp();
    const copy = server.keyring!.data;
    await vault.lock();
    server.keyring = null;
    await pageLoad();
    expect(await vault.initVault()).toBe('locked');
    expect(server.keyring!.data).toEqual(copy);
    await vault.unlockWithPassphrase(PASS);
  });

  it('leaves a device that has seen the library encrypted locked, and says so', async () => {
    localStorage.setItem('kb.vault.sealed', '1');
    await pageLoad();
    expect(await vault.initVault()).toBe('locked');
    await expect(vault.unlockWithPassphrase(PASS)).rejects.toThrow(/can’t find your encryption keyring/);
  });
});

describe('signing out of the device', () => {
  it('removes the key, the device markers and every copy kept here, except appearance settings', async () => {
    await setUp();
    localStorage.setItem('kb.vault.sealed', '1');
    localStorage.setItem('kb.vault.attachments', '1');
    localStorage.setItem('kb.draft.n1', '{"content":"x"}');
    localStorage.setItem('kb.settings', '{"theme":"dark"}');
    localStorage.setItem('other-site-thing', 'kept');
    sessionStorage.setItem('kb.filter', '{}');
    // The on-device copy of the notes.
    await new Promise<void>((resolve) => {
      const req = indexedDB.open('lumen-notes', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('notes', { keyPath: 'id' });
      req.onsuccess = () => {
        req.result.close();
        resolve();
      };
    });
    const { signOutOfDevice } = await import('../../src/lib/signout');
    await signOutOfDevice(true);

    expect(vault.vaultKey()).toBeNull();
    expect(apiMod.currentCodec()).toBeNull();
    expect((await indexedDB.databases()).map((d) => d.name)).toEqual([]);
    expect(dump(localStorage)).toEqual({ 'kb.settings': '{"theme":"dark"}', 'other-site-thing': 'kept' });
    expect(dump(sessionStorage)).toEqual({});
    // Other tabs leave too, before the storage they share is cleared.
    expect(FakeChannel.last!.posted).toContainEqual({ signout: '/' });
    expect(nav.href).toBe('/');

    // Signed back in: the passphrase is needed again, and nothing is assumed about the library.
    await pageLoad();
    expect(apiMod.libraryEncrypted()).toBe(false);
    expect(apiMod.attachmentsEncrypted()).toBe(false);
    expect(await vault.initVault()).toBe('locked');
  });

  it('in another tab: this one drops its key and leaves without sending anything', async () => {
    await setUp();
    FakeChannel.last!.deliver({ signout: '/cdn-cgi/access/logout' });
    await vi.waitFor(() => expect(nav.replaced).toBe('/cdn-cgi/access/logout'));
    expect(vault.vaultKey()).toBeNull();
    expect(apiMod.currentCodec()).toBeNull();
    expect(saver.discardAll).toBe(1);
  });

  it('ignores a sign-out message naming somewhere else to go', async () => {
    await setUp();
    FakeChannel.last!.deliver({ signout: 'https://evil.example/' });
    await new Promise((r) => setTimeout(r, 10));
    expect(nav.replaced).toBe('');
    expect(vault.encrypting()).toBe(true);
  });
});
