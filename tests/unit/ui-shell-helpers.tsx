/**
 * Shared set-up for the tests of Lumen's app shell (App, Sidebar, NoteList, Home, CommandPalette,
 * TasksView, JournalNav, Toolbar, ErrorBoundary) rendered in jsdom with React.
 *
 * - `boot()` gives every test fresh app modules (store, saver, library, settings), a stand-in server
 *   behind `fetch` and an empty IndexedDB, and by default an encrypted library unlocked with a real key
 *   (the owner keeps end-to-end encryption on), so search and Tasks run on the device as they do for him.
 * - `seedNote` / `seedFolder` put a note or folder in the note list and on the server (as ciphertext when
 *   encrypted), as loading the app would.
 * - Small DOM helpers find things the way a person (or a screen reader) would: by role and name.
 */
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { vi } from 'vitest';
import { encryptText, newMasterKey } from '../../src/lib/crypto';

export const NOW = new Date(2026, 10, 17, 10, 30).getTime();
export const DAY = 86_400_000;

/* ------------------------------------------------------------ jsdom --- */

export const scrolled: Element[] = [];
const env = { phone: false, dark: false };

/** What jsdom lacks and the components use. `phone` makes the phone-width media queries match. */
/**
 * Work still under way that a test should wait for: requests to the stand-in server and WebCrypto
 * operations (encrypting and decrypting run off the main thread, and take longer on a busy machine).
 */
const busy = {
  count: 0,
  lastChange: 0,
  start() {
    this.count++;
    this.lastChange = performance.now();
  },
  end() {
    this.count--;
    this.lastChange = performance.now();
  },
};

function trackCrypto() {
  const subtle = globalThis.crypto?.subtle as (SubtleCrypto & { __tracked?: boolean }) | undefined;
  if (!subtle || subtle.__tracked) return;
  for (const name of ['encrypt', 'decrypt', 'digest', 'importKey', 'exportKey', 'deriveKey', 'deriveBits', 'wrapKey', 'unwrapKey', 'generateKey', 'sign', 'verify'] as const) {
    const original = (subtle[name] as (...a: unknown[]) => Promise<unknown>).bind(subtle);
    Object.defineProperty(subtle, name, {
      configurable: true,
      value: (...args: unknown[]) => {
        busy.start();
        return original(...args).finally(() => busy.end());
      },
    });
  }
  Object.defineProperty(subtle, '__tracked', { value: true });
}

function installDom(phone: boolean) {
  env.phone = phone;
  trackCrypto();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  window.matchMedia = ((q: string) => {
    const matches =
      (/max-width:\s*7[0-9]{2}px/.test(q) && env.phone) || (/pointer:\s*coarse/.test(q) && env.phone) || (/prefers-color-scheme:\s*dark/.test(q) && env.dark);
    return { matches, media: q, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false };
  }) as unknown as typeof window.matchMedia;
  Element.prototype.scrollIntoView = function (this: Element) {
    scrolled.push(this);
  };
  (globalThis as { CSS?: { escape(s: string): string } }).CSS ??= { escape: (s: string) => s.replace(/[^\w-]/g, (c) => `\\${c}`) };
  if (!('ResizeObserver' in globalThis)) {
    (globalThis as Record<string, unknown>).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }
  Range.prototype.getClientRects ??= () => Object.assign([], { item: () => null }) as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect ??= () => new DOMRect();
}

