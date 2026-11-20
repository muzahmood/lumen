/**
 * Renaming a note: Lumen offers to update the [[links]] that still use its old title ([[Old]],
 * [[Old#Heading]], [[Old|alias]]), outside code, with Undo. The text rules (src/lib/wikilinks.ts) on
 * every way a link is written, then the offer itself (src/lib/relink.ts) with the app's state stubbed.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { linksTo, relinkText } from '../../src/lib/wikilinks';

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

const { offerLinkUpdate } = await import('../../src/lib/relink');

describe('rewriting links to a renamed note', () => {
  it('updates plain, heading, alias, heading-with-alias and embedded links', () => {
    const src = '[[Old]] [[Old#Plan]] [[Old|label]] [[Old#Plan|label]] ![[Old]] ![[Old|300]]';
    expect(relinkText(src, 'Old', 'New')).toBe('[[New]] [[New#Plan]] [[New|label]] [[New#Plan|label]] ![[New]] ![[New|300]]');
  });

  it('matches the old title in any case and with spaces inside the brackets', () => {
    expect(relinkText('[[OLD]] [[old]] [[ Old ]] [[\tOld\t|x]] [[ old #h]]', 'Old', 'New')).toBe('[[New]] [[New]] [[New]] [[New|x]] [[New#h]]');
  });

  it('matches accented titles in any case', () => {
    expect(relinkText('[[ÉTÉ]] [[été|summer]]', 'Été', 'Summer')).toBe('[[Summer]] [[Summer|summer]]');
  });

  it('leaves links to other notes alone, including ones that contain the old title', () => {
    const src = '[[Old2]] [[Older]] [[My Old]] [[Old.md]] [[Old notes|Old]] [Old](/note/abc123def) Old';
    expect(relinkText(src, 'Old', 'New')).toBe(src);
  });

  it('treats regex characters in the old title as text', () => {
    expect(relinkText('[[C++ (v2.0)?]] [[C++ (v2x0)?]] [[a*b]] [[aab]] [[^x$]] [[\\d]]', 'C++ (v2.0)?', 'X')).toBe(
      '[[X]] [[C++ (v2x0)?]] [[a*b]] [[aab]] [[^x$]] [[\\d]]',
    );
    expect(relinkText('[[a*b]] [[aab]] [[^x$]] [[\\d]] [[d]]', 'a*b', 'Y')).toBe('[[Y]] [[aab]] [[^x$]] [[\\d]] [[d]]');
    expect(relinkText('[[^x$]] [[\\d]] [[d]]', '\\d', 'Z')).toBe('[[^x$]] [[Z]] [[d]]');
  });

  it('writes $ in the new title literally', () => {
    expect(relinkText('[[Old]]', 'Old', '$& $1 $$ $`')).toBe("[[$& $1 $$ $`]]");
  });

  it('updates every link on a line and across paragraphs', () => {
    expect(relinkText('[[Old]][[Old]]\n\n> [[old|a]]\n- [ ] [[Old#x]]', 'Old', 'New')).toBe('[[New]][[New]]\n\n> [[New|a]]\n- [ ] [[New#x]]');
  });

  it('never touches code: spans, fences of either kind, longer fences and indented ones', () => {
    const src = [
      '`[[Old]]` ``[[Old]] ` `` [[Old]]',
      '',
      '```',
      '[[Old]]',
      '```',
      '~~~md',
      '[[Old]]',
      '```',
      '[[Old]]',
      '~~~',
      '````',
      '```',
      '[[Old]]',
      '```',
      '````',
      '  ```',
      '  [[Old]]',
      '  ```',
      '[[Old]]',
    ].join('\n');
    const out = relinkText(src, 'Old', 'New').split('\n');
    expect(out[0]).toBe('`[[Old]]` ``[[Old]] ` `` [[New]]');
    expect(out.slice(1, -1).join('\n')).toBe(src.split('\n').slice(1, -1).join('\n'));
    expect(out.at(-1)).toBe('[[New]]');
  });

  it('leaves a code block inside a quote alone', () => {
    expect(relinkText('> ```\n> [[Old]]\n> ```\n\n[[Old]]', 'Old', 'New')).toBe('> ```\n> [[Old]]\n> ```\n\n[[New]]');
  });

  it('leaves code alone in a quote or callout across a blank quoted line, and under a list item', () => {
    const quoted = '> [!example]\n> ```\n> [[Old]]\n>\n> [[Old]]\n> ```\n\n[[Old]]';
    expect(relinkText(quoted, 'Old', 'New')).toBe('> [!example]\n> ```\n> [[Old]]\n>\n> [[Old]]\n> ```\n\n[[New]]');
    const listed = '- Example:\n\n    ```\n    [[Old]]\n\n    [[Old]]\n    ```\n- [[Old]]';
    expect(relinkText(listed, 'Old', 'New')).toBe('- Example:\n\n    ```\n    [[Old]]\n\n    [[Old]]\n    ```\n- [[New]]');
  });

  it('still updates links in nested bullets and quotes, after a quoted fence ends with its quote, and beside ```code``` in a line', () => {
    expect(relinkText('- a\n    - [[Old]]\n> [[Old]]', 'Old', 'New')).toBe('- a\n    - [[New]]\n> [[New]]');
    expect(relinkText('> ```\n> code\n\n[[Old]]', 'Old', 'New')).toBe('> ```\n> code\n\n[[New]]');
    expect(relinkText('```inline``` [[Old]]\n\n[[Old]]', 'Old', 'New')).toBe('```inline``` [[New]]\n\n[[New]]');
  });

  it('isn’t confused by a lone backtick in an earlier paragraph', () => {
    expect(relinkText('Press ` to start.\n\n[[Old]] and `x`', 'Old', 'New')).toBe('Press ` to start.\n\n[[New]] and `x`');
  });

  it('is undone by renaming back, for the links it changed', () => {
    const src = 'See [[Old]], [[old|label]] and [[Old#H]].';
    const there = relinkText(src, 'Old', 'New');
    expect(relinkText(there, 'New', 'Old')).toBe('See [[Old]], [[Old|label]] and [[Old#H]].');
  });
});

describe('telling whether a note links to a title', () => {
  it('answers the same however many times it’s asked', () => {
    const src = 'x [[Plan]]';
    expect([linksTo(src, 'Plan'), linksTo(src, 'Plan'), linksTo(src, 'plan')]).toEqual([true, true, true]);
  });

  it('sees links in later paragraphs after one with only code', () => {
    expect(linksTo('`[[Plan]]`\n\nthen [[Plan|x]]', 'Plan')).toBe(true);
    expect(linksTo('`[[Plan]]`\n\n```\n[[Plan]]\n```', 'Plan')).toBe(false);
  });
});

/* ----------------------------------------------- the offer to update --- */

