// @vitest-environment jsdom
/**
 * The editor's live preview (src/lib/livePreview.ts): Markdown symbols tuck away on lines you aren't
 * editing, and checkboxes, images, formulas and diagrams render in place, without ever changing the
 * text by themselves. Runs a real CodeMirror view in jsdom; what jsdom can't do (layout, so clicks
 * placed by coordinates and tooltip positions) is left out. "What you see" is worked out from the
 * decorations: hidden ranges dropped, widgets shown as tokens like ☐ or [math x^2].
 */
import { EditorSelection, EditorState } from '@codemirror/state';
import { EditorView, type WidgetType } from '@codemirror/view';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { ensureSyntaxTree } from '@codemirror/language';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

// Mermaid needs a real layout engine; the widget only needs some SVG back.
vi.mock('mermaid', () => ({
  default: { initialize: () => {}, render: async (id: string) => ({ svg: `<svg id="${id}" xmlns="http://www.w3.org/2000/svg"><g/></svg>` }) },
}));

import { setCodec, type Codec } from '../../src/lib/api';
import { imagePeeks, type EditorHost, type HostRef } from '../../src/lib/editorExtensions';
import { livePreview } from '../../src/lib/livePreview';
import { renderMarkdown } from '../../src/lib/markdown';
import { loadExtras } from '../../src/lib/renderExtras';
import { useSettings } from '../../src/lib/settings';
import { useApp } from '../../src/lib/store';
import { expectQuick } from './timing';

beforeAll(async () => {
  // The selection bubble asks whether the pointer is coarse.
  window.matchMedia ??= ((query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {} })) as never;
  // KaTeX loads on demand (src/lib/renderExtras.ts); the formula tests need it in.
  await loadExtras();
});

const views: EditorView[] = [];
afterEach(() => {
  for (const v of views.splice(0)) v.destroy();
  useSettings.setState({ remoteImages: 'load' });
  setCodec(null);
  vi.unstubAllGlobals();
});

function makeHost(titles: string[] = ['Note']) {
  const calls: unknown[][] = [];
  const record =
    (name: string) =>
    (...args: unknown[]) =>
      void calls.push([name, ...args]);
  const host: EditorHost = {
    openMermaid: record('openMermaid'),
    openDrawing: record('openDrawing'),
    pickImages: record('pickImages'),
    pickFiles: record('pickFiles'),
    takePhoto: record('takePhoto'),
    uploadFiles: record('uploadFiles'),
    noteTitles: () => titles,
    templates: () => [],
    insertTemplate: record('insertTemplate'),
    editDrawing: record('editDrawing'),
    editMermaid: record('editMermaid'),
    openLink: record('openLink'),
    openWikilink: record('openWikilink'),
    noteExists: (t) => (calls.push(['noteExists', t]), titles.includes(t)),
    assetUrl: (src) => src,
    viewImage: record('viewImage'),
    viewDiagram: record('viewDiagram'),
  };
  return { ref: { current: host } as HostRef, calls };
}

async function editor(doc: string, opts: { focus?: boolean; cursor?: number; host?: HostRef; extensions?: 'live' | 'peeks' } = {}) {
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  const host = opts.host ?? makeHost().ref;
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc,
      extensions: [markdown({ base: markdownLanguage }), opts.extensions === 'peeks' ? imagePeeks : livePreview(host)],
    }),
  });
  views.push(view);
  ensureSyntaxTree(view.state, view.state.doc.length, 5000);
  view.dispatch({});
  if (opts.focus) {
    view.focus();
    // CodeMirror tells extensions about focus a moment later.
    await new Promise((r) => setTimeout(r, 25));
  }
  if (opts.cursor !== undefined) view.dispatch({ selection: EditorSelection.cursor(opts.cursor) });
  return view;
}

