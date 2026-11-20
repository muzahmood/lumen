/**
 * Unlinked mentions: places where a note names another note's title in its running text without
 * linking to it. Whole words only, any case; nothing inside code, links ([[…]], [text](url), <…>),
 * web addresses, HTML or a task's due date counts, since those either link already or aren't prose
 * (a journal entry is titled with its date, and linking "📅 2026-11-20" would take the task's date away).
 */
import { LinkifyIt } from 'linkify-it';
import { outsideCode } from '../../shared/noteText';
import { DUE } from './tasks';

const DUE_ALL = new RegExp(DUE.source, 'gu');

/** Finds what reading view turns into links on its own (markdown-it's linkify, same defaults). */
const linkify = new LinkifyIt();

/** `part` with the web and email addresses reading view would link blanked out. */
function blankAddresses(part: string): string {
  const found = linkify.match(part);
  if (!found) return part;
  let out = '';
  let at = 0;
  for (const m of found) {
    out += part.slice(at, m.index) + blank(part.slice(m.index, m.lastIndex));
    at = m.lastIndex;
  }
  return out + part.slice(at);
}

export interface Mention {
  /** Offsets in the note's text: the mention is text.slice(start, end). */
  start: number;
  end: number;
}

const blank = (part: string) => part.replace(/[^\n]/g, ' ');

/**
 * The text with everything that isn't running prose blanked out, character for character (so offsets
 * still match): code, links and images, HTML, web addresses, due dates.
 */
export function proseMask(text: string): string {
  return outsideCode(
    text,
    (part) =>
      // Each pattern stops at the next opening character, so a long line of unclosed "[" or "<" is
      // scanned once rather than once from each of them. A link's address may hold one level of
      // parentheses (Wikipedia's "Python_(programming_language)").
      blankAddresses(
        part
          .replace(/!?\[\[[^[\]\n]*\]\]/g, blank)
          .replace(/!?\[[^[\]\n]*\]\((?:[^()\n]|\([^()\n]*\))*\)/g, blank)
          .replace(/<[^<>\n]+>/g, blank)
          .replace(/\b(?:https?|mailto):[^\s)\]>]+/gi, blank)
          .replace(DUE_ALL, blank),
      ),
    blank,
  );
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The whole-word, any-case pattern for a title, or null for a title that makes no useful mention: too
 * short to tell from an ordinary word, or holding characters a [[link]] can't.
 */
export function mentionPattern(title: string): RegExp | null {
  const t = title.trim();
  if (t.length < 3 || /[[\]|#\n]/.test(t)) return null;
  // Words of a title are matched across spaces, never across a line break (a link can't hold one).
  const body = t.split(/\s+/).map(escapeRe).join('[^\\S\\n]+');
  return new RegExp(`(?<![\\p{L}\\p{N}_])${body}(?![\\p{L}\\p{N}_])`, 'giu');
}

/** Where `text` names `title` without linking it, in order (at most `limit`). */
export function findMentions(text: string, title: string, limit = 50): Mention[] {
  const re = mentionPattern(title);
  if (!re) return [];
  // Cheap first: most notes don't contain the title at all.
  const lower = title.trim().toLowerCase().split(/\s+/)[0];
  if (!text.toLowerCase().includes(lower)) return [];
  const mask = proseMask(text);
  const out: Mention[] = [];
  for (let m = re.exec(mask); m && out.length < limit; m = re.exec(mask)) out.push({ start: m.index, end: m.index + m[0].length });
  return out;
}

/** The text with one mention turned into a link: [[Title]], or [[Title|as written]] when it's written differently. */
export function linkMention(text: string, title: string, mention: Mention): string {
  const t = title.trim();
  const written = text.slice(mention.start, mention.end);
  const link = written === t ? `[[${t}]]` : `[[${t}|${written}]]`;
  return text.slice(0, mention.start) + link + text.slice(mention.end);
}

/** A short stretch of plain text around a mention, to show where it is. */
export function snippetAround(text: string, mention: Mention, radius = 70): { before: string; match: string; after: string } {
  const flat = (s: string) =>
    s
      .replace(/[*_`~=]+/g, '')
      .replace(/\[\[([^[\]|#]*)(?:#[^[\]|]*)?(?:\|([^[\]]*))?\]\]/g, (_m, a: string, b?: string) => b || a)
      .replace(/\s+/g, ' ');
  let start = Math.max(0, mention.start - radius);
  let end = Math.min(text.length, mention.end + radius);
  // Within the mention's paragraph.
  const paraStart = text.lastIndexOf('\n\n', mention.start);
  if (paraStart >= start) start = paraStart + 2;
  const paraEnd = text.indexOf('\n\n', mention.end);
  if (paraEnd !== -1 && paraEnd < end) end = paraEnd;
  return {
    before: `${start > 0 && text[start - 1] !== '\n' ? '…' : ''}${flat(text.slice(start, mention.start)).trimStart()}`,
    match: text.slice(mention.start, mention.end),
    after: `${flat(text.slice(mention.end, end)).trimEnd()}${end < text.length && text[end] !== '\n' ? '…' : ''}`,
  };
}
