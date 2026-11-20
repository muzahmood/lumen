/**
 * KaTeX (maths) and highlight.js (code colours) are most of what showing a note costs to download
 * and start (about 125 kB compressed, of 180), and most notes need neither. So they load on demand:
 * when a note shows maths or a code block in a named language, and otherwise in idle time shortly
 * after a note opens, so they're ready for the next one and kept by the service worker for offline
 * use. Until they're in, markdown.ts shows a formula's TeX and code without colours.
 *
 * KaTeX is the package's ES build, the one Mermaid loads too, so the app holds one copy of it.
 */
import type Katex from 'katex';
import type { HLJSApi } from 'highlight.js';

let katexLib: typeof Katex | null = null;
let hljsLib: HLJSApi | null = null;
let loading: Promise<void> | null = null;
let failedAt = -Infinity;
const listeners = new Set<() => void>();

/** After a failed download (offline, say), wait this long before trying again rather than on every render. */
const RETRY_AFTER_MS = 10_000;

export const loadedKatex = () => katexLib;
export const loadedHljs = () => hljsLib;

/** Loads both (once); resolves when they're in. */
export function loadExtras(): Promise<void> {
  if (katexLib && hljsLib) return Promise.resolve();
  if (loading) return loading;
  if (Date.now() - failedAt < RETRY_AFTER_MS) return Promise.reject(new Error('Maths and code colouring couldn’t be loaded.'));
  loading = Promise.all([import('katex'), import('highlight.js/lib/common'), import('katex/dist/katex.min.css')])
    .then(([k, h]) => {
      katexLib = k.default;
      hljsLib = h.default;
      for (const fn of listeners) fn();
    })
    .catch((err: unknown) => {
      failedAt = Date.now();
      throw err;
    })
    .finally(() => {
      loading = null;
    });
  return loading;
}

/** Told once both have loaded. */
export function onExtrasLoaded(fn: () => void): () => void {
  listeners.add(fn);
  return () => void listeners.delete(fn);
}

/**
 * Loads them when the browser is next idle (see the top of this file); returns a cancel function.
 * Offline, the download could only fail, so it waits for the connection to come back first.
 */
export function loadExtrasWhenIdle(): () => void {
  if (katexLib && hljsLib) return () => undefined;
  let cancelIdle: () => void = () => undefined;
  const schedule = () => {
    const run = () => void loadExtras().catch(() => undefined);
    if (typeof requestIdleCallback === 'function') {
      const id = requestIdleCallback(run, { timeout: 5000 });
      cancelIdle = () => cancelIdleCallback(id);
    } else {
      const id = setTimeout(run, 2000);
      cancelIdle = () => clearTimeout(id);
    }
  };
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    const online = () => {
      window.removeEventListener('online', online);
      schedule();
    };
    window.addEventListener('online', online);
    return () => {
      window.removeEventListener('online', online);
      cancelIdle();
    };
  }
  schedule();
  return () => cancelIdle();
}
