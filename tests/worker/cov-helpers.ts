/**
 * Helpers for the cov-*.test.ts files: an R2 bucket kept in memory (the test config binds none), and a
 * database that answers chosen queries differently, to play out races and failures the real one
 * can't be made to produce on demand.
 */
import { env } from 'cloudflare:workers';
import { withEnv } from './api-helpers';
import { LOCAL } from './helpers';

/** Just enough of R2Bucket for worker/storage.ts and the backups, keeping objects in memory. */
export class MemoryR2 {
  objects = new Map<string, { bytes: Uint8Array; type?: string; meta?: Record<string, string>; uploaded: Date }>();
  failDelete = false;
  deleted: string[] = [];

  async put(
    key: string,
    body: ReadableStream | ArrayBuffer | string,
    opts?: { httpMetadata?: { contentType?: string }; customMetadata?: Record<string, string> },
  ) {
    const bytes = new Uint8Array(await new Response(body as BodyInit).arrayBuffer());
    this.objects.set(key, { bytes, type: opts?.httpMetadata?.contentType, meta: opts?.customMetadata, uploaded: new Date() });
    return {};
  }

  async list(opts: { prefix?: string } = {}) {
    const objects = [...this.objects]
      .filter(([key]) => key.startsWith(opts.prefix ?? ''))
      .map(([key, o]) => ({ key, size: o.bytes.length, uploaded: o.uploaded, customMetadata: o.meta ?? {} }));
    return { objects, truncated: false };
  }

  /** The ranges asked for, in order. */
  ranges: Array<{ offset: number; length: number }> = [];

  async get(key: string, opts?: { range?: { offset: number; length: number } }) {
    const o = this.objects.get(key);
    if (!o) return null;
    if (opts?.range) this.ranges.push(opts.range);
    const bytes = opts?.range ? o.bytes.slice(opts.range.offset, opts.range.offset + opts.range.length) : o.bytes;
    return { body: new Response(bytes as BodyInit).body, size: o.bytes.length };
  }

  async delete(keys: string | string[]) {
    if (this.failDelete) throw new Error('R2 is unavailable');
    for (const key of Array.isArray(keys) ? keys : [keys]) {
      this.deleted.push(key);
      this.objects.delete(key);
    }
  }

  text(key: string) {
    const o = this.objects.get(key);
    return o ? new TextDecoder().decode(o.bytes) : null;
  }
}

export const asBucket = (r2: MemoryR2) => r2 as unknown as R2Bucket;

/**
 * The real database, except that a statement whose SQL passes `match` gets `answer` in place of its
 * result (`first()`, `all()` or `run()`): a value, or an Error to throw. `times` limits how often.
 */
export function divertedDb(match: (sql: string) => boolean, answer: unknown, times = Infinity): D1Database {
  let left = times;
  const real = env.DB;
  const diverted = (sql: string) => {
    const reply = async () => {
      if (answer instanceof Error) throw answer;
      return answer;
    };
    const stmt = { bind: () => stmt, first: reply, all: reply, run: reply, raw: reply };
    return stmt;
  };
  return new Proxy(real, {
    get(target, prop) {
      if (prop === 'prepare') {
        return (sql: string) => {
          if (left > 0 && match(sql)) {
            left--;
            return diverted(sql);
          }
          return target.prepare(sql);
        };
      }
      const value = Reflect.get(target, prop);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as D1Database;
}

/** Calls /api<path> with changed bindings, the way the app does (client header, JSON or raw body). */
export function callWith(overrides: Record<string, unknown>, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const h: Record<string, string> = { 'x-kb-client': '1', ...headers };
  let payload: BodyInit | undefined;
  if (body instanceof Uint8Array || typeof body === 'string') {
    payload = body as BodyInit;
    // A Request made here (unlike one through the Worker's own fetch) doesn't get a length by itself.
    h['content-length'] ??= String(typeof body === 'string' ? new TextEncoder().encode(body).length : body.length);
  } else if (body !== undefined) {
    payload = JSON.stringify(body);
    h['content-type'] ??= 'application/json';
  }
  return withEnv(overrides, `${LOCAL}/api${path}`, { method, headers: h, body: payload });
}
