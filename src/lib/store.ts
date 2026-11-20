import { create } from 'zustand';
import { cleanTags } from '../../shared/noteText';
import { api, ApiError, attachmentsEncrypted, errorMessage, libraryEncrypted, NetworkError, onAuthExpired, onReachabilityChange } from './api';
import { changePage, layerOf, onPageChange } from './backLayers';
import { receiveSettings } from './settingsSync';
import type { Folder, ListFilter, Me, Note, NoteMeta, ViewMode } from './types';
import { newId, noteTitle, todayIso } from './utils';
import { MAX_SAVED_SEARCH_NAME, MAX_SAVED_SEARCH_QUERY, MAX_SAVED_SEARCHES, useSettings, type SavedSearch } from './settings';

export interface DialogRequest {
  kind: 'confirm' | 'prompt';
  title: string;
  message?: string;
  confirmLabel?: string;
  /** Text for the button that declines (default "Cancel"). */
  cancelLabel?: string;
  /** A third choice, between the two (see chooseDialog). */
  altLabel?: string;
  /** Something to know, with nothing to decline: only the main button (see noticeDialog). */
  notice?: boolean;
  danger?: boolean;
  initial?: string;
  placeholder?: string;
  /** A prompt for a passphrase or key: typed text is hidden. */
  secret?: boolean;
  resolve: (value: string | boolean | null) => void;
}

export interface ToastAction {
  label: string;
  run: () => void;
  /** Styled as a destructive choice. */
  danger?: boolean;
}

export interface Toast {
  id: number;
  message: string;
  kind?: 'info' | 'error' | 'success';
  /** The main button, shown last. */
  action?: ToastAction;
  /** Further buttons, shown before the main one. */
  more?: ToastAction[];
  timeout?: number;
}

export interface DrawingRequest {
  drawingId: string | null;
  noteId: string | null;
  resolve: (drawingId: string | null) => void;
}

export interface MermaidRequest {
  code: string;
  isNew: boolean;
  resolve: (code: string | null) => void;
}

export type LightboxRequest = { kind: 'image'; src: string; alt?: string } | { kind: 'svg'; html: string };

interface AppState {
  status: 'loading' | 'ready' | 'error';
  loadError: string | null;
  me: Me | null;
  folders: Folder[];
  notes: Record<string, NoteMeta>;
  filter: ListFilter;
  /** What the note list is searched for (empty: not searching). */
  listQuery: string;
  /** Today's date (YYYY-MM-DD), changed at midnight: what says "Today" or "Yesterday" is drawn again. */
  day: string;
  noteId: string | null;
  drawerOpen: boolean;
  focusMode: boolean;
  authExpired: boolean;
  online: boolean;
  paletteOpen: boolean;
  settingsOpen: boolean;
  historyFor: string | null;
  dialog: DialogRequest | null;
  toasts: Toast[];
  drawing: DrawingRequest | null;
  mermaid: MermaidRequest | null;
  lightbox: LightboxRequest | null;
  /** Bumped when a drawing is saved so previews refetch the SVG. */
  drawingRevs: Record<string, number>;
  lastSync: number;
  /**
   * The note list is the service worker's copy from when it was last fetched (offline), not the
   * server's: it may lack notes made since, so nothing is taken as deleted because it isn't listed.
   */
  offlineList: boolean;
  /** Bumped to force the open note to reload (e.g. after restoring a version). */
  reloadToken: number;
  /** Which top-level screen phones show when no note is open. */
  mobileTab: 'home' | 'notes';
  /** What the main pane shows when no note is open: Home, or every task (/tasks). */
  screen: 'home' | 'tasks';
  /** Heading id to scroll to once the open note has loaded (from a link like /note/<id>#h-section). */
  anchor: string | null;
  /** The note whose Export dialog is open. */
  exportFor: string | null;
  /** End-to-end encryption: on, and how many items (notes, versions, folders) are still unencrypted. */
  /** pending: still stored unencrypted; rekey: still encrypted with a key that was since replaced. */
  /** attachments: uploads and drawings still stored unencrypted. */
  encryption: { on: boolean; pending: number; rekey: number; attachments: number };
  /** Encrypting files and drawings was paused and put off until Lumen next opens ("Continue for now"). */
  attachmentsDeferred: boolean;
  /** When a backup of the whole library was last downloaded, from any device (null: never). */
  lastBackup: number | null;
  /** The Settings section to show when Settings next opens (the backup reminder opens Data). */
  settingsSection: string | null;
}

/** The list's filter, kept for the tab's session (vault.ts forgets it on locking: a tag name says something). */
function storedFilter(): ListFilter {
  try {
    const raw = sessionStorage.getItem('kb.filter');
    if (raw) return JSON.parse(raw);
  } catch {
    /* ignore */
  }
  return { kind: 'all' };
}

function rememberFilter(filter: ListFilter) {
  try {
    sessionStorage.setItem('kb.filter', JSON.stringify(filter));
  } catch {
    /* ignore */
  }
}

export function parseLocation(): string | null {
  const m = /^\/note\/([A-Za-z0-9_-]+)/.exec(window.location.pathname);
  return m ? m[1] : null;
}

function parseScreen(): 'home' | 'tasks' {
  return /^\/tasks\/?$/.test(window.location.pathname) ? 'tasks' : 'home';
}

function parseTab(): 'home' | 'notes' {
  return /^\/notes\/?$/.test(window.location.pathname) ? 'notes' : 'home';
}

/** Which notes the address says the list shows (null: it doesn't say). */
function filterFromAddress(params: URLSearchParams): ListFilter | null {
  const folder = params.get('folder');
  if (folder && /^[A-Za-z0-9_-]{1,64}$/.test(folder)) return { kind: 'folder', id: folder };
  const tag = params.get('tag')?.trim();
  if (tag) return { kind: 'tag', tag };
  const view = params.get('view');
  if (view === 'pinned' || view === 'trash') return { kind: view };
  const search = params.get('search');
  if (search && /^[A-Za-z0-9_-]{1,32}$/.test(search)) return { kind: 'search', id: search };
  return null;
}

/**
 * Tag names and searches of this page's steps, by step: with encryption on they're kept out of the
 * address and the history entry (browsers keep both on disk, and may sync addresses), so they're
 * remembered here, in memory, until the page closes or locks.
 */
const unlisted = new Map<string, { filter: ListFilter; listQuery: string }>();
let stepSeq = 0;
const newStep = () => `${Date.now().toString(36)}-${(++stepSeq).toString(36)}`;
const stepOf = (state: unknown): string | null => {
  const step = (state as { step?: unknown } | null)?.step;
  return typeof step === 'string' ? step : null;
};

