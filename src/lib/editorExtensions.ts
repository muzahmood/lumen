import { EditorSelection, EditorState, RangeSetBuilder, StateField, type Extension } from '@codemirror/state';
import {
  Decoration,
  EditorView,
  ViewPlugin,
  WidgetType,
  type DecorationSet,
  type ViewUpdate,
} from '@codemirror/view';
import { HighlightStyle, syntaxTree } from '@codemirror/language';
import { startCompletion, type CompletionContext, type CompletionResult } from '@codemirror/autocomplete';
import type { SyntaxNode } from '@lezer/common';
import { tags as t } from '@lezer/highlight';
import {
  insertBlock,
  insertCodeBlock,
  insertFootnote,
  insertTable,
  insertText,
  setHeading,
  toggleLinePrefix,
  toggleWrap,
} from './editorCommands';
import { setAssetSrc } from './assets';
import { isRemoteUrl, remoteAllowed } from './markdown';
import { useSettings } from './settings';
import { findMathBlocks, scanInlineMath } from './mathSyntax';
import { MERMAID_TEMPLATES } from './mermaid';
import { endsWithBlock, markdownForPaste, startsWithBlock } from './pasteHtml';
import { isoDate } from './templateText';

export interface EditorHost {
  openMermaid(code?: string): void;
  openDrawing(): void;
  pickImages(): void;
  pickFiles(): void;
  takePhoto(): void;
  uploadFiles(files: File[]): void;
  noteTitles(): string[];
  /** Notes in the Templates folder, for /template; and putting one's text in at the cursor. */
  templates(): Array<{ id: string; title: string }>;
  insertTemplate(id: string): void;
  /** Live preview hooks. */
  editDrawing(id: string): void;
  editMermaid(startLine: number, endLine: number, code: string): void;
  openLink(href: string): void;
  /** A [[wikilink]] target: "Title", or "Title#Heading" to land on a section. */
  openWikilink(target: string): void;
  noteExists(title: string): boolean;
  assetUrl(src: string): string;
  /** Show an image (or drawing) full size, as clicking one in reading view does. */
  viewImage(src: string, alt: string): void;
  /** Show a rendered diagram full size. */
  viewDiagram(svg: string): void;
}

export type HostRef = { current: EditorHost };

/* ------------------------------------------------------------ styling --- */

export const markdownHighlight = HighlightStyle.define([
  { tag: t.heading1, fontSize: '1.75em', fontWeight: '700', lineHeight: '1.25', letterSpacing: '-0.022em' },
  { tag: t.heading2, fontSize: '1.375em', fontWeight: '650', lineHeight: '1.3', letterSpacing: '-0.016em' },
  { tag: t.heading3, fontSize: '1.15em', fontWeight: '650', letterSpacing: '-0.01em' },
  { tag: [t.heading4, t.heading5, t.heading6], fontWeight: '650' },
  { tag: t.strong, fontWeight: '700' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.strikethrough, textDecoration: 'line-through', color: 'var(--text-3)' },
  { tag: t.link, color: 'var(--accent-text)' },
  { tag: t.url, color: 'var(--text-3)' },
  { tag: t.monospace, fontFamily: 'var(--font-mono)', fontSize: '0.88em', color: 'var(--code-text)' },
  { tag: t.quote, color: 'var(--text-2)' },
  { tag: [t.processingInstruction, t.contentSeparator], color: 'var(--text-3)', fontWeight: '400' },
  { tag: t.labelName, color: 'var(--accent-text)' },
  { tag: t.keyword, color: 'var(--syn-keyword)' },
  { tag: [t.string, t.special(t.string), t.regexp], color: 'var(--syn-string)' },
  { tag: [t.comment, t.lineComment, t.blockComment], color: 'var(--syn-comment)', fontStyle: 'italic' },
  { tag: t.atom, color: 'var(--text-3)' },
  { tag: [t.number, t.bool, t.null], color: 'var(--syn-number)' },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: 'var(--syn-fn)' },
  { tag: [t.typeName, t.className, t.namespace], color: 'var(--syn-type)' },
  { tag: [t.tagName, t.angleBracket], color: 'var(--syn-keyword)' },
  { tag: t.attributeName, color: 'var(--syn-type)' },
  { tag: [t.propertyName, t.definition(t.variableName)], color: 'var(--syn-prop)' },
  { tag: t.meta, color: 'var(--text-3)' },
  { tag: t.invalid, color: 'var(--danger)' },
]);

