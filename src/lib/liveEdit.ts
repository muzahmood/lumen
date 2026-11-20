/**
 * Changing a note's text from outside its editor: an upload finishing after the note was left, links
 * updated after another note was renamed, a task ticked in the Tasks view. The change goes through the
 * note's open view when there is one (its editor and saving included), and otherwise through the
 * autosave on top of the text this device last had, so a change made elsewhere since shows as a conflict
 * rather than being overwritten.
 */
import { libraryDocs } from './library';
import { baseVersionOf, edit, unsavedPatch } from './saver';
import { noteCache, useApp } from './store';

const liveViews = new Map<string, (fn: (src: string) => string) => void>();

/** The open view of note `id` registers how to change its text; the returned function unregisters it. */
export function registerLiveView(id: string, apply: (fn: (src: string) => string) => void): () => void {
  liveViews.set(id, apply);
  return () => {
    if (liveViews.get(id) === apply) liveViews.delete(id);
  };
}

/**
 * The text of note `id` as this device has it, with the version it's to be saved on top of: edits not
 * yet confirmed saved (one on its way included) on top of their base; otherwise the newest saved text
 * this device has (the open-note cache and the on-device copy can each be behind), at its own version.
 * Never older text paired with a newer version, which would overwrite what's in between; and never
 * text older than the note list shows (saved on another device since), which isn't the note's text any
 * more: then nothing is known, and callers fetch it or leave it.
 */
export function knownText(id: string): { content: string; version: number } | null {
  const unsaved = unsavedPatch(id)?.content;
  const listed = useApp.getState().notes[id]?.version ?? 0;
  const current = <T extends { version: number }>(t: T | undefined) => (t && t.version >= listed ? t : undefined);
  const cached = current(noteCache.get(id));
  const doc = current(libraryDocs().get(id));
  const saved = cached && doc ? (doc.version > cached.version ? doc : cached) : (cached ?? doc);
  if (unsaved !== undefined) return { content: unsaved, version: baseVersionOf(id) || saved?.version || 0 };
  return saved ? { content: saved.content, version: saved.version } : null;
}

/** Applies `fn` to note `id`'s text. Returns false when this device doesn't have the note's text. */
export function changeNoteText(id: string, fn: (src: string) => string): boolean {
  const live = liveViews.get(id);
  if (live) {
    live(fn);
    return true;
  }
  const known = knownText(id);
  if (!known) return false;
  const next = fn(known.content);
  // Saved text names what the change was made on, so it can be merged with a newer version if need be.
  const saved = unsavedPatch(id)?.content === undefined;
  if (next !== known.content) edit(id, { content: next }, known.version || undefined, saved ? { content: known.content } : undefined);
  return true;
}
