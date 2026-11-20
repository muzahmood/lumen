/**
 * How strong a new encryption passphrase is, and the strong ones Lumen suggests (src/lib/passphrase.ts):
 * the time to guess it for someone with a copy of the encryption settings (offline, PBKDF2 at 600,000
 * rounds), what counts as enough, and suggestions of six random words from the EFF's diceware list.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { dictionary } from '@zxcvbn-ts/language-common';
import { GUESSES_PER_SECOND, loadEstimator, MIN_GUESSES_LOG10, strengthOf, suggestPassphrase } from '../../src/lib/passphrase';

const DICEWARE = new Set(dictionary['diceware-common']);

afterEach(() => {
  vi.restoreAllMocks();
});

describe('before the estimator has loaded', () => {
  it('says nothing rather than guessing', async () => {
    vi.resetModules();
    const fresh = await import('../../src/lib/passphrase');
    expect(fresh.strengthOf('anything at all')).toBeNull();
  });
});

describe('the strength of a passphrase', () => {
  beforeAll(async () => {
    await loadEstimator();
  });

  it('calls a common password guessed at once, saying why', () => {
    const s = strengthOf('password1234')!;
    expect(s).toMatchObject({ level: 0, label: 'Very weak', enough: false, time: 'under a second' });
    expect(s.warning).toMatch(/common/i);
  });

  it('isn’t fooled by length alone: repeats and keyboard runs stay weak', () => {
    for (const p of ['aaaaaaaaaaaaaaaa', 'qwertyuiopasdfgh', '1234567890123456', 'abcabcabcabcabc']) {
      expect(strengthOf(p)!.enough, p).toBe(false);
    }
  });

  it('counts words about Lumen itself as easy to guess', () => {
    const plain = strengthOf('orchid harbour lumen')!;
    const own = strengthOf('orchid harbour lumen', ['orchid'])!;
    expect(own.level).toBeLessThanOrEqual(plain.level);
    expect(strengthOf('lumen notes passphrase')!.enough).toBe(false);
  });

  it('takes a few unrelated words as enough, and many as strong, with the time in words', () => {
    const fair = strengthOf('correct horse battery')!;
    expect(fair.enough).toBe(true);
    expect(fair.time).toMatch(/^(about )?\d+ (years|days)$/);
    expect(strengthOf('violet harbor tangerine quietly')).toMatchObject({ level: 4, label: 'Strong', time: 'thousands of years or more' });
  });

  it('sets the bar at about two years for one fast graphics card', () => {
    const seconds = 10 ** MIN_GUESSES_LOG10 / GUESSES_PER_SECOND / 2;
    expect(seconds / 86_400 / 365).toBeGreaterThan(1);
    expect(seconds / 86_400 / 365).toBeLessThan(3);
  });
});

describe('a suggested passphrase', () => {
  it('is six words from the EFF’s diceware list, joined by hyphens, and strong', async () => {
    const p = await suggestPassphrase();
    const words = p.split('-');
    expect(words).toHaveLength(6);
    for (const w of words) expect(DICEWARE.has(w), w).toBe(true);
    expect(strengthOf(p)).toMatchObject({ level: 4, enough: true });
  });

  it('comes from the browser’s cryptographic random numbers, never the same twice in practice', async () => {
    const random = vi.spyOn(crypto, 'getRandomValues');
    const seen = new Set<string>();
    for (let i = 0; i < 20; i++) seen.add(await suggestPassphrase());
    expect(seen.size).toBe(20);
    expect(random).toHaveBeenCalled();
  });

  it('draws every word equally likely: a number past the last whole run of 7,776 is drawn again', async () => {
    const values = [65_535, 0, 7_777, 7_775, 1, 2];
    vi.spyOn(crypto, 'getRandomValues').mockImplementation(<T extends ArrayBufferView | null>(buf: T) => {
      (buf as unknown as Uint16Array)[0] = values.shift() ?? 3;
      return buf;
    });
    const list = dictionary['diceware-common'];
    // 65,535 is past 62,208 (8 × 7,776) and is drawn again; the rest map to their words.
    expect(await suggestPassphrase(5)).toBe([list[0], list[1], list[7_775], list[1], list[2]].join('-'));
  });
});
