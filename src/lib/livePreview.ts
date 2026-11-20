/**
 * Live preview for the Markdown editor: the text stays plain Markdown, but
 * markup is tucked away on lines the cursor isn't on, and rich pieces
 * (checkboxes, images, drawings, Mermaid diagrams) render in place.
 */
import { EditorState, StateEffect, StateField, type Extension, type Range, type Transaction } from '@codemirror/state';
import {
  Decoration,
  EditorView,
  ViewPlugin,
  WidgetType,
  keymap,
  showTooltip,
  type DecorationSet,
  type Tooltip,
  type ViewUpdate,
} from '@codemirror/view';
import { syntaxTree } from '@codemirror/language';
import type { SyntaxNode, SyntaxNodeRef } from '@lezer/common';
import { setAssetSrc } from './assets';
import { insertLink, setHeading, toggleLinePrefix, toggleWrap } from './editorCommands';
import type { HostRef } from './editorExtensions';
import { allowRemote, codeToCopy, fenceCode, fillMath, isRemoteUrl, remoteAllowed } from './markdown';
import { useSettings } from './settings';
import { toast } from './store';
import { tickTaskLine } from './tasks';
import { formatJson, todayIso } from './utils';
import { findMathBlocks, scanInlineMath, type MathBlock } from './mathSyntax';
import { knownDiagramHeight, OFFLINE_DIAGRAM_MESSAGE, rememberDiagramHeight, renderMermaid } from './mermaid';
import { isChunkError } from './recovery';

/* ------------------------------------------------------------ helpers --- */

// Only reveal Markdown around the cursor while the editor actually has focus;
// an unfocused editor still has a selection (at the start), which shouldn't count.
const setFocus = StateEffect.define<boolean>();
const focusField = StateField.define<boolean>({
  create: () => false,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setFocus)) value = e.value;
    return value;
  },
});
const focusTracker = EditorView.focusChangeEffect.of((_state, focusing) => setFocus.of(focusing));
const focusChanged = (trs: readonly Transaction[]) => trs.some((t) => t.effects.some((e) => e.is(setFocus)));
const hasFocus = (state: EditorState) => state.field(focusField, false) ?? false;

/**
 * Whether the selection last moved by pointer (a click or tap). Rendered things open their source
 * when the cursor is moved onto them with the keyboard, but a click beside them only places the
 * cursor: clicking at the end of a line that ends in a formula shouldn't open the formula.
 */
const pointerSelect = StateField.define<boolean>({
  create: () => false,
  update: (value, tr) => (tr.selection ? tr.isUserEvent('select.pointer') : value),
});

/** Whether the selection reveals the source of [from, to]: touching it from the keyboard, inside it from a click. */
function reveals(state: EditorState, from: number, to: number) {
  if (!hasFocus(state)) return false;
  const pointer = state.field(pointerSelect, false) ?? false;
  return state.selection.ranges.some((r) => (pointer ? r.from < to && r.to > from : r.from <= to && r.to >= from));
}

/** A press on a scrollbar inside `root` (a wide formula's), which should scroll, not open anything. */
function onScrollbar(root: HTMLElement, e: MouseEvent) {
  for (let el = e.target as HTMLElement | null; el; el = el.parentElement) {
    if (el.scrollWidth > el.clientWidth || el.scrollHeight > el.clientHeight) {
      const r = el.getBoundingClientRect();
      if (e.clientY > r.top + el.clientTop + el.clientHeight || e.clientX > r.left + el.clientLeft + el.clientWidth) return true;
    }
    if (el === root) break;
  }
  return false;
}

/**
 * Click handling for rendered things (formulas, images, diagrams): one click or tap does `single`
 * (or nothing), two in quick succession do `double`, on any device. The editor's own handling is
 * off for these widgets (ignoreEvent), so neither moves the cursor unless asked to, and presses on
 * a scrollbar or one of the widget's own buttons are left alone.
 */
function onClicks(el: HTMLElement, double: (e: MouseEvent) => void, single?: (e: MouseEvent) => void) {
  let timer = 0;
  let last = 0;
  el.addEventListener('mousedown', (e) => {
    if (onScrollbar(el, e) || (e.target as Element).closest('button')) return;
    // No caret or text selection inside the rendering; the editor's selection stays put.
    e.preventDefault();
  });
  el.addEventListener('click', (e) => {
    if (onScrollbar(el, e) || (e.target as Element).closest('button')) return;
    e.preventDefault();
    const now = Date.now();
    if (now - last < 350) {
      last = 0;
      window.clearTimeout(timer);
      double(e);
      return;
    }
    last = now;
    // Wait to see whether a second click follows, so a double-click never also does the single action.
    if (single) timer = window.setTimeout(() => single(e), 300);
  });
}

/** Opens the source of a rendered thing: puts the cursor at `pos`, as if moved there with the keyboard. */
function openSource(view: EditorView, pos: number) {
  view.dispatch({ selection: { anchor: Math.min(view.state.doc.length, pos) }, scrollIntoView: true, userEvent: 'select' });
  view.focus();
}

function activeLines(state: EditorState): Set<number> {
  const set = new Set<number>();
  if (!hasFocus(state)) return set;
  for (const r of state.selection.ranges) {
    const a = state.doc.lineAt(r.from).number;
    const b = state.doc.lineAt(r.to).number;
    for (let n = a; n <= b && n - a < 5000; n++) set.add(n);
  }
  return set;
}

function touches(state: EditorState, from: number, to: number) {
  return hasFocus(state) && state.selection.ranges.some((r) => r.from <= to && r.to >= from);
}

