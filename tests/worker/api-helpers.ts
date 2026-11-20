/**
 * Helpers shared by the api-*.test.ts files: encrypted notes and folders, uploads and drawings, replacing
 * the key, calling the Worker with changed bindings, and finding a word anywhere D1 could keep it.
 */
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import worker from '../../worker/index';
import { call, cipher, get, keyringData, post, read, sealedFields, testId, type CallOptions } from './helpers';

export const put = (path: string, body: unknown, opts?: CallOptions) => call('PUT', path, body, opts);

/** A request body that is valid JSON but not an object (`null`, `"text"`, `[1]`, `5`). */
export const rawJson = (method: string, path: string, json: string) =>
  call(method, path, json, { headers: { 'content-type': 'application/json' } });

/** An encrypted note, as the app makes one (its id is chosen here, since its ciphertext is bound to it). */
export async function encNote(fields: Record<string, unknown> = {}) {
  const res = await post('/notes', { id: testId(), enc: true, content: cipher(), sealed: sealedFields(), ...fields });
  if (res.status !== 201) throw new Error(`encNote failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body as { id: string; version: number; [k: string]: any };
}

export async function encFolder(fields: Record<string, unknown> = {}) {
  const res = await post('/folders', { id: testId('f'), enc: true, sealed: cipher(), ...fields });
  if (res.status !== 201) throw new Error(`encFolder failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body as { id: string; parent_id: string | null; [k: string]: any };
}

/** Replaces the encryption key (the keyring moves up one generation); returns the new generation. */
export async function replaceKey(): Promise<number> {
  const current = (await get('/keyring')).body.keyring;
  const gen = (current.data.gen ?? 0) + 1;
  const prev = [{ iv: cipher(4), key: cipher(32) }, ...(current.data.prev ?? [])];
  const res = await post('/keyring', { data: { ...keyringData(), gen, prev }, replaces: current.id });
  if (res.status !== 201) throw new Error(`replaceKey failed: ${res.status} ${JSON.stringify(res.body)}`);
  return gen;
}

export const bytes = (text: string) => new TextEncoder().encode(text);

/** An unencrypted upload. */
export const uploadPlain = (body: Uint8Array, name = 'file.txt', type = 'text/plain', extra: Record<string, string> = {}) =>
  call('POST', '/files', body, { headers: { 'content-type': type, 'x-file-name': encodeURIComponent(name), ...extra } });

/** An encrypted upload, with its wrapped key and the key generation it was encrypted under. */
export const uploadSealed = (id: string, kgen = 0, extra: Record<string, string> = {}, body = bytes('x'.repeat(40))) =>
  call('POST', '/files', body, {
    headers: {
      'content-type': 'application/octet-stream',
      'x-kb-enc': '1',
      'x-file-id': id,
      'x-kb-sealed': cipher(48),
      'x-kb-kgen': String(kgen),
      ...extra,
    },
  });

/** Uploads a drawing's two parts for `rev`, then points the drawing at them. */
export async function saveDrawing(id: string, rev: string, fields: Record<string, unknown> = {}, svg = '<svg/>', scene = '{"elements":[]}') {
  // As the app sends them: ciphertext as octet-stream, readable parts as JSON and SVG.
  const type = (plain: string) => ({ headers: { 'content-type': fields.enc ? 'application/octet-stream' : plain } });
  const a = await call('PUT', `/drawings/${id}/blob/scene?rev=${rev}`, bytes(scene), type('application/json'));
  const b = await call('PUT', `/drawings/${id}/blob/svg?rev=${rev}`, bytes(svg), type('image/svg+xml'));
  if (a.status !== 200 || b.status !== 200) throw new Error(`drawing parts failed: ${a.status} ${b.status}`);
  return call('PUT', `/drawings/${id}`, { rev, size: scene.length + svg.length, ...fields });
}

/** Calls the Worker directly with changed bindings (the test config can't vary per test). */
export async function withEnv(overrides: Record<string, unknown>, url: string, init: RequestInit = {}) {
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(url, init), { ...env, ...overrides } as Cloudflare.Env, ctx);
  await waitOnExecutionContext(ctx);
  return read(res);
}

/** Every text column D1 keeps, by table. */
const TEXT_COLUMNS: Record<string, string[]> = {
  notes: ['title', 'content', 'excerpt', 'info', 'tags', 'sealed'],
  note_versions: ['title', 'content', 'sealed'],
  folders: ['name', 'sealed'],
  files: ['name', 'mime', 'sealed', 'blob'],
  drawings: ['text', 'sealed'],
  kb_meta: ['value'],
};

function holdsBytes(value: unknown, needle: Uint8Array): boolean {
  if (typeof value === 'string') return value.toLowerCase().includes(new TextDecoder().decode(needle));
  if (!(value instanceof ArrayBuffer) && !ArrayBuffer.isView(value)) return false;
  const hay = value instanceof ArrayBuffer ? new Uint8Array(value) : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  outer: for (let i = 0; i + needle.length <= hay.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return true;
  }
  return false;
}

/**
 * Where D1 still holds `word` (lowercase letters only): every text column of every table, the search
 * index (a match, and the raw bytes of its internal tables, which keep words after a plain delete).
 */
export async function whereStored(word: string): Promise<string[]> {
  const found: string[] = [];
  for (const [table, columns] of Object.entries(TEXT_COLUMNS)) {
    for (const column of columns) {
      const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE instr(lower(${column}), ?) > 0`).bind(word).first<{ n: number }>();
      if (row?.n) found.push(`${table}.${column}`);
    }
  }
  const match = await env.DB.prepare('SELECT COUNT(*) AS n FROM notes_fts WHERE notes_fts MATCH ?').bind(`"${word}"`).first<{ n: number }>();
  if (match?.n) found.push('notes_fts');
  const needle = bytes(word);
  const data = await env.DB.prepare('SELECT block FROM notes_fts_data').all<{ block: unknown }>();
  if (data.results.some((r) => holdsBytes(r.block, needle))) found.push('notes_fts_data');
  const idx = await env.DB.prepare('SELECT term FROM notes_fts_idx').all<{ term: unknown }>();
  if (idx.results.some((r) => holdsBytes(r.term, needle))) found.push('notes_fts_idx');
  return found;
}

/** A D1 row as stored. */
export const row = <T = Record<string, unknown>>(sql: string, ...params: unknown[]) => env.DB.prepare(sql).bind(...params).first<T>();
export const count = async (sql: string, ...params: unknown[]) => (await row<{ n: number }>(sql, ...params))?.n ?? 0;
