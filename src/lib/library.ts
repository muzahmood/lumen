/**
 * Every note's text on this device, for what needs all of it at once: search and backlinks in an
 * encrypted library, the Tasks view, updating links when a note is renamed, and opening notes offline.
 *
 * - In memory: each note's text (decrypted, for an encrypted library), at the version the note list
 *   shows. Gone on reload or lock.
 * - On disk (encrypted libraries only): each note as the server sent it, ciphertext and all (see
 *   localStore.ts). So a new session decrypts what it already has and asks the server only for notes
 *   whose version moved on, a batch at a time, instead of downloading the whole library again.
 */
import { api, ApiError, currentCodec, currentKeyGen, NetworkError, setNoteHooks, type Codec } from './api';
import * as local from './localStore';
import type { RawNote } from './localStore';
import { onNoteSaved } from './saver';
import { noteCache, useApp } from './store';
import type { Note } from './types';

export interface Doc {
  version: number;
  content: string;
  /** `content` folded for matching (lowercase, accents removed), filled in by search when needed. */
  folded?: string;
}

const docs = new Map<string, Doc>();
/** Notes that couldn't be decrypted, at the version tried: not fetched again until they change. */
const unreadable = new Map<string, number>();
/** The on-disk copies, loaded once per session (encrypted libraries only). */
let stored: Map<string, RawNote> | null = null;
let storedFor: Codec | null = null;
/** The codec the texts in memory were decrypted with: a new unlock starts again. */
let docsFor: Codec | null | undefined;

const BATCH = 90;

/** Copies are kept on disk only while an encrypted library is unlocked: they're ciphertext then. */
const persisting = () => currentCodec() !== null;

/**
 * A row worth keeping on disk, or using from it: encrypted, in the current key. Encrypting a library
 * for the first time, or replacing its key, re-encrypts notes without changing their version, so a row
 * fetched partway through (plaintext, or in the replaced key) would otherwise pass for current.
 */
const currentCipher = (row: RawNote) => !!row.enc && (row.kgen ?? 0) >= currentKeyGen();

async function loadStored(): Promise<Map<string, RawNote>> {
  const codec = currentCodec();
  if (stored && storedFor === codec) return stored;
  const map = new Map<string, RawNote>();
  stored = map;
  storedFor = codec;
  if (!codec) {
    // A library that isn't encrypted keeps nothing on disk (and drops anything an earlier session left).
    void local.clearAll();
    return map;
  }
  // Copies written under an earlier encryption key (before a key replacement) are dropped and fetched
  // again, so nothing on the device stays encrypted with a key that was replaced.
  const gen = currentKeyGen();
  if ((await local.getMeta<number>('gen')) !== gen) {
    await local.clearAll();
    await local.setMeta('gen', gen);
  }
  for (const row of await local.readAll()) if (row && typeof row.id === 'string') map.set(row.id, row);
  return map;
}

function keep(rows: RawNote[]) {
  rows = rows.filter(currentCipher);
  if (!persisting() || !rows.length) return;
  const map = stored;
  // A copy older than the one kept (a slow answer, the service worker's offline copy) never replaces it.
  if (map && storedFor === currentCodec()) {
    for (const r of rows) {
      const old = map.get(r.id);
      if (!old || old.version <= r.version) map.set(r.id, r);
    }
  }
  void local.putMany(rows);
}

async function open(rows: RawNote[]) {
  for (const row of rows) {
    try {
      const note = await api.openRaw(row);
      docs.set(note.id, { version: note.version, content: note.content });
      unreadable.delete(note.id);
    } catch (err) {
      // The key moved on: that's handled (the device locks); nothing more to do here.
      if (err instanceof ApiError && err.code === 'key_changed') throw err;
      unreadable.set(row.id, row.version);
    }
  }
}

let running: Promise<void> | null = null;

/**
 * Brings the texts in line with the note list: drops notes that are gone, decrypts copies already on
 * the device, and fetches the rest. Offline it stops quietly with whatever it has; callers fall back to
 * titles and previews for the notes it couldn't get.
 */
export function syncLibrary(): Promise<void> {
  running ??= (async () => {
    // A pass works from the note list as it started; if the list changed meanwhile (a save, a refresh),
    // another pass brings the texts up to it, so callers waiting on this get the current ones.
    for (let pass = 0; pass < 3; pass++) {
      const list = useApp.getState().notes;
      await doSync();
      if (useApp.getState().notes === list) break;
    }
  })().finally(() => (running = null));
  return running;
}

