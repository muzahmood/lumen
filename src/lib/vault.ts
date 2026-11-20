/**
 * The vault: whether this library is end-to-end encrypted, and whether this device has the key.
 *
 * - "off": no keyring on the server; notes are stored as before (protected by Cloudflare Access).
 * - "locked": encrypted, and this device doesn't hold the key; the passphrase (or recovery key) opens it.
 * - "unlocked": the master key is in memory and in this browser's IndexedDB as a non-extractable
 *   CryptoKey (scripts can use it, but can't read it out), so the device stays unlocked until it's
 *   locked, auto-locks or signs out.
 *
 * While locked, anything Lumen keeps in this browser's storage that holds note text (unsent edits,
 * the Home capture box, a drawing's crash copy) is kept encrypted too.
 */
import { create } from 'zustand';
import { api, libraryEncrypted, onEncryptionRequired, onKeyChanged, setCodec, setKeyGen } from './api';
import {
  PBKDF2_ITERATIONS,
  decryptBytes,
  decryptText,
  encryptBytes,
  encryptText,
  formatRecoveryKey,
  fromBase64Url,
  isCiphertext,
  newMasterKey,
  parseRecoveryKey,
  passphraseKey,
  randomBytes,
  recoveryWrappingKey,
  toBase64Url,
  unwrapKey,
  wrapKey,
} from './crypto';
import { createCodec, dropCachedResponses } from './e2ee';
import { useSettings } from './settings';
import { keepStorage } from './utils';
import type { Keyring, KeyringData } from './types';

export type VaultState = 'checking' | 'off' | 'locked' | 'unlocked';

const PASS_LABEL = 'lumen/1/keyring/pass';
const RECOVERY_LABEL = 'lumen/1/keyring/recovery';
const KEYRING_CACHE = 'kb.keyring';
const ACTIVE_KEY = 'kb.vault.active';
const IDB_NAME = 'lumen-vault';
const OFFLINE = 'Connect to the internet to unlock your notes on this device for the first time.';

export const useVault = create<{ state: VaultState }>(() => ({ state: 'checking' }));

let masterKey: CryptoKey | null = null;

/** The key that encrypts notes, while unlocked. */
export function vaultKey(): CryptoKey | null {
  return masterKey;
}

/** True while notes are being encrypted and decrypted on this device. */
export function encrypting(): boolean {
  return masterKey !== null;
}

/** Every key this device holds while unlocked: the current one, then earlier ones (after a key replacement). */
export function deviceKeys(): CryptoKey[] {
  return masterKey ? [masterKey, ...olderKeys] : [];
}

/** The encryption settings (the wrapped key), from the server or this device's copy; null if there are none. */
export async function currentKeyring(): Promise<Keyring | null> {
  return (await fetchKeyring()).keyring;
}

/**
 * The keys a set of encryption settings opens with a passphrase or a recovery key (either works): the
 * key they hold, then the earlier keys kept with it. Null when the secret opens neither. For backups,
 * which carry the settings from when they were made.
 */
export async function keysFromSecret(data: KeyringData, secret: string): Promise<CryptoKey[] | null> {
  let master = await tryPassphrase(data, secret);
  if (!master) {
    const bytes = parseRecoveryKey(secret);
    if (bytes) {
      try {
        master = await unwrapKey(data.recovery, await recoveryWrappingKey(bytes), RECOVERY_LABEL);
      } catch {
        master = null;
      }
    }
  }
  if (!master) return null;
  const older = await openOlderKeys(data, master).catch(() => []);
  return [master, ...older];
}

/* ------------------------------------------------------------ storage --- */

function idb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore('keys');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbRun<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await idb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const req = fn(db.transaction('keys', mode).objectStore('keys'));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
}

