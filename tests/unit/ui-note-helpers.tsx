/**
 * Shared helpers for the component tests of the note view and dialogs (tests/unit/ui-*.test.tsx).
 *
 * Import this module FIRST in a test file (before anything from src/): it puts in what jsdom lacks
 * (matchMedia, ResizeObserver, layout stand-ins, CSS.escape, clipboard, object URLs, IndexedDB) before
 * the app's modules read them at load.
 *
 * - mount(): renders with React's createRoot inside act(); unmountAll() in afterEach.
 * - click / press / typeInto / choose / check: real DOM events, the way a person's input arrives.
 * - byName / allByName / queryByName: find controls by accessible name (aria-label, or text).
 * - fakeServer(): a stand-in for the Worker's note routes, served through a stubbed fetch, so the app's
 *   real API client, store and autosave run against it.
 */
import 'fake-indexeddb/auto';
import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { vi } from 'vitest';

/* ------------------------------------------------------------- jsdom --- */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** Media queries, set per test with setMedia(). Default: a roomy desktop window, light theme, mouse. */
const DEFAULT_MEDIA: Record<string, boolean> = {
  '(min-width: 1100px)': true,
  '(min-width: 1360px)': true,
  '(max-width: 759px)': false,
  '(prefers-color-scheme: dark)': false,
  '(pointer: coarse)': false,
};
const media = new Map<string, boolean>(Object.entries(DEFAULT_MEDIA));
const mediaListeners = new Map<string, Set<() => void>>();

window.matchMedia = ((query: string) => {
  const set = mediaListeners.get(query) ?? new Set();
  mediaListeners.set(query, set);
  return {
    get matches() {
      return media.get(query) ?? false;
    },
    media: query,
    onchange: null,
    addEventListener: (_: string, fn: () => void) => set.add(fn),
    removeEventListener: (_: string, fn: () => void) => set.delete(fn),
    addListener: (fn: () => void) => set.add(fn),
    removeListener: (fn: () => void) => set.delete(fn),
    dispatchEvent: () => false,
  };
}) as unknown as typeof window.matchMedia;

/** Changes what a media query matches, telling everything listening (as resizing the window would). */
export async function setMedia(query: string, matches: boolean) {
  media.set(query, matches);
  await act(async () => mediaListeners.get(query)?.forEach((fn) => fn()));
}

/** A phone-sized window: the phone layout's media queries. */
export async function phone() {
  await setMedia('(max-width: 759px)', true);
  await setMedia('(min-width: 1100px)', false);
  await setMedia('(min-width: 1360px)', false);
}

export function resetMedia() {
  // A query a test added (one not among the defaults) goes too, so it can't carry over to the next.
  for (const q of [...media.keys()]) if (!Object.hasOwn(DEFAULT_MEDIA, q)) media.delete(q);
  for (const [q, v] of Object.entries(DEFAULT_MEDIA)) media.set(q, v);
}

(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
(globalThis as { CSS?: { escape(s: string): string } }).CSS ??= { escape: (s: string) => s.replace(/[^\w-]/g, (c) => `\\${c}`) };
Element.prototype.scrollIntoView ??= function () {};
Element.prototype.scrollTo ??= function () {};
Range.prototype.getClientRects ??= () => Object.assign([], { item: () => null }) as unknown as DOMRectList;
Range.prototype.getBoundingClientRect ??= () => new DOMRect();
// Animation frames as timers, so fake timers cover them too.
window.requestAnimationFrame = (cb: FrameRequestCallback) => globalThis.setTimeout(() => cb(Date.now()), 16) as unknown as number;
window.cancelAnimationFrame = (id: number) => globalThis.clearTimeout(id);

export const clipboard = { written: [] as string[], fail: false };
Object.defineProperty(navigator, 'clipboard', {
  configurable: true,
  value: {
    writeText: async (text: string) => {
      if (clipboard.fail) throw new Error('denied');
      clipboard.written.push(text);
    },
  },
});

let objectUrls = 0;
URL.createObjectURL ??= () => `blob:http://localhost/${++objectUrls}`;
URL.revokeObjectURL ??= () => undefined;

/**
 * jsdom has no layout, so every element's offsetParent is null, which the dialogs' focus trap reads as
 * "hidden". Call once to treat connected elements as visible (for Tab-order tests).
 */
export function pretendLayout() {
  Object.defineProperty(HTMLElement.prototype, 'offsetParent', {
    configurable: true,
    get(this: HTMLElement) {
      return this.isConnected ? this.parentElement : null;
    },
  });
}

/** Errors thrown out of event handlers and effects, which jsdom reports instead of failing the test. */
export const uncaught: unknown[] = [];
window.addEventListener('error', (e) => {
  uncaught.push(e.error ?? e.message);
});

/* ------------------------------------------------------------ render --- */

const roots: Root[] = [];

export async function mount(element: ReactElement) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => root.render(element));
  return {
    container,
    rerender: (next: ReactElement) => act(async () => root.render(next)),
    unmount: () => act(async () => root.unmount()),
  };
}