const hide = Decoration.replace({});
const MEDIA_RE = /\.(mp4|webm|mov|m4v|ogv|mp3|m4a|wav|ogg|oga|flac|aac)(\?|#|$)/i;
const CALLOUT_KIND: Record<string, string> = {
  note: 'note', info: 'note', todo: 'note', abstract: 'abstract', summary: 'abstract', tldr: 'abstract',
  tip: 'tip', hint: 'tip', important: 'tip', success: 'tip', check: 'tip', done: 'tip',
  question: 'question', help: 'question', faq: 'question', example: 'question',
  warning: 'warning', caution: 'warning', attention: 'warning',
  danger: 'danger', error: 'danger', failure: 'danger', fail: 'danger', missing: 'danger', bug: 'danger',
  quote: 'quote', cite: 'quote',
};

/* ------------------------------------------------------------ widgets --- */

class CheckboxWidget extends WidgetType {
  constructor(
    readonly checked: boolean,
    readonly from: number,
  ) {
    super();
  }
  eq(o: CheckboxWidget) {
    return o.checked === this.checked && o.from === this.from;
  }
  toDOM(view: EditorView) {
    const box = document.createElement('span');
    box.className = `cm-lp-task${this.checked ? ' is-done' : ''}`;
    box.setAttribute('role', 'checkbox');
    box.setAttribute('aria-checked', String(this.checked));
    box.setAttribute('aria-label', this.checked ? 'Mark task not done' : 'Mark task done');
    box.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      // Dated, and a repeating task's next one added above it (see tickTaskLine).
      const line = view.state.doc.lineAt(this.from);
      const { line: text, next } = tickTaskLine(line.text, !this.checked, todayIso(), useSettings.getState().taskDoneDates);
      if (text === line.text && next === null) {
        view.dispatch({ changes: { from: this.from, to: this.from + 3, insert: this.checked ? '[ ]' : '[x]' } });
        return;
      }
      view.dispatch({ changes: { from: line.from, to: line.to, insert: next === null ? text : `${next}\n${text}` }, userEvent: 'input.toggle' });
    });
    return box;
  }
  ignoreEvent() {
    return true;
  }
}

class BulletWidget extends WidgetType {
  eq() {
    return true;
  }
  toDOM() {
    const s = document.createElement('span');
    s.className = 'cm-lp-bullet';
    s.setAttribute('aria-hidden', 'true');
    return s;
  }
}

class RuleWidget extends WidgetType {
  eq() {
    return true;
  }
  toDOM() {
    const s = document.createElement('span');
    s.className = 'cm-lp-hr';
    return s;
  }
}

/**
 * A code block's language and a Copy button (and, for JSON, Format), shown in place of its opening
 * fence, as reading view labels a block.
 */
class CodeLangWidget extends WidgetType {
  constructor(readonly lang: string) {
    super();
  }
  eq(o: CodeLangWidget) {
    return o.lang === this.lang;
  }
  toDOM(view: EditorView) {
    const wrap = document.createElement('span');
    const label = document.createElement('span');
    label.className = 'cm-lp-code-lang';
    label.textContent = this.lang;
    const tools = document.createElement('span');
    tools.className = 'cm-lp-code-tools';
    // Each acts when pressed, on the block as it is then; the buttons stay put while the code changes.
    const button = (text: string, cls: string, name: string, run: (at: number) => void) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = cls;
      b.textContent = text;
      b.setAttribute('aria-label', name);
      b.addEventListener('mousedown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        run(view.posAtDOM(wrap));
      });
      tools.appendChild(b);
    };
    if (this.lang === 'json') button('Format', 'cm-lp-code-format', 'Format JSON', (at) => formatJsonBlock(view, at));
    button('Copy', 'cm-lp-code-copy', 'Copy code', (at) => {
      const code = fenceCode(view.state.doc.toString(), view.state.doc.lineAt(at).number - 1);
      if (code === null) return;
      const copied = navigator.clipboard?.writeText(codeToCopy(code));
      if (!copied) return void toast('Couldn’t copy to the clipboard', { kind: 'error' });
      copied.then(
        () => toast('Code copied'),
        () => toast('Couldn’t copy to the clipboard', { kind: 'error' }),
      );
    });
    wrap.append(label, tools);
    return wrap;
  }
  // A click on the label places the cursor on its line, which brings the fence back; the buttons just act.
  ignoreEvent(e: Event) {
    return e.target instanceof Element && !!e.target.closest('button');
  }
}

/**
 * Lays out the code of the ```json block whose fence starts at `at` with two-space indents, as one
 * change (so one undo), keys and values exactly as written. JSON that doesn't parse is left alone.
 */
function formatJsonBlock(view: EditorView, at: number) {
  const { state } = view;
  if (state.readOnly) return;
  let block: SyntaxNode | null = syntaxTree(state).resolveInner(at, 1);
  while (block && block.name !== 'FencedCode') block = block.parent;
  if (!block) return;
  const doc = state.doc;
  const marks = block.getChildren('CodeMark');
  const first = doc.lineAt(block.from);
  const closing = marks.length > 1 ? marks[marks.length - 1] : null;
  const lastCode = closing ? doc.lineAt(closing.from).number - 1 : doc.lineAt(block.to).number;
  // The code as reading view reads it: without a list's indent or a quote's >.
  const code = lastCode > first.number ? fenceCode(doc.toString(), first.number - 1) : null;
  const json = code === null ? null : formatJson(code);
  if (code === null || json === null) {
    toast('This isn’t valid JSON, so it was left as it is.', { kind: 'error' });
    return;
  }
  // Only rewrite lines both parsers agree are this block's code.
  if (code.replace(/\n$/, '').split('\n').length !== lastCode - first.number) {
    toast('Couldn’t format this block.', { kind: 'error' });
    return;
  }
  // New lines keep the block's place in a list or quote: its > marks, and spaces for the rest.
  const lead = first.text.slice(0, block.from - first.from).replace(/[^\s>]/g, ' ');
  const from = doc.line(first.number + 1).from;
  const to = doc.line(lastCode).to;
  const insert = json
    .split('\n')
    .map((l) => lead + l)
    .join('\n');
  if (insert === doc.sliceString(from, to)) {
    toast('This JSON is already formatted.');
    return;
  }
  view.dispatch({ changes: { from, to, insert }, userEvent: 'input.format' });
}