export const editorTheme = EditorView.theme({
  '&': { backgroundColor: 'transparent', color: 'var(--text)', fontSize: 'var(--note-size)' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { fontFamily: 'var(--font-note)', lineHeight: 'var(--note-leading)', overflow: 'visible' },
  '.cm-content': { padding: '2px 0 40vh', caretColor: 'var(--accent)', width: '100%' },
  '.cm-line': { padding: '0' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--accent)', borderLeftWidth: '2px' },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection':
    { backgroundColor: 'var(--selection)' },
  '.cm-placeholder': { color: 'var(--text-3)' },
  '.cm-code-line': {
    backgroundColor: 'var(--code-bg)',
    fontFamily: 'var(--font-mono)',
    fontSize: '0.86em',
    lineHeight: '1.65',
    fontVariantLigatures: 'none',
    padding: '0 14px',
    boxShadow: '0 1px 0 var(--code-bg)',
  },
  '.cm-code-first': { borderTopLeftRadius: '10px', borderTopRightRadius: '10px', paddingTop: '6px' },
  '.cm-code-last': {
    borderBottomLeftRadius: '10px',
    borderBottomRightRadius: '10px',
    paddingBottom: '6px',
    boxShadow: 'none',
  },
  '.cm-tooltip': {
    border: '1px solid var(--border)',
    backgroundColor: 'var(--bg-elevated)',
    borderRadius: '12px',
    boxShadow: 'var(--shadow-lg)',
    overflow: 'hidden',
  },
  '.cm-tooltip.cm-tooltip-autocomplete > ul': {
    fontFamily: 'var(--font-ui)',
    maxHeight: '22em',
    minWidth: '280px',
    padding: '5px',
  },
  '.cm-tooltip.cm-tooltip-autocomplete > ul > li': {
    padding: '7px 10px !important',
    borderRadius: '7px',
    display: 'flex',
    alignItems: 'center',
    gap: '10px',
    color: 'var(--text)',
  },
  '.cm-tooltip.cm-tooltip-autocomplete > ul > li[aria-selected]': {
    backgroundColor: 'var(--bg-active)',
    color: 'var(--text)',
  },
  '.cm-completionLabel': { fontSize: '13.5px', fontWeight: '500' },
  '.cm-completionDetail': { marginLeft: 'auto', fontStyle: 'normal', color: 'var(--text-3)', fontSize: '12px' },
  '.cm-completionIcon': { display: 'none' },
  '.cm-completionMatchedText': { textDecoration: 'none', color: 'var(--accent-text)' },
  '.cm-panels': { backgroundColor: 'var(--bg-sunken)', color: 'var(--text)', borderColor: 'var(--border)' },
  '.cm-panels input, .cm-panels button': { fontFamily: 'var(--font-ui)', fontSize: '13px' },
  '.cm-searchMatch': { backgroundColor: 'var(--mark)', outline: 'none' },
  '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: 'var(--mark-strong)' },
  '.cm-selectionMatch': { backgroundColor: 'var(--accent-soft)' },
});

/* -------------------------------------------------- fenced code lines --- */

const codeLine = Decoration.line({ class: 'cm-code-line' });
const codeFirst = Decoration.line({ class: 'cm-code-line cm-code-first' });
const codeLast = Decoration.line({ class: 'cm-code-line cm-code-last' });
const codeOnly = Decoration.line({ class: 'cm-code-line cm-code-first cm-code-last' });

function codeDecorations(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  let lastLine = 0;
  for (const { from, to } of view.visibleRanges) {
    syntaxTree(view.state).iterate({
      from,
      to,
      enter: (node) => {
        if (node.name !== 'FencedCode') return;
        const doc = view.state.doc;
        const first = doc.lineAt(node.from).number;
        const last = doc.lineAt(node.to).number;
        for (let n = Math.max(first, lastLine + 1); n <= last; n++) {
          const line = doc.line(n);
          const deco = first === last ? codeOnly : n === first ? codeFirst : n === last ? codeLast : codeLine;
          builder.add(line.from, line.from, deco);
          lastLine = n;
        }
        return false;
      },
    });
  }
  return builder.finish();
}

export const codeBlockLines = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = codeDecorations(view);
    }
    update(u: ViewUpdate) {
      if (u.docChanged || u.viewportChanged || syntaxTree(u.startState) !== syntaxTree(u.state)) {
        this.decorations = codeDecorations(u.view);
      }
    }
  },
  { decorations: (v) => v.decorations },
);