// A note saved from this device: its text here is the one just saved, at its new version (or, for a
// save that didn't change the text, the same text at the new version), not the one from before.
onNoteSaved((id, version, content, base) => {
  const doc = docs.get(id);
  if (content !== undefined) docs.set(id, { version, content });
  else if (doc && doc.version === base) docs.set(id, { ...doc, version });
});

async function doSync() {
  const codec = currentCodec();
  if (docsFor !== codec) {
    docs.clear();
    unreadable.clear();
    docsFor = codec;
  }
  const metas = useApp.getState().notes;
  if (useApp.getState().status !== 'ready') return;
  const disk = await loadStored();

  for (const id of [...docs.keys()]) if (!metas[id]) docs.delete(id);
  // Copies of notes no longer listed were deleted, unless the list is the offline copy (which may lack
  // notes made since it was fetched): those copies are all there is of them while offline.
  const gone = useApp.getState().offlineList ? [] : [...disk.keys()].filter((id) => !metas[id]);
  if (gone.length) {
    gone.forEach((id) => disk.delete(id));
    void local.removeMany(gone);
  }

  const fromDisk: RawNote[] = [];
  const missing: string[] = [];
  for (const m of Object.values(metas)) {
    if (docs.get(m.id)?.version === m.version) continue;
    if (unreadable.get(m.id) === m.version) continue;
    // A note open in this session is already decrypted.
    const cached = noteCache.get(m.id);
    if (cached && cached.version === m.version) {
      docs.set(m.id, { version: m.version, content: cached.content });
      continue;
    }
    const row = disk.get(m.id);
    if (row && row.version === m.version && currentCipher(row)) fromDisk.push(row);
    else missing.push(m.id);
  }
  await open(fromDisk);
  for (let i = 0; i < missing.length; i += BATCH) {
    let rows: RawNote[];
    try {
      rows = await api.rawNotes(missing.slice(i, i + BATCH));
    } catch (err) {
      if (err instanceof NetworkError) return;
      throw err;
    }
    // Only rows that decrypt are kept on disk.
    await open(rows);
    keep(rows.filter((r) => docs.get(r.id)?.version === r.version));
  }
}

/** Every note's text that's known, by id (call syncLibrary first for it to be complete). */
export function libraryDocs(): ReadonlyMap<string, Doc> {
  return docs;
}

/** Titles of notes that couldn't be decrypted in the last pass. */
export function unreadableNotes(): string[] {
  const metas = useApp.getState().notes;
  return [...unreadable.keys()].map((id) => metas[id]?.title || id);
}

/** Drops what's known, so the next sync reads every note from the server (a check that must be current). */
export function forgetLibrary() {
  docs.clear();
  unreadable.clear();
}

/* ----------------------------------------------- hooks from the API --- */

setNoteHooks({
  // A note fetched for any reason refreshes its copy on disk.
  fetched: (raw) => {
    if (persisting()) void loadStored().then(() => keep([raw]));
  },
  // Offline, with no copy in the service worker: the copy on disk, if it's the note list's version.
  // An older one is still better than nothing to read, but its folder, tags and pin come from the list.
  offline: async (id): Promise<Note | null> => {
    if (!persisting()) return null;
    const row = (await loadStored()).get(id) ?? (await local.readOne(id));
    if (!row || row.id !== id) return null;
    const note = await api.openRaw(row);
    const meta = useApp.getState().notes[id];
    return meta ? { ...note, ...meta, version: note.version, title: meta.version === note.version ? meta.title : note.title, content: note.content } : note;
  },
});

/* -------------------------------------------- keeping it up to date --- */

/** Told after each background pass brings the copy up to date (to remake out-of-date previews from it). */
const syncedListeners = new Set<() => void>();
export function onLibrarySynced(fn: () => void) {
  syncedListeners.add(fn);
  return () => syncedListeners.delete(fn);
}

let timer: ReturnType<typeof setTimeout> | null = null;

/**
 * In an encrypted library, the copy follows the note list in the background (a few seconds after it
 * changes, when the browser is idle), so search is instant and every note opens offline.
 */
function scheduleSync() {
  if (!persisting() || timer) return;
  timer = setTimeout(() => {
    timer = null;
    const run = () =>
      void syncLibrary().then(
        () => syncedListeners.forEach((fn) => fn()),
        () => undefined,
      );
    if ('requestIdleCallback' in window) requestIdleCallback(run, { timeout: 10_000 });
    else run();
  }, 4000);
}

useApp.subscribe((s, prev) => {
  if (s.status === 'ready' && (s.notes !== prev.notes || prev.status !== 'ready')) scheduleSync();
});