class ImageWidget extends WidgetType {
  constructor(
    readonly src: string,
    readonly alt: string,
    readonly width: string | null,
    readonly host: HostRef,
  ) {
    super();
  }
  eq(o: ImageWidget) {
    return o.src === this.src && o.alt === this.alt && o.width === this.width;
  }
  toDOM(view: EditorView) {
    const wrap = document.createElement('span');
    wrap.className = 'cm-lp-image';
    // An image from another website, with Settings → Security set to ask first: a button that loads it.
    if (useSettings.getState().remoteImages === 'ask' && isRemoteUrl(this.src) && !remoteAllowed(this.src)) {
      const ask = document.createElement('button');
      ask.type = 'button';
      ask.className = 'cm-lp-remote';
      ask.textContent = `${this.alt ? `${this.alt}: image` : 'Image'} from ${new URL(this.src, location.href).host}. Click to load`;
      ask.addEventListener('mousedown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        allowRemote(this.src);
        ask.remove();
        this.fill(view, wrap);
        view.requestMeasure();
      });
      wrap.appendChild(ask);
      return wrap;
    }
    this.fill(view, wrap);
    return wrap;
  }

  private fill(view: EditorView, wrap: HTMLElement) {
    const img = document.createElement('img');
    img.alt = this.alt;
    img.loading = 'lazy';
    img.decoding = 'async';
    img.draggable = false;
    if (this.width) img.style.width = `${this.width}px`;
    img.onload = () => view.requestMeasure();
    const broken = (message: string) => {
      wrap.classList.add('is-broken');
      wrap.textContent = `${message}: ${this.alt || this.src}`;
      view.requestMeasure();
    };
    img.onerror = () => broken('Image not found');
    // Straight from its address, or (in an encrypted library) decrypted first.
    setAssetSrc(img, this.host.current.assetUrl(this.src), broken);
    wrap.appendChild(img);
    const drawing = /^\/api\/drawings\/([A-Za-z0-9_-]+)\.svg/.exec(this.src);
    if (drawing) {
      wrap.classList.add('is-drawing');
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'cm-lp-chip';
      btn.textContent = 'Edit drawing';
      btn.addEventListener('mousedown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.host.current.editDrawing(drawing[1]);
      });
      wrap.appendChild(btn);
    }
    // As in reading view: a click shows it full size; a double-click edits it (a drawing in the
    // drawing editor, any other image as its Markdown, for the caption or width).
    wrap.title = drawing ? 'Click to enlarge, double-click to edit' : 'Click to enlarge, double-click to edit its Markdown';
    onClicks(
      wrap,
      () => (drawing ? this.host.current.editDrawing(drawing[1]) : openSource(view, view.posAtDOM(wrap) + 2)),
      () => {
        if (!wrap.classList.contains('is-broken') && img.getAttribute('src')) this.host.current.viewImage(img.currentSrc || img.src, this.alt);
      },
    );
  }
  get estimatedHeight() {
    return 240;
  }
  ignoreEvent() {
    return true;
  }
}

class MermaidWidget extends WidgetType {
  constructor(
    readonly code: string,
    readonly fromLine: number,
    readonly toLine: number,
    readonly host: HostRef,
  ) {
    super();
  }
  eq(o: MermaidWidget) {
    return o.code === this.code && o.fromLine === this.fromLine && o.toLine === this.toLine;
  }
  get estimatedHeight() {
    return knownDiagramHeight(this.code, 'editor') ?? 280;
  }
  toDOM(view: EditorView) {
    const wrap = document.createElement('div');
    wrap.className = 'cm-lp-mermaid';
    const inner = document.createElement('div');
    inner.className = 'cm-lp-mermaid-body is-loading';
    inner.textContent = 'Drawing diagram…';
    // The height it drew at last time, kept while it draws, so the lines below don't jump.
    const known = knownDiagramHeight(this.code, 'editor');
    if (known) inner.style.minHeight = `${known}px`;
    wrap.appendChild(inner);
    const theme = document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
    renderMermaid(this.code, theme)
      .then((svg) => {
        inner.className = 'cm-lp-mermaid-body';
        inner.innerHTML = svg;
        inner.style.minHeight = '';
        if (inner.isConnected) rememberDiagramHeight(this.code, 'editor', inner.offsetHeight);
        view.requestMeasure();
      })
      .catch((err) => {
        inner.style.minHeight = '';
        inner.className = 'cm-lp-mermaid-body is-error';
        inner.textContent = isChunkError(err)
          ? OFFLINE_DIAGRAM_MESSAGE
          : this.code.trim()
            ? 'This diagram has a syntax error. Click to edit the code.'
            : 'Empty diagram. Click to write it, or use Edit diagram.';
        view.requestMeasure();
      });
    const edit = document.createElement('button');
    edit.type = 'button';
    edit.className = 'cm-lp-chip';
    edit.textContent = 'Edit diagram';
    edit.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.host.current.editMermaid(this.fromLine - 1, this.toLine, this.code);
    });
    wrap.appendChild(edit);
    // Onto the first line of code inside the fence.
    const openCode = () => openSource(view, view.state.doc.lineAt(view.posAtDOM(wrap)).to + 1);
    // As in reading view, a click enlarges the diagram; a double-click edits its code here. A diagram
    // that didn't draw has nothing to enlarge, so a click goes straight to its code.
    wrap.title = 'Click to enlarge, double-click to edit the code';
    onClicks(wrap, openCode, () => {
      const svg = inner.querySelector('svg');
      if (svg) this.host.current.viewDiagram(svg.outerHTML);
      else openCode();
    });
    return wrap;
  }
  ignoreEvent() {
    return true;
  }
}