/* ------------------------------------------------- inline image peeks --- */

const IMG_RE = /!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
const MEDIA_RE = /\.(mp4|webm|mov|m4v|ogv|mp3|m4a|wav|ogg|oga|flac|aac)(\?|#|$)/i;

class ImagesWidget extends WidgetType {
  constructor(readonly items: Array<{ src: string; alt: string }>) {
    super();
  }
  eq(other: ImagesWidget) {
    return other.items.length === this.items.length && other.items.every((it, i) => it.src === this.items[i].src);
  }
  toDOM() {
    const wrap = document.createElement('div');
    wrap.className = 'cm-img-peek';
    wrap.setAttribute('aria-hidden', 'true');
    for (const it of this.items) {
      // Settings → Images from other websites, Ask first: no peek (live preview has the box that asks).
      if (useSettings.getState().remoteImages === 'ask' && isRemoteUrl(it.src) && !remoteAllowed(it.src)) continue;
      const img = document.createElement('img');
      img.alt = '';
      img.loading = 'lazy';
      img.decoding = 'async';
      if (it.src.startsWith('/api/drawings/')) img.className = 'is-drawing';
      img.onerror = () => img.remove();
      // Straight from its address, or (in an encrypted library) decrypted first, never asked for by name.
      setAssetSrc(img, it.src, () => img.remove());
      wrap.appendChild(img);
    }
    return wrap;
  }
  get estimatedHeight() {
    return 132;
  }
  ignoreEvent() {
    return true;
  }
}

function imageDecorations(state: EditorState): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const doc = state.doc;
  for (let n = 1; n <= doc.lines; n++) {
    const line = doc.line(n);
    if (!line.text.includes('![')) continue;
    const items: Array<{ src: string; alt: string }> = [];
    IMG_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = IMG_RE.exec(line.text))) {
      const src = m[2];
      if (!/^(\/api\/|https?:\/\/|data:image\/)/.test(src) || MEDIA_RE.test(src)) continue;
      items.push({ src, alt: m[1] });
    }
    if (items.length) {
      builder.add(line.to, line.to, Decoration.widget({ widget: new ImagesWidget(items), block: true, side: 1 }));
    }
  }
  return builder.finish();
}

export const imagePeeks = StateField.define<DecorationSet>({
  create: imageDecorations,
  update: (deco, tr) => (tr.docChanged ? imageDecorations(tr.state) : deco),
  provide: (f) => EditorView.decorations.from(f),
});

/* ---------------------------------------------------- slash commands ---- */

interface SlashItem {
  label: string;
  hint: string;
  keys: string[];
  run: (view: EditorView, host: EditorHost) => void;
}

function template(id: string) {
  return MERMAID_TEMPLATES.find((t) => t.id === id)?.code ?? '';
}

function mermaidBlock(view: EditorView, id: string) {
  const code = template(id);
  insertBlock(view, `\`\`\`mermaid\n${code}\n\`\`\``);
}

const today = () =>
  new Date().toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

