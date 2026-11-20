/**
 * Comparing two versions of a note (version history, and Compare in a conflict): which lines changed,
 * which words changed within them, and folding what didn't, for empty, identical, unicode and large
 * texts.
 */
import { describe, expect, it } from 'vitest';
import { diffText, type Diff, type DiffFold, type DiffRow } from '../../src/lib/diff';
import { expectQuick } from './timing';

const plain = (rows: Diff['rows']) => rows.map((r) => (r.op === 'fold' ? `~${r.rows.length}` : `${r.op === 'same' ? ' ' : r.op === 'add' ? '+' : '-'}${r.text}`));
const unfold = (rows: Diff['rows']): DiffRow[] => rows.flatMap((r) => (r.op === 'fold' ? (r as DiffFold).rows : [r as DiffRow]));

/** Rebuilds both versions from a comparison: every line accounted for, in order. */
function sides(d: Diff) {
  const rows = unfold(d.rows);
  return {
    before: rows.filter((r) => r.op !== 'add').map((r) => r.text).join('\n'),
    after: rows.filter((r) => r.op !== 'del').map((r) => r.text).join('\n'),
  };
}

describe('comparing nothing with nothing, and a text with itself', () => {
  it('finds no change between two empty notes', () => {
    const d = diffText('', '')!;
    expect([d.added, d.removed]).toEqual([0, 0]);
    expect(unfold(d.rows).every((r) => r.op === 'same')).toBe(true);
  });

  it('folds an identical long note away completely', () => {
    const text = Array.from({ length: 500 }, (_, i) => `line ${i}`).join('\n');
    const d = diffText(text, text)!;
    expect([d.added, d.removed]).toEqual([0, 0]);
    expect(plain(d.rows)).toEqual(['~500']);
  });

  it('keeps a very short identical note open', () => {
    expect(plain(diffText('one', 'one')!.rows)).toEqual([' one']);
  });
});

describe('what counts as a change', () => {
  it('sees a newline added or removed at the end', () => {
    const d = diffText('a', 'a\n')!;
    expect([d.added, d.removed]).toEqual([1, 0]);
    expect(diffText('a\n', 'a')!.removed).toBe(1);
  });

  it('sees whitespace and line-ending changes as changes', () => {
    expect(diffText('a b', 'a  b')!.added).toBe(1);
    expect(diffText('a\nb', 'a\r\nb')).toMatchObject({ added: 1, removed: 1 });
  });

  it('lists a changed run’s removed lines before its added ones', () => {
    expect(plain(diffText('keep\nold 1\nold 2\nkeep too', 'keep\nnew 1\nnew 2\nnew 3\nkeep too')!.rows)).toEqual([
      ' keep',
      '-old 1',
      '-old 2',
      '+new 1',
      '+new 2',
      '+new 3',
      ' keep too',
    ]);
  });

  it('finds changes at the very start and the very end', () => {
    expect(plain(diffText('a\nb\nc', 'x\nb\ny')!.rows)).toEqual(['-a', '+x', ' b', '-c', '+y']);
  });

  it('handles a line moved from the top to the bottom', () => {
    const d = diffText('top\na\nb\nc', 'a\nb\nc\ntop')!;
    expect([d.added, d.removed]).toEqual([1, 1]);
  });

  it('accounts for every line of both versions, in order', () => {
    const before = 'title\n\n- a\n- b\n- c\n\nend\nfooter';
    const after = 'Title\n\n- a\n- c\n- d\n\nend\n\nfooter\nmore';
    const d = diffText(before, after)!;
    expect(sides(d)).toEqual({ before, after });
    expect(unfold(d.rows).filter((r) => r.op === 'add')).toHaveLength(d.added);
    expect(unfold(d.rows).filter((r) => r.op === 'del')).toHaveLength(d.removed);
  });
});

describe('words changed within a line', () => {
  it('marks only the changed word in unicode text', () => {
    const [del, add] = diffText('Café au lait 😀 ok', 'Café au chocolat 😀 ok')!.rows as DiffRow[];
    expect(del.parts?.filter((p) => p.changed).map((p) => p.text)).toEqual(['lait']);
    expect(add.parts?.filter((p) => p.changed).map((p) => p.text)).toEqual(['chocolat']);
  });

  it('marks a changed emoji or a CJK word on its own', () => {
    const [, add] = diffText('Mood: 😀 today', 'Mood: 😢 today')!.rows as DiffRow[];
    expect(add.parts?.filter((p) => p.changed).map((p) => p.text)).toEqual(['😢']);
    const [, cjk] = diffText('今日は 晴れ です', '今日は 雨 です')!.rows as DiffRow[];
    expect(cjk.parts?.filter((p) => p.changed).map((p) => p.text)).toEqual(['雨']);
  });

  it('puts the words of each side back together exactly', () => {
    const before = '- [ ] Buy **milk**, eggs & bread 📅 2026-11-20';
    const after = '- [x] Buy *oat milk*, eggs and bread 📅 2026-11-21';
    const [del, add] = diffText(before, after)!.rows as DiffRow[];
    expect(del.parts!.map((p) => p.text).join('')).toBe(before);
    expect(add.parts!.map((p) => p.text).join('')).toBe(after);
  });

  it('pairs lines in order when a run has more additions than removals', () => {
    const rows = diffText('a one\nb two', 'a ONE\nb TWO\nc three')!.rows as DiffRow[];
    expect(rows.map((r) => [r.op, !!r.parts])).toEqual([
      ['del', true],
      ['del', true],
      ['add', true],
      ['add', true],
      ['add', false],
    ]);
  });

  it('doesn’t mark words in very long lines', () => {
    const long = 'word '.repeat(500);
    const [del, add] = diffText(long, `${long}more`)!.rows as DiffRow[];
    expect(del.parts).toBeUndefined();
    expect(add.parts).toBeUndefined();
  });
});