/** The list's filter and search for the current address and step (`fallback` when neither says). */
function listPlace(fallback: ListFilter): { filter: ListFilter; listQuery: string } {
  const params = new URLSearchParams(window.location.search);
  const step = stepOf(history.state);
  const kept = step ? unlisted.get(step) : undefined;
  return {
    filter: filterFromAddress(params) ?? kept?.filter ?? fallback,
    // This page's own record first: the address may not have caught up with the last few letters typed.
    listQuery: kept?.listQuery ?? params.get('q') ?? '',
  };
}

const start = typeof window === 'undefined' ? { filter: { kind: 'all' } as ListFilter, listQuery: '' } : listPlace(storedFilter());

function decodeHash(hash: string): string {
  try {
    return decodeURIComponent(hash);
  } catch {
    return hash;
  }
}

function parseAnchor(hash = window.location.hash): string | null {
  return parseLocation() ? anchorOf(hash) : null;
}

function anchorOf(hash: string): string | null {
  if (hash.length < 2) return null;
  try {
    return decodeURIComponent(hash.slice(1));
  } catch {
    return null;
  }
}

export const useApp = create<AppState>(() => ({
  status: 'loading',
  loadError: null,
  me: null,
  folders: [],
  notes: {},
  filter: start.filter,
  listQuery: start.listQuery,
  day: todayIso(),
  noteId: parseLocation(),
  drawerOpen: false,
  focusMode: false,
  authExpired: false,
  online: typeof navigator === 'undefined' ? true : navigator.onLine,
  paletteOpen: false,
  settingsOpen: false,
  historyFor: null,
  dialog: null,
  toasts: [],
  drawing: null,
  mermaid: null,
  lightbox: null,
  drawingRevs: {},
  lastSync: 0,
  offlineList: false,
  reloadToken: 0,
  mobileTab: parseTab(),
  screen: parseScreen(),
  anchor: parseAnchor(),
  exportFor: null,
  encryption: { on: false, pending: 0, rekey: 0, attachments: 0 },
  attachmentsDeferred: false,
  lastBackup: null,
  settingsSection: null,
}));

const set = useApp.setState;
const get = useApp.getState;

/** Full notes we've already fetched this session, for instant switching. */
export const noteCache = new Map<string, Note>();

/** Notes created moments ago open straight into the editor. Entries expire rather than being consumed. */
const preferredModes = new Map<string, { mode: ViewMode; at: number }>();
export const preferredMode = {
  set(id: string, mode: ViewMode) {
    preferredModes.set(id, { mode, at: Date.now() });
  },
  get(id: string): ViewMode | undefined {
    const p = preferredModes.get(id);
    if (!p) return undefined;
    if (Date.now() - p.at > 4000) {
      preferredModes.delete(id);
      return undefined;
    }
    return p.mode;
  },
};

onAuthExpired(() => set({ authExpired: true }));

/**
 * The date moves on at midnight. Phones pause timers while Lumen is in the background, so it's looked
 * at again whenever Lumen is back on screen: a list left open overnight doesn't say "Today" for
 * yesterday's notes.
 */
if (typeof window !== 'undefined') {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const check = () => {
    const day = todayIso();
    if (get().day !== day) set({ day });
    clearTimeout(timer);
    const midnight = new Date();
    midnight.setHours(24, 0, 1, 0);
    timer = setTimeout(check, Math.max(1000, midnight.getTime() - Date.now()));
  };
  check();
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) check();
  });
  window.addEventListener('focus', check);
}
onReachabilityChange((reachable) => set({ online: reachable }));
window.addEventListener('online', () => set({ online: true }));
window.addEventListener('offline', () => set({ online: false }));

/* ------------------------------------------------------------ routing --- */
/*
 * Every page of Lumen has its own address, and its own step in Back:
 *   /             Home                 /tasks       every open task
 *   /notes        the note list (phones; wider screens show it beside every page)
 *   /note/<id>    a note (#h-… a heading in it)
 * and on any of them, which notes the list shows (?folder=<id>, ?tag=<tag>, ?view=pinned or trash) and
 * what it's searched for (&q=<text>). So Back goes back through Lumen's pages as in an app
 * (backLayers.ts first closes whatever's open over the page), and a link or bookmark opens that page.
 * With encryption on, tag names and searches are kept out of the address (see `unlisted`).
 */

interface Place {
  noteId: string | null;
  /** As in the address ("#h-…"), or empty. */
  hash: string;
  screen: 'home' | 'tasks';
  mobileTab: 'home' | 'notes';
  filter: ListFilter;
  listQuery: string;
}

const sealed = () => get().encryption.on || libraryEncrypted();
const matches = (query: string) => typeof window.matchMedia === 'function' && window.matchMedia(query).matches;
/** Phones: one page at a time, with the tab bar (as app.css lays it out). */
const phoneLayout = () => matches('(max-width: 759px)');

function hereNow(): Place {
  const s = get();
  const hash = s.noteId && parseLocation() === s.noteId ? window.location.hash : '';
  return { noteId: s.noteId, hash, screen: s.screen, mobileTab: s.mobileTab, filter: s.filter, listQuery: s.listQuery };
}

function addressOf(p: Place): string {
  const path = p.noteId ? `/note/${p.noteId}` : p.screen === 'tasks' ? '/tasks' : p.mobileTab === 'notes' ? '/notes' : '/';
  const params = new URLSearchParams();
  const secret = sealed();
  const f = p.filter;
  if (f.kind === 'folder') params.set('folder', f.id);
  else if (f.kind === 'tag' && !secret) params.set('tag', f.tag);
  else if (f.kind === 'pinned' || f.kind === 'trash') params.set('view', f.kind);
  // A saved search by its id, which says nothing of what it searches for.
  else if (f.kind === 'search') params.set('search', f.id);
  if (p.listQuery.trim() && !secret) params.set('q', p.listQuery);
  const search = params.toString();
  return path + (search ? `?${search}` : '') + (p.noteId ? p.hash : '');
}

/** Whether `address` is the page shown now (`page`), and at the same heading (`exact`). */
function compare(address: string): { page: boolean; exact: boolean } {
  const to = new URL(address, window.location.origin);
  const page = to.pathname === window.location.pathname && to.search === window.location.search;
  return { page, exact: page && decodeHash(to.hash) === decodeHash(window.location.hash) };
}

/**
 * Puts `p` in the address: a new step in Back, or this one again when `replace` (or when only the
 * heading differs: the same page). `kb` says a step of Lumen's comes before it (goBack goes there).
 */
