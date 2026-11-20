// @vitest-environment jsdom
/**
 * Other notes shown inside a note (src/lib/embeds.ts, markdown.ts, Preview.tsx, NotePeek.tsx):
 * "![[Note]]" embeds in reading view, filled in from this device's copy (or fetched and decrypted
 * here), read-only, never inside themselves; and the preview shown on resting over a [[link]].
 */
import { click, mount, resetMedia, setMedia, settle, unmountAll } from './ui-note-helpers';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Preview } from '../../src/components/Preview';
import { api } from '../../src/lib/api';
import { hydrateEmbeds, MAX_EMBED_DEPTH, noteSection } from '../../src/lib/embeds';
import { renderMarkdown } from '../../src/lib/markdown';
import { noteCache, useApp } from '../../src/lib/store';

const NOW = Date.UTC(2026, 10, 20);
const ids: Record<string, string> = {};

function note(id: string, title: string, content: string | null, extra: Record<string, unknown> = {}) {
  const meta = { id, title, folder_id: null, excerpt: '', tags: [], pinned: false, version: 1, created_at: NOW, updated_at: NOW, ...extra };
  ids[title.toLowerCase()] = id;
  useApp.setState((s) => ({ notes: { ...s.notes, [id]: meta as never } }));
  if (content !== null) noteCache.set(id, { ...meta, content } as never);
}
const resolveTitle = (t: string) => ids[t.toLowerCase()] ?? null;
const opts = (within: string[] = []) => ({ resolveTitle, breaks: true, remoteImages: 'load' as const, theme: 'light' as const, within });

function rendered(src: string) {
  const div = document.createElement('div');
  div.innerHTML = renderMarkdown(src, { resolveTitle });
  document.body.append(div);
  return div;
}

beforeEach(() => {
  useApp.setState({ notes: {} });
  noteCache.clear();
  for (const k of Object.keys(ids)) delete ids[k];
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  resetMedia();
  await unmountAll();
  document.body.replaceChildren();
});

describe('"![[Note]]" in the text', () => {
  it('becomes an embed of that note, or one heading of it, linking to it until filled in', () => {
    note('garden1234', 'Garden', '# Garden');
    const div = rendered('Before\n\n![[Garden]]\n\n![[Garden#Spring beds|beds]] and ![[Nowhere]] and ![[#Local]]');
    const embeds = [...div.querySelectorAll<HTMLElement>('span.kb-embed')];
    expect(embeds.map((e) => [e.dataset.embedId, e.dataset.embedHeading ?? null, e.querySelector('a')!.getAttribute('href')])).toEqual([
      ['garden1234', null, '/note/garden1234'],
      ['garden1234', 'Spring beds', '/note/garden1234#h-spring-beds'],
    ]);
    expect(div.querySelector('a.is-missing')!.getAttribute('data-wikilink-new')).toBe('Nowhere');
    // One of this note's own headings: just its name, as [[#Local]] would be.
    expect(div.textContent).toContain('and #Local');
  });

  it('can’t be faked with HTML written into a note', () => {
    note('garden1234', 'Garden', '# Garden');
    const div = rendered('<span class="kb-embed" data-embed-id="garden1234">x</span>');
    const span = div.querySelector('span')!;
    expect(span.classList.contains('kb-embed')).toBe(false);
    expect(span.hasAttribute('data-embed-id')).toBe(false);
  });
});

describe('a heading’s part of a note', () => {
  const md = ['# Plan', 'intro', '## Spring beds', 'dig', '### Tools', 'spade', '```', '## Not a heading', '```', '## Summer', 'water', '# Other'].join('\n');

  it('runs to the next heading at its level or above, ignoring code', () => {
    expect(noteSection(md, 'Spring beds')).toBe(['## Spring beds', 'dig', '### Tools', 'spade', '```', '## Not a heading', '```'].join('\n'));
    expect(noteSection(md, 'spring-beds')).toBe(noteSection(md, 'Spring beds'));
    expect(noteSection(md, 'Other')).toBe('# Other');
    expect(noteSection(md, 'Not a heading')).toBeNull();
    expect(noteSection(md, 'Autumn')).toBeNull();
  });
});

