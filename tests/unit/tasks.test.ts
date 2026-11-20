import { describe, expect, it } from 'vitest';
import { makeInfo } from '../../shared/noteText';
import { dueLabel, parseTasks, plainTaskText, toggleTaskIn } from '../../src/lib/tasks';
import { expectQuick } from './timing';

describe('parseTasks', () => {
  it('finds bulleted, numbered, nested and quoted tasks with their lines', () => {
    const md = '# Plan\n\n- [ ] Write **draft** 📅 2026-11-20\n  - [x] Outline\n1. [ ] Send [[Roadmap|the plan]]\n> - [ ] Quoted due:2026-12-01\n- not a task\n- [ ]\n';
    expect(parseTasks(md)).toEqual([
      { line: 2, raw: '- [ ] Write **draft** 📅 2026-11-20', text: 'Write draft', done: false, due: '2026-11-20', doneOn: null, repeat: null, depth: 0 },
      { line: 3, raw: '  - [x] Outline', text: 'Outline', done: true, due: null, doneOn: null, repeat: null, depth: 1 },
      { line: 4, raw: '1. [ ] Send [[Roadmap|the plan]]', text: 'Send the plan', done: false, due: null, doneOn: null, repeat: null, depth: 0 },
      { line: 5, raw: '> - [ ] Quoted due:2026-12-01', text: 'Quoted', done: false, due: '2026-12-01', doneOn: null, repeat: null, depth: 0 },
      // Line 7, an empty "- [ ]", isn't a task until it says something.
    ]);
  });

  it('stays quick on deeply quoted lines (an email thread pasted in)', { retry: 2 }, () => {
    const md = `- [ ] real\n${'> '.repeat(60)}text\n${'>  '.repeat(60)}- [ ] deep`;
    const start = performance.now();
    const tasks = parseTasks(md);
    expectQuick(performance.now() - start, 200);
    expect(tasks.map((t) => t.text)).toEqual(['real', 'deep']);
    expect(JSON.parse(makeInfo(md)).t).toEqual([0, 2]);
  });

  it('skips tasks inside code blocks', () => {
    const md = '```md\n- [ ] not real\n```\n~~~\n- [ ] nor this\n~~~\n- [x] real';
    expect(parseTasks(md).map((t) => t.text)).toEqual(['real']);
  });

  it('needs the box right after the list marker', () => {
    expect(parseTasks('- see [ ] here\n-[ ] tight\n* [X] Upper')).toEqual([
      { line: 2, raw: '* [X] Upper', text: 'Upper', done: true, due: null, doneOn: null, repeat: null, depth: 0 },
    ]);
  });
});

describe('plainTaskText', () => {
  it('drops formatting but keeps the words', () => {
    expect(plainTaskText('Read [the doc](https://x.y) and `npm test`, *then* ==ship== [[Plan#Later]]')).toBe(
      'Read the doc and npm test, then ship Plan › Later',
    );
    expect(plainTaskText('keep snake_case_names')).toBe('keep snake_case_names');
  });
});

describe('toggleTaskIn', () => {
  const md = 'Intro\n- [ ] One\n- [ ] Two';

  it('ticks the task on its line', () => {
    expect(toggleTaskIn(md, { line: 2, raw: '- [ ] Two' }, true, '2026-11-20')).toBe('Intro\n- [ ] One\n- [x] Two');
  });

  it('finds the task by its text when lines moved', () => {
    expect(toggleTaskIn(`New line\n${md}`, { line: 2, raw: '- [ ] Two' }, true, '2026-11-20')).toBe('New line\nIntro\n- [ ] One\n- [x] Two');
  });

  it('accepts a task already ticked elsewhere, and gives up on one that’s gone', () => {
    expect(toggleTaskIn('- [x] Two', { line: 0, raw: '- [ ] Two' }, false, '2026-11-20')).toBe('- [ ] Two');
    expect(toggleTaskIn('- [ ] Three', { line: 0, raw: '- [ ] Two' }, true, '2026-11-20')).toBeNull();
  });
});

describe('dueLabel', () => {
  it('says today, tomorrow and yesterday, and dates otherwise', () => {
    expect(dueLabel('2026-11-17', '2026-11-17')).toBe('Today');
    expect(dueLabel('2026-11-18', '2026-11-17')).toBe('Tomorrow');
    expect(dueLabel('2026-11-16', '2026-11-17')).toBe('Yesterday');
    expect(dueLabel('2027-01-05', '2026-11-17')).toMatch(/2027/);
  });
});
