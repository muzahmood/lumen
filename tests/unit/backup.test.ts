// @vitest-environment jsdom
/**
 * Encrypted backups (src/lib/sealedBackup.ts): the .zip is encrypted under a key of its own, which is
 * stored encrypted with the library key, alongside the encryption settings from when it was made. It
 * opens with a key the device holds, or (keysFromSecret in vault.ts) the passphrase or recovery key.
 */
import { describe, expect, it } from 'vitest';
import {
  encryptText,
  formatRecoveryKey,
  newMasterKey,
  passphraseKey,
  randomBytes,
  recoveryWrappingKey,
  toBase64Url,
  wrapKey,
} from '../../src/lib/crypto';
import { openSealedBackup, readSealedBackup, sealBackup } from '../../src/lib/sealedBackup';
import type { KeyringData } from '../../src/lib/types';

const ZIP_TEXT = 'PK\u0003\u0004 pretend this is a zip of every note';
const zip = new TextEncoder().encode(ZIP_TEXT);
/** Decrypted bytes as text (typed arrays from Web Crypto and from jsdom don't compare as equal). */
const text = (bytes: Uint8Array | null) => (bytes ? new TextDecoder().decode(bytes) : null);

// The vault reads the colour scheme when it loads (through settings); jsdom has no matchMedia.
window.matchMedia ??= ((query: string) => ({
  matches: false,
  media: query,
  addEventListener() {},
  removeEventListener() {},
})) as unknown as typeof window.matchMedia;

/** Encryption settings as Lumen makes them, with a quick key derivation for tests. */
async function keyring(passphrase: string) {
  const master = await newMasterKey();
  const salt = randomBytes(16);
  const recoveryBytes = randomBytes(32);
  const data: KeyringData = {
    v: 1,
    kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations: 1000, salt: toBase64Url(salt) },
    pass: await wrapKey(master, await passphraseKey(passphrase, salt, 1000), 'lumen/1/keyring/pass'),
    recovery: await wrapKey(master, await recoveryWrappingKey(recoveryBytes), 'lumen/1/keyring/recovery'),
    check: await encryptText(master, 'lumen-key-check', 'lumen/1/keyring/check'),
  };
  return { master, data, recoveryKey: formatRecoveryKey(recoveryBytes) };
}

const bytesOf = async (blob: Blob) => new Uint8Array(await blob.arrayBuffer());

describe('encrypted backups', () => {
  it('opens with the library key, and nothing readable is left in the file', async () => {
    const { master, data } = await keyring('pass phrase one');
    const file = await bytesOf(await sealBackup(zip, master, data, 0));
    expect(new TextDecoder().decode(file)).not.toContain('pretend this is a zip');
    const sealed = readSealedBackup(file)!;
    expect(sealed.header).toMatchObject({ format: 'lumen-backup', v: 1, gen: 0 });
    expect(text(await openSealedBackup(sealed, [master]))).toBe(ZIP_TEXT);
  });

  it('won’t open with another key, and says so with null rather than failing', async () => {
    const { master, data } = await keyring('pass phrase one');
    const sealed = readSealedBackup(await bytesOf(await sealBackup(zip, master, data, 0)))!;
    expect(await openSealedBackup(sealed, [await newMasterKey()])).toBeNull();
  });

  it('opens with the passphrase or the recovery key from when it was made', async () => {
    const { vi } = await import('vitest');
    vi.resetModules();
    const { keysFromSecret } = await import('../../src/lib/vault');
    const { master, data, recoveryKey } = await keyring('pass phrase one');
    const sealed = readSealedBackup(await bytesOf(await sealBackup(zip, master, data, 0)))!;
    expect(await keysFromSecret(sealed.header.keyring, 'wrong passphrase')).toBeNull();
    const byPassphrase = await keysFromSecret(sealed.header.keyring, 'pass phrase one');
    expect(text(await openSealedBackup(sealed, byPassphrase!))).toBe(ZIP_TEXT);
    const byRecovery = await keysFromSecret(sealed.header.keyring, recoveryKey.toLowerCase());
    expect(text(await openSealedBackup(sealed, byRecovery!))).toBe(ZIP_TEXT);
  });

  it('refuses a file whose contents were changed', async () => {
    const { master, data } = await keyring('pass phrase one');
    const file = await bytesOf(await sealBackup(zip, master, data, 0));
    file[file.length - 5] ^= 1;
    await expect(openSealedBackup(readSealedBackup(file)!, [master])).rejects.toThrow(/damaged/);
  });

  it('tells a plain .zip from an encrypted backup', () => {
    expect(readSealedBackup(zip)).toBeNull();
    expect(() => readSealedBackup(new TextEncoder().encode('LUMENBK1\u0000\u0000\u0010\u0000{'))).toThrow(/incomplete|damaged/);
  });
});
