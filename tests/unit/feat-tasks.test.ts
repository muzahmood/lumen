/**
 * The Tasks view's rules (src/lib/tasks.ts) on the lists people really write: every list marker,
 * nesting, quotes and callouts, code blocks, odd spacing, both due-date syntaxes, and dates near the
 * ends of months and years. The list's task counts (makeInfo) must agree with the view.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { makeInfo } from '../../shared/noteText';
import { dueLabel, parseTasks, plainTaskText, toggleTaskIn } from '../../src/lib/tasks';
import { expectQuick } from './timing';

const texts = (md: string) => parseTasks(md).map((t) => t.text);
const counts = (md: string) => JSON.parse(makeInfo(md)).t as [number, number] | undefined;

describe('which lines are tasks', () => {
  it('takes every bullet and number style, up to nine digits as Markdown allows', () => {
    const md = ['- [ ] dash', '* [ ] star', '+ [ ] plus', '1. [ ] dot', '2) [ ] bracket', '123456789. [ ] nine digits', '1234567890. [ ] ten digits'].join('\n');
    expect(texts(md)).toEqual(['dash', 'star', 'plus', 'dot', 'bracket', 'nine digits']);
  });

  it('reads ticked boxes in either case and leaves other boxes alone', () => {
    const md = '- [x] lower\n- [X] upper\n- [-] cancelled\n- [  ] two spaces\n- [/] half\n- [ ]no space after';
    expect(parseTasks(md).map((t) => [t.text, t.done])).toEqual([
      ['lower', true],
      ['upper', true],
    ]);
  });

  it('accepts tabs and extra spaces around the marker and the box', () => {
    const md = '-\t[ ] tab after marker\n-   [ ]   wide\n- [ ]\ttab after box\n - [ ] one space in\n- [ ]    \n- [x]';
    expect(parseTasks(md).map((t) => [t.text, t.depth])).toEqual([
      ['tab after marker', 0],
      ['wide', 0],
      ['tab after box', 0],
      ['one space in', 0],
      // "- [ ]    " and "- [x]" are empty boxes, not tasks.
    ]);
  });

  it('measures nesting under bullets and under numbers', () => {
    const md = ['- [ ] top', '  - [ ] child', '    - [ ] grandchild', '1. [ ] numbered', '   - [ ] under a number', '              - [ ] very deep'].join('\n');
    expect(parseTasks(md).map((t) => t.depth)).toEqual([0, 1, 2, 0, 1, 6]);
  });

  it('counts one tab of indentation as one level of nesting', () => {
    expect(parseTasks('- parent\n\t- [ ] child\n\t\t- [ ] grandchild').map((t) => t.depth)).toEqual([1, 2]);
  });

  it('finds tasks in quotes and callouts, however the quote markers are spaced', () => {
    const md = [
      '> - [ ] spaced',
      '>- [ ] tight',
      '> > - [ ] nested quote',
      '>> - [ ] nested tight',
      '>\t- [ ] tab after quote',
      '   > - [ ] indented quote',
      '> [!todo] Today',
      '> - [x] in a callout 📅 2026-11-17',
      '> 1. [ ] numbered in a quote',
    ].join('\n');
    expect(texts(md)).toEqual(['spaced', 'tight', 'nested quote', 'nested tight', 'tab after quote', 'indented quote', 'in a callout', 'numbered in a quote']);
    expect(parseTasks(md)[6].due).toBe('2026-11-17');
  });

  it('measures nesting inside a quote from after the quote marker', () => {
    expect(parseTasks('> - [ ] a\n>   - [ ] b').map((t) => t.depth)).toEqual([0, 1]);
  });

  it('never takes a box that is not right after a list marker', () => {
    const md = '[ ] bare box\nText - [ ] mid-line\n# - [ ] heading\n|- [ ] table|\n-- [ ] double dash\n1 [ ] no dot';
    expect(parseTasks(md)).toEqual([]);
    expect(counts(md)).toBeUndefined();
  });
});

describe('tasks and code', () => {
  it('skips fenced blocks of either kind, with info strings, until a matching fence closes them', () => {
    const md = [
      '```md title="example"',
      '- [ ] in backticks',
      '```',
      '~~~',
      '- [ ] in tildes',
      '```',
      '- [ ] still in tildes: a backtick fence does not close a tilde one',
      '~~~',
      '````',
      '```',
      '- [ ] inside a longer fence',
      '```',
      '````',
      '```js',
      '- [ ] after a closing fence with text',
      '``` not a closer',
      '- [ ] still code',
      '```',
      '- [ ] real',
    ].join('\n');
    expect(texts(md)).toEqual(['real']);
    expect(counts(md)).toEqual([0, 1]);
  });

  it('skips a fence indented inside a list item', () => {
    const md = '- item\n  ```\n  - [ ] example\n  ```\n- [ ] real';
    expect(texts(md)).toEqual(['real']);
    expect(counts(md)).toEqual([0, 1]);
  });

  it('treats everything after a fence that never closes as code, as reading view does', () => {
    expect(texts('- [ ] before\n```\n- [ ] after')).toEqual(['before']);
  });

  it('keeps a box written in inline code as part of the task’s words', () => {
    expect(parseTasks('- [ ] explain `- [ ]` syntax')[0].text).toBe('explain - [ ] syntax');
  });

  it('skips a fenced block inside a quote or callout', () => {
    const md = '> [!example] Task syntax\n> ```md\n> - [ ] an example, not a task\n> ```\n- [ ] real';
    expect(texts(md)).toEqual(['real']);
    expect(counts(md)).toEqual([0, 1]);
  });
});

describe('due dates', () => {
  const due = (line: string) => parseTasks(line)[0]?.due ?? null;

  it('reads both syntaxes, with or without spaces, anywhere in the task', () => {
    expect(due('- [ ] Pay rent 📅 2026-12-01')).toBe('2026-12-01');
    expect(due('- [ ] Pay rent 📅2026-12-01')).toBe('2026-12-01');
    expect(due('- [ ] Pay rent 📅️ 2026-12-01')).toBe('2026-12-01');
    expect(due('- [ ] 📅 2026-12-01 Pay rent')).toBe('2026-12-01');
    expect(due('- [ ] Pay rent due:2026-12-01')).toBe('2026-12-01');
    expect(due('- [ ] Pay rent due: 2026-12-01')).toBe('2026-12-01');
    expect(due('- [ ] Pay rent (due:2026-12-01)')).toBe('2026-12-01');
    expect(due('- [ ] Pay rent due:2026-12-01, then relax')).toBe('2026-12-01');
    expect(due('> - [x] Paid due:2026-12-01')).toBe('2026-12-01');
  });

  it('drops the date from the words shown', () => {
    expect(parseTasks('- [ ] Pay 📅 2026-12-01 rent')[0].text).toBe('Pay rent');
    expect(parseTasks('- [ ] Pay rent due:2026-12-01')[0].text).toBe('Pay rent');
    expect(parseTasks('- [ ] due:2026-12-01')[0].text).toBe('');
  });

  it('isn’t fooled by words ending in "due", longer numbers or partial dates', () => {
    expect(due('- [ ] overdue:2026-12-01')).toBeNull();
    expect(due('- [ ] residue:2026-12-01')).toBeNull();
    expect(due('- [ ] due:2026-12-011')).toBeNull();
    expect(due('- [ ] due:2026-12')).toBeNull();
    expect(due('- [ ] due 2026-12-01')).toBeNull();
    expect(due('- [ ] 2026-12-01')).toBeNull();
  });

  it('takes the first date when there are two', () => {
    expect(due('- [ ] a 📅 2026-12-01 due:2027-01-01')).toBe('2026-12-01');
    expect(due('- [ ] a due:2027-01-01 📅 2026-12-01')).toBe('2027-01-01');
  });

  it('reads a date on a task nested in a quote and a list', () => {
    expect(parseTasks('> - parent\n>   1. [ ] child 📅 2026-02-28')[0]).toMatchObject({ due: '2026-02-28', depth: 1, text: 'child' });
  });
});

describe('the line a task opens at', () => {
  it('is the 0-based line that holds it, so /note/<id>#L<line> lands on the task', () => {
    const md = '# Title\n\n```\n- [ ] code\n```\n\n> - [ ] quoted\n\n1. [ ] numbered\n   - [x] nested\n';
    const lines = md.split('\n');
    const tasks = parseTasks(md);
    expect(tasks.map((t) => t.line)).toEqual([6, 8, 9]);
    for (const t of tasks) expect(lines[t.line]).toBe(t.raw);
  });
});

describe('ticking and unticking', () => {
  it('changes only the task’s own box, not boxes later in its text', () => {
    expect(toggleTaskIn('- [ ] check [ ] boxes', { line: 0, raw: '- [ ] check [ ] boxes' }, true, '2026-11-20')).toBe('- [x] check [ ] boxes');
    expect(toggleTaskIn('- [X] done [x]', { line: 0, raw: '- [X] done [x]' }, false, '2026-11-20')).toBe('- [ ] done [x]');
  });

  it('works on quoted, numbered and nested tasks, keeping everything else on the line', () => {
    const md = 'x\n> 12) [ ] quoted 📅 2026-11-20\n    - [x] deep';
    const [quoted, deep] = parseTasks(md);
    expect(toggleTaskIn(md, quoted, true, '2026-11-20')).toBe('x\n> 12) [x] quoted 📅 2026-11-20 ✅ 2026-11-20\n    - [x] deep');
    expect(toggleTaskIn(md, deep, false, '2026-11-20')).toBe('x\n> 12) [ ] quoted 📅 2026-11-20\n    - [ ] deep');
  });

  it('is a no-op when the box already says so', () => {
    expect(toggleTaskIn('- [x] a', { line: 0, raw: '- [x] a' }, true, '2026-11-20')).toBe('- [x] a');
  });

  it('finds a task that moved to another line and was ticked meanwhile', () => {
    expect(toggleTaskIn('new\nlines\n- [x] Two', { line: 0, raw: '- [ ] Two' }, false, '2026-11-20')).toBe('new\nlines\n- [ ] Two');
  });

  it('gives up when the line no longer exists rather than ticking something else', () => {
    expect(toggleTaskIn('', { line: 3, raw: '- [ ] gone' }, true, '2026-11-20')).toBeNull();
    expect(toggleTaskIn('- [ ] gone but edited', { line: 0, raw: '- [ ] gone' }, true, '2026-11-20')).toBeNull();
  });
});

describe('notes written on Windows', () => {
  it('finds tasks on lines ending in CRLF, as the note list counts them', () => {
    const md = '# Plan\r\n- [ ] one\r\n- [x] two\r\n';
    expect(counts(md)).toEqual([1, 2]);
    expect(parseTasks(md).map((t) => [t.text, t.done])).toEqual([
      ['one', false],
      ['two', true],
    ]);
  });
});

describe('the list’s task count agrees with the Tasks view', () => {
  const samples = [
    '- [ ] a\n- [x] b',
    '1. [ ] a\n2) [X] b\n+ [ ] c',
    '> - [ ] a\n>> - [x] b\n>\t- [ ] c',
    '- [ ]\n- [x]\n- [ ]\t',
    '```\n- [ ] a\n```\n~~~\n- [x] b\n~~~\n- [ ] c',
    '- [ ]x\n-[ ] a\n- [ ] ok',
    '    - [ ] four spaces\n\t- [x] tab',
    '- [ ] a\n````\n```\n- [ ] in code\n```\n````\n- [x] b',
  ];
  for (const md of samples) {
    it(`for ${JSON.stringify(md).slice(0, 50)}`, () => {
      const tasks = parseTasks(md);
      const expected: [number, number] | undefined = tasks.length ? [tasks.filter((t) => t.done).length, tasks.length] : undefined;
      expect(counts(md)).toEqual(expected);
    });
  }
});

describe('plain words for a task', () => {
  it('shows links, embeds and wiki-links by their words', () => {
    expect(plainTaskText('Read ![chart](/api/files/abc/c.png) and [[Plan|the plan]] and [[Roadmap]]')).toBe('Read chart and the plan and Roadmap');
  });

  it('drops emphasis around words but not stars and underscores used as text', () => {
    expect(plainTaskText('**bold** __under__ ~~gone~~ ==mark== *it* _em_')).toBe('bold under gone mark it em');
    expect(plainTaskText('2 * 3 * 4 and file_name_here and a*b')).toBe('2 * 3 * 4 and file_name_here and a*b');
  });

  it('collapses whitespace and trims', () => {
    expect(plainTaskText('  lots   of\tspace  ')).toBe('lots of space');
  });
});

describe('due labels near the ends of months and years', () => {
  it('says Tomorrow and Yesterday across month, year and leap-day boundaries', () => {
    expect(dueLabel('2026-12-01', '2026-11-30')).toBe('Tomorrow');
    expect(dueLabel('2027-01-01', '2026-12-31')).toBe('Tomorrow');
    expect(dueLabel('2026-12-31', '2027-01-01')).toBe('Yesterday');
    expect(dueLabel('2028-02-29', '2028-03-01')).toBe('Yesterday');
    expect(dueLabel('2028-03-01', '2028-02-28')).not.toBe('Tomorrow');
  });

  it('names the weekday for the next six days, then gives the date', () => {
    const weekday = (iso: string) => new Date(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8))).toLocaleDateString(undefined, { weekday: 'long' });
    expect(dueLabel('2026-11-19', '2026-11-17')).toBe(weekday('2026-11-19'));
    expect(dueLabel('2026-11-23', '2026-11-17')).toBe(weekday('2026-11-23'));
    expect(dueLabel('2026-11-24', '2026-11-17')).not.toBe(weekday('2026-11-24'));
    expect(dueLabel('2026-11-24', '2026-11-17')).not.toMatch(/2026/);
    // Past dates beyond yesterday are dates, never a weekday that reads like the coming one.
    expect(dueLabel('2026-11-14', '2026-11-17')).not.toBe(weekday('2026-11-14'));
  });

  it('adds the year only for another year', () => {
    expect(dueLabel('2027-01-15', '2026-12-31')).toMatch(/2027/);
    expect(dueLabel('2026-12-20', '2026-11-17')).not.toMatch(/2026/);
    expect(dueLabel('2025-12-31', '2026-01-01')).toBe('Yesterday');
    expect(dueLabel('2025-12-20', '2026-01-01')).toMatch(/2025/);
  });
});

describe('due labels across daylight-saving changes', () => {
  const original = process.env.TZ;
  afterEach(() => {
    process.env.TZ = original;
  });

  for (const zone of ['America/New_York', 'Europe/London', 'Australia/Sydney', 'America/Santiago', 'Asia/Tehran']) {
    it(`counts whole days in ${zone}`, () => {
      process.env.TZ = zone;
      // Each pair straddles a change in one hemisphere or the other (2026).
      expect(dueLabel('2026-03-09', '2026-03-08')).toBe('Tomorrow');
      expect(dueLabel('2026-03-30', '2026-03-29')).toBe('Tomorrow');
      expect(dueLabel('2026-04-05', '2026-04-06')).toBe('Yesterday');
      expect(dueLabel('2026-09-07', '2026-09-06')).toBe('Tomorrow');
      expect(dueLabel('2026-10-05', '2026-10-04')).toBe('Tomorrow');
      expect(dueLabel('2026-11-02', '2026-11-01')).toBe('Tomorrow');
      expect(dueLabel('2026-03-08', '2026-03-08')).toBe('Today');
    });
  }
});

describe('cost on hostile task lines', () => {
  const cases: Array<[string, string]> = [
    ['deep quotes with tabs', `${'>\t'.repeat(5000)}- [ ] x`],
    ['quote markers without a list item', `${'> '.repeat(20_000)}text`],
    ['spaces between quote markers', `${'>   '.repeat(5000)}- [ ] x`],
    ['a long run of spaces before a box that never comes', `${' '.repeat(50_000)}-`],
    ['many long digit runs', `${'123456789'.repeat(5000)}. [ ] x`],
    ['many calendar emoji', `- [ ] ${'📅 '.repeat(20_000)}`],
    ['many "due:" without dates', `- [ ] ${'due: '.repeat(20_000)}`],
    ['unclosed image openers in a task', `- [ ] ${'!['.repeat(20_000)}`],
    ['unclosed link openers in a task', `- [ ] ${'['.repeat(40_000)}`],
    ['unclosed link targets in a task', `- [ ] ${'[x]('.repeat(16_000)}`],
    ['stray emphasis in a task', `- [ ] ${' *a'.repeat(20_000)}`],
    ['many lines that look like fences', '```x\n'.repeat(20_000)],
  ];
  for (const [name, md] of cases) {
    it(`stays quick on ${name}`, { retry: 2 }, () => {
      const start = performance.now();
      parseTasks(md);
      expectQuick(performance.now() - start, 300);
      const counted = performance.now();
      makeInfo(md);
      expectQuick(performance.now() - counted, 300);
    });
  }
});
