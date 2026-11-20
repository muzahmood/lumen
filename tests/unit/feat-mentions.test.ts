/**
 * Mentions under a note's title: the notes that name it without linking to it, and Link, which turns
 * one into a [[link]]. The pure rules (src/lib/mentions.ts) on punctuation, word edges, case and text
 * that already links; then the list and the Link button (src/lib/relink.ts) with the app's state
 * stubbed.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { findMentions, linkMention, mentionPattern, proseMask, snippetAround } from '../../src/lib/mentions';
import { expectQuick } from './timing';

const h = vi.hoisted(() => {
  const texts = new Map<string, string>();
  let state: { notes: Record<string, unknown> } = { notes: {} };
  return {
    texts,
    useApp: {
      getState: () => state,
      setState: (patch: Partial<typeof state>) => {
        state = { ...state, ...patch };
      },
    },
    toast: vi.fn(),
    syncLibrary: vi.fn(async () => undefined),
  };
});

vi.mock('../../src/lib/store', () => ({ useApp: h.useApp, toast: h.toast }));
vi.mock('../../src/lib/library', () => ({ syncLibrary: h.syncLibrary }));
vi.mock('../../src/lib/liveEdit', () => ({
  knownText: (id: string) => (h.texts.has(id) ? { content: h.texts.get(id)!, version: 1 } : null),
  changeNoteText: (id: string, fn: (src: string) => string) => {
    if (!h.texts.has(id)) return false;
    h.texts.set(id, fn(h.texts.get(id)!));
    return true;
  },
}));

const { linkFirstMention, unlinkedMentions } = await import('../../src/lib/relink');

const found = (text: string, title: string) => findMentions(text, title).map((m) => text.slice(m.start, m.end));

describe('where a title counts as mentioned', () => {
  it('needs whole words: not inside longer words, but next to punctuation', () => {
    const text = `planner airplane Plans plan's plan. (plan) "plan" plan-based plan_b plan2 «plan» plan…`;
    expect(found(text, 'Plan')).toEqual(['plan', 'plan', 'plan', 'plan', 'plan', 'plan', 'plan']);
  });

  it('treats letters in every script as part of a word', () => {
    expect(found('Cafés café CAFÉ cafébar', 'Café')).toEqual(['café', 'CAFÉ']);
    expect(found('Привет мирный мир', 'мир')).toEqual(['мир']);
  });

  it('finds a mention next to emoji and at the very start and end', () => {
    expect(found('Garden plan🌱 and 🌱Garden plan', 'Garden plan')).toEqual(['Garden plan', 'Garden plan']);
    expect(findMentions('Garden plan', 'Garden plan')).toEqual([{ start: 0, end: 11 }]);
  });

  it('finds mentions in headings, lists, quotes and tables', () => {
    expect(found('# Garden plan\n- garden plan\n> Garden plan\n| Garden plan | x |', 'Garden plan')).toHaveLength(4);
  });

  it('finds a mention right after a link to something else', () => {
    expect(found('[[Other]] Garden plan and [x](https://a.b) garden plan', 'Garden plan')).toEqual(['Garden plan', 'garden plan']);
  });

  it('reads punctuation in a title as itself', () => {
    expect(found('I use .NET daily, not ASP.NET', '.NET')).toEqual(['.NET']);
    expect(found('Q&A session and QxA', 'Q&A')).toEqual(['Q&A']);
    expect(found('set $HOME now', '$HOME')).toEqual(['$HOME']);
    expect(found('a.b.c and axbxc', 'a.b.c')).toEqual(['a.b.c']);
    expect(found('C++ and C+++ and Cxx', 'C++')).toEqual(['C++', 'C++']);
  });

  it('ignores spaces around the title and matches any run of spaces between its words', () => {
    expect(found('the garden \t plan', '  Garden plan  ')).toEqual(['garden \t plan']);
  });

  it('stops at the given number of mentions, in order', () => {
    const text = 'Idea '.repeat(80);
    const mentions = findMentions(text, 'Idea', 50);
    expect(mentions).toHaveLength(50);
    expect(mentions.map((m) => m.start)).toEqual([...mentions.map((m) => m.start)].sort((a, b) => a - b));
  });

  it('makes no pattern for titles too short or that a link can’t hold', () => {
    for (const title of ['', '  ', 'AI', ' AI ', 'C#', 'Plan [v2]', 'A|B', 'Line\nbreak']) expect(mentionPattern(title), title).toBeNull();
    expect(mentionPattern('Ana')).not.toBeNull();
  });
});

describe('text that already links or isn’t prose', () => {
  const title = 'Garden plan';

  it('leaves out every kind of link and embed', () => {
    const text = [
      '[[Garden plan]] [[garden plan#Beds]] [[x|Garden plan]] ![[Garden plan]]',
      '[Garden plan](/note/abc123def) ![Garden plan](/api/files/abc/p.png)',
      '<https://garden-plan.test/Garden plan> https://example.com/Garden plan',
      '<a href="x">and</a> <abbr title="Garden plan">GP</abbr>',
    ].join('\n');
    expect(found(text, title)).toEqual([]);
  });

  it('leaves out code spans and fenced blocks of either kind', () => {
    expect(found('`Garden plan` ``Garden plan``\n\n~~~\nGarden plan\n~~~\n```\nGarden plan\n```', title)).toEqual([]);
  });

  it('leaves out a task’s due date, so a journal entry titled with that day isn’t “mentioned” by it', () => {
    const text = '- [ ] Pay rent 📅 2026-11-20\n- [ ] File due:2026-11-20\nWe met on 2026-11-20.';
    expect(findMentions(text, '2026-11-20').map((m) => text.slice(0, m.start).split('\n').length)).toEqual([3]);
  });

  it('counts text inside HTML elements, which reading view shows as prose', () => {
    expect(found('<b>Garden plan</b>', title)).toEqual(['Garden plan']);
  });

  it('leaves out a link whose address has parentheses in it', () => {
    expect(found('See [Python](https://en.wikipedia.org/wiki/Python_(programming_language)) for more.', 'Python')).toEqual([]);
  });

  it('leaves out what reading view links on its own, such as an email address', () => {
    expect(found('Write to me@github.com or see https://github.com/me', 'GitHub')).toEqual([]);
    // Reading view (markdown-it's linkify, fuzzy links off) leaves a bare domain as text, so it's prose here too.
    expect(found('Clone github.com/me/repo', 'GitHub')).toEqual(['github']);
  });

  it('keeps every offset when blanking, whatever the text holds', () => {
    const text = 'é `ç` [[ü|ö]] <i>ñ</i> [a](b) https://x.y/ü\n```\n日本\n```\n😀 end';
    const mask = proseMask(text);
    expect(mask).toHaveLength(text.length);
    expect(mask.endsWith('😀 end')).toBe(true);
  });
});

describe('turning a mention into a link', () => {
  it('links it as written when the case matches, with an alias when it doesn’t', () => {
    const text = 'Garden plan, garden plan, GARDEN  PLAN.';
    const [a, b, c] = findMentions(text, 'Garden plan');
    expect(linkMention(text, 'Garden plan', a)).toBe('[[Garden plan]], garden plan, GARDEN  PLAN.');
    expect(linkMention(text, 'Garden plan', b)).toBe('Garden plan, [[Garden plan|garden plan]], GARDEN  PLAN.');
    expect(linkMention(text, 'Garden plan', c)).toBe('Garden plan, garden plan, [[Garden plan|GARDEN  PLAN]].');
  });

  it('uses the title without the spaces around it', () => {
    const text = 'see Ideas';
    expect(linkMention(text, '  Ideas ', findMentions(text, '  Ideas ')[0])).toBe('see [[Ideas]]');
  });

  it('changes nothing else in the note', () => {
    const text = 'a\n\n```\nIdeas\n```\nIdeas `Ideas` [[Ideas]]';
    const [m] = findMentions(text, 'Ideas');
    expect(linkMention(text, 'Ideas', m)).toBe('a\n\n```\nIdeas\n```\n[[Ideas]] `Ideas` [[Ideas]]');
  });
});

describe('the snippet shown for a mention', () => {
  it('shows ellipses only where the text was cut mid-line', () => {
    const text = `${'word '.repeat(30)}Garden plan${' more'.repeat(30)}`;
    const s = snippetAround(text, findMentions(text, 'Garden plan')[0], 20);
    expect(s.before.startsWith('…')).toBe(true);
    expect(s.after.endsWith('…')).toBe(true);
    expect(s.match).toBe('Garden plan');
  });

  it('starts at the beginning of the note without an ellipsis', () => {
    expect(snippetAround('Garden plan now', { start: 0, end: 11 })).toEqual({ before: '', match: 'Garden plan', after: ' now' });
  });

  it('stays within its paragraph and drops formatting', () => {
    const text = 'Other paragraph.\n\nA ~~very~~ `big` [[Bed|bed]] for the *Garden plan* here.\n\nNext paragraph.';
    const s = snippetAround(text, findMentions(text, 'Garden plan')[0]);
    expect(s).toEqual({ before: 'A very big bed for the ', match: 'Garden plan', after: ' here.' });
  });
});

describe('cost on hostile text', () => {
  const cases: Array<[string, string, string]> = [
    ['the first word of a title over and over', 'garden '.repeat(50_000), 'Garden plan'],
    ['a long title against a text of its words', 'a b c d e f '.repeat(20_000), 'a b c d e f g'],
    ['many backtick runs', '` `` ``` '.repeat(20_000), 'Garden plan'],
    ['many wiki-link openers', '[[garden '.repeat(20_000), 'Garden plan'],
    ['many web addresses', 'https://garden '.repeat(20_000), 'Garden plan'],
  ];
  for (const [name, text, title] of cases) {
    it(`stays quick on ${name}`, { retry: 2 }, () => {
      const start = performance.now();
      findMentions(text, title);
      expectQuick(performance.now() - start, 500);
    });
  }
});

/* ------------------------------------------------- the list and Link --- */