function token(w: WidgetType): string {
  const x = w as unknown as Record<string, unknown>;
  switch (w.constructor.name) {
    case 'CheckboxWidget':
      return x.checked ? '☑' : '☐';
    case 'BulletWidget':
      return '•';
    case 'RuleWidget':
      return '―';
    case 'ImageWidget':
      return `[image ${x.src}]`;
    case 'InlineMathWidget':
      return `[math ${x.tex}]`;
    case 'MathBlockWidget':
      return `[math block ${x.tex}]`;
    case 'MermaidWidget':
      return '[diagram]';
    case 'MathPreviewWidget':
      return `[preview ${x.tex}]`;
    case 'CodeLangWidget':
      return `[code ${x.lang}]`;
    default:
      return `[${w.constructor.name}]`;
  }
}

/** The text as shown between `from` and `to`: hidden ranges left out, widgets as tokens. */
function shown(view: EditorView, from = 0, to = view.state.doc.length): string {
  const doc = view.state.doc.toString();
  const points: Array<{ from: number; to: number; token: string }> = [];
  for (const source of view.state.facet(EditorView.decorations)) {
    const set = typeof source === 'function' ? source(view) : source;
    set.between(from, to, (a, b, deco) => {
      const widget = (deco.spec as { widget?: WidgetType }).widget;
      const replace = (deco as unknown as { isReplace?: boolean }).isReplace;
      if (!replace && !widget) return;
      if (b < from || a > to || (a === b && (a < from || a > to))) return;
      const label = widget && a >= from ? token(widget) : '';
      points.push({ from: Math.max(a, from), to: replace ? Math.min(b, to) : Math.max(a, from), token: label });
    });
  }
  points.sort((x, y) => x.from - y.from || y.to - x.to);
  let out = '';
  let at = from;
  for (const p of points) {
    if (p.from < at) {
      at = Math.max(at, p.to);
      continue;
    }
    out += doc.slice(at, p.from) + p.token;
    at = Math.max(at, p.to);
  }
  return out + doc.slice(at, to);
}

/** Presses the Copy button on the (first) code block's label. */
function pressCopy(view: EditorView) {
  const button = view.dom.querySelector('.cm-lp-code-copy')!;
  button.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
}

const shownLine = (view: EditorView, n: number) => {
  const line = view.state.doc.line(n);
  return shown(view, line.from, line.to);
};

const RICH = [
  '# Heading',
  'Some **bold**, *italic*, ~~gone~~ and `code`.',
  'A [link](https://example.com) and [[Note|alias]], [[Note#Part]] and ==marked==.',
  '> Quoted',
  '- bullet',
  '- [ ] open task',
  '- [x] done task',
  '1. numbered',
  '',
  '***',
  '',
];

