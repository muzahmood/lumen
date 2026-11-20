// @vitest-environment jsdom
/**
 * Changing a note from outside its editor (ticking a task in the Tasks view, a journal capture) while
 * an earlier change is still being saved: the new change is made on top of the one on its way, never
 * on the text from before it, which would undo it on the server without any conflict.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const calls: Array<{ id: string; patch: Record<string, unknown> }> = [];
let release: Array<() => void> = [];
let version = 1;

vi.mock('../../src/lib/api', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/lib/api')>();
  return {
    ...real,
    api: {
      ...real.api,
      // Each save waits until the test lets it through, then answers with the next version.
      updateNote: (id: string, patch: Record<string, unknown>) => {
        calls.push({ id, patch });
        return new Promise((resolve) =>
          release.push(() => {
            version += 1;
            resolve({ id, title: 'Plan', version, updated_at: Date.now(), created_at: 1, folder_id: null, tags: [], pinned: false, excerpt: '' });
          }),
        );
      },
    },
  };
});

window.matchMedia ??= ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;

const { changeNoteText, knownText } = await import('../../src/lib/liveEdit');
const { flush } = await import('../../src/lib/saver');
const { noteCache, upsertMeta } = await import('../../src/lib/store');

afterEach(() => {
  calls.length = 0;
  release = [];
});

describe('a change made while another is being saved', () => {
  it('is made on top of the one on its way, and saved after it', async () => {
    const id = 'note12345678';
    const meta = { id, title: 'Plan', version: 1, updated_at: 1, created_at: 1, folder_id: null, tags: [], pinned: false, excerpt: '' };
    upsertMeta(meta as never);
    noteCache.set(id, { ...meta, content: '- [ ] one\n- [ ] two' } as never);

    changeNoteText(id, (s) => s.replace('[ ] one', '[x] one'));
    const first = flush(id);
    await vi.waitFor(() => expect(calls).toHaveLength(1));

    // The first save is still on its way.
    expect(knownText(id)).toEqual({ content: '- [x] one\n- [ ] two', version: 1 });
    changeNoteText(id, (s) => s.replace('[ ] two', '[x] two'));

    release.shift()!();
    await first;
    const second = flush(id);
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[1].patch).toMatchObject({ content: '- [x] one\n- [x] two', baseVersion: 2 });
    release.shift()!();
    await second;
    expect(knownText(id)).toEqual({ content: '- [x] one\n- [x] two', version: 3 });
  });

  it('never pairs an older cached text with a newer version', () => {
    const id = 'note87654321';
    const meta = { id, title: 'Plan', version: 5, updated_at: 1, created_at: 1, folder_id: null, tags: [], pinned: false, excerpt: '' };
    noteCache.set(id, { ...meta, content: 'old text' } as never);
    // Another device saved version 6; only its details arrived here (a move, a tag), not its text.
    upsertMeta({ ...meta, version: 6 } as never);
    expect(knownText(id)).toBeNull();
  });
});
