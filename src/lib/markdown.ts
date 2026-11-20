import markdownIt, { type Env, type MarkdownIt, type StateCore, type StateInline, type Token } from 'markdown-it';
import footnote from 'markdown-it-footnote';
// Only the plugin's parsing and markup: KaTeX itself is passed in below and loads on demand (the
// plugin's own require of it is stubbed out in the build, see vite.config.ts).
import katexPluginModule from '@vscode/markdown-it-katex';
import DOMPurify from 'dompurify';
import type { KatexOptions } from 'katex';
import { TOP_LAYER_ATTRS, TOP_LAYER_TAGS, dropRemoteCss, keepPositionInNote, srcsetLoadsRemote } from './htmlSafety';
import { loadExtras, loadedHljs, loadedKatex } from './renderExtras';
import { escapeHtml, slugify } from './utils';

type KatexPlugin = (md: MarkdownIt, opts?: Record<string, unknown>) => void;
const katexPlugin = ((katexPluginModule as unknown as { default?: KatexPlugin }).default ??
  katexPluginModule) as unknown as KatexPlugin;

export interface Heading {
  level: number;
  text: string;
  id: string;
  line: number;
}

export interface RenderEnv extends Env {
  resolveTitle?: (title: string) => string | null;
  drawingRevs?: Record<string, number>;
  headings?: Heading[];
  /**
   * Set by renderMarkdown when the note has maths or code to colour and KaTeX or highlight.js hasn't
   * loaded yet (see renderExtras.ts): settles once they're in, when rendering again gives the real thing.
   */
  pending?: Promise<void>;
  /** With `pending`: there's maths, shown as TeX for now, so the layout will change once it loads. */
  pendingMath?: boolean;
}

/** What the render under way needed that hadn't loaded yet. */
let missingMath = false;
let missingCode = false;

/** A formula's TeX as typed, until KaTeX has loaded (and if it can't be, offline). */
function pendingMath(tex: string, display: boolean): string {
  const mark = display ? '$$' : '$';
  return `<span class="kb-math-pending">${escapeHtml(mark + tex + mark)}</span>`;
}

const md = markdownIt({ html: true, linkify: true, typographer: true, breaks: true });

/*
 * The reading view acts on a few markers in the rendered note: tick boxes, Edit buttons, diagram
 * sources, links that create notes. HTML written in a note could copy them, to fake a control that
 * acts on some other part of the note. So the renderer stamps the elements it makes itself with a
 * value that's new for every render (which a note can't know in advance), and the sanitizer strips
 * the markers from anything not stamped. See the afterSanitizeAttributes hook below.
 */
let stampValue = '';
const stamp = () => (stampValue ? ` data-kb="${stampValue}"` : '');
// data-remote-src and kb-remote too: a note's own "click to load" box could name one site and load
// another. The app's boxes are made after the markers are stripped (blockRemoteLoads).
const MARKER_ATTRS = [
  'data-action',
  'data-task-line',
  'data-src',
  'data-line-end',
  'data-drawing-id',
  'data-wikilink-new',
  'data-note-id',
  'data-rendered',
  'data-remote-src',
  'data-embed-id',
  'data-embed-heading',
];
const MARKER_CLASSES = ['kb-task-box', 'kb-mermaid', 'kb-drawing', 'kb-remote', 'kb-embed'];

/*
 * Images from other websites: with remoteImages 'ask', each one in a note shows as a labelled box that
 * loads the image when clicked (each request tells that website someone opened the note), and other
 * ways a note could load from elsewhere (backgrounds, video posters, SVG images) are dropped. Images
 * clicked to load are remembered until the page is closed.
 */
let blockRemote = false;
const allowedRemote = new Set<string>();

/*
 * Uploads and drawings in an encrypted library (opts.assets 'decrypt'): an image, video or audio
 * element pointing at one gets its address as data-kb-asset instead of src, so the browser never asks
 * the server for it directly (it would get ciphertext). The page decrypts it and fills it in (assets.ts).
 * Raw HTML in a note gets the same treatment, so nothing loads an attachment around that.
 */
