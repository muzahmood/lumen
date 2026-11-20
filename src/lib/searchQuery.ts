/**
 * What a search asks for, read from what was typed (no app state, so it can be tested on its own):
 *
 *   words            notes with words starting with each (as before)
 *   "exact words"    those words in that order
 *   tag:work  #work  tagged work (or a tag under it: work/clients)
 *   in:Projects      in a folder of that name, or any folder inside it; in:"Home stuff" for spaces,
 *                    in:Projects/Clients for a path
 *   is:pinned  is:journal  is:template
 *   has:task (an open task)  has:done (a ticked one)  has:image  has:drawing  has:diagram
 *   -anything        leaves out what it would find: -tag:draft, -is:pinned, -word, -"a phrase"
 *
 * A filter on its own lists every note it matches, most recently edited first.
 */
import type { Folder, NoteMeta } from './types';

export type FilterKind = 'tag' | 'in' | 'is' | 'has';

export interface SearchFilter {
  kind: FilterKind;
  value: string;
  not: boolean;
}

export interface ParsedQuery {
  /** Words each matched as the start of a word. */
  words: string[];
  /** Words matched together, in order. */
  phrases: string[];
  /** Words and phrases a note mustn't have. */
  without: string[];
  filters: SearchFilter[];
}

export const IS_VALUES = ['pinned', 'journal', 'template'] as const;
export const HAS_VALUES = ['task', 'done', 'image', 'drawing', 'diagram'] as const;

/** Lowercase, without accents: how filter values are compared. */
export const loose = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().trim();

