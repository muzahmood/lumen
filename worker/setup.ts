/**
 * Which Cloudflare Access application this Lumen trusts, and the assisted first-time setup that
 * records it. (The gate that checks every request, and the setup page, are in gate.ts.)
 *
 * Two places can say:
 * - Variables: ACCESS_TEAM_DOMAIN and ACCESS_AUD (and optionally ACCESS_ALLOWED_EMAILS), set in the
 *   dashboard, with `wrangler secret put`, or in wrangler.jsonc. When both required ones are valid they
 *   win, and the database isn't read at all.
 * - Otherwise, what the owner claimed on the setup page. A new Lumen is reachable before Access is in
 *   front of it, and anyone can get a validly signed Access token from a Zero Trust team of their own,
 *   so a sign-in alone proves nothing. The claim also needs SETUP_PASSWORD, a secret only the deployer
 *   knows (asked for by the Deploy to Cloudflare screen, or made by `npm run setup`). The first person to
 *   sign in through Access and type it records their team, the Access application and their own email
 *   in kb_meta, and from then on the setup form is gone. Wrong passwords are limited to a few an hour.
 */
import type { Env } from './env';
import { isAudTag, normalizeTeamDomain, parseList } from './auth';
import { ensureSchema } from './schema';

export interface AccessConfig {
  team: string;
  audiences: string[];
  /** Lowercased. Empty: anyone the Access policy lets in. */
  allowed: string[];
  source: 'vars' | 'setup';
}

interface Claimed {
  team: string;
  aud: string[];
  emails: string[];
  at: number;
}

const CONFIG_KEY = 'access_config';
const FAILURES_KEY = 'setup_failures';
/** A claimed setting is read again this often, so starting setup over takes effect within a minute. */
const CACHE_MS = 60_000;
/** Shorter setup passwords are refused: the form is reachable by anyone until it's used. */
export const MIN_SETUP_PASSWORD = 12;
export const MAX_SETUP_FAILURES = 10;
export const SETUP_FAILURE_WINDOW_MS = 60 * 60 * 1000;

let cache: { at: number; value: Claimed } | null = null;

/** Drops this instance's copy of the claimed setting (after a claim, and in tests). */
export function forgetAccessConfig() {
  cache = null;
}

const lower = (list: string[]) => list.map((e) => e.toLowerCase());

function parseClaimed(raw: string): Claimed | null {
  try {
    const v = JSON.parse(raw) as Partial<Claimed>;
    const team = normalizeTeamDomain(v.team);
    const aud = Array.isArray(v.aud) ? v.aud.filter((a): a is string => typeof a === 'string' && isAudTag(a)) : [];
    const emails = Array.isArray(v.emails) ? lower(v.emails.filter((e): e is string => typeof e === 'string' && e.includes('@'))) : [];
    if (!team || !aud.length) return null;
    return { team, aud, emails, at: typeof v.at === 'number' ? v.at : 0 };
  } catch {
    return null;
  }
}

/** A claimed setting goes on being used this long when reading it again fails (D1 busy, a blip). */
const STALE_OK_MS = 24 * 60 * 60 * 1000;

/**
 * The setup claimed on the setup page, if any. Not finding one is never cached; finding one is, for a
 * minute, and if reading it again then fails, the copy held is used rather than turning everyone away.
 */
async function readClaimed(db: D1Database): Promise<Claimed | null> {
  const age = cache ? Date.now() - cache.at : Infinity;
  if (cache && age < CACHE_MS) return cache.value;
  try {
    await ensureSchema(db);
    const row = await db.prepare(`SELECT value FROM kb_meta WHERE key = ?`).bind(CONFIG_KEY).first<{ value: string }>();
    const value = row ? parseClaimed(row.value) : null;
    cache = value ? { at: Date.now(), value } : null;
    return value;
  } catch (err) {
    if (cache && age < STALE_OK_MS) {
      console.warn('Access settings could not be read again; using the ones held', err);
      return cache.value;
    }
    throw err;
  }
}

/**
 * The Access settings in force, or null while there are none. Throws only if the database can't be
 * read (and only when the variables don't settle it), which the gate turns into "try again".
 */
export async function accessConfig(env: Env): Promise<AccessConfig | null> {
  const allowedVar = lower(parseList(env.ACCESS_ALLOWED_EMAILS));
  const team = normalizeTeamDomain(env.ACCESS_TEAM_DOMAIN);
  const audiences = parseList(env.ACCESS_AUD);
  if (team && audiences.length) return { team, audiences, allowed: allowedVar, source: 'vars' };
  const claimed = await readClaimed(env.DB);
  if (!claimed) return null;
  return { team: claimed.team, audiences: claimed.aud, allowed: allowedVar.length ? allowedVar : claimed.emails, source: 'setup' };
}

/** Records the owner's claim. False if someone else's got there first (only the first one counts). */
export async function saveClaim(db: D1Database, claim: { team: string; aud: string[]; email: string }): Promise<boolean> {
  await ensureSchema(db);
  const value: Claimed = { team: claim.team, aud: claim.aud, emails: [claim.email.toLowerCase()], at: Date.now() };
  const res = await db
    .prepare(`INSERT INTO kb_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING`)
    .bind(CONFIG_KEY, JSON.stringify(value))
    .run();
  forgetAccessConfig();
  if (!res.meta.changes) return false;
  await db.prepare(`DELETE FROM kb_meta WHERE key = ?`).bind(FAILURES_KEY).run();
  return true;
}

/** Wrong setup passwords in the current window (it starts at the first one), or null if none. */
async function readFailures(db: D1Database): Promise<{ count: number; since: number } | null> {
  await ensureSchema(db);
  const row = await db.prepare(`SELECT value FROM kb_meta WHERE key = ?`).bind(FAILURES_KEY).first<{ value: string }>();
  if (!row) return null;
  try {
    const v = JSON.parse(row.value) as { count?: unknown; since?: unknown };
    if (typeof v.count !== 'number' || typeof v.since !== 'number') return null;
    return Date.now() - v.since < SETUP_FAILURE_WINDOW_MS ? { count: v.count, since: v.since } : null;
  } catch {
    return null;
  }
}

export async function setupFailures(db: D1Database): Promise<number> {
  return (await readFailures(db))?.count ?? 0;
}

export async function recordSetupFailure(db: D1Database): Promise<void> {
  const current = await readFailures(db);
  const next = current ? { count: current.count + 1, since: current.since } : { count: 1, since: Date.now() };
  await db
    .prepare(`INSERT INTO kb_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
    .bind(FAILURES_KEY, JSON.stringify(next))
    .run();
}

/** The setup password, if one is set that's long enough to use; why not otherwise. */
export function setupPasswordState(env: Env): 'ok' | 'missing' | 'short' {
  const p = env.SETUP_PASSWORD ?? '';
  if (!p.trim()) return 'missing';
  return p.length < MIN_SETUP_PASSWORD ? 'short' : 'ok';
}

/** Compares in constant time (by their SHA-256 digests, so the lengths don't show either). */
export async function setupPasswordMatches(given: string, expected: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(given)),
    crypto.subtle.digest('SHA-256', enc.encode(expected)),
  ]);
  return crypto.subtle.timingSafeEqual(a, b);
}
