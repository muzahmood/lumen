import { describe, expect, it } from 'vitest';
import { diffText, type DiffFold, type DiffRow } from '../../src/lib/diff';
import { expectQuick } from './timing';

const plain = (rows: Array<DiffRow | DiffFold>) => rows.map((r) => (r.op === 'fold' ? `~${r.rows.length}` : `${r.op === 'same' ? ' ' : r.op === 'add' ? '+' : '-'}${r.text}`));

describe('diffText', () => {
  it('finds added, removed and kept lines', () => {
    const d = diffText('a\nb\nc\nd', 'a\nc\nd\ne')!;
    expect(plain(d.rows)).toEqual([' a', '-b', ' c', ' d', '+e']);
    expect([d.added, d.removed]).toEqual([1, 1]);
  });

  it('says nothing changed when nothing did', () => {
    const d = diffText('same\ntext', 'same\ntext')!;
    expect([d.added, d.removed]).toEqual([0, 0]);
    expect(plain(d.rows)).toEqual(['~2']);
  });

  it('pairs a changed line with its new version and marks the words that changed', () => {
    const d = diffText('Buy milk and eggs', 'Buy oat milk and bread')!;
    const [del, add] = d.rows as DiffRow[];
    expect(del.parts).toEqual([
      { text: 'Buy milk and ', changed: false },
      { text: 'eggs', changed: true },
    ]);
    expect(add.parts).toEqual([
      { text: 'Buy ', changed: false },
      { text: 'oat ', changed: true },
      { text: 'milk and ', changed: false },
      { text: 'bread', changed: true },
    ]);
  });

  it('shows lines alike in nothing but punctuation as wholly changed', () => {
    const [del, add] = diffText('From the other device.', '![teal](/api/files/abc123def/teal.png)')!.rows as DiffRow[];
    expect(del.parts).toBeUndefined();
    expect(add.parts).toBeUndefined();
  });

  it('folds long unchanged stretches, keeping three lines around each change', () => {
    const before = Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n');
    const after = before.replace('line 15', 'line fifteen');
    const rows = plain(diffText(before, after)!.rows);
    expect(rows).toEqual(['~12', ' line 12', ' line 13', ' line 14', '-line 15', '+line fifteen', ' line 16', ' line 17', ' line 18', '~11']);
  });

  it('handles empty texts on either side', () => {
    expect(plain(diffText('', 'new')!.rows)).toEqual(['-', '+new']);
    expect(plain(diffText('old\nlines', '')!.rows)).toEqual(['-old', '-lines', '+']);
  });

  it('gives up on versions too different to compare quickly', () => {
    const a = Array.from({ length: 400 }, (_, i) => `a${i}`).join('\n');
    const b = Array.from({ length: 400 }, (_, i) => `b${i}`).join('\n');
    expect(diffText(a, b, 100)).toBeNull();
    expect(diffText(a, b)).not.toBeNull();
  });

  it('stays quick on a long note with a few changes', { retry: 2 }, () => {
    const before = Array.from({ length: 30_000 }, (_, i) => `paragraph ${i} with some words`).join('\n');
    const after = before.replace('paragraph 100 ', 'para 100 ').replace('paragraph 20000 ', 'p 20000 ') + '\nthe end';
    const start = performance.now();
    const d = diffText(before, after)!;
    expectQuick(performance.now() - start, 500);
    expect([d.added, d.removed]).toEqual([3, 2]);
  });
});
