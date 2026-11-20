/**
 * "Uploading photo.jpg…": the placeholder put in a note while one of its files uploads, replaced by
 * the file's link when the upload is done. Its address says when the upload started, so one left
 * behind (the page closed or crashed mid-upload, and the placeholder was saved) is recognised on any
 * device, in any tab, and taken out when its note next opens, rather than staying in the note for good.
 */
import { newId } from './utils';

/** Past this, an upload that hasn't replaced its placeholder never will. */
const GIVE_UP_MS = 60 * 60_000;

/** A placeholder: an image's (!) or a file's, the file's name, and a token (start time in base 36, and a random part). */
const PLACEHOLDER = /!?\[Uploading ([^\]\n]*)…\]\(#upload-([0-9a-z]{6,12}-)?[A-Za-z0-9]{4,8}\)\n?/g;

export function uploadPlaceholder(file: { name: string; type: string }, now = Date.now()): string {
  const label = file.name.replace(/[[\]()]/g, '') || 'file';
  return `${file.type.startsWith('image/') ? '!' : ''}[Uploading ${label}…](#upload-${now.toString(36)}-${newId(4)})`;
}

/**
 * The text without placeholders whose upload can't still be going (started over an hour ago, or made
 * by an earlier version of Lumen, which didn't say when), and the names of their files.
 */
export function withoutAbandonedUploads(text: string, now = Date.now()): { text: string; abandoned: string[] } {
  if (!text.includes('[Uploading ')) return { text, abandoned: [] };
  const abandoned: string[] = [];
  const out = text.replace(PLACEHOLDER, (whole, label: string, started?: string) => {
    const at = started ? parseInt(started.slice(0, -1), 36) : 0;
    if (at && now - at < GIVE_UP_MS) return whole;
    abandoned.push(label);
    return '';
  });
  return { text: out, abandoned };
}

/** What to tell the person about uploads that were left unfinished. */
export function abandonedMessage(names: string[]): string {
  return names.length === 1
    ? `An upload didn’t finish before Lumen closed, so “${names[0]}” isn’t in this note. Add it again.`
    : `Uploads didn’t finish before Lumen closed, so ${names.map((n) => `“${n}”`).join(', ')} aren’t in this note. Add them again.`;
}
