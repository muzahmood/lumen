import { create } from 'zustand';
import { useEffect, useState } from 'react';
import type { SortKey, ViewMode } from './types';

export type Accent = 'iris' | 'green' | 'indigo' | 'teal' | 'amber' | 'rose' | 'graphite';

export const ACCENTS: Record<Accent, { label: string; light: string; dark: string; onLight: string; onDark: string }> = {
  // Key kept as "iris" so saved settings carry over; this is the Lumen ink blue.
  // (A saved "blue" from earlier versions isn't listed any more and falls back to this, its closest match.)
  iris: { label: 'Lumen', light: '#1E4E80', dark: '#7EB0E6', onLight: '#FFFFFF', onDark: '#0B1119' },
  green: { label: 'Green', light: '#1F6B50', dark: '#62BF97', onLight: '#FFFFFF', onDark: '#0E1412' },
  indigo: { label: 'Indigo', light: '#5154E6', dark: '#8C8FFF', onLight: '#FFFFFF', onDark: '#0D0D18' },
  teal: { label: 'Teal', light: '#0C8276', dark: '#2FC7B4', onLight: '#FFFFFF', onDark: '#032520' },
  amber: { label: 'Amber', light: '#AF5F00', dark: '#F5A524', onLight: '#FFFFFF', onDark: '#221400' },
  rose: { label: 'Rose', light: '#D2355A', dark: '#F2668A', onLight: '#FFFFFF', onDark: '#2A0710' },
  graphite: { label: 'Graphite', light: '#2E3038', dark: '#D7D8DD', onLight: '#FFFFFF', onDark: '#15161A' },
};

export interface Settings {
  theme: 'system' | 'light' | 'dark';
  accent: Accent;
  noteFont: 'sans' | 'serif' | 'mono';
  fontSize: number;
  readingWidth: 'narrow' | 'normal' | 'wide';
  defaultMode: ViewMode;
  livePreview: boolean;
  lineBreaks: boolean;
  editorImages: boolean;
  spellcheck: boolean;
  compressImages: boolean;
  workspaceName: string;
  sort: SortKey;
  listPreviews: boolean;
  expandedFolders: string[];
  tagsOpen: boolean;
  sidebarWidth: number;
  listWidth: number;
  sidebarCollapsed: boolean;
  showOutline: boolean;
  /** The Export dialog remembers its last choices. */
  exportFormat: 'pdf' | 'md';
  /** null: A4 or Letter by the browser's region. */
  exportPaper: 'a4' | 'letter' | null;
  exportTitle: boolean;
  exportDetails: boolean;
  exportAttachments: boolean;
  exportFrontMatter: boolean;
  /** With end-to-end encryption on: lock after this many minutes without use (0: stay unlocked). */
  autoLockMinutes: number;
  /** Images from other websites in notes: shown as they load, or only once clicked (each request tells that site you opened the note). */
  remoteImages: 'load' | 'ask';
  /** Where Home's quick capture puts what's typed: a new note, or today's journal entry. */
  captureTo: 'note' | 'journal';
  /** The list's search, while a folder or tag is open: only in it, or every note. */
  searchHere: boolean;
  /** Searches kept by name, shown in the sidebar like folders (encrypted with the library when it is). */
  savedSearches: SavedSearch[];
  /** Which ticked tasks get the day they were ticked (✅ 2026-11-20): with a due date or repeat, all, or none. */
  taskDoneDates: 'dated' | 'all' | 'off';
  /** A backup kept on the server about once a week, made by whichever device is open (when set up). */
  autoBackup: boolean;
}

export interface SavedSearch {
  id: string;
  name: string;
  /** In the search language (src/lib/searchQuery.ts): words, "phrases", tag:, in:, is:, has:, -word. */
  query: string;
}

export const MAX_SAVED_SEARCHES = 50;
export const MAX_SAVED_SEARCH_NAME = 60;
export const MAX_SAVED_SEARCH_QUERY = 500;

export const DEFAULT_SIDEBAR_WIDTH = 252;
export const DEFAULT_LIST_WIDTH = 336;

