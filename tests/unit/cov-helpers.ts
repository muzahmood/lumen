/**
 * Helpers for the cov-*.test.ts files: a stand-in server that keeps notes the way the Worker does and
 * lets each test add or replace routes, encrypted rows made with the app's own contexts, and loading
 * the app's modules afresh for each test.
 */
import { vi } from 'vitest';
import { encryptText } from '../../src/lib/crypto';

export const NOW = 1_700_000_000_000;

export const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

/** Lets real async work (WebCrypto, IndexedDB, reading a response) finish: fake timers don't cover it. */
export async function settle(rounds = 40) {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setImmediate(r));
}

export function polyfillMatchMedia() {
  if (typeof window === 'undefined') return;
  window.matchMedia ??= ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
}

/* ------------------------------------------------------------ rows --- */

export interface Row {
  id: string;
  folder_id: string | null;
  title: string;
  excerpt: string;
  info: Record<string, unknown>;
  tags: string[];
  pinned: boolean;
  version: number;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
  content: string;
  enc?: boolean;
  sealed?: Record<string, string>;
  kgen?: number;
  links?: unknown;
}

export const at = (id: string, field: string) => `lumen/1/note/${id}/${field}`;

export function plainRow(id: string, fields: Partial<Row> = {}): Row {
  return {
    id,
    folder_id: null,
    title: `Note ${id}`,
    excerpt: '',
    info: {},
    tags: [],
    pinned: false,
    version: 1,
    created_at: NOW,
    updated_at: NOW,
    deleted_at: null,
    content: '',
    enc: false,
    ...fields,
  };
}

/**
 * An encrypted note as the server stores it. `preview` is what goes in its sealed preview (the
 * default lists no links; `null` leaves the links out, as previews made by older versions did).
 */
export async function sealedRow(
  key: CryptoKey,
  id: string,
  opts: { title?: string; content?: string; tags?: string[]; links?: { n: string[]; w: string[] } | null; pv?: number } & Partial<Row> = {},
): Promise<Row> {
  const { title = `Note ${id}`, content = '', tags = [], links = { n: [], w: [] }, pv = 6, ...fields } = opts;
  const preview: Record<string, unknown> = { v: pv, e: content.slice(0, 60), i: {} };
  if (links) preview.l = links;
  return {
    ...plainRow(id, fields),
    title: '',
    tags: [],
    enc: true,
    kgen: fields.kgen ?? 0,
    content: await encryptText(key, content, at(id, 'content')),
    sealed: {
      t: await encryptText(key, title, at(id, 'title')),
      g: await encryptText(key, JSON.stringify(tags), at(id, 'tags')),
      p: await encryptText(key, JSON.stringify(preview), at(id, 'preview')),
    },
  };
}

export const metaOf = ({ content: _c, ...meta }: Row) => meta;

/* ---------------------------------------------------------- server --- */

export interface Req {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: Record<string, string>;
  body: any;
  rawBody: unknown;
  keepalive?: boolean;
  signal?: AbortSignal | null;
}

type Handler = (req: Req) => Response | undefined | Promise<Response | undefined>;

/**
 * A stand-in server, installed as fetch: notes in `rows` (list, get, batch, create, patch, trash,
 * restore, delete), anything else from `on(...)`, which tests add (checked first, newest first).
 */
