/**
 * The note-text helpers shared by the Worker and the app (shared/noteText.ts) on what people really
 * write: titles and tags with odd whitespace, previews of notes full of Markdown and math, task
 * counts that must agree with the Tasks view, and links that must leave code alone.
 */
import { describe, expect, it } from 'vitest';
import { cleanTags, cleanTitle, makeExcerpt, makeInfo, makeLinks, outsideCode, texToText } from '../../shared/noteText';
import { parseTasks } from '../../src/lib/tasks';
import { expectQuick } from './timing';

const info = (md: string) => JSON.parse(makeInfo(md)) as { th?: string; t?: [number, number]; d?: number; dr?: number; w?: number };
const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

describe('titles', () => {
  it('turns every kind of line break and tab into one space', () => {
    expect(cleanTitle('Plan\r\n\r\nfor\t\tMonday\rnow')).toBe('Plan for Monday now');
  });

  it('keeps emoji, accents and right-to-left text as typed', () => {
    expect(cleanTitle('  ☕ Café notes — بیاض  ')).toBe('☕ Café notes — بیاض');
  });

  it('gives an empty title for anything that isn’t text', () => {
    for (const v of [null, undefined, 5, {}, ['a'], true]) expect(cleanTitle(v)).toBe('');
  });

  it('never cuts an emoji in half at the length limit', () => {
    const title = cleanTitle(`${'a'.repeat(299)}😀 more`);
    expect(title).not.toMatch(loneSurrogate);
    expect(title.length).toBeLessThanOrEqual(300);
  });
});

describe('tags', () => {
  it('turns inner spaces into dashes and drops leading #s', () => {
    expect(cleanTags(['##deep work', 'a\tb', 'x\ny'])).toEqual(['deep-work', 'a-b', 'x-y']);
  });

  it('keeps the first spelling of tags that differ only in case', () => {
    expect(cleanTags(['Work', 'work', 'WORK', 'Home'])).toEqual(['Work', 'Home']);
  });

  it('keeps nested tags and unicode as they are', () => {
    expect(cleanTags(['work/clients', 'café', '日本'])).toEqual(['work/clients', 'café', '日本']);
  });

  it('skips tags that are nothing but # signs', () => {
    expect(cleanTags(['#', '###', 'ok'])).toEqual(['ok']);
  });

  it('ignores spaces around a tag rather than turning them into dashes', () => {
    expect(cleanTags([' work ', '# home', 'deep work\t'])).toEqual(['work', 'home', 'deep-work']);
  });
});

describe('previews of formatted notes', () => {
  it('reads links, embeds and wiki-links as their words', () => {
    expect(makeExcerpt('See [the docs](https://x.test/a) and [[Plan#Next steps|the plan]] and [[Roadmap#Q1]] ![pic](/api/files/abc/p.png)')).toBe(
      'See the docs and the plan and Roadmap',
    );
  });

  it('drops headings, quotes, list and task markers, and rules', () => {
    expect(makeExcerpt('## Heading\n> quoted\n* star\n+ plus\n2) two\n- [x] done task\n***\n___\nend')).toBe('Heading quoted star plus two done task end');
  });

  it('drops callout markers of every kind, folded or not', () => {
    expect(makeExcerpt('> [!warning]- Careful\n> body\n> [!tip]+ Hint')).toBe('Careful body Hint');
  });

  it('leaves out code blocks, including one never closed', () => {
    expect(makeExcerpt('before\n```js\nsecret()\n```\nafter')).toBe('before after');
    expect(makeExcerpt('before\n```\nall the rest is code')).toBe('before');
  });

  it('leaves out display math and reads inline math as text', () => {
    expect(makeExcerpt('Area $\\pi r^2$ and $$\\int_0^1 x\\,dx$$ then $a_{ij}$ and $\\sqrt{2}$')).toBe('Area π r² and then a_(ij) and √2');
  });

  it('keeps prices and escaped dollars as text', () => {
    expect(makeExcerpt('Lunch $5, dinner $12.50 and $ 3 $')).toBe('Lunch $5, dinner $12.50 and $ 3 $');
    expect(makeExcerpt('a$x$b')).toBe('a$x$b');
  });

  it('never runs longer than 240 characters', () => {
    expect(makeExcerpt(`# ${'long words here '.repeat(100)}`).length).toBeLessThanOrEqual(240);
  });

  it('drops single-star and underscore emphasis but keeps stars used as text', () => {
    expect(makeExcerpt('An *important* idea and _this_ too')).toBe('An important idea and this too');
    expect(makeExcerpt('2 * 3 = 6 and snake_case_name')).toBe('2 * 3 = 6 and snake_case_name');
  });

  it('shows a table by its cells, without pipes or the delimiter row', () => {
    expect(makeExcerpt('| Item | Qty |\n| --- | ---: |\n| Eggs | 12 |')).toBe('Item Qty Eggs 12');
  });

  it('keeps words between a less-than and a greater-than sign that aren’t an HTML tag', () => {
    expect(makeExcerpt('If x < 5 and y > 3 then stop')).toBe('If x < 5 and y > 3 then stop');
    expect(makeExcerpt('Returns `Vec<String>` here')).toBe('Returns Vec<String> here');
    expect(makeExcerpt('Text <b>bold</b> <br/> <!-- note --> end')).toBe('Text bold end');
  });

  it('leaves out code in tilde fences too', () => {
    expect(makeExcerpt('before\n~~~\nsecret()\n~~~\nafter')).toBe('before after');
  });

  it('reads backslash escapes as the characters they escape', () => {
    expect(makeExcerpt('Costs \\$5 \\*not bold\\* and 1\\. step')).toBe('Costs $5 *not bold* and 1. step');
  });

  it('never ends a preview on half an emoji', () => {
    expect(makeExcerpt(`${'a'.repeat(239)}😀😀`)).not.toMatch(loneSurrogate);
  });
});

