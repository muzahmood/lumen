import { cleanTitle } from '../../shared/noteText';
import type { RawNote } from './localStore';
import type { ParsedQuery } from './searchQuery';
import { newId } from './utils';
import type {
  Backlink,
  Bootstrap,
  DrawingInfo,
  FileInfo,
  Folder,
  Keyring,
  KeyringData,
  Me,
  Note,
  NoteMeta,
  SearchHit,
  Sealed,
  StoredSettings,
  Version,
  VersionInfo,
} from './types';

export type NotePatch = Partial<Pick<Note, 'title' | 'content' | 'folder_id' | 'tags' | 'pinned'>> & {
  baseVersion?: number;
  force?: boolean;
  snapshot?: boolean;
  /** Names the save, so the server can later say whether it landed (a 409's `saves`). */
  saveId?: string;
};

/** What a 409 conflict carries besides the note: the saves its text includes, and the server's clock. */
export interface ConflictInfo {
  note?: Note;
  saves?: string[];
  now?: number;
}

export type NewNote = Partial<Note> & { restore?: boolean };

/**
 * End-to-end encryption, while this device holds the key (see e2ee.ts): encrypts what's sent and
 * decrypts what comes back, so the rest of the app only ever sees plaintext. Search, backlinks and
 * finding which files notes use need every note's text, so with encryption on they run here too.
 */
export interface Codec {
  openMeta(meta: NoteMeta): Promise<NoteMeta>;
  openNote(note: Note): Promise<Note>;
  openFolder(folder: Folder): Promise<Folder>;
  openVersionInfo(noteId: string, info: VersionInfo): Promise<VersionInfo>;
  /** Decrypts a history snapshot as one of `noteId`'s. */
  openVersion(version: Version, noteId: string): Promise<Version>;
  sealNew(data: NewNote): Promise<Record<string, unknown>>;
  sealPatch(id: string, patch: NotePatch): Promise<Record<string, unknown>>;
  sealFolder(id: string, data: Partial<Folder>): Promise<Record<string, unknown>>;
  /** The synced settings (JSON) encrypted; and back, or null if they can't be decrypted. */
  sealSettings(json: string): Promise<string>;
  openSettings(cipher: string): Promise<string | null>;
  /** Searches the text on this device, keeping only notes `keep` passes (see search.ts). */
  search(query: ParsedQuery, limit: number, signal?: AbortSignal, keep?: (meta: NoteMeta) => boolean): Promise<SearchHit[]>;
  backlinks(id: string): Promise<Backlink[]>;
  referencedFiles(): Promise<string[]>;
  /** A file encrypted under a key of its own; `sealed` is that key with the name and type, wrapped. */
  sealFile(id: string, bytes: Uint8Array, meta: { name: string; mime: string }): Promise<{ body: Uint8Array; sealed: string }>;
  openFile(id: string, sealed: string, body: Uint8Array): Promise<{ bytes: Uint8Array; name: string; mime: string }>;
  /** An encrypted file's name and type, or null if they can't be decrypted. */
  openFileMeta(id: string, sealed: string): Promise<{ name: string; mime: string } | null>;
  /** A drawing revision's two parts, encrypted under a key of its own; `sealed` is that key, wrapped. */
  sealDrawing(id: string, parts: { scene: string; svg: string }): Promise<{ scene: Uint8Array; svg: Uint8Array; sealed: string }>;
  openDrawing(id: string, part: 'scene' | 'svg', sealed: string, body: Uint8Array): Promise<string>;
}

/**
 * Whether this device knows every upload and drawing is encrypted: encryption on, nothing of theirs
 * left in plaintext. From then on an unencrypted file or drawing wasn't stored by Lumen, so it isn't
 * shown (as with notes, see libraryEncrypted). Cleared only by signing out of the device.
 */
const ATTACHMENTS_KEY = 'kb.vault.attachments';
let sealedAttachments = false;

export function attachmentsEncrypted(): boolean {
  if (sealedAttachments) return true;
  try {
    sealedAttachments = localStorage.getItem(ATTACHMENTS_KEY) === '1';
  } catch {
    /* no storage */
  }
  return sealedAttachments;
}

/** Fired once, when this device first learns every attachment is encrypted (to drop plaintext copies kept for offline use). */
const attachmentsListeners = new Set<() => void>();
export function onAttachmentsEncrypted(fn: () => void) {
  attachmentsListeners.add(fn);
  return () => attachmentsListeners.delete(fn);
}

function rememberAttachments(data: Bootstrap) {
  const a = data.encryption?.attachments;
  if (!data.encryption?.on || !a || a.files || a.drawings || attachmentsEncrypted()) return;
  sealedAttachments = true;
  try {
    localStorage.setItem(ATTACHMENTS_KEY, '1');
  } catch {
    /* ignore */
  }
  attachmentsListeners.forEach((fn) => fn());
}

const LOCKED_FILE = 'Unlock Lumen to see this file.';
const UNENCRYPTED_FILE = 'This file isn’t encrypted, so Lumen won’t show it. Your files are encrypted, so it was put on the server some other way.';

/** The file name a response suggests (Content-Disposition), for an unencrypted file. */
function dispositionName(res: Response): string | null {
  const header = res.headers.get('content-disposition') ?? '';
  const m = /filename\*=UTF-8''([^;]+)/i.exec(header);
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return null;
  }
}

let codec: Codec | null = null;

