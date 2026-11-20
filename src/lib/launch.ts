/**
 * What the app was opened to do, from its address:
 * - ?do=new, ?do=journal, ?do=search: the home-screen shortcuts (long-press the icon; manifest.webmanifest).
 * - Something shared into Lumen from another app. The service worker (public/sw.js) keeps the shared
 *   text, link and files on this device and opens the app; here they become a new note, the files
 *   uploaded as attachments (encrypted, like any other, when the library is).
 *
 * Nothing shared is saved without asking: a share is a form sent to /share, and any website could
 * send one (with links, images that load from elsewhere, files), not only the phone's share sheet.
 * A share not yet saved or discarded (the app closed, the library locked, an upload failed) is offered
 * again the next time the app opens. Runs once the notes have loaded, so after unlocking.
 */
import { cutAt } from '../../shared/noteText';
import { errorMessage } from './api';
import { chooseDialog, createNote, newNote, openDailyNote, toast, useApp } from './store';
import { uploadForNote } from './upload';
import { idFor } from './utils';

interface Shared {
  title: string;
  text: string;
  url: string;
  files: Array<{ name: string; type: string }>;
}

interface Pending {
  cache: Cache;
  id: string;
  shared: Shared;
}

let taken = false;

/** The parameters this handles, gone from the address so a reload doesn't do it again. */
function takeParams(): { action: string | null; share: string | null } {
  const params = new URLSearchParams(window.location.search);
  const action = params.get('do');
  const share = params.get('share');
  if (action === null && share === null) return { action, share };
  params.delete('do');
  params.delete('share');
  const rest = params.toString();
  history.replaceState(history.state, '', window.location.pathname + (rest ? `?${rest}` : '') + window.location.hash);
  return { action, share };
}

/** Where shares wait: the service worker's cache (named "kb-share"; earlier versions added their own version). */
async function shareCaches(): Promise<Cache[]> {
  if (!('caches' in window)) return [];
  const names = (await caches.keys()).filter((k) => k === 'kb-share' || k.endsWith('-share'));
  return Promise.all(names.map((n) => caches.open(n)));
}

const SHARE_PATH = /^\/__kb\/share\/([^/]+)\/meta$/;

/** When a share arrived, from its id (base-36 time, then six random characters). */
const arrivedAt = (id: string) => parseInt(id.slice(0, -6), 36) || 0;

async function pendingShares(): Promise<Pending[]> {
  const out: Pending[] = [];
  for (const cache of await shareCaches()) {
    for (const req of await cache.keys()) {
      const m = SHARE_PATH.exec(new URL(req.url).pathname);
      if (!m) continue;
      const id = decodeURIComponent(m[1]);
      let shared: Shared | undefined;
      try {
        shared = (await (await cache.match(req))?.json()) as Shared | undefined;
      } catch {
        shared = undefined;
      }
      if (shared && typeof shared.text === 'string') out.push({ cache, id, shared });
      // Unreadable details can't be offered: once as old as a share that's dropped unsaved (a week),
      // it goes too, with its files.
      else if (arrivedAt(id) < Date.now() - 7 * 86_400_000) await dropShare(cache, id);
    }
  }
  return out.sort((a, b) => arrivedAt(a.id) - arrivedAt(b.id));
}

async function dropShare(cache: Cache, id: string) {
  const base = `/__kb/share/${encodeURIComponent(id)}/`;
  const keys = await cache.keys();
  await Promise.all(keys.filter((k) => new URL(k.url).pathname.startsWith(base)).map((k) => cache.delete(k)));
}

/** A shared link's title-to-be: its site, without "www.". */
function siteOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

/** A link's address as Markdown reads it whole: spaces and angle brackets encoded, in <…> if it has parentheses. */
function destination(url: string): string {
  const safe = url.replace(/[\s<>]/g, (c) => encodeURIComponent(c));
  return /[()]/.test(safe) ? `<${safe}>` : safe;
}