const meta = (id: string, title: string, deleted_at: number | null = null) => ({ id, title, deleted_at, updated_at: 1, tags: [] });

function library(notes: Array<ReturnType<typeof meta>>, texts: Record<string, string>) {
  h.useApp.setState({ notes: Object.fromEntries(notes.map((n) => [n.id, n])) });
  h.texts.clear();
  for (const [id, text] of Object.entries(texts)) h.texts.set(id, text);
}

type ToastOpts = { action?: { label: string; run: () => void }; kind?: string; timeout?: number };
const lastToast = () => h.toast.mock.calls.at(-1) as [string, ToastOpts | undefined];

beforeEach(() => {
  h.toast.mockReset();
  h.syncLibrary.mockReset();
  h.syncLibrary.mockResolvedValue(undefined);
});

describe('offering to update links after a rename', () => {
  it('counts the notes that link by the old title and updates them on request', async () => {
    library([meta('r', 'New'), meta('a', 'A'), meta('b', 'B'), meta('c', 'C')], {
      a: 'See [[Old]] and [[old#Plan|the plan]]',
      b: 'Also ![[Old]]',
      c: 'Only `[[Old]]` in code, and the word Old',
    });
    await offerLinkUpdate('r', 'Old', 'New');
    const [message, opts] = lastToast();
    expect(message).toBe('2 notes link to this note as “Old”. Update them to “New”?');
    expect(opts?.timeout).toBe(15_000);
    opts!.action!.run();
    expect(h.texts.get('a')).toBe('See [[New]] and [[New#Plan|the plan]]');
    expect(h.texts.get('b')).toBe('Also ![[New]]');
    expect(h.texts.get('c')).toBe('Only `[[Old]]` in code, and the word Old');
    expect(lastToast()[0]).toBe('Updated links in 2 notes');
  });

  it('words the offer for a single note', async () => {
    library([meta('r', 'New'), meta('a', 'A')], { a: '[[Old]]' });
    await offerLinkUpdate('r', 'Old', 'New');
    expect(lastToast()[0]).toBe('A note links to this note as “Old”. Update it to “New”?');
  });

  it('updates the renamed note’s links to itself too', async () => {
    library([meta('r', 'New')], { r: 'Back to [[Old#Top]]' });
    await offerLinkUpdate('r', 'Old', 'New');
    lastToast()[1]!.action!.run();
    expect(h.texts.get('r')).toBe('Back to [[New#Top]]');
  });

  it('doesn’t offer while another note still has the old title, in any case', async () => {
    library([meta('r', 'New'), meta('twin', ' old '), meta('a', 'A')], { a: '[[Old]]' });
    await offerLinkUpdate('r', 'Old', 'New');
    expect(h.toast).not.toHaveBeenCalled();
  });

  it('does offer when the other note with the old title is in the trash', async () => {
    library([meta('r', 'New'), meta('twin', 'Old', 5), meta('a', 'A')], { a: '[[Old]]' });
    await offerLinkUpdate('r', 'Old', 'New');
    expect(h.toast).toHaveBeenCalledTimes(1);
  });

  it('leaves trashed notes’ links alone', async () => {
    library([meta('r', 'New'), meta('t', 'T', 5)], { t: '[[Old]]' });
    await offerLinkUpdate('r', 'Old', 'New');
    expect(h.toast).not.toHaveBeenCalled();
  });

  it('doesn’t offer for titles a link can’t hold', async () => {
    library([meta('r', 'x'), meta('a', 'A')], { a: '[[Old]] [[Old#1]]' });
    for (const [from, to] of [
      ['Old', 'New [draft]'],
      ['Old', 'A|B'],
      ['Old', 'C#'],
      ['Old#1', 'New'],
    ]) {
      await offerLinkUpdate('r', from, to);
    }
    expect(h.toast).not.toHaveBeenCalled();
  });

  it('still offers, from this device’s copies, when it can’t sync', async () => {
    h.syncLibrary.mockRejectedValue(new Error('offline'));
    library([meta('r', 'New'), meta('a', 'A'), meta('unread', 'U')], { a: '[[Old]]' });
    await offerLinkUpdate('r', 'Old', 'New');
    expect(lastToast()[0]).toMatch(/^A note links/);
  });

  it('says so when the links were changed meanwhile', async () => {
    library([meta('r', 'New'), meta('a', 'A')], { a: '[[Old]]' });
    await offerLinkUpdate('r', 'Old', 'New');
    const run = lastToast()[1]!.action!.run;
    h.texts.set('a', 'edited elsewhere');
    run();
    expect(lastToast()[0]).toBe('Those links were already changed.');
  });

  it('puts each note back exactly on Undo when nothing changed since', async () => {
    library([meta('r', 'New'), meta('a', 'A')], { a: 'x [[old|label]] [[ Old ]] y' });
    await offerLinkUpdate('r', 'Old', 'New');
    lastToast()[1]!.action!.run();
    expect(h.texts.get('a')).toBe('x [[New|label]] [[New]] y');
    lastToast()[1]!.action!.run();
    expect(h.texts.get('a')).toBe('x [[old|label]] [[ Old ]] y');
  });

  it('turns only the links back on Undo when the note was edited since', async () => {
    library([meta('r', 'New'), meta('a', 'A')], { a: '[[Old]]' });
    await offerLinkUpdate('r', 'Old', 'New');
    lastToast()[1]!.action!.run();
    h.texts.set('a', '[[New]] plus a new line');
    lastToast()[1]!.action!.run();
    expect(h.texts.get('a')).toBe('[[Old]] plus a new line');
  });
});