const storedKey = () => idbRun<CryptoKey | undefined>('readonly', (s) => s.get('master') as IDBRequest<CryptoKey | undefined>).catch(() => undefined);
/** Earlier master keys (after a key replacement) and the key generation, kept with the key. */
const storedOlder = () =>
  idbRun<{ older: CryptoKey[]; gen: number } | undefined>('readonly', (s) => s.get('older') as IDBRequest<{ older: CryptoKey[]; gen: number } | undefined>).catch(
    () => undefined,
  );
const storeKey = async (key: CryptoKey, older: CryptoKey[], gen: number) => {
  await idbRun('readwrite', (s) => s.put(key, 'master'));
  await idbRun('readwrite', (s) => s.put({ older, gen }, 'older'));
};
const dropStoredKey = async () => {
  await idbRun('readwrite', (s) => s.delete('master')).catch(() => undefined);
  await idbRun('readwrite', (s) => s.delete('older')).catch(() => undefined);
};

/** Keys other than the current one, while unlocked (see storedOlder). */
let olderKeys: CryptoKey[] = [];
/** The key generation this tab holds. */
let myGen = 0;

/*
 * Replacing the encryption key: the keyring then holds the earlier master keys too (`prev`, newest
 * first), each encrypted with the new key, so text written before the replacement still opens while
 * it's being encrypted again, and afterwards (drafts this device sealed with the old key, say). Plain
 * AES-GCM over the raw key bytes, since master keys are only made for encrypting.
 */
const PREV_LABEL = 'lumen/1/keyring/prev';

async function sealOlderKey(raw: ArrayBuffer, master: CryptoKey): Promise<{ iv: string; key: string }> {
  const sealed = await encryptBytes(master, new Uint8Array(raw), PREV_LABEL);
  return { iv: toBase64Url(sealed.subarray(0, 12)), key: toBase64Url(sealed.subarray(12)) };
}

async function openOlderKeys(data: KeyringData, master: CryptoKey, extractable = false): Promise<CryptoKey[]> {
  const out: CryptoKey[] = [];
  for (const w of data.prev ?? []) {
    const iv = fromBase64Url(w.iv);
    const body = fromBase64Url(w.key);
    const joined = new Uint8Array(iv.length + body.length);
    joined.set(iv);
    joined.set(body, iv.length);
    const raw = await decryptBytes(master, joined, PREV_LABEL);
    out.push(await crypto.subtle.importKey('raw', raw as BufferSource, { name: 'AES-GCM' }, extractable, ['encrypt', 'decrypt']));
  }
  return out;
}

/** Removes this device's copy of the key entirely (used when signing out). */
export function forgetDeviceKey(): Promise<void> {
  masterKey = null;
  setCodec(null);
  return new Promise((resolve) => {
    try {
      const req = indexedDB.deleteDatabase(IDB_NAME);
      req.onsuccess = req.onerror = req.onblocked = () => resolve();
    } catch {
      // No IndexedDB here (some private windows): there's no stored key to remove.
      resolve();
    }
  });
}

function cacheKeyring(k: Keyring | null) {
  try {
    if (k) localStorage.setItem(KEYRING_CACHE, JSON.stringify(k));
    else localStorage.removeItem(KEYRING_CACHE);
  } catch {
    /* ignore */
  }
}

function cachedKeyring(): Keyring | null {
  try {
    return JSON.parse(localStorage.getItem(KEYRING_CACHE) || 'null') as Keyring | null;
  } catch {
    return null;
  }
}

/** The current keyring from the server, or the copy saved on this device when offline. */
async function fetchKeyring(): Promise<{ keyring: Keyring | null; fromCache: boolean }> {
  let keyring: Keyring | null;
  try {
    ({ keyring } = await api.keyring());
  } catch {
    return { keyring: cachedKeyring(), fromCache: true };
  }
  const cached = cachedKeyring();
  if (!keyring && cached) {
    // The server has lost its keyring (or someone removed it). Encryption is never turned off that
    // way, since new notes would then be stored readable: put this device's copy back instead.
    try {
      ({ keyring } = await api.saveKeyring(cached.data, null));
    } catch {
      return { keyring: cached, fromCache: true };
    }
  }
  cacheKeyring(keyring);
  return { keyring, fromCache: false };
}

