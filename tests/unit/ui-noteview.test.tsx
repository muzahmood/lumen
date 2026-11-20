// @vitest-environment jsdom
/**
 * The note view (src/components/NoteView.tsx) with the app's real store, autosave and API client,
 * against a stand-in server: loading, the title, folder path and chips, Edit / Split / Read, word
 * counts, saving (Ctrl/⌘ S and the save indicator), a conflict with another device and its four ways
 * out, a note in the trash, the ⋯ menu, links and mentions, the outline, and the clean-up of a new note
 * left empty. What's checked is what README's "What's in it" promises.
 */
import {
  advance,
  allByName,
  elapse,
  byName,
  clipboard,
  click,
  dialog,
  fakeServer,
  FAKE_TIMERS,
  metaOf,
  mount,
  phone,
  press,
  queryByName,
  resetMedia,
  setMedia,
  settle,
  text,
  typeInto,
  unmountAll,
  useServer,
  type FakeServer,
  type ServerNote,
  settleUntil,
} from './ui-note-helpers';
import { act } from 'react';
import { EditorSelection } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('mermaid', () => ({ default: { initialize: () => {}, render: async (id: string) => ({ svg: `<svg id="${id}"></svg>` }) } }));

import { NoteView } from '../../src/components/NoteView';
import { DialogHost, Toasts } from '../../src/components/ui';
import { setCodec, setKeyGen } from '../../src/lib/api';
import { decryptText, encryptText, newMasterKey } from '../../src/lib/crypto';
import { createCodec } from '../../src/lib/e2ee';
import { forget, statusOf } from '../../src/lib/saver';
import { useSettings } from '../../src/lib/settings';
import { noteCache, upsertMeta, useApp } from '../../src/lib/store';
import type { Folder } from '../../src/lib/types';

const NOW = 1_763_400_000_000;
const MINUTE = 60_000;

let server: FakeServer;
let seq = 0;
const used: string[] = [];
const nextId = (prefix = 'note') => {
  const id = `${prefix}${++seq}x`;
  used.push(id);
  return id;
};

/** A note on the server, in the note list, open in a NoteView (with the dialogs and toasts beside it). */
async function openNote(init: Partial<ServerNote> = {}, opts: { cached?: boolean; others?: Array<Partial<ServerNote> & { id: string }> } = {}) {
  const id = init.id ?? nextId();
  if (!used.includes(id)) used.push(id);
  const row = server.add({ title: 'Plans', content: 'Some words here', version: 2, created_at: NOW - 60 * MINUTE, updated_at: NOW - 5 * MINUTE, ...init, id });
  for (const o of opts.others ?? []) {
    used.push(o.id);
    upsertMeta(metaOf(server.add({ created_at: NOW - 60 * MINUTE, updated_at: NOW - 30 * MINUTE, ...o })));
  }
  upsertMeta(metaOf(row));
  if (opts.cached) noteCache.set(id, { ...row });
  useApp.setState({ noteId: id });
  const view = await mount(
    <>
      <NoteView noteId={id} />
      <DialogHost />
      <Toasts />
    </>,
  );
  await settle();
  return { id, row, ...view };
}

const pane = () => document.querySelector<HTMLElement>('section.note-pane')!;
const titleBox = () => byName<HTMLTextAreaElement>('Note title', 'textarea');
const editorView = () => {
  const dom = document.querySelector<HTMLElement>('.cm-editor');
  return dom ? EditorView.findFromDOM(dom) : null;
};
const editorText = () => editorView()?.state.doc.toString() ?? null;
async function typeInEditor(insert: string, at?: number) {
  const view = editorView()!;
  await act(async () => view.dispatch({ changes: { from: at ?? view.state.doc.length, insert } }));
}
const mode = () => document.querySelector('[role="radiogroup"][aria-label="View"] [aria-checked="true"]')?.getAttribute('data-value') ?? null;
const meta = () => pane().querySelector('.props-meta')?.textContent ?? '';
const toastMessages = () => useApp.getState().toasts.map((t) => t.message);
const patches = (id?: string) => server.requests('PATCH', id ? `/api/notes/${id}` : undefined).map((r) => r.body!);
const banner = () => pane().querySelector<HTMLElement>('.alert-danger');
const saveState = () => pane().querySelector<HTMLElement>('.save-state')!;

async function openMenu(label: string) {
  await click(byName(label, 'button[aria-haspopup="menu"]'));
  await advance(20);
  return document.querySelector<HTMLElement>('[role="menu"]')!;
}

/** A change saved on another device, which this device learns of when it next saves. */
function changedElsewhere(id: string, content: string, title?: string) {
  server.savedElsewhere(id, { content, ...(title ? { title } : {}) });
  // Saved there two minutes before this device tries to save.
  server.notes.get(id)!.updated_at = Date.now() - 2 * MINUTE;
}

beforeEach(() => {
  vi.useFakeTimers({ ...FAKE_TIMERS, now: NOW });
  server = fakeServer();
  useServer(server);
  localStorage.clear();
  sessionStorage.clear();
  clipboard.written = [];
  clipboard.fail = false;
  resetMedia();
  useApp.setState({
    status: 'ready',
    notes: {},
    folders: [],
    noteId: null,
    toasts: [],
    dialog: null,
    historyFor: null,
    exportFor: null,
    focusMode: false,
    drawing: null,
    mermaid: null,
    anchor: null,
    lightbox: null,
    filter: { kind: 'all' },
    me: { email: 'owner@example.com', verified: true, via: 'access', accessConfigured: true, storage: 'kv', maxUploadBytes: 25 * 1024 * 1024 },
  });
  useSettings.setState({
    defaultMode: 'edit',
    livePreview: true,
    showOutline: true,
    sidebarCollapsed: false,
    spellcheck: false,
    editorImages: true,
    lineBreaks: true,
  });
});

