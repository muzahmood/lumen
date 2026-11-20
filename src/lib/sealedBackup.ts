/**
 * Encrypted backups (.lumenbackup): the same .zip as a readable backup, encrypted on the device.
 *
 * - The .zip is encrypted (AES-256-GCM) under a random key made for this backup.
 * - That key is stored in the file encrypted with the library's key, and the file carries the
 *   encryption settings as they were (the library key wrapped by the passphrase and by the recovery
 *   key). So the backup opens with either secret as it was when it was made, in any copy of Lumen,
 *   even a new one, and without the server; a device still unlocked with that key opens it as it is.
 *
 * Layout: "LUMENBK1", the header's length (4 bytes, big-endian), the header (JSON), the encrypted .zip.
 */
import { decryptBytes, encryptBytes, fromBase64Url, toBase64Url } from './crypto';
import type { KeyringData } from './types';

const MAGIC = 'LUMENBK1';

/** The backup's own key (in its header) was changed: the right passphrase or recovery key can't open it. */
export const DAMAGED_KEY =
  'This backup file is damaged. Your passphrase or recovery key is right, but the key stored in the file was changed, so its notes can’t be read. Try another copy of the backup.';
const BODY = 'lumen/1/backup/body';
const KEY = 'lumen/1/backup/key';

export interface SealedBackupHeader {
  format: 'lumen-backup';
  v: 1;
  created: number;
  /** The key generation the backup's key was encrypted under. */
  gen: number;
  /** The encryption settings when the backup was made: the library key, wrapped by passphrase and recovery key. */
  keyring: KeyringData;
  /** This backup's own key, encrypted with the library key (base64url of IV and ciphertext). */
  key: string;
}

const utf8 = new TextEncoder();
const fromUtf8 = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

export async function sealBackup(zip: Uint8Array, libraryKey: CryptoKey, keyring: KeyringData, gen: number): Promise<Blob> {
  const own = (await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt'])) as CryptoKey;
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', own));
  const [body, wrapped] = await Promise.all([encryptBytes(own, zip, BODY), encryptBytes(libraryKey, raw, KEY)]);
  raw.fill(0);
  const header: SealedBackupHeader = { format: 'lumen-backup', v: 1, created: Date.now(), gen, keyring, key: toBase64Url(wrapped) };
  const head = utf8.encode(JSON.stringify(header));
  const length = new Uint8Array(4);
  new DataView(length.buffer).setUint32(0, head.length);
  return new Blob([utf8.encode(MAGIC) as BlobPart, length as BlobPart, head as BlobPart, body as BlobPart], { type: 'application/octet-stream' });
}

/** The header and encrypted body of an encrypted backup, or null if the bytes aren't one (a .zip, say). */
export function readSealedBackup(bytes: Uint8Array): { header: SealedBackupHeader; body: Uint8Array } | null {
  if (bytes.length < 12 || fromUtf8(bytes.subarray(0, 8)) !== MAGIC) return null;
  const length = new DataView(bytes.buffer, bytes.byteOffset + 8, 4).getUint32(0);
  if (length > 1_000_000 || 12 + length > bytes.length) throw new Error('This backup file is incomplete or damaged.');
  let header: SealedBackupHeader;
  try {
    header = JSON.parse(fromUtf8(bytes.subarray(12, 12 + length))) as SealedBackupHeader;
  } catch {
    throw new Error('This backup file is incomplete or damaged.');
  }
  if (header?.format !== 'lumen-backup' || header.v !== 1 || typeof header.key !== 'string' || !header.keyring?.pass) {
    throw new Error('This backup was made by a newer version of Lumen, or isn’t a Lumen backup.');
  }
  return { header, body: bytes.subarray(12 + length) };
}

/**
 * The backup's .zip, decrypted with the first of `keys` that opens it; null when none does (ask for
 * the passphrase or recovery key then). Throws if a key opens it but the contents were changed.
 */
export async function openSealedBackup(sealed: { header: SealedBackupHeader; body: Uint8Array }, keys: CryptoKey[]): Promise<Uint8Array | null> {
  let wrapped: Uint8Array;
  try {
    wrapped = fromBase64Url(sealed.header.key);
  } catch {
    throw new Error(DAMAGED_KEY);
  }
  for (const key of keys) {
    let raw: Uint8Array;
    try {
      raw = await decryptBytes(key, wrapped, KEY);
    } catch {
      continue;
    }
    const own = await crypto.subtle.importKey('raw', raw as BufferSource, { name: 'AES-GCM' }, false, ['decrypt']);
    raw.fill(0);
    try {
      return await decryptBytes(own, sealed.body, BODY);
    } catch {
      throw new Error('This backup file is damaged: its contents don’t match what was encrypted.');
    }
  }
  return null;
}
