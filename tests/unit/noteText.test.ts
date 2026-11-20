/** Note text helpers shared by the Worker and the app: titles, tags, list previews and summaries. */
import { describe, expect, it } from 'vitest';
import { cleanTags, cleanTitle, makeExcerpt, makeInfo, makeLinks, texToText } from '../../shared/noteText';
import { expectQuick } from './timing';

describe('cleanTitle', () => {
  it('flattens whitespace, trims and caps', () => {
    expect(cleanTitle('  a\r\nb\tc  ')).toBe('a b c');
    expect(cleanTitle('x'.repeat(400))).toHaveLength(300);
    expect(cleanTitle(42)).toBe('');
  });
});

describe('cleanTags', () => {
  it('strips #, joins words, dedupes case-insensitively and caps', () => {
    expect(cleanTags(['#a', 'A', 'b c', '', null, 'x'.repeat(70)])).toEqual(['a', 'b-c', 'x'.repeat(60)]);
    expect(cleanTags(Array.from({ length: 50 }, (_, i) => `t${i}`))).toHaveLength(40);
    expect(cleanTags('nope')).toEqual([]);
  });
});

describe('makeExcerpt', () => {
  it('reduces Markdown to plain text', () => {
    const md = '# Title\n\n> [!tip] Callout\n- [ ] task\n1. item\n\n```js\ncode()\n```\n\n$$x^2$$\n\n![img](/a.png) [link](https://x) [[Note|alias]] [[Other#h]] <b>html</b> **bold** ==hl==\n\n---\n';
    expect(makeExcerpt(md)).toBe('Title Callout task item link alias Other html bold hl');
  });

  it('caps the preview length', () => {
    expect(makeExcerpt('word '.repeat(1000)).length).toBeLessThanOrEqual(240);
  });
});

describe('formulas in previews', () => {
  it('shows inline math as readable text, and leaves prices alone', () => {
    expect(makeExcerpt('Euler: $e^{i\\pi}+1=0$, area $\\pi r^2$, costs $5 and $10.')).toBe('Euler: e^(iπ)+1=0, area π r², costs $5 and $10.');
  });

  it('spells out fractions, roots, indices and symbols', () => {
    expect(texToText('\\frac{a+b}{2} \\le \\sqrt{x_1} \\cdot \\alpha')).toBe('(a+b)/2 ≤ √(x₁) · α');
    expect(texToText('\\sum_{i=1}^{n} x_i \\to \\infty')).toBe('∑_(i=1)ⁿ x_i → ∞');
  });
});

describe('makeInfo', () => {
  it('summarises thumbnail, tasks, diagrams, drawings and words', () => {
    const md = [
      '![v](/api/files/abcdef/clip.mp4)',
      '![p](/api/files/abcdef12/photo.png)',
      '- [x] one',
      '  * [ ] two',
      '```mermaid',
      'graph TD',
      '```',
      '![d](/api/drawings/drawing1.svg)',
      'Three more words',
    ].join('\n');
    expect(JSON.parse(makeInfo(md))).toEqual({ th: '/api/files/abcdef12/photo.png', t: [1, 2], d: 1, dr: 1, im: 1, w: expect.any(Number) });
  });

  it('never takes a thumbnail that climbs out of /api/files/ with ../', () => {
    const md = '![x](/api/files/abcdef/../../../cdn-cgi/access/logout)\n![y](/api/files/abcdef/a/../../x)';
    expect(JSON.parse(makeInfo(md)).th).toBeUndefined();
  });

  it('does not count a fence and "mermaid" on different lines as a diagram', () => {
    expect(JSON.parse(makeInfo('```\nmermaid\n```')).d).toBeUndefined();
  });

  it('counts tasks as the Tasks view does: numbered and quoted too, never inside code', () => {
    const md = '1. [ ] a\n2) [x] b\n> - [ ] c\n- [ ]\n```\n- [ ] not a task\n```\n- see [ ] here\n-[ ] tight';
    // a, b, c: the empty "- [ ]" isn't a task.
    expect(JSON.parse(makeInfo(md)).t).toEqual([1, 3]);
    expect(JSON.parse(makeInfo('no tasks here')).t).toBeUndefined();
  });
});

describe('code spans', () => {
  it('end with their paragraph, so lone backticks far apart hide nothing between them', () => {
    const md = 'Press the ` key.\n\n[[Project A]] and [x](/note/abc123XYZ)\n\n# A heading with `\n\nLater, another ` here.';
    expect(makeLinks(md)).toEqual({ n: ['abc123XYZ'], w: ['project a'] });
    // Within a paragraph a span can still run over a line break.
    expect(makeLinks('a `code\n[[Hidden]]` b')).toEqual({ n: [], w: [] });
  });
});

describe('makeLinks', () => {
  it('collects note ids and wiki-link targets, as backlinks match them', () => {
    const md = 'See [a](/note/abc123XYZ) and [b](/note/abc123XYZ#h), [[Garden Plan]], [[ garden plan |alias]], [[Other#Section]] and [[]] or [[bad\nlink]].';
    expect(makeLinks(md)).toEqual({ n: ['abc123XYZ'], w: ['garden plan', 'other'] });
  });

  it('stays bounded on a note made of links', () => {
    const many = Array.from({ length: 2000 }, (_, i) => `[[Title number ${i}]] /note/id${String(i).padStart(6, '0')}`).join(' ');
    const links = makeLinks(many);
    expect(links.n.length).toBeLessThanOrEqual(500);
    expect(links.w.length).toBeLessThanOrEqual(500);
  });

  it('leaves out links written inside code', () => {
    const md = [
      'Real [[Kept]] and /note/keep123456.',
      '',
      '```',
      '[[In Fence]] /note/fence12345',
      '```',
      '',
      'Inline `[[In Span]]` and ``[[Double]] ` `` but ` lone [[After Lone]].',
    ].join('\n');
    expect(makeLinks(md)).toEqual({ n: ['keep123456'], w: ['kept', 'after lone'] });
  });
});

describe('cost on hostile input', () => {
  // These run inside the Worker on every save, under a CPU limit of a few milliseconds; patterns that
  // rescan runs of blank lines took over half a second on 20 KB.
  const cases: Array<[string, string]> = [
    ['blank lines', 'x\n' + '\n'.repeat(50_000) + 'y'],
    ['space-only lines', 'a\n' + ' \n'.repeat(30_000)],
    ['tab lines', '\t\n'.repeat(30_000)],
    ['unclosed fences', '```\n'.repeat(5_000)],
    ['backtick runs of growing length', Array.from({ length: 1500 }, (_, i) => `${'`'.repeat(i + 1)} x `).join('')],
    ['image openers', '!['.repeat(20_000)],
    ['link openers', '['.repeat(40_000)],
    ['wiki openers', '[['.repeat(20_000)],
    ['unclosed link targets', '[x]('.repeat(10_000)],
    ['unclosed tags', '<a'.repeat(20_000)],
    ['unclosed callouts', '> [!x\n'.repeat(10_000)],
    ['long digit runs', '1'.repeat(40_000) + '\n'],
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