let decryptAssets = false;
const ASSET_PATH = /^\/api\/(files\/[A-Za-z0-9_-]{6,64}(?:[/?#]|$)|drawings\/[A-Za-z0-9_-]{6,64}\.svg(?:[?#]|$))/;

/** The upload or drawing an address points at on this site (path and query), or null. */
function assetPath(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value.trim(), location.href);
    if (url.origin !== location.origin) return null;
    const path = url.pathname + url.search;
    return ASSET_PATH.test(path) ? path : null;
  } catch {
    return null;
  }
}

/** A stylesheet value loading something from /api/files or /api/drawings (here or written absolute). */
const ASSET_IN_CSS = /url\(\s*['"]?\s*(?:[a-z][a-z0-9+.-]*:)?(?:\/\/[^/'")\s]*)?\/api\/(?:files|drawings)\//i;

function deferAsset(el: Element) {
  const tag = el.nodeName;
  // Every other way note HTML could load an attachment straight from the server: dropped.
  for (const name of ['srcset', 'poster', 'href', 'xlink:href', 'src', 'data', 'background']) {
    const value = el.getAttribute(name);
    if (value === null) continue;
    if (name === 'src' && (tag === 'IMG' || tag === 'VIDEO' || tag === 'AUDIO' || tag === 'SOURCE')) continue;
    // A link's href is followed only when clicked, and opens the file through the app.
    if (name.endsWith('href') && !['image', 'use', 'feimage'].includes(tag.toLowerCase())) continue;
    const hit = name === 'srcset' ? value.split(',').some((c) => assetPath(c.trim().split(/\s+/)[0])) : !!assetPath(value);
    if (hit) el.removeAttribute(name);
  }
  const style = (el as HTMLElement).style as CSSStyleDeclaration | undefined;
  if (style?.length) {
    for (const prop of Array.from({ length: style.length }, (_, i) => style.item(i))) {
      if (ASSET_IN_CSS.test(style.getPropertyValue(prop))) style.removeProperty(prop);
    }
    if (!el.getAttribute('style')?.trim()) el.removeAttribute('style');
  }
  if (tag !== 'IMG' && tag !== 'VIDEO' && tag !== 'AUDIO' && tag !== 'SOURCE') return;
  const path = assetPath(el.getAttribute('src'));
  if (!path) return;
  el.removeAttribute('src');
  el.setAttribute('data-kb-asset', path);
  el.classList.add('kb-asset-pending');
  if (tag === 'VIDEO' || tag === 'AUDIO') el.setAttribute('preload', 'none');
}

/** An address on another site (http, https or protocol-relative). Same-site, data: and blob: are local. */
export function isRemoteUrl(url: string): boolean {
  try {
    const u = new URL(url, location.href);
    return (u.protocol === 'http:' || u.protocol === 'https:') && u.origin !== location.origin;
  } catch {
    return false;
  }
}

export const remoteAllowed = (url: string) => allowedRemote.has(url);
export const allowRemote = (url: string) => void allowedRemote.add(url);

const blocked = (url: string | null) => !!url && isRemoteUrl(url) && !allowedRemote.has(url);

function blockRemoteLoads(el: Element) {
  const tag = el.nodeName.toLowerCase();
  const src = el.getAttribute('src');
  if (tag === 'img' && blocked(src)) {
    const host = new URL(src!, location.href).host;
    const alt = el.getAttribute('alt')?.trim();
    el.setAttribute('data-remote-src', src!);
    el.removeAttribute('src');
    el.removeAttribute('srcset');
    el.classList.add('kb-remote');
    el.setAttribute('alt', `${alt ? `${alt}. ` : ''}Image from ${host}: click to load`);
    el.setAttribute('title', `Click to load this image from ${host}`);
  } else if (blocked(src)) {
    el.removeAttribute('src');
  }
  for (const name of ['srcset', 'poster', 'background', 'href', 'xlink:href']) {
    const value = el.getAttribute(name);
    // href only where it loads something (SVG image and use), not on links.
    if (name.endsWith('href') && tag !== 'image' && tag !== 'use' && tag !== 'feimage') continue;
    // srcset read candidate by candidate, as the browser does: "/\host/x.png" is another site too.
    if (name === 'srcset' ? !!value && srcsetLoadsRemote(value, isRemoteUrl) : blocked(value)) el.removeAttribute(name);
  }
  // Backgrounds, cursors, masks and SVG paints from another site, however the address is written.
  dropRemoteCss(el, isRemoteUrl);
}

function newStamp(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

const attr = (t: Token, name: string) => {
  const v = t.attrGet(name);
  return v === null ? '' : String(v);
};

/* ------------------------------------------------------------- fences --- */

md.renderer.rules.fence = (tokens, idx) => {
  const t = tokens[idx];
  const info = t.info.trim();
  const lang = (info.split(/\s+/)[0] || '').toLowerCase();
  const start = t.map?.[0] ?? -1;
  const end = t.map?.[1] ?? -1;
  const lines = `data-line="${start}" data-line-end="${end}"`;
  if (lang === 'mermaid') {
    // Encoded because the sanitizer drops attribute values containing "-->", which every arrow has.
    return `<div class="kb-mermaid"${stamp()} ${lines} data-src="${encodeURIComponent(t.content)}"><pre class="kb-mermaid-pending">${escapeHtml(
      t.content,
    )}</pre></div>\n`;
  }
  let body = escapeHtml(t.content);
  const hljs = loadedHljs();
  // Without colours (the same layout) until highlight.js has loaded.
  if (lang && !hljs) missingCode = true;
  else if (lang && hljs?.getLanguage(lang)) {
    try {
      body = hljs.highlight(t.content, { language: lang, ignoreIllegals: true }).value;
    } catch {
      // as plain text
    }
  }
  const label = lang ? escapeHtml(lang) : 'text';
  return `<div class="kb-code" ${lines}><div class="kb-code-bar"><span>${label}</span><button type="button" class="kb-code-copy"${stamp()} data-action="copy-code">Copy</button></div><pre><code class="hljs${
    lang ? ` language-${escapeHtml(lang)}` : ''
  }">${body}</code></pre></div>\n`;
};

/**
 * KaTeX for the Markdown plugin, remembering each formula's HTML. A note is rendered again in full on
 * every change (each pause in typing in split view), which would otherwise typeset every formula again.
 */
const typesetCache = new Map<string, string>();
const cachedKatex = {
  renderToString(tex: string, options: KatexOptions = {}): string {
    const key = `${options.displayMode ? 'D' : 'I'}${options.throwOnError === false ? '' : 'T'}\u0000${tex}`;
    let html = typesetCache.get(key);
    if (html === undefined) {
      const katex = loadedKatex();
      if (!katex) {
        missingMath = true;
        return pendingMath(tex, !!options.displayMode);
      }
      html = katex.renderToString(tex, options);
      typesetCache.set(key, html);
      if (typesetCache.size > 1000) typesetCache.delete(typesetCache.keys().next().value!);
    }
    return html;
  },
};

md.use(footnote);
// Wraps the fence renderer above so ```math blocks render as display math.
md.use(katexPlugin, { enableFencedBlocks: true, throwOnError: false, katex: cachedKatex });

/* ----------------------------------------------------------- callouts --- */

const CALLOUT_KIND: Record<string, string> = {
  note: 'note',
  info: 'note',
  todo: 'note',
  abstract: 'abstract',
  summary: 'abstract',
  tldr: 'abstract',
  tip: 'tip',
  hint: 'tip',
  important: 'tip',
  success: 'success',
  check: 'success',
  done: 'success',
  question: 'question',
  help: 'question',
  faq: 'question',
  warning: 'warning',
  caution: 'warning',
  attention: 'warning',
  danger: 'danger',
  error: 'danger',
  failure: 'danger',
  fail: 'danger',
  missing: 'danger',
  bug: 'danger',
  example: 'example',
  quote: 'quote',
  cite: 'quote',
};

const ICON_PATHS: Record<string, string> = {
  note: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
  abstract: '<path d="M8 6h13"/><path d="M8 12h13"/><path d="M8 18h13"/><path d="M3 6h.01"/><path d="M3 12h.01"/><path d="M3 18h.01"/>',
  tip: '<path d="M9 18h6"/><path d="M10 22h4"/><path d="M12 2a7 7 0 0 0-4 12.7V17h8v-2.3A7 7 0 0 0 12 2Z"/>',
  success: '<path d="M20 6 9 17l-5-5"/>',
  question: '<circle cx="12" cy="12" r="10"/><path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3"/><path d="M12 17h.01"/>',
  warning: '<path d="m21.7 18-8-14a2 2 0 0 0-3.4 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.7-3Z"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
  danger: '<circle cx="12" cy="12" r="10"/><path d="m15 9-6 6"/><path d="m9 9 6 6"/>',
  example: '<path d="M3 3h18v18H3z"/><path d="M8 12h8"/><path d="M12 8v8"/>',
  quote: '<path d="M3 21c3 0 7-1 7-8V5H3v8h4"/><path d="M14 21c3 0 7-1 7-8V5h-7v8h4"/>',
};

function calloutIcon(kind: string) {
  return `<svg class="kb-callout-icon" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${
    ICON_PATHS[kind] ?? ICON_PATHS.note
  }</svg>`;
}

md.core.ruler.after('block', 'kb_callouts', (state: StateCore) => {
  const tokens = state.tokens;
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].type !== 'blockquote_open') continue;
    const para = tokens[i + 1];
    const inline = tokens[i + 2];
    if (para?.type !== 'paragraph_open' || inline?.type !== 'inline') continue;
    const lines = inline.content.split('\n');
    const m = /^\[!([A-Za-z-]+)\]([+-]?)[ \t]*(.*)$/.exec(lines[0]);
    if (!m) continue;
    const type = m[1].toLowerCase();
    const kind = CALLOUT_KIND[type] ?? 'note';
    const title = m[3].trim() || type.charAt(0).toUpperCase() + type.slice(1);
    tokens[i].attrJoin('class', 'kb-callout');
    tokens[i].attrSet('data-callout', kind);
    const titleToken = new state.Token('html_block', '', 0);
    titleToken.content = `<div class="kb-callout-title">${calloutIcon(kind)}<span>${escapeHtml(title)}</span></div>\n`;
    const rest = lines.slice(1).join('\n');
    if (rest.trim()) {
      inline.content = rest;
      tokens.splice(i + 1, 0, titleToken);
    } else {
      // Title-only first paragraph: drop paragraph_open, inline, paragraph_close.
      tokens.splice(i + 1, 3, titleToken);
    }
  }
});

/* ------------------------------------------------------------- tasks ---- */

md.core.ruler.after('inline', 'kb_tasks', (state: StateCore) => {
  const tokens = state.tokens;
  for (let i = 2; i < tokens.length; i++) {
    const inline = tokens[i];
    if (inline.type !== 'inline' || tokens[i - 1].type !== 'paragraph_open' || tokens[i - 2].type !== 'list_item_open') {
      continue;
    }
    const m = /^\[([ xX])\](?:[  ]|$)/.exec(inline.content);
    const first = inline.children?.[0];
    if (!m || !first || first.type !== 'text' || !/^\[[ xX]\]/.test(first.content)) continue;
    const checked = m[1] !== ' ';
    first.content = first.content.replace(/^\[[ xX]\][  ]?/, '');
    const li = tokens[i - 2];
    // The paragraph's first line is the box's ("-" alone on the line before is the item's).
    const para = tokens[i - 1];
    const line = para.map ? para.map[0] : li.map ? li.map[0] : -1;
    li.attrJoin('class', checked ? 'kb-task is-done' : 'kb-task');
    const box = new state.Token('html_inline', '', 0);
    box.content = `<input type="checkbox" class="kb-task-box"${stamp()} name="task-${line}" data-task-line="${line}"${
      checked ? ' checked' : ''
    } aria-label="Mark task ${checked ? 'not done' : 'done'}">`;
    inline.children!.unshift(box);
    for (let j = i - 3; j >= 0; j--) {
      const t = tokens[j];
      if ((t.type === 'bullet_list_open' || t.type === 'ordered_list_open') && t.level === li.level - 1) {
        if (!attr(t, 'class').includes('kb-task-list')) t.attrJoin('class', 'kb-task-list');
        break;
      }
    }
  }
});

/* ---------------------------------------------------- headings & lines --- */

/** A heading's words as read: its text and code, and a linked note by the name shown. */
function headingText(inline: Token | undefined): string {
  if (!inline?.children) return inline?.content ?? '';
  return inline.children
    .map((c) => {
      if (c.type === 'text' || c.type === 'code_inline') return c.content;
      if (c.type === 'kb_wikilink') {
        const { target, alias } = c.meta as { target: string; alias?: string };
        return alias || target;
      }
      return '';
    })
    .join('');
}

md.core.ruler.push('kb_headings', (state: StateCore) => {
  const env = state.env as RenderEnv;
  const tokens = state.tokens;
  const found: Array<{ token: Token; text: string; slug: string }> = [];
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].type !== 'heading_open') continue;
    const text = headingText(tokens[i + 1]);
    found.push({ token: tokens[i], text, slug: `h-${slugify(text)}` });
  }
  // Each heading keeps its own id where it can; a repeated one is numbered with a suffix no other
  // heading has as its own, so "Step", "Step", "Step 1" are h-step, h-step-2, h-step-1.
  const natural = new Set(found.map((h) => h.slug));
  const used = new Set<string>();
  for (const h of found) {
    let slug = h.slug;
    for (let n = 1; used.has(slug); n++) {
      slug = `${h.slug}-${n}`;
      if (natural.has(slug)) slug = h.slug; // someone else's own id: try the next number
    }
    used.add(slug);
    h.token.attrSet('id', slug);
    env.headings?.push({ level: Number(h.token.tag.slice(1)), text: h.text, id: slug, line: h.token.map?.[0] ?? 0 });
  }
});