afterEach(async () => {
  useApp.setState({ noteId: null, dialog: null });
  await unmountAll();
  // Let the clean-up of empty notes and any saves started by unmounting finish against this server.
  await advance(2000);
  for (const id of used.splice(0)) {
    forget(id);
    noteCache.delete(id);
  }
  // A retry the autosave left armed fires now, finding nothing to send, so the next test starts clean.
  await advance(25_000);
  setCodec(null);
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/* ------------------------------------------------------------------ */

describe('opening a note', () => {
  it('shows a placeholder while the note loads, then its title and text', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    server.intercept = async (req) => {
      if (req.method === 'GET' && /^\/api\/notes\/[^/]+$/.test(req.path)) await gate;
      return undefined;
    };
    const id = nextId();
    server.add({ id, title: 'Plans', content: 'Hello there', version: 2 });
    upsertMeta(metaOf(server.notes.get(id)!));
    useApp.setState({ noteId: id });
    await mount(<NoteView noteId={id} />);
    expect(pane().querySelector('.skeleton')).not.toBeNull();
    expect(document.querySelector('textarea')).toBeNull();
    release();
    await settle();
    expect(titleBox().value).toBe('Plans');
    expect(editorText()).toBe('Hello there');
    expect(pane().getAttribute('aria-label')).toBe('Plans');
  });

  it('opens at once from this device’s copy, without waiting for the server', async () => {
    server.offline = true;
    const { id } = await openNote({ content: 'Kept here' }, { cached: true });
    expect(editorText()).toBe('Kept here');
    expect(pane().querySelector('.note-message')).toBeNull();
    expect(id).toBeTruthy();
  });

  it('says why a note can’t be opened, with a way to reload', async () => {
    server.offline = true;
    await openNote({ content: 'unreachable' });
    expect(pane().querySelector('.note-message')?.textContent).toContain('Can’t reach the server');
    expect(byName('Reload')).toBeTruthy();
    expect(document.querySelector('textarea')).toBeNull();
  });

  it('opens a note with text in the mode chosen in Settings, and an empty one in Edit', async () => {
    useSettings.setState({ defaultMode: 'read' });
    await openNote({ content: 'Has text' });
    expect(mode()).toBe('read');
    await unmountAll();
    await openNote({ content: '   ' });
    expect(mode()).toBe('edit');
  });

  it('shows text another device saved since, once nothing is waiting to be saved here', async () => {
    const { id } = await openNote({ content: 'first' });
    server.savedElsewhere(id, { content: 'second' });
    await act(async () => upsertMeta(metaOf(server.notes.get(id)!)));
    await settle();
    expect(editorText()).toBe('second');
    expect(patches()).toEqual([]);
  });

  it('keeps what’s typed here when another device’s save arrives meanwhile', async () => {
    const { id } = await openNote({ content: 'first' });
    await typeInEditor(' typed');
    server.savedElsewhere(id, { content: 'second' });
    await act(async () => upsertMeta(metaOf(server.notes.get(id)!)));
    await settle();
    expect(editorText()).toBe('first typed');
  });
});

describe('the title', () => {
  it('is a labelled box whose changes show in the note list at once and are saved after a pause', async () => {
    const { id } = await openNote({ title: 'Plans' });
    await typeInto(titleBox(), 'Better plans');
    expect(useApp.getState().notes[id].title).toBe('Better plans');
    expect(patches()).toEqual([]);
    await advance(1000);
    expect(patches(id)).toEqual([expect.objectContaining({ title: 'Better plans', baseVersion: 2 })]);
    expect(server.notes.get(id)!.title).toBe('Better plans');
  });

  it('keeps a title on one line', async () => {
    const { id } = await openNote({ title: 'Plans' });
    await typeInto(titleBox(), 'Two\nlines');
    expect(titleBox().value).toBe('Two lines');
    await advance(1000);
    expect(server.notes.get(id)!.title).toBe('Two lines');
  });

  it('moves to the text on Enter, switching to editing from reading', async () => {
    useSettings.setState({ defaultMode: 'read' });
    await openNote({ content: 'Body' });
    expect(mode()).toBe('read');
    await press('Enter', {}, titleBox());
    await advance(20);
    expect(mode()).toBe('edit');
    expect(editorView()?.hasFocus).toBe(true);
    expect(titleBox().value).toBe('Plans');
  });
});

describe('where the note is', () => {
  const folders: Folder[] = [
    { id: 'f1', parent_id: null, name: 'Work', sort: 0, created_at: 0, updated_at: 0 },
    { id: 'f2', parent_id: 'f1', name: 'Clients', sort: 0, created_at: 0, updated_at: 0 },
    { id: 'f3', parent_id: 'f2', name: 'Acme', sort: 0, created_at: 0, updated_at: 0 },
    { id: 'f4', parent_id: 'f3', name: 'Q4', sort: 0, created_at: 0, updated_at: 0 },
    { id: 'f5', parent_id: null, name: 'Home', sort: 0, created_at: 0, updated_at: 0 },
  ];

  it('shows Notes above a note in no folder, which lists every note', async () => {
    useApp.setState({ filter: { kind: 'folder', id: 'f5' } });
    await openNote();
    const crumbs = byName('Location', 'nav');
    expect(text(crumbs)).toContain('Notes');
    await click(byName('Notes', 'button', crumbs));
    expect(useApp.getState().filter).toEqual({ kind: 'all' });
  });

  it('shows the whole folder path, each folder opening its list; a deep one keeps the first and last two', async () => {
    useApp.setState({ folders });
    await openNote({ folder_id: 'f2' });
    let crumbs = byName('Location', 'nav');
    expect(Array.from(crumbs.querySelectorAll('button.crumb')).map((b) => b.textContent)).toEqual(['Work', 'Clients']);
    await click(byName('Work', 'button', crumbs));
    expect(useApp.getState().filter).toEqual({ kind: 'folder', id: 'f1' });
    await unmountAll();
    await openNote({ folder_id: 'f4' });
    crumbs = byName('Location', 'nav');
    expect(Array.from(crumbs.querySelectorAll('button.crumb')).map((b) => b.textContent)).toEqual(['Work', 'Acme', 'Q4']);
    expect(crumbs.querySelector('.crumb-gap')?.getAttribute('data-tip')).toBe('Clients');
  });

  it('moves the note to another folder from its folder chip, with the current one ticked', async () => {
    useApp.setState({ folders });
    const { id } = await openNote({ folder_id: 'f5' });
    const menu = await openMenu('Home, change folder');
    expect(menu.getAttribute('aria-label')).toBe('Home, change folder');
    expect(text(menu)).toContain('Move to');
    expect(byName('Home', '[role^="menuitem"]', menu).className).toContain('is-checked');
    await click(byName('Acme', '[role^="menuitem"]', menu));
    await settle();
    expect(patches(id)).toEqual([{ folder_id: 'f3' }]);
    expect(useApp.getState().notes[id].folder_id).toBe('f3');
    expect(byName('Acme, change folder', 'button')).toBeTruthy();
    expect(document.querySelector('[role="menu"]')).toBeNull();
  });

  it('puts the note back where it was, and says why, when the move doesn’t save', async () => {
    useApp.setState({ folders });
    const { id } = await openNote({ folder_id: 'f5' });
    server.offline = true;
    const menu = await openMenu('Home, change folder');
    await click(byName('Work', '[role^="menuitem"]', menu));
    await settle();
    expect(useApp.getState().notes[id].folder_id).toBe('f5');
    expect(toastMessages()).toEqual([expect.stringContaining('reach the server')]);
  });
});

describe('tags', () => {
  it('saves a tag added under the title', async () => {
    const { id } = await openNote({ tags: ['work'] });
    await typeInto(byName('Add tag', 'input'), 'ideas');
    await press('Enter', {}, byName('Add tag', 'input'));
    await settle();
    expect(patches(id)).toEqual([{ tags: ['work', 'ideas'] }]);
    expect(server.notes.get(id)!.tags).toEqual(['work', 'ideas']);
  });

  it('can’t be changed when this device couldn’t decrypt them', async () => {
    const id = nextId();
    server.add({ id, title: 'Sealed', content: 'x', version: 2 });
    upsertMeta({ ...metaOf(server.notes.get(id)!), tags: [], tagsUnreadable: true });
    server.intercept = (req) =>
      req.method === 'GET' && req.path === `/api/notes/${id}`
        ? new Response(JSON.stringify({ ...server.notes.get(id), tagsUnreadable: true }), { headers: { 'content-type': 'application/json' } })
        : undefined;
    useApp.setState({ noteId: id });
    await mount(<NoteView noteId={id} />);
    await settle();
    expect(queryByName('Add tag', 'input')).toBeNull();
  });
});

describe('Edit, Split and Read', () => {
  it('switches with the View buttons, offering Split only on a wide screen', async () => {
    await openNote({ content: '# One\n\nText' });
    const group = byName('View', '[role="radiogroup"]');
    expect(allByName(/./, '[role="radio"]', group).map((b) => b.getAttribute('data-value'))).toEqual(['edit', 'split', 'read']);
    await click(byName('Read', '[role="radio"]', group));
    expect(mode()).toBe('read');
    expect(pane().querySelector('.kb-prose, .preview')).not.toBeNull();
    expect(editorView()).toBeNull();
    await click(byName('Split', '[role="radio"]', group));
    expect(mode()).toBe('split');
    expect(editorView()).not.toBeNull();
    await setMedia('(min-width: 1100px)', false);
    await setMedia('(min-width: 1360px)', false);
    expect(queryByName('Split', '[role="radio"]')).toBeNull();
    // Split on a narrow screen is editing.
    expect(mode()).toBe('edit');
  });

  it('switches between reading and editing with Ctrl/⌘ E, wherever the focus is', async () => {
    await openNote({ content: 'Text' });
    expect(mode()).toBe('edit');
    const ctrl = await press('e', { ctrl: true }, document.body);
    expect(ctrl.defaultPrevented).toBe(true);
    expect(mode()).toBe('read');
    await press('e', { meta: true }, titleBox());
    expect(mode()).toBe('edit');
    await press('E', { ctrl: true }, editorView()!.contentDOM);
    expect(mode()).toBe('read');
  });

  it('leaves Ctrl/⌘ E alone while the drawing or diagram editor is open, and Ctrl/⌘ Shift E always', async () => {
    await openNote({ content: 'Text' });
    useApp.setState({ mermaid: { code: '', isNew: true, resolve: () => undefined } });
    await press('e', { ctrl: true }, document.body);
    expect(mode()).toBe('edit');
    useApp.setState({ mermaid: null, drawing: { drawingId: null, noteId: null, resolve: () => undefined } });
    await press('e', { ctrl: true }, document.body);
    expect(mode()).toBe('edit');
    useApp.setState({ drawing: null });
    await press('E', { ctrl: true, shift: true }, document.body);
    expect(mode()).toBe('edit');
  });

  it('on a phone, offers one Edit or Read button and no Split', async () => {
    await phone();
    await openNote({ content: 'Text' });
    expect(queryByName('View', '[role="radiogroup"]')).toBeNull();
    await click(byName('Read'));
    expect(editorView()).toBeNull();
    await click(byName('Edit'));
    expect(editorView()).not.toBeNull();
    expect(byName('Back')).toBeTruthy();
  });

  it('ticks a task from reading view, and saves it', async () => {
    useSettings.setState({ defaultMode: 'read' });
    const { id } = await openNote({ content: '- [ ] call Sam\n- [ ] buy milk' });
    const boxes = pane().querySelectorAll<HTMLInputElement>('input.kb-task-box');
    await click(boxes[1]);
    await advance(1000);
    expect(server.notes.get(id)!.content).toBe('- [ ] call Sam\n- [x] buy milk');
  });

  it('ticks a repeating task from reading view: dated, and back above it for its next day', async () => {
    useSettings.setState({ defaultMode: 'read' });
    const { id } = await openNote({ content: '- [ ] stretch 🔁 every day 📅 2025-11-17' });
    await click(pane().querySelector<HTMLInputElement>('input.kb-task-box')!);
    await advance(1000);
    expect(server.notes.get(id)!.content).toBe('- [ ] stretch 🔁 every day 📅 2025-11-18\n- [x] stretch 🔁 every day 📅 2025-11-17 ✅ 2025-11-17');
  });

  it('offers to start writing in an empty note shown for reading', async () => {
    useSettings.setState({ defaultMode: 'read' });
    await openNote({ content: '' });
    await click(byName('Read', '[role="radio"]'));
    const start = byName('This note is empty. Click to start writing.');
    await click(start);
    expect(mode()).toBe('edit');
  });
});

describe('word count', () => {
  it('counts the note’s words with a reading time, and the words selected', async () => {
    await openNote({ content: 'One two three four five' });
    expect(meta()).toContain('5 words, 1 min read');
    await act(async () => editorView()!.dispatch({ selection: EditorSelection.range(4, 13) }));
    expect(meta()).toContain('2 of 5 words selected');
    await act(async () => editorView()!.dispatch({ selection: EditorSelection.cursor(0) }));
    expect(meta()).toContain('5 words, 1 min read');
  });

  it('says one word, not one words', async () => {
    await openNote({ content: 'Hello' });
    expect(meta()).toContain('1 word, 1 min read');
  });

  it('follows the text as it’s typed', async () => {
    await openNote({ content: 'One' });
    await typeInEditor(' two');
    await advance(50);
    expect(meta()).toContain('2 words');
  });
});

describe('saving', () => {
  it('saves typing after a pause, showing Saving until it’s done', async () => {
    const { id } = await openNote({ content: 'Start' });
    await typeInEditor(' more');
    expect(saveState().textContent).toContain('Saving');
    await advance(1000);
    expect(server.notes.get(id)!.content).toBe('Start more');
    expect(saveState().className).toContain('is-saved');
    expect(saveState().getAttribute('role')).toBe('status');
    expect(saveState().textContent).toContain('All changes saved');
  });

  it('saves at once on Ctrl/⌘ S and says so', async () => {
    const { id } = await openNote({ content: 'Start' });
    await typeInEditor('!');
    const e = await press('s', { ctrl: true }, editorView()!.contentDOM);
    expect(e.defaultPrevented).toBe(true);
    await settle();
    expect(server.notes.get(id)!.content).toBe('Start!');
    expect(toastMessages()).toEqual(['All changes saved']);
  });

  it('says the changes are kept on this device when Ctrl/⌘ S finds no connection', async () => {
    const { id } = await openNote({ content: 'Start' });
    await typeInEditor('!');
    server.offline = true;
    await press('s', { ctrl: true }, document.body);
    await settle();
    expect(statusOf(id)).toBe('offline');
    expect(toastMessages()).toEqual(['You’re offline. Your changes are kept on this device and sync when you reconnect.']);
    expect(saveState().textContent).toContain('Offline');
    expect(saveState().textContent).toContain('Saved on this device. Syncs when you reconnect.');
    expect(localStorage.getItem(Object.keys(localStorage).find((k) => k.startsWith(`kb.draft.${id}`)) ?? '')).toContain('Start!');
  });

  it('says why when Ctrl/⌘ S is refused, and that the text is kept', async () => {
    const { id } = await openNote({ content: 'Start' });
    await typeInEditor('!');
    server.intercept = (req) =>
      req.method === 'PATCH'
        ? new Response(JSON.stringify({ error: 'too_large', message: 'This note is too large to save.' }), { status: 413, headers: { 'content-type': 'application/json' } })
        : undefined;
    await press('s', { ctrl: true }, document.body);
    await settle();
    expect(statusOf(id)).toBe('failed');
    expect(toastMessages()).toEqual(['This note is too large to save.']);
    expect(saveState().textContent).toContain('Not saved');
    expect(saveState().textContent).toContain('Your text is kept on this device');
  });

  it('sends what’s left when the note is closed', async () => {
    const { id } = await openNote({ content: 'Start' });
    await typeInEditor(' end');
    await unmountAll();
    await settle();
    expect(server.notes.get(id)!.content).toBe('Start end');
  });
});

describe('a conflict with another device', () => {
  async function conflicted(opts: { unreadable?: boolean } = {}) {
    const note = await openNote({ title: 'Plans', content: 'base text', tags: ['work'], folder_id: null });
    await typeInEditor(' mine');
    changedElsewhere(note.id, 'their text');
    if (opts.unreadable) {
      server.intercept = (req) =>
        req.method === 'PATCH' && !req.body?.force
          ? new Response(JSON.stringify({ error: 'conflict', message: 'Changed on another device.' }), { status: 409, headers: { 'content-type': 'application/json' } })
          : undefined;
    }
    await advance(1000);
    return note;
  }

  it('stops saving and shows a banner, read out as an alert, with four ways out', async () => {
    const { id } = await conflicted();
    expect(statusOf(id)).toBe('conflict');
    expect(banner()?.getAttribute('role')).toBe('alert');
    expect(text(banner()!)).toContain('Changed on another device 2 minutes ago. Choose which version to keep.');
    expect(allByName(/./, 'button', banner()!).map((b) => b.textContent)).toEqual(['Compare', 'Keep mine', 'Keep both', 'Use theirs']);
    expect(saveState().textContent).toContain('Conflict');
    // Nothing more is sent while it waits for a choice.
    await typeInEditor(' more');
    await advance(5000);
    expect(server.notes.get(id)!.content).toBe('their text');
    expect(editorText()).toBe('base text mine more');
  });

  it('compares the two versions side by side in a dialog', async () => {
    await conflicted();
    await click(byName('Compare', 'button', banner()!));
    const d = dialog()!;
    expect(d.getAttribute('aria-label')).toBe('Compare the two versions');
    expect(text(d)).toContain('Theirs (saved on the other device)');
    expect(text(d)).toContain('Mine (on this device)');
    expect(Array.from(d.querySelectorAll('.diff-line.is-del .diff-text')).map((l) => l.textContent)).toEqual(['their text']);
    expect(Array.from(d.querySelectorAll('.diff-line.is-add .diff-text')).map((l) => l.textContent)).toEqual(['base text mine']);
    await press('Escape', {}, document.body);
    expect(dialog()).toBeNull();
    expect(banner()).not.toBeNull();
  });

  it('Keep mine saves this device’s text over theirs, which stays in the note’s history', async () => {
    const { id } = await conflicted();
    await click(byName('Keep mine', 'button', banner()!));
    await settle();
    expect(patches(id).at(-1)).toMatchObject({ content: 'base text mine', force: true });
    expect(server.notes.get(id)!.content).toBe('base text mine');
    expect(server.versions.some((v) => v.note_id === id && v.content === 'their text')).toBe(true);
    expect(banner()).toBeNull();
    expect(statusOf(id)).toBe('saved');
  });

  it('Use theirs shows their text, keeping this device’s in the note’s history, and saves nothing over theirs', async () => {
    const { id } = await conflicted();
    const before = patches(id).length;
    await click(byName('Use theirs', 'button', banner()!));
    await settle();
    expect(editorText()).toBe('their text');
    expect(banner()).toBeNull();
    // A slip of the finger loses nothing: this device's text is a saved version of the note.
    expect(server.versions.filter((v) => v.note_id === id).map((v) => v.content)).toContain('base text mine');
    await advance(2000);
    expect(patches(id)).toHaveLength(before);
    expect(server.notes.get(id)!.content).toBe('their text');
    expect(Object.keys(localStorage).filter((k) => k.startsWith(`kb.draft.${id}`))).toEqual([]);
  });

  it('Use theirs changes nothing when this device’s text can’t be kept in history (offline), and says why', async () => {
    const { id } = await conflicted();
    server.offline = true;
    await click(byName('Use theirs', 'button', banner()!));
    await settle();
    expect(statusOf(id)).toBe('conflict');
    expect(editorText()).toBe('base text mine');
    expect(banner()).not.toBeNull();
    expect(toastMessages()).toEqual([expect.stringContaining('couldn’t be kept in the note’s history, so nothing was changed')]);
  });

  it('Keep mine sent again after a dropped connection is still Keep mine, not the question again', async () => {
    const { id } = await conflicted();
    // The forced save is lost on the way; the retry must still be forced.
    let drop = true;
    server.intercept = (req) => {
      if (drop && req.method === 'PATCH') {
        drop = false;
        throw new TypeError('Failed to fetch');
      }
      return undefined;
    };
    await click(byName('Keep mine', 'button', banner()!));
    await settle();
    expect(statusOf(id)).toBe('offline');
    await advance(10_000);
    await settle();
    expect(statusOf(id)).toBe('saved');
    expect(banner()).toBeNull();
    expect(server.notes.get(id)!.content).toBe('base text mine');
    expect(patches(id).at(-1)).toMatchObject({ force: true });
  });

  it('takes out an “Uploading…” placeholder left by a page that closed mid-upload, naming the file', async () => {
    const hourAgo = (Date.now() - 2 * 3_600_000).toString(36);
    const now = Date.now().toString(36);
    const note = await openNote({
      title: 'Trip',
      content: `Day one\n![Uploading beach.jpg…](#upload-${hourAgo}-ab12)\n[Uploading ticket.pdf…](#upload-k3j4h5g6)\n![Uploading still.jpg…](#upload-${now}-cd34)\nend`,
    });
    await settle();
    // The two left behind (one by an earlier version of Lumen) go; the one still on its way stays.
    expect(editorText()).toBe(`Day one\n![Uploading still.jpg…](#upload-${now}-cd34)\nend`);
    expect(toastMessages()).toContain('Uploads didn’t finish before Lumen closed, so “beach.jpg”, “ticket.pdf” aren’t in this note. Add them again.');
    await advance(1000);
    expect(server.notes.get(note.id)!.content).toBe(`Day one\n![Uploading still.jpg…](#upload-${now}-cd34)\nend`);
  });

  it('Keep both saves this device’s text as a separate note first, then shows theirs', async () => {
    const { id } = await conflicted();
    await click(byName('Keep both', 'button', banner()!));
    await settle();
    const copy = [...server.notes.values()].find((n) => n.title === 'Plans (my version)');
    expect(copy).toMatchObject({ content: 'base text mine', tags: ['work'], folder_id: null });
    used.push(copy!.id);
    expect(editorText()).toBe('their text');
    expect(banner()).toBeNull();
    expect(toastMessages()).toContain('Your version was saved as a separate note');
    expect(useApp.getState().noteId).toBe(id);
  });

  it('Keep both pressed again after a reply that never came makes no second copy', async () => {
    const { id } = await conflicted();
    // The copy is saved, but the answer is lost on the way back: the conflict stays, as offline.
    let lose = true;
    server.intercept = (req) => {
      if (lose && req.method === 'POST' && req.path === '/api/notes') {
        lose = false;
        server.serve(req);
        throw new TypeError('Failed to fetch');
      }
      return undefined;
    };
    await click(byName('Keep both', 'button', banner()!));
    await settle();
    expect(statusOf(id)).toBe('conflict');
    await click(byName('Keep both', 'button', banner()!));
    await settle();
    const copies = [...server.notes.values()].filter((n) => n.title === 'Plans (my version)');
    expect(copies).toHaveLength(1);
    used.push(copies[0].id);
    expect(editorText()).toBe('their text');
    expect(banner()).toBeNull();
  });

  it('Keep both leaves everything as it was when the copy can’t be saved', async () => {
    const { id } = await conflicted();
    server.offline = true;
    await click(byName('Keep both', 'button', banner()!));
    await settle();
    expect(statusOf(id)).toBe('conflict');
    expect(editorText()).toBe('base text mine');
    expect(banner()).not.toBeNull();
    expect(toastMessages()).toEqual([expect.stringContaining('reach the server')]);
  });

  it('the comparison offers the same three choices', async () => {
    const { id } = await conflicted();
    await click(byName('Compare', 'button', banner()!));
    const d = dialog()!;
    expect(allByName(/./, '.modal-footer button', d).map((b) => b.textContent)).toEqual(['Keep both', 'Use theirs', 'Keep mine']);
    await click(byName('Keep mine', 'button', d));
    await settle();
    expect(dialog()).toBeNull();
    expect(server.notes.get(id)!.content).toBe('base text mine');
  });

  it('when the other version can’t be read here, offers only Keep mine and Keep both', async () => {
    const { id } = await conflicted({ unreadable: true });
    expect(statusOf(id)).toBe('conflict');
    expect(text(banner()!)).toContain('that version can’t be opened here');
    expect(allByName(/./, 'button', banner()!).map((b) => b.textContent)).toEqual(['Keep mine', 'Keep both']);
    expect(editorText()).toBe('base text mine');
  });
});

describe('a note in the trash', () => {
  const trashedNote = (init: Partial<ServerNote> = {}) =>
    openNote({ deleted_at: NOW - 2 * 24 * 60 * MINUTE, content: '- [ ] task\n\nText', tags: ['old'], ...init });

  it('says it’s in the trash, opens for reading only, and offers Restore', async () => {
    const { id } = await trashedNote();
    expect(text(pane().querySelector('.alert-warn')!)).toContain('This note is in the trash and will be deleted 30 days after it was moved there.');
    expect(editorView()).toBeNull();
    expect(titleBox().readOnly).toBe(true);
    expect(queryByName('View', '[role="radiogroup"]')).toBeNull();
    expect(queryByName('Pin to top')).toBeNull();
    expect(queryByName('Add tag', 'input')).toBeNull();
    await press('e', { ctrl: true }, document.body);
    expect(editorView()).toBeNull();
    await click(byName('Restore', 'button', pane().querySelector('.alert-warn')!));
    await settle();
    expect(server.notes.get(id)!.deleted_at).toBeNull();
    expect(toastMessages()).toContain('Note restored');
  });

  it('can’t be changed by ticking a task', async () => {
    const { id } = await trashedNote();
    const box = pane().querySelector<HTMLInputElement>('input.kb-task-box')!;
    await click(box);
    await advance(1000);
    expect(box.checked).toBe(false);
    expect(patches(id)).toEqual([]);
  });

  it('is deleted forever from the ⋯ menu only after saying yes', async () => {
    const { id } = await trashedNote();
    let menu = await openMenu('More');
    expect(allByName(/./, '[role^="menuitem"]', menu).map((b) => b.textContent)).toEqual(['Restore note', 'Delete forever']);
    await click(byName('Delete forever', '[role^="menuitem"]', menu));
    await settle();
    const ask = dialog()!;
    expect(ask.getAttribute('aria-label')).toBe('Delete this note forever?');
    expect(ask.querySelector('.btn-danger')?.textContent).toBe('Delete forever');
    await click(byName('Cancel', 'button', ask));
    await settle();
    expect(server.requests('DELETE')).toEqual([]);
    expect(server.notes.has(id)).toBe(true);
    menu = await openMenu('More');
    await click(byName('Delete forever', '[role^="menuitem"]', menu));
    await settle();
    await click(byName('Delete forever', '.btn-danger'));
    await settle();
    expect(server.notes.has(id)).toBe(false);
    expect(useApp.getState().notes[id]).toBeUndefined();
  });
});

describe('the ⋯ menu', () => {
  it('lists the note’s actions, with Move to trash marked as destructive', async () => {
    await openNote();
    const menu = await openMenu('More');
    expect(allByName(/./, '[role^="menuitem"]', menu).map((b) => b.textContent)).toEqual([
      'Version history',
      'Duplicate',
      'Copy link',
      'Show Markdown syntax',
      'Show outline',
      'Focus mode',
      'Export as PDF or Markdown…',
      'Move to trash',
    ]);
    expect(byName('Move to trash', '[role^="menuitem"]', menu).className).toContain('is-danger');
  });

  it('opens version history and export for this note', async () => {
    const { id } = await openNote();
    await click(byName('Version history', '[role^="menuitem"]', await openMenu('More')));
    expect(useApp.getState().historyFor).toBe(id);
    await click(byName('Export as PDF or Markdown…', '[role^="menuitem"]', await openMenu('More')));
    expect(useApp.getState().exportFor).toBe(id);
    expect(dialog()?.getAttribute('aria-label')).toBe('Export note');
  });

  it('copies a link to the note', async () => {
    const { id } = await openNote();
    await click(byName('Copy link', '[role^="menuitem"]', await openMenu('More')));
    await settle();
    expect(clipboard.written).toEqual([`${location.origin}/note/${id}`]);
    expect(toastMessages()).toEqual(['Link copied']);
  });

  it('switches Markdown syntax, the outline and focus mode, showing which are on', async () => {
    await openNote();
    await click(byName('Show Markdown syntax', '[role^="menuitem"]', await openMenu('More')));
    expect(useSettings.getState().livePreview).toBe(false);
    let menu = await openMenu('More');
    expect(byName('Show Markdown syntax', '[role^="menuitem"]', menu).className).toContain('is-checked');
    expect(byName('Show outline', '[role^="menuitem"]', menu).className).toContain('is-checked');
    await click(byName('Show outline', '[role^="menuitem"]', menu));
    expect(useSettings.getState().showOutline).toBe(false);
    await click(byName('Focus mode', '[role^="menuitem"]', await openMenu('More')));
    expect(useApp.getState().focusMode).toBe(true);
    menu = await openMenu('More');
    expect(queryByName('Exit focus mode', '[role^="menuitem"]', menu)).not.toBeNull();
  });

  it('duplicates the note with its text, folder and tags', async () => {
    useApp.setState({ folders: [{ id: 'f1', parent_id: null, name: 'Work', sort: 0, created_at: 0, updated_at: 0 }] });
    await openNote({ title: 'Plans', content: 'Body', folder_id: 'f1', tags: ['a'] });
    await click(byName('Duplicate', '[role^="menuitem"]', await openMenu('More')));
    await settle();
    const copy = [...server.notes.values()].find((n) => n.title === 'Plans (copy)');
    expect(copy).toMatchObject({ content: 'Body', folder_id: 'f1', tags: ['a'] });
    used.push(copy!.id);
    expect(useApp.getState().noteId).toBe(copy!.id);
  });

  it('moves the note to the trash with Undo, and leaves it', async () => {
    const { id } = await openNote();
    await click(byName('Move to trash', '[role^="menuitem"]', await openMenu('More')));
    await settle();
    expect(server.notes.get(id)!.deleted_at).not.toBeNull();
    expect(useApp.getState().noteId).toBeNull();
    const t = useApp.getState().toasts.at(-1)!;
    expect(t.message).toBe('Moved to trash');
    expect(t.action?.label).toBe('Undo');
    await click(byName('Undo', 'button.toast-action'));
    await settle();
    expect(server.notes.get(id)!.deleted_at).toBeNull();
  });

  it('closes on Escape without doing anything', async () => {
    await openNote();
    await openMenu('More');
    await press('Escape', {}, document.activeElement);
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(byName('More', 'button[aria-haspopup="menu"]').getAttribute('aria-expanded')).toBe('false');
  });
});

describe('pinning', () => {
  it('pins and unpins with the pin button, which says which it is', async () => {
    const { id } = await openNote({ pinned: false });
    const pin = byName('Pin to top');
    expect(pin.getAttribute('aria-pressed')).toBe('false');
    await click(pin);
    await settle();
    expect(server.notes.get(id)!.pinned).toBe(true);
    expect(byName('Unpin').getAttribute('aria-pressed')).toBe('true');
    await click(byName('Unpin'));
    await settle();
    expect(server.notes.get(id)!.pinned).toBe(false);
  });
});

describe('backlinks', () => {
  it('shows how many notes link here, and opens one from the chip', async () => {
    const { id } = await openNote({ title: 'Plans' }, { others: [{ id: 'linker1x', title: 'Weekly', content: 'See [[Plans]] for more', version: 3 }] });
    await advance(300);
    const chip = byName(/^1 backlink/, 'button[aria-haspopup="menu"]');
    expect(chip.textContent).toContain('1 backlink');
    await click(chip);
    await advance(20);
    const menu = document.querySelector<HTMLElement>('[role="menu"]')!;
    expect(text(menu)).toContain('Linked from');
    await click(byName('Weekly', '[role^="menuitem"]', menu));
    expect(useApp.getState().noteId).toBe('linker1x');
    expect(id).not.toBe('linker1x');
  });

  it('lists them at the end in reading view, each opening its note', async () => {
    useSettings.setState({ defaultMode: 'read' });
    await openNote({ title: 'Plans' }, { others: [{ id: 'linker2x', title: 'Weekly', excerpt: 'See Plans', content: 'See [[Plans]]', version: 3 }] });
    await advance(300);
    const aside = byName('Linked from', 'aside');
    expect(text(aside)).toContain('Linked from 1 note');
    const link = aside.querySelector('a')!;
    expect(link.getAttribute('href')).toBe('/note/linker2x');
    await click(link);
    expect(useApp.getState().noteId).toBe('linker2x');
  });

  it('looks them up again once a rename has saved, not while it’s typed', async () => {
    await openNote({ title: 'Plans' }, { others: [{ id: 'linker3x', title: 'Weekly', content: 'See [[Roadmap]]', version: 3 }] });
    await advance(300);
    expect(queryByName(/backlink/, 'button')).toBeNull();
    const lookups = () => server.log.filter((r) => r.path.endsWith('/backlinks')).length;
    const before = lookups();
    await typeInto(titleBox(), 'Roadmap');
    await elapse(800);
    expect(lookups()).toBe(before);
    await elapse(600);
    expect(lookups()).toBe(before + 1);
    expect(byName(/^1 backlink/, 'button')).toBeTruthy();
  });
});

describe('unlinked mentions', () => {
  it('lists notes that name this one without linking it, and links the first mention on request', async () => {
    await openNote(
      { title: 'Roadmap' },
      { others: [{ id: 'mention1x', title: 'Standup', content: 'We looked at the roadmap today. The Roadmap is long.', version: 4 }] },
    );
    await advance(600);
    const chip = byName('1 mention', 'button');
    expect(chip.getAttribute('aria-expanded')).toBe('false');
    expect(chip.getAttribute('aria-controls')).toBe('note-mentions');
    await click(chip);
    expect(chip.getAttribute('aria-expanded')).toBe('true');
    const panel = byName('Unlinked mentions', 'section');
    expect(panel.id).toBe('note-mentions');
    expect(text(panel)).toContain('Standup');
    expect(text(panel)).toContain('2 mentions');
    expect(panel.querySelector('mark')?.textContent).toBe('roadmap');
    await click(byName('Link', 'button', panel));
    await advance(1000);
    expect(server.notes.get('mention1x')!.content).toBe('We looked at the [[Roadmap|roadmap]] today. The Roadmap is long.');
    expect(toastMessages()).toContain('Linked in “Standup”');
  });

  it('opens the mentioning note from the list', async () => {
    await openNote({ title: 'Roadmap' }, { others: [{ id: 'mention2x', title: 'Standup', content: 'About the roadmap.', version: 4 }] });
    await advance(600);
    await click(byName('1 mention', 'button'));
    await click(byName(/Standup/, 'button.mention-note'));
    expect(useApp.getState().noteId).toBe('mention2x');
  });
});

describe('renaming a note others link to', () => {
  it('offers to update the links once the title is left, and updates them on request', async () => {
    await openNote({ title: 'Plans' }, { others: [{ id: 'relink1x', title: 'Weekly', content: 'See [[Plans]] and [[Plans#Next|next]]', version: 3 }] });
    await typeInto(titleBox(), 'Roadmap');
    await act(async () => titleBox().blur());
    await settle();
    const offer = useApp.getState().toasts.at(-1)!;
    expect(offer.message).toBe('A note links to this note as “Plans”. Update it to “Roadmap”?');
    await click(byName('Update links', 'button.toast-action'));
    await advance(1000);
    expect(server.notes.get('relink1x')!.content).toBe('See [[Roadmap]] and [[Roadmap#Next|next]]');
    expect(toastMessages()).toContain('Updated links in 1 note');
  });

  it('doesn’t offer when only the case of the title changed', async () => {
    await openNote({ title: 'Plans' }, { others: [{ id: 'relink2x', title: 'Weekly', content: 'See [[Plans]]', version: 3 }] });
    await typeInto(titleBox(), 'PLANS');
    await act(async () => titleBox().blur());
    await settle();
    expect(toastMessages()).toEqual([]);
  });
});

describe('the outline', () => {
  const doc = '# Intro\n\nHello\n\n## Details\n\nMore\n\n## End\n\nBye';

  it('lists the headings beside the note on a wide screen, and jumps to one on a click', async () => {
    await openNote({ content: doc });
    await advance(50);
    const rail = byName('On this page', 'aside');
    expect(Array.from(rail.querySelectorAll('button')).map((b) => b.textContent)).toEqual(['Intro', 'Details', 'End']);
    await click(byName('End', 'button', rail));
    const view = editorView()!;
    expect(view.state.doc.lineAt(view.state.selection.main.head).text).toBe('## End');
    expect(byName('End', 'button', rail).className).toContain('is-active');
  });

  it('is left out when turned off, on a phone, in Split, or with fewer than two headings', async () => {
    useSettings.setState({ showOutline: false });
    await openNote({ content: doc });
    expect(queryByName('On this page', 'aside')).toBeNull();
    await act(async () => useSettings.setState({ showOutline: true }));
    expect(queryByName('On this page', 'aside')).not.toBeNull();
    await click(byName('Split', '[role="radio"]'));
    expect(queryByName('On this page', 'aside')).toBeNull();
    await unmountAll();
    await openNote({ content: '# Only one' });
    expect(queryByName('On this page', 'aside')).toBeNull();
    await unmountAll();
    await phone();
    await openNote({ content: doc });
    expect(queryByName('On this page', 'aside')).toBeNull();
  });
});

describe('arriving at a line or heading', () => {
  it('puts the cursor on the task’s line when opened from the Tasks view (#L2)', async () => {
    useApp.setState({ anchor: 'L2' });
    await openNote({ content: 'zero\none\n- [ ] two\nthree' });
    await advance(50);
    const view = editorView()!;
    expect(view.state.doc.lineAt(view.state.selection.main.head).text).toBe('- [ ] two');
    expect(useApp.getState().anchor).toBeNull();
  });

  it('lets go of a link to a heading that isn’t there', async () => {
    useApp.setState({ anchor: 'h-missing' });
    await openNote({ content: '# Here\n\n# There' });
    await advance(2100);
    expect(useApp.getState().anchor).toBeNull();
  });
});

describe('a new note left empty', () => {
  async function leave() {
    await act(async () => useApp.setState({ noteId: 'somewhere-else' }));
    await unmountAll();
    await advance(700);
  }

  it('is removed when it’s left without anything typed', async () => {
    const { id } = await openNote({ title: '', content: '', version: 1 });
    await leave();
    expect(server.requests('DELETE')).toEqual([expect.objectContaining({ path: `/api/notes/${id}` })]);
    expect(server.requests('DELETE')[0].query.get('ifVersion')).toBe('1');
    expect(server.notes.has(id)).toBe(false);
    expect(useApp.getState().notes[id]).toBeUndefined();
  });

  it('is kept when it has a title, tags, a pin or a saved version, or text not yet saved', async () => {
    for (const init of [{ title: 'Named' }, { tags: ['t'] }, { pinned: true }, { version: 2 }]) {
      await openNote({ title: '', content: '', version: 1, ...init });
      await leave();
    }
    const typed = await openNote({ title: '', content: '', version: 1 });
    await typeInEditor('a thought');
    await leave();
    expect(server.requests('DELETE')).toEqual([]);
    expect(server.notes.get(typed.id)!.content).toBe('a thought');
  });

  it('is kept when it only looked empty because it couldn’t be opened', async () => {
    server.offline = true;
    const { id } = await openNote({ title: '', content: '', version: 1 });
    expect(pane().querySelector('.note-message')).not.toBeNull();
    server.offline = false;
    await leave();
    expect(server.requests('DELETE')).toEqual([]);
    expect(server.notes.has(id)).toBe(true);
  });

  it('opens with the title ready to type into', async () => {
    const id = nextId();
    const { preferredMode } = await import('../../src/lib/store');
    preferredMode.set(id, 'edit');
    await openNote({ id, title: '', content: '', version: 1 });
    await advance(50);
    expect(document.activeElement).toBe(titleBox());
    expect(pane().getAttribute('aria-label')).toBe('Untitled');
    expect(titleBox().placeholder).toBe('Untitled');
  });
});

describe('diagrams and drawings from reading view', () => {
  it('saves a diagram edited in the diagram editor back into its fence', async () => {
    useSettings.setState({ defaultMode: 'read' });
    const { id } = await openNote({ content: 'Intro\n\n```mermaid\ngraph TD\n  A --> B\n```\n\nEnd' });
    await settle();
    await click(pane().querySelector('button[data-action="edit-mermaid"]'));
    const request = useApp.getState().mermaid!;
    expect(request).toMatchObject({ code: 'graph TD\n  A --> B\n', isNew: false });
    await act(async () => {
      useApp.setState({ mermaid: null });
      request.resolve('graph LR\n  A --> C');
    });
    await advance(1000);
    expect(server.notes.get(id)!.content).toBe('Intro\n\n```mermaid\ngraph LR\n  A --> C\n```\n\nEnd');
  });

  it('leaves the note as it was when the diagram editor is cancelled', async () => {
    useSettings.setState({ defaultMode: 'read' });
    const { id } = await openNote({ content: '```mermaid\ngraph TD\n  A --> B\n```' });
    await settle();
    await click(pane().querySelector('button[data-action="edit-mermaid"]'));
    const request = useApp.getState().mermaid!;
    await act(async () => request.resolve(null));
    await advance(1000);
    expect(patches(id)).toEqual([]);
  });

  it('adds a drawing saved as a separate copy (changed elsewhere meanwhile) to the note', async () => {
    useSettings.setState({ defaultMode: 'read' });
    const { id } = await openNote({ content: '![Drawing](/api/drawings/draw_old1.svg)' });
    await settle();
    await click(pane().querySelector('button[data-action="edit-drawing"]'));
    const request = useApp.getState().drawing!;
    expect(request).toMatchObject({ drawingId: 'draw_old1', noteId: id });
    await act(async () => request.resolve('draw_new2'));
    await advance(1000);
    expect(server.notes.get(id)!.content).toBe('![Drawing](/api/drawings/draw_old1.svg)\n\n![Drawing](/api/drawings/draw_new2.svg)\n');
  });
});

describe('the export dialog', () => {
  it('opens for this note with the title and text as they are on screen, unsaved changes included', async () => {
    const { id } = await openNote({ title: 'Plans', content: 'Body' });
    await typeInto(titleBox(), 'Renamed');
    await act(async () => useApp.setState({ exportFor: id }));
    const d = dialog()!;
    expect(d.getAttribute('aria-label')).toBe('Export note');
    expect(text(d)).toContain('Renamed');
    await click(byName('Cancel', 'button', d));
    expect(useApp.getState().exportFor).toBeNull();
  });
});

describe('another device’s save while this one’s is on its way', () => {
  it('keeps what was typed here on screen and in the conflict choice, rather than only theirs', async () => {
    const { id } = await openNote({ content: 'first' });
    let releaseGet!: () => void;
    let releasePatch!: () => void;
    const getHeld = new Promise<void>((r) => (releaseGet = r));
    const patchHeld = new Promise<void>((r) => (releasePatch = r));
    server.intercept = async (req) => {
      if (req.method === 'GET' && req.path === `/api/notes/${id}`) await getHeld;
      if (req.method === 'PATCH') await patchHeld;
      return undefined;
    };
    // Another device saves; the list refresh tells this one, which fetches the note again.
    server.savedElsewhere(id, { content: 'second' });
    await act(async () => upsertMeta(metaOf(server.notes.get(id)!)));
    // Meanwhile this device types, and its save goes out.
    await typeInEditor(' mine');
    await advance(1000);
    releaseGet();
    await settle();
    releasePatch();
    await settle();
    expect(editorText()).toBe('first mine');
    expect(statusOf(id)).toBe('conflict');
    await click(byName('Keep mine', 'button', banner()!));
    await settle();
    expect(server.notes.get(id)!.content).toBe('first mine');
  });
});

describe('picking up where another device left off', () => {
  it('shows another device’s newer save in place: the same editor, with the cursor where it was', async () => {
    const { id } = await openNote({ content: 'first line\nsecond line' });
    const view = editorView()!;
    await act(async () => view.dispatch({ selection: { anchor: 3 } }));
    server.savedElsewhere(id, { content: 'first line\nsecond line\nthird line' });
    await act(async () => upsertMeta(metaOf(server.notes.get(id)!)));
    await settle();
    expect(editorText()).toBe('first line\nsecond line\nthird line');
    expect(editorView()).toBe(view);
    expect(view.state.selection.main.head).toBe(3);
    expect(patches(id)).toHaveLength(0);
  });

  it('combines edits here with a newer version’s edits to other lines, shown in place, and asks nothing', async () => {
    const { id } = await openNote({ content: 'one\ntwo\nthree' });
    const view = editorView()!;
    await typeInEditor('!', 3);
    changedElsewhere(id, 'one\ntwo\nthree, from the computer');
    await advance(1000);
    await advance(100);
    expect(editorText()).toBe('one!\ntwo\nthree, from the computer');
    expect(editorView()).toBe(view);
    expect(banner()).toBeNull();
    expect(statusOf(id)).toBe('saved');
    expect(server.notes.get(id)!.content).toBe('one!\ntwo\nthree, from the computer');
    expect(toastMessages()).toEqual(['“Plans” was also changed on another device. Both sets of changes are kept.']);
  });

  it('edits made here before a newer version they can’t be combined with: shows the newer one, keeping these in history', async () => {
    const { id } = await openNote({ title: 'Plans', content: 'base text' });
    await typeInEditor(' mine');
    server.offline = true;
    await advance(1000);
    expect(statusOf(id)).toBe('offline');
    // Ten minutes on, the computer rewrites the same line; then this device is back online.
    await advance(10 * MINUTE);
    server.offline = false;
    changedElsewhere(id, 'their text');
    await advance(11_000);
    await settle();
    expect(editorText()).toBe('their text');
    expect(banner()).toBeNull();
    expect(statusOf(id)).toBe('saved');
    expect(server.notes.get(id)!.content).toBe('their text');
    expect(server.versions.filter((v) => v.note_id === id).map((v) => v.content)).toContain('base text mine');
    expect(toastMessages().at(-1)).toContain('was changed on another device after your edits here');
  });
});

describe('typing during Keep both', () => {
  it('loses nothing typed while the copy is being saved', async () => {
    const { id } = await openNote({ title: 'Plans', content: 'base text' });
    await typeInEditor(' mine');
    changedElsewhere(id, 'their text');
    await advance(1000);
    expect(statusOf(id)).toBe('conflict');
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    server.intercept = async (req) => {
      if (req.method === 'POST' && req.path === '/api/notes') await held;
      return undefined;
    };
    await click(byName('Keep both', 'button', banner()!));
    await typeInEditor(' and more');
    release();
    await settle();
    const copy = [...server.notes.values()].find((n) => n.title === 'Plans (my version)')!;
    used.push(copy.id);
    const kept = [copy.content, editorText(), server.notes.get(id)!.content].some((t) => t?.includes('and more'));
    expect(kept).toBe(true);
  });
});

describe('the save indicator', () => {
  it('says Retrying, with the reason, while the server is failing, and saves once it’s back', async () => {
    const { id } = await openNote({ content: 'Start' });
    server.intercept = (req) =>
      req.method === 'PATCH'
        ? new Response(JSON.stringify({ error: 'busy', message: 'The server is busy.' }), { status: 503, headers: { 'content-type': 'application/json' } })
        : undefined;
    await typeInEditor('!');
    await advance(1000);
    expect(statusOf(id)).toBe('error');
    expect(saveState().textContent).toContain('Retrying');
    expect(saveState().textContent).toContain('The server is busy. Retrying automatically.');
    server.intercept = null;
    await advance(21_000);
    expect(server.notes.get(id)!.content).toBe('Start!');
    expect(saveState().className).toContain('is-saved');
  });
});

describe('words selected in reading view', () => {
  it('counts the words of text selected in the rendered note', async () => {
    useSettings.setState({ defaultMode: 'read' });
    await openNote({ content: 'Alpha beta gamma delta' });
    const para = pane().querySelector('.kb-prose p, p')!;
    const range = document.createRange();
    range.setStart(para.firstChild!, 0);
    range.setEnd(para.firstChild!, 10);
    await act(async () => {
      const sel = document.getSelection()!;
      sel.removeAllRanges();
      sel.addRange(range);
      document.dispatchEvent(new Event('selectionchange'));
    });
    expect(meta()).toContain('2 of 4 words selected');
    await act(async () => {
      document.getSelection()!.removeAllRanges();
      document.dispatchEvent(new Event('selectionchange'));
    });
    expect(meta()).toContain('4 words, 1 min read');
  });
});

describe('copying a link when the clipboard is refused', () => {
  it('shows the link instead, to copy by hand', async () => {
    const { id } = await openNote();
    clipboard.fail = true;
    await click(byName('Copy link', '[role^="menuitem"]', await openMenu('More')));
    await settle();
    expect(toastMessages()).toEqual([`${location.origin}/note/${id}`]);
  });
});

describe('the sidebar button', () => {
  it('appears while the sidebar is hidden, and shows it again', async () => {
    useSettings.setState({ sidebarCollapsed: true });
    await openNote();
    await click(byName('Show sidebar'));
    expect(useSettings.getState().sidebarCollapsed).toBe(false);
    expect(queryByName('Show sidebar')).toBeNull();
  });
});

describe('adding images and files', () => {
  let uploads: Array<{ name: string | null; noteId: string | null; type: string | null }>;
  let failUpload: string | null;
  let holdUpload: Promise<void> | null;

  beforeEach(() => {
    uploads = [];
    failUpload = null;
    holdUpload = null;
    server.intercept = async (req) => {
      if (req.method !== 'POST' || req.path !== '/api/files') return undefined;
      if (holdUpload) await holdUpload;
      if (failUpload) return new Response(JSON.stringify({ error: 'storage', message: failUpload }), { status: 507, headers: { 'content-type': 'application/json' } });
      const name = decodeURIComponent(req.headers?.['x-file-name'] ?? 'file');
      uploads.push({ name, noteId: req.headers?.['x-note-id'] ?? null, type: req.headers?.['content-type'] ?? null });
      const id = `file${uploads.length}abc`;
      return new Response(
        JSON.stringify({ id, note_id: null, name, mime: req.headers?.['content-type'] ?? 'application/octet-stream', size: 10, storage: 'kv', created_at: Date.now(), url: `/api/files/${id}/${name}` }),
        { headers: { 'content-type': 'application/json' } },
      );
    };
  });

  /** Answers the file picker the toolbar opens with `files`. */
  async function pick(files: File[]) {
    await settle();
    const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
    expect(input).not.toBeNull();
    Object.defineProperty(input, 'files', { value: files, configurable: true });
    await act(async () => void input.dispatchEvent(new Event('change')));
    await settle();
  }

  it('puts a placeholder in while an image uploads, then the image', async () => {
    const { id } = await openNote({ content: 'Intro' });
    let release!: () => void;
    holdUpload = new Promise<void>((r) => (release = r));
    await click(byName('Image', 'button', byName('Formatting', '[role="toolbar"]')));
    await pick([new File(['png'], 'photo.png', { type: 'image/png' })]);
    expect(editorText()).toMatch(/^Intro\n\n!\[Uploading photo\.png…\]\(#upload-[A-Za-z0-9_-]+\)/);
    release();
    holdUpload = null;
    await settle();
    expect(editorText()).toBe('Intro\n\n![photo](/api/files/file1abc/photo.png)\n');
    expect(uploads).toEqual([{ name: 'photo.png', noteId: id, type: 'image/png' }]);
    await advance(1000);
    expect(server.notes.get(id)!.content).toBe('Intro\n\n![photo](/api/files/file1abc/photo.png)\n');
  });

  it('takes the placeholder out again and says why when an upload fails', async () => {
    await openNote({ content: 'Intro' });
    failUpload = 'Storage is full.';
    await click(byName('Image', 'button', byName('Formatting', '[role="toolbar"]')));
    await pick([new File(['png'], 'photo.png', { type: 'image/png' })]);
    expect(editorText()).not.toContain('Uploading');
    expect(editorText()).toMatch(/^Intro\n*$/);
    expect(toastMessages()).toEqual(['Storage is full.']);
  });

  it('refuses a file over the upload limit before sending anything', async () => {
    useApp.setState({ me: { ...useApp.getState().me!, maxUploadBytes: 100 } });
    await openNote({ content: 'Intro' });
    const menu = await openMenu('More formatting');
    await click(byName('Attach a file', '[role^="menuitem"]', menu));
    await pick([new File(['x'.repeat(200)], 'big.pdf', { type: 'application/pdf' })]);
    expect(toastMessages()).toEqual(['big.pdf is larger than 100 B.']);
    expect(editorText()).toBe('Intro');
    expect(server.requests('POST', '/api/files')).toEqual([]);
  });

  it('finishes an upload into the note even after the note was left', async () => {
    const { id } = await openNote({ content: 'Intro' });
    let release!: () => void;
    holdUpload = new Promise<void>((r) => (release = r));
    await click(byName('Image', 'button', byName('Formatting', '[role="toolbar"]')));
    await pick([new File(['png'], 'late.png', { type: 'image/png' })]);
    await act(async () => useApp.setState({ noteId: 'elsewhere' }));
    await unmountAll();
    await settle();
    release();
    holdUpload = null;
    await settle();
    await advance(1000);
    expect(server.notes.get(id)!.content).toBe('Intro\n\n![late](/api/files/file1abc/late.png)\n');
  });
});

describe('pressing Keep both twice', () => {
  it('makes one copy of this device’s version, not two', async () => {
    const { id } = await openNote({ title: 'Plans', content: 'base' });
    await typeInEditor(' mine');
    changedElsewhere(id, 'theirs');
    await advance(1000);
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    server.intercept = async (req) => {
      if (req.method === 'POST' && req.path === '/api/notes') await held;
      return undefined;
    };
    const keepBoth = byName('Keep both', 'button', banner()!);
    await click(keepBoth);
    await click(keepBoth);
    release();
    await settle();
    const copies = [...server.notes.values()].filter((n) => n.title === 'Plans (my version)');
    copies.forEach((c) => used.push(c.id));
    expect(copies).toHaveLength(1);
  });
});

describe('accessibility of the note’s menus and outline', () => {
  it('tells screen readers which folder the note is in, and which ⋯ options are on', async () => {
    useApp.setState({ folders: [{ id: 'f1', parent_id: null, name: 'Work', sort: 0, created_at: 0, updated_at: 0 }] });
    await openNote({ folder_id: 'f1' });
    const moveMenu = await openMenu('Work, change folder');
    const current = byName('Work', '[role^="menuitem"]', moveMenu);
    expect(current.getAttribute('aria-checked')).toBe('true');
    expect(byName('No folder', '[role^="menuitem"]', moveMenu).getAttribute('aria-checked')).toBe('false');
    await press('Escape', {}, document.activeElement);
    const more = await openMenu('More');
    expect(byName('Show outline', '[role^="menuitem"]', more).getAttribute('aria-checked')).toBe('true');
  });

  it('marks the section you’re in for screen readers as well as by look', async () => {
    await openNote({ content: '# Intro\n\nHello\n\n## Details\n\nMore' });
    await advance(50);
    const rail = byName('On this page', 'aside');
    await click(byName('Details', 'button', rail));
    expect(byName('Details', 'button', rail).className).toContain('is-active');
    expect(byName('Details', 'button', rail).getAttribute('aria-current')).toBe('location');
    expect(byName('Intro', 'button', rail).hasAttribute('aria-current')).toBe(false);
  });
});

/* ------------------------------------------------ an encrypted library --- */

describe('with end-to-end encryption on', () => {
  let key: CryptoKey;
  const at = (id: string, field: string) => `lumen/1/note/${id}/${field}`;
  const preview = (content: string) => JSON.stringify({ v: 6, e: content.slice(0, 100), i: {}, l: { n: [], w: [] } });

  /** A note as an encrypted library stores it: ciphertext, with the plaintext only in this device's list. */
  async function openSealed(init: { title: string; content: string; tags?: string[] }) {
    const id = nextId('sealed');
    const tags = init.tags ?? [];
    server.add({
      id,
      title: '',
      tags: [],
      content: await encryptText(key, init.content, at(id, 'content')),
      version: 2,
      enc: true,
      kgen: 0,
      sealed: {
        t: await encryptText(key, init.title, at(id, 'title')),
        g: await encryptText(key, JSON.stringify(tags), at(id, 'tags')),
        p: await encryptText(key, preview(init.content), at(id, 'preview')),
      },
    });
    const { content: _c, sealed: _s, enc: _e, kgen: _k, ...meta } = server.notes.get(id)!;
    upsertMeta({ ...meta, title: init.title, tags, excerpt: init.content });
    useApp.setState({ noteId: id, encryption: { on: true, pending: 0, rekey: 0, attachments: 0 } });
    await mount(
      <>
        <NoteView noteId={id} />
        <DialogHost />
        <Toasts />
      </>,
    );
    await settleUntil(() => editorText() === init.content, 'the note to open, decrypted');
    return id;
  }

  const sentText = () => JSON.stringify(server.log.filter((r) => r.method !== 'GET').map((r) => r.body));

  beforeEach(async () => {
    key = await newMasterKey();
    setKeyGen(0);
    setCodec(createCodec(key));
  });

  it('shows the note decrypted, and saves edits without any of the text reaching the server readable', async () => {
    const id = await openSealed({ title: 'Diary', content: 'Private words', tags: ['secret'] });
    expect(titleBox().value).toBe('Diary');
    expect(editorText()).toBe('Private words');
    await typeInEditor(' and more');
    await typeInto(titleBox(), 'Dear diary');
    await advance(1000);
    await settleUntil(() => patches(id).length === 1 && statusOf(id) === 'saved', 'the encrypted save');
    expect(patches(id)).toHaveLength(1);
    expect(patches(id)[0]).toMatchObject({ enc: true, baseVersion: 2 });
    const sent = sentText();
    for (const plain of ['Private words', 'and more', 'Dear diary', 'Diary', 'secret']) expect(sent).not.toContain(plain);
    const row = server.notes.get(id)!;
    expect(await decryptText(key, row.content, at(id, 'content'))).toBe('Private words and more');
    expect(await decryptText(key, row.sealed!.t, at(id, 'title'))).toBe('Dear diary');
  });

  it('shows another device’s version decrypted in a conflict, and Keep both makes the copy encrypted', async () => {
    const id = await openSealed({ title: 'Diary', content: 'base' });
    await typeInEditor(' mine');
    const row = server.notes.get(id)!;
    row.content = await encryptText(key, 'their words', at(id, 'content'));
    row.version++;
    await advance(1000);
    await settleUntil(() => statusOf(id) === 'conflict' && banner(), 'the conflict');
    expect(statusOf(id)).toBe('conflict');
    await click(byName('Compare', 'button', banner()!));
    expect(Array.from(dialog()!.querySelectorAll('.diff-line.is-del .diff-text')).map((l) => l.textContent)).toEqual(['their words']);
    await click(byName('Keep both', 'button', dialog()!));
    await settleUntil(() => [...server.notes.values()].some((n) => n.id !== id) && editorText() === 'their words', 'the copy and the switch to theirs');
    const copy = [...server.notes.values()].find((n) => n.id !== id)!;
    used.push(copy.id);
    expect(copy.enc).toBe(true);
    expect(sentText()).not.toContain('base mine');
    expect(await decryptText(key, copy.content, at(copy.id, 'content'))).toBe('base mine');
    expect(await decryptText(key, copy.sealed!.t, at(copy.id, 'title'))).toBe('Diary (my version)');
    expect(editorText()).toBe('their words');
  });

  it('says a note that can’t be decrypted can’t be opened, rather than showing it empty, and doesn’t clean it up', async () => {
    const id = nextId('sealed');
    server.add({ id, title: '', content: 'not-really-ciphertext', version: 1, enc: true, kgen: 0, sealed: {} });
    upsertMeta({ ...metaOf(server.notes.get(id)!), title: '' });
    useApp.setState({ noteId: id });
    await mount(<NoteView noteId={id} />);
    await settleUntil(() => pane()?.querySelector('.note-message'), 'the note’s message');
    expect(pane().querySelector('.note-message')?.textContent).toContain('This note can’t be decrypted.');
    await act(async () => useApp.setState({ noteId: 'elsewhere' }));
    await unmountAll();
    await advance(700);
    expect(server.requests('DELETE')).toEqual([]);
  });
});
