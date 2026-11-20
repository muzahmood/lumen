// @vitest-environment jsdom
/**
 * The formatting toolbar under the editor (src/components/Toolbar.tsx): each button's effect on the
 * note's text, the Text style and More menus, the phone (compact) layout, the shortcuts it shows
 * (the README's), and that pressing a button keeps focus, and the phone keyboard, in the editor.
 */
import React from 'react';
import { EditorSelection, EditorState, type TransactionSpec } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { allByRole, boot, byRole, chooseMenuItem, click, menuLabels, queryByRole, render, teardown, textOf } from './ui-shell-helpers';

let Toolbar: typeof import('../../src/components/Toolbar').Toolbar;

beforeEach(async () => {
  await boot({ encrypted: false });
  ({ Toolbar } = await import('../../src/components/Toolbar'));
});
afterEach(teardown);

/** Just enough of an editor for the toolbar's commands: its text and selection, and focus. */
function editor(doc: string, from = 0, to = from) {
  const view = {
    state: EditorState.create({ doc, selection: EditorSelection.single(from, to) }),
    dispatch(...specs: TransactionSpec[]) {
      view.state = view.state.update(...specs).state;
    },
    focus: vi.fn(),
  };
  return { view: view as unknown as EditorView & { focus: ReturnType<typeof vi.fn> }, text: () => view.state.doc.toString() };
}

function host() {
  return {
    openMermaid: vi.fn(),
    openDrawing: vi.fn(),
    pickImages: vi.fn(),
    pickFiles: vi.fn(),
    takePhoto: vi.fn(),
  };
}

async function show(e: ReturnType<typeof editor> | null, opts: { compact?: boolean } = {}) {
  const hooks = host();
  const undo = vi.fn();
  const redo = vi.fn();
  const { container } = await render(<Toolbar getView={() => e?.view ?? null} host={hooks as never} onUndo={undo} onRedo={redo} compact={opts.compact} />);
  return { hooks, undo, redo, bar: byRole('toolbar', 'Formatting', container) };
}
const names = (bar: HTMLElement) => allByRole('button', undefined, bar).map((b) => b.getAttribute('aria-label'));

describe('the toolbar', () => {
  it('has the README’s buttons, each labelled, with their shortcuts', async () => {
    const { bar } = await show(editor(''));
    expect(names(bar)).toEqual([
      'Text style',
      'Bold',
      'Italic',
      'Highlight',
      'Checklist',
      'Bulleted list',
      'Numbered list',
      'Quote',
      'Link',
      'Image',
      'Drawing',
      'Diagram',
      'Table',
      'Code block',
      'More formatting',
    ]);
    const kbd = (name: string) => byRole('button', name, bar).dataset.tipKbd;
    expect(kbd('Bold')).toMatch(/^(Ctrl|⌘) B$/);
    expect(kbd('Italic')).toMatch(/^(Ctrl|⌘) I$/);
    expect(kbd('Highlight')).toMatch(/^(Ctrl|⌘) Shift H$/);
    expect(kbd('Link')).toMatch(/^(Ctrl|⌘) Shift K$/);
    for (const b of allByRole('button', undefined, bar)) expect(b.getAttribute('type')).toBe('button');
  });

  it('wraps the selection in bold, italic or highlight, keeping focus in the editor', async () => {
    const e = editor('one two three', 4, 7);
    const { bar } = await show(e);
    await click(byRole('button', 'Bold', bar));
    expect(e.text()).toBe('one **two** three');
    expect(e.view.focus).toHaveBeenCalled();
    const i = editor('word', 0, 4);
    const second = await show(i);
    await click(byRole('button', 'Italic', second.bar));
    expect(i.text()).toBe('*word*');
    await click(byRole('button', 'Highlight', second.bar));
    expect(i.text()).toBe('*==word==*');
  });

  it('turns lines into a checklist, bullets, numbers or a quote, and back', async () => {
    const e = editor('milk', 2);
    const { bar } = await show(e);
    await click(byRole('button', 'Checklist', bar));
    expect(e.text()).toBe('- [ ] milk');
    await click(byRole('button', 'Checklist', bar));
    expect(e.text()).toBe('milk');
    await click(byRole('button', 'Bulleted list', bar));
    expect(e.text()).toBe('- milk');
    await click(byRole('button', 'Numbered list', bar));
    expect(e.text()).toBe('1. milk');
    await click(byRole('button', 'Quote', bar));
    expect(e.text()).toMatch(/^> /);
  });

  it('inserts a link, a table and a code block', async () => {
    const e = editor('see docs', 4, 8);
    const { bar } = await show(e);
    await click(byRole('button', 'Link', bar));
    expect(e.text()).toMatch(/^see \[docs\]\(.*\)$/);
    const t = editor('');
    const second = await show(t);
    await click(byRole('button', 'Table', second.bar));
    expect(t.text()).toMatch(/^\|.*\|\n\|[-| :]+\|/);
    const c = editor('');
    const third = await show(c);
    await click(byRole('button', 'Code block', third.bar));
    expect(c.text()).toMatch(/^```\n[\s\S]*\n```/);
  });

  it('hands images, drawings and diagrams to the note', async () => {
    const { bar, hooks } = await show(editor(''));
    await click(byRole('button', 'Image', bar));
    await click(byRole('button', 'Drawing', bar));
    await click(byRole('button', 'Diagram', bar));
    expect(hooks.pickImages).toHaveBeenCalledTimes(1);
    expect(hooks.openDrawing).toHaveBeenCalledTimes(1);
    expect(hooks.openMermaid).toHaveBeenCalledTimes(1);
  });

  it('keeps focus (and a phone’s keyboard) in the editor when a button is pressed', async () => {
    const { bar } = await show(editor(''));
    for (const name of ['Bold', 'Checklist', 'Image', 'Table']) {
      const ev = new MouseEvent('pointerdown', { bubbles: true, cancelable: true });
      byRole('button', name, bar).dispatchEvent(ev);
      expect(ev.defaultPrevented, name).toBe(true);
    }
  });

  it('does nothing, without failing, when the editor isn’t there', async () => {
    const { bar } = await show(null);
    await click(byRole('button', 'Bold', bar));
    await click(byRole('button', 'Table', bar));
    expect(bar.isConnected).toBe(true);
  });
});

