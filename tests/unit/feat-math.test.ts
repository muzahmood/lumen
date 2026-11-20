/**
 * Where the editor finds math (src/lib/mathSyntax.ts), by reading view's rules: $…$ inline unless it
 * reads as prices, \$ for a dollar sign, $$…$$ inline as display math, $$ blocks over several lines and
 * ```math fences, never inside other code.
 */
import { describe, expect, it } from 'vitest';
import { findMathBlocks, scanInlineMath } from '../../src/lib/mathSyntax';
import { expectQuick } from './timing';

const tex = (line: string) => scanInlineMath(line).map((m) => [m.tex, m.display]);
const blocks = (text: string) => {
  const lines = text.split('\n');
  return findMathBlocks((n) => lines[n - 1], lines.length);
};

describe('inline formulas', () => {
  it('finds each formula in a line with its offsets', () => {
    const line = 'a $x^2$ and $\\alpha$.';
    expect(scanInlineMath(line)).toEqual([
      { from: 2, to: 7, tex: 'x^2', display: false },
      { from: 12, to: 20, tex: '\\alpha', display: false },
    ]);
    for (const m of scanInlineMath(line)) expect(line.slice(m.from, m.to)).toBe(`$${m.tex}$`);
  });

  it('leaves prices alone', () => {
    for (const line of ['$5 and $10', 'costs $5.99, or $10', 'from $5 to $10 each', 'pay $1,000 and $2,000']) expect(tex(line), line).toEqual([]);
  });

  it('needs the dollar signs to stand apart from letters and digits', () => {
    expect(tex('a$x$ and $y$b')).toEqual([]);
    expect(tex('($x$), [$y$]; "$z$"')).toEqual([
      ['x', false],
      ['y', false],
      ['z', false],
    ]);
  });

  it('reads \\$ as a dollar sign, outside a formula and inside one', () => {
    expect(tex('\\$x$ and \\$5')).toEqual([]);
    expect(tex('$a \\$ b$')).toEqual([['a \\$ b', false]]);
    expect(tex('$a\\\\$ b')).toEqual([['a\\\\', false]]);
  });

  it('reads $$…$$ within a line as display math', () => {
    expect(tex('so $$E=mc^2$$ holds')).toEqual([['E=mc^2', true]]);
    expect(tex('$$a$$ and $b$')).toEqual([
      ['a', true],
      ['b', false],
    ]);
  });

  it('finds nothing in empty or unclosed dollars', () => {
    for (const line of ['$', '$$', '$$$$', '$x', 'x$', '$$x', '']) expect(tex(line), line).toEqual([]);
  });

  it('stays quick on a line full of dollar signs and backslashes', { retry: 2 }, () => {
    const lines = ['$'.repeat(100_000), ' $a'.repeat(50_000), `$${'\\$'.repeat(50_000)}`, '$$ \\$$'.repeat(20_000)];
    const start = performance.now();
    for (const line of lines) scanInlineMath(line);
    expectQuick(performance.now() - start, 300);
  });
});

describe('formula blocks', () => {
  it('finds a $$ block over several lines, and one on a single line', () => {
    expect(blocks('intro\n$$\n\\int_0^1 x\\,dx\n$$\nafter\n$$x^2$$')).toEqual([
      { start: 2, end: 4, tex: '\\int_0^1 x\\,dx' },
      { start: 6, end: 6, tex: 'x^2' },
    ]);
  });

  it('keeps formula text written on the opening and closing lines', () => {
    expect(blocks('$$ a +\nb\n= c $$')).toEqual([{ start: 1, end: 3, tex: ' a +\nb\n= c ' }]);
  });

  it('finds ```math and ~~~math fences', () => {
    expect(blocks('```math\na\n```\n~~~ Math \nb\n~~~')).toEqual([
      { start: 1, end: 3, tex: 'a' },
      { start: 4, end: 6, tex: 'b' },
    ]);
  });

  it('never finds math inside another code block', () => {
    expect(blocks('```\n$$\nx\n$$\n```\n````md\n```math\ny\n```\n````')).toEqual([]);
  });

  it('leaves a $$ block that never closes as text', () => {
    expect(blocks('$$\nx\nno end')).toEqual([]);
    // …and carries on finding the blocks after it.
    expect(blocks('$$\nx\nno end\n```math\ny\n```')).toEqual([{ start: 4, end: 6, tex: 'y' }]);
  });

  it('treats a line with several $$ as inline display math, not a block', () => {
    expect(blocks('$$a$$ and $$b$$')).toEqual([]);
  });

  it('stays quick on many lines of dollar signs and fences', { retry: 2 }, () => {
    const text = ['$$\n'.repeat(20_000), '```x\n'.repeat(20_000), '$$ a\n'.repeat(20_000)].join('');
    const start = performance.now();
    blocks(text);
    expectQuick(performance.now() - start, 500);
  });
});