const CHECK_LABEL = 'lumen/1/keyring/check';
const CHECK_TEXT = 'lumen-key-check';

/** False when `key` isn't the keyring's master key (the library was set up again with a new one). */
async function keyMatches(key: CryptoKey, data: KeyringData): Promise<boolean> {
  if (!data.check) return true;
  try {
    return (await decryptText(key, data.check, CHECK_LABEL)) === CHECK_TEXT;
  } catch {
    return false;
  }
}

/* ------------------------------------------------- device-local text --- */

/** Browser storage that can hold note text: unsent edits, the capture box, a drawing's crash copy. */
function localTextKeys(): string[] {
  const keys: string[] = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && (k.startsWith('kb.draft.') || k === 'kb.capture' || k === 'kb.drawing-backup')) keys.push(k);
    }
  } catch {
    /* ignore */
  }
  return keys;
}

/**
 * Marks text this device sealed. Not "e1:" alone: the capture box holds whatever was typed, which could
 * start that way and would then be left readable.
 */
const LOCAL_SEALED = '\u0001sealed:';

/**
 * True from the moment text kept in browser storage starts being encrypted for locking until the next
 * unlock: nothing may write note text there in the clear meanwhile (the drawing editor's crash copy,
 * written as the page hides or reloads, would otherwise land over the encrypted one).
 */
let localSealed = false;
export function localTextSealed(): boolean {
  return localSealed;
}

/** Told just before that text is encrypted, to put what's only in memory (a drawing's latest strokes) there first. */
const beforeSealListeners = new Set<() => void>();
export function onBeforeLocalSeal(fn: () => void): () => void {
  beforeSealListeners.add(fn);
  return () => beforeSealListeners.delete(fn);
}

async function sealLocalText(key: CryptoKey) {
  for (const fn of beforeSealListeners) {
    try {
      fn();
    } catch {
      /* what it kept before is sealed all the same */
    }
  }
  localSealed = true;
  for (const k of localTextKeys()) {
    const value = localStorage.getItem(k);
    if (value && !value.startsWith(LOCAL_SEALED)) localStorage.setItem(k, LOCAL_SEALED + (await encryptText(key, value, `lumen/1/local/${k}`)));
  }
}

async function openLocalText(keys: CryptoKey[]) {
  for (const k of localTextKeys()) {
    const value = localStorage.getItem(k);
    if (!value) continue;
    // Sealed before the marker existed: plain "e1:" ciphertext (or typed text that only looks like it,
    // which no key opens and so stays as it is).
    const sealed = value.startsWith(LOCAL_SEALED) ? value.slice(LOCAL_SEALED.length) : isCiphertext(value) ? value : null;
    if (sealed === null) continue;
    // Sealed with the current key, or with an earlier one before a key replacement.
    for (const key of keys) {
      try {
        localStorage.setItem(k, await decryptText(key, sealed, `lumen/1/local/${k}`));
        break;
      } catch {
        /* not this key */
      }
    }
  }
}

/** The note list's tag filter is kept for the tab's session, readable: a tag name says something. */
function forgetSessionText() {
  try {
    sessionStorage.removeItem('kb.filter');
  } catch {
    /* no session storage */
  }
}

/* --------------------------------------------------------------- state --- */

