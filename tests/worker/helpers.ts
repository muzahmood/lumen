/**
 * Helpers for the Worker tests: calling the API the way the app does, signing Cloudflare Access
 * tokens with the test key, and making note-shaped ciphertext (the Worker only checks its shape).
 */
import { env, exports } from 'cloudflare:workers';

/** LOCAL_DEV is on in tests, so requests to localhost skip Access (as with `npm run dev`). */
export const LOCAL = 'http://localhost';
/** Any other hostname goes through the Access check. */
export const PUBLIC = 'https://kb.example.test';
export const TEAM = env.ACCESS_TEAM_DOMAIN!;
export const AUD = env.ACCESS_AUD!;
export const OWNER = 'owner@example.com';

export interface Reply<T = any> {
  status: number;
  headers: Headers;
  body: T;
}

export interface CallOptions {
  headers?: Record<string, string>;
  origin?: string;
  /** Leave out the x-kb-client header the app sends on every write. */
  noClientHeader?: boolean;
}

/** Calls /api<path> and parses the reply (JSON when it says so, text otherwise). */
export async function call<T = any>(method: string, path: string, body?: unknown, opts: CallOptions = {}): Promise<Reply<T>> {
  const headers: Record<string, string> = opts.noClientHeader ? {} : { 'x-kb-client': '1' };
  let payload: BodyInit | undefined;
  if (body !== undefined) {
    if (typeof body === 'string' || body instanceof Uint8Array || body instanceof ArrayBuffer) {
      payload = body as BodyInit;
    } else {
      payload = JSON.stringify(body);
      headers['content-type'] = 'application/json';
    }
  }
  Object.assign(headers, opts.headers);
  const res = await exports.default.fetch(`${opts.origin ?? LOCAL}/api${path}`, { method, headers, body: payload });
  return read<T>(res);
}

export async function read<T = any>(res: Response): Promise<Reply<T>> {
  const type = res.headers.get('content-type') ?? '';
  const body = type.includes('application/json') ? await res.json() : await res.text();
  return { status: res.status, headers: res.headers, body: body as T };
}

export const get = <T = any>(path: string, opts?: CallOptions) => call<T>('GET', path, undefined, opts);
export const post = <T = any>(path: string, body?: unknown, opts?: CallOptions) => call<T>('POST', path, body ?? {}, opts);
export const patch = <T = any>(path: string, body: unknown, opts?: CallOptions) => call<T>('PATCH', path, body, opts);
export const del = <T = any>(path: string, opts?: CallOptions) => call<T>('DELETE', path, undefined, opts);

/** A fetch of any path (not only /api) on the given origin. */
export const fetchPath = (path: string, init: RequestInit = {}, origin = LOCAL) => exports.default.fetch(`${origin}${path}`, init);

/* ------------------------------------------------------------- data --- */

export async function newNote(fields: Record<string, unknown> = {}) {
  const res = await post('/notes', { title: 'Note', content: 'Some text', ...fields });
  if (res.status !== 201) throw new Error(`newNote failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body as { id: string; version: number; [k: string]: any };
}

export async function newFolder(name = 'Folder', fields: Record<string, unknown> = {}) {
  const res = await post('/folders', { name, ...fields });
  if (res.status !== 201) throw new Error(`newFolder failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body as { id: string; parent_id: string | null; [k: string]: any };
}

export const testId = (prefix = 't') => `${prefix}${crypto.randomUUID().replace(/-/g, '').slice(0, 14)}`;

/* ---------------------------------------------------------- crypto --- */

const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** Ciphertext in the app's format ("e1:" + base64url of IV and AES-GCM output) with `bytes` of random payload. */
export function cipher(bytes = 64): string {
  return `e1:${b64url(crypto.getRandomValues(new Uint8Array(12 + 16 + bytes)))}`;
}

export const sealedFields = () => ({ t: cipher(16), g: cipher(8), p: cipher(32) });

/** A keyring the Worker accepts (its contents are opaque to the server). */
export const keyringData = () => ({
  v: 1,
  kdf: { name: 'PBKDF2-SHA256', salt: cipher(16), iterations: 600000 },
  pass: { iv: cipher(4), key: cipher(32) },
  recovery: { iv: cipher(4), key: cipher(32) },
});

export async function turnOnEncryption() {
  const res = await post('/keyring', { data: keyringData(), replaces: null });
  if (res.status !== 201) throw new Error(`keyring failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.keyring as { id: number };
}

/* ---------------------------------------------------------- access --- */

let signingKey: Promise<CryptoKey> | null = null;

function testSigningKey() {
  signingKey ??= crypto.subtle.importKey(
    'jwk',
    JSON.parse(env.TEST_PRIVATE_JWK),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return signingKey;
}

const jsonSeg = (value: unknown) => b64url(new TextEncoder().encode(JSON.stringify(value)));

/** A Cloudflare Access token signed with the test key; claims and header can be overridden. */
export async function accessToken(claims: Record<string, unknown> = {}, header: Record<string, unknown> = {}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const head = jsonSeg({ alg: 'RS256', kid: 'test-key', typ: 'JWT', ...header });
  const body = jsonSeg({ aud: [AUD], iss: TEAM, email: OWNER, sub: 'user-1', iat: now, nbf: now - 5, exp: now + 3600, ...claims });
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', await testSigningKey(), new TextEncoder().encode(`${head}.${body}`));
  return `${head}.${body}.${b64url(new Uint8Array(sig))}`;
}

/**
 * Empties the library (test files share one database; tests that need a fresh one call this).
 * Deleting the notes keeps the search index in step through its triggers.
 */
export async function resetLibrary() {
  await get('/me'); // the first API call sets up the schema
  await env.DB.batch([
    env.DB.prepare('DELETE FROM notes'),
    env.DB.prepare('DELETE FROM note_versions'),
    env.DB.prepare('DELETE FROM folders'),
    env.DB.prepare('DELETE FROM files'),
    env.DB.prepare('DELETE FROM drawings'),
    env.DB.prepare('DELETE FROM blob_gc'),
    env.DB.prepare('DELETE FROM keyring'),
    env.DB.prepare(`INSERT INTO notes_fts(notes_fts) VALUES ('delete-all')`),
    env.DB.prepare(`DELETE FROM kb_meta WHERE key != 'schema_version'`),
  ]);
}
