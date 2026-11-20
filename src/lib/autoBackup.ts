/**
 * Automatic backups: about once a week, whichever device has Lumen open (and unlocked) makes the same
 * backup "Download backup" makes (encrypted on this device when the library is) and keeps it on the
 * server, in an R2 bucket of its own (see /api/backups in worker/index.ts), which keeps the newest
 * eight. Restoring one is the ordinary restore, from Settings → Data. Off without that bucket, or when
 * turned off in Settings.
 */
import { api, ApiError, errorMessage } from './api';
import { exportBackup } from './backup';
import { useSettings } from './settings';
import { toast, useApp } from './store';
import { deviceKeys } from './vault';

export const BACKUP_EVERY = 7 * 24 * 3_600_000;
/** After Lumen opens, so the backup doesn't slow the library loading. */
const FIRST_LOOK = 90_000;
/** Then looked at again now and then, for a device left open for days. */
const LOOK_EVERY = 6 * 3_600_000;

let running: Promise<boolean> | null = null;
let toldTooBig = false;

/** Why a backup can't be made here now (null: it can). */
function notNow(): string | null {
  const s = useApp.getState();
  if (s.status !== 'ready') return 'loading';
  if (!s.online || (typeof navigator !== 'undefined' && navigator.onLine === false)) return 'offline';
  // Still encrypting (or re-keying) the library: a backup made now would be part one way, part the other.
  if (s.encryption.pending > 0 || s.encryption.rekey > 0 || s.encryption.attachments > 0) return 'encrypting';
  if (s.encryption.on && !deviceKeys()[0]) return 'locked';
  const saveData = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData;
  if (saveData) return 'saving data';
  return null;
}

/**
 * Makes and keeps a backup: when one is due (`force`: now, as "Back up now" asks). True if one was
 * kept. Only one at a time, across this browser's tabs too.
 */
export function backUpIfDue(opts: { force?: boolean } = {}): Promise<boolean> {
  running ??= (async () => {
    try {
      const go = () => backUp(opts.force ?? false);
      const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
      if (!locks) return await go();
      // Another tab making one already: that one will do.
      return await locks.request('lumen-auto-backup', { ifAvailable: true }, (lock) => (lock ? go() : false));
    } finally {
      running = null;
    }
  })();
  return running;
}

async function backUp(force: boolean): Promise<boolean> {
  if (!force && !useSettings.getState().autoBackup) return false;
  if (notNow()) return false;
  const list = await api.listBackups().catch(() => null);
  if (!list?.available) return false;
  const newest = list.backups[0]?.made_at ?? 0;
  if (!force && Date.now() - newest < BACKUP_EVERY) return false;

  const sealed = useApp.getState().encryption.on;
  try {
    const made = await exportBackup(() => undefined, { encrypted: sealed });
    const kept = await api.keepBackup(made.blob, { sealed, auto: !force });
    useApp.setState({ lastBackup: kept.at });
    const gaps = made.unreadable.length + made.missing.length;
    if (gaps) {
      toast(
        `Backed up your library, without ${gaps} ${gaps === 1 ? 'item' : 'items'} this device couldn’t read or download. Settings → Data says more when you back up from there.`,
        { kind: 'error', timeout: 10_000 },
      );
    } else if (force) toast('Backed up your library', { kind: 'success' });
    return true;
  } catch (err) {
    if (err instanceof ApiError && err.code === 'recent') return false;
    if (err instanceof ApiError && err.code === 'too_large') {
      if (!toldTooBig || force) {
        toldTooBig = true;
        toast('Your library is now too big to back up automatically (over 95 MB). Download a backup from Settings → Data instead.', {
          kind: 'error',
          timeout: 12_000,
        });
      }
      return false;
    }
    if (force) toast(errorMessage(err), { kind: 'error' });
    // Automatic: tried again later, quietly.
    else console.warn('Automatic backup failed; it will be tried again later.', err);
    return false;
  }
}

let started = false;

/** Looks for a backup that's due a little after Lumen opens, and every few hours while it stays open. */
export function startAutoBackups() {
  if (started) return;
  started = true;
  setTimeout(() => void backUpIfDue(), FIRST_LOOK);
  setInterval(() => void backUpIfDue(), LOOK_EVERY);
}