function writeStep(p: Place, replace = false) {
  const address = addressOf(p);
  const { page, exact } = compare(address);
  const current = stepOf(history.state);
  const again = replace || page;
  const step = again && current ? current : newStep();
  unlisted.set(step, { filter: p.filter, listQuery: p.listQuery });
  if (exact && current === step) return;
  try {
    if (again) history.replaceState({ ...(history.state as object | null), kb: !!history.state?.kb, step }, '', address);
    else history.pushState({ kb: true, step }, '', address);
  } catch {
    /* too many changes too quickly (Safari): what's shown is right, if not the address */
  }
}

/** The search typed into the list goes into the address shortly after, in the same step. */
let queryTimer: ReturnType<typeof setTimeout> | undefined;
function writeQuery() {
  if (queryTimer === undefined) return;
  clearTimeout(queryTimer);
  queryTimer = undefined;
  // Kept for this page's step at once (something open over it shares its step), so Back finds it.
  const here = hereNow();
  const step = stepOf(history.state);
  if (step) unlisted.set(step, { filter: here.filter, listQuery: here.listQuery });
  // Its address waits while something's open over the page: that thing's step is the current one.
  if (!layerOf(history.state)) writeStep(here, true);
  else queryTimer = setTimeout(writeQuery, 400);
}

/** Back or Forward is restoring a step: a filter changed with it keeps the search that came with it. */
let restoring = false;

/** Shows another page (`change`), with the address and a step in Back to match. */
function go(change: Partial<Place>, opts: { replace?: boolean } = {}, also: Partial<AppState> = {}) {
  writeQuery();
  const place = { ...hereNow(), ...change };
  set({ noteId: place.noteId, screen: place.screen, mobileTab: place.mobileTab, filter: place.filter, listQuery: place.listQuery, ...also });
  rememberFilter(place.filter);
  changePage(() => writeStep(place, opts.replace));
}

/** Open a note (or the page under it, for null). `hash` ("#h-section") scrolls to that heading once it loads. */
export function openNote(id: string | null, opts: { replace?: boolean; hash?: string } = {}) {
  const hash = id && opts.hash && opts.hash.length > 1 ? opts.hash : '';
  go({ noteId: id, hash, ...(id ? {} : { screen: 'home' as const }) }, opts, { drawerOpen: false, anchor: hash ? anchorOf(hash) : null });
}

export function goBack() {
  if (history.state?.kb) history.back();
  else openNote(null, { replace: true });
}

export function goHome() {
  go({ noteId: null, hash: '', screen: 'home', mobileTab: 'home' }, {}, { drawerOpen: false, anchor: null });
}

/** Every open task, across notes. */
export function openTasks() {
  go({ noteId: null, hash: '', screen: 'tasks', mobileTab: 'home' }, {}, { drawerOpen: false, anchor: null });
}

/** The note list, on phones (wider screens show it beside every page). */
export function showNotes() {
  go({ noteId: null, hash: '', screen: 'home', mobileTab: 'notes' }, {}, { drawerOpen: false, anchor: null });
}

/**
 * Which notes the list shows. Picked, it's a step in Back (and on phones, the list is shown); `replace`
 * corrects the current step instead (the tag it showed was renamed, its folder deleted).
 */
export function setFilter(filter: ListFilter, opts: { replace?: boolean } = {}) {
  if (opts.replace) {
    go({ filter, listQuery: '' }, opts);
    return;
  }
  // On a phone the list replaces the page, so Tasks gives way to it (wider, Tasks stays beside it).
  go({ filter, listQuery: '', mobileTab: 'notes', ...(phoneLayout() ? { screen: 'home' as const } : {}) }, {}, { drawerOpen: false });
}

/** Searches the list: the address follows shortly after, in the same step (typing isn't a step each). */
export function setListQuery(listQuery: string) {
  set({ listQuery });
  clearTimeout(queryTimer);
  queryTimer = setTimeout(writeQuery, 400);
}

/* ------------------------------------------------------- saved searches --- */

export function savedSearch(id: string): SavedSearch | undefined {
  return useSettings.getState().savedSearches.find((s) => s.id === id);
}

function writeSavedSearches(list: SavedSearch[]) {
  useSettings.getState().update({ savedSearches: list });
}

/**
 * Keeps `query` by a name asked for (the query itself, to start with), and shows it: it's then in the
 * sidebar, on every device. The id it got, or null if not kept.
 */
export async function saveSearch(query: string): Promise<string | null> {
  const q = query.trim().slice(0, MAX_SAVED_SEARCH_QUERY);
  if (q.length < 2) return null;
  const list = useSettings.getState().savedSearches;
  if (list.length >= MAX_SAVED_SEARCHES) {
    toast(`You can keep up to ${MAX_SAVED_SEARCHES} searches. Delete one you no longer use to keep this one.`, { kind: 'error' });
    return null;
  }
  const name = (
    await promptDialog({
      title: 'Save this search',
      message: `It goes in the sidebar, under Saved searches, and stays up to date as notes change: ${q}`,
      initial: q.slice(0, MAX_SAVED_SEARCH_NAME),
      placeholder: 'Name',
      confirmLabel: 'Save',
    })
  )?.trim();
  if (!name) return null;
  const id = newId(10);
  writeSavedSearches([...useSettings.getState().savedSearches, { id, name: name.slice(0, MAX_SAVED_SEARCH_NAME), query: q }]);
  setFilter({ kind: 'search', id });
  return id;
}

export async function renameSavedSearch(id: string) {
  const found = savedSearch(id);
  if (!found) return;
  const name = (await promptDialog({ title: 'Rename saved search', initial: found.name, placeholder: 'Name', confirmLabel: 'Rename' }))?.trim();
  if (!name || name === found.name) return;
  writeSavedSearches(useSettings.getState().savedSearches.map((s) => (s.id === id ? { ...s, name: name.slice(0, MAX_SAVED_SEARCH_NAME) } : s)));
}

export async function editSavedSearch(id: string) {
  const found = savedSearch(id);
  if (!found) return;
  const query = (
    await promptDialog({
      title: `Change what “${found.name}” finds`,
      message: 'Words, "exact words", tag:, in:, is:pinned, has:task, or -word to leave one out.',
      initial: found.query,
      placeholder: 'Search',
      confirmLabel: 'Save',
    })
  )?.trim();
  if (!query || query === found.query) return;
  if (query.length < 2) {
    toast('A saved search needs at least two characters to look for.', { kind: 'error' });
    return;
  }
  writeSavedSearches(useSettings.getState().savedSearches.map((s) => (s.id === id ? { ...s, query: query.slice(0, MAX_SAVED_SEARCH_QUERY) } : s)));
}