/** A filter's value as compared: is: and has: lowercase, has: singular (has:tasks is has:task). */
function normalValue(kind: string, value: string): string {
  const v = kind === 'tag' ? value.trim().replace(/^#+/, '') : value.trim();
  if (kind === 'is') return v.toLowerCase();
  if (kind === 'has') return v.toLowerCase().replace(/s$/, '');
  return v;
}

function knownFilter(kind: string, value: string): kind is FilterKind {
  const v = normalValue(kind, value);
  // A name (in:/ alone names nothing).
  if (kind === 'tag' || kind === 'in') return /[\p{L}\p{N}]/u.test(v);
  if (kind === 'is') return (IS_VALUES as readonly string[]).includes(v);
  if (kind === 'has') return (HAS_VALUES as readonly string[]).includes(v);
  return false;
}

export function parseQuery(input: string): ParsedQuery {
  const out: ParsedQuery = { words: [], phrases: [], without: [], filters: [] };
  // -?  then key:"quoted" | key:value | "phrase" | word
  const token = /(-?)(?:([A-Za-z]+):"([^"]*)"?|"([^"]*)"?|(\S+))/g;
  const text = input.replace(/[\u0000-\u001f]/g, ' ').slice(0, 300);
  let m: RegExpExecArray | null;
  while ((m = token.exec(text))) {
    const not = m[1] === '-';
    if (m[2] !== undefined) {
      const kind = m[2].toLowerCase();
      const value = m[3].trim();
      if (knownFilter(kind, value)) out.filters.push({ kind, value: normalValue(kind, value), not });
      else if (value) (not ? out.without : out.phrases).push(value);
      continue;
    }
    if (m[4] !== undefined) {
      // Quoted words match as they are (whole words, in order), never as the start of a longer one.
      const phrase = m[4].replace(/\s+/g, ' ').trim();
      if (/[\p{L}\p{N}]/u.test(phrase)) (not ? out.without : out.phrases).push(phrase);
      continue;
    }
    let word = m[5];
    // Punctuation on its own ("-", "&") finds nothing.
    if (!/[\p{L}\p{N}]/u.test(word)) continue;
    const colon = /^([A-Za-z]+):(.+)$/.exec(word);
    if (colon && knownFilter(colon[1].toLowerCase(), colon[2])) {
      const kind = colon[1].toLowerCase() as FilterKind;
      out.filters.push({ kind, value: normalValue(kind, colon[2]), not });
      continue;
    }
    if (word.startsWith('#') && word.length > 1) {
      out.filters.push({ kind: 'tag', value: word.replace(/^#+/, ''), not });
      continue;
    }
    word = word.replace(/"/g, '');
    if (word) (not ? out.without : out.words).push(word);
  }
  return out;
}

export const hasText = (q: ParsedQuery) => q.words.length > 0 || q.phrases.length > 0;
export const isEmpty = (q: ParsedQuery) => !hasText(q) && !q.without.length && !q.filters.length;

/** The text part, for the server's full-text search: word "a phrase" -word -"a phrase". */
export function serverText(q: ParsedQuery): string {
  const quote = (s: string) => (/\s/.test(s) ? `"${s}"` : s);
  return [...q.words, ...q.phrases.map((p) => `"${p}"`), ...q.without.map((w) => `-${quote(w)}`)].join(' ');
}

/** Each folder's path of names from the top, "Projects/Clients/Acme", compared loosely. */
function folderPaths(folders: Folder[]): Map<string, string> {
  const byId = new Map(folders.map((f) => [f.id, f]));
  const out = new Map<string, string>();
  for (const f of folders) {
    const names: string[] = [];
    for (let at: Folder | undefined = f, guard = 0; at && guard < 64; at = at.parent_id ? byId.get(at.parent_id) : undefined, guard++) names.unshift(loose(at.name));
    out.set(f.id, names.join('/'));
  }
  return out;
}

/** The folders `in:value` names, with every folder inside them. */
export function foldersNamed(folders: Folder[], value: string): Set<string> {
  const want = loose(value).replace(/^\/+|\/+$/g, '');
  const paths = folderPaths(folders);
  const matches = (exact: boolean) =>
    folders.filter((f) => {
      const path = paths.get(f.id) ?? '';
      const name = path.slice(path.lastIndexOf('/') + 1);
      if (want.includes('/')) return exact ? path === want || path.endsWith(`/${want}`) : path.startsWith(want) || path.includes(`/${want}`);
      return exact ? name === want : name.startsWith(want);
    });
  // An exact name first; failing that, folders whose name starts with it.
  const roots = matches(true).length ? matches(true) : matches(false);
  const out = new Set<string>();
  let frontier = roots.map((f) => f.id);
  frontier.forEach((id) => out.add(id));
  while (frontier.length) {
    const next = folders.filter((f) => f.parent_id && frontier.includes(f.parent_id) && !out.has(f.id)).map((f) => f.id);
    next.forEach((id) => out.add(id));
    frontier = next;
  }
  return out;
}

export interface FilterContext {
  folders: Folder[];
  isJournal: (n: NoteMeta) => boolean;
  isTemplate: (n: NoteMeta) => boolean;
}

/** Whether a note passes every filter (and the extra `scope`, if given), from what the note list knows of it. */
export function noteFilter(q: ParsedQuery, ctx: FilterContext): (n: NoteMeta) => boolean {
  const checks = q.filters.map((f) => {
    let test: (n: NoteMeta) => boolean;
    if (f.kind === 'tag') {
      const want = loose(f.value);
      test = (n) => n.tags.some((t) => {
        const tag = loose(t);
        return tag === want || tag.startsWith(`${want}/`);
      });
    } else if (f.kind === 'in') {
      const ids = foldersNamed(ctx.folders, f.value);
      test = (n) => !!n.folder_id && ids.has(n.folder_id);
    } else if (f.kind === 'is') {
      const v = f.value.toLowerCase();
      test = v === 'pinned' ? (n) => n.pinned : v === 'journal' ? ctx.isJournal : ctx.isTemplate;
    } else {
      const v = f.value;
      test =
        v === 'task'
          ? (n) => !!n.info?.t && n.info.t[0] < n.info.t[1]
          : v === 'done'
            ? (n) => !!n.info?.t && n.info.t[0] > 0
            : v === 'image'
              ? // A summary made before pictures were counted has only the thumbnail, which can be a drawing.
                (n) => (n.info?.im !== undefined ? n.info.im > 0 : !!n.info?.th && !n.info.th.startsWith('/api/drawings/'))
              : v === 'drawing'
                ? (n) => !!n.info?.dr
                : (n) => !!n.info?.d;
    }
    return f.not ? (n: NoteMeta) => !test(n) : test;
  });
  return (n) => checks.every((c) => c(n));
}