export async function unmountAll() {
  for (const r of roots.splice(0)) await act(async () => r.unmount());
  document.body.innerHTML = '';
  uncaught.length = 0;
}

/* ------------------------------------------------------------ finding --- */

/** An element's accessible name, roughly as a screen reader works it out (enough for these tests). */
export function nameOf(el: Element): string {
  const label = el.getAttribute('aria-label');
  if (label) return label.trim();
  const by = el.getAttribute('aria-labelledby');
  if (by) return by.split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? '').join(' ').trim();
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
    const labels = (el as HTMLInputElement).labels;
    if (labels?.length) return Array.from(labels).map((l) => l.textContent ?? '').join(' ').trim();
    return '';
  }
  return (el.textContent ?? '').replace(/\s+/g, ' ').trim();
}

const CONTROLS = 'button, a[href], input, textarea, select, [role^="menuitem"], [role="radio"], [role="switch"], [role="option"]';

/** Every control (or `selector`) in `root` whose accessible name is `name` (exactly, or matching a RegExp). */
export function allByName(name: string | RegExp, selector = CONTROLS, root: ParentNode = document.body): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(selector)).filter((el) => {
    const n = nameOf(el);
    return typeof name === 'string' ? n === name : name.test(n);
  });
}

export function queryByName(name: string | RegExp, selector = CONTROLS, root: ParentNode = document.body): HTMLElement | null {
  return allByName(name, selector, root)[0] ?? null;
}

/** The one control named `name`; throws, listing what is there, if there's none. */
export function byName<T extends HTMLElement = HTMLElement>(name: string | RegExp, selector = CONTROLS, root: ParentNode = document.body): T {
  const found = queryByName(name, selector, root);
  if (!found) {
    const there = Array.from(root.querySelectorAll(selector))
      .map((el) => `${el.tagName.toLowerCase()}:${JSON.stringify(nameOf(el))}`)
      .join(', ');
    throw new Error(`No ${selector} named ${String(name)}. There are: ${there}`);
  }
  return found as T;
}

/** The open dialog (the last one, when one is on top of another). */
export function dialog(): HTMLElement | null {
  const all = document.querySelectorAll<HTMLElement>('[role="dialog"]');
  return all[all.length - 1] ?? null;
}

export const text = (root: ParentNode = document.body) => (root.textContent ?? '').replace(/\s+/g, ' ');

/* ------------------------------------------------------------ events --- */

export async function click(el: Element | null) {
  if (!el) throw new Error('Nothing to click');
  await act(async () => (el as HTMLElement).click());
}

export async function pointerDown(el: Element) {
  const Ctor = (window as { PointerEvent?: typeof MouseEvent }).PointerEvent ?? MouseEvent;
  await act(async () => void el.dispatchEvent(new Ctor('pointerdown', { bubbles: true, cancelable: true })));
}

export interface Mods {
  ctrl?: boolean;
  meta?: boolean;
  shift?: boolean;
  alt?: boolean;
}