export const SLASH_ITEMS: SlashItem[] = [
  { label: 'Heading 1', hint: '#', keys: ['h1', 'heading', 'title'], run: (v) => setHeading(v, 1) },
  { label: 'Heading 2', hint: '##', keys: ['h2', 'heading', 'subtitle'], run: (v) => setHeading(v, 2) },
  { label: 'Heading 3', hint: '###', keys: ['h3', 'heading'], run: (v) => setHeading(v, 3) },
  { label: 'Task list', hint: '- [ ]', keys: ['todo', 'task', 'checkbox', 'check'], run: (v) => toggleLinePrefix(v, 'task') },
  { label: 'Bulleted list', hint: '-', keys: ['bullet', 'list', 'ul'], run: (v) => toggleLinePrefix(v, 'bullet') },
  { label: 'Numbered list', hint: '1.', keys: ['number', 'ordered', 'ol', 'list'], run: (v) => toggleLinePrefix(v, 'number') },
  { label: 'Image', hint: 'Upload', keys: ['image', 'picture', 'photo', 'img'], run: (_v, h) => h.pickImages() },
  { label: 'Take photo', hint: 'Camera', keys: ['camera', 'photo', 'snap'], run: (_v, h) => h.takePhoto() },
  { label: 'Drawing', hint: 'Sketch', keys: ['drawing', 'sketch', 'whiteboard', 'excalidraw', 'draw'], run: (_v, h) => h.openDrawing() },
  { label: 'Diagram', hint: 'Mermaid editor', keys: ['diagram', 'mermaid', 'chart'], run: (_v, h) => h.openMermaid() },
  { label: 'Flowchart', hint: 'Mermaid', keys: ['flowchart', 'flow', 'diagram'], run: (v) => mermaidBlock(v, 'flowchart') },
  { label: 'Sequence diagram', hint: 'Mermaid', keys: ['sequence', 'diagram'], run: (v) => mermaidBlock(v, 'sequence') },
  { label: 'Mind map', hint: 'Mermaid', keys: ['mindmap', 'mind', 'map'], run: (v) => mermaidBlock(v, 'mindmap') },
  { label: 'Gantt chart', hint: 'Mermaid', keys: ['gantt', 'timeline', 'schedule'], run: (v) => mermaidBlock(v, 'gantt') },
  { label: 'Table', hint: '3 × 2', keys: ['table', 'grid'], run: (v) => insertTable(v) },
  { label: 'Code block', hint: '```', keys: ['code', 'snippet', 'pre'], run: (v) => insertCodeBlock(v) },
  {
    label: 'Callout',
    hint: '> [!note]',
    keys: ['callout', 'note', 'info', 'admonition'],
    run: (v) => insertBlock(v, '> [!note] Note\n> ', [10, 14]),
  },
  {
    label: 'Tip callout',
    hint: '> [!tip]',
    keys: ['tip', 'callout', 'hint'],
    run: (v) => insertBlock(v, '> [!tip] Tip\n> ', [9, 12]),
  },
  {
    label: 'Warning callout',
    hint: '> [!warning]',
    keys: ['warning', 'callout', 'caution'],
    run: (v) => insertBlock(v, '> [!warning] Warning\n> ', [13, 20]),
  },
  { label: 'Quote', hint: '>', keys: ['quote', 'blockquote'], run: (v) => toggleLinePrefix(v, 'quote') },
  { label: 'Math block', hint: '$$', keys: ['math', 'latex', 'equation', 'formula', 'block'], run: (v) => insertBlock(v, '$$\n\n$$', [3, 3]) },
  { label: 'Inline math', hint: '$x$', keys: ['math', 'inline', 'latex', 'formula', 'equation'], run: (v) => toggleWrap(v, '$', '$', 'x') },
  {
    label: 'Toggle section',
    hint: 'Collapsible',
    keys: ['toggle', 'details', 'collapse', 'spoiler'],
    run: (v) => insertBlock(v, '<details>\n<summary>Summary</summary>\n\nHidden content\n\n</details>', [19, 26]),
  },
  { label: 'Divider', hint: '---', keys: ['divider', 'hr', 'rule', 'line'], run: (v) => insertBlock(v, '---') },
  { label: 'Link to note', hint: '[[', keys: ['link', 'note', 'wiki', 'ref'], run: (v) => { insertText(v, '[[]]', 2); startCompletion(v); } },
  { label: 'File attachment', hint: 'Upload', keys: ['file', 'attach', 'pdf', 'upload'], run: (_v, h) => h.pickFiles() },
  { label: 'Footnote', hint: '[^1]', keys: ['footnote', 'cite', 'reference'], run: (v) => insertFootnote(v) },
  { label: 'Today’s date', hint: today(), keys: ['date', 'today', 'now'], run: (v) => insertText(v, today()) },
  // A due date for the Tasks view, which reads YYYY-MM-DD; the date is selected so typing replaces it.
  {
    label: 'Due date',
    hint: '📅 YYYY-MM-DD',
    keys: ['due', 'deadline', 'date', 'by'],
    run: (v) => {
      const date = isoDate(new Date());
      const text = `📅 ${date}`;
      const from = v.state.selection.main.from;
      insertText(v, text);
      const start = from + text.length - date.length;
      v.dispatch({ selection: { anchor: start, head: start + date.length } });
    },
  },
];

