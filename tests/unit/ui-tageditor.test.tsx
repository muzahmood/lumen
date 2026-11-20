// @vitest-environment jsdom
/**
 * A note's tags under its title (src/components/TagEditor.tsx): adding by typing (Enter, Tab, a comma
 * or leaving the box), removing with each tag's button or Backspace, suggestions from tags other notes
 * use, Escape to drop what was typed, and a read-only list for notes in the trash.
 */
import { allByName, blur, byName, click, mount, press, queryByName, typeInto, unmountAll } from './ui-note-helpers';
import { useState } from 'react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TagEditor } from '../../src/components/TagEditor';
import { useApp } from '../../src/lib/store';
import type { NoteMeta } from '../../src/lib/types';

const meta = (id: string, tags: string[], deleted = false): NoteMeta => ({
  id,
  folder_id: null,
  title: id,
  excerpt: '',
  info: {},
  tags,
  pinned: false,
  version: 1,
  created_at: 1,
  updated_at: 1,
  deleted_at: deleted ? 2 : null,
});

let changes: string[][] = [];

function Harness({ initial, readOnly }: { initial: string[]; readOnly?: boolean }) {
  const [tags, setTags] = useState(initial);
  return (
    <TagEditor
      tags={tags}
      readOnly={readOnly}
      onChange={(next) => {
        changes.push(next);
        setTags(next);
      }}
    />
  );
}

const input = () => byName<HTMLInputElement>('Add tag', 'input');
const shown = () => Array.from(document.querySelectorAll('.tag')).map((t) => t.textContent);

beforeEach(() => {
  changes = [];
  useApp.setState({
    notes: {
      a: meta('a', ['work', 'ideas']),
      b: meta('b', ['work', 'reading']),
      c: meta('c', ['old'], true),
    },
  });
});
afterEach(async () => {
  vi.useRealTimers();
  await unmountAll();
});

describe('adding tags', () => {
  it('adds what was typed on Enter, without a leading # and with spaces as dashes', async () => {
    await mount(<Harness initial={[]} />);
    await typeInto(input(), '#reading list');
    await press('Enter', {}, input());
    expect(changes).toEqual([['reading-list']]);
    expect(shown()).toEqual(['reading-list']);
    expect(input().value).toBe('');
  });

  it('adds on a comma, so several can be typed in a row', async () => {
    await mount(<Harness initial={['a']} />);
    await typeInto(input(), 'b,');
    await typeInto(input(), 'c,');
    expect(shown()).toEqual(['a', 'b', 'c']);
  });

  it('adds on Tab when something was typed, and lets Tab move on when nothing was', async () => {
    await mount(<Harness initial={[]} />);
    await typeInto(input(), 'later');
    const handled = await press('Tab', {}, input());
    expect(handled.defaultPrevented).toBe(true);
    expect(shown()).toEqual(['later']);
    const passed = await press('Tab', {}, input());
    expect(passed.defaultPrevented).toBe(false);
  });

  it('adds what was typed when the box is left', async () => {
    vi.useFakeTimers();
    await mount(<Harness initial={[]} />);
    await typeInto(input(), 'draft');
    await blur(input());
    expect(shown()).toEqual(['draft']);
  });

  it('ignores a tag the note already has, in any case', async () => {
    await mount(<Harness initial={['Work']} />);
    await typeInto(input(), 'work');
    await press('Enter', {}, input());
    expect(changes).toEqual([]);
    expect(shown()).toEqual(['Work']);
  });

  it('ignores a blank tag or a lone #', async () => {
    await mount(<Harness initial={[]} />);
    await typeInto(input(), '  # ');
    await press('Enter', {}, input());
    await typeInto(input(), '##');
    await press('Enter', {}, input());
    expect(changes).toEqual([]);
  });

  it('cleans a tag the way the rest of Lumen does: "# job" is "job"', async () => {
    await mount(<Harness initial={[]} />);
    await typeInto(input(), '# job');
    await press('Enter', {}, input());
    expect(changes).toEqual([['job']]);
  });

  it('drops what was typed on Escape, without adding it', async () => {
    vi.useFakeTimers();
    await mount(<Harness initial={['kept']} />);
    await typeInto(input(), 'oops');
    await press('Escape', {}, input());
    expect(input().value).toBe('');
    expect(changes).toEqual([]);
    expect(shown()).toEqual(['kept']);
  });
});

describe('suggestions', () => {
  it('suggests tags other notes use, most used first, leaving out ones the note has and ones only in the trash', async () => {
    await mount(<Harness initial={['ideas']} />);
    await act(async () => input().focus());
    const options = allByName(/^#/, '[role="option"]');
    expect(options.map((o) => o.textContent)).toEqual(['#work', '#reading']);
    expect(document.querySelector('[role="listbox"]')).not.toBeNull();
  });

  it('narrows the suggestions to what was typed, and adds one on a click', async () => {
    await mount(<Harness initial={[]} />);
    await typeInto(input(), 'rea');
    expect(allByName(/^#/, '[role="option"]').map((o) => o.textContent)).toEqual(['#reading']);
    await click(byName('#reading', '[role="option"]'));
    expect(changes).toEqual([['reading']]);
    expect(input().value).toBe('');
  });
});

describe('removing tags', () => {
  it('removes a tag with its own button, named for the tag', async () => {
    await mount(<Harness initial={['one', 'two']} />);
    await click(byName('Remove tag one'));
    expect(changes).toEqual([['two']]);
    expect(shown()).toEqual(['two']);
  });

  it('removes the last tag on Backspace in an empty box, but not while something is typed', async () => {
    await mount(<Harness initial={['one', 'two']} />);
    await typeInto(input(), 'x');
    await press('Backspace', {}, input());
    expect(changes).toEqual([]);
    await typeInto(input(), '');
    await press('Backspace', {}, input());
    expect(changes).toEqual([['one']]);
  });
});

describe('read only (a note in the trash)', () => {
  it('lists the tags with no way to change them', async () => {
    await mount(<Harness initial={['one']} readOnly />);
    expect(shown()).toEqual(['one']);
    expect(queryByName('Add tag', 'input')).toBeNull();
    expect(queryByName('Remove tag one')).toBeNull();
  });

  it('shows nothing at all when there are no tags', async () => {
    const { container } = await mount(<Harness initial={[]} readOnly />);
    expect(container.innerHTML).toBe('');
  });
});