export function setCodec(next: Codec | null) {
  codec = next;
}

/** The codec in use: set while an encrypted library is unlocked on this device. */
export function currentCodec(): Codec | null {
  return codec;
}

/*
 * The on-device copy of notes (library.ts) hears about every note fetched, and answers for a note
 * that can't be fetched while offline. Hooks rather than an import, since that module uses this one.
 */
let noteFetched: ((raw: RawNote) => void) | null = null;
let offlineNote: ((id: string) => Promise<Note | null>) | null = null;

export function setNoteHooks(hooks: { fetched: (raw: RawNote) => void; offline: (id: string) => Promise<Note | null> }) {
  noteFetched = hooks.fetched;
  offlineNote = hooks.offline;
}

/** Fired when the server refuses unencrypted text: encryption was turned on from another device. */
const encryptionListeners = new Set<() => void>();
export function onEncryptionRequired(fn: () => void) {
  encryptionListeners.add(fn);
  return () => encryptionListeners.delete(fn);
}

/** The encryption key was replaced on another device: this one's key is out of date. */
const keyChangedListeners = new Set<() => void>();
export function onKeyChanged(fn: () => void) {
  keyChangedListeners.add(fn);
  return () => keyChangedListeners.delete(fn);
}

/** The key generation encrypted text is written under (kgen), while encryption is on. */
let keyGen = 0;
export function setKeyGen(gen: number) {
  keyGen = gen;
}
export function currentKeyGen(): number {
  return keyGen;
}

/**
 * Whether this device knows the whole library is encrypted: it has seen the server report encryption
 * on with nothing left in plaintext. The server refuses unencrypted text from then on, so a note, folder
 * or version that arrives unencrypted afterwards wasn't saved by Lumen, and isn't shown as the person's
 * own (see e2ee.ts). Kept across locking; cleared only by signing out of the device.
 */
const SEALED_KEY = 'kb.vault.sealed';
let sealedLibrary = false;

export function libraryEncrypted(): boolean {
  if (sealedLibrary) return true;
  try {
    sealedLibrary = localStorage.getItem(SEALED_KEY) === '1';
  } catch {
    /* no storage: known for this page only */
  }
  return sealedLibrary;
}

function rememberEncrypted(data: Bootstrap) {
  const p = data.encryption?.pending;
  if (!data.encryption?.on || !p || p.notes || p.versions || p.folders || libraryEncrypted()) return;
  sealedLibrary = true;
  try {
    localStorage.setItem(SEALED_KEY, '1');
  } catch {
    /* ignore */
  }
}

/**
 * A note just saved, as the server now has it (`meta` as it answered, ciphertext and all, and the text
 * sent, if the save had one): the copies kept for reading offline are brought up to date at once (the
 * service worker's, and the on-device copy of an encrypted library), not when the note is next read.
 * `base` is the version the save was made on.
 */
function savedAsStored(meta: NoteMeta, content: unknown, base?: number) {
  const text = typeof content === 'string' ? content : undefined;
  try {
    navigator.serviceWorker?.controller?.postMessage({ type: 'note-saved', meta, content: text, base });
  } catch {
    /* no service worker here: nothing kept for offline */
  }
  if (text !== undefined) noteFetched?.({ ...(meta as Note), content: text });
}

/** Answers that came from the service worker's offline copy rather than from the server (it marks them). */
const offlineCopies = new WeakSet<object>();
export const fromOfflineCopy = (value: unknown): boolean => typeof value === 'object' && value !== null && offlineCopies.has(value);

/** The server answered with a different note, folder or version than the one asked for. */
function checkId<T extends { id: string | number }>(item: T, id: string | number | undefined): T {
  if (id !== undefined && item.id !== id) {
    throw new ApiError(502, 'wrong_item', 'The server sent back a different item than the one asked for. Try again.');
  }
  return item;
}

/** An encrypted row's ciphertext isn't for the app's own state; plaintext fields replace it. */
function dropCipher<T extends { enc?: boolean; sealed?: unknown }>(value: T): T {
  const { enc: _e, sealed: _s, ...rest } = value;
  return rest as T;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public data?: unknown,
  ) {
    super(message);
  }
}

/** Thrown when the request never reached the server (offline, DNS, etc). */
export class NetworkError extends Error {}

/** When Cloudflare's free daily allowances (requests, D1 rows, KV writes) start again: 00:00 UTC. */
export function quotaResetAt(now = Date.now()): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
}

