/**
 * How strong a new encryption passphrase is, and a strong one to suggest.
 *
 * The passphrase is what an attacker has to guess: the keyring (the library key, wrapped by a key
 * derived from it) is on the server, in D1 Time Travel restore points, in backups and in each device's
 * browser storage, so anyone with a copy can try passphrases offline, as fast as their hardware allows.
 * PBKDF2-SHA256 at 600,000 rounds lets one high-end graphics card try about 15,000 a second.
 *
 * The estimate is zxcvbn's (Dropbox's estimator, as zxcvbn-ts): how many guesses an attacker trying
 * common passwords, words, names, dates and patterns first would need. Loaded only where a passphrase is
 * chosen. A suggestion is six words from the EFF's diceware list (7,776 words, chosen by the browser's
 * cryptographic random numbers): about 77 bits, centuries of guessing on any hardware.
 */
import type { ZxcvbnFactory } from '@zxcvbn-ts/core';

/** Guesses a second one high-end graphics card makes against PBKDF2-SHA256 at 600,000 rounds. */
export const GUESSES_PER_SECOND = 15_000;

/** The fewest guesses (as a power of ten) a passphrase must need: about two years for one such card. */
export const MIN_GUESSES_LOG10 = 12;

/** Above this (about 200 years for one card) a passphrase is strong. */
const STRONG_GUESSES_LOG10 = 14;

export interface Strength {
  /** 0 (guessed at once) to 4 (strong), for the meter. */
  level: 0 | 1 | 2 | 3 | 4;
  label: 'Very weak' | 'Weak' | 'Fair' | 'Good' | 'Strong';
  /** Strong enough to use. */
  enough: boolean;
  /** How long one high-end graphics card would take, in words ("3 days", "about 40 years"). */
  time: string;
  /** What makes it weak, if anything stands out ("This is a commonly used password."). */
  warning: string | null;
}

let estimator: Promise<ZxcvbnFactory> | null = null;
let ready: ZxcvbnFactory | null = null;
let words: string[] | null = null;

/** Loads the estimator (once; about 1 MB, so only on the screens that choose a passphrase). */
export function loadEstimator(): Promise<ZxcvbnFactory> {
  estimator ??= (async () => {
    const [{ ZxcvbnFactory }, common, en] = await Promise.all([
      import('@zxcvbn-ts/core'),
      import('@zxcvbn-ts/language-common'),
      import('@zxcvbn-ts/language-en'),
    ]);
    words = common.dictionary['diceware-common'];
    ready = new ZxcvbnFactory({
      dictionary: { ...common.dictionary, ...en.dictionary },
      graphs: common.adjacencyGraphs,
      translations: en.translations,
    });
    return ready;
  })().catch((err) => {
    estimator = null;
    throw err;
  });
  return estimator;
}

/** Words that make a passphrase easy to guess for someone who knows whose it is. */
const OWN_WORDS = ['lumen', 'notes', 'passphrase', 'password', 'encryption', 'recovery'];

function timeFor(guessesLog10: number): string {
  // On average the right one comes halfway through.
  const seconds = 10 ** guessesLog10 / GUESSES_PER_SECOND / 2;
  const units: Array<[number, string]> = [
    [60, 'second'],
    [60, 'minute'],
    [24, 'hour'],
    [365, 'day'],
    [Infinity, 'year'],
  ];
  let value = seconds;
  for (const [size, unit] of units) {
    if (value < size || size === Infinity) {
      if (unit === 'second' && value < 1) return 'under a second';
      if (unit === 'year' && value >= 1000) return 'thousands of years or more';
      const n = Math.max(1, Math.round(value));
      return `${unit === 'year' && n >= 10 ? 'about ' : ''}${n} ${unit}${n === 1 ? '' : 's'}`;
    }
    value /= size;
  }
  return 'thousands of years or more';
}

/** The strength of `passphrase`, or null until the estimator has loaded (see loadEstimator). */
export function strengthOf(passphrase: string, ownWords: string[] = []): Strength | null {
  if (!ready) return null;
  const result = ready.check(passphrase, [...OWN_WORDS, ...ownWords].filter(Boolean));
  const log = result.guessesLog10;
  const level = (log < 6 ? 0 : log < 9 ? 1 : log < MIN_GUESSES_LOG10 ? 2 : log < STRONG_GUESSES_LOG10 ? 3 : 4) as Strength['level'];
  return {
    level,
    label: (['Very weak', 'Weak', 'Fair', 'Good', 'Strong'] as const)[level],
    enough: log >= MIN_GUESSES_LOG10,
    time: timeFor(log),
    warning: result.feedback.warning,
  };
}

/** A cryptographically random index below `n` (rejection sampling: every index equally likely). */
function randomBelow(n: number): number {
  const limit = Math.floor(0x10000 / n) * n;
  const buf = new Uint16Array(1);
  for (;;) {
    crypto.getRandomValues(buf);
    if (buf[0] < limit) return buf[0] % n;
  }
}

/** Six words from the EFF's diceware list, joined by hyphens: about 77 bits. Loads the list if need be. */
export async function suggestPassphrase(count = 6): Promise<string> {
  await loadEstimator();
  const list = words!;
  return Array.from({ length: count }, () => list[randomBelow(list.length)]).join('-');
}