const meta = (id: string, title: string, updated_at = 1, deleted_at: number | null = null) => ({ id, title, updated_at, deleted_at, tags: [] });

function library(notes: Array<ReturnType<typeof meta>>, texts: Record<string, string>) {
  h.useApp.setState({ notes: Object.fromEntries(notes.map((n) => [n.id, n])) });
  h.texts.clear();
  for (const [id, text] of Object.entries(texts)) h.texts.set(id, text);
}

beforeEach(() => {
  h.toast.mockReset();
  h.syncLibrary.mockReset();
  h.syncLibrary.mockResolvedValue(undefined);
});

describe('the Mentions list', () => {
  it('lists other notes that name the title, most recently edited first, with counts and a snippet', async () => {
    library(
      [meta('me', 'Garden plan'), meta('old', 'Old', 1), meta('new', 'New', 5), meta('linked', 'Linked', 9), meta('trash', 'Trash', 10, 99), meta('none', 'None', 3)],
      {
        me: 'Garden plan mentions itself',
        old: 'The garden plan.',
        new: 'Garden plan twice: garden plan.',
        linked: 'Only [[Garden plan]] here',
        trash: 'garden plan in the trash',
        none: 'Nothing here',
      },
    );
    const hits = await unlinkedMentions('me');
    expect(h.syncLibrary).toHaveBeenCalledTimes(1);
    expect(hits.map((x) => [x.id, x.count])).toEqual([
      ['new', 2],
      ['old', 1],
    ]);
    expect(hits[1].snippet).toEqual({ before: 'The ', match: 'garden plan', after: '.' });
  });

  it('still lists what this device has when it can’t sync', async () => {
    h.syncLibrary.mockRejectedValue(new Error('offline'));
    library([meta('me', 'Ideas'), meta('o', 'O')], { o: 'some ideas' });
    expect((await unlinkedMentions('me')).map((x) => x.id)).toEqual(['o']);
  });

  it('skips notes whose text this device doesn’t have', async () => {
    library([meta('me', 'Ideas'), meta('o', 'O')], {});
    expect(await unlinkedMentions('me')).toEqual([]);
  });

  it('doesn’t look for titles that can’t be mentioned', async () => {
    library([meta('me', 'AI'), meta('o', 'O')], { o: 'AI everywhere' });
    expect(await unlinkedMentions('me')).toEqual([]);
    expect(h.syncLibrary).not.toHaveBeenCalled();
  });

  it('lists at most 50 notes and counts at most 20 mentions in each', async () => {
    const notes = [meta('me', 'Ideas'), ...Array.from({ length: 60 }, (_, i) => meta(`n${i}`, `N${i}`, i))];
    library(notes, Object.fromEntries(notes.slice(1).map((n) => [n.id, 'ideas '.repeat(30)])));
    const hits = await unlinkedMentions('me');
    expect(hits).toHaveLength(50);
    expect(hits.every((x) => x.count === 20)).toBe(true);
  });
});