/** One of those allowances is used up for today: nothing more gets through until it resets. */
function quotaError(): ApiError {
  const at = quotaResetAt();
  const hours = Math.max(1, Math.round((at - Date.now()) / 3_600_000));
  const local = new Date(at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  return new ApiError(
    429,
    'quota_exceeded',
    `Lumen has used up today’s Cloudflare free allowance. Your edits are kept on this device and saved once it resets at ${local} (in about ${hours} ${hours === 1 ? 'hour' : 'hours'}).`,
    { resetAt: at },
  );
}

const authListeners = new Set<() => void>();
export function onAuthExpired(fn: () => void) {
  authListeners.add(fn);
  return () => authListeners.delete(fn);
}
function authExpired(): never {
  authListeners.forEach((fn) => fn());
  throw new ApiError(401, 'auth', 'Your sign-in session has ended. Reload the page to sign in again.');
}

// navigator.onLine is unreliable (captive portals, flaky mobile data), so
// reachability is also inferred from whether requests actually get through.
const reachabilityListeners = new Set<(reachable: boolean) => void>();
let lastReachable = true;
export function onReachabilityChange(fn: (reachable: boolean) => void) {
  reachabilityListeners.add(fn);
  return () => reachabilityListeners.delete(fn);
}
function setReachable(value: boolean) {
  if (value === lastReachable) return;
  lastReachable = value;
  reachabilityListeners.forEach((fn) => fn(value));
}

/**
 * Browsers cap the bodies of all keepalive requests in flight together at 64 KiB and refuse any
 * request past it outright, which would look like a dropped connection. So keepalive is a budget
 * shared by every request; one that doesn't fit goes as a normal request (its draft is on disk).
 */
/** A backup kept on the server (see /api/backups). */
export interface BackupInfo {
  name: string;
  size: number;
  made_at: number;
  encrypted: boolean;
}

export interface BackupList {
  available: boolean;
  /** How many are kept (the oldest go). */
  keep: number;
  backups: BackupInfo[];
}

const KEEPALIVE_LIMIT = 60_000;
let keepaliveInFlight = 0;

function bodyBytes(payload: BodyInit | undefined): number | null {
  if (payload === undefined) return 0;
  if (typeof payload !== 'string') return null;
  return payload.length * 3 <= KEEPALIVE_LIMIT ? payload.length * 3 : new TextEncoder().encode(payload).byteLength;
}

interface CallOptions {
  headers?: Record<string, string>;
  signal?: AbortSignal;
  raw?: boolean;
  keepalive?: boolean;
}

async function call<T>(method: string, path: string, body?: unknown, opts: CallOptions = {}): Promise<T> {
  const headers: Record<string, string> = { 'x-kb-client': '1', ...opts.headers };
  let payload: BodyInit | undefined;
  if (body instanceof Blob || body instanceof ArrayBuffer || typeof body === 'string') {
    payload = body as BodyInit;
  } else if (body !== undefined) {
    headers['content-type'] = 'application/json';
    payload = JSON.stringify(body);
  }

  // keepalive lets a save finish after the page is hidden or closed, within the shared budget above.
  const keepBytes = opts.keepalive ? bodyBytes(payload) : null;
  const keepalive = keepBytes !== null && keepaliveInFlight + keepBytes <= KEEPALIVE_LIMIT;
  if (keepalive) keepaliveInFlight += keepBytes;
  // Uploads and file downloads can rightly take long on a slow connection; everything else gets a limit.
  const bulk = opts.raw || payload instanceof Blob || payload instanceof ArrayBuffer;
  const signal = bulk ? opts.signal : withTimeout(opts.signal, REQUEST_TIMEOUT_MS);
  try {
    return await send<T>(path, { method, headers, body: payload, signal, keepalive }, opts.raw);
  } finally {
    if (keepalive) keepaliveInFlight -= keepBytes;
  }
}

/**
 * A request that hangs (a network switching from Wi-Fi to mobile, a captive portal) would otherwise
 * stay "Saving…" for good and hold up every later save of that note. Past this it counts as a dropped
 * connection, which is retried.
 */
const REQUEST_TIMEOUT_MS = 30_000;

function withTimeout(signal: AbortSignal | undefined, ms: number): AbortSignal | undefined {
  if (typeof AbortSignal.timeout !== 'function') return signal;
  const timer = AbortSignal.timeout(ms);
  if (!signal) return timer;
  return typeof AbortSignal.any === 'function' ? AbortSignal.any([signal, timer]) : signal;
}

const unreachable = () => new NetworkError('Can’t reach the server. Check your connection.');

async function send<T>(path: string, init: RequestInit, raw?: boolean): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      ...init,
      credentials: 'same-origin',
      // Cloudflare Access answers expired sessions with a redirect to its login page.
      redirect: 'manual',
    });
  } catch (err) {
    // Aborted by the caller; a timeout (TimeoutError) is treated as the connection dropping.
    if ((err as Error).name === 'AbortError') throw err;
    setReachable(false);
    throw unreachable();
  }
  setReachable(res.headers.get('x-kb-offline') !== '1');

  if (res.type === 'opaqueredirect' || res.status === 0 || res.status === 401) authExpired();
  const type = res.headers.get('content-type') ?? '';
  if (raw && res.ok) return res as unknown as T;
  if (!type.includes('application/json')) {
    const html = type.includes('text/html');
    // A page instead of JSON is Access's sign-in or refusal page (the session ended)…
    if (html && (res.status < 300 || res.status === 403)) authExpired();
    // …or Cloudflare's own error page: its daily request limit used up (error 1027, or any 429), which
    // isn't a session that ended and isn't helped by trying again before midnight UTC.
    if (res.status === 429 || (html && /\b1027\b/.test(await res.text().catch(() => '')))) throw quotaError();
    // Anything else (a 5xx, a page from a proxy) is a passing problem, and is retried.
    throw new ApiError(res.status, 'http', `Request failed (${res.status}).`);
  }
  let data: { error?: string; message?: string } & Record<string, unknown>;
  try {
    data = await res.json();
    if (res.headers.get('x-kb-offline') === '1' && data && typeof data === 'object') offlineCopies.add(data);
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw err;
    throw unreachable();
  }
  if (!res.ok && data?.error === 'encryption_required') encryptionListeners.forEach((fn) => fn());
  if (!res.ok && data?.error === 'key_changed') keyChangedListeners.forEach((fn) => fn());
  if (!res.ok && data?.error === 'quota_exceeded') throw quotaError();
  if (!res.ok) {
    throw new ApiError(res.status, data?.error ?? 'error', data?.message ?? `Request failed (${res.status}).`, data);
  }
  return data as T;
}

