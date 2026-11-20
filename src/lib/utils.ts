import { texToText } from '../../shared/noteText';

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';

export function newId(length = 14): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  let out = '';
  for (const b of bytes) out += ALPHABET[b % 62];
  return out;
}

/**
 * Asks the browser not to clear this site's storage when space runs low (or, in Safari, after a week
 * without a visit). It holds unsent edits, the encrypted copy of every note, and what this device knows
 * about the library being encrypted. Asked only where it matters (unlocking the device, the installed
 * app), since Firefox asks the person about it; other browsers decide by themselves.
 */
export function keepStorage(): void {
  try {
    const storage = typeof navigator === 'undefined' ? undefined : navigator.storage;
    if (!storage?.persist || !storage.persisted) return;
    void storage
      .persisted()
      .then((kept) => (kept ? undefined : storage.persist()))
      .catch(() => undefined);
  } catch {
    /* not offered here */
  }
}

/**
 * The id of something made from `base` for `purpose` (the copy saving edits to a deleted note, say):
 * the same every time, on every device, so sending it again after a reply that never came finds the
 * first one rather than making a second. Never one newId makes (those have no "_"). A base that isn't
 * an id of the usual kind gets a random id instead.
 */
export function idFor(base: string, purpose: string): string {
  const id = `${base}_${purpose}`;
  return /^[A-Za-z0-9_-]{6,64}$/.test(id) ? id : newId();
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

export function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^\p{L}\p{N}\s-]/gu, '')
      .trim()
      // Runs of spaces and dashes are one dash, so "Pros -- cons" (written in a link) reaches the
      // heading whose "--" typography turned into "–" (dropped above).
      .replace(/[\s-]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 80) || 'section'
  );
}

const rtf = typeof Intl !== 'undefined' ? new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' }) : null;

/**
 * Date formatters, made once each. toLocaleDateString(…, options) builds a new formatter on every
 * call, which a note list of thousands of rows does on every render (hundreds of ms per render).
 */
const formatters = new Map<string, Intl.DateTimeFormat>();
function dateFormat(opts: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = JSON.stringify(opts);
  let f = formatters.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat(undefined, opts);
    formatters.set(key, f);
  }
  return f;
}

/** Sorting by title: one shared collator (localeCompare with options builds one per comparison). */
export const titleCollator = new Intl.Collator(undefined, { sensitivity: 'base' });

export function relativeTime(ts: number, now = Date.now()): string {
  const diff = ts - now;
  const abs = Math.abs(diff);
  const min = 60_000;
  const hour = 60 * min;
  const day = 24 * hour;
  if (abs < min) return 'just now';
  if (!rtf) return new Date(ts).toLocaleString();
  if (abs < hour) return rtf.format(Math.round(diff / min), 'minute');
  if (abs < day) return rtf.format(Math.round(diff / hour), 'hour');
  if (abs < 7 * day) return rtf.format(Math.round(diff / day), 'day');
  const d = new Date(ts);
  const sameYear = d.getFullYear() === new Date(now).getFullYear();
  return dateFormat({ month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }) }).format(d);
}

function startOfDay(ts: number) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Midnight `days` calendar days before the midnight `day` (not days × 24 hours: clocks change). */
function daysBefore(day: number, days: number) {
  const d = new Date(day);
  d.setDate(d.getDate() - days);
  return d.getTime();
}

/** Compact timestamp for list rows: "2:14 PM", "Yesterday", "Mon", "Nov 3". */
export function shortTime(ts: number, now = Date.now()): string {
  const d = new Date(ts);
  const today = startOfDay(now);
  if (ts >= today) return dateFormat({ hour: 'numeric', minute: '2-digit' }).format(d);
  if (ts >= daysBefore(today, 1)) return 'Yesterday';
  if (ts >= daysBefore(today, 6)) return dateFormat({ weekday: 'short' }).format(d);
  const sameYear = d.getFullYear() === new Date(now).getFullYear();
  return dateFormat({ month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }) }).format(d);
}

