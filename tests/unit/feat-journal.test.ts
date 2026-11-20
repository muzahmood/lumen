/**
 * The journal (src/lib/journal.ts): entries are notes titled with their date and tagged #journal, new
 * ones go beside the latest entry, they're made from the template titled "Journal", one per day however
 * many ask at once, after checking a note list that might be missing the entry; and Home's quick capture
 * adds to the end of today's entry with the time. The app's store, API and live editing are stubbed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_JOURNAL, fillTemplate } from '../../src/lib/templateText';

type Meta = { id: string; title: string; folder_id: string | null; tags: string[]; pinned: boolean; updated_at: number; deleted_at: number | null };
type Folder = { id: string; name: string; parent_id: string | null };

const h = vi.hoisted(() => {
  let state = {
    notes: {} as Record<string, Meta>,
    folders: [] as Folder[],
    status: 'ready',
    lastSync: Date.now(),
    filter: { kind: 'all' } as { kind: string; id?: string },
  };
  const noteCache = new Map<string, Meta & { content: string }>();
  const server = new Map<string, string>();
  let seq = 0;
  const useApp = {
    getState: () => state,
    setState: (patch: Partial<typeof state> | ((s: typeof state) => Partial<typeof state>)) => {
      state = { ...state, ...(typeof patch === 'function' ? patch(state) : patch) };
    },
  };
  const knownText = (id: string) => (noteCache.has(id) ? { content: noteCache.get(id)!.content, version: 1 } : null);
  return {
    useApp,
    noteCache,
    server,
    knownText,
    reset() {
      seq = 0;
      noteCache.clear();
      server.clear();
      state = { notes: {}, folders: [], status: 'ready', lastSync: Date.now(), filter: { kind: 'all' } };
    },
    createNote: vi.fn(async (init: { title: string; folder_id: string | null; tags: string[]; pinned: boolean; content: string }, _opts?: unknown) => {
      await new Promise((r) => setTimeout(r, 0));
      const meta: Meta = { id: `made${++seq}`, title: init.title, folder_id: init.folder_id, tags: init.tags, pinned: init.pinned, updated_at: Date.now(), deleted_at: null };
      useApp.setState((s) => ({ notes: { ...s.notes, [meta.id]: meta } }));
      noteCache.set(meta.id, { ...meta, content: init.content });
      return meta;
    }),
    createFolder: vi.fn(async ({ name }: { name: string }) => {
      await new Promise((r) => setTimeout(r, 0));
      return { id: `folder${++seq}`, name, parent_id: null };
    }),
    getNote: vi.fn(async (id: string) => ({ ...state.notes[id], content: server.get(id) ?? '' })),
    loadAll: vi.fn(async (_silent?: boolean) => {
      useApp.setState({ status: 'ready', lastSync: Date.now() });
    }),
    openNote: vi.fn(),
    toastError: vi.fn(),
    changeNoteText: vi.fn((id: string, fn: (src: string) => string) => {
      const known = noteCache.get(id);
      if (!known) return false;
      noteCache.set(id, { ...known, content: fn(known.content) });
      return true;
    }),
  };
});

vi.mock('../../src/lib/store', () => ({
  useApp: h.useApp,
  createNote: h.createNote,
  loadAll: h.loadAll,
  noteCache: h.noteCache,
  openNote: h.openNote,
  toastError: h.toastError,
  folderDescendants: (folders: Folder[], id: string) => {
    const out = new Set([id]);
    for (let grew = true; grew; ) {
      grew = false;
      for (const f of folders) if (f.parent_id && out.has(f.parent_id) && !out.has(f.id)) grew = !!out.add(f.id);
    }
    return out;
  },
}));
vi.mock('../../src/lib/api', () => ({ api: { getNote: h.getNote, createFolder: h.createFolder } }));
vi.mock('../../src/lib/liveEdit', () => ({ knownText: h.knownText, changeNoteText: h.changeNoteText }));

const { captureToJournal, isJournalEntry, journalEntries, journalFolderId, openJournal } = await import('../../src/lib/journal');

const folder = (id: string, name: string, parent_id: string | null = null): Folder => ({ id, name, parent_id });
const note = (id: string, title: string, folder_id: string | null, tags: string[] = [], updated_at = 1, deleted_at: number | null = null): Meta => ({
  id,
  title,
  folder_id,
  tags,
  pinned: false,
  updated_at,
  deleted_at,
});

/** Notes and folders, with the text this device has for some of them. */
function library(folders: Folder[], notes: Meta[], texts: Record<string, string> = {}) {
  h.useApp.setState({ folders, notes: Object.fromEntries(notes.map((n) => [n.id, n])) });
  for (const [id, content] of Object.entries(texts)) h.noteCache.set(id, { ...h.useApp.getState().notes[id], content });
}