describe('live preview', () => {
  it('tucks the symbols away on lines you aren’t editing', async () => {
    const doc = [...RICH, ''].join('\n');
    const view = await editor(doc, { focus: true, cursor: doc.length });
    expect(shown(view)).toBe(
      [
        'Heading',
        'Some bold, italic, gone and code.',
        'A link and alias, Note#Part and marked.',
        'Quoted',
        '• bullet',
        '☐open task',
        '☑done task',
        '1. numbered',
        '',
        '―',
        '',
        '',
      ].join('\n'),
    );
    expect(view.state.doc.toString()).toBe(doc);
  });

  it('shows exactly what’s written on the line being edited, whichever line that is', async () => {
    const lines = [
      ...RICH,
      '> [!tip] Title',
      '> - [ ] in a callout',
      '  - [X] nested',
      '![pic|200](/api/files/abcdef12/p.png)',
      '',
      '```mermaid',
      'graph TD',
      '```',
      '',
      '```math',
      'a^2',
      '```',
      '``` js',
      'let a = 1;',
      '```',
      '| a | **b** |',
      '|---|---|',
      '<b>**html**</b>',
    ];
    const view = await editor(lines.join('\n'), { focus: true });
    for (let n = 1; n <= lines.length; n++) {
      view.dispatch({ selection: EditorSelection.cursor(view.state.doc.line(n).from) });
      // A formula being edited also previews its result under its last line.
      expect(shownLine(view, n).replace(/\[preview [^\]]*\]$/, ''), `line ${n}`).toBe(lines[n - 1]);
    }
    expect(view.state.doc.toString()).toBe(lines.join('\n'));
  });

  it('shows every line finished while the editor isn’t focused, the cursor’s too', async () => {
    const view = await editor('## Plans\n**bold**', { cursor: 3 });
    expect(shown(view)).toBe('Plans\nbold');
  });

  it('finishes the line again once the editor loses focus', async () => {
    const view = await editor('## Plans\n**bold**', { focus: true, cursor: 3 });
    expect(shown(view)).toBe('## Plans\nbold');
    view.contentDOM.blur();
    await new Promise((r) => setTimeout(r, 25));
    expect(shown(view)).toBe('Plans\nbold');
  });

  it('keeps an image or formula rendered when a click lands beside it, and opens it from the keyboard', async () => {
    const doc = 'See ![pic](/api/files/abcdef12/p.png)\nArea $x^2$\nend';
    const view = await editor(doc, { focus: true, cursor: doc.length });
    const lineEnd = (n: number) => view.state.doc.line(n).to;
    view.dispatch({ selection: EditorSelection.cursor(lineEnd(1)), userEvent: 'select.pointer' });
    expect(shownLine(view, 1)).toBe('See [image /api/files/abcdef12/p.png]');
    view.dispatch({ selection: EditorSelection.cursor(lineEnd(2)), userEvent: 'select.pointer' });
    expect(shownLine(view, 2)).toBe('Area [math x^2]');
    view.dispatch({ selection: EditorSelection.cursor(lineEnd(1)) });
    expect(shownLine(view, 1)).toBe('See ![pic](/api/files/abcdef12/p.png)');
    view.dispatch({ selection: EditorSelection.cursor(lineEnd(2)) });
    expect(shownLine(view, 2)).toBe('Area $x^2$');
  });

  it('reveals every line a selection covers, and only those', async () => {
    const view = await editor('# One\n**two**\n*three*\n~~four~~', { focus: true });
    const doc = view.state.doc;
    view.dispatch({ selection: EditorSelection.range(doc.line(2).from + 1, doc.line(3).from + 2) });
    expect(shown(view)).toBe('One\n**two**\n*three*\nfour');
  });

  it('leaves code blocks, HTML and tables as written', async () => {
    const doc = '```js\nconst a = **b**; // [x](y)\n```\n\n<div>**html** [[Note]]</div>\n\n| a | **b** |\n|---|---|\n| [x](y) | c |\n\nend';
    const view = await editor(doc);
    const shownText = shown(view);
    expect(shownText).toContain('const a = **b**; // [x](y)');
    expect(shownText).toContain('<div>**html** [[Note]]</div>');
    expect(shownText).toContain('| a | **b** |');
    expect(view.dom.querySelectorAll('.cm-lp-table')).toHaveLength(3);
  });

  it('never hides characters inside inline code', async () => {
    const view = await editor('==use `a == b` here== and `x == y`\n\nend', { cursor: 0 });
    expect(shownLine(view, 1)).toContain('a == b');
    expect(shownLine(view, 1)).toContain('x == y');
  });

  it('marks links to missing notes, asking about the bare title', async () => {
    const { ref, calls } = makeHost(['Note']);
    const view = await editor('[[Note#Part|see]] and [[Gone|x]]', { host: ref });
    const links = [...view.dom.querySelectorAll('.cm-lp-wikilink')];
    expect(links.map((l) => [l.textContent, l.classList.contains('is-missing')])).toEqual([
      ['see', false],
      ['x', true],
    ]);
    expect(calls.filter((c) => c[0] === 'noteExists').map((c) => c[1])).toEqual(['Note', 'Gone']);
  });

  it('styles headings and callouts by line', async () => {
    const view = await editor('## Two\n\n> [!warning] Careful\n> body\n\n> plain quote');
    const lines = [...view.dom.querySelectorAll('.cm-line')];
    expect(lines[0].className).toContain('cm-lp-h2');
    expect(lines[2].className).toContain('cm-lp-callout-warning is-first');
    expect(lines[3].className).toContain('cm-lp-callout-warning is-last');
    expect(lines[5].className).toContain('cm-lp-quote');
    expect(lines[5].className).not.toContain('callout');
    expect(view.dom.querySelector('.cm-lp-callout-tag')!.textContent).toBe('[!warning]');
  });
});

