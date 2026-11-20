/**
 * Autosave with offline safety, for one person moving between devices.
 *
 * Every edit is written to localStorage immediately (a "draft"), then sent to the server after a short
 * pause. If the network is down the draft stays and is retried. Each edit remembers the text it was
 * made on (the note as the server had it, at `baseVersion`), so when a save meets a newer version from
 * another device (the server answers 409), it's settled without asking whenever that's safe:
 *
 * - nothing really changed here (typed and undone), or the newer version was built on this device's own
 *   save (a phone that locked before hearing back): the newer version is simply shown;
 * - the two sets of changes touch different lines: both are kept;
 * - they can't be combined, and the edits here were made before the other device saved: the newer
 *   version stays, as it would when picking up on one device where the other left off, and the edits
 *   from here go into the note's history first.
 *
 * Only edits that can't be combined with a version saved before them (typed here on top of text this
 * device hadn't caught up with) stop for a choice, in the conflict banner.
 */
import { useSyncExternalStore } from 'react';
import { cleanTitle } from '../../shared/noteText';
import { api, ApiError, NetworkError, onReachabilityChange, type ConflictInfo } from './api';
import { merge3 } from './diff';
import { noteCache, openNote, preferredMode, removeMeta, restoreNote, toast, upsertMeta, useApp } from './store';
import type { Note } from './types';
import { idFor, newId, noteTitle } from './utils';

/**
 * 'error' retries on its own; 'failed' is an error that would only repeat (the note is too large,
 * the session ended), so it waits for the next edit or Ctrl/⌘ S instead of retrying in a loop.
 */
export type SaveStatus = 'saved' | 'pending' | 'saving' | 'offline' | 'conflict' | 'error' | 'failed';

const NO_RETRY = new Set([400, 401, 403, 413]);

interface Patch {
  title?: string;
  content?: string;
}

type Field = keyof Patch;
const FIELDS: Field[] = ['title', 'content'];

interface Entry {
  id: string;
  baseVersion: number;
  /**
   * The note's text at baseVersion, as far as this device knows it: what the edits here were made on.
   * Saves that change nothing from it aren't sent, and changes saved elsewhere since are merged from it.
   */
  base: Patch;
  /** Fingerprints of the base, when only those survived (a draft too large to keep the base's text). */
  basePrint: SentPrint | null;
  pending: Patch | null;
  /** What the save in flight is sending: until it's confirmed, drafts keep it too. */
  sending: Patch | null;
  /** The id the save in flight was sent under. */
  sendingId: string | null;
  /**
   * Saves that may have reached the server although no reply came back (connection dropped, server
   * error), with the id each was sent under.
   */
  unconfirmed: Array<{ id: string; patch: Patch }>;
  /**
   * Ids and fingerprints of saves sent and not yet confirmed, this session or (through the draft) an
   * earlier one: the page may have closed while one was on its way, and it landed.
   */
  sentPrints: SentPrint[];
  /** When the edits not yet saved were last changed (0: none since this device loaded the note). */
  editedAt: number;
  timer: ReturnType<typeof setTimeout> | null;
  inflight: Promise<void> | null;
  status: SaveStatus;
  conflict: Note | null;
  error: string | null;
  /** "Keep mine" was chosen in a conflict: saves are forced until one lands. */
  keepMine?: boolean;
}

const DRAFT_PREFIX = 'kb.draft.';
const SAVE_DELAY = 900;
/** A draft keeps the text its edits were made on up to this size; past it, only its fingerprint. */
const DRAFT_BASE_LIMIT = 200_000;
/**
 * Edits made here count as older than another device's version only when they're older by more than
 * this, so that a reply's journey or a busy device never decides it.
 */
const OLDER_MARGIN_MS = 2000;
const entries = new Map<string, Entry>();
const listeners = new Set<() => void>();
let retryTimer: ReturnType<typeof setTimeout> | null = null;

/** A note whose edits are stuck on this device: offline, failing, or waiting for a conflict choice. */
export interface Unsynced {
  id: string;
  status: SaveStatus;
}

const STUCK = new Set<SaveStatus>(['offline', 'error', 'failed', 'conflict']);
let unsynced: Unsynced[] = [];

function emit() {
  // A new array only when something changed, so components reading it re-render only then.
  const next = [...entries.values()].filter((e) => STUCK.has(e.status)).map((e) => ({ id: e.id, status: e.status }));
  if (next.length !== unsynced.length || next.some((u, i) => u.id !== unsynced[i].id || u.status !== unsynced[i].status)) unsynced = next;
  listeners.forEach((fn) => fn());
}

/**
 * A save that needs a decision, or won't go through, for a note that isn't open: nothing on screen
 * would show it otherwise, and its edits would wait unseen on this device.
 */
function tellIfInBackground(e: Entry, message: string) {
  const { noteId, notes } = useApp.getState();
  if (noteId === e.id) return;
  toast(`“${noteTitle(notes[e.id]?.title)}” ${message}`, {
    kind: 'error',
    timeout: 12_000,
    action: { label: 'Open', run: () => openNote(e.id) },
  });
}

function entry(id: string, baseVersion = 0): Entry {
  let e = entries.get(id);
  if (!e) {
    e = {
      id,
      baseVersion,
      base: {},
      basePrint: null,
      pending: null,
      sending: null,
      sendingId: null,
      unconfirmed: [],
      sentPrints: [],
      editedAt: 0,
      timer: null,
      inflight: null,
      status: 'saved',
      conflict: null,
      error: null,
    };
    entries.set(id, e);
  }
  return e;
}

function setStatus(e: Entry, status: SaveStatus) {
  e.status = status;
  emit();
}