/** Works out whether this library is encrypted and whether this device can open it. Call once at startup. */
export async function initVault(): Promise<VaultState> {
  const local = await storedKey();
  if (local && autoLockDue()) {
    // Locked while Lumen was closed: what it left in browser storage is encrypted first.
    await sealLocalText(local).catch(() => undefined);
    forgetSessionText();
    await dropStoredKey();
  } else if (local) {
    const kept = await storedOlder();
    masterKey = local;
    olderKeys = kept?.older ?? [];
    myGen = kept?.gen ?? cachedKeyring()?.data.gen ?? 0;
    setKeyGen(myGen);
    setCodec(createCodec(local, olderKeys));
    useVault.setState({ state: 'unlocked' });
    startAutoLock();
    // Check in the background that this is still the library's key. If the key was replaced on
    // another device (or encryption set up again after a reset), this one would encrypt notes no
    // other device could read: lock, keeping unsent edits encrypted with this key, which the new
    // keyring still opens.
    void fetchKeyring().then(async ({ keyring }) => {
      if (keyring && !(await keyMatches(local, keyring.data))) await lockAfterReplacement();
    });
    return 'unlocked';
  }
  const { keyring } = await fetchKeyring();
  // A library this device has seen fully encrypted stays locked without a keyring (it says the keyring
  // is missing), rather than carrying on unencrypted.
  const state: VaultState = keyring || libraryEncrypted() ? 'locked' : 'off';
  if (keyring) await dropPlainCachesOnce();
  useVault.setState({ state });
  return state;
}

const CACHES_CLEARED = 'kb.vault.caches-cleared';

/**
 * The service worker's offline copies of notes from before encryption hold plaintext: they go the
 * first time this device learns encryption is on. Only once, so unlocking offline later keeps the
 * (by then encrypted) offline copies.
 */
async function dropPlainCachesOnce() {
  try {
    if (localStorage.getItem(CACHES_CLEARED)) return;
  } catch {
    /* no storage: clear every time */
  }
  await dropCachedResponses();
  try {
    localStorage.setItem(CACHES_CLEARED, '1');
  } catch {
    /* ignore */
  }
}

/** The keyring is gone from the server, yet the library is encrypted (see fetchKeyring). */
const KEYRING_MISSING =
  'Lumen can’t find your encryption keyring on the server. Open Lumen on a device that’s still unlocked: it puts the keyring back.';

async function becomeUnlocked(key: CryptoKey, older: CryptoKey[] = [], gen = 0) {
  await storeKey(key, older, gen).catch(() => undefined);
  masterKey = key;
  olderKeys = older;
  myGen = gen;
  setKeyGen(gen);
  setCodec(createCodec(key, older));
  await openLocalText([key, ...older]);
  localSealed = false;
  await dropPlainCachesOnce();
  markActive(true);
  startAutoLock();
  // What this device keeps (the key, the encrypted copy of every note, unsent edits) is kept for good.
  keepStorage();
  useVault.setState({ state: 'unlocked' });
  tabs?.postMessage('unlock');
}

/** Opens the library with the passphrase. Throws a message for the person if it doesn't open it. */
export async function unlockWithPassphrase(passphrase: string): Promise<void> {
  const { keyring, fromCache } = await fetchKeyring();
  if (!keyring) throw new Error(fromCache ? OFFLINE : KEYRING_MISSING);
  const key = await tryPassphrase(keyring.data, passphrase);
  if (!key) throw new Error('That passphrase didn’t unlock your notes. Check it and try again, or use your recovery key.');
  await becomeUnlocked(key, await openOlderKeys(keyring.data, key), keyring.data.gen ?? 0);
}

async function tryPassphrase(data: KeyringData, passphrase: string, extractable = false): Promise<CryptoKey | null> {
  try {
    const wrapping = await passphraseKey(passphrase, fromBase64Url(data.kdf.salt), data.kdf.iterations);
    return await unwrapKey(data.pass, wrapping, PASS_LABEL, extractable);
  } catch {
    return null;
  }
}

async function passWrap(master: CryptoKey, passphrase: string) {
  const salt = randomBytes(16);
  const wrapping = await passphraseKey(passphrase, salt, PBKDF2_ITERATIONS);
  return {
    kdf: { name: 'PBKDF2' as const, hash: 'SHA-256' as const, iterations: PBKDF2_ITERATIONS, salt: toBase64Url(salt) },
    pass: await wrapKey(master, wrapping, PASS_LABEL),
  };
}

async function saveKeyring(data: KeyringData, replaces: number | null) {
  const { keyring } = await api.saveKeyring(data, replaces);
  cacheKeyring(keyring);
}

