// @vitest-environment jsdom
/**
 * The editor's "/" insert menu and "[[" note links (src/lib/editorExtensions.ts): what each menu item
 * puts in the note, where the menu offers itself, and what choosing a note title writes.
 */
import { CompletionContext, type Completion, type CompletionResult } from '@codemirror/autocomplete';
import { EditorSelection, EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { ensureSyntaxTree } from '@codemirror/language';
import { afterEach, describe, expect, it } from 'vitest';
import { completionSources, SLASH_ITEMS, type EditorHost, type HostRef } from '../../src/lib/editorExtensions';
import { MERMAID_TEMPLATES } from '../../src/lib/mermaid';
import { isoDate } from '../../src/lib/templateText';

const TITLES = ['Garden plan', 'Budget 2026', 'garage sale', 'Reading list'];
const TEMPLATES = [
  { id: 'tpl-meeting', title: 'Meeting notes' },
  { id: 'tpl-weekly', title: 'Weekly review' },
  { id: 'tpl-blank', title: '' },
];

const views: EditorView[] = [];
afterEach(() => {
  for (const v of views.splice(0)) v.destroy();
});

function setup(doc: string, cursor = doc.length, opts: { titles?: string[]; templates?: typeof TEMPLATES } = {}) {
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
    noteTitles: () => opts.titles ?? TITLES,
    templates: () => opts.templates ?? TEMPLATES,
    insertTemplate: record('insertTemplate'),
    editDrawing: record('editDrawing'),
    editMermaid: record('editMermaid'),
    openLink: record('openLink'),
    openWikilink: record('openWikilink'),
    noteExists: () => true,
    assetUrl: (s) => s,
    viewImage: record('viewImage'),
    viewDiagram: record('viewDiagram'),
  };
  const ref: HostRef = { current: host };
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  const view = new EditorView({
    parent,
    state: EditorState.create({ doc, selection: EditorSelection.cursor(cursor), extensions: [markdown({ base: markdownLanguage })] }),
  });
  views.push(view);
  ensureSyntaxTree(view.state, view.state.doc.length, 5000);
  view.dispatch({});
  const [slash, wiki] = completionSources(ref);
  const ask = (source: typeof slash) => source(new CompletionContext(view.state, view.state.selection.main.head, false)) as CompletionResult | null;
  return {
    view,
    calls,
    slash: () => ask(slash),
    wiki: () => ask(wiki),
    text: () => view.state.doc.toString(),
    selected: () => view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to),
    head: () => view.state.selection.main.head,
    choose(result: CompletionResult | null, label: string) {
      const option = result?.options.find((o) => o.label === label);
      if (!option) throw new Error(`no option ${label} in ${result?.options.map((o) => o.label).join(', ')}`);
      const apply = option.apply as (v: EditorView, c: Completion, from: number, to: number) => void;
      apply(view, option, result!.from, result!.to ?? view.state.selection.main.head);
    },
  };
}

const labels = (r: CompletionResult | null) => r?.options.map((o) => o.label) ?? [];

