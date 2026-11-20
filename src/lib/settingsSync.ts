/**
 * Settings that follow you to every device: one record on the server (encrypted when the library is),
 * read with each refresh of the note list and saved a moment after a change.
 *
 * - Only SYNCED settings travel. Text size, pane widths, which folders are open and auto-lock stay
 *   with the device: they depend on its screen, or (auto-lock) on where it's used.
 * - Each save names the version it started from. If another device saved meanwhile, its values are
 *   taken for every setting this device hasn't changed since, and the save is tried again; so two
 *   devices changing different settings at once both keep their change.
 * - Nothing is sent while an encrypted library is locked; changes wait until it's unlocked.
 */
import { api, ApiError, currentCodec, currentKeyGen, libraryEncrypted, NetworkError } from './api';
import { settingsFromOtherTab, useSettings, validSettings, type Settings } from './settings';
import type { StoredSettings } from './types';

export const SYNCED_SETTINGS = [
  'theme',
  'accent',
  'noteFont',
  'readingWidth',
  'defaultMode',
  'livePreview',
  'lineBreaks',
  'editorImages',
  'spellcheck',
  'compressImages',
  'workspaceName',
  'sort',
  'listPreviews',
  'showOutline',
  'remoteImages',
  'captureTo',
  'exportFormat',
  'exportPaper',
  'exportTitle',
  'exportDetails',
  'exportAttachments',
  'exportFrontMatter',
  'savedSearches',
  'taskDoneDates',
  'autoBackup',
] as const satisfies ReadonlyArray<keyof Settings>;

type SyncedKey = (typeof SYNCED_SETTINGS)[number];
type Synced = Pick<Settings, SyncedKey>;

/** What this device has: the version it last had in step with, and the settings changed here since. */
interface Stamp {
  at: number;
  dirty: SyncedKey[];
}

const STAMP_KEY = 'kb.settings.sync';

function readStamp(): Stamp {
  try {
    const v = JSON.parse(localStorage.getItem(STAMP_KEY) || 'null') as Partial<Stamp> | null;
    if (v && typeof v.at === 'number') return { at: v.at, dirty: (v.dirty ?? []).filter((k): k is SyncedKey => (SYNCED_SETTINGS as readonly string[]).includes(k)) };
  } catch {
    /* unreadable: start over */
  }
  return { at: 0, dirty: [] };
}

function writeStamp(stamp: Stamp) {
  try {
    localStorage.setItem(STAMP_KEY, JSON.stringify(stamp));
  } catch {
    /* no storage: syncing still works for this session */
  }
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function current(): Synced {
  const s = useSettings.getState();
  return Object.fromEntries(SYNCED_SETTINGS.map((k) => [k, s[k]])) as Synced;
}

/**
 * The values another device saved that this version can use (see RULES in settings.ts: an unknown
 * theme or view mode, say, is left out), that differ from what's here, skipping `except`.
 */
export function usable(values: unknown, except: readonly string[] = []): Partial<Synced> {
  const here = current();
  const valid = validSettings(values);
  const out: Record<string, unknown> = {};
  for (const k of SYNCED_SETTINGS) {
    if (except.includes(k) || !Object.hasOwn(valid, k)) continue;
    if (!same(valid[k], here[k])) out[k] = valid[k];
  }
  return out as Partial<Synced>;
}

let applying = false;

function apply(values: Partial<Synced>) {
  if (!Object.keys(values).length) return;
  applying = true;
  try {
    useSettings.getState().update(values);
  } finally {
    applying = false;
  }
}

/** Takes another device's settings (as stored) for everything not changed here since; false if unreadable. */
async function take(stored: StoredSettings): Promise<boolean> {
  const json = await api.openSettings(stored).catch(() => null);
  if (json === null) return false;
  let values: Record<string, unknown>;
  try {
    values = JSON.parse(json) as Record<string, unknown>;
  } catch {
    return false;
  }
  const stamp = readStamp();
  // A save from here finished while this was being read: what's stored is older than what this device
  // has now, so it's not taken (that would undo the change just sent).
  if (stored.at <= stamp.at) return true;
  apply(usable(values, stamp.dirty));
  writeStamp({ ...readStamp(), at: stored.at });
  return true;
}

let pushing: Promise<void> | null = null;
let timer: ReturnType<typeof setTimeout> | undefined;

/** Saves this device's synced settings, merging with another device's save if one came first. */
function push(): Promise<void> {
  clearTimeout(timer);
  pushing ??= (async () => {
    // Locked: what's sent has to be encrypted, so it waits.
    if (libraryEncrypted() && !currentCodec()) return;
    for (let attempt = 0; attempt < 3; attempt++) {
      const sent = current();
      const res = await api.saveSettings(JSON.stringify(sent), readStamp().at);
      if (res.ok) {
        // Changes made while this was on its way stay to be sent.
        const now = current();
        writeStamp({ at: res.at, dirty: readStamp().dirty.filter((k) => !same(now[k], sent[k])) });
        if (readStamp().dirty.length) schedule();
        return;
      }
      if (!res.settings || !(await take(res.settings))) {
        // Nothing readable there (gone, or under a key this device doesn't have): this device's replaces it.
        writeStamp({ ...readStamp(), at: res.settings?.at ?? 0 });
      }
    }
  })()
    .catch((err) => {
      // Offline, or the key changed: the changes stay marked and go with the next refresh.
      if (!(err instanceof NetworkError) && !(err instanceof ApiError)) console.warn('Settings not synced', err);
    })
    .finally(() => (pushing = null));
  return pushing;
}

function schedule() {
  clearTimeout(timer);
  timer = setTimeout(() => void push(), 1500);
}

/**
 * With each refresh of the note list: takes a newer version saved by another device, sends this
 * device's changes, and re-saves what's stored if it isn't encrypted the way the library now is
 * (encryption turned on, or the key replaced, since).
 */
export async function receiveSettings(stored: StoredSettings | null | undefined, encryptionOn: boolean): Promise<void> {
  if (stored === undefined) return; // an older server
  const stamp = readStamp();
  let resave = false;
  if (!stored) {
    // None saved yet: this device's become everyone's.
    resave = true;
  } else {
    if (stored.at > stamp.at && !(await take(stored))) resave = true;
    if (encryptionOn && (!stored.enc || stored.kgen < currentKeyGen())) resave = true;
  }
  if (resave || readStamp().dirty.length) await push();
}

/** Every change to a synced setting on this device is marked, and sent shortly. */
useSettings.subscribe((next, prev) => {
  if (applying || settingsFromOtherTab) return;
  const changed = SYNCED_SETTINGS.filter((k) => !same(next[k], prev[k]));
  if (!changed.length) return;
  const stamp = readStamp();
  writeStamp({ ...stamp, dirty: [...new Set([...stamp.dirty, ...changed])] });
  schedule();
});
