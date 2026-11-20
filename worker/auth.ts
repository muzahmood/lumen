/**
 * Cloudflare Access JWT verification.
 *
 * Every request that reaches this Worker through Cloudflare Access carries a
 * signed token (the Cf-Access-Jwt-Assertion header and the CF_Authorization
 * cookie). The Worker checks that token itself on every request, so nothing is
 * served on a hostname Access doesn't cover, even by mistake. (Cloudflare's
 * ctx.access isn't available to Workers that serve static assets, so it can't
 * be relied on here.)
 */

interface AccessJwk {
  kid: string;
  kty: string;
  alg?: string;
  n: string;
  e: string;
}

export interface AccessPayload {
  aud?: string | string[];
  email?: string;
  exp?: number;
  nbf?: number;
  iss?: string;
  sub?: string;
  common_name?: string;
}

const KEY_TTL_MS = 60 * 60 * 1000;
/** An unknown key id may mean Access rotated its keys, but refetch at most this often. */
const FORCED_REFRESH_GAP_MS = 60 * 1000;
const TEAM_RE = /^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/;
const AUD_RE = /^[a-f0-9]{32,128}$/;

let keyCache: { domain: string; fetchedAt: number; keys: Map<string, CryptoKey> } | null = null;
let lastForcedRefresh = 0;