describe('the / menu', () => {
  it('opens at the start of a line or after a space, listing every block and template', () => {
    const start = setup('/');
    expect(labels(start.slash())).toEqual([...SLASH_ITEMS.map((i) => i.label), 'Template: Meeting notes', 'Template: Weekly review', 'Template: Untitled']);
    expect(start.slash()!.from).toBe(0);
    const afterWord = setup('Some text /ta');
    expect(afterWord.slash()!.from).toBe('Some text '.length);
  });

  it('narrows by keyword or label as you type', () => {
    expect(labels(setup('/due').slash())).toContain('Due date');
    expect(labels(setup('/math').slash()).filter((l) => !l.startsWith('Template'))).toEqual(['Math block', 'Inline math']);
    expect(labels(setup('/h2').slash())).toEqual(['Heading 2']);
    expect(labels(setup('/callout').slash()).filter((l) => !l.startsWith('Template'))).toEqual(['Callout', 'Tip callout', 'Warning callout']);
    expect(setup('/zzzz').slash()).toBeNull();
  });

  it('stays away from paths, code, links and HTML', () => {
    expect(setup('and/or').slash()).toBeNull();
    expect(setup('```\n/ta').slash()).toBeNull();
    expect(setup('Some `code /ta` here', 'Some `code /ta'.length).slash()).toBeNull();
    const link = setup('[see /ta](https://example.com)', '[see /ta'.length);
    expect(link.slash()).toBeNull();
    expect(setup('<div title="x /ta').slash()).toBeNull();
  });

  it('finds templates by name, with or without the word template', () => {
    for (const q of ['/template', '/templ', '/t']) expect(labels(setup(q).slash()).filter((l) => l.startsWith('Template'))).toHaveLength(3);
    for (const q of ['/meet', '/templatemeet', '/template-meet']) {
      expect(labels(setup(q).slash()).filter((l) => l.startsWith('Template')), q).toEqual(['Template: Meeting notes']);
    }
  });

  it('shows at most twelve templates', () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ id: `t${i}`, title: `Template ${i}` }));
    expect(labels(setup('/template', undefined, { templates: many }).slash()).filter((l) => l.startsWith('Template:'))).toHaveLength(12);
  });

  it('puts a template in place of what was typed', () => {
    const e = setup('Intro\n/meet');
    e.choose(e.slash(), 'Template: Meeting notes');
    expect(e.text()).toBe('Intro\n');
    expect(e.head()).toBe(6);
    expect(e.calls).toEqual([['insertTemplate', 'tpl-meeting']]);
  });
});

