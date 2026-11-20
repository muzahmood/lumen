/**
 * Sign out of this device: removes everything Lumen keeps in the browser for offline
 * use (cached notes, files, drawings and the app itself, unsent drafts and the encryption key), then ends
 * the Cloudflare Access session. Appearance settings are kept; they hold no note content.
 */
import { api } from './api';
import { deleteLocalNotes } from './localStore';
import { discardAll, flushAll, hasUnsaved } from './saver';
import { confirmDialog, noticeDialog } from './store';
import { announceSignOut, forgetDeviceKey } from './vault';

const KEEP = new Set(['kb.settings']);

function unsentDraftCount(): number {
  let n = 0;
  for (let i = 0; i < localStorage.length; i++) if (localStorage.key(i)?.startsWith('kb.draft.')) n++;
  return n;
}

/**
 * Everything this browser keeps for Lumen. Each step runs whatever happened to the ones before (a
 * browser without IndexedDB, say, still loses its drafts); throws at the end if any step failed.
 */
async function clearDeviceData() {
  const steps: Array<() => unknown> = [
    // The encryption key this browser holds goes too: signing back in asks for the passphrase.
    () => forgetDeviceKey(),
    // The copy of every note kept for search and offline reading (ciphertext, but it goes all the same).
    () => deleteLocalNotes(),
    async () => {
      if (!('caches' in window)) return;
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
    },
    () => {
      const keys: string[] = [];
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key?.startsWith('kb.') && !KEEP.has(key)) keys.push(key);
      }
      keys.forEach((k) => localStorage.removeItem(k));
    },
    () => sessionStorage.clear(),
  ];
  let failed: unknown = null;
  for (const step of steps) {
    try {
      await step();
    } catch (err) {
      failed ??= err;
    }
  }
  if (failed) throw failed;
}

export async function signOutOfDevice(local: boolean) {
  // Give pending edits a last chance to reach the server first.
  try {
    await flushAll();
  } catch {
    /* offline or signed out; counted below */
  }
  const unsent = unsentDraftCount() + (hasUnsaved() ? 1 : 0);
  const ok = await confirmDialog({
    title: 'Sign out of this device?',
    message:
      unsent > 0
        ? 'Some edits haven’t reached the server yet and will be lost. Signing out also removes the notes, files and drawings saved in this browser for offline use.'
        : 'This removes the notes, files and drawings saved in this browser for offline use, then ends your Cloudflare Access session.',
    confirmLabel: unsent > 0 ? 'Sign out and discard' : 'Sign out',
    danger: unsent > 0,
  });
  if (!ok) return;
  // From here this tab sends and keeps nothing: otherwise leaving the page (its pagehide flush) or a
  // retry would write the edits just discarded back into the storage cleared below.
  discardAll();
  // Access's logout ends the session for this app; locally there's no session to end.
  const destination = local ? '/' : '/cdn-cgi/access/logout';
  // Other Lumen tabs in this browser leave too, before this one clears the storage they share.
  announceSignOut(destination);
  let httpCacheCleared = true;
  try {
    // The browser's HTTP cache, where opened files and images are kept, is emptied by the server's reply.
    await api.signOut();
  } catch {
    // Offline: the rest is still cleared, but that cache only the server's answer (or the browser's
    // own settings) can empty.
    httpCacheCleared = false;
  }
  let cleared = true;
  try {
    await clearDeviceData();
  } catch {
    cleared = false;
  }
  if (!httpCacheCleared) {
    // Emptied the next time Lumen opens in this browser; but this may be a computer that isn't the
    // person's, so they're told before leaving.
    try {
      localStorage.setItem(CLEAR_HTTP_CACHE, '1');
    } catch {
      /* no storage: the notice below is all there is */
    }
  }
  if (!httpCacheCleared || !cleared) {
    await noticeDialog({
      title: cleared ? 'Pictures and files opened here are still in this browser' : 'Not everything here could be cleared',
      message: cleared
        ? 'You’re offline, so the copies of pictures and files this browser keeps couldn’t be removed. On a computer that isn’t yours, clear this site’s data in the browser’s settings. Lumen also clears them the next time it opens here.'
        : 'Some of what Lumen keeps in this browser couldn’t be removed. On a computer that isn’t yours, clear this site’s data in the browser’s settings.',
      confirmLabel: 'Sign out',
    });
  }
  location.href = destination;
}

/** Set when signing out couldn't empty the browser's HTTP cache (offline): done the next time Lumen opens. */
const CLEAR_HTTP_CACHE = 'kb.signout.clear-cache';

/** Empties the browser's HTTP cache of Lumen's files if signing out here last time couldn't. Call once at start. */
export function clearCacheLeftBySignOut(): void {
  try {
    if (!localStorage.getItem(CLEAR_HTTP_CACHE)) return;
  } catch {
    return;
  }
  void api.clearHttpCache().then(
    () => {
      try {
        localStorage.removeItem(CLEAR_HTTP_CACHE);
      } catch {
        /* tried again next time */
      }
    },
    () => undefined,
  );
}
