/**
 * Problems found by using the app end to end (an encrypted library in a real browser), kept here so
 * they stay fixed.
 */
import { describe, expect, it } from 'vitest';
import { makeInfo } from '../../shared/noteText';
import { findMentions, linkMention } from '../../src/lib/mentions';
import { parseTasks } from '../../src/lib/tasks';
import { snippetToHtml, wordCount } from '../../src/lib/utils';

describe('a journal entry’s date in other notes', () => {
  const text = '- [ ] Review 📅 2026-11-17\n- [ ] Pay rent due:2026-11-17\nSee you on 2026-11-17.\n';

  it('isn’t a mention when it’s a task’s due date', () => {
    const found = findMentions(text, '2026-11-17');
    expect(found).toHaveLength(1);
    expect(text.slice(0, found[0].start)).toBe('- [ ] Review 📅 2026-11-17\n- [ ] Pay rent due:2026-11-17\nSee you on ');
  });

  it('keeps every task’s date when the mention is linked', () => {
    const [mention] = findMentions(text, '2026-11-17');
    const linked = linkMention(text, '2026-11-17', mention);
    expect(linked).toContain('See you on [[2026-11-17]].');
    expect(parseTasks(linked).map((t) => t.due)).toEqual(['2026-11-17', '2026-11-17']);
  });
});

describe('an empty tick box', () => {
  // The default journal template starts its Focus section with one: an untouched entry added an
  // "Untitled task" to the Tasks view and Home's count every day.
  const entry = '*Tuesday, November 17, 2026*\n\n## Focus\n\n- [ ] \n\n## Notes\n\n';

  it('isn’t a task, in the Tasks view or the counts', () => {
    expect(parseTasks(entry)).toEqual([]);
    expect(JSON.parse(makeInfo(entry))).not.toHaveProperty('t');
    for (const empty of ['- [ ]', '- [x]  ', '> - [ ] \t', '1. [ ]']) expect(parseTasks(empty), empty).toEqual([]);
  });

  it('is one as soon as it says something, a due date included', () => {
    const md = `${entry.replace('- [ ] ', '- [ ] Call the bank')}\n- [ ] 📅 2026-11-20`;
    expect(parseTasks(md).map((t) => [t.text, t.due])).toEqual([
      ['Call the bank', null],
      ['', '2026-11-20'],
    ]);
    expect(JSON.parse(makeInfo(md)).t).toEqual([0, 2]);
  });
});

describe('pictures counted for has:image', () => {
  it('leave out an image example written in code', () => {
    expect(JSON.parse(makeInfo('Set a width with `![caption|300](…)`.\n\n```\n![x](/api/files/abcdef12/x.png)\n```'))).not.toHaveProperty('im');
    expect(JSON.parse(makeInfo('![x](https://example.com/x.png) and `![y](y.png)`')).im).toBe(1);
  });
});

describe('search result snippets', () => {
  // As the on-device search and the server hand them over: line breaks kept, matches between \u0001 and \u0002.
  const shown = (snippet: string) => snippetToHtml(snippet);

  it('read like the note-list previews: no task boxes, list or quote markers, callouts or table pipes', () => {
    expect(shown('## Intro\nSome \u0001intro\u0002.\n## Plan\nThe plan is [[Alpha project|the alpha]].\n> - [ ] quoted task')).toBe(
      'Intro Some <mark>intro</mark>. Plan The plan is the alpha. quoted task',
    );
    expect(shown('- [x] Ship v1 due:2026-11-10\n- [ ] \u0001Review\u0002 📅 [[2026-11-17]]\n  1. [ ] nested')).toBe(
      'Ship v1 due:2026-11-10 <mark>Review</mark> 📅 2026-11-17 nested',
    );
    expect(shown('> [!tip] Remember\n> the *main* idea\n| Item | Qty |\n| --- | ---: |\n| Eggs \\| ham | 12 |')).toBe(
      'Remember the main idea Item Qty Eggs | ham 12',
    );
  });

  it('leave out a code fence’s own line, and the pipes of a table row the snippet starts partway through', () => {
    expect(shown('…+ S | Save now | \u0001Math\u0002 works inline |\n```ts\n// Code blocks are highlighted')).toBe(
      '…+ S Save now <mark>Math</mark> works inline // Code blocks are highlighted',
    );
  });

  it('show formulas as readable text, and escapes as their characters', () => {
    expect(shown('$$\\int_0^1 x^2\\,dx = \\tfrac{1}{3}$$')).toBe('∫₀¹ x² dx = 1/3');
    expect(shown('Math $e^{i\\pi}$ and $$x^2$$ costs \\$5')).toBe('Math e^(iπ) and x² costs $5');
    // A match marked inside a formula keeps its mark (the TeX shows as written).
    expect(shown('$\u0001alpha\u0002 + 1$')).toBe('<mark>alpha</mark> + 1');
  });

  it('leave words that only look like markers in running text, and a snippet starting mid-line', () => {
    expect(shown('…moved in 2019. Then - not a list, 2 * 3 = 6')).toBe('…moved in 2019. Then - not a list, 2 * 3 = 6');
    expect(shown('…[ ] not at a line start')).toBe('…[ ] not at a line start');
  });

  it('still escape HTML, so a note can’t put markup in the list', () => {
    expect(shown('<img src=x onerror=alert(1)> \u0001hit\u0002')).toBe('&lt;img src=x onerror=alert(1)&gt; <mark>hit</mark>');
  });
});

describe('word counts', () => {
  it('count a link by its text, not its address', () => {
    expect(wordCount('Some **bold** and [a link](https://example.com/x/y).')).toBe(5);
    expect(wordCount('A [titled link](https://example.com "The title") here')).toBe(4);
  });

  it('count a bare web address as one word', () => {
    expect(wordCount('see https://example.com/a/b?c=d and <https://x.test/p>')).toBe(4);
  });

  it('still count ordinary prose, tasks and wiki links', () => {
    expect(wordCount('- [x] Ship it\n- [ ] Call [[Beta plan]]')).toBe(5);
  });
});