md.core.ruler.push('kb_lines', (state: StateCore) => {
  for (const t of state.tokens) {
    if (t.map && t.nesting === 1 && t.block) t.attrSet('data-line', String(t.map[0]));
  }
});

/* --------------------------------------------------------- wikilinks ---- */

/**
 * A "[[…]]" starting at `pos`: where its "]]" is, or -1. The first "]]", with no "[" or line break
 * before it, found by stopping at either, rather than searching the rest of the text for "]]" from
 * every "[[" (quadratic: "[[" 40,000 times took a second).
 */
function wikilinkEnd(state: StateInline, pos: number): number {
  const { src } = state;
  if (src.charCodeAt(pos) !== 0x5b || src.charCodeAt(pos + 1) !== 0x5b) return -1;
  for (let i = pos + 2; i + 1 < state.posMax; i++) {
    const c = src.charCodeAt(i);
    if (c === 0x5b || c === 0x0a) return -1;
    if (c === 0x5d && src.charCodeAt(i + 1) === 0x5d) return src.slice(pos + 2, i).trim() ? i : -1;
  }
  return -1;
}

function pushWikilink(state: StateInline, type: 'kb_wikilink' | 'kb_embed', inner: string) {
  const [target, alias] = inner.split('|');
  const tok = state.push(type, '', 0);
  tok.meta = { target: target.trim(), alias: alias?.trim() };
}

