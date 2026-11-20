/**
 * [[Link]] text helpers with no app state: finding and rewriting links to a note by its title, outside
 * code. Used when a note is renamed (relink.ts). Code is told apart by shared/noteText.ts, as for the
 * links each note's preview lists (makeLinks).
 */
import { outsideCode } from '../../shared/noteText';

export { outsideCode };

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const linkRe = (title: string) => new RegExp(`\\[\\[\\s*${escapeRe(title)}\\s*(?=\\||#|\\]\\])`, 'gi');

/** The text with links to the note titled `from` pointing at `to` instead (any case of `from`). */
export function relinkText(src: string, from: string, to: string): string {
  const re = linkRe(from);
  return outsideCode(src, (part) => part.replace(re, () => `[[${to}`));
}

/** Whether the text links to the note titled `title`. */
export function linksTo(src: string, title: string): boolean {
  let found = false;
  const re = linkRe(title);
  outsideCode(src, (part) => {
    if (!found && re.test(part)) found = true;
    re.lastIndex = 0;
    return part;
  });
  return found;
}