const DEFAULTS: Settings = {
  theme: 'system',
  accent: 'iris',
  noteFont: 'sans',
  fontSize: 16,
  readingWidth: 'normal',
  defaultMode: 'edit',
  livePreview: true,
  lineBreaks: true,
  editorImages: true,
  spellcheck: true,
  compressImages: true,
  workspaceName: 'Lumen',
  sort: 'updated',
  listPreviews: true,
  expandedFolders: [],
  tagsOpen: true,
  sidebarWidth: DEFAULT_SIDEBAR_WIDTH,
  listWidth: DEFAULT_LIST_WIDTH,
  sidebarCollapsed: false,
  showOutline: true,
  exportFormat: 'pdf',
  exportPaper: null,
  exportTitle: true,
  exportDetails: false,
  exportAttachments: true,
  exportFrontMatter: false,
  autoLockMinutes: 0,
  remoteImages: 'load',
  captureTo: 'note',
  searchHere: false,
  savedSearches: [],
  taskDoneDates: 'dated',
  autoBackup: true,
};

type Rule<T> = (v: unknown) => T | undefined;
const oneOf =
  <T extends string | null>(...values: readonly T[]): Rule<T> =>
  (v) =>
    values.includes(v as T) ? (v as T) : undefined;
const bool: Rule<boolean> = (v) => (typeof v === 'boolean' ? v : undefined);
/** A whole number brought into [min, max]; anything that isn't a number doesn't fit. */
const between =
  (min: number, max: number): Rule<number> =>
  (v) =>
    typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, Math.round(v))) : undefined;

/**
 * What each setting may hold, as the screens that change them allow. A value that doesn't fit
 * (another device's, from a different version of Lumen or damaged on the way, or one left in this
 * browser) is dropped, so the setting keeps its current or default value instead of breaking a
 * screen: an unknown view mode, say, would show a note as neither text nor reading view.
 */
const RULES: { [K in keyof Settings]: Rule<Settings[K]> } = {
  theme: oneOf('system', 'light', 'dark'),
  accent: (v) => (typeof v === 'string' && Object.hasOwn(ACCENTS, v) ? (v as Accent) : undefined),
  noteFont: oneOf('sans', 'serif', 'mono'),
  fontSize: between(14, 21),
  readingWidth: oneOf('narrow', 'normal', 'wide'),
  defaultMode: oneOf('edit', 'split', 'read'),
  livePreview: bool,
  lineBreaks: bool,
  editorImages: bool,
  spellcheck: bool,
  compressImages: bool,
  workspaceName: (v) => (typeof v === 'string' ? v.slice(0, 40) : undefined),
  sort: oneOf('updated', 'created', 'title'),
  listPreviews: bool,
  expandedFolders: (v) => (Array.isArray(v) ? v.filter((id): id is string => typeof id === 'string') : undefined),
  tagsOpen: bool,
  sidebarWidth: between(200, 360),
  listWidth: between(260, 520),
  sidebarCollapsed: bool,
  showOutline: bool,
  exportFormat: oneOf('pdf', 'md'),
  exportPaper: oneOf('a4', 'letter', null),
  exportTitle: bool,
  exportDetails: bool,
  exportAttachments: bool,
  exportFrontMatter: bool,
  autoLockMinutes: between(0, 7 * 24 * 60),
  remoteImages: oneOf('load', 'ask'),
  captureTo: oneOf('note', 'journal'),
  searchHere: bool,
  taskDoneDates: oneOf('dated', 'all', 'off'),
  autoBackup: bool,
  savedSearches: (v) => {
    if (!Array.isArray(v)) return undefined;
    const out: SavedSearch[] = [];
    for (const item of v) {
      if (!item || typeof item !== 'object') continue;
      const { id, name, query } = item as Record<string, unknown>;
      if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,32}$/.test(id) || out.some((s) => s.id === id)) continue;
      if (typeof name !== 'string' || typeof query !== 'string') continue;
      const n = name.trim().slice(0, MAX_SAVED_SEARCH_NAME);
      const q = query.trim().slice(0, MAX_SAVED_SEARCH_QUERY);
      if (n && q.length >= 2) out.push({ id, name: n, query: q });
      if (out.length >= MAX_SAVED_SEARCHES) break;
    }
    return out;
  },
};