interface Draft extends Patch {
  baseVersion: number;
  /** When these edits were last changed. */
  at: number;
  /** Saves sent but not confirmed when the draft was written (see Entry.sentPrints). */
  sent?: SentPrint[];
  /** The text the edits were made on (see Entry.base), when it isn't too large to keep. */
  base?: Patch;
  /** Its fingerprints, always (see Entry.basePrint). */
  basePrint?: SentPrint;
}

/**
 * A save's id (missing in drafts from before saves had ids) and a short fingerprint of what it sent.
 * In a draft, also what it sent when more was typed after it (so the draft's own text isn't that): if
 * the save landed, the next session knows what the newer version was built on.
 */
interface SentPrint {
  id?: string;
  t?: string;
  c?: string;
  text?: Patch;
}

/** A 53-bit hash (cyrb53) of a string, as base 36: enough to recognise text this device sent. */
function fingerprint(s: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

/** A field as the server keeps it: titles cleaned (one line, trimmed), text with "\n" line breaks. */
const norm = (f: Field, s: string) => (f === 'title' ? cleanTitle(s) : s.replace(/\r\n?/g, '\n'));
const same = (f: Field, a: string, b: string) => a === b || norm(f, a) === norm(f, b);
const printKey = (f: Field) => (f === 'title' ? 't' : 'c');
const printField = (f: Field, s: string) => fingerprint(norm(f, s));

const printOf = (p: Patch): SentPrint => ({
  ...(p.title !== undefined && { t: printField('title', p.title) }),
  ...(p.content !== undefined && { c: printField('content', p.content) }),
});

/** True if the saved note has every field the fingerprinted save sent. */
function holdsPrint(saved: Note, p: SentPrint): boolean {
  if (p.t === undefined && p.c === undefined) return false;
  return (p.t === undefined || p.t === printField('title', saved.title)) && (p.c === undefined || p.c === printField('content', saved.content));
}

const isPatch = (p: unknown): p is Patch =>
  !!p && typeof p === 'object' && FIELDS.every((k) => (p as Record<string, unknown>)[k] === undefined || typeof (p as Record<string, unknown>)[k] === 'string');

const isSentPrint = (p: unknown): p is SentPrint =>
  !!p &&
  typeof p === 'object' &&
  ['id', 't', 'c'].every((k) => (p as Record<string, unknown>)[k] === undefined || typeof (p as Record<string, unknown>)[k] === 'string') &&
  ((p as SentPrint).text === undefined || isPatch((p as SentPrint).text));

/** Fingerprints of a base, worked out once per base (a long note's are worth not redoing on every keystroke). */
const basePrints = new WeakMap<Patch, SentPrint>();
function basePrintOf(e: Entry): SentPrint | null {
  if (e.base.title === undefined && e.base.content === undefined) return e.basePrint;
  let p = basePrints.get(e.base);
  if (!p) {
    p = printOf(e.base);
    basePrints.set(e.base, p);
  }
  return p;
}

/** True if every field of `patch` (one at least) is as it was in the text the edits were made on. */
function unchangedFrom(patch: Patch, base: Patch, basePrint: SentPrint | null): boolean {
  let any = false;
  for (const f of FIELDS) {
    const value = patch[f];
    if (value === undefined) continue;
    any = true;
    const was = base[f];
    if (was !== undefined ? !same(f, value, was) : basePrint?.[printKey(f)] !== printField(f, value)) return false;
  }
  return any;
}

/*
 * Each tab keeps its own drafts: kb.draft.<note>~<tab>. A tab marks itself as open (kb.tab.<tab>,
 * refreshed while it's open) and other tabs leave an open tab's drafts alone. Taking them would send
 * its unsaved text from two places (false "changed on another device" prompts), and a save in one tab
 * would delete the other's copy. Drafts left by a tab that closed, crashed or was killed are taken by
 * the next tab to open the note. A tab keeps its id across reloads (session storage), so a page the
 * phone killed and reloaded gets its own drafts straight back.
 */
const TAB_PREFIX = 'kb.tab.';
/** Background tabs may refresh their mark only about once a minute. */
const TAB_OPEN_MS = 3 * 60_000;

let tabId = (() => {
  try {
    const known = sessionStorage.getItem('kb.tab-id');
    if (known) return known;
    const id = newId();
    sessionStorage.setItem('kb.tab-id', id);
    return id;
  } catch {
    return newId();
  }
})();

function markOpen() {
  try {
    localStorage.setItem(TAB_PREFIX + tabId, String(Date.now()));
  } catch {
    /* ignore */
  }
}

function tabOpen(owner: string): boolean {
  if (owner === tabId) return true;
  try {
    return Date.now() - Number(localStorage.getItem(TAB_PREFIX + owner) || 0) < TAB_OPEN_MS;
  } catch {
    return false;
  }
}

markOpen();
setInterval(markOpen, 20_000);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') markOpen();
});
window.addEventListener('pagehide', (e) => {
  if (e.persisted) return;
  try {
    localStorage.removeItem(TAB_PREFIX + tabId);
  } catch {
    /* ignore */
  }
});

// A tab that closes may leave edits it never got to send (offline, or its last save didn't make it):
// the tabs still open take them up, a moment after it says it's going (its own last save on its way
// gets there first, and is then recognised as already sent), and every few minutes for a tab that
// couldn't say so (crashed, killed), rather than only at the next start.
window.addEventListener('storage', (e) => {
  if (e.key?.startsWith(TAB_PREFIX) && e.key !== TAB_PREFIX + tabId && e.newValue === null) setTimeout(recoverDrafts, 1500);
});
setInterval(() => recoverDrafts(), TAB_OPEN_MS);