describe('the Link button', () => {
  const undo = () => (h.toast.mock.calls.at(-1)![1] as { action: { run: () => void } }).action.run();

  it('links the first unlinked mention and offers Undo', () => {
    library([meta('o', 'Other')], { o: '`Ideas` then ideas, and Ideas' });
    expect(linkFirstMention('o', 'Ideas')).toBe(true);
    expect(h.texts.get('o')).toBe('`Ideas` then [[Ideas|ideas]], and Ideas');
    expect(h.toast).toHaveBeenCalledWith('Linked in “Other”', expect.objectContaining({ kind: 'success' }));
    undo();
    expect(h.texts.get('o')).toBe('`Ideas` then ideas, and Ideas');
  });

  it('links the next one when pressed again', () => {
    library([meta('o', '')], { o: 'Ideas and Ideas' });
    linkFirstMention('o', 'Ideas');
    linkFirstMention('o', 'Ideas');
    expect(h.texts.get('o')).toBe('[[Ideas]] and [[Ideas]]');
    expect(h.toast.mock.calls[0][0]).toBe('Linked in “Untitled”');
  });

  it('leaves a note edited since alone on Undo', () => {
    library([meta('o', 'O')], { o: 'Ideas' });
    linkFirstMention('o', 'Ideas');
    h.texts.set('o', '[[Ideas]] and more typed since');
    undo();
    expect(h.texts.get('o')).toBe('[[Ideas]] and more typed since');
  });

  it('says so when there is nothing left to link', () => {
    library([meta('o', 'O')], { o: '[[Ideas]] only' });
    expect(linkFirstMention('o', 'Ideas')).toBe(false);
    expect(h.toast).not.toHaveBeenCalled();
    expect(linkFirstMention('missing', 'Ideas')).toBe(false);
  });
});
