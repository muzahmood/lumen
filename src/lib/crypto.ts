/**
 * The cryptography behind end-to-end encryption, all from the browser's Web Crypto API.
 *
 * - One random 256-bit master key encrypts everything (AES-GCM, a fresh 96-bit IV per message).
 * - The master key is stored only wrapped (encrypted): by a key derived from the passphrase
 *   (PBKDF2-SHA256), and by a random recovery key the person keeps. Neither secret leaves the device.
 * - Every ciphertext carries "additional data" naming what it is (note id and field), so the server
 *   can't move an encrypted title onto another note, or a note's body into a different note.
 *
 * Ciphertext is stored as text: "e1:" + base64url(iv || AES-GCM output).
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** OWASP's recommendation for PBKDF2-HMAC-SHA256 (2023). Stored per keyring, so it can be raised later. */
export const PBKDF2_ITERATIONS = 600_000;

export function randomBytes(n: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(n));
}

export function toBase64Url(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64Url(text: string): Uint8Array {
  const b64 = text.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((text.length + 3) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Copies into a fresh ArrayBuffer-backed array, which Web Crypto's typings require. */
const buf = (bytes: Uint8Array) => new Uint8Array(bytes);

/** A key from the passphrase, used only to wrap and unwrap the master key. */
export async function passphraseKey(passphrase: string, salt: Uint8Array, iterations: number): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey('raw', encoder.encode(passphrase.normalize('NFKC')), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt: buf(salt), iterations },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['wrapKey', 'unwrapKey'],
  );
}

/** The recovery key's bytes as a wrapping key. */
export function recoveryWrappingKey(bytes: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', buf(bytes), { name: 'AES-GCM' }, false, ['wrapKey', 'unwrapKey']);
}

/** A new master key. Extractable only so it can be wrapped once; it's re-imported non-extractable for use. */
export function newMasterKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']) as Promise<CryptoKey>;
}

export interface Wrapped {
  iv: string;
  key: string;
}

export async function wrapKey(key: CryptoKey, wrapping: CryptoKey, label: string): Promise<Wrapped> {
  const iv = randomBytes(12);
  const wrapped = await crypto.subtle.wrapKey('raw', key, wrapping, { name: 'AES-GCM', iv: buf(iv), additionalData: encoder.encode(label) });
  return { iv: toBase64Url(iv), key: toBase64Url(new Uint8Array(wrapped)) };
}

/**
 * Unwraps the master key. Fails (throws) on a wrong passphrase or recovery key, since AES-GCM checks
 * its tag. `extractable` only for re-wrapping it under a new passphrase or recovery key.
 */
export function unwrapKey(w: Wrapped, wrapping: CryptoKey, label: string, extractable = false): Promise<CryptoKey> {
  return crypto.subtle.unwrapKey(
    'raw',
    buf(fromBase64Url(w.key)),
    wrapping,
    { name: 'AES-GCM', iv: buf(fromBase64Url(w.iv)), additionalData: encoder.encode(label) },
    { name: 'AES-GCM', length: 256 },
    extractable,
    ['encrypt', 'decrypt'],
  );
}

const PREFIX = 'e1:';

export function isCiphertext(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith(PREFIX);
}

export async function encryptBytes(key: CryptoKey, data: Uint8Array, context: string): Promise<Uint8Array> {
  const iv = randomBytes(12);
  const sealed = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv: buf(iv), additionalData: encoder.encode(context) }, key, buf(data)),
  );
  const out = new Uint8Array(12 + sealed.length);
  out.set(iv);
  out.set(sealed, 12);
  return out;
}

export async function decryptBytes(key: CryptoKey, data: Uint8Array, context: string): Promise<Uint8Array> {
  return new Uint8Array(
    await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: buf(data.subarray(0, 12)), additionalData: encoder.encode(context) },
      key,
      buf(data.subarray(12)),
    ),
  );
}

export async function encryptText(key: CryptoKey, text: string, context: string): Promise<string> {
  return PREFIX + toBase64Url(await encryptBytes(key, encoder.encode(text), context));
}

export async function decryptText(key: CryptoKey, payload: string, context: string): Promise<string> {
  if (!isCiphertext(payload)) throw new Error('Not encrypted');
  return decoder.decode(await decryptBytes(key, fromBase64Url(payload.slice(PREFIX.length)), context));
}

/* -------------------------------------------------------- recovery key --- */

// Crockford's base32: no I, L, O or U, so the key survives being written down and read back.
const B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** 32 random bytes as 52 base32 characters in groups of four: "7KQ2-…". */
export function formatRecoveryKey(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out.match(/.{1,4}/g)!.join('-');
}

/** Reads a recovery key back, forgiving case, spaces, dashes and look-alike letters. Null if malformed. */
export function parseRecoveryKey(text: string): Uint8Array | null {
  const clean = text
    .toUpperCase()
    .replace(/[\s-]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1');
  if (clean.length !== 52 || /[^0-9A-HJKMNP-TV-Z]/.test(clean)) return null;
  const out = new Uint8Array(32);
  let bits = 0;
  let value = 0;
  let i = 0;
  for (const ch of clean) {
    value = (value << 5) | B32.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      if (i < 32) out[i++] = (value >>> (bits - 8)) & 255;
      bits -= 8;
    }
  }
  return i === 32 ? out : null;
}