/* ------------------------------------------------------ stand-in server --- */

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
}
export interface FolderRow {
  id: string;
  parent_id: string | null;
  name: string;
  sort: number;
  created_at: number;
  updated_at: number;
  enc?: boolean;
  sealed?: string;
}
export interface Req {
  method: string;
  path: string;
  query: URLSearchParams;
  body: Record<string, any> | undefined;
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

export const server = {
  rows: new Map<string, Row>(),
  folders: [] as FolderRow[],
  log: [] as Req[],
  /** What the server's full-text index answers (only asked when the library isn't encrypted). */
  searchHits: [] as Array<{ id: string; title: string; folder_id: string | null; updated_at: number; tags: string[]; snippet: string }>,
  encrypted: false,
  lastBackup: null as number | null,
  /** Answers a request before the stand-in does (return undefined to let it through). */
  intercept: null as ((req: Req) => Promise<Response | undefined> | Response | undefined) | null,
  created: 0,
  reset() {
    this.rows.clear();
    this.folders = [];
    this.log = [];
    this.searchHits = [];
    this.encrypted = false;
    this.lastBackup = null;
    this.intercept = null;
    this.created = 0;
  },
  requests(method: string, path?: string | RegExp) {
    return this.log.filter((r) => r.method === method && (path === undefined || (typeof path === 'string' ? r.path === path : path.test(r.path))));
  },
};

const metaOf = ({ content: _c, ...meta }: Row) => meta;
const missing = () => json(404, { error: 'not_found', message: 'Note not found.' });

function serve(req: Req): Response {
  const b = req.body ?? {};
  const one = /^\/api\/notes\/([^/]+)$/.exec(req.path);
  const act = /^\/api\/notes\/([^/]+)\/(trash|restore)$/.exec(req.path);
  const folder = /^\/api\/folders\/([^/]+)$/.exec(req.path);
  if (req.method === 'GET' && req.path === '/api/bootstrap') {
    return json(200, {
      me: { email: 'owner@example.com', verified: true, via: 'access', accessConfigured: true, storage: 'kv', maxUploadBytes: 1e8 },
      notes: [...server.rows.values()].map(metaOf),
      folders: server.folders,
      encryption: server.encrypted
        ? { on: true, pending: { notes: 0, versions: 0, folders: 0 }, attachments: { files: 0, drawings: 0 }, gen: 0, rekey: { notes: 0, versions: 0, folders: 0 } }
        : { on: false, pending: null },
      lastBackup: server.lastBackup,
      settings: null,
      serverTime: Date.now(),
    });
  }
  if (req.method === 'GET' && req.path === '/api/keyring') return json(200, { keyring: null });
  if (req.method === 'PUT' && req.path === '/api/settings') return json(200, { ok: true, at: Date.now() });
  if (req.method === 'GET' && req.path === '/api/search') {
    return json(200, { results: server.searchHits.slice(0, Number(req.query.get('limit') ?? 40)) });
  }
  if (req.method === 'POST' && req.path === '/api/notes/batch') {
    const ids = (b.ids as string[]) ?? [];
    return json(200, { notes: ids.filter((id) => server.rows.has(id)).map((id) => server.rows.get(id)) });
  }
  if (req.method === 'POST' && req.path === '/api/notes') {
    const id = (b.id as string) ?? `srv${++server.created}`;
    const row: Row = {
      id,
      folder_id: b.folder_id ?? null,
      title: b.title ?? '',
      excerpt: '',
      info: {},
      tags: b.tags ?? [],
      pinned: !!b.pinned,
      version: 1,
      created_at: Date.now(),
      updated_at: Date.now(),
      deleted_at: null,
      content: b.content ?? '',
      ...(b.enc ? { enc: true, sealed: b.sealed, kgen: b.kgen } : {}),
    };
    server.rows.set(id, row);
    return json(200, metaOf(row));
  }
  if (req.method === 'POST' && req.path === '/api/trash/empty') {
    const gone = [...server.rows.values()].filter((r) => r.deleted_at);
    gone.forEach((r) => server.rows.delete(r.id));
    return json(200, { ok: true, deleted: gone.length });
  }
  if (act && req.method === 'POST') {
    const row = server.rows.get(act[1]);
    if (!row) return missing();
    row.deleted_at = act[2] === 'trash' ? Date.now() : null;
    return json(200, metaOf(row));
  }
  if (one && req.method === 'GET') {
    const row = server.rows.get(one[1]);
    return row ? json(200, row) : missing();
  }
  if (one && req.method === 'DELETE') {
    const deleted = server.rows.delete(one[1]);
    return json(200, { ok: true, deleted });
  }
  if (one && req.method === 'PATCH') {
    const row = server.rows.get(one[1]);
    if (!row) return missing();
    if (b.folder_id && !server.folders.some((f) => f.id === b.folder_id)) {
      return json(409, { error: 'folder_missing', message: 'That folder no longer exists. It may have been deleted on another device.' });
    }
    const textChanged = typeof b.content === 'string' || typeof b.title === 'string' || !!b.sealed?.t;
    if (typeof b.content === 'string') row.content = b.content;
    if (typeof b.title === 'string') row.title = b.title;
    if (Array.isArray(b.tags)) row.tags = b.tags;
    if ('folder_id' in b) row.folder_id = b.folder_id;
    if ('pinned' in b) row.pinned = !!b.pinned;
    if (b.sealed) row.sealed = { ...row.sealed, ...b.sealed };
    if (textChanged) row.version++;
    row.updated_at = Date.now();
    return json(200, metaOf(row));
  }
  if (req.method === 'GET' && /^\/api\/notes\/[^/]+\/backlinks$/.test(req.path)) return json(200, { backlinks: [] });
  if (req.method === 'POST' && req.path === '/api/folders') {
    const f: FolderRow = {
      id: (b.id as string) ?? `fld${++server.created}`,
      parent_id: b.parent_id ?? null,
      name: b.enc ? '' : (b.name ?? ''),
      sort: 0,
      created_at: Date.now(),
      updated_at: Date.now(),
      ...(b.enc ? { enc: true, sealed: b.sealed } : {}),
    };
    server.folders.push(f);
    return json(200, f);
  }
  if (folder && req.method === 'PATCH') {
    const f = server.folders.find((x) => x.id === folder[1]);
    if (!f) return json(404, { error: 'not_found', message: 'Folder not found.' });
    if ('parent_id' in b) f.parent_id = b.parent_id;
    if (b.enc) Object.assign(f, { enc: true, sealed: b.sealed });
    else if (typeof b.name === 'string') f.name = b.name;
    f.updated_at = Date.now();
    return json(200, f);
  }
  if (folder && req.method === 'DELETE') {
    const gone = new Set([folder[1]]);
    for (let grew = true; grew; ) {
      grew = false;
      for (const f of server.folders) if (f.parent_id && gone.has(f.parent_id) && !gone.has(f.id)) (gone.add(f.id), (grew = true));
    }
    server.folders = server.folders.filter((f) => !gone.has(f.id));
    let trashed = 0;
    for (const r of server.rows.values()) if (r.folder_id && gone.has(r.folder_id)) (r.deleted_at = Date.now(), (r.folder_id = null), trashed++);
    return json(200, { ok: true, trashed });
  }
  return json(404, { error: 'no_route', message: `No such route: ${req.method} ${req.path}` });
}

async function fakeFetch(input: string | URL | Request, init: RequestInit = {}) {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, 'http://localhost');
  const req: Req = {
    method: init.method ?? 'GET',
    path: url.pathname,
    query: url.searchParams,
    body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
  };
  server.log.push(req);
  if (init.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  busy.start();
  try {
    return (server.intercept ? await server.intercept(req) : undefined) ?? serve(req);
  } finally {
    busy.end();
  }
}

/* ------------------------------------------------------- the device --- */

let key: CryptoKey | null = null;
let mods: Awaited<ReturnType<typeof loadModules>> | null = null;
const roots: Root[] = [];

async function loadModules() {
  const api = await import('../../src/lib/api');
  const store = await import('../../src/lib/store');
  const settings = await import('../../src/lib/settings');
  const saver = await import('../../src/lib/saver');
  return { api, store, settings, saver };
}

export type Booted = Awaited<ReturnType<typeof boot>>;

/**
 * A fresh app on a fresh device: modules, storage, server. `encrypted` (the default) unlocks the
 * library with a real key, as on the owner's devices; `phone` makes phone-width media queries match.
 */
export async function boot(opts: { encrypted?: boolean; phone?: boolean; status?: 'loading' | 'ready' } = {}) {
  const encrypted = opts.encrypted ?? true;
  installDom(!!opts.phone);
  vi.stubGlobal('indexedDB', new IDBFactory());
  vi.stubGlobal('BroadcastChannel', undefined);
  vi.stubGlobal('fetch', fakeFetch);
  localStorage.clear();
  sessionStorage.clear();
  window.history.replaceState(null, '', '/');
  document.body.innerHTML = '';
  scrolled.length = 0;
  server.reset();
  server.encrypted = encrypted;
  vi.resetModules();
  mods = await loadModules();
  const { api, store } = mods;
  if (encrypted) {
    key ??= await newMasterKey();
    const e2ee = await import('../../src/lib/e2ee');
    api.setKeyGen(0);
    api.setCodec(e2ee.createCodec(key));
  }
  store.useApp.setState({
    status: opts.status ?? 'ready',
    me: { email: 'owner@example.com', verified: true, via: 'access', accessConfigured: true, storage: 'kv', maxUploadBytes: 1e8 },
    encryption: { on: encrypted, pending: 0, rekey: 0, attachments: 0 },
    lastBackup: Date.now(),
  });
  return { ...mods, encrypted };
}

/** Unmounts everything and puts the globals back. Call in afterEach. */
export async function teardown() {
  for (const r of roots.splice(0)) await act(async () => r.unmount());
  if (mods) {
    mods.saver.discardAll();
    mods.api.setCodec(null);
  }
  mods = null;
  document.body.innerHTML = '';
  vi.useRealTimers();
  vi.unstubAllGlobals();
}

const at = (id: string, f: string) => `lumen/1/note/${id}/${f}`;

export interface NoteInit {
  title?: string;
  content?: string;
  excerpt?: string;
  folder_id?: string | null;
  tags?: string[];
  pinned?: boolean;
  info?: Record<string, unknown>;
  created_at?: number;
  updated_at?: number;
  deleted_at?: number | null;
  version?: number;
}

/** The note list's entry for a note, as the app holds it (decrypted). */
export function metaFor(id: string, init: NoteInit = {}) {
  return {
    id,
    folder_id: init.folder_id ?? null,
    title: init.title ?? `Note ${id}`,
    excerpt: init.excerpt ?? (init.content ?? '').slice(0, 80),
    info: init.info ?? {},
    tags: init.tags ?? [],
    pinned: init.pinned ?? false,
    version: init.version ?? 1,
    created_at: init.created_at ?? init.updated_at ?? NOW,
    updated_at: init.updated_at ?? NOW,
    deleted_at: init.deleted_at ?? null,
  };
}

/** A note on the server (ciphertext when encrypted) and in this device's note list. */
export async function seedNote(id: string, init: NoteInit = {}) {
  if (!mods) throw new Error('boot() first');
  const meta = metaFor(id, init);
  const content = init.content ?? '';
  if (server.encrypted && key) {
    server.rows.set(id, {
      ...meta,
      title: '',
      tags: [],
      excerpt: '',
      info: {},
      content: await encryptText(key, content, at(id, 'content')),
      enc: true,
      kgen: 0,
      sealed: {
        t: await encryptText(key, meta.title, at(id, 'title')),
        g: await encryptText(key, JSON.stringify(meta.tags), at(id, 'tags')),
        p: await encryptText(key, JSON.stringify({ v: 6, e: meta.excerpt, i: meta.info, l: { n: [], w: [] } }), at(id, 'preview')),
      },
    });
  } else {
    server.rows.set(id, { ...meta, content });
  }
  const listed = server.encrypted ? { ...meta, enc: true, pv: 6, links: { n: [], w: [] } } : meta;
  await act(async () => mods!.store.upsertMeta(listed as never));
  return listed;
}

/** Many notes at once (only in the note list, not on the server): for counts and long lists. */
export async function listNotes(metas: ReturnType<typeof metaFor>[]) {
  if (!mods) throw new Error('boot() first');
  await act(async () => mods!.store.useApp.setState((s) => ({ notes: { ...s.notes, ...Object.fromEntries(metas.map((m) => [m.id, m])) } })));
}

/** A folder in the sidebar and on the server (its name as ciphertext when encrypted). */
export async function seedFolder(id: string, name: string, parent_id: string | null = null, sort = 0) {
  if (!mods) throw new Error('boot() first');
  const f: FolderRow = { id, parent_id, name, sort, created_at: NOW, updated_at: NOW };
  server.folders.push(
    server.encrypted && key ? { ...f, name: '', enc: true, sealed: await encryptText(key, name, `lumen/1/folder/${id}/name`) } : { ...f },
  );
  await act(async () => mods!.store.useApp.setState((s) => ({ folders: [...s.folders, f] })));
  return f;
}

/** Changes app state as the app would, inside act. */
export async function setApp(patch: Record<string, unknown> | ((s: any) => Record<string, unknown>)) {
  await act(async () => mods!.store.useApp.setState(patch as never));
}
export async function setSettings(patch: Record<string, unknown>) {
  await act(async () => mods!.settings.useSettings.setState(patch as never));
}

/* ------------------------------------------------------------ render --- */

export async function render(element: ReactElement) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => root.render(element));
  return {
    container,
    rerender: (el: ReactElement) => act(async () => root.render(el)),
    unmount: async () => {
      await act(async () => root.unmount());
      roots.splice(roots.indexOf(root), 1);
    },
  };
}

