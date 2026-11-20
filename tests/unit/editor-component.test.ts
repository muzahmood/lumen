// @vitest-environment jsdom
/**
 * The Editor component (src/components/Editor.tsx) as NoteView uses it: the text it's given, edits it
 * reports, the selection it reports for the word count, the README's keyboard shortcuts, and changes
 * made outside it (a task ticked in reading view, a restore) applied without disturbing the cursor.
 */
import { act, createElement, createRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { EditorSelection } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Editor, type EditorHandle } from '../../src/components/Editor';
import type { HostRef } from '../../src/lib/editorExtensions';
import { wordCount } from '../../src/lib/utils';

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  // jsdom has no layout; CodeMirror measures after scrolling a change into view.
  Range.prototype.getClientRects ??= () => Object.assign([], { item: () => null }) as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect ??= () => new DOMRect();
});

const roots: Root[] = [];
afterEach(async () => {
  for (const r of roots.splice(0)) await act(async () => r.unmount());
});

async function mount(value: string) {
  const changes: string[] = [];
  const selections: string[] = [];
  const ref = createRef<EditorHandle>();
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  const host = { current: { noteTitles: () => [], templates: () => [] } } as unknown as HostRef;
  const render = (v: string) =>
    act(async () => {
      root.render(
        createElement(Editor, {
          ref,
          docKey: 'note-1',
          value: v,
          onChange: (text: string) => changes.push(text),
          host,
          spellcheck: false,
          showImages: false,
          livePreview: false,
          onSelectionText: (text: string) => selections.push(text),
        }),
      );
    });
  await render(value);
  const view = () => ref.current!.view() as EditorView;
  return { view, changes, selections, rerender: render, text: () => view().state.doc.toString(), unmount: () => act(async () => root.unmount()) };
}

const KEY_CODES: Record<string, number> = { Enter: 13, '0': 48, '1': 49, '2': 50, b: 66, i: 73, h: 72, k: 75 };

function press(view: EditorView, key: string, mods: { ctrl?: boolean; alt?: boolean; shift?: boolean } = {}) {
  const k = mods.shift && key.length === 1 ? key.toUpperCase() : key;
  view.contentDOM.dispatchEvent(
    new KeyboardEvent('keydown', {
      key: k,
      keyCode: KEY_CODES[key],
      ctrlKey: !!mods.ctrl,
      altKey: !!mods.alt,
      shiftKey: !!mods.shift,
      bubbles: true,
      cancelable: true,
    }),
  );
}

describe('the editor', () => {
  it('opens a note as it is, without reporting an edit', async () => {
    const e = await mount('# Plans\n\n- [ ] one\n- [x] two');
    expect(e.text()).toBe('# Plans\n\n- [ ] one\n- [x] two');
    expect(e.changes).toEqual([]);
  });

  it('opens a note written with Windows line endings without changing it', async () => {
    const e = await mount('| a | b |\r\n|---|---|\r\n| 1 | 2 |\r\n| 3 | 4 |');
    expect(e.view().state.doc.lines).toBe(4);
    expect(e.text()).toBe('| a | b |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |');
    expect(e.changes).toEqual([]);
  });

  it('reports each edit with the whole text', async () => {
    const e = await mount('Hello');
    await act(async () => e.view().dispatch({ changes: { from: 5, insert: ' world' } }));
    expect(e.changes).toEqual(['Hello world']);
  });

  it('applies a change made elsewhere as the smallest edit, keeping the cursor in place', async () => {
    const e = await mount('- [ ] one\n- [ ] two\nend');
    await act(async () => e.view().dispatch({ selection: EditorSelection.cursor(22) }));
    // Reading view ticks the first task.
    await e.rerender('- [x] one\n- [ ] two\nend');
    expect(e.text()).toBe('- [x] one\n- [ ] two\nend');
    expect(e.view().state.selection.main.head).toBe(22);
  });

  it('reports the selected text for the word count, and nothing once it’s gone', async () => {
    const e = await mount('One **two** three\n- [x] four five');
    await act(async () => e.view().dispatch({ selection: EditorSelection.range(4, 28) }));
    const last = e.selections.at(-1)!;
    expect(last).toBe('**two** three\n- [x] four');
    expect(wordCount(last)).toBe(3);
    await act(async () => e.view().dispatch({ selection: EditorSelection.cursor(3) }));
    expect(e.selections.at(-1)).toBe('');
    await act(async () => e.view().dispatch({ selection: EditorSelection.range(0, 3) }));
    await e.unmount();
    expect(e.selections.at(-1)).toBe('');
  });
});

describe('keyboard shortcuts from the README', () => {
  it('Ctrl/⌘ Enter ticks a task, or makes the line one', async () => {
    const e = await mount('call Sam');
    await act(async () => e.view().dispatch({ selection: EditorSelection.cursor(2) }));
    press(e.view(), 'Enter', { ctrl: true });
    expect(e.text()).toBe('- [ ] call Sam');
    press(e.view(), 'Enter', { ctrl: true });
    expect(e.text()).toBe('- [x] call Sam');
  });

  it('Ctrl/⌘ Alt 1–6 makes a heading, and Ctrl/⌘ Alt 0 plain text again', async () => {
    const e = await mount('Plans');
    press(e.view(), '2', { ctrl: true, alt: true });
    expect(e.text()).toBe('## Plans');
    press(e.view(), '1', { ctrl: true, alt: true });
    expect(e.text()).toBe('# Plans');
    press(e.view(), '0', { ctrl: true, alt: true });
    expect(e.text()).toBe('Plans');
  });

  it('leaves Ctrl Alt \\ to type a backslash: it’s AltGr on Windows keyboards such as German or French', async () => {
    const e = await mount('  indented');
    const ev = new KeyboardEvent('keydown', { key: '\\', keyCode: 220, ctrlKey: true, altKey: true, bubbles: true, cancelable: true });
    e.view().contentDOM.dispatchEvent(ev);
    // Not taken by "indent selection" (CodeMirror's Mod-Alt-\), so the browser types the character.
    expect(ev.defaultPrevented).toBe(false);
    expect(e.text()).toBe('  indented');
  });

  it('Ctrl/⌘ B, I and Shift H format the selection; Shift K makes a link', async () => {
    const e = await mount('word');
    const select = () => act(async () => e.view().dispatch({ selection: EditorSelection.range(0, e.text().length) }));
    await select();
    press(e.view(), 'b', { ctrl: true });
    expect(e.text()).toBe('**word**');
    await select();
    press(e.view(), 'b', { ctrl: true });
    expect(e.text()).toBe('word');
    await select();
    press(e.view(), 'i', { ctrl: true });
    expect(e.text()).toBe('*word*');
    await select();
    press(e.view(), 'i', { ctrl: true });
    await select();
    press(e.view(), 'h', { ctrl: true, shift: true });
    expect(e.text()).toBe('==word==');
    await select();
    press(e.view(), 'h', { ctrl: true, shift: true });
    await select();
    press(e.view(), 'k', { ctrl: true, shift: true });
    expect(e.text()).toBe('[word](https://)');
  });
});
