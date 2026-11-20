// @vitest-environment jsdom
/** Ctrl/⌘ Enter on tasks, and Ctrl/⌘ Alt 0–6 for headings. */
import { EditorSelection, EditorState, type TransactionSpec } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import { describe, expect, it } from 'vitest';
import { setHeading, toggleTask } from '../../src/lib/editorCommands';

/** Just enough of an editor for the commands: its state, and applying a change. */
function editor(doc: string, from: number, to = from) {
  const view = {
    state: EditorState.create({ doc, selection: EditorSelection.single(from, to), extensions: EditorState.allowMultipleSelections.of(true) }),
    dispatch(spec: TransactionSpec) {
      view.state = view.state.update(spec).state;
    },
    focus() {},
  };
  return { view: view as unknown as EditorView, text: () => view.state.doc.toString() };
}

describe('Ctrl/⌘ Enter', () => {
  it('ticks a task, and unticks it again', () => {
    const e = editor('- [ ] call Sam\n', 4);
    toggleTask(e.view);
    expect(e.text()).toBe('- [x] call Sam\n');
    toggleTask(e.view);
    expect(e.text()).toBe('- [ ] call Sam\n');
  });

  it('makes a plain line or a bullet a task', () => {
    const plain = editor('call Sam', 2);
    toggleTask(plain.view);
    expect(plain.text()).toBe('- [ ] call Sam');
    const bullet = editor('  - call Sam', 5);
    toggleTask(bullet.view);
    expect(bullet.text()).toBe('  - [ ] call Sam');
  });

  it('ticks numbered and quoted tasks, and keeps a quote when making a task', () => {
    const numbered = editor('1. [ ] call Sam', 6);
    toggleTask(numbered.view);
    expect(numbered.text()).toBe('1. [x] call Sam');
    const quoted = editor('> [!note]\n> - [ ] inside', 14);
    toggleTask(quoted.view);
    expect(quoted.text()).toBe('> [!note]\n> - [x] inside');
    const plain = editor('> just text', 4);
    toggleTask(plain.view);
    expect(plain.text()).toBe('> - [ ] just text');
  });

  it('ticks every selected task when any is open, and unticks them when all are done', () => {
    const doc = '- [x] one\n- [ ] two\n* [X] three';
    const e = editor(doc, 0, doc.length);
    toggleTask(e.view);
    expect(e.text()).toBe('- [x] one\n- [x] two\n* [X] three');
    toggleTask(e.view);
    expect(e.text()).toBe('- [ ] one\n- [ ] two\n* [ ] three');
  });
});

describe('Ctrl/⌘ Alt and a digit', () => {
  it('sets, swaps and removes a heading', () => {
    const e = editor('Plans', 0);
    setHeading(e.view, 2);
    expect(e.text()).toBe('## Plans');
    setHeading(e.view, 1);
    expect(e.text()).toBe('# Plans');
    setHeading(e.view, 0);
    expect(e.text()).toBe('Plans');
  });

  it('turns a list item or task into a heading, without its marker', () => {
    const task = editor('- [ ] Next steps', 8);
    setHeading(task.view, 2);
    expect(task.text()).toBe('## Next steps');
    const item = editor('  1. Next steps', 6);
    setHeading(item.view, 3);
    expect(item.text()).toBe('### Next steps');
  });
});