export interface PreparedSetup {
  /** The recovery key, to show once. */
  recoveryKey: string;
  /** Turns encryption on: stores the keyring and unlocks this device. */
  commit: () => Promise<void>;
}

/**
 * Prepares encryption without changing anything yet: a new master key, the recovery key, and the
 * keyring. Nothing is stored until `commit`, so closing the window before saving the recovery key
 * leaves the library as it was.
 */
export async function prepareSetup(passphrase: string): Promise<PreparedSetup> {
  const master = await newMasterKey();
  const recoveryBytes = randomBytes(32);
  const data: KeyringData = {
    v: 1,
    ...(await passWrap(master, passphrase)),
    recovery: await wrapKey(master, await recoveryWrappingKey(recoveryBytes), RECOVERY_LABEL),
    check: await encryptText(master, CHECK_TEXT, CHECK_LABEL),
  };
  return {
    recoveryKey: formatRecoveryKey(recoveryBytes),
    commit: async () => {
      const { keyring } = await fetchKeyring();
      // Also refused if notes are already encrypted (with a key whose keyring has gone missing): a
      // second key would leave them unreadable.
      const { encryption } = await api.bootstrap();
      if (keyring || encryption?.on) throw new Error('Encryption was turned on from another device. Reload to unlock with that passphrase.');
      await saveKeyring(data, null);
      // Kept from here on in non-extractable form: unwrap it again from what was just stored.
      const wrapping = await passphraseKey(passphrase, fromBase64Url(data.kdf.salt), data.kdf.iterations);
      await becomeUnlocked(await unwrapKey(data.pass, wrapping, PASS_LABEL));
    },
  };
}

/** Opens the library with the recovery key and sets a new passphrase. */
export async function recoverWithKey(recoveryText: string, newPassphrase: string): Promise<void> {
  const bytes = parseRecoveryKey(recoveryText);
  if (!bytes) throw new Error('That isn’t a recovery key. It’s 52 letters and digits in groups of four.');
  const { keyring, fromCache } = await fetchKeyring();
  if (fromCache) throw new Error('Connect to the internet to use your recovery key.');
  if (!keyring) throw new Error(KEYRING_MISSING);
  let master: CryptoKey;
  try {
    master = await unwrapKey(keyring.data.recovery, await recoveryWrappingKey(bytes), RECOVERY_LABEL, true);
  } catch {
    throw new Error('That recovery key didn’t unlock your notes. Check it and try again.');
  }
  await saveKeyring({ ...keyring.data, ...(await passWrap(master, newPassphrase)) }, keyring.id);
  await becomeUnlocked(await reimport(master), await openOlderKeys(keyring.data, master), keyring.data.gen ?? 0);
}