/** Deletes a saved search (no notes change), with Undo. */
export function deleteSavedSearch(id: string) {
  const list = useSettings.getState().savedSearches;
  const at = list.findIndex((s) => s.id === id);
  if (at < 0) return;
  const gone = list[at];
  writeSavedSearches(list.filter((s) => s.id !== id));
  const f = get().filter;
  if (f.kind === 'search' && f.id === id) setFilter({ kind: 'all' }, { replace: true });
  toast(`Deleted the saved search “${gone.name}”. Your notes are unchanged.`, {
    action: {
      label: 'Undo',
      run: () => {
        const now = useSettings.getState().savedSearches.filter((s) => s.id !== id);
        writeSavedSearches([...now.slice(0, at), gone, ...now.slice(at)]);
      },
    },
  });
}

/** The tab's title for what's shown. */
export function pageTitle(s: AppState): string {
  const secret = s.encryption.on || libraryEncrypted();
  const name = ((): string | null => {
    if (s.noteId) {
      if (secret) return 'Note';
      const note = s.notes[s.noteId];
      return note ? noteTitle(note.title) : null;
    }
    if (s.screen === 'tasks') return 'Tasks';
    if (s.mobileTab !== 'notes') return null;
    const f = s.filter;
    if (f.kind === 'all') return 'All notes';
    if (f.kind === 'pinned') return 'Pinned';
    if (f.kind === 'trash') return 'Trash';
    if (secret) return f.kind === 'folder' ? 'Folder' : f.kind === 'search' ? 'Saved search' : 'Tag';
    if (f.kind === 'folder') return s.folders.find((x) => x.id === f.id)?.name ?? 'Folder';
    if (f.kind === 'search') return savedSearch(f.id)?.name ?? 'Saved search';
    return `#${f.tag}`;
  })();
  return name ? `${name} – Lumen` : 'Lumen';
}

if (typeof window !== 'undefined') {
  // Back or Forward to another page: show what its step says.
  onPageChange(() => {
    clearTimeout(queryTimer);
    queryTimer = undefined;
    const s = get();
    const noteId = parseLocation();
    const list = listPlace({ kind: 'all' });
    const next: Partial<AppState> = { noteId, anchor: parseAnchor(), screen: parseScreen() };
    if (!noteId) next.mobileTab = parseTab();
    if (JSON.stringify(list.filter) !== JSON.stringify(s.filter)) next.filter = list.filter;
    if (list.listQuery !== s.listQuery) next.listQuery = list.listQuery;
    restoring = true;
    try {
      set(next);
    } finally {
      restoring = false;
    }
    rememberFilter(get().filter);
    // Its address brought up to date with what was restored (a search typed while something was open
    // over the page reached only this page's record), so a reload here shows the same.
    if (!layerOf(history.state)) writeStep(hereNow(), true);
  });

  // A filter changed some other way clears the search, so the list shows what was picked.
  useApp.subscribe((s, prev) => {
    if (restoring || !s.listQuery || s.listQuery !== prev.listQuery) return;
    if (JSON.stringify(s.filter) !== JSON.stringify(prev.filter)) setListQuery('');
  });

  // Encryption turned on (or found on): tag names and searches leave the address.
  useApp.subscribe((s, prev) => {
    if (s.encryption.on && !prev.encryption.on && !layerOf(history.state)) writeStep(hereNow(), true);
  });

  // The tab's title says which page this is: the note's title, say. With encryption on, only what
  // kind of page (browsers keep titles in their history, and may sync it).
  const title = () => {
    const t = pageTitle(get());
    if (document.title !== t) document.title = t;
  };
  useApp.subscribe(title);
  title();

  // This page's first step. Opened at a page other than Home (a link, a shortcut, a shared note) on a
  // phone or as an installed app, Home goes underneath it, so Back goes there before leaving Lumen,
  // as in an app. Not when opened to do something (?do=, ?share=): that's taken care of, and moves on.
  const params = new URLSearchParams(window.location.search);
  if (!params.has('do') && !params.has('share')) {
    const here = hereNow();
    const home: Place = { ...here, noteId: null, hash: '', screen: 'home', mobileTab: 'home', listQuery: '' };
    const fresh = !stepOf(history.state) && !history.state?.kb;
    if (fresh && (phoneLayout() || matches('(display-mode: standalone)')) && addressOf(home) !== addressOf(here)) {
      const step = newStep();
      unlisted.set(step, { filter: home.filter, listQuery: '' });
      history.replaceState({ kb: false, step }, '', addressOf(home));
      writeStep(here);
    } else {
      writeStep(here, true);
    }
  }
}

/* ------------------------------------------------------------ loading --- */

let welcomeAttempted = false;
let loading: Promise<void> | null = null;

/** Load folders and note metadata. Concurrent calls share one request. */
export function loadAll(silent = false): Promise<void> {
  if (!loading) loading = doLoad(silent).finally(() => (loading = null));
  return loading;
}

async function doLoad(silent: boolean) {
  try {
    const data = await api.bootstrap();
    if (!silent && !welcomeAttempted && data.notes.length === 0 && data.folders.length === 0) {
      welcomeAttempted = true;
      try {
        const { WELCOME_NOTE, WELCOME_TITLE } = await import('./welcome');
        const meta = await api.createNote({ title: WELCOME_TITLE, content: WELCOME_NOTE, tags: ['guide'], pinned: true });
        data.notes.push(meta);
      } catch {
        /* the welcome note is a nicety; carry on without it */
      }
    }
    // A refresh (each return to the tab) delivers every note as a new object. Notes that look the same
    // keep their old object, and an unchanged list keeps its identity, so only rows that changed redraw.
    const prev = get().notes;
    const offline = !!data.offline;
    const notes: Record<string, NoteMeta> = {};
    let unchanged = data.notes.length === Object.keys(prev).length;
    for (const n of data.notes) {
      const old = prev[n.id];
      // Offline, the list is the copy from when it was last fetched: a note never goes back to an
      // older version than the one known here (saved since, on this device or seen from another).
      const same = !!old && (sameMeta(old, n) || (offline && old.version > n.version));
      notes[n.id] = same ? old : n;
      if (!same) unchanged = false;
    }
    if (offline && get().status === 'ready') {
      // …and notes known here that it hasn't heard of (made this session, or since it was fetched) stay.
      for (const [id, old] of Object.entries(prev)) {
        if (!notes[id]) {
          notes[id] = old;
          unchanged = false;
        }
      }
    }
    // Text kept for a note that has moved on (saved on another device) is older than the list now: it
    // goes, as in upsertMeta, so nothing (Duplicate, a save's cached copy) takes it for the current text.
    for (const [id, cached] of noteCache) if (notes[id] && notes[id].version > cached.version) noteCache.delete(id);
    const prevFolders = get().folders;
    const sameFolders = JSON.stringify(prevFolders) === JSON.stringify(data.folders);
    // Offline, folders made since the list was fetched stay too.
    const folders = sameFolders
      ? prevFolders
      : offline
        ? [...data.folders, ...prevFolders.filter((f) => !data.folders.some((d) => d.id === f.id))]
        : data.folders;
    const p = data.encryption?.pending;
    const r = data.encryption?.rekey;
    const a = data.encryption?.attachments;
    const encryption = {
      on: !!data.encryption?.on,
      // Plaintext on the server once the library was seen fully encrypted isn't encrypted as the
      // person's own: it's listed as unreadable instead (see e2ee.ts).
      pending: p && !libraryEncrypted() ? p.notes + p.versions + p.folders : 0,
      rekey: r ? r.notes + r.versions + r.folders + (r.files ?? 0) + (r.drawings ?? 0) : 0,
      // Files and drawings saved before they were encrypted are the person's own: they're encrypted
      // once (a device that has seen them all encrypted refuses any that turn up unencrypted later).
      attachments: a && !attachmentsEncrypted() ? a.files + a.drawings : 0,
    };
    set({
      status: 'ready',
      loadError: null,
      me: data.me,
      folders,
      notes: unchanged ? prev : notes,
      // When the server was last heard from, which an offline copy isn't.
      lastSync: offline ? get().lastSync : Date.now(),
      offlineList: offline,
      encryption,
      lastBackup: data.lastBackup ?? null,
    });
    // Settings saved on another device, and this device's changes on their way (settingsSync.ts).
    void receiveSettings(data.settings, encryption.on);
  } catch (err) {
    if (silent && get().status === 'ready') return;
    set({ status: 'error', loadError: errorMessage(err) });
  }
}