/**
 * Lets promises, fetches and IndexedDB settle. Rounds of setImmediate rather than setTimeout(0), which
 * takes a whole timer tick (about 15 ms on Windows).
 */
export async function settle(rounds = 20) {
  // At least `rounds` turns, then until no request or encryption is under way and nothing has
  // changed on the page or in the app's state for a moment (or 5 s pass).
  let last = performance.now();
  const bump = () => (last = performance.now());
  const watcher = new MutationObserver(bump);
  watcher.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
  const unsubscribe = mods?.store.useApp.subscribe(bump);
  const deadline = performance.now() + 5000;
  try {
    for (let i = 0; ; i++) {
      await act(async () => new Promise((r) => setImmediate(r)));
      const now = performance.now();
      const quiet = now - Math.max(last, busy.lastChange) >= 6;
      if ((i >= rounds && busy.count === 0 && quiet) || now > deadline) break;
    }
  } finally {
    watcher.disconnect();
    unsubscribe?.();
  }
}

/** Waits for the next animation frame (menus and the palette move focus on one). */
export async function frame() {
  await act(async () => new Promise((r) => requestAnimationFrame(() => r(undefined))));
  await settle(2);
}

/** Real time passing (for debounces), with everything it sets off. */
export async function wait(ms: number) {
  await act(async () => new Promise((r) => setTimeout(r, ms)));
  await settle();
}

