/**
 * Other notes shown inside a note: "![[Note]]" embeds in reading view, and the preview that appears
 * when a pointer rests on a [[link]]. Their text comes from this device (what's open or not yet sent,
 * or the on-device copy of the library: already decrypted when the library is encrypted), or else is
 * fetched as opening the note would, and decrypted here. Nothing about them goes anywhere new.
 *
 * What's shown is read-only: its tick boxes are off and its diagrams and drawings can't be edited
 * from here (their line numbers are another note's, and would change this one).
 */
import { api } from './api';
import { decryptingAssets, hydrateAssets } from './assets';
import { knownText } from './liveEdit';
import { renderMarkdown, type RenderEnv } from './markdown';
import { hydrateMermaid } from './mermaid';
import { useApp } from './store';
import { noteTitle, slugify } from './utils';

/** How many embeds deep: a note embedding one that embeds another, and no further. */
export const MAX_EMBED_DEPTH = 3;

/** Notes being fetched, by id and the version the note list shows (so each is fetched once). */
const fetching = new Map<string, Promise<string | null>>();

/** A note's text, from this device if it has it, or fetched (and decrypted here). Null if it can't be read. */
export async function noteText(id: string): Promise<{ content: string; version: number } | null> {
  const known = knownText(id);
  if (known) return known;
  const version = useApp.getState().notes[id]?.version ?? 0;
  const key = `${id}:${version}`;
  let pending = fetching.get(key);
  if (!pending) {
    pending = api.getNote(id).then(
      (n) => n.content,
      () => null,
    );
    fetching.set(key, pending);
    // Forgotten once settled: a failure (offline) is tried again next time.
    void pending.finally(() => setTimeout(() => fetching.delete(key), 30_000));
  }
  const content = await pending;
  return content === null ? null : { content, version };
}

/**
 * The part of `md` under the heading named `heading` (by its words, as links name it): from that
 * heading to the next one at its level or above. Null if there's no such heading.
 */