/** A non-extractable copy of an extractable key. */
async function reimport(key: CryptoKey): Promise<CryptoKey> {
  const raw = await crypto.subtle.exportKey('raw', key);
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

/** Replaces the passphrase. The notes don't change; only the wrapped key does. */
export async function changePassphrase(current: string, next: string): Promise<void> {
  const { keyring, fromCache } = await fetchKeyring();
  if (!keyring || fromCache) throw new Error('Connect to the internet to change your passphrase.');
  const master = await tryPassphrase(keyring.data, current, true);
  if (!master) throw new Error('Your current passphrase isn’t right.');
  await saveKeyring({ ...keyring.data, ...(await passWrap(master, next)) }, keyring.id);
}

/** Makes a new recovery key; the previous one stops working. Returns it, to show once. */
export async function replaceRecoveryKey(passphrase: string): Promise<string> {
  const { keyring, fromCache } = await fetchKeyring();
  if (!keyring || fromCache) throw new Error('Connect to the internet to make a new recovery key.');
  const master = await tryPassphrase(keyring.data, passphrase, true);
  if (!master) throw new Error('That passphrase isn’t right.');
  const bytes = randomBytes(32);
  await saveKeyring({ ...keyring.data, recovery: await wrapKey(master, await recoveryWrappingKey(bytes), RECOVERY_LABEL) }, keyring.id);
  return formatRecoveryKey(bytes);
}

let replacingKey = false;

/**
 * Prepares replacing the encryption key: a new master key and recovery key, and a keyring that keeps
 * the passphrase and lists the old key (and any earlier ones) under the new one. Nothing changes until
 * `commit`, which stores the keyring and moves this device to the new key. Everything already saved is
 * then encrypted again (rekeyLibrary in e2ee.ts). The old passphrase stays; the recovery key is new,
 * since the old one only ever opened the old key.
 */
export async function prepareKeyReplacement(passphrase: string): Promise<PreparedSetup> {
  const { keyring, fromCache } = await fetchKeyring();
  if (!keyring || fromCache) throw new Error('Connect to the internet to replace your encryption key.');
  const oldKey = await tryPassphrase(keyring.data, passphrase, true);
  if (!oldKey) throw new Error('That passphrase isn’t right.');
  const earlier = await openOlderKeys(keyring.data, oldKey, true);
  const raws = (await Promise.all([oldKey, ...earlier].map((k) => crypto.subtle.exportKey('raw', k)))).slice(0, 20);
  const next = await newMasterKey();
  const recoveryBytes = randomBytes(32);
  const gen = (keyring.data.gen ?? 0) + 1;
  const data: KeyringData = {
    v: 1,
    gen,
    ...(await passWrap(next, passphrase)),
    recovery: await wrapKey(next, await recoveryWrappingKey(recoveryBytes), RECOVERY_LABEL),
    check: await encryptText(next, CHECK_TEXT, CHECK_LABEL),
    prev: await Promise.all(raws.map((raw) => sealOlderKey(raw, next))),
  };
  return {
    recoveryKey: formatRecoveryKey(recoveryBytes),
    commit: async () => {
      replacingKey = true;
      try {
        // Edits waiting to be sent go first, under the key they were written with.
        try {
          const { flushAll } = await import('./saver');
          await flushAll();
        } catch {
          /* offline: they stay as drafts, sent with the new key later */
        }
        await saveKeyring(data, keyring.id);
        const older = await Promise.all(raws.map((raw) => crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])));
        await becomeUnlocked(await reimport(next), older, gen);
        // Other Lumen tabs in this browser hold the old key: they reload onto the new one.
        tabs?.postMessage('rekeyed');
      } finally {
        replacingKey = false;
      }
    },
  };
}

let lockingAfterReplacement = false;

/**
 * The key was replaced on another device. This device locks: unsent edits are sealed with the key it
 * holds (the new keyring still opens that one), and unlocking with the passphrase moves it to the new key.
 */
async function lockAfterReplacement() {
  if (lockingAfterReplacement) return;
  lockingAfterReplacement = true;
  // Replaced in another tab of this browser, which stored the new key: nothing to lock, only to
  // reload onto it (dropping the stored key here would throw away the new one).
  const stored = await storedOlder();
  if (stored && stored.gen > myGen) {
    location.reload();
    return;
  }
  try {
    sessionStorage.setItem(NOTICE_KEY, 'key-replaced');
  } catch {
    /* ignore */
  }
  const key = masterKey;
  // Not sent: the server would refuse text under this key. Kept, encrypted, until the next unlock.
  try {
    (await import('./saver')).freezeDrafts();
  } catch {
    /* ignore */
  }
  if (key) await sealLocalText(key).catch(() => undefined);
  forgetSessionText();
  await dropStoredKey();
  masterKey = null;
  location.reload();
}

const NOTICE_KEY = 'kb.vault.notice';

/** Why this device was locked, if not by the person (shown on the unlock screen once). */
export function takeLockNotice(): string | null {
  try {
    const notice = sessionStorage.getItem(NOTICE_KEY);
    sessionStorage.removeItem(NOTICE_KEY);
    return notice === 'key-replaced' ? 'Your encryption key was replaced on another device. Unlock with your passphrase to continue.' : null;
  } catch {
    return null;
  }
}