describe('each / menu item', () => {
  /** Types "/query" on a new line after a paragraph, chooses `label`, and returns the editor. */
  function pick(label: string, query = '') {
    const e = setup(`Intro\n\n/${query}`);
    e.choose(e.slash(), label);
    return e;
  }

  it('makes headings, lists, tasks and quotes of the line', () => {
    const cases: Array<[string, string]> = [
      ['Heading 1', '# '],
      ['Heading 2', '## '],
      ['Heading 3', '### '],
      ['Task list', '- [ ] '],
      ['Bulleted list', '- '],
      ['Numbered list', '1. '],
      ['Quote', '> '],
    ];
    for (const [label, prefix] of cases) {
      const e = setup('Intro\n\nPlans /');
      e.choose(e.slash(), label);
      expect(e.text(), label).toBe(`Intro\n\n${prefix}Plans `);
    }
  });

  it('inserts tables, code, callouts, math, toggles and dividers with the part to type selected', () => {
    const table = pick('Table');
    expect(table.text()).toBe('Intro\n\n| Column 1 | Column 2 | Column 3 |\n| --- | --- | --- |\n|     |     |     |\n|     |     |     |\n');
    expect(table.selected()).toBe('Column 1');

    const code = pick('Code block');
    expect(code.text()).toBe('Intro\n\n```\n\n```\n');
    expect(code.view.state.doc.lineAt(code.head()).number).toBe(4);

    for (const [label, kind, title] of [
      ['Callout', 'note', 'Note'],
      ['Tip callout', 'tip', 'Tip'],
      ['Warning callout', 'warning', 'Warning'],
    ]) {
      const e = pick(label);
      expect(e.text(), label).toBe(`Intro\n\n> [!${kind}] ${title}\n> \n`);
      expect(e.selected(), label).toBe(title);
    }

    const block = pick('Math block');
    expect(block.text()).toBe('Intro\n\n$$\n\n$$\n');
    expect(block.view.state.doc.lineAt(block.head()).text).toBe('');
    expect(block.view.state.doc.lineAt(block.head()).number).toBe(4);

    const inline = pick('Inline math');
    expect(inline.text()).toBe('Intro\n\n$x$');
    expect(inline.selected()).toBe('x');

    const toggle = pick('Toggle section');
    expect(toggle.text()).toBe('Intro\n\n<details>\n<summary>Summary</summary>\n\nHidden content\n\n</details>\n');
    expect(toggle.selected()).toBe('Summary');

    // A divider straight after text would turn that text into a heading; it gets a blank line first.
    const divider = setup('Intro\n/');
    divider.choose(divider.slash(), 'Divider');
    expect(divider.text()).toBe('Intro\n\n---\n');
  });

  it('inserts diagrams from their templates', () => {
    for (const [label, id] of [
      ['Flowchart', 'flowchart'],
      ['Sequence diagram', 'sequence'],
      ['Mind map', 'mindmap'],
      ['Gantt chart', 'gantt'],
    ]) {
      const code = MERMAID_TEMPLATES.find((t) => t.id === id)!.code;
      expect(pick(label).text(), label).toBe(`Intro\n\n\`\`\`mermaid\n${code}\n\`\`\`\n`);
    }
  });

  it('inserts note links, footnotes and dates', () => {
    const link = pick('Link to note');
    expect(link.text()).toBe('Intro\n\n[[]]');
    expect(link.head()).toBe('Intro\n\n[['.length);

    const footnote = setup('Claim[^1] /');
    footnote.choose(footnote.slash(), 'Footnote');
    expect(footnote.text()).toBe('Claim[^1] [^2]\n\n[^2]: ');

    const today = pick('Today’s date');
    const written = new Date().toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
    expect(today.text()).toBe(`Intro\n\n${written}`);

    // A due date the Tasks view reads, with the date selected so typing replaces it.
    const due = setup('- [ ] pay rent /due');
    due.choose(due.slash(), 'Due date');
    expect(due.text()).toBe(`- [ ] pay rent 📅 ${isoDate(new Date())}`);
    expect(due.selected()).toBe(isoDate(new Date()));
  });

  it('hands pickers and editors to the app, leaving no / behind', () => {
    const cases: Array<[string, string]> = [
      ['Image', 'pickImages'],
      ['Take photo', 'takePhoto'],
      ['Drawing', 'openDrawing'],
      ['Diagram', 'openMermaid'],
      ['File attachment', 'pickFiles'],
    ];
    for (const [label, call] of cases) {
      const e = pick(label);
      expect(e.text(), label).toBe('Intro\n\n');
      expect(e.calls.map((c) => c[0]), label).toEqual([call]);
    }
  });
});

describe('[[ note links', () => {
  it('offer titles containing what was typed, in any case', () => {
    const e = setup('See [[gar');
    const result = e.wiki()!;
    expect(labels(result)).toEqual(['Garden plan', 'garage sale']);
    expect(result.from).toBe('See [['.length);
    expect(labels(setup('See [[').wiki())).toEqual(TITLES);
  });

  it('write the title and close the link, leaving the cursor after it', () => {
    // As typed with brackets closing themselves: the cursor sits before "]]".
    const closed = setup('See [[gar]] and more', 'See [[gar'.length);
    closed.choose(closed.wiki(), 'Garden plan');
    expect(closed.text()).toBe('See [[Garden plan]] and more');
    expect(closed.head()).toBe('See [[Garden plan]]'.length);
    const open = setup('See [[gar');
    open.choose(open.wiki(), 'garage sale');
    expect(open.text()).toBe('See [[garage sale]]');
    expect(open.head()).toBe(open.text().length);
  });

  it('stop offering titles after a label or heading starts, or on the next line', () => {
    expect(setup('[[Garden plan|my').wiki()).toBeNull();
    expect(setup('[[Garden plan#Be').wiki()).toBeNull();
    expect(setup('[[Garden\nplan').wiki()).toBeNull();
    expect(setup('[[Garden plan]] then').wiki()).toBeNull();
  });

  it('list at most 60 titles', () => {
    const many = Array.from({ length: 100 }, (_, i) => `Note ${i}`);
    expect(labels(setup('[[note', undefined, { titles: many }).wiki())).toHaveLength(60);
  });
});
