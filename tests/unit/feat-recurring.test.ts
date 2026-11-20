/**
 * Completion dates and repeating tasks (src/lib/tasks.ts), in Obsidian Tasks' syntax: a ticked task
 * gets the day it was ticked (✅ 2026-11-20); one that repeats (🔁 every week) comes back above it,
 * unticked, due on its next date.
 */
import { describe, expect, it } from 'vitest';
import { isTicked, nextDate, parseTasks, repeatRule, tickLines, tickTaskLine, toggleTaskIn } from '../../src/lib/tasks';

const TODAY = '2026-11-20'; // a Friday

describe('how a task repeats', () => {
  it('understands every day, week, month or year, every few of them, weekdays and named days, and "when done"', () => {
    expect(repeatRule('every day')).toEqual({ unit: 'day', every: 1, days: [], whenDone: false });
    expect(repeatRule('Every 3 Days')).toEqual({ unit: 'day', every: 3, days: [], whenDone: false });
    expect(repeatRule('every 2 weeks')).toMatchObject({ unit: 'week', every: 2 });
    expect(repeatRule('every month')).toMatchObject({ unit: 'month', every: 1 });
    expect(repeatRule('every year')).toMatchObject({ unit: 'year', every: 1 });
    expect(repeatRule('every weekday')).toMatchObject({ unit: 'weekdays', days: [1, 2, 3, 4, 5] });
    expect(repeatRule('every Monday')).toMatchObject({ unit: 'weekdays', days: [1] });
    expect(repeatRule('every tue and thu')).toMatchObject({ unit: 'weekdays', days: [2, 4] });
    expect(repeatRule('every Saturday, Sunday')).toMatchObject({ unit: 'weekdays', days: [0, 6] });
    expect(repeatRule('every week when done')).toMatchObject({ unit: 'week', whenDone: true });
  });

  it('isn’t guessed at: anything else doesn’t repeat', () => {
    for (const words of ['every', 'every blue moon', 'every 0 days', 'every funday', 'weekly', 'every month on the 15th']) {
      expect(repeatRule(words), words).toBeNull();
    }
  });

  it('gives the next date, a month on from the 31st being the month’s last day', () => {
    expect(nextDate(repeatRule('every day')!, TODAY)).toBe('2026-11-21');
    expect(nextDate(repeatRule('every 2 weeks')!, TODAY)).toBe('2026-12-04');
    expect(nextDate(repeatRule('every month')!, '2026-01-31')).toBe('2026-02-28');
    expect(nextDate(repeatRule('every month')!, '2028-01-31')).toBe('2028-02-29');
    expect(nextDate(repeatRule('every 3 months')!, '2026-11-30')).toBe('2027-02-28');
    expect(nextDate(repeatRule('every year')!, '2028-02-29')).toBe('2029-02-28');
    expect(nextDate(repeatRule('every month')!, '2026-12-15')).toBe('2027-01-15');
    // Friday, then Monday; and a Monday's next Monday is a week on.
    expect(nextDate(repeatRule('every weekday')!, TODAY)).toBe('2026-11-23');
    expect(nextDate(repeatRule('every Monday')!, '2026-11-23')).toBe('2026-11-30');
    expect(nextDate(repeatRule('every tue and thu')!, '2026-11-24')).toBe('2026-11-26');
  });
});

