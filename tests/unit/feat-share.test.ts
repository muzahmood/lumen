// @vitest-environment jsdom
/**
 * Sharing into Lumen and the home-screen shortcuts (src/lib/launch.ts): what a shared text, link and
 * files become, and how waiting shares are offered (save, discard, or later, oldest first, a week at
 * most). The service worker's share cache is played by an in-memory one shaped like public/sw.js
 * leaves it; the store, uploads and API are stubbed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  chooseDialog: vi.fn(async (_opts: { message: string }): Promise<'confirm' | 'alt' | null> => 'confirm'),
  createNote: vi.fn(async (init: Record<string, unknown>, _opts?: unknown) => ({ id: 'n1', ...init })),
  newNote: vi.fn(async () => undefined),
  openDailyNote: vi.fn(async () => undefined),
  toast: vi.fn(),
  setState: vi.fn(),
  uploadForNote: vi.fn(async (file: File, _noteId: string | null) => ({ markdown: `![${file.name}](/api/files/up${file.name.length}/${file.name})` })),
}));

vi.mock('../../src/lib/store', () => ({
  chooseDialog: h.chooseDialog,
  createNote: h.createNote,
  newNote: h.newNote,
  openDailyNote: h.openDailyNote,
  toast: h.toast,
  useApp: { setState: h.setState, getState: () => ({}) },
}));
vi.mock('../../src/lib/upload', () => ({ uploadForNote: h.uploadForNote }));
vi.mock('../../src/lib/api', () => ({ errorMessage: (err: unknown) => (err instanceof Error ? err.message : String(err)) }));

/* ------------------------------------------------ a share cache in memory --- */

type Stored = { json?: () => Promise<unknown>; blob?: () => Promise<Blob> };

class MemoryCache {
  entries = new Map<string, Stored>();
  private key = (req: string | { url: string }) => new URL(typeof req === 'string' ? req : req.url, location.origin).href;
  async keys() {
    return [...this.entries.keys()].map((url) => ({ url }));
  }
  async match(req: string | { url: string }) {
    return this.entries.get(this.key(req));
  }
  async delete(req: string | { url: string }) {
    return this.entries.delete(this.key(req));
  }
  /** A share as the service worker stores it: its files at /0, /1… and then its meta. */
  share(id: string, meta: unknown, files: Array<{ name: string; type: string; body: string }> = []) {
    files.forEach((f, i) => this.entries.set(this.key(`/__kb/share/${id}/${i}`), { blob: async () => new Blob([f.body], { type: f.type }) }));
    this.entries.set(this.key(`/__kb/share/${id}/meta`), { json: async () => meta });
  }
  ids() {
    return [...new Set([...this.entries.keys()].map((u) => new URL(u).pathname.split('/')[3]))];
  }
}

let stores: Map<string, MemoryCache>;
const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 17, 12);
/** A share id as the service worker makes them: base-36 time, then six random characters. */
const idAt = (ms: number, tail = 'abcdef') => ms.toString(36) + tail;
const meta = (fields: Partial<{ title: string; text: string; url: string; files: Array<{ name: string; type: string }> }> = {}) => ({ title: '', text: '', url: '', files: [], ...fields });

async function launch(search = '') {
  window.history.replaceState(null, '', `/${search}`);
  vi.resetModules();
  const { takeLaunchAction } = await import('../../src/lib/launch');
  takeLaunchAction();
  return takeLaunchAction;
}

/** Lets the offering of waiting shares run to its end. */
const settle = async () => {
  for (let i = 0; i < 300; i++) await Promise.resolve();
};