// "Duplicate tab" copies session storage, id included: the copy notices and takes a new id.
const tabsChannel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel('lumen-tabs');
const introducedAt = Date.now();
tabsChannel?.addEventListener('message', (e: MessageEvent) => {
  const msg = e.data as { hello?: string; taken?: string } | null;
  if (msg?.hello === tabId) tabsChannel.postMessage({ taken: tabId });
  else if (msg?.taken === tabId && Date.now() - introducedAt < 5_000) {
    tabId = newId();
    try {
      sessionStorage.setItem('kb.tab-id', tabId);
    } catch {
      /* ignore */
    }
    markOpen();
  }
});
tabsChannel?.postMessage({ hello: tabId });

const draftKey = (noteId: string) => `${DRAFT_PREFIX}${noteId}~${tabId}`;

function parseDraftKey(key: string | null): { noteId: string; owner: string | null } | null {
  if (!key?.startsWith(DRAFT_PREFIX)) return null;
  const rest = key.slice(DRAFT_PREFIX.length);
  const at = rest.indexOf('~');
  // Drafts saved before drafts had owners: anyone's to take.
  return at < 0 ? { noteId: rest, owner: null } : { noteId: rest.slice(0, at), owner: rest.slice(at + 1) };
}

function parseDraft(raw: string | null): Draft | null {
  try {
    const d = raw ? (JSON.parse(raw) as Draft) : null;
    return d && typeof d === 'object' ? d : null;
  } catch {
    return null; // sealed while this device is locked
  }
}

/** Drafts of a note this tab may use: its own first, then those left by closed tabs, newest first. */
function usableDrafts(noteId: string): Array<{ key: string; draft: Draft; mine: boolean }> {
  const out: Array<{ key: string; draft: Draft; mine: boolean }> = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      const p = parseDraftKey(key);
      if (!p || p.noteId !== noteId) continue;
      // Another tab that's still open: its drafts are its own.
      if (p.owner !== null && p.owner !== tabId && tabOpen(p.owner)) continue;
      const draft = parseDraft(localStorage.getItem(key!));
      if (draft) out.push({ key: key!, draft, mine: p.owner === tabId });
    }
  } catch {
    /* ignore */
  }
  return out.sort((a, b) => Number(b.mine) - Number(a.mine) || (b.draft.at ?? 0) - (a.draft.at ?? 0));
}

/** This tab's draft of a note, taking over one left by a closed tab if it has none. */
function takeDraft(noteId: string): Draft | null {
  const [best, ...rest] = usableDrafts(noteId);
  if (!best) return null;
  try {
    if (!best.mine) {
      localStorage.setItem(draftKey(noteId), JSON.stringify(best.draft));
      localStorage.removeItem(best.key);
    }
    // Older copies left by other closed tabs: superseded.
    for (const r of rest) localStorage.removeItem(r.key);
  } catch {
    /* the in-memory copy still works */
  }
  return best.draft;
}

/** Removes this note's drafts that aren't an open tab's (this tab's included). */
function dropDrafts(noteId: string) {
  try {
    for (const { key } of usableDrafts(noteId)) localStorage.removeItem(key);
    localStorage.removeItem(draftKey(noteId));
  } catch {
    /* ignore */
  }
}

/** What a draft says its edits were made on, and the saves it may already have sent, put into an entry. */
function resumeDraft(e: Entry, draft: Draft) {
  e.pending = { title: draft.title, content: draft.content };
  e.baseVersion = draft.baseVersion;
  e.base = isPatch(draft.base) ? { title: draft.base.title, content: draft.base.content } : {};
  e.basePrint = isSentPrint(draft.basePrint) ? draft.basePrint : null;
  const sent = Array.isArray(draft.sent) ? draft.sent.filter(isSentPrint).slice(-5) : [];
  e.sentPrints = sent.map(({ text: _t, ...p }) => p);
  // Saves whose text the draft kept: they may have landed.
  e.unconfirmed = sent.filter((p) => p.id && p.text).map((p) => ({ id: p.id!, patch: { title: p.text!.title, content: p.text!.content } }));
  e.editedAt = typeof draft.at === 'number' ? draft.at : 0;
}

/** A draft whose edits change nothing from the text they were made on (typed and undone, say). */
function draftChangesNothing(draft: Draft): boolean {
  const base = isPatch(draft.base) ? draft.base : {};
  const print = isSentPrint(draft.basePrint) ? draft.basePrint : null;
  return unchangedFrom({ title: draft.title, content: draft.content }, base, print);
}

let warnedStorageFull = false;

function isQuotaError(err: unknown): boolean {
  return err instanceof DOMException && (err.name === 'QuotaExceededError' || err.name === 'NS_ERROR_DOM_QUOTA_REACHED' || err.code === 22);
}

/**
 * The device is locking: drafts are written out one last time, then left alone (and nothing more is
 * sent) so the vault can encrypt them. Otherwise a save failing, or the flush when the page unloads,
 * could write a draft back in plain text after it was encrypted. The page reloads next.
 */
let frozen = false;
export function freezeDrafts() {
  for (const e of entries.values()) {
    if (e.timer) {
      clearTimeout(e.timer);
      e.timer = null;
    }
    writeDraft(e);
  }
  frozen = true;
}