describe('code blocks in live preview', () => {
  it('tuck their fences away while the cursor is outside, the language left as a label', async () => {
    const doc = 'Intro\n\n``` bash\ndocker compose down\n```\n\nend';
    const view = await editor(doc, { focus: true, cursor: 0 });
    const tucked = 'Intro\n\n[code bash]\ndocker compose down\n\n\nend';
    expect(shown(view)).toBe(tucked);
    expect(view.dom.querySelector('.cm-lp-code-lang')!.textContent).toBe('bash');
    // Anywhere in the block, fences included, shows it as written.
    for (const n of [3, 4, 5]) {
      view.dispatch({ selection: EditorSelection.cursor(view.state.doc.line(n).from) });
      expect(shown(view), `line ${n}`).toBe(doc);
    }
    // And clicking out of the editor tucks them away again.
    view.contentDOM.blur();
    await new Promise((r) => setTimeout(r, 25));
    expect(shown(view)).toBe(tucked);
    expect(view.state.doc.toString()).toBe(doc);
  });

  it('keep every line, so the code doesn’t move when the fences come back', async () => {
    const view = await editor('a\n```js\nx\n```\nb', { focus: true, cursor: 0 });
    expect(view.dom.querySelectorAll('.cm-line')).toHaveLength(5);
    view.dispatch({ selection: EditorSelection.cursor(view.state.doc.line(3).from) });
    expect(view.dom.querySelectorAll('.cm-line')).toHaveLength(5);
  });

  it('label as reading view does: the first word, lower case, or text with none', async () => {
    const view = await editor('````JS title="a.js"\nx\n````\n\n~~~\nplain\n~~~\n\nend');
    expect(shown(view)).toBe('[code js]\nx\n\n\n[code text]\nplain\n\n\nend');
  });

  it('copy the code from a Copy button on the label, leaving the cursor where it was', async () => {
    const writeText = vi.fn(async (_text: string) => {});
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    useApp.setState({ toasts: [] });
    const view = await editor('Intro\n\n``` bash\ndocker compose down\n```\n\nend', { focus: true, cursor: 0 });
    expect(view.dom.querySelector('.cm-lp-code-bar .cm-lp-code-copy')).not.toBeNull();
    pressCopy(view);
    expect(writeText).toHaveBeenCalledWith('docker compose down');
    expect(view.state.selection.main.head).toBe(0);
    expect(shownLine(view, 3)).toBe('[code bash]');
    await Promise.resolve();
    expect(useApp.getState().toasts.at(-1)?.message).toBe('Code copied');
  });

  it('copy what reading view would: the code as it is now, without a list’s indent or a quote’s >', async () => {
    const writeText = vi.fn(async (_text: string) => {});
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    const list = await editor('- item\n  ```py\n  pass\n    x = 1\n  ```\n\nend');
    pressCopy(list);
    expect(writeText).toHaveBeenLastCalledWith('pass\n  x = 1');
    const quote = await editor('> ```sh\n> ls\n> pwd\n> ```\n\nend');
    pressCopy(quote);
    expect(writeText).toHaveBeenLastCalledWith('ls\npwd');
    // Changed while the button is showing: the new code is copied.
    const view = await editor('```js\nlet a = 1;\n```\n\nend', { focus: true, cursor: 22 });
    view.dispatch({ changes: { from: 14, to: 15, insert: '2' } });
    pressCopy(view);
    expect(writeText).toHaveBeenLastCalledWith('let a = 2;');
    // Blank lines at the end don't come along either, so a pasted command still waits for Enter.
    pressCopy(await editor('```sh\ndocker compose down\n\n\n```\n\nend'));
    expect(writeText).toHaveBeenLastCalledWith('docker compose down');
  });

  it('say so when the clipboard can’t be used', async () => {
    vi.stubGlobal('navigator', { ...navigator, clipboard: undefined });
    useApp.setState({ toasts: [] });
    pressCopy(await editor('```\nx\n```\n\nend'));
    expect(useApp.getState().toasts.at(-1)).toMatchObject({ message: 'Couldn’t copy to the clipboard', kind: 'error' });
  });

  it('work in lists and quotes, and on a block never closed', async () => {
    const list = await editor('- item\n  ```py\n  pass\n  ```\n\nend');
    expect(shownLine(list, 2)).toBe('  [code py]');
    expect(shownLine(list, 4).trim()).toBe('');
    const quote = await editor('> ```sh\n> ls\n> ```\n\nend');
    expect(shownLine(quote, 1)).toBe('[code sh]');
    expect(shownLine(quote, 3)).not.toContain('```');
    const open = await editor('Intro\n\n```js\nlet a');
    expect(shown(open)).toBe('Intro\n\n[code js]\nlet a');
  });
});