describe('ticking a task', () => {
  it('dates one with a due date or a repeat; a plain checklist item stays as it is', () => {
    expect(tickTaskLine('- [ ] Milk', true, TODAY)).toEqual({ line: '- [x] Milk', next: null });
    expect(tickTaskLine('- [ ] Pay rent 📅 2026-11-20', true, TODAY)).toEqual({ line: '- [x] Pay rent 📅 2026-11-20 ✅ 2026-11-20', next: null });
    expect(tickTaskLine('- [ ] Pay rent due:2026-11-25', true, TODAY).line).toBe('- [x] Pay rent due:2026-11-25 ✅ 2026-11-20');
  });

  it('dates every task, or none, when set to', () => {
    expect(tickTaskLine('- [ ] Milk', true, TODAY, 'all').line).toBe('- [x] Milk ✅ 2026-11-20');
    expect(tickTaskLine('- [ ] Pay rent 📅 2026-11-20', true, TODAY, 'off').line).toBe('- [x] Pay rent 📅 2026-11-20');
  });

  it('takes the date off again when unticked, and replaces an old one when ticked again', () => {
    expect(tickTaskLine('- [x] Pay rent 📅 2026-11-20 ✅ 2026-11-19', false, TODAY)).toEqual({ line: '- [ ] Pay rent 📅 2026-11-20', next: null });
    expect(tickTaskLine('- [X] Plan done:2026-11-01', false, TODAY).line).toBe('- [ ] Plan');
    expect(tickTaskLine('- [ ] Plan 📅 2026-11-30 ✅ 2026-11-01', true, TODAY).line).toBe('- [x] Plan 📅 2026-11-30 ✅ 2026-11-20');
  });

  it('brings a repeating task back above it, unticked and due on its next date', () => {
    expect(tickTaskLine('- [ ] Water plants 🔁 every week 📅 2026-11-18', true, TODAY)).toEqual({
      line: '- [x] Water plants 🔁 every week 📅 2026-11-18 ✅ 2026-11-20',
      next: '- [ ] Water plants 🔁 every week 📅 2026-11-25',
    });
    // From the day it's ticked "when done", or when it has no due date yet.
    expect(tickTaskLine('- [ ] Haircut 🔁 every 4 weeks when done 📅 2026-10-01', true, TODAY).next).toBe(
      '- [ ] Haircut 🔁 every 4 weeks when done 📅 2026-12-18',
    );
    expect(tickTaskLine('- [ ] Stretch 🔁 every day', true, TODAY).next).toBe('- [ ] Stretch 🔁 every day 📅 2026-11-21');
    // In words too, keeping how it was written.
    expect(tickTaskLine('* [ ] Report repeat:every month due:2026-11-30', true, TODAY).next).toBe('* [ ] Report repeat:every month due:2026-12-30');
    // Even with dates off, it comes back (the date is how it knows when).
    expect(tickTaskLine('- [ ] Stretch 🔁 every day', true, TODAY, 'off')).toEqual({ line: '- [x] Stretch 🔁 every day', next: '- [ ] Stretch 🔁 every day 📅 2026-11-21' });
  });

  it('keeps where the task is: indented, numbered, in a quote', () => {
    expect(tickTaskLine('    1. [ ] Sub 🔁 every day 📅 2026-11-20', true, TODAY)).toEqual({
      line: '    1. [x] Sub 🔁 every day 📅 2026-11-20 ✅ 2026-11-20',
      next: '    1. [ ] Sub 🔁 every day 📅 2026-11-21',
    });
    expect(tickTaskLine('> - [ ] Quoted 📅 2026-11-20', true, TODAY).line).toBe('> - [x] Quoted 📅 2026-11-20 ✅ 2026-11-20');
  });

  it('leaves alone a line that isn’t a task, or a task already as asked', () => {
    expect(tickTaskLine('Just text [ ] here', true, TODAY)).toEqual({ line: 'Just text [ ] here', next: null });
    expect(tickTaskLine('- [x] Done 🔁 every day', true, TODAY)).toEqual({ line: '- [x] Done 🔁 every day', next: null });
    expect(isTicked('- [x] a')).toBe(true);
    expect(isTicked('- [ ] a')).toBe(false);
    expect(isTicked('a [x]')).toBeNull();
  });
});

describe('a note’s tasks', () => {
  it('read their dates and repeat, with what they say shown without them', () => {
    const [a, b, c] = parseTasks(
      ['- [x] Water plants 🔁 every week 📅 2026-11-18 ✅ 2026-11-20', '- [ ] Odd 🔁 every blue moon', '- [ ] Plain'].join('\n'),
    );
    expect(a).toMatchObject({ text: 'Water plants', done: true, due: '2026-11-18', doneOn: '2026-11-20', repeat: 'every week' });
    expect(b).toMatchObject({ text: 'Odd', repeat: null });
    expect(c).toMatchObject({ text: 'Plain', due: null, doneOn: null, repeat: null });
  });

  it('are ticked in place, the next one going above, found by their text if lines moved', () => {
    const md = ['# Chores', '- [ ] Water plants 🔁 every week 📅 2026-11-18', '- [ ] Milk'].join('\n');
    const [task] = parseTasks(md);
    expect(toggleTaskIn(md, task, true, TODAY)).toBe(
      ['# Chores', '- [ ] Water plants 🔁 every week 📅 2026-11-25', '- [x] Water plants 🔁 every week 📅 2026-11-18 ✅ 2026-11-20', '- [ ] Milk'].join('\n'),
    );
    const moved = `Intro\n\n${md}`;
    expect(toggleTaskIn(moved, task, true, TODAY)?.split('\n')[4]).toBe('- [x] Water plants 🔁 every week 📅 2026-11-18 ✅ 2026-11-20');
    // Ticked (and dated) elsewhere since: unticked here, the date goes too.
    const elsewhere = md.replace('- [ ] Water plants 🔁 every week 📅 2026-11-18', '- [x] Water plants 🔁 every week 📅 2026-11-18 ✅ 2026-11-19');
    expect(toggleTaskIn(`x\n${elsewhere}`, task, false, TODAY)?.split('\n')[2]).toBe('- [ ] Water plants 🔁 every week 📅 2026-11-18');
    expect(toggleTaskIn('nothing here', task, true, TODAY)).toBeNull();
  });

  it('several at once (Ctrl/⌘ Enter on a selection), each new one above its own', () => {
    const md = ['- [ ] A 🔁 every day 📅 2026-11-20', '- [ ] B', '- [ ] C 🔁 every day 📅 2026-11-20'].join('\n');
    expect(tickLines(md, [{ line: 0, done: true }, { line: 2, done: true }], TODAY).split('\n')).toEqual([
      '- [ ] A 🔁 every day 📅 2026-11-21',
      '- [x] A 🔁 every day 📅 2026-11-20 ✅ 2026-11-20',
      '- [ ] B',
      '- [ ] C 🔁 every day 📅 2026-11-21',
      '- [x] C 🔁 every day 📅 2026-11-20 ✅ 2026-11-20',
    ]);
  });
});