function slashSource(host: HostRef) {
  return (ctx: CompletionContext): CompletionResult | null => {
    const line = ctx.state.doc.lineAt(ctx.pos);
    const before = line.text.slice(0, ctx.pos - line.from);
    const m = /(?:^|\s)\/([\w-]*)$/.exec(before);
    if (!m) return null;
    for (let node: ReturnType<ReturnType<typeof syntaxTree>['resolveInner']> | null = syntaxTree(ctx.state).resolveInner(ctx.pos, -1); node; node = node.parent) {
      if (/Code|URL|Link|HTML/.test(node.name)) return null;
    }
    const q = m[1].toLowerCase();
    const from = ctx.pos - m[1].length - 1;
    const options = SLASH_ITEMS.filter(
      (it) => !q || it.keys.some((k) => k.startsWith(q)) || it.label.toLowerCase().includes(q),
    ).map((it, i) => ({
      label: it.label,
      detail: it.hint,
      boost: -i,
      apply: (view: EditorView, _c: unknown, f: number, to: number) => {
        view.dispatch({ changes: { from: f, to, insert: '' }, selection: { anchor: f } });
        it.run(view, host.current);
      },
    }));
    // Templates: all of them for "/", "/t" … "/template", or by name ("/meeting", "/templatemeeting").
    const words = 'template'.startsWith(q) ? '' : q.startsWith('template') ? q.slice('template'.length).replace(/^-/, '') : q;
    const templates = host.current.templates().filter((t) => !words || t.title.toLowerCase().includes(words));
    for (const [i, t] of templates.slice(0, 12).entries()) {
      options.push({
        label: `Template: ${t.title || 'Untitled'}`,
        detail: 'Insert',
        boost: -100 - i,
        apply: (view: EditorView, _c: unknown, f: number, to: number) => {
          view.dispatch({ changes: { from: f, to, insert: '' }, selection: { anchor: f } });
          host.current.insertTemplate(t.id);
        },
      });
    }
    if (!options.length) return null;
    return { from, to: ctx.pos, options, filter: false };
  };
}