describe('formulas in live preview', () => {
  it('are typeset where the cursor isn’t, and prices and code stay text', async () => {
    const doc = 'Costs $5 and $6, $x^2$ and `$y$`; $a*b*c$ and *d*.\n\n\\$7\\$ too\n\nend';
    const view = await editor(doc);
    expect(shownLine(view, 1)).toBe('Costs $5 and $6, [math x^2] and $y$; [math a*b*c] and d.');
    expect(shownLine(view, 3)).toBe('\\$7\\$ too');
    expect(view.dom.querySelectorAll('.cm-lp-math .katex')).toHaveLength(2);
  });

  it('open as TeX when the cursor arrives from the keyboard, and only that formula', async () => {
    const view = await editor('A $x^2$ and $y$.\n\nend', { focus: true });
    view.dispatch({ selection: EditorSelection.cursor(3) });
    expect(shownLine(view, 1)).toBe('A $x^2$ and [math y].');
  });

  it('show a display block typeset, or its TeX with a preview below while the cursor is in it', async () => {
    const view = await editor('Intro\n\n$$\n\\frac{a}{b}\n$$\n\nend', { focus: true, cursor: 0 });
    expect(shown(view)).toBe('Intro\n\n[math block \\frac{a}{b}]\n\nend');
    view.dispatch({ selection: EditorSelection.cursor(view.state.doc.line(4).from) });
    expect(shown(view)).toBe('Intro\n\n$$\n\\frac{a}{b}\n$$[preview \\frac{a}{b}]\n\nend');
  });

  it('leaves $$ inside a code block as code', async () => {
    const view = await editor('```\n$$\nx\n$$\n```\n\nend');
    expect(shown(view)).toBe('[code text]\n$$\nx\n$$\n\n\nend');
  });

  it('close again on Escape: the cursor goes just past an inline formula, the text unchanged', async () => {
    const view = await editor('See $x^2$ here', { focus: true, cursor: 6 });
    view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true, cancelable: true }));
    expect(view.state.selection.main.head).toBe(9);
    expect(view.state.doc.toString()).toBe('See $x^2$ here');
    expect(shown(view)).toBe('See [math x^2] here');
  });

  it('close a block at the end of the note on Escape by adding one line after it', async () => {
    const view = await editor('$$\nx\n$$', { focus: true, cursor: 3 });
    view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true, cancelable: true }));
    expect(view.state.doc.toString()).toBe('$$\nx\n$$\n');
    expect(view.state.selection.main.head).toBe(view.state.doc.length);
    expect(shown(view)).toBe('[math block x]\n');
  });

  it('open a block’s TeX from its Edit button, at the end of its first line', async () => {
    const view = await editor('Intro\n\n$$\na+b\nc\n$$', { focus: true, cursor: 0 });
    const edit = view.dom.querySelector('.cm-lp-math-block button')!;
    edit.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    expect(view.state.selection.main.head).toBe(view.state.doc.line(4).to);
    expect(view.state.doc.toString()).toBe('Intro\n\n$$\na+b\nc\n$$');
  });
});

