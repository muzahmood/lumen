import { describe, expect, it } from 'vitest';
import { fillTemplate, isoDate, parseIsoDate } from '../../src/lib/templateText';

const when = new Date(2026, 10, 17, 9, 5);

describe('fillTemplate', () => {
  it('fills in dates, times and the title', () => {
    expect(fillTemplate('{{date}} at {{time}} ({{datetime}}) {{year}}/{{month}}/{{day}}: {{title}}', { date: when, title: 'Standup' })).toBe(
      '2026-11-17 at 09:05 (2026-11-17 09:05) 2026/11/17: Standup',
    );
  });

  it('spells out the weekday and the long date in the reader’s language', () => {
    const filled = fillTemplate('{{weekday}} | {{longdate}}', { date: when });
    expect(filled).toBe(`${when.toLocaleDateString(undefined, { weekday: 'long' })} | ${when.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}`);
  });

  it('accepts spaces and any case, and leaves unknown placeholders alone', () => {
    expect(fillTemplate('{{ DATE }} {{nope}} {{title}}', { date: when })).toBe('2026-11-17 {{nope}} ');
    expect(fillTemplate('{{constructor}} {{toString}}', { date: when })).toBe('{{constructor}} {{toString}}');
  });
});

describe('dates', () => {
  it('reads and writes YYYY-MM-DD as local dates', () => {
    expect(isoDate(when)).toBe('2026-11-17');
    expect(parseIsoDate('2026-11-17', when)?.getHours()).toBe(9);
    expect(parseIsoDate('2026-02-30')).toBeNull();
    expect(parseIsoDate('Meeting')).toBeNull();
  });
});