md.inline.ruler.before('link', 'kb_wikilink', (state: StateInline, silent: boolean) => {
  const end = wikilinkEnd(state, state.pos);
  if (end < 0) return false;
  if (!silent) pushWikilink(state, 'kb_wikilink', state.src.slice(state.pos + 2, end));
  state.pos = end + 2;
  return true;
});

// "![[Note]]" (or "![[Note#Heading]]"): that note shown here, read-only (filled in by embeds.ts).
md.inline.ruler.before('kb_wikilink', 'kb_embed', (state: StateInline, silent: boolean) => {
  if (state.src.charCodeAt(state.pos) !== 0x21) return false;
  const end = wikilinkEnd(state, state.pos + 1);
  if (end < 0) return false;
  if (!silent) pushWikilink(state, 'kb_embed', state.src.slice(state.pos + 3, end));
  state.pos = end + 2;
  return true;
});

md.renderer.rules.kb_embed = (tokens, idx, _opts, rawEnv) => {
  const env = (rawEnv ?? {}) as RenderEnv;
  const { target, alias } = tokens[idx].meta as { target: string; alias?: string };
  const [title, heading] = target.split('#');
  const label = escapeHtml(alias || target);
  // A heading of this note: its name (the note is already here).
  if (!title.trim()) return label;
  const found = env.resolveTitle?.(title.trim()) ?? null;
  const id = found && /^[A-Za-z0-9_-]{1,64}$/.test(found) ? escapeHtml(found) : null;
  if (!id) return `<a class="kb-wikilink is-missing"${stamp()} href="#" data-wikilink-new="${escapeHtml(title.trim())}" title="Create this note">${label}</a>`;
  const section = heading?.trim() ? ` data-embed-heading="${escapeHtml(heading.trim())}"` : '';
  const hash = heading?.trim() ? `#h-${escapeHtml(slugify(heading))}` : '';
  // Until it's filled in (and wherever it isn't: exported, or a note that can't be read), a link to it.
  return `<span class="kb-embed"${stamp()} data-embed-id="${id}"${section}><a class="kb-wikilink kb-embed-link"${stamp()} href="/note/${id}${hash}" data-note-id="${id}">${label}</a></span>`;
};