function writeDraft(e: Entry) {
  if (frozen) return;
  // An edit made while a save is in flight must not leave a draft without the text being sent: if
  // the page closes before that save is confirmed, the draft is all that's left of it.
  const unsaved = e.sending || e.pending ? { ...e.sending, ...e.pending } : null;
  const key = draftKey(e.id);
  const sizeOf = (p: Patch) => (p.title?.length ?? 0) + (p.content?.length ?? 0);
  const draft = (withText: boolean): string => {
    const print = basePrintOf(e);
    const base = withText && sizeOf(e.base) > 0 && sizeOf(e.base) <= DRAFT_BASE_LIMIT ? e.base : null;
    // What each save that may land sent, when more was typed after it (see SentPrint).
    const sent = e.sentPrints.map((p) => {
      const text = !withText || !p.id ? undefined : p.id === e.sendingId ? e.sending : e.unconfirmed.find((u) => u.id === p.id)?.patch;
      const differs = text && unsaved && FIELDS.some((f) => text[f] !== undefined && text[f] !== unsaved[f]);
      return differs && sizeOf(text) <= DRAFT_BASE_LIMIT ? { ...p, text } : p;
    });
    return JSON.stringify({
      ...unsaved,
      baseVersion: e.baseVersion,
      at: e.editedAt || Date.now(),
      ...(sent.length ? { sent } : {}),
      ...(base ? { base } : {}),
      ...(print ? { basePrint: print } : {}),
    } satisfies Draft);
  };
  try {
    if (unsaved) localStorage.setItem(key, draft(true));
    else localStorage.removeItem(key);
  } catch (err) {
    if (!unsaved || !isQuotaError(err)) return; // private mode: the in-memory copy still exists
    // Storage is full. The text the edits were made on goes first (its fingerprint stays), then the
    // drawing editor's crash copy (the largest thing kept there): a note's unsaved text matters more.
    // If that's not enough, say so once.
    for (const makeRoom of [() => undefined, () => localStorage.removeItem('kb.drawing-backup')]) {
      try {
        makeRoom();
        localStorage.setItem(key, draft(false));
        return;
      } catch {
        /* still full */
      }
    }
    if (!warnedStorageFull) {
      warnedStorageFull = true;
      toast(
        'This browser’s storage is full, so unsaved edits aren’t being kept on this device. They still save to the server while you’re online.',
        { kind: 'error', timeout: 15_000 },
      );
    }
  }
}

/** The draft this tab would use for a note (its own, or one a closed tab left), without taking it. */
export function readDraft(id: string): Draft | null {
  return usableDrafts(id)[0]?.draft ?? null;
}

/** Nothing of the note's on its way, waiting, or possibly landed without a reply. */
const idle = (e: Entry) => !e.pending && !e.sending && !e.inflight && !e.unconfirmed.length && e.status !== 'conflict';

/** Register a freshly loaded note. Returns the content to show (a local draft wins). */
export function track(note: Note): { title: string; content: string; fromDraft: boolean } {
  const e = entry(note.id, note.version);
  const unsaved = e.sending || e.pending ? { ...e.sending, ...e.pending } : null;
  if (unsaved) return { title: unsaved.title ?? note.title, content: unsaved.content ?? note.content, fromDraft: true };
  const draft = takeDraft(note.id);
  if (draft && (draft.content !== undefined || draft.title !== undefined)) {
    const differs =
      (draft.content !== undefined && draft.content !== note.content) || (draft.title !== undefined && draft.title !== note.title);
    // A draft that changes nothing from what it was made on isn't an edit, however old that text is.
    if (differs && !draftChangesNothing(draft)) {
      resumeDraft(e, draft);
      // Made on the version shown: that's the text it was made on, if the draft didn't keep it.
      if (note.version === draft.baseVersion) e.base = { title: e.base.title ?? note.title, content: e.base.content ?? note.content };
      setStatus(e, 'pending');
      schedule(e, 50);
      return { title: draft.title ?? note.title, content: draft.content ?? note.content, fromDraft: true };
    }
    try {
      localStorage.removeItem(draftKey(note.id));
    } catch {
      /* ignore */
    }
  }
  if (idle(e)) {
    e.baseVersion = note.version;
    e.base = { title: note.title, content: note.content };
    e.basePrint = null;
  }
  return { title: note.title, content: note.content, fromDraft: false };
}

/**
 * An edit. A change made from outside the editor names the version its text came from (and that text,
 * when it's known): with nothing of this note's unsaved here, that's what it's saved on top of, so a
 * newer text elsewhere is merged or conflicts instead of being overwritten, and an older remembered base
 * doesn't cause a false conflict.
 */
export function edit(id: string, patch: Patch, baseVersion?: number, baseText?: Patch) {
  const e = entry(id, baseVersion);
  if (baseVersion && idle(e)) {
    if (baseText) e.base = { ...baseText };
    else if (baseVersion !== e.baseVersion) e.base = {};
    if (baseText || baseVersion !== e.baseVersion) e.basePrint = null;
    e.baseVersion = baseVersion;
  }
  e.pending = { ...e.pending, ...patch };
  e.editedAt = Date.now();
  writeDraft(e);
  if (e.status !== 'conflict') setStatus(e, 'pending');
  schedule(e, SAVE_DELAY);
}

function schedule(e: Entry, delay: number) {
  if (e.status === 'conflict') return;
  if (e.timer) clearTimeout(e.timer);
  e.timer = setTimeout(() => {
    e.timer = null;
    void flush(e.id);
  }, delay);
}

