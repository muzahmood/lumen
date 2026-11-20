// @vitest-environment jsdom
/**
 * Reading view's clicks not covered by render-preview.test.ts (src/components/Preview.tsx): a code
 * block's Copy button, pictures and diagrams opening full size, drawings opening in the drawing editor
 * (by their Edit button or a double-click, never in a read-only view), and the headings it reports for
 * the outline.
 */
import { byName, clipboard, click, mount, settle, unmountAll } from './ui-note-helpers';
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('mermaid', () => ({
  default: { initialize: () => {}, render: async (id: string) => ({ svg: `<svg id="${id}" xmlns="http://www.w3.org/2000/svg"><g><text>drawn</text></g></svg>` }) },
}));

import { Preview } from '../../src/components/Preview';
import type { Heading } from '../../src/lib/markdown';
import { useApp } from '../../src/lib/store';

afterEach(async () => {
  await act(async () => useApp.setState({ lightbox: null, toasts: [] }));
  await unmountAll();
  clipboard.written.length = 0;
  clipboard.fail = false;
});

async function show(source: string, props: Record<string, unknown> = {}) {
  const calls: unknown[][] = [];
  const { container } = await mount(
    <Preview
      source={source}
      onToggleTask={(line: number) => calls.push(['toggle', line])}
      onEditMermaid={(s: number, e: number, code: string) => calls.push(['mermaid', s, e, code])}
      onEditDrawing={(id: string) => calls.push(['drawing', id])}
      {...props}
    />,
  );
  await settle();
  return { root: container, calls };
}

const toasts = () => useApp.getState().toasts.map((t) => t.message);

describe('a code block’s Copy button', () => {
  it('copies just the code, with no line break at the end to run a pasted command by itself', async () => {
    const p = await show('```js\nconst a = 1;\nconsole.log(a);\n```\n\n```sh\ndocker compose down\n\n\n```');
    await click(byName('Copy', 'button', p.root));
    await settle();
    await click(p.root.querySelectorAll('button[data-action="copy-code"]')[1]);
    await settle();
    expect(clipboard.written).toEqual(['const a = 1;\nconsole.log(a);', 'docker compose down']);
    expect(toasts()).toContain('Code copied');
  });

  it('says so when the clipboard refuses', async () => {
    clipboard.fail = true;
    const p = await show('```\nsecret sauce\n```');
    await click(byName('Copy', 'button', p.root));
    await settle();
    expect(toasts()).toContain('Couldn’t copy to the clipboard');
  });
});

describe('pictures, diagrams and drawings', () => {
  it('opens a picture full size, with its description', async () => {
    const p = await show('![A red bike](https://example.com/bike.png)');
    await click(p.root.querySelector('img'));
    expect(useApp.getState().lightbox).toEqual({ kind: 'image', src: 'https://example.com/bike.png', alt: 'A red bike' });
  });

  it('follows a linked picture’s link instead of enlarging it', async () => {
    const p = await show('[![logo](https://example.com/logo.png)](https://example.com)');
    await click(p.root.querySelector('img'));
    expect(useApp.getState().lightbox).toBeNull();
  });

  it('opens a diagram full size on a click, and edits it with its Edit button', async () => {
    const p = await show('Intro\n\n```mermaid\ngraph TD\n  A-->B\n```\n');
    await settle();
    const drawnSvg = p.root.querySelector('[data-action="zoom-diagram"] svg text')!;
    await act(async () => void drawnSvg.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(useApp.getState().lightbox).toMatchObject({ kind: 'svg' });
    await click(byName('Edit diagram', 'button', p.root));
    expect(p.calls).toEqual([['mermaid', 2, 6, 'graph TD\n  A-->B\n']]);
  });

  it('edits a drawing from its Edit button or a double-click', async () => {
    const p = await show('![Drawing](/api/drawings/abcdef123.svg)');
    await click(byName('Edit drawing', 'button', p.root));
    await act(async () => void p.root.querySelector('.kb-drawing img')!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })));
    expect(p.calls).toEqual([
      ['drawing', 'abcdef123'],
      ['drawing', 'abcdef123'],
    ]);
  });

  it('edits nothing in a read-only view (version history, the trash)', async () => {
    const p = await show('![Drawing](/api/drawings/abcdef123.svg)\n\n```mermaid\ngraph TD\n  A-->B\n```\n', { readOnly: true });
    await settle();
    await click(p.root.querySelector('[data-action="edit-drawing"]'));
    await act(async () => void p.root.querySelector('.kb-drawing img')!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })));
    const edit = p.root.querySelector('[data-action="edit-mermaid"]');
    if (edit) await click(edit);
    expect(p.calls).toEqual([]);
  });
});

describe('the outline', () => {
  it('reports the note’s headings as they change', async () => {
    const seen: Heading[][] = [];
    const { rerender } = await mount(<Preview source={'# One\n\ntext\n\n## Two'} onHeadings={(h: Heading[]) => seen.push(h)} />);
    expect(seen.at(-1)!.map((h) => [h.level, h.text])).toEqual([
      [1, 'One'],
      [2, 'Two'],
    ]);
    await rerender(<Preview source={'# One\n\n## Two\n\n### Three'} onHeadings={(h: Heading[]) => seen.push(h)} />);
    expect(seen.at(-1)!.map((h) => h.text)).toEqual(['One', 'Two', 'Three']);
  });
});