md.renderer.rules.kb_wikilink = (tokens, idx, _opts, rawEnv) => {
  const env = (rawEnv ?? {}) as RenderEnv;
  const { target, alias } = tokens[idx].meta as { target: string; alias?: string };
  const [title, heading] = target.split('#');
  const label = escapeHtml(alias || target);
  // [[#Heading]]: a heading in this note.
  if (!title.trim()) return heading?.trim() ? `<a class="kb-wikilink" href="#h-${slugify(heading)}">${label}</a>` : label;
  const found = env.resolveTitle?.(title.trim()) ?? null;
  // The id comes from the note list (from the server): only one of the usual form goes into the page,
  // and escaped, so it can't add attributes to a link the renderer marks as its own.
  const id = found && /^[A-Za-z0-9_-]{1,64}$/.test(found) ? escapeHtml(found) : null;
  if (id) {
    const hash = heading ? `#h-${escapeHtml(slugify(heading))}` : '';
    return `<a class="kb-wikilink"${stamp()} href="/note/${id}${hash}" data-note-id="${id}">${label}</a>`;
  }
  return `<a class="kb-wikilink is-missing"${stamp()} href="#" data-wikilink-new="${escapeHtml(title.trim())}" title="Create this note">${label}</a>`;
};

/* --------------------------------------------------------- ==mark== ---- */