function wikilinkSource(host: HostRef) {
  return (ctx: CompletionContext): CompletionResult | null => {
    const before = ctx.state.sliceDoc(Math.max(0, ctx.pos - 200), ctx.pos);
    const m = /\[\[([^\][\n|#]*)$/.exec(before);
    if (!m) return null;
    const q = m[1].toLowerCase();
    const titles = host.current
      .noteTitles()
      .filter((t) => !q || t.toLowerCase().includes(q))
      .slice(0, 60);
    return {
      from: ctx.pos - m[1].length,
      options: titles.map((title) => ({
        label: title,
        apply: (view: EditorView, _c: unknown, from: number, to: number) => {
          const closed = view.state.sliceDoc(to, to + 2) === ']]';
          const insert = closed ? title : `${title}]]`;
          view.dispatch({ changes: { from, to, insert }, selection: { anchor: from + insert.length + (closed ? 2 : 0) } });
        },
      })),
      filter: false,
    };
  };
}

export function completionSources(host: HostRef) {
  return [slashSource(host), wikilinkSource(host)];
}

/* ----------------------------------------------------- paste & drop ----- */

/** Inside a code block, inline code or a formula: pasted text goes in as it is there. */
function inCodeOrMath(view: EditorView, pos: number): boolean {
  for (let node: SyntaxNode | null = syntaxTree(view.state).resolveInner(pos, -1); node; node = node.parent) {
    if (/^(FencedCode|CodeBlock|InlineCode|CodeText|HTMLBlock)$/.test(node.name)) return true;
  }
  const line = view.state.doc.lineAt(pos);
  const at = pos - line.from;
  if (scanInlineMath(line.text).some((m) => at > m.from && at < m.to)) return true;
  const doc = view.state.doc;
  return findMathBlocks((n) => doc.line(n).text, doc.lines).some((b) => line.number > b.start && line.number < b.end);
}

/** True if the selection is part of a link or image already (its label or its address). */
function inLinkSyntax(view: EditorView, from: number, to: number): boolean {
  const tree = syntaxTree(view.state);
  for (const [pos, side] of [[from, 1], [to, -1]] as const) {
    for (let node: SyntaxNode | null = tree.resolveInner(pos, side); node; node = node.parent) {
      if (/^(Link|Image|URL|Autolink)$/.test(node.name)) return true;
    }
  }
  return false;
}

/**
 * Pasted Markdown that starts or ends with a block (a list, a heading, a table) goes on lines of its
 * own: a list pasted into the middle of a sentence would otherwise run on from it.
 */
function insertPastedMarkdown(view: EditorView, md: string) {
  const changes = view.state.changeByRange((range) => {
    const line = view.state.doc.lineAt(range.from);
    const endLine = view.state.doc.lineAt(range.to);
    const before = line.text.slice(0, range.from - line.from);
    const after = endLine.text.slice(range.to - endLine.from);
    const lead = before.trim() && startsWithBlock(md) ? '\n\n' : '';
    const trail = after.trim() && endsWithBlock(md) ? '\n\n' : '';
    const insert = `${lead}${md}${trail}`;
    return { changes: { from: range.from, to: range.to, insert }, range: EditorSelection.cursor(range.from + lead.length + md.length) };
  });
  view.dispatch(view.state.update(changes, { userEvent: 'input.paste', scrollIntoView: true }));
}

export function pasteAndDrop(host: HostRef): Extension {
  return EditorView.domEventHandlers({
    paste(event, view) {
      const files = Array.from(event.clipboardData?.files ?? []);
      if (files.length) {
        event.preventDefault();
        host.current.uploadFiles(files);
        return true;
      }
      const text = event.clipboardData?.getData('text/plain')?.trim() ?? '';
      const sel = view.state.selection.main;
      // A web address pasted over selected words links them; pasted over an address (a link's own,
      // say), into code, or inside a link or image, it simply replaces the selection.
      const selected = sel.empty ? '' : view.state.sliceDoc(sel.from, sel.to);
      if (
        selected &&
        /^https?:\/\/\S+$/.test(text) &&
        !/^\s*<?(?:https?:\/\/|mailto:|www\.)/i.test(selected) &&
        !inCodeOrMath(view, sel.from) &&
        !inLinkSyntax(view, sel.from, sel.to)
      ) {
        event.preventDefault();
        const label = selected;
        view.dispatch({ changes: { from: sel.from, to: sel.to, insert: `[${label}](${text})` }, userEvent: 'input.paste' });
        return true;
      }
      // Formatted text (a web page, a document, an email) goes in as Markdown, except into code or a
      // formula, where only the text belongs.
      if (event.clipboardData && !inCodeOrMath(view, sel.from)) {
        const md = markdownForPaste(event.clipboardData);
        if (md) {
          event.preventDefault();
          insertPastedMarkdown(view, md);
          return true;
        }
      }
      return false;
    },
    drop(event, view) {
      const files = Array.from(event.dataTransfer?.files ?? []);
      if (!files.length) return false;
      event.preventDefault();
      const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
      if (pos !== null) view.dispatch({ selection: { anchor: pos } });
      host.current.uploadFiles(files);
      return true;
    },
  });
}

export const proseBrackets = EditorState.languageData.of(() => [{ closeBrackets: { brackets: ['(', '[', '{'] } }]);