/* --------------------------------------------------------------- math --- */

/** Display-math blocks ($$…$$ and ```math), kept up to date as the note changes. */
const mathBlocksField = StateField.define<MathBlock[]>({
  create: (state) => findMathBlocks((n) => state.doc.line(n).text, state.doc.lines),
  update: (blocks, tr) => (tr.docChanged ? findMathBlocks((n) => tr.state.doc.line(n).text, tr.state.doc.lines) : blocks),
});

function mathBlockAtLine(state: EditorState, line: number): MathBlock | undefined {
  return state.field(mathBlocksField, false)?.find((b) => line >= b.start && line <= b.end);
}

class InlineMathWidget extends WidgetType {
  constructor(
    readonly tex: string,
    readonly display: boolean,
  ) {
    super();
  }
  eq(o: InlineMathWidget) {
    return o.tex === this.tex && o.display === this.display;
  }
  toDOM(view: EditorView) {
    const span = document.createElement('span');
    span.className = `cm-lp-math${this.display ? ' is-display' : ''}`;
    fillMath(span, this.tex, this.display, () => view.requestMeasure());
    span.title = 'Double-click to edit';
    // Its TeX opens with the cursor just after the opening $ (or $$).
    onClicks(span, () => openSource(view, view.posAtDOM(span) + (this.display ? 2 : 1)));
    return span;
  }
  ignoreEvent() {
    return true;
  }
}

class MathBlockWidget extends WidgetType {
  constructor(
    readonly tex: string,
    readonly lines: number,
  ) {
    super();
  }
  eq(o: MathBlockWidget) {
    return o.tex === this.tex && o.lines === this.lines;
  }
  get estimatedHeight() {
    return 64;
  }
  toDOM(view: EditorView) {
    const wrap = document.createElement('div');
    wrap.className = 'cm-lp-math-block';
    const empty = !this.tex.trim();
    const body = document.createElement('div');
    body.className = 'cm-lp-math-body';
    if (empty) {
      wrap.classList.add('is-empty');
      body.textContent = 'Empty math block. Click to write it.';
    } else {
      fillMath(body, this.tex, true, () => view.requestMeasure());
    }
    wrap.appendChild(body);
    // Onto the end of the first line of TeX (or just past the $$ of a one-line block).
    const open = () => {
      const first = view.state.doc.lineAt(view.posAtDOM(wrap));
      openSource(view, this.lines > 1 && first.number < view.state.doc.lines ? view.state.doc.line(first.number + 1).to : first.from + 2);
    };
    if (!empty) {
      const edit = document.createElement('button');
      edit.type = 'button';
      edit.className = 'cm-lp-chip';
      edit.textContent = 'Edit';
      edit.setAttribute('aria-label', 'Edit this formula');
      edit.addEventListener('mousedown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        open();
      });
      wrap.appendChild(edit);
      wrap.title = 'Double-click to edit';
    }
    // Two clicks (or the Edit button) open the TeX; one click leaves the formula as it is, so reading
    // or scrolling past it never switches it into editing. An empty block has nothing to read.
    onClicks(wrap, open, empty ? open : undefined);
    return wrap;
  }
  ignoreEvent() {
    return true;
  }
}

/** Shown under a math block while its TeX is being edited, so the result updates as you type. */
class MathPreviewWidget extends WidgetType {
  constructor(readonly tex: string) {
    super();
  }
  eq(o: MathPreviewWidget) {
    return o.tex === this.tex;
  }
  toDOM(view: EditorView) {
    const wrap = document.createElement('div');
    wrap.className = 'cm-lp-math-preview';
    wrap.setAttribute('aria-hidden', 'true');
    if (this.tex.trim()) fillMath(wrap, this.tex, true, () => view.requestMeasure());
    else wrap.textContent = 'Type TeX above; the result shows here.';
    return wrap;
  }
  ignoreEvent() {
    return true;
  }
}

/** The inline formula the cursor is in, if any, with document positions. */
function inlineMathAtCursor(state: EditorState): { from: number; to: number; tex: string; display: boolean } | null {
  const r = state.selection.main;
  if (!r.empty || !hasFocus(state)) return null;
  const line = state.doc.lineAt(r.head);
  if (!line.text.includes('$') || mathBlockAtLine(state, line.number)) return null;
  for (const m of scanInlineMath(line.text)) {
    const from = line.from + m.from;
    const to = line.from + m.to;
    if (!reveals(state, from, to)) continue;
    if (inCodeAt(state, from)) return null;
    return { from, to, tex: m.tex, display: m.display };
  }
  return null;
}

function inCodeAt(state: EditorState, pos: number) {
  for (let n: ReturnType<ReturnType<typeof syntaxTree>['resolveInner']> | null = syntaxTree(state).resolveInner(pos, 1); n; n = n.parent) {
    if (/Code|HTML|Comment/.test(n.name)) return true;
  }
  return false;
}

/** While the cursor is in an inline formula (so its TeX shows), preview the result above the line. */
function mathTips(state: EditorState): readonly Tooltip[] {
  const m = inlineMathAtCursor(state);
  if (!m || !m.tex.trim()) return [];
  return [
    {
      pos: m.from,
      above: true,
      strictSide: false,
      arrow: false,
      create: (view) => {
        const dom = document.createElement('div');
        dom.className = 'cm-math-tip';
        dom.setAttribute('aria-hidden', 'true');
        fillMath(dom, m.tex, m.display, () => view.requestMeasure());
        return { dom, offset: { x: 0, y: 6 } };
      },
    },
  ];
}