/**
 * The last search for a closing "==" that found none, per paragraph being read: from `from` to the
 * end of its line (`end`, within `max`). Any later "==" on that line, read further along, would search
 * the same stretch again and find none either (markdown-it reads left to right, so it's never inside
 * a code span or after an escape the search stepped over). Without this, a line of "==a ==a ==a …"
 * was searched to its end from every one of them: 160 KB took 23 seconds.
 */
const markMisses = new WeakMap<StateInline, { max: number; from: number; end: number }>();

/**
 * Where the "==" closing a highlight opened before `from` is, on the same line, or -1. Code spans
 * (`a == b`) and escaped characters are stepped over, as markdown-it reads them.
 */
function closingMark(state: StateInline, from: number, max: number): number {
  const miss = markMisses.get(state);
  if (miss && miss.max === max && from >= miss.from && from < miss.end) return -1;
  const end = closingMarkScan(state.src, from, max);
  if (end.at < 0) {
    // The earliest miss on the line counts (a link's label is read ahead, then the text again from its start).
    const same = miss && miss.max === max && miss.end === end.lineEnd;
    markMisses.set(state, { max, from: same ? Math.min(miss.from, from) : from, end: end.lineEnd });
  }
  return end.at;
}

function closingMarkScan(src: string, from: number, max: number): { at: number; lineEnd: number } {
  const lineEnd = src.indexOf('\n', from);
  const end = lineEnd < 0 || lineEnd > max ? max : lineEnd;
  for (let i = from; i < end; i++) {
    const c = src.charCodeAt(i);
    if (c === 0x5c) {
      i++;
    } else if (c === 0x60) {
      let j = i;
      while (j < end && src.charCodeAt(j) === 0x60) j++;
      const run = src.slice(i, j);
      // The code span closes at the next run of exactly as many backticks; with none, they're text.
      let close = src.indexOf(run, j);
      while (close >= 0 && close < end && (src.charCodeAt(close + run.length) === 0x60 || src.charCodeAt(close - 1) === 0x60)) {
        let k = close;
        while (src.charCodeAt(k) === 0x60) k++;
        close = src.indexOf(run, k);
      }
      i = close >= 0 && close + run.length <= end ? close + run.length - 1 : j - 1;
    } else if (c === 0x3d && src.charCodeAt(i + 1) === 0x3d) {
      // It closes only after a non-space.
      if (!/\s/.test(src[i - 1])) return { at: i, lineEnd: end };
      i++;
    }
  }
  return { at: -1, lineEnd: end };
}

md.inline.ruler.before('emphasis', 'kb_mark', (state: StateInline, silent: boolean) => {
  const start = state.pos;
  const src = state.src;
  if (src.charCodeAt(start) !== 0x3d || src.charCodeAt(start + 1) !== 0x3d) return false;
  // Like emphasis, it opens only before a non-space ("plain== and" doesn't open).
  if (start + 2 >= state.posMax || /\s/.test(src[start + 2])) return false;
  const end = closingMark(state, start + 2, state.posMax);
  if (end < 0 || end === start + 2) return false;
  if (!silent) {
    state.push('mark_open', 'mark', 1);
    const oldMax = state.posMax;
    state.pos = start + 2;
    state.posMax = end;
    state.md.inline.tokenize(state);
    state.posMax = oldMax;
    state.push('mark_close', 'mark', -1);
  }
  state.pos = end + 2;
  return true;
});