export function standInServer(opts: { encryption?: boolean } = {}) {
  const rows = new Map<string, Row>();
  const folders: Array<Record<string, unknown>> = [];
  const log: Req[] = [];
  const handlers: Array<{ method: string; path: string | RegExp; fn: Handler }> = [];
  let created = 0;
  const state = { encryption: opts.encryption ?? false };

  const bootstrap = () =>
    json(200, {
      me: {},
      notes: [...rows.values()].map(metaOf),
      folders,
      encryption: state.encryption
        ? { on: true, gen: 0, pending: { notes: 0, versions: 0, folders: 0 }, rekey: { notes: 0, versions: 0, folders: 0 }, attachments: { files: 0, drawings: 0 } }
        : { on: false, pending: null },
      serverTime: NOW,
    });

  function notes(req: Req): Response {
    const b = req.body ?? {};
    const one = /^\/api\/notes\/([^/]+)$/.exec(req.path);
    const action = /^\/api\/notes\/([^/]+)\/(trash|restore)$/.exec(req.path);
    if (req.method === 'GET' && req.path === '/api/bootstrap') return bootstrap();
    if (req.method === 'POST' && req.path === '/api/notes/batch') {
      return json(200, { notes: (b.ids as string[]).filter((id) => rows.has(id)).map((id) => rows.get(id)!) });
    }
    if (req.method === 'POST' && req.path === '/api/notes') {
      const id = (b.id as string) ?? `srv${++created}`;
      const row = plainRow(id, {
        folder_id: b.folder_id ?? null,
        title: b.title ?? '',
        tags: b.tags ?? [],
        pinned: !!b.pinned,
        content: b.content ?? '',
        created_at: Date.now(),
        updated_at: Date.now(),
        ...(b.enc ? { enc: true, sealed: b.sealed, kgen: b.kgen ?? 0, title: '', tags: [] } : {}),
      });
      rows.set(id, row);
      return json(201, metaOf(row));
    }
    if (action && req.method === 'POST') {
      const row = rows.get(action[1]);
      if (!row) return json(404, { error: 'not_found', message: 'Note not found.' });
      row.deleted_at = action[2] === 'trash' ? Date.now() : null;
      return json(200, metaOf(row));
    }
    if (one && req.method === 'GET') {
      const row = rows.get(one[1]);
      return row ? json(200, row) : json(404, { error: 'not_found', message: 'Note not found.' });
    }
    if (one && req.method === 'DELETE') {
      return json(200, { ok: true, deleted: rows.delete(one[1]) });
    }
    if (one && req.method === 'PATCH') {
      const row = rows.get(one[1]);
      if (!row) return json(404, { error: 'not_found', message: 'Note not found.' });
      const textChanged =
        (typeof b.content === 'string' && b.content !== row.content) ||
        (typeof b.title === 'string' && b.title !== row.title) ||
        (b.sealed?.t !== undefined && b.sealed.t !== row.sealed?.t);
      if (textChanged && typeof b.baseVersion === 'number' && b.baseVersion !== row.version && b.force !== true) {
        return json(409, { error: 'conflict', message: 'Changed on another device.', note: { ...row } });
      }
      if (typeof b.content === 'string') row.content = b.content;
      if (typeof b.title === 'string') row.title = b.title;
      if (b.tags) row.tags = b.tags;
      if ('folder_id' in b) row.folder_id = b.folder_id;
      if ('pinned' in b) row.pinned = b.pinned;
      if (b.sealed) row.sealed = { ...row.sealed, ...b.sealed };
      if (textChanged) {
        row.version++;
        row.updated_at = Date.now();
      }
      return json(200, metaOf(row));
    }
    return json(404, { error: 'no_route', message: 'No such route.' });
  }

  const fetchFn = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input instanceof Request ? input.url : input), 'http://localhost');
    let body: unknown;
    if (typeof init.body === 'string') {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    const req: Req = {
      method: init.method ?? 'GET',
      path: url.pathname,
      query: url.searchParams,
      headers: (init.headers ?? {}) as Record<string, string>,
      body,
      rawBody: init.body,
      keepalive: init.keepalive,
      signal: init.signal,
    };
    log.push(req);
    for (const h of handlers) {
      if (h.method !== '*' && h.method !== req.method) continue;
      if (typeof h.path === 'string' ? h.path !== req.path : !h.path.test(req.path)) continue;
      const res = await h.fn(req);
      if (res) return res;
    }
    return notes(req);
  });
  vi.stubGlobal('fetch', fetchFn);

  return {
    rows,
    folders,
    log,
    state,
    fetch: fetchFn,
    /** Answers `method path` (a string or a pattern; method '*' for any) before the built-in routes. */
    on(method: string, path: string | RegExp, fn: Handler) {
      handlers.unshift({ method, path, fn });
    },
    requests: (method: string, path: string | RegExp) =>
      log.filter((r) => r.method === method && (typeof path === 'string' ? r.path === path : path.test(r.path))),
  };
}

export type StandIn = ReturnType<typeof standInServer>;