export async function flush(id: string, opts: { force?: boolean; keepalive?: boolean } = {}): Promise<void> {
  const e = entries.get(id);
  if (!e || frozen) return;
  if (e.timer) {
    clearTimeout(e.timer);
    e.timer = null;
  }
  while (e.inflight) await e.inflight;
  if (!e.pending || frozen) return;
  // "Keep mine" holds until it's saved: retried after a dropped connection, it's still forced, not
  // turned back into a question about a conflict already answered.
  if (e.keepMine) opts = { ...opts, force: true };
  if (e.status === 'conflict' && !opts.force) return;
  if (Date.now() < pausedUntil) {
    // Today's allowance is used up (pauseUntilReset): kept in the draft, sent once it resets.
    e.error = pausedReason;
    setStatus(e, 'error');
    return;
  }
  // Nothing differs from the text the edits were made on (typed and undone, a box ticked and unticked),
  // and no earlier save of it may have landed: there's nothing to send. Sending it anyway would meet
  // any newer version from another device as a "conflict" (and, encrypted, make a new version of the
  // same text, since the server can't compare it).
  if (!opts.force && !e.sentPrints.length && unchangedFrom(e.pending, e.base, basePrintOf(e))) {
    e.pending = null;
    writeDraft(e);
    setStatus(e, 'saved');
    return;
  }

  const sending = e.pending;
  const base = e.baseVersion;
  const saveId = newId(12);
  e.pending = null;
  e.sending = sending;
  e.sendingId = saveId;
  e.sentPrints = [...e.sentPrints, { id: saveId, ...printOf(sending) }].slice(-5);
  // On disk before it goes: if the page is closed or killed before the reply (a phone locking), the
  // next session knows this save may have landed, and can tell from the server whether it did.
  writeDraft(e);
  setStatus(e, 'saving');
  const run = (async () => {
    try {
      const meta = await api.updateNote(
        id,
        { ...sending, baseVersion: e.baseVersion, saveId, force: opts.force || undefined },
        { keepalive: opts.keepalive },
      );
      // Deleted for good meanwhile, or signed out in another tab: this note's edits were dropped, and
      // the reply mustn't put the note back in the list or a draft back in storage.
      if (entries.get(id) !== e) return;
      e.sending = null;
      e.sendingId = null;
      e.unconfirmed = [];
      e.sentPrints = [];
      e.baseVersion = meta.version;
      // The server now has what was sent, on top of the text it was made on.
      e.base = {
        title: sending.title !== undefined ? cleanTitle(sending.title) : (e.base.title ?? meta.title),
        content: sending.content ?? e.base.content,
      };
      e.basePrint = null;
      e.conflict = null;
      e.error = null;
      refreshOfflineCopy(id);
      // Moved to the trash on another device: the edits were saved, but into a note in the trash.
      const before = useApp.getState().notes[id];
      if (meta.deleted_at && before && !before.deleted_at) {
        toast(`“${noteTitle(meta.title)}” was moved to the trash on another device. Your edits were saved in it.`, {
          timeout: 12_000,
          action: { label: 'Restore', run: () => void restoreNote(id) },
        });
      }
      // The cached text is the one this save was built on (if it's at the version saved on top of):
      // read it before upsertMeta drops it for its older version, then store it as the saved one. A
      // cache older than that would pair its title or text with the new version.
      const cached = noteCache.get(id);
      upsertMeta(meta);
      if (cached && cached.version === base) {
        noteCache.set(id, {
          ...cached,
          ...meta,
          title: sending.title ?? cached.title,
          content: sending.content ?? cached.content,
        });
      }
      savedListeners.forEach((fn) => fn(id, meta.version, sending.content, base));
      failedRounds = 0;
      e.keepMine = false;
      writeDraft(e);
      setStatus(e, e.pending ? 'pending' : 'saved');
      if (e.pending) schedule(e, SAVE_DELAY);
    } catch (err) {
      // Deleted for good meanwhile, or signed out in another tab: nothing to keep or rescue.
      if (entries.get(id) !== e) return;
      e.sending = null;
      e.sendingId = null;
      e.pending = { ...sending, ...e.pending };
      // A refusal (4xx) means it wasn't saved; anything else may have been, with the reply lost.
      const refused = err instanceof ApiError && err.status >= 400 && err.status < 500;
      if (!refused) e.unconfirmed = [...e.unconfirmed, { id: saveId, patch: sending }].slice(-5);
      writeDraft(e);
      let failure: unknown = err;
      // Only the server's own "note not found", not any 404 (an unknown route, a proxy page).
      if (err instanceof ApiError && err.status === 404 && err.code === 'not_found') {
        try {
          await rescueDeleted(e);
          return;
        } catch (rescueErr) {
          failure = rescueErr;
        }
      }
      if (failure instanceof NetworkError) {
        setStatus(e, 'offline');
        scheduleRetry();
      } else if (failure instanceof ApiError && failure.status === 409 && failure.code === 'conflict') {
        const info = (failure.data ?? {}) as ConflictInfo;
        const saved = info.note ?? null;
        if (saved && (await settleWith(e, saved, info))) return;
        if (entries.get(id) !== e) return;
        e.conflict = saved;
        setStatus(e, 'conflict');
        tellIfInBackground(e, 'was changed on another device. Open it to choose which version to keep.');
      } else if (failure instanceof ApiError && failure.code === 'quota_exceeded') {
        e.error = failure.message;
        setStatus(e, 'error');
        pauseUntilReset(failure);
      } else {
        e.error = failure instanceof Error ? failure.message : 'Save failed';
        if (failure instanceof ApiError && NO_RETRY.has(failure.status)) {
          setStatus(e, 'failed');
          // A session that ended has its own banner; anything else is about this note.
          if (failure.status !== 401 && failure.status !== 403) tellIfInBackground(e, `couldn’t be saved: ${e.error}`);
        } else {
          setStatus(e, 'error');
          scheduleBackoff();
        }
      }
    }
  })();
  e.inflight = run;
  try {
    await run;
  } finally {
    e.inflight = null;
  }
}

/**
 * The text each field of the edits here was changed from, as far as the server's version goes: the
 * text they were made on, or, when one of this device's saves landed without it hearing back (and the
 * newer version was built on it), what that save sent.
 */