/** Waits until `check` stops throwing (or fails with its last error). */
export async function until(check: () => unknown, ms = 2000) {
  // performance.now, since a test may have frozen Date.
  const end = performance.now() + ms;
  for (;;) {
    try {
      return check();
    } catch (err) {
      if (performance.now() > end) throw err;
      await act(async () => new Promise((r) => setTimeout(r, 10)));
    }
  }
}

/* ------------------------------------------------------------ events --- */

type Mods = { ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean; altKey?: boolean };

export async function click(el: Element | null | undefined, mods: Mods & { clientX?: number; clientY?: number; button?: number } = {}) {
  if (!el) throw new Error('Nothing to click');
  await act(async () => {
    el.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true, ...mods }));
    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, ...mods }));
    el.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, cancelable: true, ...mods }));
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ...mods }));
  });
}

/** A right-click (or long press): the context menu event. Returns whether the default was prevented. */
export async function contextMenu(el: Element | null | undefined, at: { clientX?: number; clientY?: number } = {}) {
  if (!el) throw new Error('Nothing to right-click');
  let ev!: MouseEvent;
  await act(async () => {
    ev = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 60, ...at });
    el.dispatchEvent(ev);
  });
  return ev.defaultPrevented;
}

/** A keydown on `el` (the focused element by default). Returns the event, to check defaultPrevented. */
export async function press(key: string, mods: Mods & { code?: string } = {}, el: Element | null = document.activeElement) {
  const target = el ?? document.body;
  let ev!: KeyboardEvent;
  await act(async () => {
    ev = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...mods });
    target.dispatchEvent(ev);
  });
  return ev;
}