const made = () => h.createNote.mock.calls.map(([init]) => init);
const text = (id: string) => h.noteCache.get(id)?.content;
const at = (y: number, m: number, d: number, hh = 9, mm = 5, ss = 0) => new Date(y, m - 1, d, hh, mm, ss);
const timeOf = (d: Date) => d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

const TEMPLATE = '# {{date}} ({{weekday}}) at {{time}}\n{{title}}\n\n## Notes\n\n';

beforeEach(() => {
  h.reset();
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(at(2026, 11, 17));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('opening a day’s entry', () => {
  it('opens the entry that already exists, without making another', async () => {
    library([folder('j', 'Journal')], [note('e', '2026-11-17', 'j', ['journal'])]);
    await openJournal('2026-11-17');
    expect(h.createNote).not.toHaveBeenCalled();
    expect(h.openNote).toHaveBeenCalledWith('e');
  });

  it('makes a missing one from the journal template, titled with its date and tagged journal, beside the latest entry', async () => {
    library(
      [folder('t', 'Templates'), folder('d', 'Diary'), folder('x', 'Old')],
      [note('tpl', 'Journal', 't'), note('e1', '2026-11-16', 'd', ['journal']), note('e0', '2025-01-01', 'x', ['journal'], 999)],
      { tpl: TEMPLATE },
    );
    await openJournal('2026-11-17');
    expect(made()).toEqual([
      { title: '2026-11-17', folder_id: 'd', tags: ['journal'], pinned: false, content: `# 2026-11-17 (${at(2026, 11, 17).toLocaleDateString(undefined, { weekday: 'long' })}) at 09:05\n2026-11-17\n\n## Notes\n\n` },
    ]);
    expect(h.createNote.mock.calls[0][1]).toEqual({ open: true, mode: 'edit' });
    expect(h.openNote).not.toHaveBeenCalled();
  });

  it('fills another day’s entry with that day’s date, at the current time', async () => {
    library([folder('t', 'Templates'), folder('j', 'Journal')], [note('tpl', 'Journal', 't')], { tpl: '{{date}} {{weekday}} {{year}}/{{month}}/{{day}} {{time}} {{title}}' });
    await openJournal('2027-01-01');
    const friday = at(2027, 1, 1).toLocaleDateString(undefined, { weekday: 'long' });
    expect(made()[0]).toMatchObject({ title: '2027-01-01', folder_id: 'j', content: `2027-01-01 ${friday} 2027/01/01 09:05 2027-01-01` });
  });

  it('fetches the template’s text when this device doesn’t have it', async () => {
    library([folder('t', 'Templates')], [note('tpl', 'Daily', 't')]);
    h.server.set('tpl', 'From the server: {{date}}');
    await openJournal('2026-11-17');
    expect(h.getNote).toHaveBeenCalledWith('tpl');
    expect(made()[0].content).toBe('From the server: 2026-11-17');
  });

  it('uses the short default when there is no journal template', async () => {
    library([folder('j', 'Journal'), folder('w', 'Templates', 'x'), folder('x', 'Work')], [note('nested', 'Journal', 'w')], { nested: 'not the template' });
    await openJournal('2026-11-17');
    expect(made()[0].content).toBe(fillTemplate(DEFAULT_JOURNAL, { date: at(2026, 11, 17), title: '2026-11-17' }));
  });

  it('starts a Journal folder for the first entry, once, however many days are opened at once', async () => {
    library([], []);
    await Promise.all([openJournal('2026-11-17'), openJournal('2026-11-18'), captureToJournal('first thought')]);
    expect(h.createFolder).toHaveBeenCalledTimes(1);
    expect(h.createFolder).toHaveBeenCalledWith({ name: 'Journal' });
    const folderId = h.useApp.getState().folders[0].id;
    expect(made().map((n) => [n.title, n.folder_id])).toEqual([
      ['2026-11-17', folderId],
      ['2026-11-18', folderId],
    ]);
  });

  it('keeps the journal in its folder after the folder is renamed', async () => {
    library([folder('d', 'Days')], [note('e', '2026-11-16', 'd', ['journal'])]);
    expect(journalFolderId()).toBe('d');
    await openJournal('2026-11-17');
    expect(made()[0].folder_id).toBe('d');
  });

  it('follows the latest entry by its date, not by when it was last edited', async () => {
    library([folder('a', 'A'), folder('b', 'B')], [note('e1', '2026-11-16', 'a', ['journal'], 1), note('e2', '2026-11-10', 'b', ['journal'], 999)]);
    expect(journalFolderId()).toBe('a');
  });

  it('chooses the folder from entries only: not trashed ones, templates or untagged dated notes', async () => {
    library(
      [folder('j', 'Journal'), folder('t', 'Templates'), folder('trash', 'Trashed'), folder('m', 'Misc')],
      [
        note('ok', '2026-11-01', 'j', ['journal']),
        note('gone', '2026-11-20', 'trash', ['journal'], 1, 5),
        note('tpl', '2026-12-01', 't', ['journal']),
        note('plain', '2026-12-02', 'm'),
      ],
    );
    expect(journalFolderId()).toBe('j');
  });

  it('falls back to the Journal folder when the latest entry’s folder is gone', () => {
    library([folder('j', 'journal ')], [note('e', '2026-11-16', 'deleted-folder', ['journal'])]);
    expect(journalFolderId()).toBe('j');
  });

  it('keeps new entries at the top level when the latest entry is there', async () => {
    library([], [note('e', '2026-11-16', null, ['journal'])]);
    await openJournal('2026-11-17');
    expect(h.createFolder).not.toHaveBeenCalled();
    expect(made()[0].folder_id).toBeNull();
  });
});

describe('the same day asked for at once', () => {
  it('makes one entry when it is opened twice together (a double tap)', async () => {
    library([folder('j', 'Journal')], []);
    await Promise.all([openJournal('2026-11-17'), openJournal('2026-11-17'), openJournal('2026-11-17')]);
    expect(h.createNote).toHaveBeenCalledTimes(1);
  });

  it('adds a capture made while the entry is being made to that same entry', async () => {
    library([folder('t', 'Templates'), folder('j', 'Journal')], [note('tpl', 'Journal', 't')], { tpl: '## Notes\n\n' });
    const [, id] = await Promise.all([openJournal('2026-11-17'), captureToJournal('Call Sam')]);
    expect(h.createNote).toHaveBeenCalledTimes(1);
    expect(id).toBe('made1');
    expect(text('made1')).toBe(`## Notes\n\n**${timeOf(at(2026, 11, 17))}** Call Sam\n`);
  });

  it('keeps two captures made at once, in order', async () => {
    library([folder('j', 'Journal')], []);
    await Promise.all([captureToJournal('one'), captureToJournal('two')]);
    expect(h.createNote).toHaveBeenCalledTimes(1);
    const body = text('made1')!;
    expect(body.indexOf('one')).toBeGreaterThan(-1);
    expect(body.indexOf('two')).toBeGreaterThan(body.indexOf('one'));
  });

  it('tries again after a failed attempt', async () => {
    library([folder('j', 'Journal')], []);
    h.createNote.mockRejectedValueOnce(new Error('offline'));
    await openJournal('2026-11-17');
    expect(h.toastError).toHaveBeenCalledTimes(1);
    await openJournal('2026-11-17');
    expect(h.createNote).toHaveBeenCalledTimes(2);
    expect(Object.values(h.useApp.getState().notes).map((n) => n.title)).toEqual(['2026-11-17']);
  });
});

describe('a note list that may be missing the entry', () => {
  it('waits for the list to load before deciding to make one', async () => {
    library([folder('j', 'Journal')], []);
    h.useApp.setState({ status: 'loading' });
    h.loadAll.mockImplementationOnce(async () => {
      library([folder('j', 'Journal')], [note('e', '2026-11-17', 'j', ['journal'])]);
      h.useApp.setState({ status: 'ready', lastSync: Date.now() });
    });
    await openJournal('2026-11-17');
    expect(h.loadAll).toHaveBeenCalled();
    expect(h.createNote).not.toHaveBeenCalled();
    expect(h.openNote).toHaveBeenCalledWith('e');
  });

  it('refreshes a list older than ten seconds and finds the entry another device made', async () => {
    library([folder('j', 'Journal')], []);
    h.useApp.setState({ lastSync: Date.now() - 60_000 });
    h.loadAll.mockImplementationOnce(async () => {
      library([folder('j', 'Journal')], [note('phone', '2026-11-17', 'j', ['journal'])]);
      h.useApp.setState({ lastSync: Date.now() });
    });
    await openJournal('2026-11-17');
    expect(h.loadAll).toHaveBeenCalledWith(true);
    expect(h.createNote).not.toHaveBeenCalled();
    expect(h.openNote).toHaveBeenCalledWith('phone');
  });

  it('trusts a list refreshed moments ago', async () => {
    library([folder('j', 'Journal')], []);
    h.useApp.setState({ lastSync: Date.now() - 2_000 });
    await openJournal('2026-11-17');
    expect(h.loadAll).not.toHaveBeenCalled();
    expect(h.createNote).toHaveBeenCalledTimes(1);
  });
});

describe('capturing to the journal', () => {
  it('adds the text to the end of today’s entry with the time, after one blank line', async () => {
    library([folder('j', 'Journal')], [note('e', '2026-11-17', 'j', ['journal'])], { e: '## Notes\n\nEarlier.\n\n\n  \n' });
    expect(await captureToJournal('  Call Sam  ')).toBe('e');
    expect(text('e')).toBe(`## Notes\n\nEarlier.\n\n**${timeOf(at(2026, 11, 17))}** Call Sam\n`);
  });

  it('adds tasks, bullets and numbered items as they are, so they stay list items', async () => {
    library([folder('j', 'Journal')], [note('e', '2026-11-17', 'j', ['journal'])], { e: 'Start' });
    for (const item of ['- [ ] buy milk', '* starred', '+ plus', '1. first', '2) second']) await captureToJournal(item);
    expect(text('e')).toBe('Start\n\n- [ ] buy milk\n\n* starred\n\n+ plus\n\n1. first\n\n2) second\n');
  });

  it('puts the time on text that only looks like a list item', async () => {
    library([folder('j', 'Journal')], [note('e', '2026-11-17', 'j', ['journal'])], { e: '' });
    await captureToJournal('-no space');
    await captureToJournal('1.5 litres');
    const t = timeOf(at(2026, 11, 17));
    expect(text('e')).toBe(`**${t}** -no space\n\n**${t}** 1.5 litres\n`);
  });

  it('keeps a capture of several lines together', async () => {
    library([folder('j', 'Journal')], [note('e', '2026-11-17', 'j', ['journal'])], { e: '' });
    await captureToJournal('line one\nline two');
    expect(text('e')).toBe(`**${timeOf(at(2026, 11, 17))}** line one\nline two\n`);
  });

  it('ignores an empty capture', async () => {
    library([folder('j', 'Journal')], []);
    expect(await captureToJournal('  \n\t ')).toBeNull();
    expect(h.createNote).not.toHaveBeenCalled();
  });

  it('makes today’s entry with the capture already in it when there isn’t one', async () => {
    library([folder('t', 'Templates'), folder('j', 'Journal')], [note('tpl', 'Journal', 't')], { tpl: '## {{date}}\n\n' });
    const id = await captureToJournal('First');
    expect(id).toBe('made1');
    expect(made()[0]).toMatchObject({ title: '2026-11-17', content: `## 2026-11-17\n\n**${timeOf(at(2026, 11, 17))}** First\n` });
    expect(h.createNote.mock.calls[0][1]).toEqual({ open: false, mode: 'edit' });
    expect(h.changeNoteText).not.toHaveBeenCalled();
  });

  it('reads the entry from the server first when this device hasn’t loaded it', async () => {
    library([folder('j', 'Journal')], [note('e', '2026-11-17', 'j', ['journal'])]);
    h.server.set('e', 'From the phone');
    await captureToJournal('and from here');
    expect(h.getNote).toHaveBeenCalledWith('e');
    expect(text('e')).toBe(`From the phone\n\n**${timeOf(at(2026, 11, 17))}** and from here\n`);
  });

  it('says it couldn’t save, and returns nothing, when the entry can’t be changed', async () => {
    library([folder('j', 'Journal')], [note('e', '2026-11-17', 'j', ['journal'])], { e: 'x' });
    h.changeNoteText.mockReturnValueOnce(false);
    expect(await captureToJournal('lost?')).toBeNull();
    expect(h.toastError).toHaveBeenCalledTimes(1);
  });
});

describe('the day a capture goes to', () => {
  it('is the local date just before midnight and just after, across the turn of the year', async () => {
    library([folder('j', 'Journal')], [note('e', '2026-12-31', 'j', ['journal'])], { e: 'NYE' });
    vi.setSystemTime(at(2026, 12, 31, 23, 59, 59));
    expect(await captureToJournal('last of the year')).toBe('e');
    vi.setSystemTime(at(2027, 1, 1, 0, 0, 1));
    const id = await captureToJournal('first of the year');
    expect(id).not.toBe('e');
    expect(made()[0].title).toBe('2027-01-01');
  });

  it('is the end of February in a leap year', async () => {
    library([folder('j', 'Journal')], []);
    vi.setSystemTime(at(2028, 2, 29, 23, 30));
    await captureToJournal('leap');
    expect(made()[0].title).toBe('2028-02-29');
  });

  describe('in other time zones', () => {
    const original = process.env.TZ;
    afterEach(() => {
      process.env.TZ = original;
    });
    const instant = Date.UTC(2026, 10, 17, 11, 30);
    const cases: Array<[string, string]> = [
      ['Pacific/Kiritimati', '2026-11-18'],
      ['Pacific/Auckland', '2026-11-18'],
      ['Asia/Kolkata', '2026-11-17'],
      ['America/Los_Angeles', '2026-11-17'],
      ['Pacific/Pago_Pago', '2026-11-17'],
    ];
    for (const [zone, day] of cases) {
      it(`is the date in ${zone}`, async () => {
        process.env.TZ = zone;
        vi.setSystemTime(instant);
        library([folder('j', 'Journal')], []);
        await captureToJournal('here');
        expect(made()[0].title).toBe(day);
        expect(made()[0].content).toContain(`**${timeOf(new Date(instant))}** here`);
      });
    }

    it('fills a day whose midnight is skipped by daylight saving (Chile, 6 September 2026)', async () => {
      process.env.TZ = 'America/Santiago';
      vi.setSystemTime(new Date(2026, 8, 10, 0, 30));
      library([folder('t', 'Templates'), folder('j', 'Journal')], [note('tpl', 'Journal', 't')], { tpl: '{{date}} {{weekday}}' });
      await openJournal('2026-09-06');
      expect(made()[0]).toMatchObject({ title: '2026-09-06', content: `2026-09-06 ${new Date(2026, 8, 6, 12).toLocaleDateString(undefined, { weekday: 'long' })}` });
    });
  });
});

describe('which notes are entries', () => {
  it('takes dated notes tagged journal in any case, or dated notes in the journal folder', () => {
    library(
      [folder('j', 'Journal'), folder('o', 'Other')],
      [
        note('tag', '2026-11-01', 'j', ['JOURNAL']),
        note('old', '2026-10-01', 'o', ['journal']),
        note('folder', ' 2026-11-02 ', 'j'),
        note('undated', 'Ideas', 'j', ['journal']),
        note('elsewhere', '2026-11-03', 'o'),
        note('trashed', '2026-11-04', 'j', ['journal'], 1, 9),
        note('long', '2026-11-05 recap', 'j', ['journal']),
      ],
    );
    expect(journalFolderId()).toBe('j');
    expect([...journalEntries().keys()].sort()).toEqual(['2026-10-01', '2026-11-01', '2026-11-02']);
    expect(isJournalEntry(note('x', '2026-11-03', 'o') as never, null)).toBe(false);
  });
});