function startingText(e: Entry, theirs: Note, saves: string[]): Patch {
  const from: Patch = { ...e.base };
  // Oldest first, so a later save that landed counts over an earlier one, field by field.
  for (const p of e.sentPrints) {
    // Listed by the server as part of the note's text; or (from a server that doesn't list saves, or a
    // draft from before saves had ids) exactly what the note holds now.
    if (!(p.id && saves.includes(p.id)) && !holdsPrint(theirs, p)) continue;
    const sent = e.unconfirmed.find((u) => u.id === p.id)?.patch;
    for (const f of FIELDS) {
      const print = p[printKey(f)];
      if (print === undefined) continue;
      const mine = e.pending?.[f];
      if (sent?.[f] !== undefined) from[f] = sent[f];
      else if (print === printField(f, theirs[f])) from[f] = theirs[f];
      // Nothing typed here since that save: what's here is already in the newer version's history.
      else if (mine !== undefined && print === printField(f, mine)) from[f] = mine;
      // Otherwise only its fingerprint is known: merge from the text the edits were made on.
    }
  }
  return from;
}

/**
 * A save refused because the note is at a newer version (`theirs`), saved on another device or by an
 * earlier save of this one. Settles it without asking when that's safe (see the top of this file).
 * False when it's the person's choice.
 */
async function settleWith(e: Entry, theirs: Note, info: ConflictInfo): Promise<boolean> {
  const mine = e.pending ?? {};
  const from = startingText(e, theirs, Array.isArray(info.saves) ? info.saves : []);
  const rest: Patch = {};
  let combinable = true;
  for (const f of FIELDS) {
    const value = mine[f];
    if (value === undefined || same(f, value, theirs[f])) continue;
    const was = from[f];
    // Nothing changed here: the newer version stands.
    if (was === undefined ? e.basePrint?.[printKey(f)] === printField(f, value) : same(f, value, was)) continue;
    if (was === undefined) {
      combinable = false;
      break;
    }
    // Changed only here.
    if (same(f, theirs[f], was)) {
      rest[f] = value;
      continue;
    }
    const merged = f === 'content' ? merge3(norm(f, was), norm(f, value), norm(f, theirs[f])) : null;
    if (merged === null) {
      combinable = false;
      break;
    }
    if (merged !== norm(f, theirs[f])) rest[f] = merged;
  }
  if (combinable) {
    // Something of each device's in the result: say so, as the note just changed under the person's eyes.
    const theirsChanged = FIELDS.some((f) => from[f] !== undefined && !same(f, theirs[f], from[f]!));
    adopt(e, theirs, rest);
    if (e.pending && theirsChanged) {
      toast(`“${noteTitle(e.pending.title ?? theirs.title)}” was also changed on another device. Both sets of changes are kept.`, { timeout: 8000 });
    }
    return true;
  }
  if (olderHere(e, theirs, info.now)) return keepNewer(e, theirs);
  return false;
}

/** The newer version is the note's text now, with `rest` (what's still different here) to be saved on top. */
function adopt(e: Entry, theirs: Note, rest: Patch) {
  e.baseVersion = theirs.version;
  e.base = { title: theirs.title, content: theirs.content };
  e.basePrint = null;
  e.unconfirmed = [];
  e.sentPrints = [];
  e.conflict = null;
  const { content: _content, ...meta } = theirs;
  upsertMeta(meta);
  noteCache.set(e.id, theirs);
  e.pending = rest.title !== undefined || rest.content !== undefined ? rest : null;
  writeDraft(e);
  setStatus(e, e.pending ? 'pending' : 'saved');
  const shown = { title: rest.title ?? theirs.title, content: rest.content ?? theirs.content };
  replacedListeners.forEach((fn) => fn(e.id, shown));
  if (e.pending) schedule(e, 50);
  else refreshOfflineCopy(e.id);
}

/**
 * Whether the edits here were made before the other device saved its version. Each age is measured
 * on one clock (the server's for theirs, this device's for these), so a device whose clock is off
 * doesn't change the answer.
 */
function olderHere(e: Entry, theirs: Note, serverNow: number | undefined): boolean {
  if (!e.editedAt) return false;
  const theirsAge = (typeof serverNow === 'number' ? serverNow : Date.now()) - theirs.updated_at;
  return Date.now() - e.editedAt > theirsAge + OLDER_MARGIN_MS;
}

/**
 * Edits here that can't be combined with a version another device saved after them: that newer
 * version stays, as it would when picking up on one device where another left off. The edits from
 * here are kept in the note's history first; if that can't be done, or more is typed meanwhile, the
 * choice is the person's after all.
 */
async function keepNewer(e: Entry, theirs: Note): Promise<boolean> {
  const editedAt = e.editedAt;
  const mine = e.pending ?? {};
  const kept = { title: mine.title ?? e.base.title ?? theirs.title, content: mine.content ?? e.base.content ?? theirs.content };
  try {
    await api.keepVersion(e.id, kept, editedAt);
  } catch {
    return false;
  }
  if (entries.get(e.id) !== e || e.editedAt !== editedAt) return false;
  adopt(e, theirs, {});
  toast(
    `“${noteTitle(theirs.title)}” was changed on another device after your edits here, so it shows that newer version. Your edits are kept in its version history.`,
    {
      timeout: 12_000,
      action: {
        label: 'Version history',
        run: () => {
          if (useApp.getState().noteId !== e.id) openNote(e.id);
          useApp.setState({ historyFor: e.id });
        },
      },
    },
  );
  return true;
}

const replacedListeners = new Set<(id: string, text: { title: string; content: string }) => void>();

/**
 * The text to show for a note after a refused save was settled without asking: another device's newer
 * version, or that with the edits made here combined in. The note's view shows it in place.
 */
