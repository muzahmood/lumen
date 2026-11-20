/**
 * Recovering when part of the app fails to download.
 *
 * Script chunks are loaded on demand (the editor, settings, diagrams, Excalidraw's internals). One
 * failing to load means one of two things: a new version was deployed while this tab was open (the
 * old file names are gone from the server), or the device is offline and never saved that file.
 * Only the first is fixed by reloading, and only when nothing unsaved would be lost.
 */

import { toast } from './store';

const RELOAD_KEY = 'kb.version-reload';
let announced = false;

/**
 * Tells the person a new version is out, once per page, with a Reload button. Used where a reload
 * could cost unsaved work (the drawing editor, a dialog), so it's their call.
 */
export function announceUpdate() {
  if (announced) return;
  announced = true;
  toast('Lumen has been updated. Reload when you’re ready to get the new version.', {
    timeout: 0,
    action: { label: 'Reload', run: () => location.reload() },
  });
}

export type LoadFailure = 'updated' | 'offline';

/** True for the errors browsers and Vite raise when a script or style chunk can't be loaded. */
export function isChunkError(err: unknown): boolean {
  const text = err instanceof Error ? `${err.name} ${err.message}` : String(err);
  return /dynamically imported module|module script|error loading dynamically imported|Unable to preload CSS|ChunkLoadError/i.test(text);
}

/**
 * Works out why a chunk failed: if the server answers, the file must be gone (a new version);
 * if it doesn't, the device is offline. Never rejects.
 */
export async function diagnoseLoadFailure(): Promise<LoadFailure> {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return 'offline';
  try {
    // HEAD bypasses the service worker's caches; a redirect (an expired sign-in) still counts as reachable.
    await fetch('/', { method: 'HEAD', cache: 'no-store', redirect: 'manual', credentials: 'same-origin' });
    return 'updated';
  } catch {
    return 'offline';
  }
}

/**
 * Reloads once onto the new version. Returns false (and does nothing) if it already tried in the
 * last 30 seconds, so a file that's genuinely broken can't cause a reload loop. Unsaved note edits
 * are safe: they're in localStorage and sync after the reload.
 */
export function reloadForNewVersion(): boolean {
  try {
    const last = Number(sessionStorage.getItem(RELOAD_KEY) || 0);
    if (Date.now() - last < 30_000) return false;
    sessionStorage.setItem(RELOAD_KEY, String(Date.now()));
  } catch {
    // Without storage there's no memory across reloads: reload at most once, never from a page
    // that itself came from a reload.
    const nav = performance.getEntriesByType?.('navigation')[0] as PerformanceNavigationTiming | undefined;
    if (nav?.type === 'reload') return false;
  }
  location.reload();
  return true;
}
