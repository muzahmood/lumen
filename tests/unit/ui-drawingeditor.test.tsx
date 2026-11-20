// @vitest-environment jsdom
/**
 * The drawing editor (src/components/DrawingEditor.tsx), Lumen's own part of it: the copy kept on the
 * device while drawing (offered back after a crash, only for the same drawing), saving with the
 * revision it started from, a drawing changed elsewhere meanwhile (save a copy, replace theirs, or keep
 * editing), and never closing over unsaved changes without asking. Excalidraw itself is stood in for:
 * a stub that hands over an API and lets each test report the scene changing.
 */
import { FAKE_TIMERS, advance, byName, click, mount, nameOf, settle, text, unmountAll } from './ui-note-helpers';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type El = { id: string; type: string; version: number; text?: string };

const excal = vi.hoisted(() => ({
  elements: [] as Array<{ id: string; type: string; version: number; text?: string }>,
  props: null as null | { initialData: unknown; onChange: (els: unknown[]) => void; excalidrawAPI: (a: unknown) => void },
}));

/** Locking, as the vault tells the editor about it (stood in for: e2ee-vault.test.ts covers the vault). */
const locking = vi.hoisted(() => ({ sealed: false, beforeSeal: new Set<() => void>() }));
vi.mock('../../src/lib/vault', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/lib/vault')>()),
  localTextSealed: () => locking.sealed,
  onBeforeLocalSeal: (fn: () => void) => (locking.beforeSeal.add(fn), () => void locking.beforeSeal.delete(fn)),
}));