/**
 * Escape while a formula's TeX is open: put the cursor just after it, so it's typeset again (for a
 * block, at the start of the next line, adding one at the end of the note if needed).
 */
function leaveMath(view: EditorView): boolean {
  const { state } = view;
  if (!state.selection.main.empty) return false;
  const line = state.doc.lineAt(state.selection.main.head);
  const block = mathBlockAtLine(state, line.number);
  if (block) {
    if (block.end < state.doc.lines) {
      view.dispatch({ selection: { anchor: state.doc.line(block.end + 1).from }, scrollIntoView: true, userEvent: 'select.pointer' });
    } else {
      view.dispatch({ changes: { from: state.doc.length, insert: '\n' }, selection: { anchor: state.doc.length + 1 }, scrollIntoView: true });
    }
    return true;
  }
  const inline = inlineMathAtCursor(state);
  if (!inline) return false;
  // Placed like a click, so being right beside the formula doesn't open it again.
  view.dispatch({ selection: { anchor: inline.to }, userEvent: 'select.pointer' });
  return true;
}

const mathTipField = StateField.define<readonly Tooltip[]>({
  create: mathTips,
  update: (tips, tr) => (tr.docChanged || tr.selection || focusChanged([tr]) ? mathTips(tr.state) : tips),
  provide: (f) => showTooltip.computeN([f], (s) => s.field(f)),
});

/* ------------------------------------------------- code block fences --- */

/**
 * A fenced code block's fences, tucked away while the cursor is outside the block: the opening one
 * shows just the language and its buttons, the closing one nothing. Both lines stay (as the block's top and bottom
 * edge), so the code doesn't move when the cursor goes in and the fences come back. Diagrams and
 * display math are drawn whole instead (buildBlocks), so they're left to that.
 */