describe('checkboxes in live preview', () => {
  const click = (el: Element) => el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));

  it('tick and untick their own line, in lists, numbered lists, callouts and nesting', async () => {
    const doc = '- [ ] one\n1. [x] two\n> - [ ] three\n  - [X] four\n- [ ] five';
    const view = await editor(doc);
    const boxes = () => [...view.dom.querySelectorAll('.cm-lp-task')];
    expect(boxes().map((b) => b.getAttribute('aria-checked'))).toEqual(['false', 'true', 'false', 'true', 'false']);
    click(boxes()[2]);
    expect(view.state.doc.toString()).toBe('- [ ] one\n1. [x] two\n> - [x] three\n  - [X] four\n- [ ] five');
    click(boxes()[3]);
    expect(view.state.doc.toString()).toBe('- [ ] one\n1. [x] two\n> - [x] three\n  - [ ] four\n- [ ] five');
    click(boxes()[1]);
    expect(view.state.doc.toString()).toBe('- [ ] one\n1. [ ] two\n> - [x] three\n  - [ ] four\n- [ ] five');
  });

  it('date a task with a due date, and bring a repeating one back above it', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date(2026, 10, 20, 12) });
    try {
      const view = await editor('- [ ] water 🔁 every day 📅 2026-11-20\n- [ ] milk');
      click(view.dom.querySelectorAll('.cm-lp-task')[0]);
      expect(view.state.doc.toString()).toBe('- [ ] water 🔁 every day 📅 2026-11-21\n- [x] water 🔁 every day 📅 2026-11-20 ✅ 2026-11-20\n- [ ] milk');
      // A plain checklist item stays plain; unticking takes the date off.
      click(view.dom.querySelectorAll('.cm-lp-task')[2]);
      click(view.dom.querySelectorAll('.cm-lp-task')[1]);
      expect(view.state.doc.toString()).toBe('- [ ] water 🔁 every day 📅 2026-11-21\n- [ ] water 🔁 every day 📅 2026-11-20\n- [x] milk');
    } finally {
      vi.useRealTimers();
    }
  });

  it('still tick the right line after the text above them changes', async () => {
    const view = await editor('- [ ] one\n- [ ] two');
    view.dispatch({ changes: { from: 0, insert: 'A new first line\n\n' } });
    click(view.dom.querySelectorAll('.cm-lp-task')[1]);
    expect(view.state.doc.toString()).toBe('A new first line\n\n- [ ] one\n- [x] two');
  });
});