describe('filling embeds in', () => {
  it('shows the note’s text, or a heading’s part, from this device, read-only', async () => {
    note('garden1234', 'Garden', '# Garden\n\n## Spring beds\n\n- [ ] dig the beds\n\n```mermaid\ngraph TD; A-->B\n```\n\n## Summer\n\nwater');
    const div = rendered('![[Garden#Spring beds]]');
    const get = vi.spyOn(api, 'getNote');
    await hydrateEmbeds(div, opts());
    const embed = div.querySelector<HTMLElement>('.kb-embed.is-filled')!;
    expect(embed.querySelector('.kb-embed-head')!.textContent).toBe('Garden › Spring beds');
    const body = embed.querySelector('.kb-embed-body')!;
    expect(body.textContent).toContain('dig the beds');
    expect(body.textContent).not.toContain('water');
    // Its tick boxes, diagram editing and heading ids are its own note's, not this one's.
    const box = body.querySelector<HTMLInputElement>('input.kb-task-box')!;
    expect(box.disabled).toBe(true);
    expect(box.hasAttribute('data-task-line')).toBe(false);
    expect(body.querySelector('[data-action="edit-mermaid"]')).toBeNull();
    expect(body.querySelector('[id]')).toBeNull();
    expect(body.querySelector('[data-line]')).toBeNull();
    expect(get).not.toHaveBeenCalled();
  });

  it('fetches a note this device doesn’t have yet (decrypted here), once', async () => {
    note('far123456', 'Far away', null);
    const get = vi.spyOn(api, 'getNote').mockResolvedValue({ id: 'far123456', content: 'Fetched words' } as never);
    const div = rendered('![[Far away]] and again ![[Far away]]');
    await hydrateEmbeds(div, opts());
    expect([...div.querySelectorAll('.kb-embed-body')].map((b) => b.textContent!.trim())).toEqual(['Fetched words', 'Fetched words']);
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('stays a link when the note can’t be read (offline), is in the trash, or lacks the heading', async () => {
    note('off123456', 'Offline', null);
    note('gone12345', 'Trashed', 'text', { deleted_at: NOW });
    note('plan12345', 'Plan', '# Plan');
    vi.spyOn(api, 'getNote').mockRejectedValue(new TypeError('Failed to fetch'));
    const div = rendered('![[Offline]]\n\n![[Trashed]]\n\n![[Plan#Missing part]]');
    await hydrateEmbeds(div, opts());
    const [offline, trashed, plan] = [...div.querySelectorAll<HTMLElement>('span.kb-embed')];
    expect(offline.classList.contains('is-filled')).toBe(false);
    expect(offline.querySelector('a')!.textContent).toBe('Offline');
    expect(trashed.classList.contains('is-filled')).toBe(false);
    expect(plan.querySelector('.kb-embed-missing')!.textContent).toBe('There’s no heading “Missing part” in that note.');
  });

  it('never shows a note inside itself, nor goes round a loop, nor deeper than a few', async () => {
    note('a12345678', 'A', 'in A ![[B]]');
    note('b12345678', 'B', 'in B ![[A]]');
    const div = rendered('![[A]]');
    await hydrateEmbeds(div, opts(['host12345']));
    // A shows B, whose embed of A (already shown) stays a link.
    expect(div.querySelectorAll('.kb-embed.is-filled')).toHaveLength(2);
    expect(div.querySelector('.kb-embed.is-unshown')!.getAttribute('title')).toBe('This note is already shown here');

    note('self12345', 'Self', 'me ![[Self]]');
    const own = rendered('![[Self]]');
    await hydrateEmbeds(own, opts(['self12345']));
    expect(own.querySelector('.kb-embed.is-filled')).toBeNull();

    const chain = Array.from({ length: MAX_EMBED_DEPTH + 2 }, (_, i) => `n${i}00000000`);
    chain.forEach((id, i) => note(id, `N${i}`, i + 1 < chain.length ? `level ${i} ![[N${i + 1}]]` : 'bottom'));
    const deep = rendered('![[N0]]');
    await hydrateEmbeds(deep, opts());
    expect(deep.querySelectorAll('.kb-embed.is-filled')).toHaveLength(MAX_EMBED_DEPTH);
  });
});

describe('in reading view', () => {
  it('fills them in, keeps them through later changes, and never ticks the other note’s tasks here', async () => {
    note('chores123', 'Chores', '- [ ] water plants');
    const calls: number[] = [];
    const { container } = await mount(<Preview source={'Mine:\n\n- [ ] my task\n\n![[Chores]]'} noteId="host12345" onToggleTask={(l: number) => calls.push(l)} />);
    await settle(40);
    const filled = () => container.querySelector('.kb-embed.is-filled');
    expect(filled()!.textContent).toContain('water plants');
    await click(filled()!.querySelector('input.kb-task-box'));
    expect(calls).toEqual([]);
    await click(container.querySelector('input.kb-task-box'));
    expect(calls).toEqual([2]);
  });

  it('shows what the embedded note says now, once it changes', async () => {
    note('chores123', 'Chores', 'old words');
    const { container } = await mount(<Preview source="![[Chores]]" noteId="host12345" />);
    await settle(40);
    expect(container.querySelector('.kb-embed-body')!.textContent).toContain('old words');
    await act(async () => note('chores123', 'Chores', 'new words', { version: 2 }));
    await settle(40);
    expect(container.querySelector('.kb-embed-body')!.textContent).toContain('new words');
  });
});

describe('the preview on resting over a link', () => {
  async function hoverLink(link: Element) {
    await act(async () => {
      link.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    });
  }

  it('appears after a moment, with the note’s title and start, and goes when the pointer leaves', async () => {
    await setMedia('(hover: hover) and (pointer: fine)', true);
    note('garden1234', 'Garden', '# Garden\n\nBeds by the wall.');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { container } = await mount(<Preview source="See [[Garden]]." noteId="host12345" />);
    const link = container.querySelector('a.kb-wikilink')!;
    await hoverLink(link);
    expect(document.querySelector('.note-peek')).toBeNull();
    await act(async () => vi.advanceTimersByTime(500));
    vi.useRealTimers();
    await settle(30);
    const peek = document.querySelector<HTMLElement>('.note-peek')!;
    expect(peek.getAttribute('role')).toBe('tooltip');
    expect(peek.querySelector('.note-peek-title')!.textContent).toBe('Garden');
    expect(peek.textContent).toContain('Beds by the wall.');
    expect(link.getAttribute('aria-describedby')).toBe('note-peek');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    await act(async () => {
      link.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body }));
      vi.advanceTimersByTime(300);
    });
    expect(document.querySelector('.note-peek')).toBeNull();
    expect(link.hasAttribute('aria-describedby')).toBe(false);
  });

  it('doesn’t appear on a touch screen (a tap opens the note)', async () => {
    note('garden1234', 'Garden', 'Beds');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { container } = await mount(<Preview source="See [[Garden]]." />);
    await hoverLink(container.querySelector('a.kb-wikilink')!);
    await act(async () => vi.advanceTimersByTime(1000));
    expect(document.querySelector('.note-peek')).toBeNull();
  });
});