/** Section a note list falls under when sorted by date. */
export function dateGroup(ts: number, now = Date.now()): string {
  const today = startOfDay(now);
  if (ts >= today) return 'Today';
  if (ts >= daysBefore(today, 1)) return 'Yesterday';
  if (ts >= daysBefore(today, 7)) return 'Previous 7 days';
  if (ts >= daysBefore(today, 30)) return 'Previous 30 days';
  const d = new Date(ts);
  const sameYear = d.getFullYear() === new Date(now).getFullYear();
  return dateFormat({ month: 'long', ...(sameYear ? {} : { year: 'numeric' }) }).format(d);
}

export function greeting(d = new Date()): string {
  const h = d.getHours();
  if (h < 5) return 'Working late';
  if (h < 12) return 'Good morning';
  if (h >= 12 && h < 18) return 'Good afternoon';
  return 'Good evening';
}

export function initialOf(text: string | null | undefined): string {
  const t = (text ?? '').trim();
  return t ? t[0].toUpperCase() : 'K';
}

export function readingMinutes(words: number): number {
  return Math.max(1, Math.round(words / 230));
}

export function fullDate(ts: number): string {
  return dateFormat({ weekday: 'short', year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(
    new Date(ts),
  );
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  // Each unit up to where it would round to 1024 of itself ("1024 KB" reads as "1.0 MB").
  const kb = (bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0);
  if (Number(kb) < 1024) return `${kb} KB`;
  const mb = (bytes / 1024 ** 2).toFixed(1);
  if (Number(mb) < 1024) return `${mb} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

export function todayIso(d = new Date()): string {
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

export function wordCount(md: string): number {
  const text = md
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    // A link counts by its text, not its address; a bare web address is one word.
    .replace(/\]\([^)\s]*(?:\s+"[^"]*")?\)/g, '] ')
    .replace(/<?\b(?:https?:\/\/|mailto:)[^\s<>]+>?/gi, ' link ')
    // List markers aren't words ("1. one" is one), nor is a ticked box's "x", in a quote or not.
    .replace(/^[ \t]*(?:>[ \t]*)*(?:(?:[-*+]|\d{1,9}[.)])[ \t]+(?:\[[ xX]\](?=[ \t]|$))?)?/gm, ' ')
    .replace(/[#>*_`~=[\]()|-]/g, ' ');
  // Combining marks belong to their word (Hindi, Arabic vowel marks, accents written separately).
  const m = text.match(/[\p{L}\p{N}][\p{L}\p{N}\p{M}'’]*/gu);
  return m ? m.length : 0;
}

/**
 * JSON laid out with two-space indents, as JSON.stringify(value, null, 2) lays it out, but worked on
 * the text itself, so keys, strings and numbers stay exactly as written: parsing and printing it again
 * would round big numbers, move keys like "10" ahead of the rest, and drop repeated keys. Null when
 * it isn't valid JSON.
 */
export function formatJson(text: string): string | null {
  try {
    JSON.parse(text);
  } catch {
    return null;
  }
  const isSpace = (c: string) => c === ' ' || c === '\t' || c === '\n' || c === '\r';
  let out = '';
  let depth = 0;
  const newline = () => `\n${'  '.repeat(depth)}`;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      // Copied whole; it's valid JSON, so the string is closed.
      let end = i + 1;
      while (text[end] !== '"') end += text[end] === '\\' ? 2 : 1;
      out += text.slice(i, end + 1);
      i = end;
    } else if (c === '{' || c === '[') {
      let next = i + 1;
      while (next < text.length && isSpace(text[next])) next++;
      if (text[next] === (c === '{' ? '}' : ']')) {
        out += c + text[next]; // empty: {} or []
        i = next;
      } else {
        depth++;
        out += c + newline();
      }
    } else if (c === '}' || c === ']') {
      depth--;
      out += newline() + c;
    } else if (c === ',') {
      out += `,${newline()}`;
    } else if (c === ':') {
      out += ': ';
    } else if (!isSpace(c)) {
      out += c;
    }
  }
  return out;
}