/** Types into a React-controlled input or textarea (sets the value as a person's typing would). */
export async function type(el: Element | null | undefined, value: string) {
  if (!el) throw new Error('Nothing to type into');
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

export async function focus(el: Element | null | undefined) {
  if (!el) throw new Error('Nothing to focus');
  await act(async () => (el as HTMLElement).focus());
}

/** A stand-in DataTransfer for drag and drop (jsdom has none). */
export function dataTransfer(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    dropEffect: 'none',
    effectAllowed: 'all',
    get types() {
      return [...data.keys()];
    },
    setData: (t: string, v: string) => void data.set(t, v),
    getData: (t: string) => data.get(t) ?? '',
    clearData: () => data.clear(),
    setDragImage() {},
  };
}

export async function drag(type: 'dragstart' | 'dragover' | 'dragleave' | 'drop', el: Element | null | undefined, dt: ReturnType<typeof dataTransfer>) {
  if (!el) throw new Error(`Nothing to ${type}`);
  let ev!: Event;
  await act(async () => {
    ev = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(ev, 'dataTransfer', { value: dt });
    el.dispatchEvent(ev);
  });
  return ev;
}

/* ----------------------------------------------------------- queries --- */

const norm = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();

/** Text as shown (whitespace collapsed). */
export const textOf = (el: Element | null | undefined) => norm(el?.textContent);

