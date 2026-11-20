/**
 * Small helpers used across the app (src/lib/utils.ts): ids, escaping, heading slugs, the dates and
 * greetings shown in lists and on Home, sizes, word counts, safe file names, search snippets. And the
 * first-run note (src/lib/welcome.ts), which has to show the features it describes.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeExcerpt, makeInfo, makeLinks } from '../../shared/noteText';
import { parseTasks } from '../../src/lib/tasks';
import {
  dateGroup,
  debounce,
  escapeHtml,
  formatBytes,
  greeting,
  initialOf,
  newId,
  noteTitle,
  readingMinutes,
  relativeTime,
  safeName,
  shortTime,
  slugify,
  snippetToHtml,
  todayIso,
  uploadSafeName,
  wordCount,
} from '../../src/lib/utils';
import { WELCOME_NOTE, WELCOME_TITLE } from '../../src/lib/welcome';

const local = (y: number, m: number, d: number, hh = 0, mm = 0) => new Date(y, m - 1, d, hh, mm).getTime();

describe('ids and escaping', () => {
  it('makes ids of the asked length from letters and digits, different each time', () => {
    const ids = Array.from({ length: 200 }, () => newId());
    expect(ids.every((id) => /^[0-9a-zA-Z]{14}$/.test(id))).toBe(true);
    expect(new Set(ids).size).toBe(200);
    expect(newId(32)).toHaveLength(32);
  });

  it('escapes every character that matters in HTML text and attributes', () => {
    expect(escapeHtml(`<img src=x onerror="alert('1')">&amp;`)).toBe('&lt;img src=x onerror=&quot;alert(&#39;1&#39;)&quot;&gt;&amp;amp;');
  });

  it('turns a search snippet into safe HTML with its matches marked', () => {
    expect(snippetToHtml('<b>\u0001bold\u0002</b> **x** [link](https://e.x) [[Note|alias]] ## head')).toBe('&lt;b&gt;<mark>bold</mark>&lt;/b&gt; x link alias head');
  });
});

describe('heading slugs', () => {
  it('keeps letters and digits of every script, lower case, joined by dashes', () => {
    expect(slugify('  Été & Hiver!  ')).toBe('ete-hiver');
    expect(slugify('日本語 見出し')).toBe('日本語-見出し');
    expect(slugify('🚀 Launch   plan v2')).toBe('launch-plan-v2');
    expect(slugify('C++ / C#')).toBe('c-c');
  });

  it('gives a name to headings with nothing to slug, and caps long ones', () => {
    expect(slugify('')).toBe('section');
    expect(slugify('!!! ???')).toBe('section');
    expect(slugify('a'.repeat(120))).toHaveLength(80);
  });
});

describe('times shown in lists and on Home', () => {
  const now = local(2026, 11, 17, 14, 30);

  it('says how long ago, in words, then gives the date', () => {
    const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
    expect(relativeTime(now - 30_000, now)).toBe('just now');
    expect(relativeTime(now - 5 * 60_000, now)).toBe(rtf.format(-5, 'minute'));
    expect(relativeTime(now - 3 * 3_600_000, now)).toBe(rtf.format(-3, 'hour'));
    expect(relativeTime(now - 2 * 86_400_000, now)).toBe(rtf.format(-2, 'day'));
    expect(relativeTime(now + 10 * 60_000, now)).toBe(rtf.format(10, 'minute'));
    expect(relativeTime(local(2025, 3, 1), now)).toMatch(/2025/);
  });

  it('labels list rows by today, yesterday, this week, then the date', () => {
    expect(shortTime(local(2026, 11, 17, 0, 0), now)).toMatch(/\d/);
    expect(shortTime(local(2026, 11, 16, 23, 59), now)).toBe('Yesterday');
    expect(shortTime(local(2026, 11, 16, 0, 0), now)).toBe('Yesterday');
    expect(shortTime(local(2026, 11, 15, 23, 59), now)).not.toBe('Yesterday');
    expect(shortTime(local(2025, 11, 17), now)).toMatch(/2025/);
  });

  it('groups notes by day ranges', () => {
    expect(dateGroup(local(2026, 11, 17, 0, 0), now)).toBe('Today');
    expect(dateGroup(local(2026, 11, 16, 0, 0), now)).toBe('Yesterday');
    expect(dateGroup(local(2026, 11, 10, 0, 0), now)).toBe('Previous 7 days');
    expect(dateGroup(local(2026, 10, 18, 0, 0), now)).toBe('Previous 30 days');
    expect(dateGroup(local(2026, 1, 5), now)).toBe(new Date(local(2026, 1, 5)).toLocaleDateString(undefined, { month: 'long' }));
  });

  it('greets by the hour, changing exactly on the hour', () => {
    const at = (hh: number, mm = 0) => greeting(new Date(2026, 10, 17, hh, mm));
    expect([at(0), at(4, 59), at(5), at(11, 59), at(12), at(17, 59), at(18), at(23, 59)]).toEqual([
      'Working late',
      'Working late',
      'Good morning',
      'Good morning',
      'Good afternoon',
      'Good afternoon',
      'Good evening',
      'Good evening',
    ]);
  });

  describe('across a daylight-saving change', () => {
    const original = process.env.TZ;
    afterEach(() => {
      process.env.TZ = original;
    });

    it('calls only the previous calendar day “Yesterday” (New York, March and November 2026)', () => {
      process.env.TZ = 'America/New_York';
      const afterSpring = local(2026, 3, 9, 10);
      expect(shortTime(local(2026, 3, 7, 23, 30), afterSpring)).not.toBe('Yesterday');
      expect(dateGroup(local(2026, 3, 7, 23, 30), afterSpring)).not.toBe('Yesterday');
      const afterFall = local(2026, 11, 2, 10);
      expect(shortTime(local(2026, 11, 1, 0, 30), afterFall)).toBe('Yesterday');
      expect(dateGroup(local(2026, 11, 1, 0, 30), afterFall)).toBe('Yesterday');
    });

    it('writes today’s date in the local zone near midnight', () => {
      const instant = new Date(Date.UTC(2026, 11, 31, 23, 30));
      process.env.TZ = 'Pacific/Auckland';
      expect(todayIso(instant)).toBe('2027-01-01');
      process.env.TZ = 'America/Los_Angeles';
      expect(todayIso(instant)).toBe('2026-12-31');
    });
  });
});

describe('sizes and reading time', () => {
  it('writes sizes in the right unit with sensible precision', () => {
    expect([0, 1023, 1024, 10 * 1024 - 1, 10 * 1024, 5 * 1024 * 1024, 3 * 1024 ** 3].map(formatBytes)).toEqual(['0 B', '1023 B', '1.0 KB', '10.0 KB', '10 KB', '5.0 MB', '3.00 GB']);
  });

  it('never shows 1024 of a unit', () => {
    expect(formatBytes(1024 * 1024 - 1)).not.toMatch(/^1024/);
    expect(formatBytes(1024 ** 3 - 1)).not.toMatch(/^1024/);
  });

  it('reads at about 230 words a minute, at least one minute', () => {
    expect([0, 1, 230, 344, 345, 1000].map(readingMinutes)).toEqual([1, 1, 1, 1, 2, 4]);
  });
});

describe('word counts', () => {
  it('counts words, not Markdown, code, images or a ticked box’s x', () => {
    expect(wordCount("# Title\n\n- [x] Don't stop\n- [ ] it’s fine\n\n```js\nconst notCounted = 1;\n```\n![alt words](/a.png)\n| a | b |")).toBe(7);
  });

  it('counts numbers and words in any script', () => {
    expect(wordCount('3 apples, 日本 и Москва')).toBe(5);
  });

  it('counts nothing in an empty note', () => {
    expect(wordCount('')).toBe(0);
    expect(wordCount('--- *** ___')).toBe(0);
  });
});

describe('file names', () => {
  it('replaces characters file systems and Markdown links object to', () => {
    expect(safeName('a/b\\c:d*e?f"g<h>i|j#k^l[m]n')).toBe('a b c d e f g h i j k l m n');
    expect(safeName('  many   spaces  ')).toBe('many spaces');
  });

  it('never gives a name made only of dots, or an empty one', () => {
    for (const bad of ['', '   ', '.', '..', '...', '///', '[]']) expect(safeName(bad), bad).toBe('Untitled');
    expect(safeName('', 'Note')).toBe('Note');
  });

  it('caps names at 100 characters', () => {
    expect(safeName('x'.repeat(300))).toHaveLength(100);
  });

  it('makes upload names plain, keeping the extension', () => {
    expect(uploadSafeName('My Photo (1).JPG')).toBe('My-Photo-1.JPG');
    expect(uploadSafeName('café crème.png')).toBe('cafe-creme.png');
    expect(uploadSafeName('???')).toBe('file');
  });

  it('keeps a name before the extension for files named in other scripts', () => {
    for (const name of ['تصویر.png', '照片.png', 'Фото.jpg']) expect(uploadSafeName(name), name).not.toMatch(/^\./);
  });
});

describe('small bits of text', () => {
  it('shows Untitled for a blank title, and the first letter for an avatar', () => {
    expect([noteTitle(''), noteTitle('   '), noteTitle(null), noteTitle(' x ')]).toEqual(['Untitled', 'Untitled', 'Untitled', ' x ']);
    expect([initialOf('  morgan'), initialOf(''), initialOf(null)]).toEqual(['M', 'K', 'K']);
  });

  it('debounces calls, keeping the last arguments, and can be cancelled', () => {
    vi.useFakeTimers();
    try {
      const fn = vi.fn();
      const d = debounce(fn, 100);
      d(1);
      d(2);
      vi.advanceTimersByTime(99);
      expect(fn).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(fn).toHaveBeenCalledExactlyOnceWith(2);
      d(3);
      d.cancel();
      vi.advanceTimersByTime(500);
      expect(fn).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('the welcome note', () => {
  it('is titled, and starts with a readable preview', () => {
    expect(WELCOME_TITLE).toBe('Welcome to Lumen');
    expect(makeExcerpt(WELCOME_NOTE)).toMatch(/^Lumen is where your notes, diagrams and drawings live/);
  });

  it('has the tasks, diagram and formula it describes', () => {
    expect(parseTasks(WELCOME_NOTE).map((t) => [t.text, t.done])).toEqual([
      ['Open this note', true],
      ['Tick a box right here in reading view', false],
      ['Create a folder from the sidebar and drag a note into it', false],
    ]);
    expect(JSON.parse(makeInfo(WELCOME_NOTE))).toMatchObject({ t: [1, 3], d: 1 });
    expect(WELCOME_NOTE).toContain('$e^{i\\pi} + 1 = 0$');
    expect(WELCOME_NOTE).toContain('const greet = (name: string) => `Hello, ${name}`;');
  });

  it('closes every code block it opens, and links to no other note', () => {
    expect(WELCOME_NOTE.split('\n').filter((l) => /^```/.test(l)).length % 2).toBe(0);
    expect(makeLinks(WELCOME_NOTE)).toEqual({ n: [], w: [] });
  });
});