/** A key pressed on `target` (default: what has focus). Returns the event, to see if it was handled. */
export async function press(key: string, mods: Mods = {}, target: Element | null = document.activeElement) {
  const event = new KeyboardEvent('keydown', {
    key,
    ctrlKey: !!mods.ctrl,
    metaKey: !!mods.meta,
    shiftKey: !!mods.shift,
    altKey: !!mods.alt,
    bubbles: true,
    cancelable: true,
  });
  await act(async () => void (target ?? document.body).dispatchEvent(event));
  return event;
}

/** Types `value` into a text field as the browser reports it: its value replaced, then an input event. */
export async function typeInto(el: Element, value: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')!.set!;
  await act(async () => {
    (el as HTMLElement).focus();
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

/** Picks an option of a <select>, or moves a range input. */
export async function choose(el: Element, value: string) {
  const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')!.set!;
  await act(async () => {
    setter.call(el, value);
    el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
    if (!(el instanceof HTMLSelectElement)) el.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

export async function focus(el: Element) {
  await act(async () => (el as HTMLElement).focus());
}

export async function blur(el: Element) {
  await act(async () => (el as HTMLElement).blur());
}

/* ------------------------------------------------------------ timing --- */

/** Lets promises, fetches and React updates settle (real async work; fake timers don't cover it). */
export async function settle(rounds = 30) {
  await act(async () => {
    for (let i = 0; i < rounds; i++) await new Promise<void>((r) => setImmediate(r));
  });
}

/**
 * Settles until `check` is true: real WebCrypto and fetches take a varying number of turns, more on a
 * busy machine, so a fixed number of rounds can stop short. Fails with `what` if it never comes true.
 */
export async function settleUntil(check: () => unknown, what = 'the condition', maxRounds = 4000) {
  for (let done = 0; done < maxRounds; done += 20) {
    if (check()) return;
    await settle(20);
  }
  if (!check()) throw new Error(`Still waiting for ${what} after ${maxRounds} rounds`);
}

/** With fake timers (see FAKE_TIMERS): moves the clock on, letting what that starts settle. */
export async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
  await settle();
}

/**
 * Like advance(), but a step at a time, with React rendering after each: effects that start timers
 * when something renders (a lookup once a save has finished, say) start them when they would in a
 * browser, not when one long act() ends.
 */
export async function elapse(ms: number, step = 50) {
  for (let done = 0; done < ms; done += step) await advance(Math.min(step, ms - done));
}

/** The timers to fake: setImmediate stays real so settle() can let promises and fetches finish. */
export const FAKE_TIMERS = { toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] as const };

/* -------------------------------------------------------- the server --- */

export interface ServerNote {
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
  /** An encrypted note: content is ciphertext and the other fields are in `sealed`. */
  enc?: boolean;
  sealed?: Record<string, string>;
  kgen?: number;
  /** Ids of the saves that changed its text, as the Worker keeps them (migration 6). */
  saves?: string[];
}

export interface Req {
  method: string;
  path: string;
  query: URLSearchParams;
  body: Record<string, any> | undefined;
  /** The request's headers, lower-cased names. */
  headers?: Record<string, string>;
}

const respond = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/**
 * The Worker's note routes, kept the way it keeps them: versions go up when text changes, a save on
 * top of an older version is refused with the saved note (409), trash and restore, versions, backlinks
 * (any note whose text has [[Title]]). `intercept` stands in front: return a Response to answer, throw
 * to drop the connection, or undefined to let the server answer.
 */
export function fakeServer(now = () => Date.now()) {
  const notes = new Map<string, ServerNote>();
  const versions: Array<{ id: number; note_id: string; title: string; content: string; created_at: number }> = [];
  const log: Req[] = [];
  let created = 0;
  let versionSeq = 100;
  const server = {
    notes,
    versions,
    log,
    intercept: null as ((req: Req) => Promise<Response | undefined> | Response | undefined) | null,
    offline: false,
    stats: { notes: { active: 3, trashed: 1, chars: 1200 }, files: { count: 2, bytes: 2048 }, drawings: { count: 1, bytes: 512 }, storage: 'kv' },

    add(init: Partial<ServerNote> & { id: string }): ServerNote {
      const t = now();
      const note: ServerNote = {
        folder_id: null,
        title: '',
        excerpt: '',
        info: {},
        tags: [],
        pinned: false,
        version: 1,
        created_at: t,
        updated_at: t,
        deleted_at: null,
        content: '',
        ...init,
      };
      notes.set(note.id, note);
      return note;
    },
    /** Another device saves new text into the note. */
    savedElsewhere(id: string, patch: { title?: string; content?: string }) {
      const n = notes.get(id)!;
      versions.push({ id: ++versionSeq, note_id: id, title: n.title, content: n.content, created_at: n.updated_at });
      Object.assign(n, patch);
      n.version++;
      n.updated_at = now();
    },
    addVersion(noteId: string, v: { title: string; content: string; created_at: number }) {
      const row = { id: ++versionSeq, note_id: noteId, ...v };
      versions.push(row);
      return row;
    },
    requests(method: string, path?: string | RegExp) {
      return log.filter((r) => r.method === method && (path === undefined || (typeof path === 'string' ? r.path === path : path.test(r.path))));
    },
    serve(req: Req): Response {
      const b = req.body ?? {};
      const meta = ({ content: _c, saves: _s, ...m }: ServerNote) => m;
      const note = /^\/api\/notes\/([^/]+)(?:\/(trash|restore|versions|backlinks))?$/.exec(req.path);
      if (req.method === 'POST' && req.path === '/api/notes') {
        const id = (b.id as string) ?? `new${++created}`;
        // As the Worker: an id that's taken is refused (a restore replaces the note instead).
        if (server.notes.has(id) && !b.restore) return respond(409, { error: 'exists', message: 'A note with this id already exists.' });
        const row = server.add({
          id,
          title: b.title ?? '',
          content: b.content ?? '',
          folder_id: b.folder_id ?? null,
          tags: b.tags ?? [],
          pinned: !!b.pinned,
          ...(b.enc ? { enc: true, sealed: b.sealed, kgen: b.kgen ?? 0 } : {}),
        });
        return respond(200, meta(row));
      }
      if (req.method === 'POST' && req.path === '/api/notes/batch') {
        const ids: string[] = b.ids ?? [];
        return respond(200, { notes: ids.map((id) => notes.get(id)).filter(Boolean) });
      }
      if (note) {
        const [, id, sub] = note;
        const row = notes.get(decodeURIComponent(id));
        if (!row) return respond(404, { error: 'not_found', message: 'Note not found.' });
        if (req.method === 'GET' && !sub) {
          const { saves: _s, ...note } = row;
          return respond(200, note);
        }
        if (req.method === 'GET' && sub === 'versions') {
          return respond(200, {
            versions: versions
              .filter((v) => v.note_id === row.id)
              .sort((x, y) => y.created_at - x.created_at)
              .map((v) => ({ id: v.id, title: v.title, size: v.content.length, created_at: v.created_at })),
          });
        }
        if (req.method === 'GET' && sub === 'backlinks') {
          const key = row.title.trim().toLowerCase();
          const backlinks = [...notes.values()]
            .filter((n) => n.id !== row.id && !n.deleted_at && key && n.content.toLowerCase().includes(`[[${key}`))
            .map((n) => ({ id: n.id, title: n.title, excerpt: n.excerpt, updated_at: n.updated_at }));
          return respond(200, { backlinks });
        }
        if (req.method === 'POST' && sub === 'versions') {
          const v = { id: ++versionSeq, note_id: row.id, title: b.title ?? '', content: b.content ?? '', created_at: typeof b.at === 'number' ? b.at : now() };
          versions.push(v);
          return respond(201, { ok: true, id: v.id });
        }
        if (req.method === 'POST' && sub === 'trash') {
          row.deleted_at = now();
          return respond(200, meta(row));
        }
        if (req.method === 'POST' && sub === 'restore') {
          row.deleted_at = null;
          return respond(200, meta(row));
        }
        if (req.method === 'DELETE') {
          const ifVersion = req.query.get('ifVersion');
          if (ifVersion !== null && Number(ifVersion) !== row.version) return respond(200, { ok: true, deleted: false });
          notes.delete(row.id);
          return respond(200, { ok: true, deleted: true });
        }
        if (req.method === 'PATCH') {
          const textChanged =
            (typeof b.content === 'string' && b.content !== row.content) ||
            (typeof b.title === 'string' && b.title !== row.title) ||
            (b.sealed?.t !== undefined && b.sealed.t !== row.sealed?.t);
          if (textChanged && typeof b.baseVersion === 'number' && b.baseVersion !== row.version && b.force !== true) {
            const { saves, ...note } = row;
            return respond(409, { error: 'conflict', message: 'Changed on another device.', note, saves: saves ?? [], now: now() });
          }
          if (textChanged) versions.push({ id: ++versionSeq, note_id: row.id, title: row.title, content: row.content, created_at: row.updated_at });
          if (textChanged && typeof b.saveId === 'string') row.saves = [...(row.saves ?? []), b.saveId].slice(-16);
          if (typeof b.content === 'string') row.content = b.content;
          if (typeof b.title === 'string') row.title = b.title;
          if (Array.isArray(b.tags)) row.tags = b.tags;
          if ('folder_id' in b) row.folder_id = b.folder_id;
          if ('pinned' in b) row.pinned = !!b.pinned;
          if (b.enc) {
            row.enc = true;
            row.sealed = { ...row.sealed, ...b.sealed };
            row.kgen = b.kgen ?? row.kgen;
          }
          if (textChanged) {
            row.version++;
            row.updated_at = now();
          }
          return respond(200, meta(row));
        }
      }
      const version = /^\/api\/versions\/(\d+)$/.exec(req.path);
      if (version && req.method === 'GET') {
        const v = versions.find((x) => x.id === Number(version[1]));
        return v ? respond(200, v) : respond(404, { error: 'not_found', message: 'Version not found.' });
      }
      // Every note and every saved version, in one page each (for finding which files are in use).
      if (req.method === 'GET' && req.path === '/api/export/notes') {
        return respond(200, { notes: [...server.notes.values()].map(({ saves: _s, ...n }) => n), next: null });
      }
      if (req.method === 'GET' && req.path === '/api/versions/export') {
        return respond(200, { versions: versions.map((v) => ({ ...v, enc: false, sealed: {} })), next: null });
      }
      if (req.method === 'GET' && req.path === '/api/stats') return respond(200, server.stats);
      if (req.method === 'PUT' && req.path === '/api/settings') return respond(200, { ok: true, at: now() });
      if (req.method === 'POST' && req.path === '/api/backup') return respond(200, { ok: true, at: now() });
      return respond(404, { error: 'no_route', message: `No route for ${req.method} ${req.path}` });
    },
    async fetch(input: RequestInfo | URL, init: RequestInit = {}) {
      const url = new URL(String(input), 'http://localhost');
      let body: Record<string, any> | undefined;
      if (typeof init.body === 'string') {
        try {
          body = JSON.parse(init.body);
        } catch {
          body = undefined;
        }
      }
      const headers: Record<string, string> = {};
      new Headers(init.headers).forEach((v, k) => (headers[k] = v));
      const req: Req = { method: init.method ?? 'GET', path: url.pathname, query: url.searchParams, body, headers };
      log.push(req);
      if (server.offline) throw new TypeError('Failed to fetch');
      const answer = server.intercept ? await server.intercept(req) : undefined;
      return answer ?? server.serve(req);
    },
  };
  return server;
}

export type FakeServer = ReturnType<typeof fakeServer>;

/** Serves the app's requests from `server` until vi.unstubAllGlobals(). */
export function useServer(server: FakeServer) {
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => server.fetch(input, init));
}

/** A note's list entry (NoteMeta) from a server row. */
export function metaOf(n: ServerNote) {
  const { content: _c, saves: _s, ...m } = n;
  return m;
}
