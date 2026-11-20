// @vitest-environment jsdom
/**
 * Export (src/components/ExportDialog.tsx), as README's "Export" promises: a note to PDF (paper size,
 * title and date options, through the browser's print window) or Markdown (a .zip with its images and
 * drawings when it has any). The choices are remembered; the dialog closes before the print window
 * opens; a failed export says so and leaves the dialog open.
 */
import { byName, click, dialog, mount, press, text, unmountAll } from './ui-note-helpers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const calls = vi.hoisted(() => ({
  print: [] as Array<{ note: unknown; opts: Record<string, unknown>; closedFirst: boolean }>,
  markdown: [] as Array<{ note: unknown; opts: Record<string, unknown> }>,
  downloads: [] as Array<{ filename: string; size: number }>,
  printFails: null as Error | null,
  markdownResult: null as null | { missing: number; filename: string },
  hold: null as null | Promise<void>,
  onCloseCalled: () => false,
}));

vi.mock('../../src/lib/exportNote', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/lib/exportNote')>();
  return {
    ...real,
    printNote: async (note: unknown, opts: Record<string, unknown>, beforePrint?: () => void) => {
      if (calls.hold) await calls.hold;
      if (calls.printFails) throw calls.printFails;
      beforePrint?.();
      calls.print.push({ note, opts, closedFirst: calls.onCloseCalled() });
    },
    exportMarkdown: async (note: { title: string; content: string }, opts: Record<string, unknown>) => {
      if (calls.hold) await calls.hold;
      calls.markdown.push({ note, opts });
      const zipped = opts.attachments && real.noteAttachments(note.content).length > 0;
      const r = calls.markdownResult ?? { missing: 0, filename: `${note.title}.${zipped ? 'zip' : 'md'}` };
      return { blob: new Blob(['x']), filename: r.filename, missing: r.missing };
    },
  };
});
vi.mock('../../src/lib/utils', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/lib/utils')>()),
  downloadBlob: (blob: Blob, filename: string) => calls.downloads.push({ filename, size: blob.size }),
}));

import { ExportDialog } from '../../src/components/ExportDialog';
import { useSettings } from '../../src/lib/settings';
import { useApp } from '../../src/lib/store';

const NOTE = { id: 'n1', title: 'Trip: Rome/Paris', content: 'Plans', tags: ['travel'], created_at: 1, updated_at: 2 };
const WITH_FILES = {
  ...NOTE,
  content: '![Photo](/api/files/abcdef12/photo.jpg)\n\n![Drawing](/api/drawings/drawing99.svg)\n\n![Again](/api/files/abcdef12/photo.jpg)',
};

let closed = 0;
const open = (note = NOTE) => mount(<ExportDialog note={note} onClose={() => void closed++} />);
const toasts = () => useApp.getState().toasts.map((t) => ({ message: t.message, kind: t.kind }));
const switchNamed = (name: string) => byName(name, '[role="switch"]');

beforeEach(() => {
  closed = 0;
  calls.print = [];
  calls.markdown = [];
  calls.downloads = [];
  calls.printFails = null;
  calls.markdownResult = null;
  calls.hold = null;
  calls.onCloseCalled = () => closed > 0;
  localStorage.clear();
  useApp.setState({ toasts: [] });
  useSettings.setState({
    exportFormat: 'pdf',
    exportPaper: 'a4',
    exportTitle: true,
    exportDetails: false,
    exportAttachments: true,
    exportFrontMatter: false,
    accent: 'iris',
    lineBreaks: true,
  });
});
afterEach(unmountAll);

describe('the export dialog', () => {
  it('is a dialog named Export note, with the note’s title under it', async () => {
    await open();
    expect(dialog()?.getAttribute('aria-label')).toBe('Export note');
    expect(dialog()?.getAttribute('aria-modal')).toBe('true');
    expect(text(dialog()!)).toContain('Trip: Rome/Paris');
  });

  it('closes with Cancel, the close button or Escape, exporting nothing', async () => {
    await open();
    await click(byName('Cancel'));
    await click(byName('Close'));
    await press('Escape', {}, document.body);
    expect(closed).toBe(3);
    expect(calls.print).toHaveLength(0);
    expect(calls.markdown).toHaveLength(0);
  });
});

