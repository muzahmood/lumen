import { describe, expect, it } from 'vitest';
import { linksTo, outsideCode, relinkText } from '../../src/lib/wikilinks';

describe('relinkText', () => {
  it('moves plain, labelled and heading links to the new title, in any case', () => {
    const src = 'See [[Roadmap]], [[roadmap|the plan]] and [[ Roadmap #Later]].';
    expect(relinkText(src, 'Roadmap', 'Plan 2027')).toBe('See [[Plan 2027]], [[Plan 2027|the plan]] and [[Plan 2027#Later]].');
  });

  it('leaves other notes’ links alone, including ones that start the same way', () => {
    const src = '[[Roadmap 2]] [[Road]] [[Roadmapping]] [[Roadmap]]';
    expect(relinkText(src, 'Roadmap', 'Plan')).toBe('[[Roadmap 2]] [[Road]] [[Roadmapping]] [[Plan]]');
  });

  it('never touches code blocks or code spans', () => {
    const src = 'Use [[A]].\n\n```md\n[[A]]\n```\n\nInline `[[A]]` and ``[[A]] ` `` then [[A]].\n~~~\n[[A]]\n~~~';
    expect(relinkText(src, 'A', 'B')).toBe('Use [[B]].\n\n```md\n[[A]]\n```\n\nInline `[[A]]` and ``[[A]] ` `` then [[B]].\n~~~\n[[A]]\n~~~');
  });

  it('treats regex characters in titles as text, and $ in the new title literally', () => {
    expect(relinkText('[[C++ (notes)]] [[Cxx (notes)]]', 'C++ (notes)', 'Costs $& $1')).toBe('[[Costs $& $1]] [[Cxx (notes)]]');
  });

  it('keeps an unclosed fence from swallowing links before it', () => {
    expect(relinkText('[[A]]\n```\n[[A]]', 'A', 'B')).toBe('[[B]]\n```\n[[A]]');
  });
});

describe('linksTo', () => {
  it('finds a link outside code only', () => {
    expect(linksTo('x [[Plan|label]]', 'plan')).toBe(true);
    expect(linksTo('`[[Plan]]`', 'Plan')).toBe(false);
    expect(linksTo('[[Planning]]', 'Plan')).toBe(false);
    expect(linksTo('first [[A]] then [[A]]', 'A')).toBe(true);
  });
});

describe('outsideCode', () => {
  it('passes everything else through unchanged', () => {
    const src = 'a `b` c\n```\nd\n```\ne';
    expect(outsideCode(src, (p) => p.toUpperCase())).toBe('A `b` C\n```\nd\n```\nE');
  });
});