describe('its menus', () => {
  it('makes headings and plain text from Text style', async () => {
    const e = editor('Plans', 1);
    const { bar } = await show(e);
    await click(byRole('button', 'Text style', bar));
    expect(menuLabels()).toEqual(['Heading 1', 'Heading 2', 'Heading 3', 'Normal text']);
    await chooseMenuItem('Heading 2');
    expect(e.text()).toBe('## Plans');
    await click(byRole('button', 'Text style', bar));
    await chooseMenuItem('Normal text');
    expect(e.text()).toBe('Plans');
  });

  it('offers the rest from More formatting, with Strikethrough’s shortcut', async () => {
    const e = editor('old', 0, 3);
    const { bar, hooks } = await show(e);
    await click(byRole('button', 'More formatting', bar));
    expect(menuLabels()).toEqual([
      'Strikethrough',
      'Callout',
      'Collapsible section',
      'Inline math',
      'Math block',
      'Divider',
      'Footnote',
      'Attach a file',
      'Take a photo',
    ]);
    expect(textOf(document.querySelector('[role="menu"] .menu-hint'))).toMatch(/^(Ctrl|⌘) Shift X$/);
    await chooseMenuItem('Strikethrough');
    expect(e.text()).toBe('~~old~~');
    await click(byRole('button', 'More formatting', bar));
    await chooseMenuItem('Attach a file');
    expect(hooks.pickFiles).toHaveBeenCalledTimes(1);
  });

  it('inserts a callout, a divider and display math', async () => {
    const e = editor('');
    const { bar } = await show(e);
    await click(byRole('button', 'More formatting', bar));
    await chooseMenuItem('Callout');
    expect(e.text()).toMatch(/^> \[!note\] Note\n> /);
    const d = editor('');
    const second = await show(d);
    await click(byRole('button', 'More formatting', second.bar));
    await chooseMenuItem('Divider');
    expect(d.text().trim()).toBe('---');
    const m = editor('');
    const third = await show(m);
    await click(byRole('button', 'More formatting', third.bar));
    await chooseMenuItem('Math block');
    expect(m.text()).toMatch(/^\$\$\n\n\$\$/);
  });
});

describe('on a phone (compact)', () => {
  it('puts Undo, Redo and Take a photo in the bar and leaves the rest to More', async () => {
    const { bar, undo, redo, hooks } = await show(editor(''), { compact: true });
    expect(names(bar)).toEqual(['Undo', 'Redo', 'Text style', 'Bold', 'Italic', 'Highlight', 'Checklist', 'Bulleted list', 'Image', 'Take a photo', 'Drawing', 'Diagram', 'Table', 'More formatting']);
    await click(byRole('button', 'Undo', bar));
    await click(byRole('button', 'Redo', bar));
    await click(byRole('button', 'Take a photo', bar));
    expect([undo.mock.calls.length, redo.mock.calls.length, hooks.takePhoto.mock.calls.length]).toEqual([1, 1, 1]);
    await click(byRole('button', 'More formatting', bar));
    expect(menuLabels()).not.toContain('Take a photo');
    expect(queryByRole('button', 'Numbered list', bar)).toBeNull();
  });
});
