// @vitest-environment jsdom
/**
 * The diagram editor (src/components/MermaidEditor.tsx): Mermaid code on one side and its preview on
 * the other, templates to start from, and closing that never throws away edited code without asking.
 * The drawing itself (mermaid) is stood in for: the preview shows what renderMermaid returns.
 */
import { FAKE_TIMERS, advance, byName, click, dialog, mount, nameOf, pointerDown, press, queryByName, setMedia, text, typeInto, unmountAll, resetMedia } from './ui-note-helpers';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const drawn = vi.hoisted(() => ({ calls: [] as string[], fail: null as string | null }));
vi.mock('../../src/lib/mermaid', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/lib/mermaid')>()),
  renderMermaid: async (source: string) => {
    drawn.calls.push(source);
    if (drawn.fail) throw new Error(`Error: ${drawn.fail}\nmore detail`);
    return `<svg class="drawn" data-lines="${source.split('\n').length}"></svg>`;
  },
}));

import { MermaidEditor } from '../../src/components/MermaidEditor';
import { DialogHost } from '../../src/components/ui';
import { MERMAID_TEMPLATES } from '../../src/lib/mermaid';
import { openMermaidEditor, useApp } from '../../src/lib/store';

beforeEach(() => {
  vi.useFakeTimers(FAKE_TIMERS as never);
  drawn.calls.length = 0;
  drawn.fail = null;
});

afterEach(async () => {
  await act(async () => useApp.setState({ mermaid: null, dialog: null }));
  await unmountAll();
  resetMedia();
  vi.useRealTimers();
});

const FLOW = MERMAID_TEMPLATES[0].code;

async function openEditor(code: string, isNew: boolean) {
  await mount(
    <>
      <MermaidEditor />
      <DialogHost />
    </>,
  );
  let result!: Promise<string | null>;
  await act(async () => {
    result = openMermaidEditor(code, isNew);
  });
  let done: { value: string | null } | null = null;
  void result.then((value) => (done = { value }));
  const editor = () => document.querySelector<HTMLElement>('.mermaid-modal')!;
  const code$ = () => editor().querySelector<HTMLTextAreaElement>('textarea')!;
  return { result, answered: () => done, editor, code: code$ };
}

describe('the diagram editor', () => {
  it('starts a new diagram from the first template, ready to insert', async () => {
    const e = await openEditor('', true);
    expect(nameOf(e.editor())).toBe('New diagram');
    expect(e.code().value).toBe(FLOW);
    expect(nameOf(e.code())).toBe('Diagram code');
    expect(byName('Insert diagram', 'button', e.editor())).toBeTruthy();
    await advance(20);
    expect(document.activeElement).toBe(e.code());
  });

  it('opens an existing diagram’s code to edit and save', async () => {
    const e = await openEditor('pie\n  "A" : 1', false);
    expect(nameOf(e.editor())).toBe('Edit diagram');
    expect(e.code().value).toBe('pie\n  "A" : 1');
    await typeInto(e.code(), 'pie\n  "A" : 2');
    await click(byName('Save diagram', 'button', e.editor()));
    expect(await e.result).toBe('pie\n  "A" : 2');
    expect(useApp.getState().mermaid).toBeNull();
  });

  it('draws the preview a moment after typing stops, not on every key', async () => {
    const e = await openEditor('graph TD\n  A-->B', false);
    await advance(300);
    expect(e.editor().querySelector('.mermaid-preview svg.drawn')).not.toBeNull();
    drawn.calls.length = 0;
    await typeInto(e.code(), 'graph TD\n  A-->C');
    await advance(100);
    await typeInto(e.code(), 'graph TD\n  A-->D');
    await advance(300);
    expect(drawn.calls).toEqual(['graph TD\n  A-->D']);
  });

  it('says why code can’t be drawn, keeping the last good drawing dimmed', async () => {
    const e = await openEditor('graph TD\n  A-->B', false);
    await advance(300);
    drawn.fail = 'Parse error on line 2';
    await typeInto(e.code(), 'graph TD\n  A-->');
    await advance(300);
    expect(text(e.editor())).toContain('The diagram can’t be drawn yet.');
    expect(text(e.editor())).toContain('Parse error on line 2');
    expect(text(e.editor())).not.toContain('Error: Parse');
    expect(e.editor().querySelector('.mermaid-preview-svg')!.classList).toContain('is-stale');
  });

  it('can’t be saved with no code, by its button', async () => {
    const e = await openEditor('pie\n  "A" : 1', false);
    await typeInto(e.code(), '   ');
    expect((byName('Save diagram', 'button', e.editor()) as HTMLButtonElement).disabled).toBe(true);
  });

  it('can’t be saved with no code by Ctrl/⌘ Enter either', async () => {
    const e = await openEditor('pie\n  "A" : 1', false);
    await typeInto(e.code(), '');
    await press('Enter', { ctrl: true }, e.code());
    expect(e.answered()).toBeNull();
    expect(useApp.getState().mermaid).not.toBeNull();
  });

  it('saves with Ctrl/⌘ Enter', async () => {
    const e = await openEditor('pie\n  "A" : 1', false);
    await typeInto(e.code(), 'pie\n  "B" : 1');
    const key = await press('Enter', { meta: true }, e.code());
    expect(key.defaultPrevented).toBe(true);
    expect(await e.result).toBe('pie\n  "B" : 1');
  });

  it('indents with Tab instead of leaving the box', async () => {
    const e = await openEditor('graph TD\nA-->B', false);
    const box = e.code();
    box.setSelectionRange(9, 9);
    const key = await press('Tab', {}, box);
    expect(key.defaultPrevented).toBe(true);
    expect(box.value).toBe('graph TD\n    A-->B');
    await advance(20);
    expect(box.selectionStart).toBe(13);
  });
});