describe('images, drawings and diagrams in live preview', () => {
  it('show an image in place of its Markdown, at the width it asks for', async () => {
    const view = await editor('![Chart|240](/api/files/abcdef12/c.png)\n\nend');
    const img = view.dom.querySelector<HTMLImageElement>('.cm-lp-image img')!;
    expect(img.getAttribute('src')).toBe('/api/files/abcdef12/c.png');
    expect(img.alt).toBe('Chart');
    expect(img.style.width).toBe('240px');
  });

  it('hold an image from another website behind a button when Settings say ask first', async () => {
    useSettings.setState({ remoteImages: 'ask' });
    const view = await editor('![chart](https://img.example/held.png)\n\nend');
    expect(view.dom.querySelector('.cm-lp-image img')).toBeNull();
    const ask = view.dom.querySelector<HTMLButtonElement>('.cm-lp-image button.cm-lp-remote')!;
    expect(ask.textContent).toBe('chart: image from img.example. Click to load');
    ask.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    expect(view.dom.querySelector('.cm-lp-image img')!.getAttribute('src')).toBe('https://img.example/held.png');
  });

  it('never point an image at an upload directly in an encrypted library', async () => {
    setCodec({} as Codec);
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
    const view = await editor('![p](/api/files/abcdef12/holiday.png)\n\nend');
    const img = view.dom.querySelector('.cm-lp-image img')!;
    expect(img.getAttribute('src') ?? '').not.toContain('/api/files/');
  });

  it('give drawings an Edit button that opens the drawing editor', async () => {
    const { ref, calls } = makeHost();
    const view = await editor('![d](/api/drawings/draw_123.svg)\n\nend', { host: ref });
    view.dom.querySelector('.cm-lp-image.is-drawing button')!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    expect(calls).toContainEqual(['editDrawing', 'draw_123']);
  });

  it('draw diagrams in place of their fence, and edit the same lines reading view would', async () => {
    const { ref, calls } = makeHost();
    const doc = 'Intro\n\n```mermaid\ngraph TD\n  A --> B\n```\n\nend';
    const view = await editor(doc, { host: ref });
    expect(shown(view)).toBe('Intro\n\n[diagram]\n\nend');
    await new Promise((r) => setTimeout(r, 0));
    view.dom.querySelector('.cm-lp-mermaid button')!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    const [, start, end, code] = calls.find((c) => c[0] === 'editMermaid')!;
    const placeholder = document.createElement('div');
    placeholder.innerHTML = renderMarkdown(doc);
    const block = placeholder.querySelector<HTMLElement>('.kb-mermaid')!;
    expect([start, end]).toEqual([Number(block.dataset.line), Number(block.dataset.lineEnd)]);
    expect(code).toBe('graph TD\n  A --> B');
  });

  it('leave a mermaid example inside another code block as code', async () => {
    const doc = '````md\n```mermaid\ngraph LR\n```\n````\n\nend';
    const view = await editor(doc);
    expect(shown(view)).toBe('[code md]\n```mermaid\ngraph LR\n```\n\n\nend');
  });
});

describe('cost of live preview', () => {
  it('stays quick on a long line of mixed syntax, cursor moves included', { retry: 2 }, async () => {
    const line = '**b** [[N]] ==h== $x$ `c` [l](https://e.x) '.repeat(400);
    const start = performance.now();
    const view = await editor(`${line}\n\nend`, { focus: true });
    for (const pos of [0, 100, line.length]) view.dispatch({ selection: EditorSelection.cursor(pos) });
    expectQuick(performance.now() - start, 1500);
  });

  it('stays quick on an image whose alt text is a long run of spaces', { retry: 2 }, async () => {
    const view = await editor(`![a${' '.repeat(20_000)}|x](/api/files/abcdef12/a.png)\n\nend`);
    const start = performance.now();
    view.dispatch({ selection: EditorSelection.cursor(view.state.doc.length) });
    expectQuick(performance.now() - start, 250);
  }, 20_000);
});

describe('image thumbnails when Markdown syntax is shown', () => {
  it('appear under lines with images, but not for media or links', async () => {
    const view = await editor('![a](/api/files/abcdef12/a.png) ![d](/api/drawings/abcdef1.svg)\n![v](/api/files/abcdef12/v.mp4)\n[not an image](/api/files/abcdef12/x.png)', { extensions: 'peeks' });
    const imgs = [...view.dom.querySelectorAll<HTMLImageElement>('.cm-img-peek img')];
    expect(imgs.map((i) => i.getAttribute('src'))).toEqual(['/api/files/abcdef12/a.png', '/api/drawings/abcdef1.svg']);
    expect(view.state.doc.lines).toBe(3);
  });

  it('don’t load images from other websites when Settings say ask first', async () => {
    useSettings.setState({ remoteImages: 'ask' });
    const view = await editor('![t](https://tracker.example/pixel.png)', { extensions: 'peeks' });
    const remote = [...view.dom.querySelectorAll('img')].filter((i) => /tracker\.example/.test(i.getAttribute('src') ?? ''));
    expect(remote).toEqual([]);
  });

  it('never point a thumbnail at an upload directly in an encrypted library', async () => {
    setCodec({} as Codec);
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
    const view = await editor('![p](/api/files/abcdef12/holiday-in-rome.png)', { extensions: 'peeks' });
    const direct = [...view.dom.querySelectorAll('img')].filter((i) => (i.getAttribute('src') ?? '').includes('/api/files/'));
    expect(direct).toEqual([]);
  });
});
