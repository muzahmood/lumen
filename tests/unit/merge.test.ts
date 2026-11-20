/**
 * Combining a note's edits from two devices (merge3 in src/lib/diff.ts): line by line, both sets kept
 * when they touch different lines, and nothing combined (null, for the person to choose) when they
 * touch the same ones or it isn't clear which would go first.
 */
import { describe, expect, it } from 'vitest';
import { merge3 } from '../../src/lib/diff';

const lines = (...l: string[]) => l.join('\n');

describe('merge3', () => {
  const base = lines('# Trip', '', 'Flights booked', '', '- passport', '- charger', '', 'Notes');

  it('keeps changes to different lines from both sides', () => {
    const mine = lines('# Trip to Lisbon', '', 'Flights booked', '', '- passport', '- charger', '', 'Notes');
    const theirs = lines('# Trip', '', 'Flights booked', '', '- passport', '- charger', '', 'Notes: hotel by the river');
    expect(merge3(base, mine, theirs)).toBe(lines('# Trip to Lisbon', '', 'Flights booked', '', '- passport', '- charger', '', 'Notes: hotel by the river'));
  });

  it('keeps lines added on one side and removed on the other, when they’re apart', () => {
    const mine = lines('# Trip', '', 'Flights booked', '', '- passport', '- charger', '- sunscreen', '', 'Notes');
    const theirs = lines('# Trip', '', '', '- passport', '- charger', '', 'Notes');
    expect(merge3(base, mine, theirs)).toBe(lines('# Trip', '', '', '- passport', '- charger', '- sunscreen', '', 'Notes'));
  });

  it('keeps changes on lines next to each other', () => {
    expect(merge3(lines('a', 'b', 'c'), lines('A', 'b', 'c'), lines('a', 'B', 'c'))).toBe(lines('A', 'B', 'c'));
  });

  it('counts a change both sides made the same way once', () => {
    const both = lines('# Trip', '', 'Flights and hotel booked', '', '- passport', '- charger', '', 'Notes');
    const theirs = lines('# Trip', '', 'Flights and hotel booked', '', '- passport', '- charger', '', 'Notes, more');
    expect(merge3(base, both, theirs)).toBe(lines('# Trip', '', 'Flights and hotel booked', '', '- passport', '- charger', '', 'Notes, more'));
  });

  it('takes the other side whole when one side changed nothing', () => {
    const theirs = lines('Completely', 'different');
    expect(merge3(base, base, theirs)).toBe(theirs);
    expect(merge3(base, theirs, base)).toBe(theirs);
    expect(merge3(base, theirs, theirs)).toBe(theirs);
  });

  it('won’t combine two different changes to the same line', () => {
    expect(merge3(base, base.replace('Flights booked', 'Flights booked for May'), base.replace('Flights booked', 'Flights cancelled'))).toBeNull();
  });

  it('won’t combine lines added at the same place, as which goes first isn’t known', () => {
    expect(merge3('a\nb\n', 'a\nb\nmine\n', 'a\nb\ntheirs\n')).toBeNull();
  });

  it('won’t combine lines added right where the other side changed a line', () => {
    expect(merge3(lines('a', 'b', 'c'), lines('a', 'new', 'b', 'c'), lines('a', 'B', 'c'))).toBeNull();
  });

  it('won’t combine a line removed on one side with a change to it on the other', () => {
    expect(merge3(lines('a', 'b', 'c'), lines('a', 'c'), lines('a', 'b, edited', 'c'))).toBeNull();
  });

  it('works on notes with no line breaks, and empty ones', () => {
    expect(merge3('', 'mine', '')).toBe('mine');
    expect(merge3('one line', 'one line, mine', 'one line, theirs')).toBeNull();
  });

  it('gives up (null) rather than make the page wait when the versions differ too much', () => {
    const big = Array.from({ length: 400 }, (_, i) => `line ${i}`);
    const mine = big.map((l, i) => (i % 2 ? `${l} mine` : l)).join('\n');
    const theirs = big.map((l, i) => (i % 2 ? l : `${l} theirs`)).join('\n');
    expect(merge3(big.join('\n'), mine, theirs, 50)).toBeNull();
    // Within the limit, the same edits (every other line, never the same one) combine.
    expect(merge3(big.join('\n'), mine, theirs)).toBe(big.map((l, i) => (i % 2 ? `${l} mine` : `${l} theirs`)).join('\n'));
  });
});