const json = (v: unknown) => JSON.stringify(v ?? null);

/** The same note as far as anything shown goes (its text isn't part of the list). */
function sameMeta(a: NoteMeta, b: NoteMeta): boolean {
  return (
    a.version === b.version &&
    a.updated_at === b.updated_at &&
    a.created_at === b.created_at &&
    a.deleted_at === b.deleted_at &&
    a.pinned === b.pinned &&
    a.folder_id === b.folder_id &&
    a.title === b.title &&
    a.excerpt === b.excerpt &&
    !!a.enc === !!b.enc &&
    json(a.tags) === json(b.tags) &&
    json(a.info) === json(b.info) &&
    json(a.links) === json(b.links) &&
    a.pv === b.pv
  );
}

export function upsertMeta(meta: NoteMeta) {
  set((s) => ({ notes: { ...s.notes, [meta.id]: meta } }));
  const cached = noteCache.get(meta.id);
  // A cached text is only good at its own version: a newer one (saved on another device, say) means
  // fetching the text again, never the old text passed off as the new version.
  if (cached) {
    if (cached.version === meta.version) noteCache.set(meta.id, { ...cached, ...meta });
    else noteCache.delete(meta.id);
  }
}

export function removeMeta(id: string) {
  set((s) => {
    const notes = { ...s.notes };
    delete notes[id];
    return { notes };
  });
  noteCache.delete(id);
}

/* ------------------------------------------------------------ toasts ---- */

let toastSeq = 0;
export function toast(message: string, opts: Omit<Toast, 'id' | 'message'> = {}) {
  const id = ++toastSeq;
  set((s) => ({ toasts: [...s.toasts.slice(-3), { id, message, ...opts }] }));
  const timeout = opts.timeout ?? (opts.more?.length ? 8000 : opts.action ? 6000 : opts.kind === 'error' ? 6000 : 3200);
  if (timeout > 0) setTimeout(() => dismissToast(id), timeout);
  return id;
}
export function dismissToast(id: number) {
  set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
}
export function toastError(err: unknown) {
  toast(errorMessage(err), { kind: 'error' });
}

/* ------------------------------------------------------------ dialogs --- */

/**
 * One question at a time. A question asked while another is showing (a share offered as the app
 * opens, a command run over a question) waits its turn and shows once that one is answered, rather
 * than taking its place and leaving it unanswered, and whatever awaited it waiting, for good.
 */
const waitingDialogs: DialogRequest[] = [];

function ask(dialog: DialogRequest) {
  if (get().dialog) waitingDialogs.push(dialog);
  else set({ dialog });
}

useApp.subscribe((s, prev) => {
  if (prev.dialog && !s.dialog && waitingDialogs.length) set({ dialog: waitingDialogs.shift()! });
});

export function confirmDialog(opts: Omit<DialogRequest, 'kind' | 'resolve'>): Promise<boolean> {
  return new Promise((resolve) => ask({ kind: 'confirm', ...opts, resolve: (v) => resolve(!!v) }));
}

/** A question with two answers besides Cancel: 'confirm' (the main button), 'alt' (altLabel) or null. */
export function chooseDialog(opts: Omit<DialogRequest, 'kind' | 'resolve'> & { altLabel: string }): Promise<'confirm' | 'alt' | null> {
  return new Promise((resolve) => ask({ kind: 'confirm', ...opts, resolve: (v) => resolve(v === 'alt' ? 'alt' : v ? 'confirm' : null) }));
}

/** Something the person needs to know before going on: one button, answered by it, Escape or a click outside. */
export function noticeDialog(opts: Omit<DialogRequest, 'kind' | 'resolve' | 'notice' | 'altLabel'>): Promise<void> {
  return new Promise((resolve) => ask({ kind: 'confirm', ...opts, notice: true, resolve: () => resolve() }));
}

export function promptDialog(opts: Omit<DialogRequest, 'kind' | 'resolve'>): Promise<string | null> {
  return new Promise((resolve) => ask({ kind: 'prompt', ...opts, resolve: (v) => resolve(typeof v === 'string' ? v : null) }));
}

export function openDrawingEditor(drawingId: string | null, noteId: string | null): Promise<string | null> {
  return new Promise((resolve) => set({ drawing: { drawingId, noteId, resolve } }));
}

export function openMermaidEditor(code: string, isNew: boolean): Promise<string | null> {
  return new Promise((resolve) => set({ mermaid: { code, isNew, resolve } }));
}

export function bumpDrawing(id: string) {
  set((s) => ({ drawingRevs: { ...s.drawingRevs, [id]: Date.now() } }));
}

/* -------------------------------------------------------------- notes --- */

/**
 * A new note. With `id` (from idFor), it can be asked for again after a reply that never came without
 * making a second one (see api.createNoteOnce).
 */
export async function createNote(init: Partial<Note> = {}, opts: { open?: boolean; mode?: ViewMode; id?: string } = {}) {
  const s = get();
  const folderId = init.folder_id !== undefined ? init.folder_id : s.filter.kind === 'folder' ? s.filter.id : null;
  const tags = init.tags ?? (s.filter.kind === 'tag' ? [s.filter.tag] : []);
  const pinned = init.pinned ?? s.filter.kind === 'pinned';
  const content = init.content ?? '';
  const data = { title: init.title ?? '', content, folder_id: folderId, tags, pinned };
  const meta = opts.id ? await api.createNoteOnce({ ...data, id: opts.id }) : await api.createNote(data);
  upsertMeta(meta);
  noteCache.set(meta.id, { ...meta, content });
  if (opts.open !== false) {
    preferredMode.set(meta.id, opts.mode ?? 'edit');
    openNote(meta.id);
  }
  return meta;
}