describe('formulas as text', () => {
  it('raises and lowers what Unicode can, and brackets the rest', () => {
    expect(texToText('x^{10} + y_{n+1} + e^{-x} + a_{ij}')).toBe('x¹⁰ + y_(n+1) + e^(-x) + a_(ij)');
    expect(texToText('x^n_2')).toBe('xⁿ₂');
  });

  it('turns Greek letters and symbols into characters and leaves unknown commands as words', () => {
    expect(texToText('\\alpha \\leq \\Omega \\neq \\infty \\foo')).toBe('α ≤ Ω ≠ ∞ foo');
  });

  it('drops sizing and font commands, keeping their contents', () => {
    expect(texToText('\\left( \\mathbb{R} \\right) \\text{if } x \\displaystyle')).toBe('( R ) if x');
  });

  it('spells out a fraction with a root inside it', () => {
    const text = texToText('\\frac{1}{\\sqrt{2}}');
    expect(text).not.toMatch(/frac/);
    expect(text).toMatch(/^1\/\(?√2\)?$/);
  });
});

describe('summaries for the note list', () => {
  it('takes the first image or drawing that isn’t video or audio as the thumbnail', () => {
    expect(info('![a](/api/files/abc123/a.MP3)\n![b](/api/files/abc124/b.webm)\n![d](/api/drawings/dr123.svg)\n![c](/api/files/abc125/c.jpg)').th).toBe('/api/drawings/dr123.svg');
    expect(info('![c](/api/files/abc125)').th).toBe('/api/files/abc125');
  });

  it('never takes a thumbnail from another website or a different part of this one', () => {
    expect(info('![x](https://example.com/a.png)\n![y](/api/notes/x)\n![z](/api/files/abc/a/b.png)').th).toBeUndefined();
  });

  it('counts mermaid diagrams, indented or with more backticks, and drawings each time they appear', () => {
    expect(info('```mermaid\na\n```\n  ````mermaid\nb\n````\n```js\nmermaid\n```').d).toBe(2);
    expect(info('![d](/api/drawings/abc123.svg) ![d](/api/drawings/abc123.svg)').dr).toBe(2);
  });

  it('counts words but not code, images, or a ticked box’s x', () => {
    expect(info("Don't stop — it’s 3 o'clock\n```\nnot counted here\n```\n![alt words](/api/files/abc/p.png)").w).toBe(5);
  });

  it('leaves out what a note doesn’t have', () => {
    expect(makeInfo('')).toBe('{}');
    expect(makeInfo('   \n\n')).toBe('{}');
  });
});

describe('task counts agree with the Tasks view on generated notes', () => {
  // A small deterministic generator, so a failure always reproduces.
  let seed = 12345;
  const rand = (n: number) => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed % n;
  };
  const pieces = ['- ', '* ', '+ ', '1. ', '12) ', '> ', '>', '\t', ' ', '  ', '    ', '[ ]', '[x]', '[X]', '[  ]', 'word', ' ', '```', '~~~', '````', '📅 2026-01-01', '-', ''];
  const line = () => Array.from({ length: 1 + rand(6) }, () => pieces[rand(pieces.length)]).join('');

  it('counts the same tasks the view lists, for 3,000 random notes', () => {
    for (let n = 0; n < 3000; n++) {
      const md = Array.from({ length: 1 + rand(8) }, line).join('\n');
      const tasks = parseTasks(md);
      const expected = tasks.length ? [tasks.filter((t) => t.done).length, tasks.length] : undefined;
      expect(info(md).t, JSON.stringify(md)).toEqual(expected);
    }
  });
});