/** The settings in `values` that fit RULES (numbers brought into range); everything else left out. */
export function validSettings(values: unknown): Partial<Settings> {
  const out: Partial<Record<keyof Settings, unknown>> = {};
  if (!values || typeof values !== 'object' || Array.isArray(values)) return out as Partial<Settings>;
  for (const key of Object.keys(RULES) as (keyof Settings)[]) {
    if (!Object.hasOwn(values, key)) continue;
    const v = RULES[key]((values as Record<string, unknown>)[key]);
    if (v !== undefined) out[key] = v;
  }
  return out as Partial<Settings>;
}

const KEY = 'kb.settings';

function load(): Settings {
  try {
    const stored = JSON.parse(localStorage.getItem(KEY) || '{}') as unknown;
    const merged = { ...DEFAULTS, ...validSettings(stored) };
    // Called editorFont before it applied to reading view too.
    const legacyFont = stored && typeof stored === 'object' ? RULES.noteFont((stored as { editorFont?: unknown }).editorFont) : undefined;
    if (legacyFont && !Object.hasOwn(stored as object, 'noteFont')) merged.noteFont = legacyFont;
    // Earlier default names become the current one; a custom name is left alone.
    if (merged.workspaceName === 'Knowledgebase' || merged.workspaceName === 'Constella') merged.workspaceName = 'Lumen';
    return merged;
  } catch {
    return { ...DEFAULTS };
  }
}

type SettingsStore = Settings & { update: (patch: Partial<Settings>) => void };

export const useSettings = create<SettingsStore>((set) => ({
  ...load(),
  update(patch) {
    set(patch);
    // Only the changed settings, merged into what's stored now: writing this tab's whole copy would
    // undo changes made in another tab since this one opened (say, auto-lock turned on there).
    let stored: Partial<Settings> = {};
    try {
      stored = (JSON.parse(localStorage.getItem(KEY) || '{}') as Partial<Settings>) ?? {};
    } catch {
      /* unreadable: start from the changes */
    }
    try {
      localStorage.setItem(KEY, JSON.stringify({ ...stored, ...patch }));
    } catch {
      /* storage may be unavailable (private mode); settings stay in memory */
    }
  },
}));

/** True while a change made in another tab is being applied here (that tab sends it to other devices). */
export let settingsFromOtherTab = false;

// A change made in another tab applies here too.
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key !== KEY) return;
    // Not a change made here: another device's settings arriving (settingsSync.ts) leave it alone.
    settingsFromOtherTab = true;
    try {
      useSettings.setState(load());
    } finally {
      settingsFromOtherTab = false;
    }
  });
}

// Not every environment has matchMedia (tests in jsdom): then there's no system theme to follow.
const darkQuery = typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-color-scheme: dark)') : null;

export function useResolvedTheme(): 'light' | 'dark' {
  const theme = useSettings((s) => s.theme);
  const [systemDark, setSystemDark] = useState(() => darkQuery?.matches ?? false);
  useEffect(() => {
    if (!darkQuery) return;
    const fn = () => setSystemDark(darkQuery.matches);
    darkQuery.addEventListener('change', fn);
    return () => darkQuery.removeEventListener('change', fn);
  }, []);
  if (theme === 'system') return systemDark ? 'dark' : 'light';
  return theme;
}

/** Whether a media query matches, kept up to date. False where there's no matchMedia (an embedded view). */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => typeof window.matchMedia === 'function' && window.matchMedia(query).matches);
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia(query);
    const fn = () => setMatches(mq.matches);
    fn();
    mq.addEventListener('change', fn);
    return () => mq.removeEventListener('change', fn);
  }, [query]);
  return matches;
}

export const isTouchDevice = () => typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches;
