// @vitest-environment jsdom
/**
 * Reading view's component (src/components/Preview.tsx): clicking what the renderer made. A tick box
 * reports its line, diagrams report the lines to edit, links to headings and footnotes scroll, images
 * held back by Settings load on a click, and a read-only view (version history) changes nothing.
 */
import { act, createElement, createRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('mermaid', () => ({
  default: { initialize: () => {}, render: async (id: string) => ({ svg: `<svg id="${id}" xmlns="http://www.w3.org/2000/svg"><g><text>drawn</text></g></svg>` }) },
}));

import { Preview, type PreviewHandle } from '../../src/components/Preview';
import { useSettings } from '../../src/lib/settings';
import { useApp } from '../../src/lib/store';
import type { NoteMeta } from '../../src/lib/types';

const scrolled: Element[] = [];
const thrown: unknown[] = [];

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  // Missing from jsdom.
  (globalThis as { CSS?: { escape(s: string): string } }).CSS ??= { escape: (s: string) => s.replace(/[^\w-]/g, (c) => `\\${c}`) };
  Element.prototype.scrollIntoView = function (this: Element) {
    scrolled.push(this);
  };
  window.addEventListener('error', (e) => {
    thrown.push(e.error ?? e.message);
    e.preventDefault();
  });
});

const roots: Root[] = [];
afterEach(async () => {
  for (const r of roots.splice(0)) await act(async () => r.unmount());
  useSettings.setState({ remoteImages: 'load' });
  scrolled.length = 0;
  thrown.length = 0;
});

async function show(source: string, props: Record<string, unknown> = {}) {
  const calls: unknown[][] = [];
  const ref = createRef<PreviewHandle>();
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(
      createElement(Preview, {
        ref,
        source,
        onToggleTask: (line: number) => calls.push(['toggle', line]),
        onEditMermaid: (start: number, end: number, code: string) => calls.push(['mermaid', start, end, code]),
        onEditDrawing: (id: string) => calls.push(['drawing', id]),
        ...props,
      }),
    );
  });
  // Let diagrams draw.
  await act(async () => new Promise((r) => setTimeout(r, 0)));
  const click = (el: Element | null) => act(async () => void (el as HTMLElement).click());
  return { root: container, calls, click };
}

describe('reading view', () => {
  it('reports the line of the box that was ticked', async () => {
    const p = await show('---\ntitle: x\n---\n\n- [ ] one\n\n```\n- [ ] code\n```\n- [x] two');
    const boxes = p.root.querySelectorAll('input.kb-task-box');
    await p.click(boxes[1]);
    await p.click(boxes[0]);
    expect(p.calls).toEqual([
      ['toggle', 9],
      ['toggle', 4],
    ]);
  });

  it('changes nothing when read-only, not even the box', async () => {
    const p = await show('- [ ] one', { readOnly: true });
    const box = p.root.querySelector<HTMLInputElement>('input.kb-task-box')!;
    await p.click(box);
    expect(box.checked).toBe(false);
    expect(p.calls).toEqual([]);
  });

  it('ignores tick boxes and buttons written in the note’s own HTML', async () => {
    const p = await show('<input type="checkbox" class="kb-task-box" data-task-line="0">\n\n<button data-action="edit-mermaid">x</button>');
    await p.click(p.root.querySelector('input'));
    await p.click(p.root.querySelector('button'));
    expect(p.calls).toEqual([]);
  });

  it('edits a diagram by the lines of its fence, and a drawing by its id', async () => {
    const p = await show('Intro\n\n```mermaid\ngraph TD\n  A --> B\n```\n\n![d](/api/drawings/draw_123.svg)');
    expect(p.root.querySelector('.kb-mermaid svg')).not.toBeNull();
    await p.click(p.root.querySelector('.kb-mermaid button[data-action="edit-mermaid"]'));
    await p.click(p.root.querySelector('button[data-action="edit-drawing"]'));
    expect(p.calls).toEqual([
      ['mermaid', 2, 6, 'graph TD\n  A --> B\n'],
      ['drawing', 'draw_123'],
    ]);
  });

  it('scrolls to a footnote and to a heading linked in the same note', async () => {
    const p = await show('# Top\n\nClaim[^1]\n\n[Back up](#h-top)\n\n[^1]: Source.');
    await p.click(p.root.querySelector('sup a'));
    expect(scrolled.at(-1)?.id).toBe('fn1');
    await p.click([...p.root.querySelectorAll('a')].find((a) => a.textContent === 'Back up')!);
    expect(scrolled.at(-1)?.id).toBe('h-top');
    expect(thrown).toEqual([]);
  });

  it('handles a link to an empty anchor without an error', async () => {
    const p = await show('[top](#) and [[#Heading]]\n\n# Heading');
    for (const a of p.root.querySelectorAll('a')) await p.click(a);
    expect(thrown).toEqual([]);
  });

  it('opens links to existing notes by their title, and offers to create missing ones', async () => {
    const meta = (id: string, title: string, updated_at: number) =>
      ({ id, title, updated_at, deleted_at: null, folder_id: null, excerpt: '', info: {}, tags: [], pinned: false, version: 1, created_at: 0 }) as unknown as NoteMeta;
    useApp.setState({ notes: { old1234567: meta('old1234567', 'Plans', 1), new1234567: meta('new1234567', 'plans', 2) } });
    const p = await show('[[Plans#Next]] [[Elsewhere]]');
    const [found, missing] = p.root.querySelectorAll('a');
    // The most recently edited of two notes with the same title wins.
    expect(found.getAttribute('href')).toBe('/note/new1234567#h-next');
    expect(missing.getAttribute('data-wikilink-new')).toBe('Elsewhere');
    useApp.setState({ notes: {} });
  });

  it('loads an image held back by Settings when it is clicked, and remembers it', async () => {
    useSettings.setState({ remoteImages: 'ask' });
    const p = await show('![chart](https://img.example/clicked.png)');
    const held = p.root.querySelector<HTMLImageElement>('img.kb-remote')!;
    expect(held.getAttribute('src')).toBeNull();
    await p.click(held);
    expect(held.getAttribute('src')).toBe('https://img.example/clicked.png');
    expect(held.classList.contains('kb-remote')).toBe(false);
    const again = await show('![chart](https://img.example/clicked.png)');
    expect(again.root.querySelector('img')!.getAttribute('src')).toBe('https://img.example/clicked.png');
  });
});
