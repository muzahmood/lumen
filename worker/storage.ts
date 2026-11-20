import type { Env } from './env';

/**
 * Blob storage for uploads and drawings.
 * - R2 when FILES_BUCKET is bound (10 GB free).
 * - Workers KV otherwise (1 GB free, no payment method needed).
 *
 * Keys are never overwritten: every drawing save writes a new revision key.
 * That sidesteps KV's edge caching, which can serve a stale value for up to
 * a minute after an overwrite.
 */
export type StorageKind = 'r2' | 'kv';

export const KV_MAX_BYTES = 25 * 1024 * 1024;
export const R2_MAX_BYTES = 95 * 1024 * 1024;

export function activeStorage(env: Env): StorageKind | null {
  if (env.FILES_BUCKET) return 'r2';
  if (env.FILES_KV) return 'kv';
  return null;
}

export function maxUploadBytes(env: Env): number {
  const kind = activeStorage(env);
  return kind === 'r2' ? R2_MAX_BYTES : KV_MAX_BYTES;
}

export async function putBlob(
  env: Env,
  kind: StorageKind,
  key: string,
  body: ReadableStream | ArrayBuffer | string,
  contentType: string,
): Promise<void> {
  if (kind === 'r2') {
    if (!env.FILES_BUCKET) throw new Error('R2 bucket binding FILES_BUCKET is missing');
    await env.FILES_BUCKET.put(key, body, { httpMetadata: { contentType } });
    return;
  }
  if (!env.FILES_KV) throw new Error('KV binding FILES_KV is missing');
  await env.FILES_KV.put(key, body);
}

export async function getBlob(env: Env, kind: StorageKind, key: string): Promise<ReadableStream | null> {
  if (kind === 'r2') {
    const obj = await env.FILES_BUCKET?.get(key);
    return obj ? obj.body : null;
  }
  if (!env.FILES_KV) return null;
  return env.FILES_KV.get(key, 'stream');
}

/** Bytes `start` to `end` (inclusive) of a blob: what a video or audio player asks for. */
export async function getBlobRange(env: Env, kind: StorageKind, key: string, start: number, end: number): Promise<ReadableStream | null> {
  if (kind === 'r2') {
    const obj = await env.FILES_BUCKET?.get(key, { range: { offset: start, length: end - start + 1 } });
    return obj ? obj.body : null;
  }
  // KV has no ranges: values are at most 25 MB, so the part is cut from the whole.
  const all = await env.FILES_KV?.get(key, 'arrayBuffer');
  return all ? new Response(all.slice(start, end + 1)).body : null;
}

/** False when the delete failed (it's then tried again later: see blob_gc in index.ts). A key already gone counts as deleted. */
export async function deleteBlob(env: Env, kind: StorageKind, key: string): Promise<boolean> {
  try {
    if (kind === 'r2') {
      if (!env.FILES_BUCKET) return false;
      await env.FILES_BUCKET.delete(key);
    } else {
      if (!env.FILES_KV) return false;
      await env.FILES_KV.delete(key);
    }
    return true;
  } catch (err) {
    console.warn('deleteBlob failed', key, err);
    return false;
  }
}

/** Where a file's bytes are: its own key once encrypted (`blob`), else the original `files/<id>`. */
export const fileKey = (id: string, blob?: string | null) => (blob ? blob : `files/${id}`);
/** A fresh key for an encrypted file's bytes. */
export const sealedFileKey = (id: string, suffix: string) => `files/${id}.e${suffix}`;
/**
 * An unencrypted upload's own key: two uploads of one file at once (a restore on two devices) each
 * write their own, so the one that loses can delete its copy without touching the other's.
 */
export const plainFileKey = (id: string, suffix: string) => `files/${id}.p${suffix}`;
export const drawingKey = (id: string, rev: string, part: 'scene' | 'svg') =>
  `drawings/${id}/${rev}.${part === 'scene' ? 'excalidraw' : 'svg'}`;
