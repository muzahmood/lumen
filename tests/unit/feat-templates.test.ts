/**
 * Templates: notes in a top-level Templates folder; a new note from one has its placeholders filled in,
 * in the title too ("Meeting {{date}}" makes "Meeting 2026-11-17"). The filling itself
 * (src/lib/templateText.ts) near midnight, month and year ends and in other time zones; then making
 * notes from templates (src/lib/journal.ts) with the app's store and API stubbed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_JOURNAL, fillTemplate, isoDate, parseIsoDate } from '../../src/lib/templateText';

type Meta = { id: string; title: string; folder_id: string | null; tags: string[]; pinned: boolean; updated_at: number; deleted_at: number | null };
type Folder = { id: string; name: string; parent_id: string | null };

const h = vi.hoisted(() => {
  let state = { notes: {} as Record<string, Meta>, folders: [] as Folder[], filter: { kind: 'all' } as { kind: string; id?: string } };
  const noteCache = new Map<string, { content: string }>();
  const server = new Map<string, string>();
  let seq = 0;
  const useApp = {
    getState: () => state,
    setState: (patch: Partial<typeof state> | ((s: typeof state) => Partial<typeof state>)) => {
      state = { ...state, ...(typeof patch === 'function' ? patch(state) : patch) };
    },
  };
  return {
    useApp,
    noteCache,
    server,
    reset() {
      seq = 0;
      noteCache.clear();
      server.clear();
      state = { notes: {}, folders: [], filter: { kind: 'all' } };
    },
    createNote: vi.fn(async (init: Record<string, unknown>, _opts?: unknown) => ({ id: `made${++seq}`, ...init })),
    createFolder: vi.fn(async ({ name }: { name: string }) => {
      await new Promise((r) => setTimeout(r, 0));
      return { id: `folder${++seq}`, name, parent_id: null };
    }),
    getNote: vi.fn(async (id: string) => ({ id, content: server.get(id) ?? '' })),
    openNote: vi.fn(),
    toastError: vi.fn(),
  };
});

vi.mock('../../src/lib/store', () => ({
  useApp: h.useApp,
  createNote: h.createNote,
  loadAll: vi.fn(),
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
vi.mock('../../src/lib/liveEdit', () => ({
  knownText: (id: string) => (h.noteCache.has(id) ? { content: h.noteCache.get(id)!.content, version: 1 } : null),
  changeNoteText: () => false,
}));

const journal = await import('../../src/lib/journal');

const at = (y: number, m: number, d: number, hh = 9, mm = 5) => new Date(y, m - 1, d, hh, mm);
const weekday = (d: Date) => d.toLocaleDateString(undefined, { weekday: 'long' });

describe('filling in placeholders', () => {
  it('fills every placeholder, in titles and running text alike', () => {
    const d = at(2026, 11, 17);
    expect(fillTemplate('Meeting {{date}}', { date: d })).toBe('Meeting 2026-11-17');
    expect(fillTemplate('{{date}}{{time}} x{{day}}y {{date}} {{DATE}} {{Title}}', { date: d, title: 'Standup' })).toBe('2026-11-1709:05 x17y 2026-11-17 2026-11-17 Standup');
  });

  it('accepts spaces and tabs inside the braces, and leaves extra braces as text', () => {
    const d = at(2026, 11, 17);
    expect(fillTemplate('{{ date }} {{\tyear\t}} {{{day}}} {{ day', { date: d })).toBe('2026-11-17 2026 {17} {{ day');
  });

  it('leaves unknown names, built-in object names and malformed ones as typed', () => {
    const d = at(2026, 11, 17);
    for (const typed of ['{{nope}}', '{{constructor}}', '{{toString}}', '{{hasOwnProperty}}', '{{__proto__}}', '{{valueOf}}', '{{date2}}', '{{da te}}', '{{}}', '{date}'])
      expect(fillTemplate(typed, { date: d }), typed).toBe(typed);
  });

  it('puts the title in as written, even with $ signs or braces in it', () => {
    expect(fillTemplate('# {{title}}', { date: at(2026, 11, 17), title: "Costs $& $1 $' {{date}}" })).toBe("# Costs $& $1 $' {{date}}");
  });

  it('fills {{title}} with nothing when there is no title yet', () => {
    expect(fillTemplate('[{{title}}]', { date: at(2026, 11, 17) })).toBe('[]');
  });

  it('pads times and dates around midnight and at the ends of months and years', () => {
    expect(fillTemplate('{{datetime}}', { date: at(2026, 12, 31, 23, 59) })).toBe('2026-12-31 23:59');
    expect(fillTemplate('{{datetime}}', { date: at(2027, 1, 1, 0, 0) })).toBe('2027-01-01 00:00');
    expect(fillTemplate('{{year}}-{{month}}-{{day}}', { date: at(2028, 2, 29) })).toBe('2028-02-29');
    expect(fillTemplate('{{date}}', { date: at(2026, 3, 1, 0, 0) })).toBe('2026-03-01');
  });

  it('spells out the weekday and long date for the day given', () => {
    const d = at(2027, 1, 1);
    expect(fillTemplate('{{weekday}}', { date: d })).toBe(weekday(d));
    expect(fillTemplate('{{longdate}}', { date: d })).toContain('2027');
  });

  it('fills the default journal text as a dated page with a Focus task and Notes', () => {
    const filled = fillTemplate(DEFAULT_JOURNAL, { date: at(2026, 11, 17) });
    expect(filled).not.toMatch(/\{\{/);
    expect(filled).toMatch(/^\*.+2026\*\n\n## Focus\n\n- \[ \] \n\n## Notes\n\n$/);
  });

  describe('in other time zones', () => {
    const original = process.env.TZ;
    afterEach(() => {
      process.env.TZ = original;
    });
    const instant = new Date(Date.UTC(2026, 10, 17, 11, 30));

    for (const [zone, date, time] of [
      ['Pacific/Auckland', '2026-11-18', '00:30'],
      ['Asia/Kathmandu', '2026-11-17', '17:15'],
      ['America/St_Johns', '2026-11-17', '08:00'],
      ['Pacific/Pago_Pago', '2026-11-17', '00:30'],
    ] as const) {
      it(`uses the local date and time in ${zone}`, () => {
        process.env.TZ = zone;
        expect(fillTemplate('{{date}} {{time}}', { date: instant })).toBe(`${date} ${time}`);
      });
    }

    it('reads a date as that local day even where its midnight is skipped (Chile)', () => {
      process.env.TZ = 'America/Santiago';
      const d = parseIsoDate('2026-09-06', at(2026, 1, 1, 0, 30))!;
      expect(isoDate(d)).toBe('2026-09-06');
      expect(fillTemplate('{{date}} {{weekday}}', { date: d })).toBe(`2026-09-06 ${weekday(new Date(2026, 8, 6, 12))}`);
    });
  });
});

describe('reading dates', () => {
  it('takes real calendar dates only', () => {
    expect(parseIsoDate('2028-02-29')).not.toBeNull();
    for (const bad of ['2026-02-29', '2026-04-31', '2026-13-01', '2026-00-10', '2026-1-5', '2026-11-17T09:00', '17-11-2026', '', 'today'])
      expect(parseIsoDate(bad), bad).toBeNull();
  });

  it('ignores spaces around a date and uses noon unless told the time', () => {
    const d = parseIsoDate(' 2026-11-17 ')!;
    expect([isoDate(d), d.getHours(), d.getMinutes()]).toEqual(['2026-11-17', 12, 0]);
    expect(parseIsoDate('2026-11-17', at(2000, 1, 1, 23, 45))!.getHours()).toBe(23);
  });

  it('writes local dates with padded months and days', () => {
    expect(isoDate(at(2026, 1, 5, 0, 0))).toBe('2026-01-05');
    expect(isoDate(at(2026, 12, 31, 23, 59))).toBe('2026-12-31');
  });
});

/* ------------------------------------------------- notes from templates --- */