/** Returns the team domain as https://<team>.cloudflareaccess.com, or null if it isn't one. */
export function normalizeTeamDomain(value: string | undefined | null): string | null {
  if (!value) return null;
  let v = value.trim().replace(/\/+$/, '').toLowerCase();
  if (!v) return null;
  if (!/^https?:\/\//.test(v)) v = `https://${v}`;
  return TEAM_RE.test(v) ? v : null;
}

/** Splits a comma- or space-separated setting into trimmed, non-empty values. */
export function parseList(value: string | undefined | null): string[] {
  return (value ?? '')
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function base64UrlToBytes(input: string): Uint8Array {
  let s = input.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function decodeJson<T>(segment: string): T {
  return JSON.parse(new TextDecoder().decode(base64UrlToBytes(segment))) as T;
}

/**
 * Keys from a refresh that's due go on being used this long when the refresh fails (Access's key
 * endpoint down, a network blip), rather than every request being refused until it's back. Access
 * rotates its keys every few weeks and keeps the old ones published meanwhile, so a day is safe.
 */
const STALE_KEYS_OK_MS = 24 * 60 * 60 * 1000;
/** After a refresh fails, the next one waits this long: not every request fetches (and fails) again. */
const RETRY_AFTER_FAILURE_MS = 30 * 1000;
let lastFailure = 0;

async function fetchKeys(domain: string): Promise<Map<string, CryptoKey>> {
  const res = await fetch(`${domain}/cdn-cgi/access/certs`);
  if (!res.ok) throw new Error(`Could not fetch Access certificates (${res.status})`);
  const body = (await res.json()) as { keys?: AccessJwk[] };
  const keys = new Map<string, CryptoKey>();
  for (const jwk of body.keys ?? []) {
    if (jwk.kty !== 'RSA' || !jwk.kid) continue;
    const key = await crypto.subtle.importKey(
      'jwk',
      { kty: 'RSA', n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['verify'],
    );
    keys.set(jwk.kid, key);
  }
  return keys;
}

async function loadKeys(domain: string, force: boolean): Promise<Map<string, CryptoKey>> {
  const cached = keyCache && keyCache.domain === domain ? keyCache : null;
  const age = cached ? Date.now() - cached.fetchedAt : Infinity;
  if (cached && age < KEY_TTL_MS && !force) return cached.keys;
  // Due a refresh, but the last one just failed: the keys held still do, for now.
  const fallback = cached && age < STALE_KEYS_OK_MS && !force ? cached.keys : null;
  if (fallback && Date.now() - lastFailure < RETRY_AFTER_FAILURE_MS) return fallback;
  try {
    const keys = await fetchKeys(domain);
    keyCache = { domain, fetchedAt: Date.now(), keys };
    return keys;
  } catch (err) {
    lastFailure = Date.now();
    if (!fallback) throw err;
    console.warn('Access signing keys could not be refreshed; using the ones held', err);
    return fallback;
  }
}

/**
 * Verifies an Access token: RS256 signature from the team's published keys, an
 * issuer equal to the team domain, an unexpired exp, and an aud matching one of
 * the configured Access applications. Throws on any failure.
 */
export async function verifyAccessJwt(token: string, teamDomain: string, audiences: string[]): Promise<AccessPayload> {
  const domain = normalizeTeamDomain(teamDomain);
  if (!domain) throw new Error('Invalid team domain');
  if (!audiences.length) throw new Error('No audience configured');
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('Malformed token');
  const [headerSeg, payloadSeg, sigSeg] = parts;
  const header = decodeJson<{ alg?: string; kid?: string }>(headerSeg);
  if (header.alg !== 'RS256' || typeof header.kid !== 'string' || !header.kid) throw new Error('Unsupported token');

  let keys = await loadKeys(domain, false);
  let key = keys.get(header.kid);
  if (!key && Date.now() - lastForcedRefresh > FORCED_REFRESH_GAP_MS) {
    lastForcedRefresh = Date.now();
    keys = await loadKeys(domain, true);
    key = keys.get(header.kid);
  }
  if (!key) throw new Error('Unknown signing key');

  const valid = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    key,
    base64UrlToBytes(sigSeg),
    new TextEncoder().encode(`${headerSeg}.${payloadSeg}`),
  );
  if (!valid) throw new Error('Bad signature');

  const payload = decodeJson<AccessPayload>(payloadSeg);
  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== 'number' || now > payload.exp + 30) throw new Error('Token expired');
  if (typeof payload.nbf === 'number' && now + 30 < payload.nbf) throw new Error('Token not yet valid');
  if (typeof payload.iss !== 'string' || normalizeTeamDomain(payload.iss) !== domain) throw new Error('Issuer mismatch');
  const tokenAuds = Array.isArray(payload.aud) ? payload.aud : payload.aud ? [payload.aud] : [];
  if (!tokenAuds.some((a) => audiences.includes(a))) throw new Error('Audience mismatch');
  return payload;
}

/** The Access token from the request: the header Access adds, else the app cookie. */
export function readAccessToken(req: Request): string | null {
  const header = req.headers.get('cf-access-jwt-assertion');
  if (header) return header.trim();
  const cookie = req.headers.get('cookie') ?? '';
  const match = /(?:^|;\s*)CF_Authorization=([^;]+)/.exec(cookie);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}

/** Plain addresses only (no spaces, quotes or angle brackets), so nothing odd ends up on the setup page. */
const EMAIL_RE = /^[^\s@<>"'&;,]{1,64}@[a-z0-9.-]{1,190}\.[a-z]{2,63}$/i;

/** True for something shaped like an Access application's Audience (AUD) tag. */
export const isAudTag = (value: string) => AUD_RE.test(value);
/** True for a plain email address (see EMAIL_RE). */
export const isPlainEmail = (value: string) => EMAIL_RE.test(value);

export interface SetupHint {
  team: string | null;
  aud: string[];
  /** The signed-in account, suggested for ACCESS_ALLOWED_EMAILS. */
  email: string | null;
}

/**
 * Reads (without trusting) the team domain, AUD and email from a token, so the
 * setup page can show the owner exactly which values to set. Values are
 * format-checked so nothing odd ends up on the page. The page goes only to
 * whoever sent the token, so nothing is shown that they didn't send.
 */
export function unverifiedSetupHint(token: string | null): SetupHint {
  if (!token) return { team: null, aud: [], email: null };
  try {
    const payload = decodeJson<AccessPayload>(token.split('.')[1] ?? '');
    const team = normalizeTeamDomain(payload.iss);
    const aud = (Array.isArray(payload.aud) ? payload.aud : payload.aud ? [payload.aud] : []).filter(
      (a): a is string => typeof a === 'string' && AUD_RE.test(a),
    );
    const email = typeof payload.email === 'string' && EMAIL_RE.test(payload.email) ? payload.email : null;
    return { team, aud, email };
  } catch {
    return { team: null, aud: [], email: null };
  }
}