/* ------------------------------------------------------ images, links --- */

const DRAWING_RE = /^\/api\/drawings\/([A-Za-z0-9_-]+)\.svg/;
const VIDEO_RE = /\.(mp4|webm|mov|m4v|ogv)(\?|#|$)/i;
const AUDIO_RE = /\.(mp3|m4a|wav|ogg|oga|flac|aac)(\?|#|$)/i;

md.renderer.rules.image = (tokens, idx, options, rawEnv, self) => {
  const env = (rawEnv ?? {}) as RenderEnv;
  const t = tokens[idx];
  let alt = self.renderInlineAsText(t.children ?? [], options, env);
  const src = attr(t, 'src');
  const title = attr(t, 'title');
  let width: string | undefined;
  let height: string | undefined;
  // Unambiguous (spaces before the bar are trimmed after), so a long run of spaces can't make it slow.
  const size = /^(.*?)\|\s*(\d{1,4})(?:x(\d{1,4}))?$/.exec(alt);
  if (size) {
    alt = size[1].trimEnd();
    width = size[2];
    height = size[3];
  }
  const dims = `${width ? ` width="${width}"` : ''}${height ? ` height="${height}"` : ''}`;
  const titleAttr = title ? ` title="${escapeHtml(title)}"` : '';

  if (VIDEO_RE.test(src)) {
    return `<video class="kb-media" src="${escapeHtml(src)}" controls preload="metadata"${dims}${titleAttr}></video>`;
  }
  if (AUDIO_RE.test(src)) {
    return `<audio class="kb-media" src="${escapeHtml(src)}" controls preload="metadata"${titleAttr}></audio>`;
  }
  const drawing = DRAWING_RE.exec(src);
  if (drawing) {
    const id = drawing[1];
    const rev = env.drawingRevs?.[id];
    const finalSrc = rev ? `/api/drawings/${id}.svg?v=${rev}` : src;
    return `<span class="kb-drawing"${stamp()} data-drawing-id="${id}"><img class="kb-drawing-img" src="${escapeHtml(
      finalSrc,
    )}" alt="${escapeHtml(alt || 'Drawing')}" loading="lazy"${dims}${titleAttr}><button type="button" class="kb-block-edit"${stamp()} data-action="edit-drawing" data-drawing-id="${id}">Edit drawing</button></span>`;
  }
  return `<img src="${escapeHtml(src)}" alt="${escapeHtml(alt)}" loading="lazy"${dims}${titleAttr}>`;
};

const defaultLinkOpen =
  md.renderer.rules.link_open ?? ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));
md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  const href = attr(tokens[idx], 'href');
  if (/^https?:\/\//i.test(href)) {
    tokens[idx].attrSet('target', '_blank');
    tokens[idx].attrSet('rel', 'noopener noreferrer');
  }
  return defaultLinkOpen(tokens, idx, options, env, self);
};

md.renderer.rules.table_open = (tokens: Token[], idx, options, _env, self) =>
  `<div class="kb-table-wrap">${self.renderToken(tokens, idx, options)}`;
md.renderer.rules.table_close = (tokens: Token[], idx, options, _env, self) =>
  `${self.renderToken(tokens, idx, options)}</div>`;

/* ---------------------------------------------------------- sanitize ---- */

DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.nodeType !== 1) return;
  const el = node as Element;
  // Any link opening elsewhere (HTML or SVG <a>, any target) can't reach back into this page.
  const name = el.nodeName.toLowerCase();
  if ((name === 'a' || name === 'area') && el.hasAttribute('target')) el.setAttribute('rel', 'noopener noreferrer');

  // The app's markers only on elements this render made (see stampValue above).
  const mark = el.getAttribute('data-kb');
  if (mark !== null) el.removeAttribute('data-kb');
  if (!stampValue || mark !== stampValue) {
    for (const name of MARKER_ATTRS) if (el.hasAttribute(name)) el.removeAttribute(name);
    for (const name of MARKER_CLASSES) el.classList?.remove(name);
  }

  // Nothing in a note may pin itself over the app (a fake lock screen, say): only positioning that
  // stays inside the note area (the positioned container, prose.css) is kept, so neither "fixed" nor
  // a variable that turns into it (position: var(--p)). Popovers and dialogs never get this far
  // (PURIFY_CONFIG).
  keepPositionInNote(el);

  if (blockRemote) {
    blockRemoteLoads(el);
    if (el.hasAttribute('style') && !el.getAttribute('style')?.trim()) el.removeAttribute('style');
  }

  // Only the renderer sets these (below); one written in a note is dropped first.
  if (el.hasAttribute('data-kb-asset')) el.removeAttribute('data-kb-asset');
  if (decryptAssets) deferAsset(el);
});