const enc = encodeURIComponent;

/** Decrypts each item while encryption is on; returns them unchanged otherwise. */
function openEach<T>(items: T[], open: ((item: T) => Promise<T>) | undefined): Promise<T[]> {
  return open ? Promise.all(items.map(open)) : Promise.resolve(items);
}

export const api = {
  async bootstrap(): Promise<Bootstrap> {
    const c = codec;
    const data = await call<Bootstrap>('GET', '/api/bootstrap');
    if (fromOfflineCopy(data)) data.offline = true;
    rememberEncrypted(data);
    if (c) rememberAttachments(data);
    if (!c) return data;
    // The key was replaced on another device since this one unlocked.
    if (data.encryption?.on && (data.encryption.gen ?? 0) > keyGen) keyChangedListeners.forEach((fn) => fn());
    const [notes, folders] = await Promise.all([openEach(data.notes, c.openMeta), openEach(data.folders, c.openFolder)]);
    return { ...data, notes, folders };
  },
  me: () => call<Me>('GET', '/api/me'),

  /**
   * Saves the synced settings (JSON), encrypted when the library is, on top of the version stored at
   * `base`. Refused (ok: false, with what's stored now) when another device saved since.
   */
  async saveSettings(json: string, base: number): Promise<{ ok: true; at: number } | { ok: false; settings: StoredSettings | null }> {
    const c = codec;
    const body = c ? { enc: true, data: await c.sealSettings(json), kgen: keyGen, base } : { enc: false, data: json, base };
    return call('PUT', '/api/settings', body);
  },
  /**
   * Stored settings as JSON text, or null if this device can't read them (encrypted, and no key for
   * them) or won't: unencrypted settings once the library is known to be encrypted can only have been
   * put there by someone else (the Worker refuses them), like unencrypted notes. This device's own then
   * replace them.
   */
  async openSettings(stored: StoredSettings): Promise<string | null> {
    if (!stored.enc) return libraryEncrypted() ? null : stored.data;
    return codec ? codec.openSettings(stored.data) : null;
  },
  /** The note list as stored: encrypted fields left as ciphertext (for re-encrypting them). */
  async bootstrapSealed(): Promise<Bootstrap> {
    const data = await call<Bootstrap>('GET', '/api/bootstrap');
    rememberEncrypted(data);
    return data;
  },
  stats: () =>
    call<{
      notes: { active: number; trashed: number; chars: number };
      files: { count: number; bytes: number };
      drawings: { count: number; bytes: number };
      storage: 'kv' | 'r2' | null;
    }>('GET', '/api/stats'),

  async getNote(id: string): Promise<Note> {
    let note: RawNote;
    try {
      note = checkId(await call<RawNote>('GET', `/api/notes/${enc(id)}`), id);
    } catch (err) {
      // Offline, and the service worker has no copy: the copy kept on this device, if there is one.
      if (err instanceof NetworkError && offlineNote) {
        const kept = await offlineNote(id).catch(() => null);
        if (kept) return kept;
      }
      throw err;
    }
    // The service worker's copy (offline), from when the note was last read: the copy kept on this
    // device may be newer (saved since), and then it's the one shown.
    if (fromOfflineCopy(note) && offlineNote) {
      const kept = await offlineNote(id).catch(() => null);
      if (kept && kept.version > note.version) return kept;
    }
    const opened = await api.openRaw(note);
    noteFetched?.(note);
    return opened;
  },
  /** A note as the server sent it, decrypted (while encryption is on) after the same checks as getNote. */
  async openRaw(note: RawNote): Promise<Note> {
    const c = codec;
    if (c && note.enc && (note.kgen ?? 0) > keyGen) {
      // Written with a key newer than this device's: it was replaced elsewhere.
      keyChangedListeners.forEach((fn) => fn());
      throw new ApiError(409, 'key_changed', 'Your encryption key was replaced on another device. Unlock again with your passphrase.');
    }
    return c ? c.openNote(note) : note;
  },
  /** Up to 90 notes by id, as stored (ciphertext for encrypted notes): for the on-device copy. */
  async rawNotes(ids: string[]): Promise<RawNote[]> {
    if (!ids.length) return [];
    const { notes } = await call<{ notes: RawNote[] }>('POST', '/api/notes/batch', { ids });
    const asked = new Set(ids);
    // Only the notes asked for; anything else the server sent is ignored.
    return notes.filter((n) => n && typeof n.id === 'string' && asked.has(n.id));
  },
  async createNote(data: NewNote): Promise<NoteMeta> {
    const c = codec;
    const body = c ? { ...(await c.sealNew(data)), kgen: keyGen } : dropCipher(data);
    const meta = checkId(await call<NoteMeta>('POST', '/api/notes', body), (body as { id?: string }).id);
    savedAsStored(meta, (body as { content?: unknown }).content ?? '');
    return c ? c.openMeta(meta) : meta;
  },
  /**
   * Creates a note under an id chosen here (idFor in utils.ts), so it can be sent again when no reply
   * came (a dropped connection, a page closed mid-save): a note already there under that id with this
   * title and text is the earlier try, landed, and is the answer. One with anything else (made on
   * another device from the same note, with other edits) is left alone, and this one gets an id of
   * its own: nothing either side wrote is lost.
   */
  async createNoteOnce(data: NewNote & { id: string }): Promise<NoteMeta> {
    try {
      return await api.createNote(data);
    } catch (err) {
      if (!(err instanceof ApiError && err.status === 409 && err.code === 'exists')) throw err;
    }
    const there = await api.getNote(data.id).catch(() => null);
    if (there && !there.deleted_at && there.content === (data.content ?? '') && there.title === cleanTitle(data.title)) {
      const { content: _c, ...meta } = there;
      return meta;
    }
    return api.createNote({ ...data, id: newId() });
  },
  async updateNote(id: string, patch: NotePatch, opts?: CallOptions): Promise<NoteMeta> {
    const c = codec;
    try {
      const body: Record<string, unknown> = c ? { ...(await c.sealPatch(id, patch)), kgen: keyGen } : { ...patch };
      const meta = checkId(await call<NoteMeta>('PATCH', `/api/notes/${enc(id)}`, body, opts), id);
      savedAsStored(meta, body.content, patch.baseVersion);
      return c ? c.openMeta(meta) : meta;
    } catch (err) {
      // A conflict carries the saved note, to show beside the local edits: decrypt it too.
      const saved = err instanceof ApiError ? (err.data as { note?: Note } | undefined) : undefined;
      if (c && err instanceof ApiError && err.code === 'conflict' && saved?.note) {
        const note = saved.note.id === id ? await c.openNote(saved.note).catch(() => undefined) : undefined;
        throw new ApiError(err.status, err.code, err.message, { ...saved, note });
      }
      throw err;
    }
  },
  /**
   * Keeps `text` in the note's history without changing the note (edits made here that a newer version
   * from another device replaced). `at` is when they were made. Encrypted like the note's own text.
   */
  async keepVersion(id: string, text: { title: string; content: string }, at: number): Promise<void> {
    const c = codec;
    if (c) {
      const sealed = (await c.sealPatch(id, text)) as { content: string; sealed: { t: string } };
      await call('POST', `/api/notes/${enc(id)}/versions`, { enc: true, content: sealed.content, sealed: { t: sealed.sealed.t }, kgen: keyGen, at });
      return;
    }
    await call('POST', `/api/notes/${enc(id)}/versions`, { title: text.title, content: text.content, at });
  },
  async trashNote(id: string): Promise<NoteMeta> {
    const c = codec;
    const meta = checkId(await call<NoteMeta>('POST', `/api/notes/${enc(id)}/trash`, {}), id);
    return c ? c.openMeta(meta) : meta;
  },
  async restoreNote(id: string): Promise<NoteMeta> {
    const c = codec;
    const meta = checkId(await call<NoteMeta>('POST', `/api/notes/${enc(id)}/restore`, {}), id);
    return c ? c.openMeta(meta) : meta;
  },
  /** With `ifVersion`, deletes only while the note is still at that version (`deleted` says whether it did). */
  deleteNote: (id: string, opts: { ifVersion?: number } = {}) =>
    call<{ ok: true; deleted: boolean }>(
      'DELETE',
      `/api/notes/${enc(id)}${opts.ifVersion === undefined ? '' : `?ifVersion=${opts.ifVersion}`}`,
    ),
  /** Empties the browser's HTTP cache for this site (Clear-Site-Data), as part of signing out. */
  signOut: () => call<{ ok: true }>('POST', '/api/signout', {}),
  emptyTrash: () => call<{ ok: true; deleted: number }>('POST', '/api/trash/empty', {}),
  async versions(id: string): Promise<{ versions: VersionInfo[] }> {
    const c = codec;
    const { versions } = await call<{ versions: VersionInfo[] }>('GET', `/api/notes/${enc(id)}/versions`);
    return { versions: await openEach(versions, c ? (v) => c.openVersionInfo(id, v) : undefined) };
  },
  /** A history snapshot of `noteId`. */
  async version(vid: number, noteId: string): Promise<Version> {
    const c = codec;
    const version = checkId(await call<Version>('GET', `/api/versions/${vid}`), vid);
    if (version.note_id !== noteId) throw new ApiError(404, 'not_found', 'Version not found.');
    return c ? c.openVersion(version, noteId) : version;
  },
  async backlinks(id: string): Promise<{ backlinks: Backlink[] }> {
    const c = codec;
    if (c) return { backlinks: await c.backlinks(id) };
    return call<{ backlinks: Backlink[] }>('GET', `/api/notes/${enc(id)}/backlinks`);
  },

  async createFolder(data: Partial<Folder>): Promise<Folder> {
    const c = codec;
    const body = c ? { ...(await c.sealFolder(data.id ?? '', data)), kgen: keyGen } : dropCipher(data);
    const folder = checkId(await call<Folder>('POST', '/api/folders', body), (body as { id?: string }).id);
    return c ? c.openFolder(folder) : folder;
  },
  async updateFolder(id: string, patch: Partial<Pick<Folder, 'name' | 'parent_id' | 'sort'>>): Promise<Folder> {
    const c = codec;
    const folder = checkId(await call<Folder>('PATCH', `/api/folders/${enc(id)}`, c ? { ...(await c.sealFolder(id, patch)), kgen: keyGen } : patch), id);
    return c ? c.openFolder(folder) : folder;
  },
  deleteFolder: (id: string) => call<{ ok: true; trashed: number }>('DELETE', `/api/folders/${enc(id)}`),

  /** The server's full-text search (unencrypted libraries only; search.ts decides). */
  searchServer: (q: string, limit: number, signal?: AbortSignal) =>
    call<{ results: SearchHit[] }>('GET', `/api/search?q=${enc(q)}&limit=${limit}`, undefined, { signal }),

  /** Every upload. An encrypted one's name and type are decrypted here (its `url` then carries the name, like any other). */
  async listFiles(): Promise<{ files: FileInfo[] }> {
    const c = codec;
    const { files } = await call<{ files: FileInfo[] }>('GET', '/api/files');
    return { files: await Promise.all(files.map((f) => openFileInfo(c, f))) };
  },
  deleteFile: (id: string) => call<{ ok: true }>('DELETE', `/api/files/${enc(id)}`),
  /**
   * Uploads and drawings that nothing in `referenced` links to (see cleanup.ts, which works that out);
   * with dryRun false, deletes those of them in `confirm`, and no others.
   */
  async cleanup(body: { dryRun: boolean; referenced: string[]; confirm?: { files: string[]; drawings: string[] } }) {
    const c = codec;
    const result = await call<{
      dryRun: boolean;
      files: Array<{ id: string; name: string; size: number; enc?: boolean; sealed?: string }>;
      drawings: Array<{ id: string; size: number }>;
      bytes: number;
    }>('POST', '/api/files/cleanup', body);
    const files = await Promise.all(
      result.files.map(async (f) => (f.enc ? { ...f, name: (c && (await c.openFileMeta(f.id, f.sealed ?? ''))?.name) || 'Encrypted file' } : f)),
    );
    return { ...result, files };
  },
  /**
   * Uploads a file. While encryption is on it's encrypted here first, under its own key, with an id
   * chosen here (the ciphertext is bound to it); the server never learns its name or type.
   */
  async uploadFile(file: Blob, name: string, opts: { noteId?: string | null; id?: string } = {}): Promise<FileInfo> {
    const c = codec;
    const noteHeader: Record<string, string> = opts.noteId ? { 'x-note-id': opts.noteId } : {};
    if (!c) {
      return call<FileInfo>('POST', '/api/files', file, {
        headers: {
          'content-type': file.type || 'application/octet-stream',
          'x-file-name': enc(name),
          ...noteHeader,
          ...(opts.id ? { 'x-file-id': opts.id } : {}),
        },
      });
    }
    const id = opts.id ?? newId(16);
    const mime = file.type || 'application/octet-stream';
    const { body, sealed } = await c.sealFile(id, new Uint8Array(await file.arrayBuffer()), { name, mime });
    const info = checkId(
      await call<FileInfo>('POST', '/api/files', new Blob([body as BlobPart]), {
        headers: {
          'content-type': 'application/octet-stream',
          'x-kb-enc': '1',
          'x-file-id': id,
          'x-kb-sealed': sealed,
          'x-kb-kgen': String(keyGen),
          ...noteHeader,
        },
      }),
      id,
    );
    return openFileInfo(c, info);
  },
  /** Replaces an upload saved before encryption with its encrypted form (encryptAttachments in e2ee.ts). */
  sealExistingFile: (id: string, body: Uint8Array, sealed: string) =>
    call<{ sealed: boolean }>('PUT', `/api/files/${enc(id)}/seal`, new Blob([body as BlobPart]), {
      headers: { 'content-type': 'application/octet-stream', 'x-kb-sealed': sealed, 'x-kb-kgen': String(keyGen) },
    }),
  fetchRaw: (url: string) => call<Response>('GET', url, undefined, { raw: true }),

  /**
   * An upload's bytes, decrypted if it's encrypted, with its name and type. Asked for by id alone, so
   * a request never carries the file's name. `fresh` goes past copies kept on the device.
   */
  async fileBlob(id: string, opts: { fresh?: boolean } = {}): Promise<{ blob: Blob; name: string; mime: string }> {
    const res = await call<Response>('GET', `/api/files/${enc(id)}${opts.fresh ? `?fresh=${Date.now()}` : ''}`, undefined, { raw: true });
    const sealed = res.headers.get('x-kb-key');
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (sealed) {
      const c = codec;
      if (!c) throw new ApiError(423, 'locked', LOCKED_FILE);
      const opened = await c.openFile(id, sealed, bytes);
      return { blob: new Blob([opened.bytes as BlobPart], { type: opened.mime }), name: opened.name, mime: opened.mime };
    }
    if (codec && attachmentsEncrypted()) {
      // Possibly a copy kept from before the files were encrypted: once more, from the server.
      if (!opts.fresh) return api.fileBlob(id, { fresh: true });
      throw new ApiError(422, 'unencrypted', UNENCRYPTED_FILE);
    }
    const mime = (res.headers.get('content-type') ?? 'application/octet-stream').split(';')[0].trim();
    return { blob: new Blob([bytes as BlobPart], { type: mime }), name: dispositionName(res) ?? id, mime };
  },

  /** A drawing's picture (SVG) or editable scene (JSON) as text, decrypted if it's encrypted. */
  async drawingPart(id: string, part: 'svg' | 'scene', opts: { fresh?: boolean } = {}): Promise<string> {
    const path = part === 'svg' ? `/api/drawings/${enc(id)}.svg` : `/api/drawings/${enc(id)}/scene`;
    const res = await call<Response>('GET', `${path}${opts.fresh ? `?fresh=${Date.now()}` : ''}`, undefined, { raw: true });
    const sealed = res.headers.get('x-kb-key');
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (sealed) {
      const c = codec;
      if (!c) throw new ApiError(423, 'locked', LOCKED_FILE);
      return c.openDrawing(id, part, sealed, bytes);
    }
    if (codec && attachmentsEncrypted()) {
      if (!opts.fresh) return api.drawingPart(id, part, { fresh: true });
      throw new ApiError(422, 'unencrypted', 'This drawing isn’t encrypted, so Lumen won’t show it.');
    }
    return new TextDecoder().decode(bytes);
  },

  /** An attachment's bytes by the address a note uses for it (/api/files/…, /api/drawings/….svg or /scene). */
  async assetBytes(url: string): Promise<Uint8Array> {
    const file = /^\/api\/files\/([A-Za-z0-9_-]{6,64})/.exec(url);
    if (file) return new Uint8Array(await (await api.fileBlob(file[1])).blob.arrayBuffer());
    const drawing = /^\/api\/drawings\/([A-Za-z0-9_-]{6,64})(\.svg|\/scene)/.exec(url);
    if (drawing) return new TextEncoder().encode(await api.drawingPart(drawing[1], drawing[2] === '.svg' ? 'svg' : 'scene'));
    return new Uint8Array(await (await api.fetchRaw(url)).arrayBuffer());
  },

  listDrawings: () => call<{ drawings: DrawingInfo[] }>('GET', '/api/drawings'),
  async getDrawingScene(id: string): Promise<Record<string, unknown>> {
    return JSON.parse(await api.drawingPart(id, 'scene')) as Record<string, unknown>;
  },
  deleteDrawing: (id: string) => call<{ ok: true }>('DELETE', `/api/drawings/${enc(id)}`),
  /**
   * `baseRev` is the revision the editor started from (null for a new drawing): the server then
   * refuses (409 drawing_conflict, with the current drawing) to save over a revision saved since.
   * Left out, the save replaces whatever is there. While encryption is on, both parts are encrypted
   * here under a new key for this revision.
   */
  async saveDrawing(
    id: string,
    data: { scene: string; svg: string; noteId: string | null; text: string; createdAt?: number; baseRev?: string | null },
  ): Promise<DrawingInfo> {
    const c = codec;
    const rev = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const sealed = c ? await c.sealDrawing(id, { scene: data.scene, svg: data.svg }) : null;
    const scene: Blob = sealed ? new Blob([sealed.scene as BlobPart]) : new Blob([data.scene], { type: 'application/json' });
    const svg: Blob = sealed ? new Blob([sealed.svg as BlobPart]) : new Blob([data.svg], { type: 'image/svg+xml' });
    await call('PUT', `/api/drawings/${enc(id)}/blob/scene?rev=${rev}`, scene, {
      headers: { 'content-type': sealed ? 'application/octet-stream' : 'application/json' },
    });
    await call('PUT', `/api/drawings/${enc(id)}/blob/svg?rev=${rev}`, svg, {
      headers: { 'content-type': sealed ? 'application/octet-stream' : 'image/svg+xml' },
    });
    return call<DrawingInfo>('PUT', `/api/drawings/${enc(id)}`, {
      rev,
      note_id: data.noteId,
      // Kept for search on the server, so not sent at all once notes are encrypted.
      text: c ? '' : data.text,
      size: scene.size + svg.size,
      created_at: data.createdAt,
      ...(data.baseRev !== undefined ? { base_rev: data.baseRev } : {}),
      ...(sealed ? { enc: true, sealed: sealed.sealed, kgen: keyGen } : {}),
    });
  },
  /** Records that a backup of the whole library was just downloaded (for the reminder on Home). */
  markBackup: () => call<{ ok: true; at: number }>('POST', '/api/backups/made', {}),
  /** Backups kept on the server (automatic ones, or "Back up now"): off when no bucket is set up for them. */
  listBackups: () => call<BackupList>('GET', '/api/backups'),
  /** Keeps a backup made here (`sealed`: encrypted on this device). `auto`: one is enough for every device today. */
  keepBackup: (blob: Blob, opts: { sealed: boolean; auto?: boolean }) =>
    call<{ ok: true; name: string; at: number }>('POST', '/api/backups', blob, {
      headers: { 'content-type': 'application/octet-stream', ...(opts.sealed ? { 'x-kb-backup': 'sealed' } : {}), ...(opts.auto ? { 'x-kb-auto': '1' } : {}) },
    }),
  async fetchBackup(name: string): Promise<Uint8Array> {
    const res = await call<Response>('GET', `/api/backups/${enc(name)}`, undefined, { raw: true });
    return new Uint8Array(await res.arrayBuffer());
  },
  deleteBackup: (name: string) => call<{ ok: true }>('DELETE', `/api/backups/${enc(name)}`),
  /** Empties the browser's HTTP cache for this site (once files are encrypted: plaintext copies go). */
  clearHttpCache: () => call<{ ok: true }>('POST', '/api/cache/clear', {}),

  /**
   * Every note, a page at a time. `sealed` leaves encrypted notes as they're stored. Otherwise a note
   * this device can't open (encrypted with another key, changed outside Lumen, or unencrypted in an
   * encrypted library) is left out and its id put in `unreadable`, so one such note doesn't stop a
   * whole backup.
   */
  async exportNotes(after: number, opts: { sealed?: boolean } = {}): Promise<{ notes: Note[]; next: number | null; unreadable: string[] }> {
    const c = opts.sealed ? null : codec;
    const page = await call<{ notes: Note[]; next: number | null }>('GET', `/api/export/notes?after=${after}&limit=100`);
    if (!c) return { ...page, unreadable: [] };
    const opened = await Promise.allSettled(page.notes.map(c.openNote));
    const notes: Note[] = [];
    const unreadable: string[] = [];
    for (const [i, result] of opened.entries()) {
      if (result.status === 'fulfilled') notes.push(result.value);
      else if (result.reason instanceof ApiError && result.reason.status === 422) unreadable.push(page.notes[i].id);
      else throw result.reason;
    }
    return { ...page, notes, unreadable };
  },

  /* ------------------------------------------- end-to-end encryption --- */

  keyring: () => call<{ keyring: Keyring | null }>('GET', '/api/keyring'),
  saveKeyring: (data: KeyringData, replaces: number | null) =>
    call<{ keyring: Keyring }>('POST', '/api/keyring', { data, replaces }),
  sealFolders: (folders: Array<{ id: string; sealed: string }>) => call<{ sealed: number }>('POST', '/api/folders/seal', { folders, kgen: keyGen }),
  sealNotes: (notes: Array<{ id: string; version: number; content: string; sealed: Sealed }>) =>
    call<{ sealed: number }>('POST', '/api/notes/seal', { notes, kgen: keyGen }),
  /** Every saved version as stored (ciphertext for encrypted ones), a page at a time: what old versions link to. */
  exportVersions: (after: number) => call<{ versions: Version[]; next: number | null }>('GET', `/api/versions/export?after=${after}`),
  plainVersions: (after: number) =>
    call<{ versions: Array<{ id: number; note_id: string; title: string; content: string }>; next: number | null }>(
      'GET',
      `/api/versions/plain?after=${after}`,
    ),
  sealVersions: (versions: Array<{ id: number; content: string; sealed: Sealed } | { id: number; drop: true }>) =>
    call<{ sealed: number }>('POST', '/api/versions/seal', { versions, kgen: keyGen }),
  finishEncryption: () => call<{ ok: true }>('POST', '/api/encryption/finish', {}),
  /** Replaces encrypted notes' previews (`p`), each only while the note is still at `version`. */
  sealPreviews: (notes: Array<{ id: string; version: number; p: string }>) =>
    call<{ updated: string[] }>('POST', '/api/notes/previews', { notes, kgen: keyGen }),

  /** After the encryption key was replaced: what's still encrypted with an earlier key, a page at a time. */
  rekeyNotes: (after: number) =>
    call<{ notes: Array<{ id: string; version: number; updated_at?: number; content: string; sealed: Sealed }>; next: number | null }>(
      'GET',
      `/api/rekey/notes?after=${after}`,
    ),
  rekeyVersions: (after: number) =>
    call<{ versions: Array<{ id: number; note_id: string; content: string; sealed: Sealed }>; next: number | null }>(
      'GET',
      `/api/rekey/versions?after=${after}`,
    ),
  /** Each only while the note is still at `version` and `updated_at` (a title or tag change moves only the latter). */
  saveRekeyedNotes: (notes: Array<{ id: string; version: number; updated_at?: number; content: string; sealed: Sealed }>) =>
    call<{ rekeyed: number }>('POST', '/api/rekey/notes', { notes, kgen: keyGen }),
  saveRekeyedVersions: (versions: Array<{ id: number; content: string; sealed: Sealed }>) =>
    call<{ rekeyed: number }>('POST', '/api/rekey/versions', { versions, kgen: keyGen }),
  saveRekeyedFolders: (folders: Array<{ id: string; sealed: string }>) =>
    call<{ rekeyed: number }>('POST', '/api/rekey/folders', { folders, kgen: keyGen }),
  /** Encrypted uploads' or drawings' wrapped keys still under an earlier key, a page at a time. */
  rekeyAttachments: (kind: 'files' | 'drawings', after: string) =>
    call<{ items: Array<{ id: string; sealed: string }>; next: string | null }>('GET', `/api/rekey/${kind}?after=${enc(after)}`),
  saveRekeyedAttachments: (kind: 'files' | 'drawings', items: Array<{ id: string; sealed: string }>) =>
    call<{ rekeyed: number }>('POST', `/api/rekey/${kind}`, { items, kgen: keyGen }),
};

/** An upload as the app uses it: an encrypted one with its name and type (and an address carrying the name), decrypted. */
async function openFileInfo(c: Codec | null, f: FileInfo): Promise<FileInfo> {
  if (!f.enc) return f;
  const meta = c ? await c.openFileMeta(f.id, f.sealed ?? '') : null;
  const name = meta?.name || 'file';
  return { ...f, name: meta ? name : 'Encrypted file', mime: meta?.mime ?? 'application/octet-stream', url: `/api/files/${f.id}/${enc(name)}` };
}

export function errorMessage(err: unknown): string {
  if (err instanceof ApiError || err instanceof NetworkError) return err.message;
  if (err instanceof Error) return err.message;
  return 'Something went wrong.';
}