export async function newNote() {
  try {
    await createNote();
  } catch (err) {
    toastError(err);
  }
}

export async function newDrawingNote() {
  const drawingId = await openDrawingEditor(null, null);
  if (!drawingId) return;
  try {
    await createNote(
      { title: 'Untitled drawing', content: `![Drawing](/api/drawings/${drawingId}.svg)\n` },
      { mode: 'read' },
    );
  } catch (err) {
    toastError(err);
  }
}

export async function newDiagramNote() {
  const code = await openMermaidEditor('', true);
  if (!code?.trim()) return;
  try {
    await createNote({ title: 'Untitled diagram', content: `\`\`\`mermaid\n${code.trim()}\n\`\`\`\n` }, { mode: 'edit' });
  } catch (err) {
    toastError(err);
  }
}

/** Save a quick thought from the Home screen without leaving it. */
export async function captureNote(text: string): Promise<boolean> {
  const trimmed = text.trim();
  if (!trimmed) return false;
  const [first, ...rest] = trimmed.split('\n');
  const firstPlain = first.replace(/^#+\s*|[*_`>]/g, '').replace(/^[-+]\s(\[[ xX]\]\s)?/, '').trim();
  const short = firstPlain.length <= 80;
  const title = short ? firstPlain : `${firstPlain.slice(0, 60).trim()}…`;
  const content = short ? rest.join('\n').trim() : trimmed;
  try {
    const meta = await createNote({ title, content }, { open: false });
    toast('Saved to your notes', { kind: 'success', action: { label: 'Open', run: () => openNote(meta.id) } });
    return true;
  } catch (err) {
    toastError(err);
    return false;
  }
}

export async function updateNoteMeta(id: string, patch: Partial<Pick<NoteMeta, 'folder_id' | 'tags' | 'pinned'>>) {
  const prev = get().notes[id];
  if (prev) upsertMeta({ ...prev, ...patch });
  try {
    const meta = await api.updateNote(id, patch);
    upsertMeta(meta);
  } catch (err) {
    if (prev) revertMeta(id, prev, patch);
    toastError(err);
    // The folder was deleted elsewhere: refresh so it leaves the sidebar and menus.
    if (err instanceof ApiError && err.code === 'folder_missing') void loadAll(true);
  }
}

/* ---------------------------------------------------- many at once --- */

type MetaPatch = Partial<Pick<NoteMeta, 'folder_id' | 'tags' | 'pinned'>>;

/**
 * A change that didn't save: the fields it changed go back as `prev` had them, on the note as it is
 * now, since a save of its text (a newer version and title) may have landed meanwhile.
 */
function revertMeta(id: string, prev: NoteMeta, patch: MetaPatch) {
  const now = get().notes[id];
  if (!now) return;
  const back: MetaPatch = {};
  if ('folder_id' in patch) back.folder_id = prev.folder_id;
  if ('tags' in patch) back.tags = prev.tags;
  if ('pinned' in patch) back.pinned = prev.pinned;
  upsertMeta({ ...now, ...back });
}

/** Runs `task` on each item, a few at a time. */
async function fewAtATime<T>(items: T[], task: (item: T) => Promise<void>, size = 4) {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await task(items[next++]);
  };
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, worker));
}

/**
 * Changes the folder, tags or pin of several notes: shown at once, then saved a few at a time. A note
 * that doesn't save goes back as it was, and one message says how many didn't. Returns the ids saved.
 */
export async function updateNotesMeta(changes: Array<{ id: string; patch: MetaPatch }>): Promise<string[]> {
  const before = new Map<string, NoteMeta>();
  for (const { id, patch } of changes) {
    const prev = get().notes[id];
    if (!prev) continue;
    before.set(id, prev);
    upsertMeta({ ...prev, ...patch });
  }
  const saved: string[] = [];
  let failure: unknown = null;
  let failed = 0;
  await fewAtATime(changes, async ({ id, patch }) => {
    try {
      upsertMeta(await api.updateNote(id, patch));
      saved.push(id);
    } catch (err) {
      const prev = before.get(id);
      if (prev) revertMeta(id, prev, patch);
      failure = err;
      failed++;
    }
  });
  if (failed) {
    toast(`${failed === 1 ? 'A note' : `${failed} notes`} couldn’t be changed: ${errorMessage(failure)}`, { kind: 'error' });
    if (failure instanceof ApiError && failure.code === 'folder_missing') void loadAll(true);
  }
  return saved;
}

/** Moves several notes to the trash, with Undo. */
export async function trashNotes(ids: string[]) {
  const done: string[] = [];
  let failure: unknown = null;
  await fewAtATime(ids, async (id) => {
    try {
      upsertMeta(await api.trashNote(id));
      done.push(id);
    } catch (err) {
      failure = err;
    }
  });
  if (done.includes(get().noteId ?? '')) openNote(null, { replace: true });
  if (failure) toastError(failure);
  if (!done.length) return;
  toast(`Moved ${done.length} ${done.length === 1 ? 'note' : 'notes'} to the trash`, {
    action: { label: 'Undo', run: () => void restoreNotes(done) },
  });
}

/** Takes several notes out of the trash. */
export async function restoreNotes(ids: string[]) {
  let restored = 0;
  let failure: unknown = null;
  await fewAtATime(ids, async (id) => {
    try {
      upsertMeta(await api.restoreNote(id));
      restored++;
    } catch (err) {
      failure = err;
    }
  });
  if (failure) toastError(failure);
  else if (restored) toast(`Restored ${restored} ${restored === 1 ? 'note' : 'notes'}`, { kind: 'success' });
}

