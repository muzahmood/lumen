// @vitest-environment jsdom
/**
 * The editor component's parts not covered by editor-component.test.ts (src/components/Editor.tsx):
 * its name for screen readers, spell check following Settings, Undo and Redo from the toolbar, where
 * the cursor goes when a note opens, and each note having its own undo history.
 */
import { FAKE_TIMERS, advance, mount, unmountAll } from './ui-note-helpers';
import { act, createRef } from 'react';
import type { EditorView } from '@codemirror/view';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Editor, type EditorHandle } from '../../src/components/Editor';
import type { HostRef } from '../../src/lib/editorExtensions';

afterEach(async () => {
  await unmountAll();
  vi.useRealTimers();
});

const host = { current: { noteTitles: () => [], templates: () => [] } } as unknown as HostRef;

async function open(props: { docKey?: string; value: string; spellcheck?: boolean; autoFocus?: boolean; livePreview?: boolean }) {
  const ref = createRef<EditorHandle>();
  const changes: string[] = [];
  const el = (p: typeof props) => (
    <Editor
      ref={ref}
      docKey={p.docKey ?? 'note-1'}
      value={p.value}
      onChange={(t: string) => changes.push(t)}
      host={host}
      spellcheck={p.spellcheck ?? true}
      showImages={false}
      livePreview={p.livePreview ?? false}
      autoFocus={p.autoFocus}
    />
  );
  const m = await mount(el(props));
  const view = () => ref.current!.view() as EditorView;
  return { ref, view, changes, text: () => view().state.doc.toString(), rerender: (p: typeof props) => m.rerender(el(p)) };
}

const type = (view: EditorView, at: number, insert: string) => act(async () => view.dispatch({ changes: { from: at, insert }, userEvent: 'input.type' }));

describe('the editor', () => {
  it('is named “Note text” for screen readers', async () => {
    const e = await open({ value: 'Hello' });
    expect(e.view().contentDOM.getAttribute('aria-label')).toBe('Note text');
    expect(e.view().contentDOM.getAttribute('role')).toBe('textbox');
  });

  it('follows the Spell check setting, without starting over', async () => {
    const e = await open({ value: 'Helo', spellcheck: true });
    const first = e.view();
    expect(first.contentDOM.getAttribute('spellcheck')).toBe('true');
    await e.rerender({ value: 'Helo', spellcheck: false });
    expect(e.view()).toBe(first);
    expect(e.view().contentDOM.getAttribute('spellcheck')).toBe('false');
  });

  it('undoes and redoes from outside (the toolbar’s buttons)', async () => {
    const e = await open({ value: 'Hello' });
    await type(e.view(), 5, ' world');
    expect(e.text()).toBe('Hello world');
    await act(async () => e.ref.current!.undo());
    expect(e.text()).toBe('Hello');
    await act(async () => e.ref.current!.redo());
    expect(e.text()).toBe('Hello world');
  });

  it('puts the cursor at the end of the text when it opens to write in', async () => {
    vi.useFakeTimers(FAKE_TIMERS as never);
    const e = await open({ value: 'First line\nSecond line', autoFocus: true });
    await advance(20);
    expect(e.view().state.selection.main.head).toBe('First line\nSecond line'.length);
    expect(e.changes).toEqual([]);
  });

  it('keeps each note’s undo history to itself: undo in the next note never brings back the last one’s text', async () => {
    const e = await open({ docKey: 'a', value: 'Note A' });
    await type(e.view(), 6, ' edited');
    await e.rerender({ docKey: 'b', value: 'Note B' });
    expect(e.text()).toBe('Note B');
    await act(async () => e.ref.current!.undo());
    expect(e.text()).toBe('Note B');
  });

  it('switching live preview on and off leaves the text as it is', async () => {
    const e = await open({ value: '# Title\n\n**bold** and [[Link]]', livePreview: false });
    await e.rerender({ value: '# Title\n\n**bold** and [[Link]]', livePreview: true });
    await e.rerender({ value: '# Title\n\n**bold** and [[Link]]', livePreview: false });
    expect(e.text()).toBe('# Title\n\n**bold** and [[Link]]');
    expect(e.changes).toEqual([]);
  });
});
