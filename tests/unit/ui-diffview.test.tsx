// @vitest-environment jsdom
/**
 * The comparison of two versions (src/components/DiffView.tsx), as version history and the conflict
 * banner's Compare show it: lines only in one side marked, changed words marked, unchanged stretches
 * folded (and unfolded on a click), a changed title shown, and plain words when there's nothing to show.
 */
import { allByName, byName, click, mount, text, unmountAll } from './ui-note-helpers';
import { afterEach, describe, expect, it } from 'vitest';
import { DiffView } from '../../src/components/DiffView';

afterEach(unmountAll);

const show = (before: { title: string; content: string }, after: { title: string; content: string }) =>
  mount(<DiffView before={before} after={after} beforeLabel="In this version" afterLabel="In the note now" />);

const lines = (root: ParentNode, op: 'add' | 'del' | 'same') =>
  Array.from(root.querySelectorAll(`.diff > .diff-line.is-${op} .diff-text`)).map((el) => el.textContent);

describe('comparing two versions', () => {
  it('marks lines only in the older version as removed and lines only in the newer one as added', async () => {
    const { container } = await show({ title: 'Plan', content: 'one\ntwo\nthree' }, { title: 'Plan', content: 'one\nthree\nfour' });
    expect(lines(container, 'del')).toEqual(['two']);
    expect(lines(container, 'add')).toEqual(['four']);
    expect(text(container)).toContain('− In this version');
    expect(text(container)).toContain('+ In the note now');
    expect(container.querySelector('.diff-count')?.textContent).toMatch(/\+1\s*−1\s*lines/);
  });

  it('marks the words that changed within a line', async () => {
    const { container } = await show({ title: 'A', content: 'the quick brown fox' }, { title: 'A', content: 'the quick red fox' });
    const marked = Array.from(container.querySelectorAll('.diff mark')).map((m) => m.textContent?.trim());
    expect(marked).toContain('brown');
    expect(marked).toContain('red');
  });

  it('folds a long unchanged stretch, and shows it on a click', async () => {
    const same = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\n');
    const { container } = await show({ title: 'A', content: `start\n${same}\nend` }, { title: 'A', content: `begin\n${same}\nfinish` });
    const fold = byName(/unchanged lines$/, 'button.diff-fold', container);
    const hidden = Number(/(\d+) unchanged/.exec(fold.textContent ?? '')![1]);
    expect(hidden).toBeGreaterThan(0);
    expect(text(container)).not.toContain('line 15');
    await click(fold);
    expect(text(container)).toContain('line 15');
    expect(allByName(/unchanged lines$/, 'button.diff-fold', container)).toHaveLength(0);
  });

  it('shows a changed title, and an empty one as Untitled', async () => {
    const { container } = await show({ title: '', content: 'same' }, { title: 'Named', content: 'same' });
    const title = container.querySelector('.diff-title')!;
    expect(title.querySelector('.is-del')?.textContent).toContain('Untitled');
    expect(title.querySelector('.is-add')?.textContent).toContain('Named');
  });

  it('says so when nothing differs, rather than showing an empty comparison', async () => {
    const { container } = await show({ title: 'A', content: 'same\ntext' }, { title: ' A ', content: 'same\ntext' });
    expect(text(container)).toContain('No differences: the text is the same in both.');
    expect(container.querySelector('.diff')).toBeNull();
  });

  it('names the comparison for screen readers and hides the +/− signs from them', async () => {
    const { container } = await show({ title: 'A', content: 'a' }, { title: 'A', content: 'b' });
    expect(container.querySelector('.diff')?.getAttribute('aria-label')).toBe('Changes');
    for (const sign of container.querySelectorAll('.diff-sign')) expect(sign.getAttribute('aria-hidden')).toBe('true');
  });
});