/** An element's accessible name, roughly as a screen reader would compute it. */
export function nameOf(el: Element): string {
  const label = el.getAttribute('aria-label');
  if (label) return norm(label);
  const by = el.getAttribute('aria-labelledby');
  if (by) return norm(by.split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? '').join(' '));
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    const lab = el.labels?.[0];
    return norm(lab?.textContent) || norm(el.getAttribute('title')) || norm(el.getAttribute('placeholder'));
  }
  // Content, leaving out what's hidden from assistive technology.
  const clone = el.cloneNode(true) as Element;
  clone.querySelectorAll('[aria-hidden="true"]').forEach((n) => n.remove());
  return norm(clone.textContent) || norm(el.getAttribute('title'));
}

const ROLES: Record<string, string> = {
  button: 'button:not([role]), [role="button"], input[type="button"], input[type="submit"]',
  link: 'a[href]:not([role]), [role="link"]',
  menuitem: '[role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"]',
  menu: '[role="menu"]',
  option: '[role="option"]',
  listbox: '[role="listbox"]',
  radio: '[role="radio"], input[type="radio"]',
  radiogroup: '[role="radiogroup"]',
  checkbox: 'input[type="checkbox"], [role="checkbox"]',
  searchbox: 'input[type="search"], [role="searchbox"]',
  textbox: 'input:not([type]), input[type="text"], textarea, [role="textbox"]',
  combobox: '[role="combobox"]',
  dialog: '[role="dialog"], dialog',
  toolbar: '[role="toolbar"]',
  status: '[role="status"], output',
  alert: '[role="alert"]',
  navigation: 'nav, [role="navigation"]',
  region: 'section[aria-label], [role="region"]',
  heading: 'h1, h2, h3, h4, h5, h6, [role="heading"]',
  separator: '[role="separator"], hr',
  progressbar: '[role="progressbar"]',
  main: 'main, [role="main"]',
};