vi.mock('@excalidraw/excalidraw/index.css', () => ({}));
vi.mock('@excalidraw/excalidraw', async () => {
  const { createElement, useEffect } = await import('react');
  return {
    Excalidraw: (props: NonNullable<typeof excal.props>) => {
      excal.props = props;
      useEffect(() => {
        excal.elements = [...(((props.initialData as { elements?: [] }) ?? {}).elements ?? [])];
        props.excalidrawAPI({
          getSceneElements: () => excal.elements,
          getAppState: () => ({ viewBackgroundColor: '#ffffff' }),
          getFiles: () => ({}),
        });
        // Excalidraw reports the scene it opened with.
        props.onChange(excal.elements);
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, []);
      return createElement('div', { className: 'excalidraw-stub' });
    },
    exportToSvg: async () => document.createElementNS('http://www.w3.org/2000/svg', 'svg'),
    serializeAsJSON: (elements: unknown[]) => JSON.stringify({ type: 'excalidraw', elements }),
    getSceneVersion: (elements: Array<{ version: number }>) => elements.reduce((n, e) => n + e.version, 0),
    convertToExcalidrawElements: (x: unknown) => x,
  };
});

import DrawingEditor from '../../src/components/DrawingEditor';
import { DialogHost, Toasts } from '../../src/components/ui';
import { api, ApiError } from '../../src/lib/api';
import { openDrawingEditor, useApp } from '../../src/lib/store';

const BACKUP = 'kb.drawing-backup';
const NOW = 1_700_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

let saves: Array<{ id: string; data: Parameters<typeof api.saveDrawing>[1] }>;
let saveAnswers: Array<(id: string) => Promise<unknown>>;

beforeEach(() => {
  vi.useFakeTimers({ ...FAKE_TIMERS, now: NOW } as never);
  localStorage.clear();
  locking.sealed = false;
  excal.elements = [];
  excal.props = null;
  saves = [];
  saveAnswers = [];
  vi.spyOn(api, 'getDrawingScene').mockImplementation(async () => ({ elements: [{ id: 'saved', type: 'rectangle', version: 3 }], appState: {} }));
  vi.spyOn(api, 'listDrawings').mockImplementation(async () => ({
    drawings: [{ id: 'drawing01', note_id: 'note1', rev: 'rev-1', storage: 'kv', size: 10, created_at: NOW - 10 * DAY, updated_at: NOW - 2 * DAY }],
  }));
  vi.spyOn(api, 'saveDrawing').mockImplementation(async (id, data) => {
    saves.push({ id, data });
    const answer = saveAnswers.shift();
    if (answer) return answer(id) as never;
    return { id, note_id: data.noteId, rev: `rev-${saves.length + 1}`, storage: 'kv', size: 1, created_at: NOW, updated_at: NOW };
  });
});

afterEach(async () => {
  await act(async () => useApp.setState({ drawing: null, dialog: null, toasts: [] }));
  await unmountAll();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

async function open(drawingId: string | null, noteId: string | null = 'note1') {
  await mount(
    <>
      <DrawingEditor />
      <DialogHost />
      <Toasts />
    </>,
  );
  let result!: Promise<string | null>;
  await act(async () => {
    result = openDrawingEditor(drawingId, noteId);
  });
  await settle();
  let done: { value: string | null } | null = null;
  void result.then((value) => (done = { value }));
  return { result, answered: () => done };
}

/** The person draws: the scene changes and Excalidraw reports it. */
async function draw(...elements: El[]) {
  excal.elements = [...excal.elements, ...elements];
  await act(async () => excal.props!.onChange(excal.elements));
}

/** A question asked over the editor (the editor is a dialog too). */
const question = () => document.querySelector<HTMLElement>('.modal[role="dialog"]');
const backup = () => JSON.parse(localStorage.getItem(BACKUP) ?? 'null');
const editor = () => document.querySelector<HTMLElement>('.drawing-overlay')!;
const bar = (name: string) => byName(name, 'button', editor().querySelector('.drawing-bar')!);

function keepCopy(copy: { requestId: string | null; noteId: string | null; id?: string | null; at?: number; elements?: El[] }) {
  localStorage.setItem(
    BACKUP,
    JSON.stringify({
      requestId: copy.requestId,
      noteId: copy.noteId,
      id: copy.id ?? null,
      at: copy.at ?? NOW - 60_000,
      scene: JSON.stringify({ elements: copy.elements ?? [{ id: 'crash', type: 'ellipse', version: 7 }] }),
    }),
  );
}

describe('opening', () => {
  it('is a named modal screen, with Cancel, Save and Done', async () => {
    await open('drawing01');
    expect(editor().getAttribute('role')).toBe('dialog');
    expect(editor().getAttribute('aria-modal')).toBe('true');
    expect(nameOf(editor())).toBe('Drawing editor');
    expect(text(editor())).toContain('Edit drawing');
    for (const b of ['Cancel', 'Save', 'Done']) expect(bar(b)).toBeTruthy();
  });

  it('opens the saved drawing', async () => {
    await open('drawing01');
    expect(api.getDrawingScene).toHaveBeenCalledWith('drawing01');
    expect((excal.props!.initialData as { elements: El[] }).elements).toEqual([{ id: 'saved', type: 'rectangle', version: 3 }]);
  });

  it('says when a drawing can’t be opened, with a way out', async () => {
    vi.mocked(api.getDrawingScene).mockRejectedValue(new ApiError(404, 'not_found', 'Drawing not found.'));
    const e = await open('drawing01');
    expect(text(editor())).toContain('This drawing couldn’t be opened. Drawing not found.');
    expect((bar('Done') as HTMLButtonElement).disabled).toBe(true);
    await click(byName('Close', 'button', editor().querySelector('.drawing-host')!));
    expect(await e.result).toBeNull();
  });
});

describe('the copy kept while drawing', () => {
  it('is written every 15 seconds while there are unsaved changes, and not before', async () => {
    await open('drawing01');
    await advance(15_000);
    expect(backup()).toBeNull();
    await draw({ id: 'line', type: 'line', version: 1 });
    await advance(15_000);
    expect(backup()).toMatchObject({ requestId: 'drawing01', noteId: 'note1', id: 'drawing01' });
    expect(JSON.parse(backup().scene).elements.map((e: El) => e.id)).toEqual(['saved', 'line']);
  });

  it('is written at once when the page is hidden or closed', async () => {
    await open(null);
    await draw({ id: 'box', type: 'rectangle', version: 1 });
    await act(async () => void window.dispatchEvent(new Event('pagehide')));
    expect(backup()).toMatchObject({ requestId: null, noteId: 'note1', id: null });
  });

  it('takes the latest strokes just before the device locks, then is never written in the clear again', async () => {
    await open('drawing01');
    await draw({ id: 'combination', type: 'text', version: 1, text: '12-34-56' });
    // Locking (by hand or automatically) asks for what's only in memory first…
    expect(locking.beforeSeal.size).toBe(1);
    locking.beforeSeal.forEach((fn) => fn());
    expect(JSON.parse(backup().scene).elements.map((e: El) => e.id)).toContain('combination');
    // …then encrypts it, and reloads: neither that reload's pagehide nor the 15-second copy rewrites it.
    localStorage.setItem(BACKUP, '\u0001sealed:e1:ciphertext');
    locking.sealed = true;
    await act(async () => void window.dispatchEvent(new Event('pagehide')));
    await advance(15_000);
    expect(localStorage.getItem(BACKUP)).toBe('\u0001sealed:e1:ciphertext');
  });

  it('stops listening for locks once the editor closes', async () => {
    await open('drawing01');
    expect(locking.beforeSeal.size).toBe(1);
    await act(async () => useApp.setState({ drawing: null }));
    await settle();
    expect(locking.beforeSeal.size).toBe(0);
  });

  it('is offered back when the same drawing opens again, and restoring it opens the copy', async () => {
    keepCopy({ requestId: 'drawing01', noteId: 'note1', id: 'drawing01', at: NOW - 3 * DAY });
    const e = await open('drawing01');
    expect(nameOf(question()!)).toBe('Restore your unsaved drawing?');
    // Saved again on another device since the copy was made: restoring replaces that.
    expect(text(question()!)).toContain('The drawing has been saved again since then');
    await click(byName('Restore it', 'button', question()!));
    await settle();
    expect((excal.props!.initialData as { elements: El[] }).elements.map((x) => x.id)).toEqual(['crash']);
    // Not saved yet: leaving asks first.
    await click(bar('Cancel'));
    expect(nameOf(question()!)).toBe('Discard changes to this drawing?');
    await click(byName('Cancel', 'button', question()!));
    expect(e.answered()).toBeNull();
  });

  it('is kept for next time on “Not now”, and the saved drawing opens', async () => {
    keepCopy({ requestId: 'drawing01', noteId: 'note1', id: 'drawing01' });
    await open('drawing01');
    await click(byName('Not now', 'button', question()!));
    await settle();
    expect((excal.props!.initialData as { elements: El[] }).elements.map((x) => x.id)).toEqual(['saved']);
    expect(backup()).not.toBeNull();
  });

  it('isn’t offered for another drawing, a new drawing from another note, or when it’s weeks old', async () => {
    keepCopy({ requestId: 'drawing01', noteId: 'note1' });
    await open('drawing02');
    expect(question()).toBeNull();
    await unmountAll();

    keepCopy({ requestId: null, noteId: 'note1' });
    await act(async () => useApp.setState({ drawing: null }));
    await open(null, 'note2');
    expect(question()).toBeNull();
    await unmountAll();

    keepCopy({ requestId: null, noteId: 'note1', at: NOW - 15 * DAY });
    await act(async () => useApp.setState({ drawing: null }));
    await open(null, 'note1');
    expect(question()).toBeNull();
  });

  it('opens even when the saved drawing can’t be reached (offline), if restored', async () => {
    vi.mocked(api.getDrawingScene).mockRejectedValue(new TypeError('Failed to fetch'));
    keepCopy({ requestId: 'drawing01', noteId: 'note1', id: 'drawing01' });
    await open('drawing01');
    expect(text(question()!)).toContain('The saved version can’t be reached right now.');
    await click(byName('Restore it', 'button', question()!));
    await settle();
    expect(editor().querySelector('.excalidraw-stub')).not.toBeNull();
  });

  it('goes when changes are discarded on purpose', async () => {
    const e = await open('drawing01');
    await draw({ id: 'line', type: 'line', version: 1 });
    await advance(15_000);
    expect(backup()).not.toBeNull();
    await click(bar('Cancel'));
    await click(byName('Discard', 'button', question()!));
    expect(await e.result).toBe('drawing01');
    expect(backup()).toBeNull();
  });

  it('goes once the drawing is saved', async () => {
    const e = await open('drawing01');
    await draw({ id: 'line', type: 'line', version: 1 });
    await advance(15_000);
    await click(bar('Done'));
    await settle();
    expect(await e.result).toBe('drawing01');
    expect(backup()).toBeNull();
  });
});

describe('saving', () => {
  it('saves on top of the revision it opened, with the drawing’s words for search', async () => {
    const e = await open('drawing01');
    await draw({ id: 't', type: 'text', version: 1, text: 'Hello board' });
    await click(bar('Done'));
    await settle();
    expect(saves).toHaveLength(1);
    expect(saves[0].id).toBe('drawing01');
    expect(saves[0].data).toMatchObject({ noteId: 'note1', baseRev: 'rev-1', text: 'Hello board', createdAt: NOW - 10 * DAY });
    expect(saves[0].data.svg).toContain('<svg');
    expect(await e.result).toBe('drawing01');
  });

  it('a new drawing saves as new (no revision to check), and Save keeps it open with the next save on top of the first', async () => {
    const e = await open(null);
    await draw({ id: 'box', type: 'rectangle', version: 1 });
    await click(bar('Save'));
    await settle();
    expect(saves[0].data.baseRev).toBeNull();
    expect(text()).toContain('Drawing saved');
    expect(e.answered()).toBeNull();
    await draw({ id: 'box2', type: 'rectangle', version: 1 });
    await click(bar('Done'));
    await settle();
    expect(saves[1].id).toBe(saves[0].id);
    expect(saves[1].data.baseRev).toBe('rev-2');
    expect(await e.result).toBe(saves[0].id);
  });

  it('closes an empty new drawing without saving anything', async () => {
    const e = await open(null);
    await click(bar('Done'));
    await settle();
    expect(saves).toEqual([]);
    expect(await e.result).toBeNull();
  });

  it('closes a drawing with no changes at once, and still hands back one saved earlier', async () => {
    const e = await open(null);
    await draw({ id: 'box', type: 'rectangle', version: 1 });
    await click(bar('Save'));
    await settle();
    await click(bar('Cancel'));
    expect(question()).toBeNull();
    expect(await e.result).toBe(saves[0].id);
  });

  it('says when a save fails and keeps everything open, the copy on the device included', async () => {
    saveAnswers.push(async () => {
      throw new ApiError(507, 'storage_full', 'Storage is full.');
    });
    const e = await open('drawing01');
    await draw({ id: 'line', type: 'line', version: 1 });
    await click(bar('Done'));
    await settle();
    expect(text()).toContain('Couldn’t save the drawing: Storage is full.');
    expect(e.answered()).toBeNull();
    expect((bar('Done') as HTMLButtonElement).disabled).toBe(false);
    await advance(15_000);
    expect(backup()).not.toBeNull();
  });

  it('shows it’s saving, with the buttons held until it’s done', async () => {
    let finish!: () => void;
    saveAnswers.push((id) => new Promise((r) => (finish = () => r({ id, rev: 'rev-9', note_id: 'note1', storage: 'kv', size: 1, created_at: NOW, updated_at: NOW }))));
    const e = await open('drawing01');
    await draw({ id: 'line', type: 'line', version: 1 });
    await click(bar('Done'));
    await settle();
    expect(bar('Saving…')).toBeTruthy();
    expect((bar('Saving…') as HTMLButtonElement).disabled).toBe(true);
    expect((bar('Cancel') as HTMLButtonElement).disabled).toBe(true);
    await act(async () => finish());
    await settle();
    expect(await e.result).toBe('drawing01');
  });
});

describe('a drawing changed somewhere else meanwhile', () => {
  const conflict = () => async () => {
    throw new ApiError(409, 'drawing_conflict', 'Changed elsewhere.', {
      drawing: { id: 'drawing01', rev: 'rev-theirs', note_id: 'note1', storage: 'kv', size: 1, created_at: NOW, updated_at: NOW - 60_000 },
    });
  };

  it('asks what to do, and Save as a copy saves this one under a new id, for the note', async () => {
    saveAnswers.push(conflict());
    const e = await open('drawing01');
    await draw({ id: 'line', type: 'line', version: 1 });
    await click(bar('Done'));
    await settle();
    expect(nameOf(question()!)).toBe('This drawing was changed somewhere else');
    await click(byName('Save as a copy', 'button', question()!));
    await settle();
    expect(saves).toHaveLength(2);
    expect(saves[1].id).not.toBe('drawing01');
    expect(saves[1].data.baseRev).toBeNull();
    expect(saves[1].data.createdAt).toBeUndefined();
    expect(await e.result).toBe(saves[1].id);
  });

  it('Replace theirs saves over exactly the version reported', async () => {
    saveAnswers.push(conflict());
    const e = await open('drawing01');
    await draw({ id: 'line', type: 'line', version: 1 });
    await click(bar('Done'));
    await settle();
    await click(byName('Replace theirs', 'button', question()!));
    await settle();
    expect(saves[1]).toMatchObject({ id: 'drawing01', data: { baseRev: 'rev-theirs' } });
    expect(await e.result).toBe('drawing01');
  });

  it('Keep editing saves nothing and leaves the drawing open with its changes', async () => {
    saveAnswers.push(conflict());
    const e = await open('drawing01');
    await draw({ id: 'line', type: 'line', version: 1 });
    await click(bar('Done'));
    await settle();
    await click(byName('Keep editing', 'button', question()!));
    await settle();
    expect(saves).toHaveLength(1);
    expect(e.answered()).toBeNull();
    expect((bar('Done') as HTMLButtonElement).disabled).toBe(false);
    // Still unsaved: leaving asks.
    await click(bar('Cancel'));
    expect(nameOf(question()!)).toBe('Discard changes to this drawing?');
  });
});

describe('leaving with unsaved changes', () => {
  it('asks first, and keeps everything when the answer is no', async () => {
    const e = await open('drawing01');
    await draw({ id: 'line', type: 'line', version: 1 });
    await click(bar('Cancel'));
    const q = question()!;
    expect(nameOf(q)).toBe('Discard changes to this drawing?');
    expect(byName('Discard', 'button', q).className).toContain('btn-danger');
    await click(byName('Cancel', 'button', q));
    expect(e.answered()).toBeNull();
    expect(useApp.getState().drawing).not.toBeNull();
  });
});