// A write refused because the key moved on: replaced elsewhere (not by this device, mid-replacement).
onKeyChanged(() => {
  if (masterKey && !replacingKey) void lockAfterReplacement();
});

/**
 * Locks this device: encrypts note text kept in browser storage, removes the key from the browser,
 * and reloads to the unlock screen. Edits not yet saved are sent first where possible.
 */
export async function lock(everywhere = true): Promise<void> {
  const key = masterKey;
  if (!key) return;
  try {
    const { flushAll, freezeDrafts } = await import('./saver');
    await flushAll();
    freezeDrafts();
  } catch {
    /* offline: they stay on the device, encrypted below */
  }
  await sealLocalText(key);
  await dropStoredKey();
  masterKey = null;
  forgetSessionText();
  // Other Lumen tabs in this browser still hold the key in memory: they lock too.
  if (everywhere) tabs?.postMessage('lock');
  location.reload();
}

/** Keeps every Lumen tab in this browser locked or unlocked together. */
const tabs = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel('lumen-vault');
tabs?.addEventListener('message', (e: MessageEvent) => {
  if (e.data === 'lock' && masterKey) void lock(false);
  // Unlocked in another tab: the key is in IndexedDB now, so pick it up.
  else if (e.data === 'unlock' && !masterKey && useVault.getState().state === 'locked') void initVault();
  // The key was replaced in another tab, which stored the new one: start again with it.
  else if (e.data === 'rekeyed') location.reload();
  else if (e.data && typeof e.data === 'object' && SIGN_OUT_DESTINATIONS.has((e.data as { signout?: string }).signout ?? '')) {
    void signedOutElsewhere((e.data as { signout: string }).signout);
  }
});

const SIGN_OUT_DESTINATIONS = new Set(['/', '/cdn-cgi/access/logout']);

/**
 * "Sign out of this device" in one tab: every other Lumen tab in this browser leaves as well. Without
 * this they'd keep showing decrypted notes, and write drafts and the keyring back into the storage
 * the signing-out tab just cleared.
 */
export function announceSignOut(destination: string) {
  tabs?.postMessage({ signout: destination });
}

async function signedOutElsewhere(destination: string) {
  masterKey = null;
  setCodec(null);
  const { discardAll } = await import('./saver');
  discardAll();
  location.replace(destination);
}

/**
 * The server refused plaintext: encryption was turned on from another device while this one had
 * Lumen open. Ask for the passphrase; unsent edits stay on this device until then.
 */
onEncryptionRequired(() => noticeEncryption(true));

/** Bootstrap said encryption is on but this device can't decrypt: same as above. */
export function noticeEncryption(on: boolean) {
  if (!on || masterKey) return;
  void dropPlainCachesOnce();
  useVault.setState({ state: 'locked' });
}

/* ------------------------------------------------------------ auto-lock --- */

let autoLockStarted = false;
let lastWrite = 0;

function markActive(force = false) {
  const now = Date.now();
  if (!force && now - lastWrite < 30_000) return;
  lastWrite = now;
  try {
    localStorage.setItem(ACTIVE_KEY, String(now));
  } catch {
    /* ignore */
  }
}

function autoLockDue(): boolean {
  const minutes = useSettings.getState().autoLockMinutes;
  if (!minutes) return false;
  try {
    const last = Number(localStorage.getItem(ACTIVE_KEY) || 0);
    return last > 0 && Date.now() - last > minutes * 60_000;
  } catch {
    return false;
  }
}

/** Locks after the chosen time without use (Settings → Security). Also checked when Lumen next opens. */
function startAutoLock() {
  if (autoLockStarted) return;
  autoLockStarted = true;
  markActive(true);
  for (const type of ['pointerdown', 'keydown', 'wheel', 'touchstart']) {
    window.addEventListener(type, () => markActive(), { passive: true, capture: true });
  }
  setInterval(() => {
    if (masterKey && autoLockDue()) void lock();
  }, 30_000);
}