export function onTextReplaced(fn: (id: string, text: { title: string; content: string }) => void): () => void {
  replacedListeners.add(fn);
  return () => {
    replacedListeners.delete(fn);
  };
}

const refreshTimers = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * The service worker keeps the copy of each note it last fetched, for reading offline. Saving doesn't
 * change that copy, so after a burst of saves the note is fetched once more to bring it up to date;
 * otherwise reopening it offline (say, after the phone closed the tab) would show the text from
 * before this session's edits, and edits made on top of that would conflict with them.
 */
function refreshOfflineCopy(id: string) {
  if (!navigator.serviceWorker?.controller) return;
  clearTimeout(refreshTimers.get(id));
  refreshTimers.set(
    id,
    setTimeout(() => {
      refreshTimers.delete(id);
      void fetch(`/api/notes/${encodeURIComponent(id)}`, { credentials: 'same-origin', redirect: 'manual' })
        .then((res) => res.arrayBuffer())
        .catch(() => undefined);
    }, 4000),
  );
}

/**
 * The note was deleted for good on another device (or its trash was emptied) while this device
 * still had edits for it. Rather than retry forever or drop them, save them as a new note.
 */
async function rescueDeleted(e: Entry) {
  const lost = e.pending;
  const cached = noteCache.get(e.id);
  const title = lost?.title ?? cached?.title ?? '';
  const content = lost?.content ?? cached?.content ?? '';
  if (title.trim() || content.trim()) {
    const { folders } = useApp.getState();
    const folderId = cached?.folder_id && folders.some((f) => f.id === cached.folder_id) ? cached.folder_id : null;
    // Under an id of its own made from the deleted note's: a reply lost on the way (the 404 comes back
    // on the retry, and so does this) or a page closed meanwhile finds this copy instead of a second.
    const meta = await api.createNoteOnce({ id: idFor(e.id, 'kept'), title, content, folder_id: folderId, tags: cached?.tags ?? [] });
    upsertMeta(meta);
    noteCache.set(meta.id, { ...meta, content });
    // Anything typed while the copy was being made goes to the copy as well.
    if (e.pending && e.pending !== lost) edit(meta.id, e.pending, meta.version, { title: meta.title, content });
    const viewing = useApp.getState().noteId === e.id;
    if (viewing) {
      // They were just editing it, so the copy opens ready to type in.
      preferredMode.set(meta.id, 'edit');
      openNote(meta.id, { replace: true });
    }
    toast('This note was deleted on another device, so your edits here were saved as a new note.', {
      timeout: 9000,
      ...(viewing ? {} : { action: { label: 'Open', run: () => openNote(meta.id) } }),
    });
  }
  // Nothing more should be sent for the deleted note, including by a flush already waiting its turn.
  e.pending = null;
  forget(e.id);
  removeMeta(e.id);
}

function scheduleRetry(delay = 10_000) {
  if (retryTimer) return;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    void flushAll();
  }, delay);
}

/**
 * Saves the server keeps failing (a 5xx, a refusal that isn't about the note) are tried again each
 * round twice as long after the last, from 20 seconds up to 15 minutes; a save that lands starts the
 * count again. Every 20 seconds for good was some 4,300 requests a day for each such note, out of the
 * free plan's 100,000.
 */
const RETRY_FIRST = 20_000;
const RETRY_LONGEST = 15 * 60_000;
let failedRounds = 0;
function scheduleBackoff() {
  if (retryTimer) return;
  scheduleRetry(Math.min(RETRY_LONGEST, RETRY_FIRST * 2 ** Math.min(failedRounds++, 6)));
}

/**
 * Until when nothing is sent: one of Cloudflare's free daily allowances is used up (requests, D1 rows,
 * KV writes), and every try before it resets at 00:00 UTC would fail too. The edits wait in the drafts;
 * the person is told once. A minute's spread after midnight, so devices don't all come back at once.
 */
let pausedUntil = 0;
let pausedReason = '';
function pauseUntilReset(err: ApiError) {
  const resetAt = (err.data as { resetAt?: number } | undefined)?.resetAt ?? Date.now() + 3_600_000;
  const until = resetAt + Math.round(Math.random() * 60_000);
  const told = pausedUntil > Date.now();
  pausedUntil = until;
  pausedReason = err.message;
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = setTimeout(() => {
    retryTimer = null;
    pausedUntil = 0;
    void flushAll();
  }, until - Date.now());
  if (!told) toast(err.message, { kind: 'error', timeout: 0 });
}

export async function flushAll(opts: { keepalive?: boolean } = {}) {
  // Conflicts wait for a choice, and 'failed' saves for the next edit or Ctrl/⌘ S: resending them
  // in the background would only fail the same way.
  await Promise.all(
    [...entries.values()]
      .filter((e) => e.pending && e.status !== 'conflict' && e.status !== 'failed')
      .map((e) => flush(e.id, opts)),
  );
}

/**
 * Push any drafts left over from a previous session (e.g. written offline): this tab's own, and those
 * of tabs that are no longer open. Another open tab's drafts are its own to send.
 */
export function recoverDrafts() {
  // Signing out or locking: drafts are being cleared or encrypted, not taken up.
  if (frozen) return;
  const notes = new Set<string>();
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      const p = parseDraftKey(key);
      if (p) notes.add(p.noteId);
      // Marks of tabs gone for over a day: tidied away.
      else if (key?.startsWith(TAB_PREFIX) && Date.now() - Number(localStorage.getItem(key) || 0) > 86_400_000) {
        localStorage.removeItem(key);
        i--;
      }
    }
  } catch {
    /* ignore */
  }
  for (const id of notes) {
    if (entries.has(id)) continue;
    const draft = takeDraft(id);
    if (!draft || (draft.title === undefined && draft.content === undefined)) continue;
    // Changes nothing from the text it was made on, and no save of it may have landed: nothing to send.
    if (!draft.sent?.length && draftChangesNothing(draft)) {
      dropDrafts(id);
      continue;
    }
    const e = entry(id, draft.baseVersion);
    resumeDraft(e, draft);
    e.status = 'pending';
    schedule(e, 1500);
  }
}