beforeEach(() => {
  vi.clearAllMocks();
  h.chooseDialog.mockImplementation(async () => 'confirm');
  stores = new Map([['kb-share', new MemoryCache()]]);
  const cacheStorage = { keys: async () => [...stores.keys()], open: async (name: string) => stores.get(name)! };
  vi.stubGlobal('caches', cacheStorage);
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const shares = () => stores.get('kb-share')!;

describe('home-screen shortcuts', () => {
  it('opens a new note, today’s journal or search, once, and tidies the address', async () => {
    window.location.hash = '';
    const again = await launch('?do=new&keep=1#frag');
    expect(h.newNote).toHaveBeenCalledTimes(1);
    expect(window.location.pathname + window.location.search + window.location.hash).toBe('/?keep=1#frag');
    again();
    expect(h.newNote).toHaveBeenCalledTimes(1);

    await launch('?do=journal');
    expect(h.openDailyNote).toHaveBeenCalledTimes(1);
    await launch('?do=search');
    expect(h.setState).toHaveBeenCalledWith({ paletteOpen: true });
    expect(window.location.search).toBe('');
  });

  it('says when a share couldn’t be received', async () => {
    await launch('?share=failed');
    expect(h.toast).toHaveBeenCalledWith(expect.stringMatching(/couldn’t receive/), { kind: 'error' });
    await launch('?share=unavailable');
    expect(h.toast).toHaveBeenLastCalledWith(expect.stringMatching(/wasn’t ready/), { kind: 'error' });
  });

  it('leaves the address alone when it asks for nothing', async () => {
    const spy = vi.spyOn(window.history, 'replaceState');
    await launch('?other=1');
    spy.mockClear();
    await settle();
    expect(spy).not.toHaveBeenCalled();
    expect(window.location.search).toBe('?other=1');
  });
});

describe('shares waiting on this device', () => {
  it('asks first, then saves the text, link and files as a note and forgets the share', async () => {
    const id = idAt(NOW - DAY);
    shares().share(id, meta({ title: 'Trip', text: 'Look at this', url: 'https://example.com/a', files: [{ name: 'p.jpg', type: 'image/jpeg' }] }), [{ name: 'p.jpg', type: 'image/jpeg', body: 'jpg' }]);
    await launch(`?share=${id}`);
    await settle();
    expect(h.chooseDialog).toHaveBeenCalledTimes(1);
    expect(h.chooseDialog.mock.calls[0][0].message).toBe('Trip\nLook at this\nhttps://example.com/a\n1 file: p.jpg');
    expect(h.createNote).toHaveBeenCalledWith(
      { title: 'Trip', content: 'Look at this\n\n[Trip](https://example.com/a)\n\n![p.jpg](/api/files/up5/p.jpg)\n', folder_id: null, tags: [], pinned: false },
      { mode: 'read', id: `${id}_note` },
    );
    expect(h.uploadForNote.mock.calls[0][0].type).toBe('image/jpeg');
    expect(h.uploadForNote.mock.calls[0].slice(1)).toEqual([null, true, `${id}_file0`]);
    expect(h.toast).toHaveBeenLastCalledWith('Saved what was shared, with a file');
    expect(shares().entries.size).toBe(0);
  });

  it('forgets a share that is discarded, without saving it', async () => {
    shares().share(idAt(NOW - 1000), meta({ text: 'spam' }));
    h.chooseDialog.mockResolvedValueOnce('alt');
    await launch();
    await settle();
    expect(h.createNote).not.toHaveBeenCalled();
    expect(shares().entries.size).toBe(0);
  });

  it('keeps shares left for later, and asks about none after them until next time', async () => {
    shares().share(idAt(NOW - 2000, 'aaaaaa'), meta({ text: 'first' }));
    shares().share(idAt(NOW - 1000, 'bbbbbb'), meta({ text: 'second' }));
    h.chooseDialog.mockResolvedValueOnce(null);
    await launch();
    await settle();
    expect(h.chooseDialog).toHaveBeenCalledTimes(1);
    expect(h.chooseDialog.mock.calls[0][0].message).toBe('first');
    expect(shares().ids()).toHaveLength(2);
  });

  it('asks about the oldest share first, from this and older versions’ caches', async () => {
    stores.set('lumen-v3-share', new MemoryCache());
    stores.get('lumen-v3-share')!.share(idAt(NOW - 5 * DAY, 'oldver'), meta({ text: 'oldest' }));
    shares().share(idAt(NOW - 1000, 'zzzzzz'), meta({ text: 'newest' }));
    shares().share(idAt(NOW - DAY, 'mmmmmm'), meta({ text: 'middle' }));
    stores.set('other-cache', new MemoryCache());
    stores.get('other-cache')!.share(idAt(NOW, 'xxxxxx'), meta({ text: 'not a share cache' }));
    await launch();
    await settle();
    expect(h.chooseDialog.mock.calls.map(([o]) => o.message)).toEqual(['oldest', 'middle', 'newest']);
  });

  it('drops shares over a week old without asking', async () => {
    shares().share(idAt(NOW - 8 * DAY), meta({ text: 'stale' }), [{ name: 'a.txt', type: 'text/plain', body: 'a' }]);
    shares().share(idAt(NOW - 6 * DAY), meta({ text: 'fresh' }));
    await launch();
    await settle();
    expect(h.chooseDialog.mock.calls.map(([o]) => o.message)).toEqual(['fresh']);
    expect(shares().entries.size).toBe(0);
  });

  it('saves what it can when a file fails to upload, and names the file', async () => {
    shares().share(idAt(NOW - 1000), meta({ text: 'two files', files: [{ name: 'ok.png', type: 'image/png' }, { name: 'big.mov', type: 'video/quicktime' }] }), [
      { name: 'ok.png', type: 'image/png', body: 'x' },
      { name: 'big.mov', type: 'video/quicktime', body: 'y' },
    ]);
    h.uploadForNote.mockImplementation(async (file: File) => {
      if (file.name === 'big.mov') throw new Error('Too large');
      return { markdown: `![${file.name}](/api/files/f/${file.name})` };
    });
    await launch();
    await settle();
    expect(h.createNote.mock.calls[0][0]).toMatchObject({ content: 'two files\n\n![ok.png](/api/files/f/ok.png)\n' });
    expect(h.toast).toHaveBeenLastCalledWith('Saved what was shared, but not “big.mov”: Too large', { kind: 'error', timeout: 12_000 });
    expect(shares().entries.size).toBe(0);
  });

  it('saved again (the reply lost, or closed before it was cleared away), asks for the same note and files', async () => {
    const id = idAt(NOW - 1000);
    const files = [
      { name: 'a.png', type: 'image/png' },
      { name: 'b.pdf', type: 'application/pdf' },
    ];
    shares().share(id, meta({ text: 'twice', files }), files.map((f) => ({ ...f, body: 'x' })));
    // The first time, the note was made but its reply never came back.
    h.createNote.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await launch();
    await settle();
    expect(shares().ids()).toEqual([id]);
    await launch();
    await settle();
    const asked = h.createNote.mock.calls.map((c) => (c[1] as { id: string }).id);
    expect(asked).toEqual([`${id}_note`, `${id}_note`]);
    const uploads = h.uploadForNote.mock.calls.map((c) => c[3]);
    expect(uploads).toEqual([`${id}_file0`, `${id}_file1`, `${id}_file0`, `${id}_file1`]);
    expect(shares().entries.size).toBe(0);
  });

  it('keeps the share for next time when the note can’t be saved', async () => {
    shares().share(idAt(NOW - 1000), meta({ text: 'keep me' }));
    shares().share(idAt(NOW - 500, 'second'), meta({ text: 'and me' }));
    h.createNote.mockRejectedValueOnce(new Error('Locked'));
    await launch();
    await settle();
    expect(h.toast).toHaveBeenLastCalledWith('Couldn’t save what was shared: Locked. It’s kept on this device for next time.', { kind: 'error' });
    expect(shares().ids()).toHaveLength(2);
    expect(h.chooseDialog).toHaveBeenCalledTimes(1);
  });

  it('drops a week-old share whose details can’t be read, with its files', async () => {
    const id = idAt(NOW - 9 * DAY);
    shares().entries.set(new URL(`/__kb/share/${id}/0`, location.origin).href, { blob: async () => new Blob(['big video']) });
    shares().entries.set(new URL(`/__kb/share/${id}/meta`, location.origin).href, {
      json: async () => {
        throw new SyntaxError('Unexpected end of JSON input');
      },
    });
    await launch();
    await settle();
    expect(h.chooseDialog).not.toHaveBeenCalled();
    expect(shares().entries.size).toBe(0);
  });

  it('doesn’t ask twice when the app opens twice at once', async () => {
    shares().share(idAt(NOW - 1000), meta({ text: 'once' }));
    let answer: (v: 'confirm') => void = () => undefined;
    h.chooseDialog.mockImplementationOnce(() => new Promise((r) => (answer = r)));
    vi.resetModules();
    window.history.replaceState(null, '', '/');
    const a = await import('../../src/lib/launch');
    a.takeLaunchAction();
    a.takeLaunchAction();
    await settle();
    answer('confirm');
    await settle();
    expect(h.chooseDialog).toHaveBeenCalledTimes(1);
    expect(h.createNote).toHaveBeenCalledTimes(1);
  });
});

describe('what a share becomes', () => {
  let sharedNote: typeof import('../../src/lib/launch').sharedNote;
  beforeEach(async () => {
    ({ sharedNote } = await import('../../src/lib/launch'));
  });

  it('titles a note by its first line, shortened past 80 characters', () => {
    const long = 'word '.repeat(30).trim();
    const note = sharedNote({ title: '', text: `${long}\nsecond line`, url: '' }, []);
    expect(note.title).toBe(`${long.slice(0, 77)}…`);
    expect(note.content).toBe(`${long}\nsecond line\n`);
  });

  it('never cuts an emoji in half when shortening a title', () => {
    expect(sharedNote({ title: '', text: `${'a'.repeat(76)}😀${'b'.repeat(10)}`, url: '' }, []).title).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  });

  it('caps a shared title at 200 characters', () => {
    expect(sharedNote({ title: 'T'.repeat(300), text: '', url: '' }, []).title).toHaveLength(200);
  });

  it('doesn’t repeat a link that the text has in brackets or before punctuation', () => {
    for (const text of ['see <https://x.test/a>', 'see (https://x.test/a)', 'see https://x.test/a.', 'see https://x.test/a!?', 'https://x.test/a, nice']) {
      expect(sharedNote({ title: 'X', text, url: 'https://x.test/a' }, []).content, text).toBe(`${text}\n`);
    }
  });

  it('links mail addresses, and keeps other schemes as plain text', () => {
    expect(sharedNote({ title: 'Mail me', text: '', url: 'mailto:a@b.test' }, []).content).toBe('[Mail me](mailto:a@b.test)\n');
    expect(sharedNote({ title: '', text: '', url: 'data:text/html,<b>x</b>' }, []).content).toBe('data:text/html,<b>x</b>\n');
    expect(sharedNote({ title: '', text: '', url: 'https://x.test/p' }, [])).toEqual({ title: 'x.test', content: '<https://x.test/p>\n' });
  });

  it('reads a link shared as the text, with spaces around it, as the link', () => {
    expect(sharedNote({ title: 'Page', text: '  https://x.test/p \n', url: '' }, [])).toEqual({ title: 'Page', content: '[Page](https://x.test/p)\n' });
  });

  it('falls back to the site, then "Shared", when there is nothing to title it by', () => {
    expect(sharedNote({ title: '  ', text: '#', url: 'https://www.news.test/a' }, []).title).toBe('news.test');
    expect(sharedNote({ title: '', text: '', url: 'not a url' }, []).title).toBe('Shared');
  });

  it('puts the files after the text and link, in order', () => {
    expect(sharedNote({ title: 'T', text: 'Body', url: 'https://x.test' }, ['![a](/api/files/a/a.png)', '[📎 b.pdf](/api/files/b/b.pdf)']).content).toBe(
      'Body\n\n[T](https://x.test)\n\n![a](/api/files/a/a.png)\n\n[📎 b.pdf](/api/files/b/b.pdf)\n',
    );
  });
});