export function noteSection(md: string, heading: string): string | null {
  const want = slugify(heading);
  const lines = md.split('\n');
  let fence: string | null = null;
  let start = -1;
  let level = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const f = /^\s*(`{3,}|~{3,})/.exec(line);
    if (f) {
      if (!fence) fence = f[1][0];
      else if (f[1][0] === fence) fence = null;
      continue;
    }
    if (fence) continue;
    const h = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (!h) continue;
    if (start < 0) {
      if (slugify(h[2]) === want) {
        start = i;
        level = h[1].length;
      }
    } else if (h[1].length <= level) {
      return lines.slice(start, i).join('\n').trimEnd();
    }
  }
  return start < 0 ? null : lines.slice(start).join('\n').trimEnd();
}

/** The first `limit` characters of `md` or so, cut at the end of a line, with "…" if anything's left. */
function shorten(md: string, limit: number): string {
  if (md.length <= limit) return md;
  const cut = md.lastIndexOf('\n', limit);
  return `${md.slice(0, cut > limit / 2 ? cut : limit).trimEnd()}\n\n…`;
}

export interface PartOptions {
  resolveTitle: RenderEnv['resolveTitle'];
  breaks: boolean;
  remoteImages: 'load' | 'ask';
  /** Show only about this much of the text (a preview). */
  limit?: number;
}

/** A note (or one heading's part of it) rendered to show inside another, read-only. Null if it can't be read. */
export async function renderNotePart(
  id: string,
  heading: string | null,
  opts: PartOptions,
): Promise<{ html: string; version: number; found: boolean } | null> {
  const text = await noteText(id);
  if (!text) return null;
  const section = heading ? noteSection(text.content, heading) : text.content;
  if (section === null) return { html: '', version: text.version, found: false };
  const source = opts.limit ? shorten(section, opts.limit) : section;
  const env: RenderEnv = { resolveTitle: opts.resolveTitle, drawingRevs: useApp.getState().drawingRevs, headings: [] };
  let html = renderMarkdown(source, env, { breaks: opts.breaks, remoteImages: opts.remoteImages, assets: decryptingAssets() ? 'decrypt' : 'load' });
  if (env.pending) {
    // Maths or code colours still loading: once in, rendered again (or as it is, if they can't load).
    await env.pending.catch(() => undefined);
    html = renderMarkdown(source, env, { breaks: opts.breaks, remoteImages: opts.remoteImages, assets: decryptingAssets() ? 'decrypt' : 'load' });
  }
  return { html: readOnly(html), version: text.version, found: true };
}

/** Rendered HTML made safe to show inside another note: nothing in it can change either note. */
function readOnly(html: string): string {
  const t = document.createElement('template');
  t.innerHTML = html;
  const root = t.content;
  for (const box of root.querySelectorAll<HTMLInputElement>('input.kb-task-box')) {
    box.disabled = true;
    box.removeAttribute('data-task-line');
  }
  // Editing a diagram or drawing from here would change lines of this note, not that one.
  for (const button of root.querySelectorAll('[data-action="edit-mermaid"], [data-action="edit-drawing"]')) button.remove();
  // Its headings aren't this note's: not in its outline, or where its #links go.
  for (const el of root.querySelectorAll('[id]')) el.removeAttribute('id');
  for (const el of root.querySelectorAll('[data-line], [data-line-end]')) {
    el.removeAttribute('data-line');
    el.removeAttribute('data-line-end');
  }
  return t.innerHTML;
}

export interface EmbedOptions extends Omit<PartOptions, 'limit'> {
  theme: 'light' | 'dark';
  /** The note these are in, and those around it: none is shown inside itself. */
  within: string[];
}

/**
 * Fills in the "![[Note]]" embeds under `root` that aren't yet (or whose note has changed since), and
 * then theirs, up to MAX_EMBED_DEPTH. One that can't be (offline, deleted, too deep, itself) stays a link.
 */
export async function hydrateEmbeds(root: ParentNode, opts: EmbedOptions, depth = 1): Promise<void> {
  const spans = Array.from(root.querySelectorAll<HTMLElement>('span.kb-embed[data-embed-id]')).filter(
    // Only this level's: those inside a filled one are its own, filled with it.
    (el) => el.parentElement?.closest('.kb-embed-body') === (root instanceof Element ? root.closest('.kb-embed-body') : null),
  );
  await Promise.all(spans.map((span) => fill(span, opts, depth)));
}

async function fill(span: HTMLElement, opts: EmbedOptions, depth: number) {
  const id = span.dataset.embedId!;
  const heading = span.dataset.embedHeading ?? null;
  if (depth > MAX_EMBED_DEPTH || opts.within.includes(id)) {
    span.classList.add('is-unshown');
    span.title = opts.within.includes(id) ? 'This note is already shown here' : 'Shown in its own note (embedded too deeply here)';
    return;
  }
  const listed = useApp.getState().notes[id];
  if (!listed || listed.deleted_at) return;
  const version = knownText(id)?.version ?? listed.version;
  if (span.dataset.embedShown === String(version)) return;
  const part = await renderNotePart(id, heading, opts);
  if (!part || !span.isConnected) return;
  const title = `${noteTitle(listed.title)}${heading ? ` › ${heading}` : ''}`;
  const head = document.createElement('span');
  head.className = 'kb-embed-head';
  const link = span.querySelector<HTMLAnchorElement>('a.kb-embed-link');
  if (link) {
    link.textContent = title;
    head.append(link);
  }
  const body = document.createElement('span');
  body.className = 'kb-embed-body';
  if (part.found) body.innerHTML = part.html;
  else {
    const missing = document.createElement('span');
    missing.className = 'kb-embed-missing';
    missing.textContent = `There’s no heading “${heading}” in that note.`;
    body.append(missing);
  }
  span.replaceChildren(head, body);
  span.classList.add('is-filled');
  span.dataset.embedShown = String(part.version);
  hydrateAssets(body);
  void hydrateMermaid(body, opts.theme);
  await hydrateEmbeds(body, { ...opts, within: [...opts.within, id] }, depth + 1);
}
