import { describe, expect, it } from 'vitest';
import { findMentions, linkMention, mentionPattern, proseMask, snippetAround } from '../../src/lib/mentions';
import { expectQuick } from './timing';

const found = (text: string, title: string) => findMentions(text, title).map((m) => text.slice(m.start, m.end));

describe('findMentions', () => {
  it('finds a title as whole words, in any case and with any spacing on one line', () => {
    expect(found('The garden plan is due. Garden  Plan again. My garden planner no.', 'Garden plan')).toEqual(['garden plan', 'Garden  Plan']);
    // Not across a line break: the link would have to hold it (and two paragraphs would merge).
    expect(found('the Garden\n\nPlan for spring, the Garden\nplan', 'Garden plan')).toEqual([]);
  });

  it('stays quick on long lines of unclosed brackets', { retry: 2 }, () => {
    const start = performance.now();
    found(`${'[a '.repeat(40_000)} ${'a<'.repeat(40_000)} garden plan`, 'Garden plan');
    expectQuick(performance.now() - start, 1500);
  });

  it('skips code, links, web addresses and HTML', () => {
    const text = [
      'Linked [[Garden plan]] and [[x|Garden plan]] and [Garden plan](/note/abc123def).',
      '`Garden plan` in code, https://example.com/Garden-plan, <span title="Garden plan">x</span>',
      '```',
      'Garden plan in a block',
      '```',
      'But this Garden plan counts.',
    ].join('\n');
    expect(found(text, 'Garden plan')).toEqual(['Garden plan']);
    expect(findMentions(text, 'Garden plan')[0].start).toBe(text.lastIndexOf('Garden plan'));
  });

  it('keeps every offset when blanking things out', () => {
    const text = 'a `code` [[b]] [c](d) e\n```\nf\n```\ng';
    expect(proseMask(text)).toHaveLength(text.length);
  });

  it('makes no mentions of titles too short or unlinkable', () => {
    expect(mentionPattern('AI')).toBeNull();
    expect(mentionPattern('C# notes')).toBeNull();
    expect(mentionPattern('Ideas')).not.toBeNull();
    expect(findMentions('My ideas, ideas.', 'Ideas')).toHaveLength(2);
  });

  it('treats regex characters in titles as text', () => {
    expect(found('Learning C++ (basics) today', 'C++ (basics)')).toEqual(['C++ (basics)']);
  });
});

describe('linkMention', () => {
  it('links a mention, keeping how it was written', () => {
    const text = 'See the garden plan, and the Garden plan.';
    const [first, second] = findMentions(text, 'Garden plan');
    expect(linkMention(text, 'Garden plan', first)).toBe('See the [[Garden plan|garden plan]], and the Garden plan.');
    expect(linkMention(text, 'Garden plan', second)).toBe('See the garden plan, and the [[Garden plan]].');
  });
});

describe('snippetAround', () => {
  it('shows the mention within its paragraph, formatting dropped', () => {
    const text = 'First paragraph.\n\nWe **must** finish the Garden plan before [[May]] ends.\n\nNext.';
    const [m] = findMentions(text, 'Garden plan');
    expect(snippetAround(text, m)).toEqual({ before: 'We must finish the ', match: 'Garden plan', after: ' before May ends.' });
  });
});