/** Deletes several notes for good, after asking once. Returns whether it went ahead. */
export async function deleteNotesForever(chosen: string[]): Promise<boolean> {
  // Only notes in the trash, whatever was passed in.
  let ids = chosen.filter((id) => get().notes[id]?.deleted_at);
  const n = ids.length;
  if (!n) return false;
  const ok = await confirmDialog({
    title: `Delete ${n} ${n === 1 ? 'note' : 'notes'} forever?`,
    message: 'Their history goes with them. This can’t be undone.',
    confirmLabel: 'Delete forever',
    danger: true,
  });
  if (!ok) return false;
  // Any restored while the question was up stay.
  ids = ids.filter((id) => get().notes[id]?.deleted_at);
  const gone = ids.map((id) => get().notes[id]).filter(Boolean);
  const deleted: string[] = [];
  let failure: unknown = null;
  await fewAtATime(ids, async (id) => {
    try {
      await api.deleteNote(id);
      deleted.push(id);
    } catch (err) {
      failure = err;
    }
  });
  await forgetEdits(deleted);
  deleted.forEach(removeMeta);
  if (deleted.includes(get().noteId ?? '')) openNote(null, { replace: true });
  const counted = (k: number) => `${k} ${k === 1 ? 'note' : 'notes'}`;
  if (failure && deleted.length) toast(`Deleted ${counted(deleted.length)} forever; ${counted(ids.length - deleted.length)} couldn’t be: ${errorMessage(failure)}`, { kind: 'error' });
  else if (failure) toastError(failure);
  else toast(`Deleted ${counted(deleted.length)} forever`, { kind: 'success', ...removeFilesTheyUsed(gone.filter((n) => deleted.includes(n.id))) });
  return true;
}

/* -------------------------------------------------------------- tags --- */

const sameTag = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** Notes with a tag (in any case), trashed ones too, so a renamed or removed tag is gone everywhere. */
export function notesTagged(tag: string): NoteMeta[] {
  return Object.values(get().notes).filter((n) => n.tags.some((t) => sameTag(t, tag)));
}

/** Puts the tags of `notes` back as `before` had them (Undo). */
function restoreTags(before: Array<{ id: string; tags: string[] }>) {
  void updateNotesMeta(before.map(({ id, tags }) => ({ id, patch: { tags } })));
}

/**
 * Renames a tag on every note that has it. Renaming it to a tag that's already used merges the two,
 * after asking. With Undo. `to` is cleaned like any tag (no #, spaces become dashes).
 */
export async function renameTag(from: string, raw: string) {
  const to = cleanTags([raw])[0] ?? '';
  if (!to || to === from) return;
  const notes = notesTagged(from).filter((n) => !n.tagsUnreadable);
  if (!notes.length) return;
  const merging = !sameTag(from, to) && Object.values(get().notes).some((n) => n.tags.some((t) => sameTag(t, to)));
  if (merging) {
    const ok = await confirmDialog({
      title: `Merge #${from} into #${to}?`,
      message: `#${to} is already a tag. ${notes.length === 1 ? `The note tagged #${from} gets` : `The ${notes.length} notes tagged #${from} get`} #${to} instead.`,
      confirmLabel: 'Merge tags',
    });
    if (!ok) return;
  }
  const before = notes.map((n) => ({ id: n.id, tags: n.tags }));
  const changes = notes.map((n) => {
    const tags: string[] = [];
    for (const t of n.tags.map((t) => (sameTag(t, from) ? to : t))) if (!tags.some((x) => sameTag(x, t))) tags.push(t);
    return { id: n.id, patch: { tags } };
  });
  const s = get();
  if (s.filter.kind === 'tag' && sameTag(s.filter.tag, from)) setFilter({ kind: 'tag', tag: to }, { replace: true });
  const saved = await updateNotesMeta(changes);
  if (!saved.length) return;
  toast(`${merging ? 'Merged' : 'Renamed'} #${from} ${merging ? 'into' : 'to'} #${to} in ${saved.length} ${saved.length === 1 ? 'note' : 'notes'}`, {
    kind: 'success',
    action: { label: 'Undo', run: () => restoreTags(before.filter((b) => saved.includes(b.id))) },
  });
}

/** Asks for a tag's new name, then renames it. */
export async function promptRenameTag(tag: string) {
  const name = await promptDialog({ title: `Rename #${tag}`, initial: tag, confirmLabel: 'Rename', placeholder: 'New tag name' });
  if (name?.trim()) await renameTag(tag, name);
}

/** Removes a tag from every note that has it, after asking. With Undo. The notes stay. */
export async function removeTag(tag: string) {
  const notes = notesTagged(tag).filter((n) => !n.tagsUnreadable);
  if (!notes.length) return;
  const ok = await confirmDialog({
    title: `Remove #${tag}?`,
    message: `It comes off ${notes.length} ${notes.length === 1 ? 'note' : 'notes'}. The notes themselves stay.`,
    confirmLabel: 'Remove tag',
    danger: true,
  });
  if (!ok) return;
  const before = notes.map((n) => ({ id: n.id, tags: n.tags }));
  const s = get();
  if (s.filter.kind === 'tag' && sameTag(s.filter.tag, tag)) setFilter({ kind: 'all' }, { replace: true });
  const saved = await updateNotesMeta(notes.map((n) => ({ id: n.id, patch: { tags: n.tags.filter((t) => !sameTag(t, tag)) } })));
  if (!saved.length) return;
  toast(`Removed #${tag} from ${saved.length} ${saved.length === 1 ? 'note' : 'notes'}`, {
    action: { label: 'Undo', run: () => restoreTags(before.filter((b) => saved.includes(b.id))) },
  });
}

export async function trashNote(id: string) {
  try {
    const meta = await api.trashNote(id);
    upsertMeta(meta);
    if (get().noteId === id) openNote(null, { replace: true });
    toast('Moved to trash', {
      more: [{ label: 'Delete forever', danger: true, run: () => void deleteNoteForever(id) }],
      action: {
        label: 'Undo',
        run: () => void restoreNote(id, true),
      },
    });
  } catch (err) {
    toastError(err);
  }
}

export async function restoreNote(id: string, reopen = false) {
  try {
    const meta = await api.restoreNote(id);
    upsertMeta(meta);
    if (reopen) openNote(id);
    else toast('Note restored', { kind: 'success' });
  } catch (err) {
    toastError(err);
  }
}

export async function deleteNoteForever(id: string) {
  const ok = await confirmDialog({
    title: 'Delete this note forever?',
    message: 'Its history goes with it. This can’t be undone.',
    confirmLabel: 'Delete forever',
    danger: true,
  });
  if (!ok) return;
  const note = get().notes[id];
  try {
    await api.deleteNote(id);
    await forgetEdits([id]);
    const offer = removeFilesTheyUsed(note ? [note] : []);
    removeMeta(id);
    if (get().noteId === id) openNote(null, { replace: true });
    toast('Note deleted forever', { kind: 'success', ...offer });
  } catch (err) {
    toastError(err);
  }
}

/**
 * Notes deleted for good leave their pictures, files and drawings in storage until nothing links to
 * them: removing those is offered right then, with the message, when any of the notes had any (the same
 * check and question as Settings → Data → Remove unused files, which loads only if it's chosen).
 */