const matches = (name: string, want: string | RegExp | undefined) =>
  want === undefined || (typeof want === 'string' ? name === want : want.test(name));

export function allByRole(role: string, name?: string | RegExp, root: ParentNode = document.body): HTMLElement[] {
  const sel = ROLES[role] ?? `[role="${role}"]`;
  return Array.from(root.querySelectorAll<HTMLElement>(sel)).filter((el) => matches(nameOf(el), name));
}

export function queryByRole(role: string, name?: string | RegExp, root: ParentNode = document.body): HTMLElement | null {
  const found = allByRole(role, name, root);
  if (found.length > 1) throw new Error(`${found.length} ${role}s named ${String(name)}: ${found.map(nameOf).join(' | ')}`);
  return found[0] ?? null;
}

export function byRole(role: string, name?: string | RegExp, root: ParentNode = document.body): HTMLElement {
  const el = queryByRole(role, name, root);
  if (!el) {
    const sel = ROLES[role] ?? `[role="${role}"]`;
    const seen = Array.from(root.querySelectorAll(sel)).map(nameOf);
    throw new Error(`No ${role} named ${String(name)}. There are: ${seen.join(' | ') || 'none'}`);
  }
  return el;
}

/** What has focus, briefly: its accessible label, or its tag ("BODY" when nothing has). */
export function focused(): string {
  const el = document.activeElement;
  if (!el || el === document.body) return 'BODY';
  return el.getAttribute('aria-label') || `${el.tagName}: ${textOf(el).slice(0, 40)}`;
}

/** The innermost element whose own text is `text`. */
export function byText(text: string | RegExp, root: ParentNode = document.body, selector = '*'): HTMLElement {
  const found = Array.from(root.querySelectorAll<HTMLElement>(selector)).filter((el) => matches(textOf(el), text));
  const innermost = found.filter((el) => !found.some((o) => o !== el && el.contains(o)));
  if (!innermost.length) throw new Error(`No element with text ${String(text)}`);
  return innermost[0];
}

export function queryByText(text: string | RegExp, root: ParentNode = document.body, selector = '*'): HTMLElement | null {
  try {
    return byText(text, root, selector);
  } catch {
    return null;
  }
}

/** The menu that's open (menus are portalled to the end of the page). */
export function openMenu(): HTMLElement {
  const menus = allByRole('menu');
  if (!menus.length) throw new Error('No menu is open');
  return menus[menus.length - 1];
}

/** The labels of an open menu's items, in order. */
export const menuLabels = (menu: Element = openMenu()) => allByRole('menuitem', undefined, menu).map((b) => textOf(b.querySelector('.menu-label')));

/** Picks an item from the open menu by its label. */
export async function chooseMenuItem(label: string | RegExp) {
  const item = allByRole('menuitem', undefined, openMenu()).find((b) => matches(textOf(b.querySelector('.menu-label')), label));
  if (!item) throw new Error(`No menu item ${String(label)}; there are: ${menuLabels().join(' | ')}`);
  await click(item);
  await settle();
}

/** The dialog the store is asking (confirm or prompt), answered as a person would in DialogHost. */
export function pendingDialog(store: Booted['store']) {
  return store.useApp.getState().dialog;
}
export async function answerDialog(store: Booted['store'], value: string | boolean | null) {
  const d = store.useApp.getState().dialog;
  if (!d) throw new Error('No dialog is up');
  await act(async () => {
    store.useApp.setState({ dialog: null });
    d.resolve(value);
  });
  await settle();
}

export const toasts = (store: Booted['store']) => store.useApp.getState().toasts.map((t) => t.message);
