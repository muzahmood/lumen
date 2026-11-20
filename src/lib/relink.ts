/**
 * Keeping [[links]] working when a note is renamed. Links name their note by title, so after a rename
 * the notes that link to it offer to switch to the new title: [[Old]], [[Old|label]] and [[Old#Heading]]
 * become [[New]], [[New|label]] and [[New#Heading]]. Text inside code is left alone.
 */
import { syncLibrary } from './library';
import { changeNoteText, knownText } from './liveEdit';
import { findMentions, linkMention, mentionPattern, snippetAround } from './mentions';
import { toast, useApp } from './store';
import { noteTitle } from './utils';
import { linksTo, relinkText } from './wikilinks';

/* ------------------------------------------------- unlinked mentions --- */

export interface MentionHit {
  /** The note that mentions it. */
  id: string;
  title: string;
  /** How many unlinked mentions it has. */
  count: number;
  /** Around the first one. */
  snippet: { before: string; match: string; after: string };
}

/**
 * Notes that name note `id`'s title in their text without linking to it (see mentions.ts), most
 * recently edited first. Read from the copy of every note on this device.
 */
export async function unlinkedMentions(id: string): Promise<MentionHit[]> {
  const title = useApp.getState().notes[id]?.title.trim() ?? '';
  if (!mentionPattern(title)) return [];
  try {
    await syncLibrary();
  } catch {
    /* offline or locked: the notes this device already has */
  }
  const out: MentionHit[] = [];
  const others = Object.values(useApp.getState().notes)
    .filter((m) => m.id !== id && !m.deleted_at)
    .sort((a, b) => b.updated_at - a.updated_at);
  for (const m of others) {
    const text = knownText(m.id)?.content;
    if (!text) continue;
    const found = findMentions(text, title, 20);
    if (!found.length) continue;
    out.push({ id: m.id, title: m.title, count: found.length, snippet: snippetAround(text, found[0]) });
    if (out.length >= 50) break;
  }
  return out;
}

/** Links the first unlinked mention of `title` in note `otherId`, with Undo. False if there was none left. */
export function linkFirstMention(otherId: string, title: string): boolean {
  let before = '';
  let after = '';
  changeNoteText(otherId, (src) => {
    const [first] = findMentions(src, title, 1);
    if (!first) return src;
    before = src;
    after = linkMention(src, title, first);
    return after;
  });
  if (!after) return false;
  const name = noteTitle(useApp.getState().notes[otherId]?.title);
  toast(`Linked in “${name}”`, {
    kind: 'success',
    action: { label: 'Undo', run: () => changeNoteText(otherId, (src) => (src === after ? before : src)) },
  });
  return true;
}

/** Characters a [[link]] can't hold: a title with them can't be linked to by name. */
const UNLINKABLE = /[[\]|#\n]/;

/**
 * Note `id` was renamed from `from` to `to`: if other notes link to it by the old title, offer to
 * update them. Not when another note still has the old title (those links now lead there).
 */
export async function offerLinkUpdate(id: string, from: string, to: string): Promise<void> {
  if (UNLINKABLE.test(from) || UNLINKABLE.test(to)) return;
  const live = () => Object.values(useApp.getState().notes).filter((m) => !m.deleted_at);
  const fromKey = from.toLowerCase();
  if (live().some((m) => m.id !== id && m.title.trim().toLowerCase() === fromKey)) return;
  try {
    await syncLibrary();
  } catch {
    /* offline or locked: the notes this device already has */
  }
  const ids = live()
    .filter((m) => {
      const text = knownText(m.id)?.content;
      return text !== undefined && linksTo(text, from);
    })
    .map((m) => m.id);
  if (!ids.length) return;
  const n = ids.length;
  toast(`${n === 1 ? 'A note links' : `${n} notes link`} to this note as “${from}”. Update ${n === 1 ? 'it' : 'them'} to “${to}”?`, {
    timeout: 15_000,
    action: { label: 'Update links', run: () => updateLinks(ids, from, to) },
  });
}

function updateLinks(ids: string[], from: string, to: string) {
  const changed: Array<{ id: string; before: string; after: string }> = [];
  for (const id of ids) {
    changeNoteText(id, (src) => {
      const next = relinkText(src, from, to);
      if (next !== src) changed.push({ id, before: src, after: next });
      return next;
    });
  }
  if (!changed.length) {
    toast('Those links were already changed.');
    return;
  }
  const n = changed.length;
  toast(`Updated links in ${n} ${n === 1 ? 'note' : 'notes'}`, {
    kind: 'success',
    action: {
      label: 'Undo',
      // Exactly as before where nothing else changed since; otherwise only the links go back.
      run: () => changed.forEach((c) => changeNoteText(c.id, (src) => (src === c.after ? c.before : relinkText(src, to, from)))),
    },
  });
}
