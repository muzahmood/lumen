/** End-to-end encryption primitives (src/lib/crypto.ts), on Node's Web Crypto. */
import { describe, expect, it } from 'vitest';
import {
  decryptText,
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
} from '../../src/lib/crypto';
import { isCipher } from '../../worker/util';

describe('text encryption', () => {
  it('round-trips, with a fresh IV every time, in the format the Worker accepts', async () => {
    const key = await newMasterKey();
    const a = await encryptText(key, 'héllo 🌍', 'lumen/1/note/abc/content');
    const b = await encryptText(key, 'héllo 🌍', 'lumen/1/note/abc/content');
    expect(a).not.toBe(b);
    expect(isCiphertext(a)).toBe(true);
    expect(isCipher(a)).toBe(true);
    expect(await decryptText(key, a, 'lumen/1/note/abc/content')).toBe('héllo 🌍');
    // An empty body is exactly 41 characters (the Worker relies on this to skip empty snapshots).
    expect(await encryptText(key, '', 'ctx')).toHaveLength(41);
  });

  it('binds ciphertext to its note and field', async () => {
    const key = await newMasterKey();
    const c = await encryptText(key, 'secret', 'lumen/1/note/abc/content');
    await expect(decryptText(key, c, 'lumen/1/note/xyz/content')).rejects.toThrow();
    await expect(decryptText(key, c, 'lumen/1/note/abc/title')).rejects.toThrow();
  });

  it('refuses tampered ciphertext and the wrong key', async () => {
    const key = await newMasterKey();
    const c = await encryptText(key, 'secret', 'ctx');
    const bytes = fromBase64Url(c.slice(3));
    bytes[bytes.length - 1] ^= 1;
    await expect(decryptText(key, `e1:${toBase64Url(bytes)}`, 'ctx')).rejects.toThrow();
    await expect(decryptText(await newMasterKey(), c, 'ctx')).rejects.toThrow();
  });
});

describe('keys', () => {
  it('wraps the master key under a passphrase and unwraps it as non-extractable', async () => {
    const master = await newMasterKey();
    const salt = randomBytes(16);
    // Few iterations to keep the test fast; the app uses PBKDF2_ITERATIONS.
    const wrapping = await passphraseKey('correct horse battery staple', salt, 1000);
    const wrapped = await wrapKey(master, wrapping, 'pass');
    const back = await unwrapKey(wrapped, await passphraseKey('correct horse battery staple', salt, 1000), 'pass');
    expect(back.extractable).toBe(false);
    await expect(crypto.subtle.exportKey('raw', back)).rejects.toThrow();
    const c = await encryptText(master, 'x', 'ctx');
    expect(await decryptText(back, c, 'ctx')).toBe('x');
    await expect(unwrapKey(wrapped, await passphraseKey('wrong passphrase', salt, 1000), 'pass')).rejects.toThrow();
    await expect(unwrapKey(wrapped, wrapping, 'recovery')).rejects.toThrow();
  });

  it('formats and parses recovery keys, forgiving case, spaces and look-alike letters', async () => {
    for (let i = 0; i < 200; i++) {
      const bytes = randomBytes(32);
      const text = formatRecoveryKey(bytes);
      expect(parseRecoveryKey(text)).toEqual(bytes);
      expect(parseRecoveryKey(` ${text.toLowerCase().replace(/-/g, ' ')} `)).toEqual(bytes);
    }
    expect(parseRecoveryKey('not a key')).toBeNull();
    const wrapping = await recoveryWrappingKey(randomBytes(32));
    expect(wrapping.extractable).toBe(false);
  });
});