describe('links a note makes', () => {
  it('finds wiki-links with headings, aliases and spaces, once each, lower case', () => {
    expect(makeLinks('[[ Plan ]] [[plan#Q1]] [[PLAN|the plan]] [[Plan#Q2|alias]] [[Other]]').w).toEqual(['plan', 'other']);
  });

  it('finds embeds as links too', () => {
    expect(makeLinks('![[Diagram note]]').w).toEqual(['diagram note']);
  });

  it('ignores empty, multi-line and over-long link targets', () => {
    expect(makeLinks(`[[ ]] [[a\nb]] [[${'x'.repeat(301)}]]`).w).toEqual([]);
  });

  it('finds note ids in Markdown links, with or without a heading or query', () => {
    expect(makeLinks('[a](/note/abc123XYZ) [b](/note/abc123XYZ#h-x) [c](/note/def456_-z?x=1) [short](/note/abc)').n).toEqual(['abc123XYZ', 'def456_-z']);
  });

  it('leaves out links in code spans of any length, fences of either kind and fences indented up to three spaces', () => {
    const md = ['`[[A]]` ``[[B]]`` ```[[C]]```', '', '~~~', '[[D]]', '~~~', '   ```', '[[E]]', '   ```', '[[Real]]'].join('\n');
    expect(makeLinks(md).w).toEqual(['real']);
  });

  // The fence lines aren't seen as a fence here, but their backtick runs pair up as a code span within the quote.
  it('leaves out links in a code block inside a quote or callout', () => {
    expect(makeLinks('> [!example] Linking\n> ```md\n> [[Example only]]\n> ```\n\n[[Real]]').w).toEqual(['real']);
  });
});

describe('outside code', () => {
  it('hands each piece of prose and code to its own function, keeping the text whole', () => {
    const src = 'a `b` c\n\n```\nd\n```\ne ``f`` g';
    const prose: string[] = [];
    const code: string[] = [];
    const out = outsideCode(
      src,
      (p) => {
        prose.push(p);
        return p;
      },
      (c) => {
        code.push(c);
        return c;
      },
    );
    expect(out).toBe(src);
    expect(code).toEqual(['`b`', '```', 'd', '```', '``f``']);
    expect(prose.join('|')).toBe('a | c\n|e | g');
  });

  it('pairs a code span only with a run of exactly as many backticks', () => {
    expect(outsideCode('x ``a ` b`` y `c` z', (p) => p.toUpperCase())).toBe('X ``a ` b`` Y `c` Z');
  });

  it('lets a heading end an unclosed code span', () => {
    expect(outsideCode('a ` b\n# [[H]]\nc ` d', (p) => p.replace(/\[\[H\]\]/, '[[X]]'))).toBe('a ` b\n# [[X]]\nc ` d');
  });
});

describe('cost on more hostile input', () => {
  const cases: Array<[string, string]> = [
    ['many dollar signs', '$'.repeat(60_000)],
    ['many short formulas never closed', ' $a'.repeat(30_000)],
    ['deeply nested braces in a formula', `$${'{'.repeat(3000)}x${'}'.repeat(3000)}$`],
    ['many fraction commands', `$${'\\frac{'.repeat(2000)}$`],
    ['many callout openers on one line', `> ${'[!'.repeat(20_000)}`],
    ['task boxes without list markers', '[ ] '.repeat(20_000)],
    ['thumbnail openers', '![x](/api/files/'.repeat(5_000)],
    ['drawing paths', '/api/drawings/'.repeat(10_000)],
    ['a very long single word', 'a'.repeat(200_000)],
    ['many headings with lone backticks', '# `\n'.repeat(20_000)],
    ['note ids without an end', '/note/'.repeat(20_000)],
  ];
  for (const [name, md] of cases) {
    it(`stays linear on ${name}`, { retry: 2 }, () => {
      const start = performance.now();
      makeInfo(md);
      makeExcerpt(md);
      makeLinks(md);
      expectQuick(performance.now() - start, 150);
    });
  }
});
