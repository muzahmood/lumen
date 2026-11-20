/**
 * Exporting the open note.
 *
 * - Markdown: the note as a .md file. When it has images, files or drawings, they go into a .zip
 *   beside it and the links point at those copies, so the note reads the same outside Lumen.
 * - PDF: the note laid out for paper in a print-only copy of the page, then the browser's print
 *   window, where "Save as PDF" makes the file. Text stays selectable and math, diagrams and
 *   drawings stay sharp, because the browser itself draws them.
 */
import { zipSync, strToU8, type Zippable } from 'fflate';
import { api } from './api';
import { decryptingAssets, hydrateAssetsNow } from './assets';
import { frontMatter } from './backup';
import { renderMarkdown } from './markdown';
import { hydrateMermaid } from './mermaid';
import { loadExtras } from './renderExtras';
import { useSettings } from './settings';
import { useApp } from './store';
import type { Note } from './types';
import { escapeHtml, fullDate, noteTitle, safeName, uploadSafeName } from './utils';

export type ExportNote = Pick<Note, 'id' | 'title' | 'content' | 'tags' | 'created_at' | 'updated_at'>;

const FILE_URL = /\/api\/files\/([A-Za-z0-9_-]{6,64})(?:\/([^\s)"'<>]*))?/g;
const DRAWING_URL = /\/api\/drawings\/([A-Za-z0-9_-]{6,64})\.svg(?:\?[^\s)"'<>]*)?/g;

interface Attachment {
  kind: 'file' | 'drawing';
  id: string;
  /** Where the copy goes in the .zip. */
  path: string;
  fetch: string;
  /** For drawings: the editable Excalidraw scene, saved alongside. */
  scene?: { path: string; fetch: string };
}

/** Images, files and drawings the note links to, each once (however many times it's linked). */
export function noteAttachments(content: string): Attachment[] {
  const out = new Map<string, Attachment>();
  for (const m of content.matchAll(FILE_URL)) {
    if (out.has(`f:${m[1]}`)) continue;
    let name = 'file';
    try {
      name = m[2] ? decodeURIComponent(m[2]) : name;
    } catch {
      /* keep the default */
    }
    out.set(`f:${m[1]}`, { kind: 'file', id: m[1], path: `attachments/${m[1]}-${uploadSafeName(name)}`, fetch: `/api/files/${m[1]}` });
  }
  for (const m of content.matchAll(DRAWING_URL)) {
    if (out.has(`d:${m[1]}`)) continue;
    out.set(`d:${m[1]}`, {
      kind: 'drawing',
      id: m[1],
      path: `drawings/${m[1]}.svg`,
      fetch: `/api/drawings/${m[1]}.svg`,
      scene: { path: `drawings/${m[1]}.excalidraw`, fetch: `/api/drawings/${m[1]}/scene` },
    });
  }
  return [...out.values()];
}

/** Links that only work inside Lumen (other notes, uploads left out) point back at this Lumen. */
function absoluteLinks(md: string): string {
  return md.replace(/(\]\(|<|src=")\/(api|note)\//g, (_m, lead: string, kind: string) => `${lead}${location.origin}/${kind}/`);
}

/** An attachment's bytes, decrypted when the library is encrypted (the copy in the .zip is readable). */
const fetchBytes = (url: string): Promise<Uint8Array> => api.assetBytes(url);

export interface MarkdownOptions {
  /** Put images, files and drawings in a .zip with the note (when it has any). */
  attachments: boolean;
  /** YAML front matter with the title, tags and dates. */
  frontMatter: boolean;
}

/** The note as Markdown: a .md file, or a .zip with its attachments. `missing` counts files that couldn't be fetched. */
export async function exportMarkdown(note: ExportNote, opts: MarkdownOptions): Promise<{ blob: Blob; filename: string; missing: number }> {
  const name = safeName(noteTitle(note.title));
  const heading = note.title.trim() && !/^#\s/.test(note.content.trimStart()) ? `# ${note.title.trim()}\n\n` : '';
  const head = (opts.frontMatter ? frontMatter(note) : '') + heading;
  const attachments = opts.attachments ? noteAttachments(note.content) : [];

  if (!attachments.length) {
    const text = head + absoluteLinks(note.content);
    return { blob: new Blob([text], { type: 'text/markdown;charset=utf-8' }), filename: `${name}.md`, missing: 0 };
  }

  const zip: Zippable = {};
  const included = new Map<string, string>();
  let missing = 0;
  for (const a of attachments) {
    try {
      zip[a.path] = [await fetchBytes(a.fetch), { level: /\.(png|jpe?g|gif|webp|avif|mp4|webm|mov|mp3|m4a|zip|pdf)$/i.test(a.path) ? 0 : 6 }];
      if (a.scene) {
        // The editable scene is a bonus (open it at excalidraw.com); the picture is what matters.
        const scene = await fetchBytes(a.scene.fetch).catch(() => null);
        if (scene) zip[a.scene.path] = scene;
      }
      included.set(`${a.kind}:${a.id}`, a.path);
    } catch {
      // Not reachable (offline, deleted): its link keeps pointing at Lumen instead.
      missing++;
    }
  }
  const body = note.content
    .replace(FILE_URL, (m, id: string) => included.get(`file:${id}`) ?? m)
    .replace(DRAWING_URL, (m, id: string) => included.get(`drawing:${id}`) ?? m);
  zip[`${name}.md`] = strToU8(head + absoluteLinks(body));
  const data = zipSync(zip);
  return { blob: new Blob([data as BlobPart], { type: 'application/zip' }), filename: `${name}.zip`, missing };
}

export type Paper = 'a4' | 'letter';

/**
 * Letter where it's the norm (the US, Canada, Mexico and parts of Latin America), A4 everywhere
 * else. Browsers say "en-US" in much of the world, so the time zone decides first.
 */
export function defaultPaper(): Paper {
  let zone = '';
  try {
    zone = Intl.DateTimeFormat().resolvedOptions().timeZone ?? '';
  } catch {
    /* unknown: A4 */
  }
  if (!zone.startsWith('America/')) return 'a4';
  const region = (navigator.language.split('-')[1] ?? '').toUpperCase();
  return !region || ['US', 'CA', 'MX', 'PR', 'GT', 'SV', 'HN', 'NI', 'CR', 'PA', 'DO', 'CO', 'VE', 'CL'].includes(region) ? 'letter' : 'a4';
}

export interface PdfOptions {
  paper: Paper;
  /** The note's title at the top. */
  title: boolean;
  /** Its last-edited date and tags under the title. */
  details: boolean;
  /** Single line breaks, as in reading view. */
  breaks: boolean;
  /** The accent color's light-theme value, for links. */
  accent: string;
}

function waitForImage(img: HTMLImageElement): Promise<void> {
  if (img.complete) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => resolve();
    img.addEventListener('load', done, { once: true });
    img.addEventListener('error', done, { once: true });
    setTimeout(done, 10_000);
  });
}

/**
 * Lays the note out in a print-only copy of the page and opens the print window. The file name the
 * browser suggests is the note's title. Resolves once the print window has been opened.
 */
export async function printNote(note: ExportNote, opts: PdfOptions, beforePrint?: () => void): Promise<void> {
  // A copy left behind by an earlier export whose print window never reported closing.
  document.querySelectorAll('.export-print, style[data-export-page]').forEach((el) => el.remove());

  const { notes, drawingRevs } = useApp.getState();
  const titles = new Map<string, string>();
  for (const n of Object.values(notes)) {
    const key = n.title.trim().toLowerCase();
    if (key && !n.deleted_at && !titles.has(key)) titles.set(key, n.id);
  }
  // Formulas and code colours, which load on demand. Offline without them, the TeX and plain code print.
  await loadExtras().catch(() => undefined);
  const html = renderMarkdown(
    note.content,
    { resolveTitle: (t) => titles.get(t.toLowerCase()) ?? null, drawingRevs, headings: [] },
    // Images from other websites as reading view shows them: under "Ask first", only those already
    // clicked to load are fetched; the rest print as their placeholder (each fetch tells that site).
    { breaks: opts.breaks, assets: decryptingAssets() ? 'decrypt' : 'load', remoteImages: useSettings.getState().remoteImages },
  );

  const root = document.createElement('div');
  root.className = 'export-print';
  root.style.setProperty('--accent', opts.accent);
  const tags = note.tags.length ? ` · ${note.tags.map((t) => `#${escapeHtml(t)}`).join(' ')}` : '';
  root.innerHTML = [
    opts.title ? `<h1 class="export-title">${escapeHtml(noteTitle(note.title))}</h1>` : '',
    opts.details ? `<p class="export-details">Last edited ${escapeHtml(fullDate(note.updated_at))}${tags}</p>` : '',
    `<article class="kb-prose">${html}</article>`,
  ].join('');

  // Paper has no app around it: links to other notes open them in Lumen, a link to a note that
  // doesn't exist yet is plain text, and buttons for editing are left out.
  root.querySelectorAll<HTMLAnchorElement>('a[href^="/"]').forEach((a) => a.setAttribute('href', location.origin + a.getAttribute('href')));
  root.querySelectorAll('a.kb-wikilink.is-missing').forEach((a) => a.replaceWith(document.createTextNode(a.textContent ?? '')));
  root.querySelectorAll('button').forEach((b) => b.remove());
  // Collapsed sections can't be opened on paper.
  root.querySelectorAll('details').forEach((d) => (d.open = true));
  // Hidden from the screen, so lazy images would never load: fetch them now.
  root.querySelectorAll('img').forEach((img) => (img.loading = 'eager'));

  document.body.appendChild(root);
  // Encrypted images and drawings are decrypted now: paper can't wait for them to scroll into view.
  await hydrateAssetsNow(root);
  await hydrateMermaid(root, 'light');
  root.querySelectorAll('.kb-block-edit').forEach((b) => b.remove());
  await Promise.all(Array.from(root.querySelectorAll('img'), waitForImage));
  await document.fonts?.ready;

  const page = document.createElement('style');
  page.dataset.exportPage = '';
  page.textContent = `@page { size: ${opts.paper === 'letter' ? 'letter' : 'A4'}; margin: 18mm 16mm 20mm; }`;
  document.head.appendChild(page);
  document.body.classList.add('is-exporting');
  const previousTitle = document.title;
  // Browsers name the PDF after the page title.
  document.title = safeName(noteTitle(note.title));

  const cleanup = () => {
    root.remove();
    page.remove();
    document.body.classList.remove('is-exporting');
    document.title = previousTitle;
  };
  window.addEventListener('afterprint', cleanup, { once: true });
  beforePrint?.();
  window.print();
}