describe('as a PDF', () => {
  it('offers paper, title and date options, and remembers each choice', async () => {
    await open();
    await click(byName('Letter', '[role="radio"]'));
    expect(useSettings.getState().exportPaper).toBe('letter');
    await click(switchNamed('Date and tags'));
    expect(useSettings.getState().exportDetails).toBe(true);
    await click(switchNamed('Title'));
    expect(useSettings.getState().exportTitle).toBe(false);
    expect(switchNamed('Title').getAttribute('aria-checked')).toBe('false');
    expect(JSON.parse(localStorage.getItem('kb.settings')!)).toMatchObject({ exportPaper: 'letter', exportDetails: true, exportTitle: false });
  });

  it('tells you which file name the browser will suggest, made safe for a file system', async () => {
    await open();
    expect(text(dialog()!)).toContain('The file is named “Trip Rome Paris”');
  });

  it('closes itself before the print window opens, with the options chosen', async () => {
    useSettings.setState({ exportPaper: 'letter', exportDetails: true, lineBreaks: false });
    await open();
    await click(byName(/Save as PDF/, 'button.btn-primary'));
    expect(calls.print).toHaveLength(1);
    expect(calls.print[0].closedFirst).toBe(true);
    expect(calls.print[0].opts).toMatchObject({ paper: 'letter', title: true, details: true, breaks: false, accent: '#1E4E80' });
  });

  it('says what went wrong, and stays open, when the PDF can’t be made', async () => {
    calls.printFails = new Error('Images didn’t load');
    await open();
    await click(byName(/Save as PDF/, 'button.btn-primary'));
    expect(closed).toBe(0);
    expect(toasts()).toEqual([{ message: 'Couldn’t export the note: Images didn’t load', kind: 'error' }]);
    expect(byName(/Save as PDF/, 'button.btn-primary').hasAttribute('disabled')).toBe(false);
  });
});

describe('as Markdown', () => {
  it('downloads a .md for a note with no attachments, with the attachments switch off and disabled', async () => {
    useSettings.setState({ exportFormat: 'md' });
    await open();
    const attach = switchNamed('Include images and drawings');
    expect(attach.hasAttribute('disabled')).toBe(true);
    expect(attach.getAttribute('aria-checked')).toBe('false');
    expect(text(dialog()!)).toContain('This note has no images, files or drawings.');
    expect(text(dialog()!)).toContain('Downloads “Trip Rome Paris.md”.');
    await click(byName(/Download \.md/, 'button.btn-primary'));
    expect(calls.downloads).toEqual([{ filename: 'Trip: Rome/Paris.md', size: 1 }]);
    expect(closed).toBe(1);
    expect(toasts()).toEqual([{ message: 'Downloaded Trip: Rome/Paris.md', kind: 'success' }]);
  });

  it('counts each attached file once and offers a .zip, or a .md that links back to Lumen with the switch off', async () => {
    await open(WITH_FILES);
    await click(byName('Markdown', '[role="radio"]'));
    expect(useSettings.getState().exportFormat).toBe('md');
    expect(text(dialog()!)).toContain('Put the 2 files this note uses in a .zip beside it');
    expect(byName(/Download \.zip/, 'button.btn-primary')).toBeTruthy();
    await click(switchNamed('Include images and drawings'));
    expect(text(dialog()!)).toContain('Its images and drawings link back to Lumen');
    await click(byName(/Download \.md/, 'button.btn-primary'));
    expect(calls.markdown[0].opts).toEqual({ attachments: false, frontMatter: false });
  });

  it('passes front matter on when it’s chosen', async () => {
    useSettings.setState({ exportFormat: 'md' });
    await open();
    await click(switchNamed('Front matter'));
    await click(byName(/Download \.md/, 'button.btn-primary'));
    expect(calls.markdown[0].opts).toEqual({ attachments: true, frontMatter: true });
  });

  it('warns when some attachments couldn’t be fetched, naming how many', async () => {
    useSettings.setState({ exportFormat: 'md' });
    calls.markdownResult = { missing: 2, filename: 'Trip.zip' };
    await open(WITH_FILES);
    await click(byName(/Download \.zip/, 'button.btn-primary'));
    expect(toasts()).toEqual([
      { message: 'Downloaded Trip.zip, but 2 attachments couldn’t be fetched; their links point to Lumen instead.', kind: 'error' },
    ]);
  });

  it('can’t be closed or started again while the file is being prepared', async () => {
    useSettings.setState({ exportFormat: 'md' });
    let release!: () => void;
    calls.hold = new Promise<void>((r) => (release = r));
    await open();
    await click(byName(/Download \.md/, 'button.btn-primary'));
    const busy = byName('Preparing…', 'button.btn-primary');
    expect(busy.hasAttribute('disabled')).toBe(true);
    expect(byName('Cancel').hasAttribute('disabled')).toBe(true);
    await press('Escape', {}, document.body);
    expect(closed).toBe(0);
    release();
    calls.hold = null;
    await new Promise((r) => setTimeout(r, 0));
    await click(byName('Close'));
    expect(calls.markdown).toHaveLength(1);
  });
});