function tuckFences(state: EditorState, block: SyntaxNode, decos: Range<Decoration>[]) {
  const doc = state.doc;
  const marks = block.getChildren('CodeMark');
  if (!marks.length) return;
  const first = doc.lineAt(marks[0].from);
  const closing = marks.length > 1 ? marks[marks.length - 1] : null;
  const last = doc.lineAt(closing ? closing.from : block.to);
  if (touches(state, first.from, last.to)) return;
  const infoNode = block.getChild('CodeInfo');
  const info = infoNode ? doc.sliceString(infoNode.from, infoNode.to).trim() : '';
  if ((closing && /^mermaid$/i.test(info) && /^\s*[`~]/.test(first.text)) || mathBlockAtLine(state, first.number)) return;
  decos.push(Decoration.line({ class: 'cm-lp-code-bar' }).range(first.from));
  decos.push(Decoration.replace({ widget: new CodeLangWidget(info.split(/\s+/)[0].toLowerCase() || 'text') }).range(marks[0].from, first.to));
  if (closing && last.number > first.number) decos.push(hide.range(closing.from, last.to));
}

/* ------------------------------------------------- inline decorations --- */

/** Markdown constructs whose live-preview styling would mangle TeX if applied inside a formula. */
const MATH_SENSITIVE = new Set([
  'HeaderMark',
  'ATXHeading1',
  'ATXHeading2',
  'ATXHeading3',
  'ATXHeading4',
  'ATXHeading5',
  'ATXHeading6',
  'EmphasisMark',
  'StrikethroughMark',
  'InlineCode',
  'Link',
  'Image',
  'Blockquote',
  'QuoteMark',
  'ListMark',
  'TaskMarker',
  'HorizontalRule',
  'Table',
]);

function buildInline(view: EditorView, host: HostRef): DecorationSet {
  const { state } = view;
  const doc = state.doc;
  const active = activeLines(state);
  const decos: Range<Decoration>[] = [];
  const tree = syntaxTree(state);
  const lineOf = (pos: number) => doc.lineAt(pos).number;

  // Formulas first: typeset where the cursor isn't, TeX source where it is. Markdown's own syntax
  // inside them (underscores, asterisks, brackets) is TeX, not emphasis or links, so the passes
  // below leave anything within a formula alone.
  const mathRanges: Array<{ from: number; to: number }> = [];
  for (const { from, to } of view.visibleRanges) {
    for (let pos = from; pos <= to; ) {
      const line = doc.lineAt(pos);
      pos = line.to + 1;
      if (!line.text.includes('$') || mathBlockAtLine(state, line.number)) continue;
      for (const m of scanInlineMath(line.text)) {
        const a = line.from + m.from;
        const b = line.from + m.to;
        if (inCodeAt(state, a)) continue;
        mathRanges.push({ from: a, to: b });
        if (reveals(state, a, b)) decos.push(Decoration.mark({ class: 'cm-lp-math-src' }).range(a, b));
        else decos.push(Decoration.replace({ widget: new InlineMathWidget(m.tex, m.display) }).range(a, b));
      }
    }
  }
  const inMath = (pos: number) =>
    mathRanges.some((r) => pos >= r.from && pos < r.to) || !!mathBlockAtLine(state, lineOf(pos));
  // A code block spanning two visible ranges is met twice; its fences are tucked once.
  const fenced = new Set<number>();

  for (const { from, to } of view.visibleRanges) {
    tree.iterate({
      from,
      to,
      enter: (node: SyntaxNodeRef) => {
        const name = node.name;
        if (MATH_SENSITIVE.has(name) && inMath(node.from)) return false;
        switch (name) {
          case 'FencedCode':
            // The code itself is left exactly as written.
            if (!fenced.has(node.from)) {
              fenced.add(node.from);
              tuckFences(state, node.node, decos);
            }
            return false;
          case 'CodeBlock':
          case 'HTMLBlock':
          case 'CommentBlock':
            return false;
          case 'Table': {
            // Tables stay as text, set in monospace so the columns line up.
            const first = doc.lineAt(node.from).number;
            const last = doc.lineAt(node.to).number;
            for (let n = first; n <= last; n++) {
              decos.push(Decoration.line({ class: 'cm-lp-table' }).range(doc.line(n).from));
            }
            return false;
          }
          case 'HeaderMark': {
            const parent = node.node.parent;
            if (!parent || !parent.name.startsWith('ATXHeading')) return;
            if (active.has(lineOf(node.from))) return;
            if (node.from === parent.from) {
              let end = node.to;
              while (doc.sliceString(end, end + 1) === ' ') end++;
              decos.push(hide.range(node.from, end));
            } else {
              decos.push(hide.range(node.from, node.to)); // closing #'s
            }
            return;
          }
          case 'ATXHeading1':
          case 'ATXHeading2':
          case 'ATXHeading3':
          case 'ATXHeading4':
          case 'ATXHeading5':
          case 'ATXHeading6': {
            const line = doc.lineAt(node.from);
            decos.push(Decoration.line({ class: `cm-lp-h cm-lp-h${name.slice(-1)}` }).range(line.from));
            return;
          }
          case 'EmphasisMark':
          case 'StrikethroughMark': {
            const parent = node.node.parent;
            if (parent && !touches(state, parent.from, parent.to) && !active.has(lineOf(node.from))) {
              decos.push(hide.range(node.from, node.to));
            }
            return;
          }
          case 'InlineCode': {
            decos.push(Decoration.mark({ class: 'cm-lp-code' }).range(node.from, node.to));
            if (!touches(state, node.from, node.to) && !active.has(lineOf(node.from))) {
              const marks = node.node.getChildren('CodeMark');
              for (const m of marks) decos.push(hide.range(m.from, m.to));
            }
            return false;
          }
          case 'Link': {
            // Skip the inner [Title] of a [[wikilink]]; handled by the regex pass below.
            if (doc.sliceString(node.from - 1, node.from) === '[' || doc.sliceString(node.to, node.to + 1) === ']') return false;
            const marks = node.node.getChildren('LinkMark');
            const url = node.node.getChild('URL');
            if (!url || marks.length < 2) return false;
            const textFrom = marks[0].to;
            const textTo = marks[1].from;
            if (textTo <= textFrom) return false;
            decos.push(
              Decoration.mark({
                class: 'cm-lp-link',
                attributes: { title: `${doc.sliceString(url.from, url.to)}  (Ctrl/⌘-click to open)` },
              }).range(textFrom, textTo),
            );
            if (!touches(state, node.from, node.to) && !active.has(lineOf(node.from))) {
              decos.push(hide.range(node.from, textFrom));
              decos.push(hide.range(textTo, node.to));
            }
            return false;
          }
          case 'Image': {
            const line = doc.lineAt(node.from);
            // Its Markdown shows when the cursor is moved onto its line, or clicked inside the Markdown itself.
            if (state.field(pointerSelect, false) ? reveals(state, node.from, node.to) : active.has(line.number)) return false;
            const url = node.node.getChild('URL');
            const marks = node.node.getChildren('LinkMark');
            if (!url || marks.length < 2) return false;
            const src = doc.sliceString(url.from, url.to);
            if (!/^(\/api\/|https?:\/\/|data:image\/)/.test(src) || MEDIA_RE.test(src)) return false;
            let alt = doc.sliceString(marks[0].to, marks[1].from);
            let width: string | null = null;
            // Unambiguous (spaces before the bar trimmed after), so a long run of spaces can't make it slow.
            const size = /^(.*?)\|\s*(\d{1,4})(?:x\d{1,4})?$/.exec(alt);
            if (size) {
              alt = size[1].trimEnd();
              width = size[2];
            }
            decos.push(Decoration.replace({ widget: new ImageWidget(src, alt, width, host) }).range(node.from, node.to));
            return false;
          }
          case 'Blockquote': {
            const first = doc.lineAt(node.from);
            const last = doc.lineAt(node.to);
            const callout = /^\s*>\s*\[!([A-Za-z-]+)\]/.exec(first.text);
            const kind = callout ? CALLOUT_KIND[callout[1].toLowerCase()] ?? 'note' : null;
            for (let n = first.number; n <= last.number; n++) {
              const l = doc.line(n);
              const cls = kind
                ? `cm-lp-quote cm-lp-callout cm-lp-callout-${kind}${n === first.number ? ' is-first' : ''}${n === last.number ? ' is-last' : ''}`
                : 'cm-lp-quote';
              decos.push(Decoration.line({ class: cls }).range(l.from));
            }
            if (callout) {
              const start = first.from + first.text.indexOf('[!');
              const end = first.from + first.text.indexOf(']', start - first.from) + 1;
              if (end > start) decos.push(Decoration.mark({ class: 'cm-lp-callout-tag' }).range(start, end));
            }
            return;
          }
          case 'QuoteMark': {
            if (active.has(lineOf(node.from))) return;
            let end = node.to;
            if (doc.sliceString(end, end + 1) === ' ') end++;
            decos.push(hide.range(node.from, end));
            return;
          }
          case 'ListMark': {
            const item = node.node.parent;
            const list = item?.parent;
            const task = item?.getChild('Task');
            const line = doc.lineAt(node.from);
            const isActiveLine = active.has(line.number);
            // Hanging indent so wrapped lines line up with the text, not the bullet.
            if (node.from === item?.from || doc.lineAt(item?.from ?? node.from).number === line.number) {
              const lead = node.from - line.from;
              const markerEm = isActiveLine
                ? (node.to - node.from + (task ? 4 : 1)) * 0.55
                : task
                  ? 1.6
                  : list?.name === 'BulletList'
                    ? 1.2
                    : (node.to - node.from) * 0.58 + 0.35;
              const em = (lead * 0.28 + markerEm).toFixed(2);
              decos.push(Decoration.line({ attributes: { style: `padding-left:${em}em;text-indent:-${em}em` } }).range(line.from));
            }
            if (isActiveLine) return;
            if (task) {
              const marker = task.getChild('TaskMarker');
              if (!marker) return;
              let end = node.to;
              while (end < marker.from && doc.sliceString(end, end + 1) === ' ') end++;
              decos.push(hide.range(node.from, end));
              return;
            }
            if (list?.name === 'BulletList') {
              decos.push(Decoration.replace({ widget: new BulletWidget() }).range(node.from, node.to));
            }
            return;
          }
          case 'TaskMarker': {
            const text = doc.sliceString(node.from, node.to);
            const checked = /x/i.test(text);
            const line = doc.lineAt(node.from);
            if (checked && line.to > node.to + 1) {
              decos.push(Decoration.mark({ class: 'cm-lp-done' }).range(node.to + 1, line.to));
            }
            if (active.has(line.number)) return;
            let end = node.to;
            if (doc.sliceString(end, end + 1) === ' ') end++;
            decos.push(Decoration.replace({ widget: new CheckboxWidget(checked, node.from) }).range(node.from, end));
            return;
          }
          case 'HorizontalRule': {
            if (active.has(lineOf(node.from))) return;
            decos.push(Decoration.replace({ widget: new RuleWidget() }).range(node.from, node.to));
            return;
          }
          default:
            return;
        }
      },
    });

    // Patterns the Markdown grammar doesn't know: ==highlight== and [[wikilinks]].
    for (let pos = from; pos <= to; ) {
      const line = doc.lineAt(pos);
      pos = line.to + 1;
      if (!line.text.includes('==') && !line.text.includes('[[')) continue;
      const inCode = (at: number) => {
        for (let n: ReturnType<typeof tree.resolveInner> | null = tree.resolveInner(at, 1); n; n = n.parent) {
          if (/Code|HTML|Comment/.test(n.name)) return true;
        }
        return false;
      };
      const isActive = active.has(line.number);
      // "==" markers outside code, math and escapes, paired as reading view pairs them (markdown.ts):
      // one opens before a non-space and closes after one, so "==" inside `a == b` is never hidden.
      const text = line.text;
      let open = -1;
      for (let i = text.indexOf('=='); i >= 0; i = text.indexOf('==', i + 2)) {
        const at = line.from + i;
        if (text[i - 1] === '\\' || inCode(at) || inMath(at)) continue;
        const closes = open >= 0 && i > open + 2 && !/\s/.test(text[i - 1]);
        if (closes) {
          const a = line.from + open;
          const b = at + 2;
          decos.push(Decoration.mark({ class: 'cm-lp-highlight' }).range(a + 2, b - 2));
          if (!isActive) {
            decos.push(hide.range(a, a + 2));
            decos.push(hide.range(b - 2, b));
          }
          open = -1;
        } else if (i + 2 < text.length && !/\s/.test(text[i + 2])) {
          open = i;
        }
      }
      let m: RegExpExecArray | null;
      const wl = /\[\[([^\][\n]+)\]\]/g;
      while ((m = wl.exec(line.text))) {
        const a = line.from + m.index;
        const b = a + m[0].length;
        if (inCode(a) || inMath(a)) continue;
        const inner = m[1];
        const pipe = inner.indexOf('|');
        if (!isActive) {
          decos.push(hide.range(a, a + 2 + (pipe >= 0 ? pipe + 1 : 0)));
          decos.push(hide.range(b - 2, b));
        }
        const labelFrom = isActive || pipe < 0 ? a + 2 : a + 3 + pipe;
        const title = (pipe >= 0 ? inner.slice(0, pipe) : inner).split('#')[0].trim();
        decos.push(
          Decoration.mark({
            class: host.current.noteExists(title) ? 'cm-lp-wikilink' : 'cm-lp-wikilink is-missing',
            attributes: { title: 'Ctrl/⌘-click to open' },
          }).range(labelFrom, b - 2),
        );
      }
    }
  }
  return Decoration.set(decos, true);
}

function inlinePlugin(host: HostRef) {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = buildInline(view, host);
      }
      update(u: ViewUpdate) {
        if (
          u.docChanged ||
          u.selectionSet ||
          u.viewportChanged ||
          focusChanged(u.transactions) ||
          syntaxTree(u.startState) !== syntaxTree(u.state)
        ) {
          this.decorations = buildInline(u.view, host);
        }
      }
    },
    { decorations: (v) => v.decorations },
  );
}

/* ---------------------------------------------------- block diagrams ---- */

function buildBlocks(state: EditorState, host: HostRef): DecorationSet {
  const doc = state.doc;
  const active = activeLines(state);
  const decos: Range<Decoration>[] = [];
  for (let n = 1; n <= doc.lines; n++) {
    const open = /^\s*(`{3,}|~{3,})(.*)$/.exec(doc.line(n).text);
    if (!open) continue;
    const fence = open[1];
    const close = new RegExp(`^\\s*${fence[0] === '`' ? '`' : '~'}{${fence.length},}\\s*$`);
    let end = n + 1;
    while (end <= doc.lines && !close.test(doc.line(end).text)) end++;
    // Any other code block is stepped over whole: a ```mermaid example inside a ````md block is code,
    // as reading view shows it.
    if (!/^mermaid$/i.test(open[2].trim())) {
      n = end;
      continue;
    }
    if (end > doc.lines) break;
    let isActive = false;
    for (let i = n; i <= end && !isActive; i++) isActive = active.has(i);
    if (!isActive) {
      const code = end > n + 1 ? doc.sliceString(doc.line(n + 1).from, doc.line(end - 1).to) : '';
      decos.push(
        Decoration.replace({ widget: new MermaidWidget(code, n, end, host), block: true }).range(
          doc.line(n).from,
          doc.line(end).to,
        ),
      );
    }
    n = end;
  }

  // Display math: typeset in place, or (while the cursor is in it) its TeX with a preview below.
  for (const block of state.field(mathBlocksField, false) ?? []) {
    let isActive = false;
    for (let i = block.start; i <= block.end && !isActive; i++) isActive = active.has(i);
    const first = doc.line(block.start);
    const last = doc.line(block.end);
    if (!isActive) {
      decos.push(
        Decoration.replace({ widget: new MathBlockWidget(block.tex, block.end - block.start + 1), block: true }).range(first.from, last.to),
      );
      continue;
    }
    for (let i = block.start; i <= block.end; i++) decos.push(Decoration.line({ class: 'cm-lp-math-line' }).range(doc.line(i).from));
    decos.push(Decoration.widget({ widget: new MathPreviewWidget(block.tex), block: true, side: 1 }).range(last.to));
  }
  return Decoration.set(decos, true);
}

function blockField(host: HostRef) {
  return StateField.define<DecorationSet>({
    create: (state) => buildBlocks(state, host),
    update: (deco, tr) => (tr.docChanged || tr.selection || focusChanged([tr]) ? buildBlocks(tr.state, host) : deco),
    provide: (f) => EditorView.decorations.from(f),
  });
}

/* ----------------------------------------------------- selection menu --- */

type BubbleAction = { label: string; text: string; run: (v: EditorView) => void; cls?: string };

const BUBBLE: BubbleAction[] = [
  { label: 'Bold', text: 'B', cls: 'is-bold', run: (v) => toggleWrap(v, '**') },
  { label: 'Italic', text: 'I', cls: 'is-italic', run: (v) => toggleWrap(v, '*') },
  { label: 'Strikethrough', text: 'S', cls: 'is-strike', run: (v) => toggleWrap(v, '~~') },
  { label: 'Highlight', text: 'H', cls: 'is-mark', run: (v) => toggleWrap(v, '==') },
  { label: 'Code', text: '</>', cls: 'is-code', run: (v) => toggleWrap(v, '`', '`', 'code') },
  { label: 'Link', text: 'Link', run: (v) => insertLink(v) },
  { label: 'Heading 1', text: 'H1', run: (v) => setHeading(v, 1) },
  { label: 'Heading 2', text: 'H2', run: (v) => setHeading(v, 2) },
  { label: 'Quote', text: '“ ”', run: (v) => toggleLinePrefix(v, 'quote') },
];

function bubbleTooltips(state: EditorState): readonly Tooltip[] {
  const r = state.selection.main;
  if (r.empty || state.selection.ranges.length > 1) return [];
  if (typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches) return [];
  return [
    {
      pos: r.from,
      end: r.to,
      above: true,
      strictSide: false,
      arrow: false,
      create: (view) => {
        const dom = document.createElement('div');
        dom.className = 'cm-bubble';
        dom.setAttribute('role', 'toolbar');
        dom.setAttribute('aria-label', 'Format selection');
        BUBBLE.forEach((a, i) => {
          if (i === 5 || i === 6) {
            const sep = document.createElement('span');
            sep.className = 'cm-bubble-sep';
            dom.appendChild(sep);
          }
          const b = document.createElement('button');
          b.type = 'button';
          b.textContent = a.text;
          b.className = a.cls ?? '';
          b.setAttribute('aria-label', a.label);
          b.dataset.tip = a.label;
          b.addEventListener('mousedown', (e) => {
            e.preventDefault();
            a.run(view);
          });
          dom.appendChild(b);
        });
        return { dom, offset: { x: 0, y: 6 } };
      },
    },
  ];
}

const bubbleField = StateField.define<readonly Tooltip[]>({
  create: bubbleTooltips,
  update: (tips, tr) => (tr.docChanged || tr.selection ? bubbleTooltips(tr.state) : tips),
  provide: (f) => showTooltip.computeN([f], (s) => s.field(f)),
});

/* ----------------------------------------------------- link opening ----- */

function linkClicks(host: HostRef): Extension {
  return EditorView.domEventHandlers({
    mousedown(e, view) {
      if (!(e.metaKey || e.ctrlKey) || e.button !== 0) return false;
      const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
      if (pos === null) return false;
      const line = view.state.doc.lineAt(pos);
      const wl = /\[\[([^\][\n]+)\]\]/g;
      let m: RegExpExecArray | null;
      while ((m = wl.exec(line.text))) {
        const a = line.from + m.index;
        if (pos >= a && pos <= a + m[0].length) {
          e.preventDefault();
          host.current.openWikilink(m[1].split('|')[0].trim());
          return true;
        }
      }
      for (let n: ReturnType<ReturnType<typeof syntaxTree>['resolveInner']> | null = syntaxTree(view.state).resolveInner(pos, 1); n; n = n.parent) {
        if (n.name === 'Link' || n.name === 'Autolink') {
          const url = n.getChild('URL');
          if (url) {
            e.preventDefault();
            host.current.openLink(view.state.sliceDoc(url.from, url.to));
            return true;
          }
        }
      }
      return false;
    },
  });
}

export function livePreview(host: HostRef): Extension {
  // mathBlocksField and pointerSelect come before the fields that read them.
  return [
    focusField,
    focusTracker,
    pointerSelect,
    mathBlocksField,
    inlinePlugin(host),
    blockField(host),
    bubbleField,
    mathTipField,
    linkClicks(host),
    keymap.of([{ key: 'Escape', run: leaveMath }]),
  ];
}
