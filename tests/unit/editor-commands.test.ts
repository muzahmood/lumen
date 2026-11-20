// @vitest-environment jsdom
/**
 * Editor commands (src/lib/editorCommands.ts) beyond editorCommands.test.ts: several lines at once,
 * nested lists, quotes and callouts, Windows line endings, the last line, and the toolbar's wrap and
 * list buttons.
 */
import { EditorSelection, EditorState, type SelectionRange, type TransactionSpec } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import { describe, expect, it, vi } from 'vitest';
import {
  insertBlock,
  insertCodeBlock,
  insertFootnote,
  insertLink,
  insertTable,
  setHeading,
  toggleLinePrefix,
  toggleTask,
  toggleWrap,
} from '../../src/lib/editorCommands';

/** Just enough of an editor for the commands: its state, and applying a change. */
function editor(doc: string, ...ranges: Array<[number, number?]>) {
  const selection = ranges.length
    ? EditorSelection.create(ranges.map(([a, b]) => EditorSelection.range(a, b ?? a)))
    : EditorSelection.single(0);
  const view = {
    state: EditorState.create({ doc, selection, extensions: EditorState.allowMultipleSelections.of(true) }),
    dispatch(...specs: TransactionSpec[]) {
      view.state = view.state.update(...specs).state;
    },
    focus() {},
  };
  return {
    view: view as unknown as EditorView,
    text: () => view.state.doc.toString(),
    selected: () => view.state.selection.ranges.map((r: SelectionRange) => view.state.sliceDoc(r.from, r.to)),
    head: () => view.state.selection.main.head,
  };
}

/** The whole document selected. */
const all = (doc: string) => editor(doc, [0, doc.length]);

describe('Ctrl/⌘ Enter on several lines', () => {
  it('makes each selected line a task, keeping indents and quotes', () => {
    const e = all('call Sam\n  - nested bullet\n> quoted line\n> 3. numbered in a quote');
    toggleTask(e.view);
    expect(e.text()).toBe('- [ ] call Sam\n  - [ ] nested bullet\n> - [ ] quoted line\n> - [ ] numbered in a quote');
  });

  it('ticks tasks on the last line of a note with no line break after it', () => {
    const e = editor('intro\n- [ ] last', [8]);
    toggleTask(e.view);
    expect(e.text()).toBe('intro\n- [x] last');
  });

  it('dates tasks with a due date, and brings each repeating one back above it', () => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date(2026, 10, 20, 12) });
    try {
      const e = all('- [ ] a 🔁 every week 📅 2026-11-20\n- [ ] b 📅 2026-11-22');
      toggleTask(e.view);
      expect(e.text()).toBe('- [ ] a 🔁 every week 📅 2026-11-27\n- [x] a 🔁 every week 📅 2026-11-20 ✅ 2026-11-20\n- [x] b 📅 2026-11-22 ✅ 2026-11-20');
    } finally {
      vi.useRealTimers();
    }
  });

  it('works on each line of several separate selections', () => {
    const e = editor('- [ ] a\nb\n- [ ] c', [2], [16]);
    toggleTask(e.view);
    expect(e.text()).toBe('- [x] a\nb\n- [x] c');
  });

  it('acts on the lines of a note written with Windows line endings, leaving no stray \\r', () => {
    const e = editor('- [ ] one\r\n- [ ] two\r\n', [12]);
    toggleTask(e.view);
    expect(e.text()).toBe('- [ ] one\n- [x] two\n');
  });

  it('leaves the next line alone when a selection ends at its very start', () => {
    const e = editor('Plans\nNotes', [0, 6]);
    setHeading(e.view, 1);
    expect(e.text()).toBe('# Plans\nNotes');
    const t = editor('call Sam\nbuy milk', [0, 9]);
    toggleTask(t.view);
    expect(t.text()).toBe('- [ ] call Sam\nbuy milk');
  });
});

describe('Ctrl/⌘ Alt and a digit on several lines', () => {
  it('makes every selected line that heading, stripping list markers', () => {
    const e = all('One\n- Two\n3. Three\n- [x] Four');
    setHeading(e.view, 3);
    expect(e.text()).toBe('### One\n### Two\n### Three\n### Four');
    setHeading(e.view, 0);
    expect(e.text()).toBe('One\nTwo\nThree\nFour');
  });

  it('turns plain text back to plain text without touching it', () => {
    const e = all('- [ ] task\n> quote\nplain');
    setHeading(e.view, 0);
    expect(e.text()).toBe('- [ ] task\n> quote\nplain');
  });

  it('makes every line the heading even when one of them already is', () => {
    const e = all('## Already\nNot yet');
    setHeading(e.view, 2);
    expect(e.text()).toBe('## Already\n## Not yet');
  });

  it('keeps a line inside its quote or callout', () => {
    const e = editor('> [!note] Plan\n> Next steps', [17]);
    setHeading(e.view, 2);
    expect(e.text()).toBe('> [!note] Plan\n> ## Next steps');
  });
});