/** The note made of what was shared: its text, the link (unless the text has it already), then the files. */
export function sharedNote(shared: Pick<Shared, 'title' | 'text' | 'url'>, files: string[]): { title: string; content: string } {
  const text = shared.text.replace(/\r\n?/g, '\n').trim();
  let url = shared.url.trim();
  // Many apps share a link as the text; it then reads as the link.
  if (!url && /^https?:\/\/\S+$/.test(text)) url = text;
  // Only a web or mail address becomes a link; anything else is kept as text.
  const linkable = /^(https?:\/\/|mailto:)\S/i.test(url);
  const parts: string[] = [];
  if (text && text !== url) parts.push(text);
  // Already in the text, as a whole word (not just the start of a longer address there).
  const inText = !!url && text !== url && text.split(/\s+/).some((w) => w.replace(/^[<(]+|[>).,;:!?]+$/g, '') === url);
  if (url && !inText) {
    const label = shared.title.trim().replace(/[\\[\]]/g, (c) => `\\${c}`);
    if (!linkable) parts.push(url);
    else if (/[\p{L}\p{N}]/u.test(label)) parts.push(`[${label}](${destination(url)})`);
    else parts.push(`<${url.replace(/[\s<>]/g, (c) => encodeURIComponent(c))}>`);
  }
  parts.push(...files);
  const firstLine = text && text !== url ? text.split('\n')[0].replace(/^#+\s*/, '').trim() : '';
  const title = cutAt(shared.title.trim() || (firstLine.length <= 80 ? firstLine : `${cutAt(firstLine, 77)}…`) || siteOf(url) || 'Shared', 200);
  return { title, content: `${parts.join('\n\n')}\n` };
}

/** What's in a share, in plain words for the question before saving it. */
function describe(shared: Shared): string {
  const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
  const lines: string[] = [];
  if (shared.title.trim()) lines.push(clip(shared.title.trim(), 120));
  if (shared.text.trim()) lines.push(clip(shared.text.trim().replace(/\s+/g, ' '), 240));
  if (shared.url.trim() && !shared.text.includes(shared.url.trim())) lines.push(clip(shared.url.trim(), 160));
  const n = shared.files.length;
  if (n) lines.push(`${n === 1 ? '1 file' : `${n} files`}: ${clip(shared.files.map((f) => f.name).join(', '), 160)}`);
  return lines.join('\n') || 'Nothing to show.';
}

/** Saves one share as a note: the text and link always, each file that uploads (the others named in a message). */
async function saveShare({ cache, id, shared }: Pending) {
  const base = `/__kb/share/${encodeURIComponent(id)}`;
  const links: string[] = [];
  const failed: string[] = [];
  let reason = '';
  for (const [i, f] of shared.files.entries()) {
    const res = await cache.match(`${base}/${i}`);
    if (!res) continue;
    try {
      const file = new File([await res.blob()], f.name, { type: f.type });
      // Under ids made from the share's: saving it again (after a reply that never came, or a page
      // closed before the share was cleared away) finds these rather than storing each file twice.
      links.push((await uploadForNote(file, null, true, idFor(id, `file${i}`))).markdown);
    } catch (err) {
      failed.push(f.name);
      reason = errorMessage(err);
    }
  }
  const { title, content } = sharedNote(shared, links);
  // At the top level, whatever list was open last: where it went is shown as it opens.
  await createNote({ title, content, folder_id: null, tags: [], pinned: false }, { mode: 'read', id: idFor(id, 'note') });
  if (failed.length) toast(`Saved what was shared, but not ${failed.map((f) => `“${f}”`).join(', ')}: ${reason}`, { kind: 'error', timeout: 12_000 });
  else toast(links.length ? `Saved what was shared, with ${links.length === 1 ? 'a file' : `${links.length} files`}` : 'Saved what was shared');
}

let offering: Promise<void> | null = null;

/** Asks about each share waiting on this device, oldest first: save it, discard it, or leave it for later. */
function offerShares(): Promise<void> {
  offering ??= (async () => {
    const weekAgo = Date.now() - 7 * 86_400_000;
    for (const share of await pendingShares()) {
      // Shared over a week ago and never saved: not wanted any more.
      if (arrivedAt(share.id) < weekAgo) {
        await dropShare(share.cache, share.id);
        continue;
      }
      const choice = await chooseDialog({
        title: 'Save what was shared?',
        message: describe(share.shared),
        confirmLabel: 'Save as a note',
        altLabel: 'Discard',
        cancelLabel: 'Later',
      });
      if (choice === null) return; // kept, and asked about again next time
      if (choice === 'alt') {
        await dropShare(share.cache, share.id);
        continue;
      }
      try {
        await saveShare(share);
      } catch (err) {
        toast(`Couldn’t save what was shared: ${errorMessage(err)}. It’s kept on this device for next time.`, { kind: 'error' });
        return;
      }
      await dropShare(share.cache, share.id);
    }
  })()
    .catch(() => undefined)
    .finally(() => (offering = null));
  return offering;
}

/** Does what the app was opened to do, once; and offers anything shared that's waiting. */
export function takeLaunchAction() {
  if (taken) return;
  taken = true;
  const { action, share } = takeParams();
  if (share === 'failed') toast('Lumen couldn’t receive what was shared. Try sharing it again.', { kind: 'error' });
  else if (share === 'unavailable') toast('Lumen wasn’t ready to receive that yet. Share it again now that the app is open.', { kind: 'error' });
  else if (action === 'new') void newNote();
  else if (action === 'journal') void openDailyNote();
  else if (action === 'search') useApp.setState({ paletteOpen: true });
  void offerShares();
}