describe('templates', () => {
  it('swap one template for another without asking while the code is still a template', async () => {
    const e = await openEditor('', true);
    await click(byName('Sequence', 'button', e.editor()));
    expect(e.code().value).toBe(MERMAID_TEMPLATES.find((t) => t.label === 'Sequence')!.code);
    expect(useApp.getState().dialog).toBeNull();
  });

  it('ask before replacing code that was edited, and keep it when the answer is no', async () => {
    const e = await openEditor('', true);
    await typeInto(e.code(), 'graph LR\n  Mine-->Ours');
    await click(byName('Sequence', 'button', e.editor()));
    expect(nameOf(dialog()!)).toBe('Replace your diagram with the sequence template?');
    await click(byName('Cancel', 'button', dialog()!));
    expect(e.code().value).toBe('graph LR\n  Mine-->Ours');
    await click(byName('Sequence', 'button', e.editor()));
    await click(byName('Replace', 'button', dialog()!));
    expect(e.code().value).toContain('sequenceDiagram');
  });
});

describe('closing', () => {
  it('closes at once when nothing was changed, with nothing to insert', async () => {
    const e = await openEditor('', true);
    await click(byName('Cancel', 'button', e.editor()));
    expect(await e.result).toBeNull();
    expect(useApp.getState().dialog).toBeNull();
  });

  it('asks before throwing away edited code, from Cancel, Escape or the Close button', async () => {
    for (const leave of [
      (ed: HTMLElement) => click(byName('Cancel', 'button', ed)),
      () => press('Escape'),
      (ed: HTMLElement) => click(byName('Close', 'button', ed)),
    ]) {
      const e = await openEditor('pie\n  "A" : 1', false);
      await typeInto(e.code(), 'pie\n  "A" : 9');
      await leave(e.editor());
      expect(nameOf(dialog()!)).toBe('Discard changes to this diagram?');
      expect(byName('Discard', 'button', dialog()!).className).toContain('btn-danger');
      // Keep editing: nothing is lost.
      await click(byName('Cancel', 'button', dialog()!));
      expect(e.answered()).toBeNull();
      expect(e.code().value).toBe('pie\n  "A" : 9');
      // Discard: closed, nothing saved.
      await leave(e.editor());
      await click(byName('Discard', 'button', dialog()!));
      expect(await e.result).toBeNull();
      expect(useApp.getState().mermaid).toBeNull();
      await act(async () => useApp.setState({ dialog: null }));
      await unmountAll();
    }
  });

  it('stays open on a press beside it, where it’s easy to click by mistake', async () => {
    const e = await openEditor('pie\n  "A" : 1', false);
    await pointerDown(document.querySelector('.overlay')!);
    expect(useApp.getState().mermaid).not.toBeNull();
    expect(e.answered()).toBeNull();
  });

  it('keeps the edited code when Escape answers the “Discard changes?” question', async () => {
    const e = await openEditor('pie\n  "A" : 1', false);
    await typeInto(e.code(), 'pie\n  "A" : 9');
    await press('Escape');
    expect(nameOf(dialog()!)).toBe('Discard changes to this diagram?');
    await press('Escape');
    expect(useApp.getState().mermaid).not.toBeNull();
    expect(e.code().value).toBe('pie\n  "A" : 9');
    expect(queryByName('Discard', 'button')).toBeNull();
  });
});

describe('on a phone', () => {
  it('shows the code or the preview, switched with tabs', async () => {
    await setMedia('(max-width: 759px)', true);
    const e = await openEditor('graph TD\n  A-->B', false);
    expect(e.editor().querySelector('textarea')).not.toBeNull();
    expect(e.editor().querySelector('.mermaid-preview')).toBeNull();
    await click(byName('Preview', '[role="radio"]', e.editor()));
    await advance(300);
    expect(e.editor().querySelector('textarea')).toBeNull();
    expect(e.editor().querySelector('.mermaid-preview svg.drawn')).not.toBeNull();
    await click(byName('Code', '[role="radio"]', e.editor()));
    expect(e.code().value).toBe('graph TD\n  A-->B');
  });
});