function removeFilesTheyUsed(notes: NoteMeta[]): { action?: ToastAction; timeout?: number } {
  const had = notes.some(
    (n) => n.info?.th || n.info?.im || n.info?.dr || /\/api\/(?:files|drawings)\//.test(noteCache.get(n.id)?.content ?? ''),
  );
  if (!had) return {};
  return { timeout: 10_000, action: { label: 'Remove unused files', run: () => void import('./cleanup').then((m) => m.removeUnusedFilesNow()) } };
}

/** Drop unsent edits for notes deleted on purpose, so they're never sent, retried or "rescued" later. */
async function forgetEdits(ids: string[]) {
  const { forget } = await import('./saver');
  ids.forEach(forget);
}

/** Quietly remove a note that was left completely empty, if it's still at `version` on the server. */
export async function discardEmptyNote(id: string, version: number) {
  try {
    const { forget, pendingText } = await import('./saver');
    if (pendingText(id)) return;
    const { deleted } = await api.deleteNote(id, { ifVersion: version });
    if (!deleted) return;
    forget(id);
    removeMeta(id);
  } catch {
    /* leave it; the user can delete it themselves */
  }
}

export async function emptyTrash() {
  const trashed = Object.values(get().notes)
    .filter((n) => n.deleted_at)
    .map((n) => n.id);
  const count = trashed.length;
  if (!count) return;
  const ok = await confirmDialog({
    title: `Delete ${count} ${count === 1 ? 'note' : 'notes'} forever?`,
    message: 'Everything in the trash is removed permanently.',
    confirmLabel: 'Empty trash',
    danger: true,
  });
  if (!ok) return;
  try {
    await api.emptyTrash();
    await forgetEdits(trashed);
    const offer = removeFilesTheyUsed(trashed.map((id) => get().notes[id]).filter(Boolean));
    set((s) => ({ notes: Object.fromEntries(Object.entries(s.notes).filter(([, n]) => !n.deleted_at)) }));
    toast('Trash emptied', { kind: 'success', ...offer });
  } catch (err) {
    toastError(err);
  }
}

export async function duplicateNote(id: string) {
  try {
    const src = noteCache.get(id) ?? (await api.getNote(id));
    await createNote({
      title: `${src.title || 'Untitled'} (copy)`,
      content: src.content,
      folder_id: src.folder_id,
      tags: src.tags,
    });
  } catch (err) {
    toastError(err);
  }
}

/* ------------------------------------------------------------ folders --- */

export async function createFolder(parentId: string | null = null): Promise<Folder | null> {
  const name = await promptDialog({
    title: parentId ? 'New subfolder' : 'New folder',
    placeholder: 'Folder name',
    confirmLabel: 'Create folder',
  });
  if (!name?.trim()) return null;
  try {
    const folder = await api.createFolder({ name: name.trim(), parent_id: parentId });
    set((s) => ({ folders: [...s.folders, folder] }));
    return folder;
  } catch (err) {
    toastError(err);
    return null;
  }
}

export async function renameFolder(folder: Folder) {
  const name = await promptDialog({ title: 'Rename folder', initial: folder.name, confirmLabel: 'Rename' });
  if (!name?.trim() || name.trim() === folder.name) return;
  try {
    const updated = await api.updateFolder(folder.id, { name: name.trim() });
    set((s) => ({ folders: s.folders.map((f) => (f.id === folder.id ? updated : f)) }));
  } catch (err) {
    toastError(err);
  }
}

export async function moveFolder(folder: Folder, parentId: string | null) {
  try {
    const updated = await api.updateFolder(folder.id, { parent_id: parentId });
    set((s) => ({ folders: s.folders.map((f) => (f.id === folder.id ? updated : f)) }));
  } catch (err) {
    toastError(err);
  }
}

export function folderDescendants(folders: Folder[], id: string): Set<string> {
  const out = new Set<string>([id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const f of folders) {
      if (f.parent_id && out.has(f.parent_id) && !out.has(f.id)) {
        out.add(f.id);
        grew = true;
      }
    }
  }
  return out;
}

export async function deleteFolder(folder: Folder) {
  const s = get();
  const ids = folderDescendants(s.folders, folder.id);
  const count = Object.values(s.notes).filter((n) => !n.deleted_at && n.folder_id && ids.has(n.folder_id)).length;
  const ok = await confirmDialog({
    title: `Delete “${folder.name}”?`,
    message:
      count > 0
        ? `${count} ${count === 1 ? 'note moves' : 'notes move'} to the trash, along with any subfolders.`
        : 'The folder is empty. Any subfolders are removed too.',
    confirmLabel: 'Delete folder',
    danger: true,
  });
  if (!ok) return;
  try {
    await api.deleteFolder(folder.id);
    if (s.filter.kind === 'folder' && ids.has(s.filter.id)) setFilter({ kind: 'all' }, { replace: true });
    await loadAll(true);
  } catch (err) {
    toastError(err);
  }
}

export function folderPath(folders: Folder[], id: string | null): Folder[] {
  const byId = new Map(folders.map((f) => [f.id, f]));
  const out: Folder[] = [];
  let cur = id ? byId.get(id) : undefined;
  let guard = 0;
  while (cur && guard++ < 50) {
    out.unshift(cur);
    cur = cur.parent_id ? byId.get(cur.parent_id) : undefined;
  }
  return out;
}

/* -------------------------------------------------------- daily note ---- */

/** Today's journal entry, made from the journal template if there isn't one yet (see journal.ts). */
export async function openDailyNote() {
  const { openJournal } = await import('./journal');
  await openJournal(todayIso());
}

/* ------------------------------------------------------- background ----- */

/*
 * Picking this device up again: the note list is refreshed, so what was saved on another device shows
 * (the open note follows its version, see NoteView) before anything is typed on top of older text. On
 * the tab coming back, the window getting focus, a page restored from the back/forward cache, the
 * connection coming back, and the first touch or key after a minute without either (a window that kept
 * focus while the person was on their phone).
 */
const REFRESH_GAP_MS = 10_000;
const IDLE_MS = 60_000;

function refreshIfStale() {
  const s = get();
  if (s.status === 'ready' && Date.now() - s.lastSync > REFRESH_GAP_MS) void loadAll(true);
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') refreshIfStale();
});
window.addEventListener('focus', refreshIfStale);
window.addEventListener('pageshow', (e) => {
  if (e.persisted) refreshIfStale();
});
window.addEventListener('online', refreshIfStale);
onReachabilityChange((reachable) => {
  if (reachable) refreshIfStale();
});
let lastActive = Date.now();
const onActivity = () => {
  const now = Date.now();
  if (now - lastActive > IDLE_MS) refreshIfStale();
  lastActive = now;
};
window.addEventListener('pointerdown', onActivity, { capture: true, passive: true });
window.addEventListener('keydown', onActivity, { capture: true });

export function isOfflineError(err: unknown) {
  return err instanceof NetworkError;
}