const PURIFY_CONFIG = {
  USE_PROFILES: { html: true, svg: true, mathMl: true },
  ADD_ATTR: ['target', 'loading', 'controls', 'preload'],
  // Dialogs and popovers open in the browser's top layer, over the whole app, whatever their styles.
  FORBID_TAGS: ['style', 'form', 'script', ...TOP_LAYER_TAGS],
  FORBID_ATTR: TOP_LAYER_ATTRS,
};

const mathCache = new Map<string, string>();

/**
 * One formula as HTML, with the same KaTeX settings as reading view (errors show in red rather
 * than throwing), sanitized like everything else rendered from a note. Cached: the editor asks
 * again every time the cursor moves.
 */
export function renderMath(tex: string, display: boolean): string {
  const key = `${display ? 'D' : 'I'}\u0000${tex}`;
  const hit = mathCache.get(key);
  if (hit !== undefined) return hit;
  const katex = loadedKatex();
  // Not kept: the formula replaces it once KaTeX is in (see fillMath).
  if (!katex) return pendingMath(tex, display);
  let html: string;
  try {
    html = katex.renderToString(tex, { displayMode: display, throwOnError: false });
  } catch (err) {
    html = `<span class="katex-error">${escapeHtml(err instanceof Error ? err.message : String(err))}</span>`;
  }
  html = DOMPurify.sanitize(html, PURIFY_CONFIG) as unknown as string;
  mathCache.set(key, html);
  if (mathCache.size > 500) mathCache.delete(mathCache.keys().next().value!);
  return html;
}

/**
 * Puts a formula into `el`: now, or as its TeX until KaTeX has loaded and then the formula (the
 * editor's first formula in a session). `then` runs after a late fill (the size changed).
 */
export function fillMath(el: HTMLElement, tex: string, display: boolean, then?: () => void): void {
  el.innerHTML = renderMath(tex, display);
  if (loadedKatex()) return;
  loadExtras().then(
    () => {
      el.innerHTML = renderMath(tex, display);
      then?.();
    },
    () => undefined, // offline: the TeX stays
  );
}

export function renderMarkdown(
  src: string,
  env: RenderEnv = {},
  opts: { breaks?: boolean; remoteImages?: 'load' | 'ask'; assets?: 'load' | 'decrypt' } = {},
): string {
  md.set({ breaks: opts.breaks ?? true });
  env.headings = [];
  delete env.pending;
  delete env.pendingMath;
  stampValue = newStamp();
  blockRemote = opts.remoteImages === 'ask';
  decryptAssets = opts.assets === 'decrypt';
  missingMath = false;
  missingCode = false;
  try {
    const html = md.render(src, env);
    if (missingMath || missingCode) {
      const pending = loadExtras();
      pending.catch(() => undefined); // the caller may not wait for it; a failure just keeps the stand-ins
      env.pending = pending;
      env.pendingMath = missingMath;
    }
    return DOMPurify.sanitize(html, PURIFY_CONFIG) as unknown as string;
  } finally {
    stampValue = '';
    blockRemote = false;
    decryptAssets = false;
  }
}

/**
 * The code in the fenced block that opens on `line` (0-based), as reading view shows it: fences left
 * out, and the indent or `> ` of a list or quote it sits in taken off.
 */
export function fenceCode(src: string, line: number): string | null {
  const block = md.parse(src, {}).find((t) => t.type === 'fence' && t.map?.[0] === line);
  return block ? block.content : null;
}

/**
 * A code block's code as its Copy button copies it (in reading view and the editor alike): without the
 * line break that ends the last line, or any blank lines after it, so a command pasted into a terminal
 * waits for Enter instead of running straight away.
 */
export const codeToCopy = (code: string) => code.replace(/(?:\r?\n)+$/, '');

export function extractHeadings(src: string): Heading[] {
  const env: RenderEnv = { headings: [] };
  md.parse(src, env);
  return env.headings ?? [];
}