export function debounce<A extends unknown[]>(fn: (...args: A) => void, ms: number) {
  let t: ReturnType<typeof setTimeout> | undefined;
  const wrapped = (...args: A) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
  wrapped.cancel = () => clearTimeout(t);
  return wrapped;
}

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

export function isMac(): boolean {
  return typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
}

export const modKey = () => (isMac() ? '⌘' : 'Ctrl');
export const altKey = () => (isMac() ? '⌥' : 'Alt');

/** Plain-file-system-safe name. */
export function safeName(name: string, fallback = 'Untitled'): string {
  const cleaned = name
    .replace(/[\\/:*?"<>|#^[\]]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100);
  // Names made only of dots ("..") would act as path steps inside a backup .zip.
  return cleaned && !/^\.+$/.test(cleaned) ? cleaned : fallback;
}

export function uploadSafeName(name: string): string {
  return (
    name
      .normalize('NFKD')
      // Letters and digits of any script (a name in Arabic or Chinese keeps its name), not symbols.
      .replace(/[^\p{L}\p{N}_.\- ]+/gu, '')
      .trim()
      .replace(/\s+/g, '-')
      .slice(0, 120) || 'file'
  );
}

/** Search snippet (with \u0001 / \u0002 match markers) as safe HTML without Markdown punctuation. */
// What starts a line of Markdown: quote markers, a callout's [!kind], a heading's hashes or a list
// marker, and a task's box. Each part starts with a different character, so it's read one way only.
const LINE_START = /^[ \t]*(?:>[ \t]*)*(?:\[![^\]\n]*\][+-]?[ \t]*)?(?:(?:#{1,6}|[-*+]|\d{1,9}[.)])[ \t]+)?(?:\[[ xX]\](?:[ \t]+|$))?/gm;

export function snippetToHtml(snippet: string): string {
  // Formulas as readable text, as in note-list previews ("e^(iπ)"), unless a match is marked inside one.
  const tex = (s: string) => (/[\u0001\u0002]/.test(s) ? s : texToText(s));
  const plain = snippet
    .replace(/\$\$([^$]+?)\$\$/g, (_m, t: string) => ` ${tex(t)} `)
    .replace(/(^|[^\\$\w])\$(?=\S)([^$\n]*?\S)\$(?![\w$])/g, (_m, before: string, t: string) => `${before}${tex(t)}`)
    // Line by line (a snippet keeps its line breaks until the end): table rows by their cells, then
    // each line's markers. A snippet starting mid-line starts with "…", so it isn't taken for one.
    .replace(/^[ \t]*\|[ \t|:-]+$/gm, '')
    // A row starts or ends with a pipe (a snippet can start or end partway through one, with "…").
    .replace(/^(?:[ \t]*\|.*|.*\|[ \t]*…?)$/gm, (row) => row.replace(/\\\|/g, '\u0000').replace(/\|/g, ' ').replace(/\u0000/g, '|'))
    // A code fence's own line ("```ts") says nothing; the code inside can be what matched.
    .replace(/^[ \t]*(?:>[ \t]*)*(?:`{3,}|~{3,}).*$/gm, '')
    .replace(LINE_START, '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[\[([^\]|#]*)(?:#[^\]|]*)?(?:\|([^\]]*))?\]\]/g, (_m, a: string, b?: string) => b || a)
    .replace(/(\*\*|__|~~|==|`{1,3})/g, '')
    // Single-star or underscore emphasis around words, not a star or underscore used as text.
    .replace(/(^|[\s(\u0001])[*_]([^*_\s][^*_]*?)[*_](?=[\s).,;:!?\u0002]|$)/gm, '$1$2')
    // Headings in snippets made before line breaks were kept.
    .replace(/(^|\s)#{1,6}\s+/g, '$1')
    // Backslash escapes, last: "\*" stays a star.
    .replace(/\\([!-/:-@[-`{-~])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  return escapeHtml(plain).replace(/\u0001/g, '<mark>').replace(/\u0002/g, '</mark>');
}

export function noteTitle(title: string | undefined | null): string {
  return title && title.trim() ? title : 'Untitled';
}