/**
 * Resolve a conflict: keep the local text (overwrite) or take the saved one. Keeping it sends `shown`,
 * the whole note as this device shows it, not only the fields edited here: otherwise a title kept
 * from here would be mixed with a body changed elsewhere that this device never displayed. (The
 * server keeps the version it replaces in the note's history.)
 *
 * Taking theirs keeps this device's text in the note's history first (as keeping mine keeps theirs),
 * so a slip of the finger loses nothing; if that can't be done (offline), nothing changes and null is
 * returned. `keepMine: false` skips it, for "Keep both", which has just saved this text as its own note.
 */
export async function resolveConflict(id: string, choice: 'mine' | 'theirs', shown?: Patch, opts: { keepMine?: boolean } = {}): Promise<Note | null> {
  const e = entries.get(id);
  if (!e) return null;
  const theirs = e.conflict;
  if (choice === 'mine') {
    if (shown) e.pending = { ...e.pending, ...shown };
    e.status = 'pending';
    e.keepMine = true;
    await flush(id, { force: true });
    return null;
  }
  const mine = { ...e.base, ...e.sending, ...e.pending };
  const differs = FIELDS.some((f) => mine[f] !== undefined && mine[f] !== (theirs ? theirs[f] : undefined));
  if (opts.keepMine !== false && (e.pending || e.sending) && differs) {
    try {
      await api.keepVersion(id, { title: mine.title ?? theirs?.title ?? '', content: mine.content ?? theirs?.content ?? '' }, e.editedAt || Date.now());
    } catch (err) {
      toast(`Your version couldn’t be kept in the note’s history, so nothing was changed: ${err instanceof Error ? err.message : 'try again.'}`, {
        kind: 'error',
      });
      return null;
    }
    // Discarded meanwhile (signed out in another tab): nothing more to do here.
    if (entries.get(id) !== e) return null;
  }
  e.keepMine = false;
  e.pending = null;
  e.conflict = null;
  e.unconfirmed = [];
  e.sentPrints = [];
  if (theirs) {
    e.baseVersion = theirs.version;
    e.base = { title: theirs.title, content: theirs.content };
    e.basePrint = null;
    noteCache.set(id, theirs);
    upsertMeta(theirs);
  }
  writeDraft(e);
  setStatus(e, 'saved');
  return theirs;
}

export function pendingText(id: string): Patch | null {
  return entries.get(id)?.pending ?? null;
}

/** Everything of the note not yet confirmed saved: the save on its way, with later edits on top. */
export function unsavedPatch(id: string): Patch | null {
  const e = entries.get(id);
  return e && (e.sending || e.pending) ? { ...e.sending, ...e.pending } : null;
}

const savedListeners = new Set<(id: string, version: number, content: string | undefined, base: number) => void>();

/** Each confirmed save: the note's new version, its text if the save changed it, and the version it was saved on top of. */
export function onNoteSaved(fn: (id: string, version: number, content: string | undefined, base: number) => void) {
  savedListeners.add(fn);
  return () => savedListeners.delete(fn);
}

export function conflictOf(id: string): Note | null {
  return entries.get(id)?.conflict ?? null;
}

export function statusOf(id: string): SaveStatus {
  return entries.get(id)?.status ?? 'saved';
}

/** Why the last save failed, in words for the person. */
export function errorOf(id: string): string | null {
  return entries.get(id)?.error ?? null;
}

/** Signing out (here or in another tab): stop saving anything from this one (its drafts are being deleted). */
export function discardAll() {
  for (const e of entries.values()) if (e.timer) clearTimeout(e.timer);
  entries.clear();
  // A save already on its way mustn't write its draft back into the storage being cleared.
  frozen = true;
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = null;
  // Nor may a note be fetched again into the offline copies being deleted.
  for (const t of refreshTimers.values()) clearTimeout(t);
  refreshTimers.clear();
  emit();
}

/** Drop any queued edits and the local draft for a note (used when a note is deleted). */
export function forget(id: string) {
  const e = entries.get(id);
  if (e?.timer) clearTimeout(e.timer);
  entries.delete(id);
  dropDrafts(id);
  emit();
}

/** The server version this device last synced for the note. */
export function baseVersionOf(id: string): number {
  return entries.get(id)?.baseVersion ?? 0;
}

export function hasUnsaved(): boolean {
  for (const e of entries.values()) if (e.pending || e.inflight) return true;
  return false;
}

function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Notes with edits stuck on this device (see Unsynced), for the "not synced" marker. */
export function useUnsynced(): Unsynced[] {
  return useSyncExternalStore(subscribe, () => unsynced);
}

export function useSaveStatus(id: string | null): SaveStatus {
  return useSyncExternalStore(subscribe, () => (id ? entries.get(id)?.status ?? 'saved' : 'saved'));
}

window.addEventListener('online', () => void flushAll());
onReachabilityChange((reachable) => {
  if (reachable) void flushAll();
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') void flushAll({ keepalive: true });
});
// Drafts are already in localStorage, so leaving the page never loses text;
// this just gets them to the server sooner.
window.addEventListener('pagehide', () => {
  if (hasUnsaved()) void flushAll({ keepalive: true });
});