describe('wrapping a selection (bold, italic, highlight, code)', () => {
  it('wraps, and unwraps from inside or outside the markers', () => {
    const e = editor('make this bold', [5, 9]);
    toggleWrap(e.view, '**');
    expect(e.text()).toBe('make **this** bold');
    expect(e.selected()).toEqual(['this']);
    toggleWrap(e.view, '**');
    expect(e.text()).toBe('make this bold');
    const outer = editor('make **this** bold', [5, 13]);
    toggleWrap(outer.view, '**');
    expect(outer.text()).toBe('make this bold');
    expect(outer.selected()).toEqual(['this']);
  });

  it('inserts a placeholder to type over when nothing is selected', () => {
    const e = editor('x ', [2]);
    toggleWrap(e.view, '==');
    expect(e.text()).toBe('x ==text==');
    expect(e.selected()).toEqual(['text']);
    const code = editor('', [0]);
    toggleWrap(code.view, '`', '`', 'code');
    expect(code.text()).toBe('`code`');
    expect(code.selected()).toEqual(['code']);
  });

  it('wraps each of several selections', () => {
    const e = editor('one two three', [0, 3], [8, 13]);
    toggleWrap(e.view, '*');
    expect(e.text()).toBe('*one* two *three*');
    expect(e.selected()).toEqual(['one', 'three']);
  });

  it('makes a bold word bold italic with Ctrl/⌘ I, rather than italic only', () => {
    const inside = editor('a **bold** word', [4, 8]);
    toggleWrap(inside.view, '*');
    expect(inside.text()).toBe('a ***bold*** word');
    const whole = editor('a **bold** word', [2, 10]);
    toggleWrap(whole.view, '*');
    expect(whole.text()).toBe('a ***bold*** word');
  });
});

describe('the toolbar’s list buttons', () => {
  it('number the selected lines in order, keeping quotes and indents', () => {
    const e = all('first\n> second\n  third');
    toggleLinePrefix(e.view, 'number');
    expect(e.text()).toBe('1. first\n> 2. second\n  3. third');
    toggleLinePrefix(e.view, 'number');
    expect(e.text()).toBe('first\n> second\n  third');
  });

  it('turn one kind of list into another', () => {
    // Every selected line becomes a bullet (the one that was already stays one).
    const e = all('- a\n1. b\n- [x] c');
    toggleLinePrefix(e.view, 'bullet');
    expect(e.text()).toBe('- a\n- b\n- c');
    const t = all('- a\n1) b');
    toggleLinePrefix(t.view, 'task');
    expect(t.text()).toBe('- [ ] a\n- [ ] b');
  });

  it('quote and unquote lines', () => {
    const e = all('a\nb');
    toggleLinePrefix(e.view, 'quote');
    expect(e.text()).toBe('> a\n> b');
    toggleLinePrefix(e.view, 'quote');
    expect(e.text()).toBe('a\nb');
  });

  it('extend a list to the selected lines that aren’t in it yet', () => {
    const e = all('1. first\n2. second\nthird');
    toggleLinePrefix(e.view, 'number');
    expect(e.text()).toBe('1. first\n2. second\n3. third');
    const b = all('- a\nb');
    toggleLinePrefix(b.view, 'bullet');
    expect(b.text()).toBe('- a\n- b');
  });
});

describe('inserting blocks', () => {
  it('puts a block on its own lines with a blank line around it', () => {
    const mid = editor('Para one\nmore', [3]);
    insertBlock(mid.view, '---');
    expect(mid.text()).toBe('Para one\n\n---\n\nmore');
    const blank = editor('Para\n\n\n\nNext', [6]);
    insertBlock(blank.view, '---');
    expect(blank.text()).toBe('Para\n\n---\n\nNext');
    const start = editor('', [0]);
    insertBlock(start.view, '---');
    expect(start.text()).toBe('---\n');
  });

  it('makes a table with the first header selected to type over', () => {
    const e = editor('', [0]);
    insertTable(e.view);
    expect(e.text()).toBe('| Column 1 | Column 2 | Column 3 |\n| --- | --- | --- |\n|     |     |     |\n|     |     |     |\n');
    expect(e.selected()).toEqual(['Column 1']);
  });

  it('makes code inline for one line and a fenced block for several', () => {
    const one = editor('call foo() now', [5, 10]);
    insertCodeBlock(one.view);
    expect(one.text()).toBe('call `foo()` now');
    const many = editor('a = 1\nb = 2', [0, 11]);
    insertCodeBlock(many.view);
    expect(many.text()).toBe('```\na = 1\nb = 2\n```');
    const empty = editor('Text', [4]);
    insertCodeBlock(empty.view);
    expect(empty.text()).toBe('Text\n\n```\n\n```\n');
    expect(empty.head()).toBe('Text\n\n```\n'.length);
  });

  it('numbers footnotes after the ones already used, with the note at the end', () => {
    const e = editor('Claim[^1] and more.\n\n[^1]: Source.', [18]);
    insertFootnote(e.view);
    expect(e.text()).toBe('Claim[^1] and more[^2].\n\n[^1]: Source.\n\n[^2]: ');
    expect(e.head()).toBe(e.text().length);
  });

  it('makes links from a selected address or selected words', () => {
    const url = editor('see https://example.com', [4, 23]);
    insertLink(url.view);
    expect(url.text()).toBe('see [link text](https://example.com)');
    expect(url.selected()).toEqual(['link text']);
    const words = editor('see the docs', [8, 12]);
    insertLink(words.view);
    expect(words.text()).toBe('see the [docs](https://)');
    expect(words.selected()).toEqual(['https://']);
  });
});