const folder = (id: string, name: string, parent_id: string | null = null): Folder => ({ id, name, parent_id });
const note = (id: string, title: string, folder_id: string | null, tags: string[] = [], deleted_at: number | null = null): Meta => ({
  id,
  title,
  folder_id,
  tags,
  pinned: false,
  updated_at: 1,
  deleted_at,
});

function library(folders: Folder[], notes: Meta[], texts: Record<string, string> = {}, filter: { kind: string; id?: string } = { kind: 'all' }) {
  h.useApp.setState({ folders, notes: Object.fromEntries(notes.map((n) => [n.id, n])), filter });
  for (const [id, content] of Object.entries(texts)) h.noteCache.set(id, { content });
}

beforeEach(() => {
  h.reset();
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(at(2026, 11, 17));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('which notes are templates', () => {
  const folders = [folder('t', ' templates '), folder('t2', 'Work', 't'), folder('t3', 'Deep', 't2'), folder('w', 'Work'), folder('x', 'Templates', 'w')];

  it('are the notes in the top-level Templates folder, at any depth, whatever its case', () => {
    library(folders, [note('a', 'A', 't'), note('b', 'B', 't3'), note('c', 'C', 'x'), note('d', 'D', null), note('e', 'E', 't', [], 5)]);
    const { notes } = h.useApp.getState();
    expect(['a', 'b', 'c', 'd'].map((id) => journal.isTemplate(notes[id] as never))).toEqual([true, true, false, false]);
    expect(journal.templateNotes().map((n) => n.id)).toEqual(['a', 'b']);
  });

  it('are none when there is no Templates folder at the top', () => {
    library([folder('w', 'Work'), folder('x', 'Templates', 'w')], [note('c', 'C', 'x')]);
    expect(journal.templateNotes()).toEqual([]);
  });

  it('leave the journal template out of those offered for new notes', () => {
    library(folders, [note('j', 'JOURNAL', 't'), note('m', 'Meeting {{date}}', 't'), note('n', 'Journal notes', 't2')]);
    expect(journal.journalTemplate()?.id).toBe('j');
    expect(journal.newNoteTemplates().map((n) => n.id)).toEqual(['n', 'm']);
  });

  it('take a template titled Daily as the journal’s when there is no Journal one', () => {
    library(folders, [note('d', ' daily ', 't2'), note('m', 'Meeting', 't')]);
    expect(journal.journalTemplate()?.id).toBe('d');
  });

  it('use the one titled Journal for the journal when there is also one titled Daily', () => {
    library(folders, [note('j', 'Journal', 't'), note('d', 'Daily', 't')]);
    expect(journal.journalTemplate()?.id).toBe('j');
    expect(journal.newNoteTemplates().map((n) => n.id)).toEqual(['d']);
  });
});

describe('a new note from a template', () => {
  const folders = [folder('t', 'Templates'), folder('ts', 'Sub', 't'), folder('p', 'Projects')];

  it('fills the title and text, and keeps the template’s tags except "template"', async () => {
    library(folders, [note('tpl', 'Meeting {{date}} ', 't', ['work', 'Template', 'meeting'])], { tpl: '# {{title}}\n\n{{weekday}} at {{time}}' }, { kind: 'folder', id: 'p' });
    await journal.newFromTemplate('tpl');
    expect(h.createNote).toHaveBeenCalledWith(
      { title: 'Meeting 2026-11-17', content: `# Meeting 2026-11-17\n\n${weekday(at(2026, 11, 17))} at 09:05`, folder_id: 'p', tags: ['work', 'meeting'], pinned: false },
      { mode: 'edit' },
    );
  });

  it('goes to the top level, not into Templates, when made while viewing the templates', async () => {
    library(folders, [note('tpl', 'T', 'ts')], { tpl: 'x' }, { kind: 'folder', id: 'ts' });
    await journal.newFromTemplate('tpl');
    expect(h.createNote.mock.calls[0][0]).toMatchObject({ folder_id: null });
  });

  it('goes to the top level when no folder is being viewed', async () => {
    library(folders, [note('tpl', 'T', 't')], { tpl: 'x' }, { kind: 'tag', id: 'work' });
    await journal.newFromTemplate('tpl');
    expect(h.createNote.mock.calls[0][0]).toMatchObject({ folder_id: null });
  });

  it('reads the template from the server when this device doesn’t have its text', async () => {
    library(folders, [note('tpl', 'T', 't')]);
    h.server.set('tpl', 'Server {{year}}');
    await journal.newFromTemplate('tpl');
    expect(h.createNote.mock.calls[0][0]).toMatchObject({ content: 'Server 2026' });
  });

  it('does nothing for a template that no longer exists, and reports failures', async () => {
    library(folders, []);
    await journal.newFromTemplate('gone');
    expect(h.createNote).not.toHaveBeenCalled();
    library(folders, [note('tpl', 'T', 't')]);
    h.getNote.mockRejectedValueOnce(new Error('offline'));
    await journal.newFromTemplate('tpl');
    expect(h.toastError).toHaveBeenCalledTimes(1);
  });

  it('fills a template put into an existing note with that note’s title', async () => {
    library(folders, [note('tpl', 'T', 't')], { tpl: '## {{title}} — {{date}}' });
    expect(await journal.filledTemplate('tpl', 'Weekly review')).toBe('## Weekly review — 2026-11-17');
  });

  it('fills the title at the moment it is made, near midnight', async () => {
    vi.setSystemTime(at(2026, 12, 31, 23, 59));
    library(folders, [note('tpl', 'Log {{date}} {{time}}', 't')], { tpl: '' });
    await journal.newFromTemplate('tpl');
    expect(h.createNote.mock.calls[0][0]).toMatchObject({ title: 'Log 2026-12-31 23:59' });
  });
});

describe('making templates', () => {
  it('makes the Templates folder once, however many new templates are started at once', async () => {
    library([], []);
    await Promise.all([journal.newTemplate(), journal.newTemplate()]);
    expect(h.createFolder).toHaveBeenCalledTimes(1);
    expect(h.createFolder).toHaveBeenCalledWith({ name: 'Templates' });
    expect(h.createNote.mock.calls.map(([init]) => init.folder_id)).toEqual(['folder1', 'folder1']);
  });

  it('uses the Templates folder that is there', async () => {
    library([folder('t', 'Templates')], []);
    await journal.newTemplate();
    expect(h.createFolder).not.toHaveBeenCalled();
    expect(h.createNote.mock.calls[0][0]).toMatchObject({ title: '', content: '', folder_id: 't' });
  });

  it('opens the journal template, or makes one titled Journal from the default text', async () => {
    library([folder('t', 'Templates')], [note('j', 'Journal', 't')]);
    await journal.editJournalTemplate();
    expect(h.openNote).toHaveBeenCalledWith('j');
    library([], []);
    await journal.editJournalTemplate();
    expect(h.createNote).toHaveBeenCalledWith({ title: 'Journal', content: DEFAULT_JOURNAL, folder_id: 'folder1', tags: [], pinned: false }, { mode: 'edit' });
  });
});