describe('folding unchanged stretches', () => {
  const lines = (n: number, prefix = 'l') => Array.from({ length: n }, (_, i) => `${prefix}${i}`);

  it('keeps up to seven unchanged lines between two changes open', () => {
    const before = ['a', ...lines(7), 'b'].join('\n');
    const after = ['A', ...lines(7), 'B'].join('\n');
    expect(plain(diffText(before, after)!.rows).some((r) => r.startsWith('~'))).toBe(false);
  });

  it('folds eight or more, keeping three on each side', () => {
    const before = ['a', ...lines(8), 'b'].join('\n');
    const after = ['A', ...lines(8), 'B'].join('\n');
    expect(plain(diffText(before, after)!.rows)).toEqual(['-a', '+A', ' l0', ' l1', ' l2', '~2', ' l5', ' l6', ' l7', '-b', '+B']);
  });

  it('keeps no context before the first change at the top or after the last at the bottom', () => {
    const before = [...lines(10), 'x', ...lines(10, 'm')].join('\n');
    const after = [...lines(10), 'y', ...lines(10, 'm')].join('\n');
    expect(plain(diffText(before, after)!.rows)).toEqual(['~7', ' l7', ' l8', ' l9', '-x', '+y', ' m0', ' m1', ' m2', '~7']);
  });
});

describe('large notes', () => {
  it('compares a large note with many scattered changes', { retry: 2 }, () => {
    const before = Array.from({ length: 5000 }, (_, i) => `line ${i}`);
    const after = before.map((l, i) => (i % 10 === 0 ? `${l} edited` : l));
    const start = performance.now();
    const d = diffText(before.join('\n'), after.join('\n'))!;
    expectQuick(performance.now() - start, 1000);
    expect([d.added, d.removed]).toEqual([500, 500]);
    expect(sides(d)).toEqual({ before: before.join('\n'), after: after.join('\n') });
  });

  it('gives up quickly on two long notes with nothing in common', { retry: 2 }, () => {
    const a = Array.from({ length: 30_000 }, (_, i) => `a${i}`).join('\n');
    const b = Array.from({ length: 30_000 }, (_, i) => `b${i}`).join('\n');
    const start = performance.now();
    expect(diffText(a, b)).toBeNull();
    expectQuick(performance.now() - start, 1000);
  });

  it('stays quick on a long note made mostly of the same line, with a few hundred changes', { retry: 2 }, () => {
    // Every diagonal of the comparison has long runs of equal lines here: the costly shape for Myers' algorithm.
    const before = Array.from({ length: 20_000 }, (_, i) => (i % 97 === 0 ? `unique ${i}` : ''));
    const after = before.map((l, i) => (i % 97 === 0 ? `changed ${i}` : l));
    const start = performance.now();
    const d = diffText(before.join('\n'), after.join('\n'));
    expectQuick(performance.now() - start, 1500);
    if (d) expect(sides(d)).toEqual({ before: before.join('\n'), after: after.join('\n') });
  });

  it('stays quick near the edit limit when unchanged lines are all alike', { retry: 2 }, () => {
    // Lines removed in some places and others added elsewhere, among thousands of blank lines.
    const before = Array.from({ length: 30_000 }, (_, i) => (i % 43 === 0 ? `gone ${i}` : ''));
    const after = Array.from({ length: 30_000 }, (_, i) => (i % 43 === 21 ? `new ${i}` : ''));
    const start = performance.now();
    const d = diffText(before.join('\n'), after.join('\n'));
    expectQuick(performance.now() - start, 1500);
    if (d) expect(sides(d)).toEqual({ before: before.join('\n'), after: after.join('\n') });
  });

  it('accepts a change of exactly the edit limit and refuses one past it', () => {
    const a = Array.from({ length: 10 }, (_, i) => `a${i}`).join('\n');
    const b = Array.from({ length: 10 }, (_, i) => `b${i}`).join('\n');
    expect(diffText(a, b, 20)).not.toBeNull();
    expect(diffText(a, b, 19)).toBeNull();
  });
});
