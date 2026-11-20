/**
 * Pasting formatted text (a web page, Google Docs, Word, an email, Lumen's own reading view) as
 * Markdown, so headings, lists, links, tables, code and formulas survive instead of arriving as one
 * flat run of text. Ctrl/⌘ Shift V still pastes plain text: browsers send no HTML for it.
 *
 * The HTML is parsed into an inert document (DOMParser): nothing in it runs or loads.
 */
import TurndownService from 'turndown';

type Node_ = Node;

const BLOCK_START = /^(#{1,6}\s|[-*+]\s|\d+[.)]\s|>|```|~~~|\||\$\$|---\s*$)/;

/** Elements whose content is never wanted in a note (Word's <o:p> is an empty paragraph marker). */
const DROP = ['script', 'style', 'meta', 'link', 'title', 'noscript', 'template', 'iframe', 'object', 'embed', 'canvas', 'button', 'select', 'textarea', 'svg', 'o\\:p'];

const hasStyle = (el: Element, re: RegExp) => re.test(el.getAttribute('style') ?? '');

/** Absolute links to this site become the paths Lumen writes (/note/…, /api/files/…). */
function localPath(href: string): string {
  try {
    const url = new URL(href, location.href);
    if (url.origin === location.origin && /^\/(note|api)\//.test(url.pathname)) return url.pathname + url.search + url.hash;
  } catch {
    /* leave it */
  }
  return href;
}

/** Only web, mail and Lumen's own links are kept; anything relative to the page it came from isn't. */
function cleanHref(raw: string | null): string | null {
  if (!raw) return null;
  const href = raw.trim();
  if (/^(https?:|mailto:)/i.test(href)) return localPath(href);
  if (/^\/(note|api)\//.test(href)) return href;
  return null;
}

function cleanSrc(raw: string | null): string | null {
  if (!raw) return null;
  const src = raw.trim();
  if (/^https?:/i.test(src)) return localPath(src);
  if (/^\/api\/(files|drawings)\//.test(src)) return src;
  // data: and blob: images only live in the page they came from (and can be huge).
  return null;
}

/**
 * Google Docs wraps everything in <b style="font-weight:normal"> and marks bold, italic and
 * strikethrough with inline styles on spans; Word adds its own tags. Rewritten as plain elements first.
 */
function normalize(doc: Document) {
  for (const selector of DROP) {
    try {
      doc.querySelectorAll(selector).forEach((el) => el.remove());
    } catch {
      /* a selector this browser can't parse */
    }
  }
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_COMMENT);
  const comments: Node_[] = [];
  while (walker.nextNode()) comments.push(walker.currentNode);
  comments.forEach((c) => c.parentNode?.removeChild(c));

  doc.querySelectorAll('b[id^="docs-internal-guid"], b[style*="font-weight:normal"], b[style*="font-weight: normal"]').forEach(unwrap);

  // <sup>, <sub> and <kbd> are kept as HTML (Markdown has none of them), so only the elements come
  // along: not the page's styles, ids or popover attributes on them or anything inside them (a link's
  // address stays).
  doc.querySelectorAll('sup, sub, kbd').forEach((kept) => {
    for (const el of [kept, ...Array.from(kept.querySelectorAll('*'))]) {
      for (const name of el.getAttributeNames()) if (!(name === 'href' && el.nodeName === 'A')) el.removeAttribute(name);
    }
  });

  // Google Docs puts a nested list straight inside its parent list; HTML (and Markdown) nest it in
  // the item before it.
  doc.querySelectorAll('ul > ul, ul > ol, ol > ul, ol > ol').forEach((list) => {
    const item = list.previousElementSibling;
    if (item?.nodeName === 'LI') item.appendChild(list);
  });
  // An item whose text is one paragraph (Docs wraps every item's text in a <p>) is a line, not a
  // paragraph: the list stays tight ("- a" then "  - b", no blank line between).
  doc.querySelectorAll('li').forEach((li) => {
    const paragraphs = Array.from(li.children).filter((c) => c.nodeName === 'P');
    if (paragraphs.length === 1) unwrap(paragraphs[0]);
  });

  wordLists(doc);

  doc.querySelectorAll<HTMLElement>('span[style]').forEach((span) => {
    let inner: Element = span;
    const wrapWith = (tag: string) => {
      const el = doc.createElement(tag);
      while (inner.firstChild) el.appendChild(inner.firstChild);
      inner.appendChild(el);
      inner = el;
    };
    if (hasStyle(span, /font-weight\s*:\s*(bold|[6-9]00)/i)) wrapWith('strong');
    if (hasStyle(span, /font-style\s*:\s*italic/i)) wrapWith('em');
    if (hasStyle(span, /text-decoration[^;]*line-through/i)) wrapWith('del');
    if (hasStyle(span, /font-family[^;]*(mono|courier|consolas|menlo)/i) && !span.closest('pre')) wrapWith('code');
  });

  // Images and links that can't work here are dropped, keeping a link's text.
  doc.querySelectorAll('img').forEach((img) => {
    const src = cleanSrc(img.getAttribute('src'));
    if (src) img.setAttribute('src', src);
    else img.remove();
  });
  doc.querySelectorAll('a').forEach((a) => {
    const href = cleanHref(a.getAttribute('href'));
    if (href) a.setAttribute('href', href);
    else a.removeAttribute('href');
  });
}

/**
 * Desktop Word and Outlook write a list as paragraphs styled "mso-list:l0 level1 lfo1", each starting
 * with its bullet or number as text (in a span styled "mso-list:Ignore"). Runs of them become real
 * lists, nested by their level, numbered when the marker is a number or letter.
 */
function wordLists(doc: Document) {
  const isItem = (el: Element | null): el is HTMLElement =>
    !!el && el.nodeName === 'P' && /mso-list\s*:\s*l\d+\s+level\d+/i.test(el.getAttribute('style') ?? '');
  for (const first of Array.from(doc.querySelectorAll('p')).filter(isItem)) {
    if (!first.isConnected || isItem(first.previousElementSibling)) continue;
    const run: HTMLElement[] = [];
    for (let p: Element | null = first; isItem(p); p = p.nextElementSibling) run.push(p);
    const stack: Array<{ level: number; list: HTMLElement }> = [];
    for (const p of run) {
      const level = Number(/level(\d+)/i.exec(p.getAttribute('style') ?? '')?.[1] ?? 1);
      const markerSpan = Array.from(p.querySelectorAll('span')).find((s) => /mso-list\s*:\s*ignore/i.test(s.getAttribute('style') ?? ''));
      const marker = (markerSpan?.textContent ?? '').replace(/[\s ]+/g, '');
      markerSpan?.remove();
      const ordered = /^\(?(\d{1,3}|[a-z]|[ivxlcdm]{1,6})[.)]$/i.test(marker);
      while (stack.length && stack[stack.length - 1].level > level) stack.pop();
      let top = stack[stack.length - 1];
      if (!top || top.level < level) {
        const list = doc.createElement(ordered ? 'ol' : 'ul');
        if (top) (top.list.lastElementChild ?? top.list).appendChild(list);
        else p.parentNode?.insertBefore(list, p);
        top = { level, list };
        stack.push(top);
      }
      const li = doc.createElement('li');
      while (p.firstChild) li.appendChild(p.firstChild);
      top.list.appendChild(li);
      p.remove();
    }
  }
}

function unwrap(el: Element) {
  const parent = el.parentNode;
  if (!parent) return;
  while (el.firstChild) parent.insertBefore(el.firstChild, el);
  parent.removeChild(el);
}

/* ---------------------------------------------------------- tables --- */

function cellText(service: TurndownService, cell: HTMLElement): string {
  return service
    .turndown(cell)
    .replace(/\n+/g, ' ')
    .replace(/\|/g, '\\|')
    .trim();
}

/**
 * Set while a table's cells are being converted. Markdown tables can't nest, so a table inside a cell
 * (layout tables in emails nest many deep) becomes its text there. Converting it as a table too would
 * convert everything inside it again at every level: exponential in the depth.
 */
let inTableCell = 0;

/** A GitHub-style table, the first row as its header. Merged cells are spread out rather than lost. */
function tableMarkdown(service: TurndownService, table: HTMLTableElement): string {
  const rows = Array.from(table.rows).filter((r) => r.closest('table') === table);
  if (!rows.length) return '';
  inTableCell++;
  const grid: string[][] = [];
  try {
    // A cell spanning rows leaves its column empty in the rows below, so their cells stay in place.
    const below: number[] = [];
    for (const r of rows) {
      const out: string[] = [];
      let col = 0;
      const skipSpanned = () => {
        while ((below[col] ?? 0) > 0) {
          out[col] = '';
          below[col]--;
          col++;
        }
      };
      for (const c of Array.from(r.cells)) {
        skipSpanned();
        const text = cellText(service, c);
        const across = Math.max(1, Math.min(20, c.colSpan || 1));
        const down = Math.max(1, Math.min(100, c.rowSpan || 1));
        for (let k = 0; k < across; k++) {
          out[col] = k === 0 ? text : '';
          if (down > 1) below[col] = down - 1;
          col++;
        }
      }
      for (; col < below.length; col++) {
        if ((below[col] ?? 0) > 0) {
          out[col] = '';
          below[col]--;
        }
      }
      grid.push(Array.from(out, (cell) => cell ?? ''));
    }
  } finally {
    inTableCell--;
  }
  const width = Math.max(...grid.map((r) => r.length));
  if (width === 0) return '';
  const line = (cells: string[]) => `| ${Array.from({ length: width }, (_, i) => cells[i] ?? '').join(' | ')} |`;
  const [head, ...body] = grid;
  const align = Array.from(rows[0].cells).map((c) => {
    const a = (c.getAttribute('align') ?? (c as HTMLElement).style?.textAlign ?? '').toLowerCase();
    return a === 'center' ? ':---:' : a === 'right' ? '---:' : '---';
  });
  return [line(head), `| ${Array.from({ length: width }, (_, i) => align[i] ?? '---').join(' | ')} |`, ...body.map(line)].join('\n');
}

/* --------------------------------------------------------- service --- */

let service: TurndownService | null = null;

function makeService(): TurndownService {
  const s = new TurndownService({
    headingStyle: 'atx',
    hr: '---',
    bulletListMarker: '-',
    codeBlockStyle: 'fenced',
    fence: '```',
    emDelimiter: '*',
    strongDelimiter: '**',
    linkStyle: 'inlined',
  });

  // Markdown characters in text are escaped, but not underscores inside words (snake_case stays
  // readable; Markdown never treats those as emphasis).
  (s as unknown as { escape: (t: string) => string }).escape = (text: string) =>
    text
      .replace(/\\/g, '\\\\')
      .replace(/\*/g, '\\*')
      .replace(/(^|[^\p{L}\p{N}])_|_(?=[^\p{L}\p{N}]|$)/gu, (m) => m.replace('_', '\\_'))
      .replace(/`/g, '\\`')
      .replace(/\[/g, '\\[')
      .replace(/\]/g, '\\]')
      .replace(/^(#{1,6})(\s)/gm, '\\$1$2')
      .replace(/^([-+])(\s)/gm, '\\$1$2')
      .replace(/^(\d+)([.)])(\s)/gm, '$1\\$2$3')
      .replace(/^>/gm, '\\>')
      .replace(/==/g, '=\\=')
      // Text, not markup: "Vec<String>" isn't a tag, "~~" isn't strikethrough, "$5" doesn't start a formula.
      .replace(/</g, '\\<')
      .replace(/~~/g, '~\\~')
      .replace(/\$/g, '\\$');

  // Lumen's own reading view: [[links]], tick boxes, callouts, diagrams and formulas come back as written.
  s.addRule('wikilink', {
    filter: (node) => node.nodeName === 'A' && (node as Element).classList.contains('kb-wikilink'),
    replacement: (content) => `[[${content.replace(/[[\]]/g, '')}]]`,
  });
  s.addRule('katexDisplay', {
    filter: (node) => (node as Element).classList?.contains('katex-display'),
    replacement: (_c, node) => {
      const tex = (node as Element).querySelector('annotation[encoding="application/x-tex"]')?.textContent?.trim();
      return tex ? `\n\n$$\n${tex}\n$$\n\n` : '';
    },
  });
  s.addRule('katexInline', {
    filter: (node) => (node as Element).classList?.contains('katex') && !(node as Element).closest('.katex-display'),
    replacement: (_c, node) => {
      const tex = (node as Element).querySelector('annotation[encoding="application/x-tex"]')?.textContent?.trim();
      return tex ? `$${tex}$` : '';
    },
  });
  s.addRule('mermaid', {
    filter: (node) => (node as Element).classList?.contains('kb-mermaid'),
    replacement: (_c, node) => {
      let src = '';
      try {
        src = decodeURIComponent((node as Element).getAttribute('data-src') ?? '');
      } catch {
        /* not ours */
      }
      return src.trim() ? `\n\n\`\`\`mermaid\n${src.trim()}\n\`\`\`\n\n` : '';
    },
  });
  s.addRule('lumenCode', {
    filter: (node) => (node as Element).classList?.contains('kb-code-bar'),
    replacement: () => '',
  });
  s.addRule('callout', {
    filter: (node) => node.nodeName === 'BLOCKQUOTE' && (node as Element).classList.contains('kb-callout'),
    replacement: (content, node) => {
      const el = node as Element;
      const kind = el.getAttribute('data-callout') || 'note';
      const title = el.querySelector('.kb-callout-title')?.textContent?.trim() ?? '';
      const body = content.replace(/^\n+|\n+$/g, '');
      const lines = [`[!${kind}]${title ? ` ${title}` : ''}`, ...(body ? body.split('\n') : [])];
      return `\n\n${lines.map((l) => `> ${l}`.trimEnd()).join('\n')}\n\n`;
    },
  });
  s.addRule('calloutTitle', {
    filter: (node) => (node as Element).classList?.contains('kb-callout-title'),
    replacement: () => '',
  });

  // GitHub-flavoured extras: strikethrough, highlights, tick boxes and tables.
  s.addRule('strike', {
    filter: ['del', 's', 'strike'] as never,
    replacement: (content) => (content.trim() ? `~~${content}~~` : content),
  });
  s.addRule('mark', {
    filter: ['mark'] as never,
    replacement: (content) => (content.trim() ? `==${content}==` : content),
  });
  s.addRule('taskBox', {
    filter: (node) => node.nodeName === 'INPUT' && (node as HTMLInputElement).type === 'checkbox' && !!(node as Element).closest('li'),
    replacement: (_c, node) => ((node as HTMLInputElement).hasAttribute('checked') ? '[x] ' : '[ ] '),
  });
  s.addRule('table', {
    filter: ['table'] as never,
    // A table inside another (on the way to its cells, or met before it) is its cells' text.
    replacement: (content, node) =>
      inTableCell > 0 || (node as Element).parentElement?.closest('table')
        ? ` ${content.replace(/\s+/g, ' ').trim()} `
        : `\n\n${tableMarkdown(s, node as HTMLTableElement)}\n\n`,
  });

  // Lists as Lumen writes them: "- item" and "1. item", nested items indented under their text.
  s.addRule('listItem', {
    filter: 'li',
    replacement: (content, node) => {
      const parent = node.parentNode as HTMLElement | null;
      let marker = '- ';
      if (parent?.nodeName === 'OL') {
        const start = Number(parent.getAttribute('start') ?? 1) || 1;
        const index = Array.prototype.indexOf.call(parent.children, node);
        marker = `${start + Math.max(0, index)}. `;
      }
      const body = content
        .replace(/^\n+/, '')
        .replace(/\n+$/, '\n')
        // Lines under the item are indented to its text; blank lines stay blank.
        .replace(/\n(?=[^\n])/g, `\n${' '.repeat(marker.length)}`)
        .replace(/^\[([ x])\]\s+/, '[$1] ');
      return marker + body + (node.nextSibling && !/\n$/.test(body) ? '\n' : '');
    },
  });

  // A <pre> without a <code> inside (many sites' highlighters) is still a code block.
  s.addRule('preOnly', {
    filter: (node) => node.nodeName === 'PRE' && !(node.firstChild && node.firstChild.nodeName === 'CODE'),
    replacement: (_c, node) => {
      const text = (node as Element).textContent?.replace(/\n$/, '') ?? '';
      const classes = `${(node as Element).className} ${(node.parentNode as Element | null)?.className ?? ''}`;
      // GitHub: highlight-source-js, and highlight-text-md for its text grammars.
      const lang = /(?:lang(?:uage)?-|highlight-(?:source-|text-)?)([\w+#]+)/.exec(classes)?.[1] ?? '';
      // A fence longer than any run of backticks in the code, so code holding ``` stays inside.
      const longest = Math.max(2, ...(text.match(/`+/g) ?? []).map((run) => run.length));
      const fence = '`'.repeat(longest + 1);
      return text.trim() ? `\n\n${fence}${lang}\n${text}\n${fence}\n\n` : '';
    },
  });

  s.keep(['sup', 'sub', 'kbd'] as never);
  return s;
}

/** The HTML as Markdown, or null when there's nothing worth converting. */
export function htmlToMarkdown(html: string): string | null {
  if (!html || html.length > 1_500_000) return null;
  return docToMarkdown(new DOMParser().parseFromString(html, 'text/html'));
}

/**
 * Turndown trims the end of what it returns with /[\t\r\n\s]+$/, which is tried again from every
 * space of a run that text follows: a long run of spaces in pasted code (a page can put anything on
 * the clipboard) froze the tab, 40,000 for a second and growing with the square. Only <pre> keeps such
 * a run (elsewhere whitespace collapses), so there long runs are stood in for by a short marker while
 * Turndown runs, and put back after.
 */
const SPACE_RUN = /[ \t]{16,}/g;
const RUN_MARKER = /(\d+)/g;

function standInForSpaceRuns(doc: Document): string[] {
  const runs: string[] = [];
  for (const pre of Array.from(doc.querySelectorAll('pre'))) {
    // A <pre> of nothing but spaces is dropped as empty, as before.
    if (!pre.textContent?.trim()) continue;
    const walker = doc.createTreeWalker(pre, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode as Text;
      if (node.data.length >= 16) node.data = node.data.replace(SPACE_RUN, (run) => `${runs.push(run) - 1}`);
    }
  }
  return runs;
}

function docToMarkdown(doc: Document): string | null {
  if (!doc.body) return null;
  normalize(doc);
  service ??= makeService();
  const runs = standInForSpaceRuns(doc);
  const md = service
    .turndown(doc.body)
    .replace(RUN_MARKER, (marker, i: string) => runs[Number(i)] ?? marker)
    // A line of nothing but spaces (an email's empty line) is empty; two or more after text are a line break.
    .replace(/^[ \t]+$/gm, '')
    // Each run of spaces is tried from its first space only (the lookbehind): tried from every space
    // in it, a long run followed by text was quadratic (40,000 spaces took 2.5 seconds).
    .replace(/(?<![ \t])[ \t]+$/gm, (m) => (m.length >= 2 ? m : ''))
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return md || null;
}

/** Whether `markdown` adds anything over the plain text (formatting, links, structure). */
function addsFormatting(markdown: string, plain: string): boolean {
  const squash = (s: string) => s.replace(/\\(.)/g, '$1').replace(/\s+/g, ' ').trim();
  return squash(markdown) !== squash(plain);
}

/** HTML without its comments, in one pass (a lazy regex rescans to the end from every unclosed "<!--"). */
function withoutComments(html: string): string {
  let out = '';
  let at = 0;
  for (;;) {
    const open = html.indexOf('<!--', at);
    if (open === -1) return out + html.slice(at);
    out += html.slice(at, open);
    const close = html.indexOf('-->', open + 4);
    if (close === -1) return out;
    at = close + 3;
  }
}

/**
 * What to insert for a paste that carries HTML, or null to let the plain text go in as usual: code
 * copied from an editor, a lone link, or HTML that adds nothing over its text.
 */
export function markdownForPaste(data: DataTransfer): string | null {
  const types = Array.from(data.types ?? []);
  if (!types.includes('text/html')) return null;
  // VS Code and other editors put highlighted code on the clipboard as HTML: the text is what's wanted.
  if (types.includes('vscode-editor-data')) return null;
  const plain = data.getData('text/plain') ?? '';
  if (/^\s*https?:\/\/\S+\s*$/.test(plain)) return null;
  const html = data.getData('text/html');
  if (!html || html.length > 1_500_000) return null;
  let md: string | null;
  try {
    const doc = new DOMParser().parseFromString(withoutComments(html), 'text/html');
    // A single block of preformatted text from a code editor or terminal (however the browser wraps
    // it: Chrome on Windows adds <html><body>): its text is what's wanted.
    const blocks = Array.from(doc.body?.children ?? []);
    if (blocks.length === 1 && /^(PRE|CODE)$/.test(blocks[0].nodeName) && doc.body.textContent?.trim() === blocks[0].textContent?.trim()) return null;
    md = docToMarkdown(doc);
  } catch {
    return null;
  }
  if (!md || !addsFormatting(md, plain)) return null;
  return md;
}

/** Whether pasted Markdown starts or ends with a block (list, heading, table…) rather than running text. */
export function startsWithBlock(md: string): boolean {
  return BLOCK_START.test(md);
}

export function endsWithBlock(md: string): boolean {
  const last = md.slice(md.lastIndexOf('\n') + 1);
  return md.includes('\n') || BLOCK_START.test(last);
}
