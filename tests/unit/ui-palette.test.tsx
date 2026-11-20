// @vitest-environment jsdom
/**
 * The quick switcher on Ctrl/⌘ K (src/components/CommandPalette.tsx): recent notes and actions when
 * empty, notes by title and by their text (searched on the device, since the library is encrypted),
 * creating a note from the typed title (also Ctrl/⌘ Enter), commands after ">", commands for the open
 * note, templates, the keyboard (↑ ↓ Enter Esc) and what a screen reader is told.
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  allByRole,
  boot,
  byRole,
  click,
  DAY,
  focus,
  focused,
  frame,
  NOW,
  press,
  queryByRole,
  queryByText,
  render,
  seedFolder,
  seedNote,
  server,
  setApp,
  setSettings,
  settle,
  teardown,
  textOf,
  toasts,
  type,
  wait,
  type Booted,
} from './ui-shell-helpers';

let h: Booted;
let CommandPalette: typeof import('../../src/components/CommandPalette').CommandPalette;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'], now: NOW });
  h = await boot();
  ({ CommandPalette } = await import('../../src/components/CommandPalette'));
});
afterEach(async () => {
  delete (navigator as { clipboard?: unknown }).clipboard;
  await teardown();
});

/** The clipboard this browser offers (jsdom has none). */
const clipboard = (value: unknown) => Object.defineProperty(navigator, 'clipboard', { value, configurable: true });

const state = () => h.store.useApp.getState();
const dialog = () => queryByRole('dialog', 'Search and commands');
const input = () => dialog()!.querySelector('input')!;
const options = () => allByRole('option', undefined, dialog()!);
/** Each option's label, without the folder name shown beside it. */
const labels = () =>
  options().map((o) => {
    const label = o.querySelector('.palette-label')!;
    return textOf(label).slice(0, textOf(label).length - textOf(label.querySelector('.palette-detail')).length).trim();
  });
const groups = () => Array.from(dialog()!.querySelectorAll('.palette-group')).map(textOf);
const selected = () => options().find((o) => o.getAttribute('aria-selected') === 'true');

async function openPalette() {
  await render(<CommandPalette />);
  await setApp({ paletteOpen: true });
  await frame();
}
/** Types into the switcher and waits for its debounce and the on-device search. */
async function query(q: string) {
  await type(input(), q);
  await wait(200);
  await settle(30);
}

async function library() {
  await seedFolder('p', 'Projects');
  await seedNote('a', { title: 'Budget 2027', content: 'numbers', updated_at: NOW - 1000, folder_id: 'p' });
  await seedNote('b', { title: 'Garden plans', content: 'plant the budget roses', updated_at: NOW - 2000 });
  await seedNote('c', { title: 'Reading list', content: 'books', updated_at: NOW - 3000 });
  await seedNote('t', { title: 'Budget draft', content: 'old', updated_at: NOW, deleted_at: NOW });
}

describe('opening and closing', () => {
  it('shows nothing until it’s opened, then a labelled modal dialog with the search box focused', async () => {
    await render(<CommandPalette />);
    expect(dialog()).toBeNull();
    await setApp({ paletteOpen: true });
    await frame();
    expect(dialog()!.getAttribute('aria-modal')).toBe('true');
    expect(document.activeElement).toBe(input());
    expect(input().getAttribute('aria-label')).toBe('Search notes or commands');
    expect(input().placeholder).toBe('Search notes, or type > for commands');
  });

  it('closes on Escape, on the Esc button and on a click outside it', async () => {
    await openPalette();
    const ev = await press('Escape', {}, input());
    expect(ev.defaultPrevented).toBe(true);
    expect(state().paletteOpen).toBe(false);
    await setApp({ paletteOpen: true });
    await click(byRole('button', 'Esc'));
    expect(state().paletteOpen).toBe(false);
    await setApp({ paletteOpen: true });
    await click(dialog()!);
    expect(state().paletteOpen).toBe(true);
    await click(document.querySelector('.overlay-palette'));
    expect(state().paletteOpen).toBe(false);
  });

  it('starts empty each time it opens', async () => {
    await library();
    await openPalette();
    await query('garden');
    await setApp({ paletteOpen: false });
    await setApp({ paletteOpen: true });
    await frame();
    expect(input().value).toBe('');
    expect(groups()[0]).toBe('Recent');
  });

  it('gives focus back to where it was when it closes', async () => {
    await render(
      <>
        <button type="button">Before</button>
        <CommandPalette />
      </>,
    );
    await focus(byRole('button', 'Before'));
    await setApp({ paletteOpen: true });
    await frame();
    expect(document.activeElement).toBe(input());
    await press('Escape', {}, input());
    expect(focused()).toBe('BUTTON: Before');
  });
});

describe('with nothing typed', () => {
  it('lists the six most recently edited notes, then the actions, leaving out the trash', async () => {
    for (let i = 0; i < 8; i++) await seedNote(`n${i}`, { title: `Note ${i}`, updated_at: NOW - i * 1000 });
    await seedNote('gone', { title: 'Gone', updated_at: NOW + 1, deleted_at: NOW });
    await openPalette();
    expect(groups()).toEqual(['Recent', 'Actions']);
    expect(labels()).toEqual([
      'Note 0',
      'Note 1',
      'Note 2',
      'Note 3',
      'Note 4',
      'Note 5',
      'New note',
      'New drawing',
      'New diagram',
      'Open today’s journal',
      'New folder',
    ]);
    expect(selected()).toBe(options()[0]);
  });

  it('shows each note’s folder and when it was edited', async () => {
    await library();
    await openPalette();
    const budget = options()[0];
    expect(textOf(budget.querySelector('.palette-detail'))).toBe('Projects');
    expect(budget.querySelector('.palette-hint')).not.toBeNull();
  });

  it('makes an untitled note on Ctrl/⌘ Enter', async () => {
    await openPalette();
    await press('Enter', { ctrlKey: true }, input());
    await settle();
    expect(state().paletteOpen).toBe(false);
    const id = state().noteId!;
    expect(state().notes[id].title).toBe('');
  });

  it('lists an empty library’s actions only', async () => {
    await openPalette();
    expect(groups()).toEqual(['Actions']);
  });
});

describe('finding notes', () => {
  it('ranks titles that start with the words first, then a word inside, then letters in order', async () => {
    await seedNote('x', { title: 'Overbudget', updated_at: NOW });
    await seedNote('y', { title: 'The budget', updated_at: NOW });
    await seedNote('z', { title: 'Budget', updated_at: NOW - 5000 });
    await seedNote('w', { title: 'Big unused dog', updated_at: NOW });
    await openPalette();
    await query('bud');
    expect(labels().slice(0, 4)).toEqual(['Budget', 'The budget', 'Overbudget', 'Big unused dog']);
    expect(groups()[0]).toBe('Notes');
  });

  it('finds notes by their text too, on this device, below the title matches', async () => {
    await library();
    await openPalette();
    await query('budget');
    expect(groups()).toEqual(['Notes', 'Found in text', 'Create']);
    expect(labels().slice(0, 2)).toEqual(['Budget 2027', 'Garden plans']);
    expect(dialog()!.querySelector('.palette-snippet mark')!.textContent).toBe('budget');
    expect(server.requests('GET', '/api/search')).toHaveLength(0);
    expect(labels()).not.toContain('Budget draft');
  });

  it('opens the highlighted note with Enter, closing itself', async () => {
    await library();
    await openPalette();
    await query('garden');
    await press('Enter', {}, input());
    expect(state()).toMatchObject({ paletteOpen: false, noteId: 'b' });
  });

  it('moves the highlight with ↑ and ↓, stopping at either end, and tells the input which is highlighted', async () => {
    await library();
    await openPalette();
    expect(input().getAttribute('aria-activedescendant')).toBe(options()[0].id);
    await press('ArrowUp', {}, input());
    expect(selected()).toBe(options()[0]);
    await press('ArrowDown', {}, input());
    await press('ArrowDown', {}, input());
    expect(selected()).toBe(options()[2]);
    expect(input().getAttribute('aria-activedescendant')).toBe(options()[2].id);
    for (let i = 0; i < 20; i++) await press('ArrowDown', {}, input());
    expect(selected()).toBe(options().at(-1));
    await press('Enter', {}, input());
    expect(state().paletteOpen).toBe(false);
  });

  it('opens a note on a click, and highlights what the pointer is over', async () => {
    await library();
    await openPalette();
    const reading = options().find((o) => textOf(o).startsWith('Reading list'))!;
    await (await import('react')).act(async () => reading.dispatchEvent(new MouseEvent('mousemove', { bubbles: true })));
    expect(selected()).toBe(reading);
    await click(reading);
    expect(state().noteId).toBe('c');
  });

  it('says when no command matches', async () => {
    await openPalette();
    await query('>zzzz');
    expect(textOf(dialog()!.querySelector('.palette-empty'))).toBe('No notes or commands match “>zzzz”');
    expect(dialog()!.querySelector('.palette-empty-tip')).toBeNull();
  });

  it('says when a search finds no note, with how to narrow it', async () => {
    await seedNote('a', { title: 'Plan', content: 'steps' });
    await openPalette();
    await query('qqqq zzzz');
    expect(labels()).toEqual(['New note “qqqq zzzz”']);
    expect(textOf(dialog()!.querySelector('.palette-empty-tip'))).toContain('Narrow a search with');
  });

  it('runs the same search filters as the list', async () => {
    await library();
    await openPalette();
    await query('in:Projects');
    expect(labels()).toContain('Budget 2027');
    expect(labels()).not.toContain('Garden plans');
  });
});

describe('creating from the typed title', () => {
  it('offers a new note with the title typed, and makes it on Enter', async () => {
    await library();
    await openPalette();
    await query('Holiday ideas');
    const create = options().find((o) => o.id === 'pal-c-create')!;
    expect(textOf(create.querySelector('.palette-label'))).toBe('New note “Holiday ideas”');
    expect(textOf(create.querySelector('.palette-hint'))).toMatch(/^(Ctrl|⌘) Enter$/);
    await press('Enter', { ctrlKey: true }, input());
    await settle();
    expect(state().notes[state().noteId!].title).toBe('Holiday ideas');
  });

  it('opens the note instead when that title exists, whatever its case', async () => {
    await library();
    await openPalette();
    await query('reading LIST');
    expect(options().some((o) => o.id === 'pal-c-create')).toBe(false);
    await press('Enter', { metaKey: true }, input());
    expect(state().noteId).toBe('c');
    expect(server.requests('POST', '/api/notes')).toHaveLength(0);
  });

  it('offers to create a title only a note in the trash has', async () => {
    await library();
    await openPalette();
    await query('Budget draft');
    expect(options().some((o) => o.id === 'pal-c-create')).toBe(true);
  });

  it('makes the new note in the folder being viewed', async () => {
    await library();
    await setApp({ filter: { kind: 'folder', id: 'p' } });
    await openPalette();
    await query('Q3 numbers');
    await press('Enter', { ctrlKey: true }, input());
    await settle();
    expect(state().notes[state().noteId!]).toMatchObject({ title: 'Q3 numbers', folder_id: 'p' });
  });
});

describe('commands', () => {
  it('lists only commands after >, best match first', async () => {
    await library();
    await openPalette();
    await query('>');
    expect(groups()).toEqual(['Actions', 'Templates', 'Go to', 'Preferences']);
    expect(labels()).not.toContain('Budget 2027');
    await query('>trash');
    expect(labels()[0]).toBe('Trash');
  });

  it('goes to each list and Tasks', async () => {
    await openPalette();
    await query('>pinned');
    await press('Enter', {}, input());
    expect(state().filter).toEqual({ kind: 'pinned' });
    await setApp({ paletteOpen: true });
    await frame();
    await query('>tasks');
    await press('Enter', {}, input());
    expect(state().screen).toBe('tasks');
    // The palette's step in Back comes off first, then Tasks takes its place.
    await vi.waitFor(() => expect(location.pathname).toBe('/tasks'));
  });

  it('goes to a saved search by its name', async () => {
    await setSettings({ savedSearches: [{ id: 'ss1', name: 'Quarterly budgets', query: 'budget tag:q' }] });
    await openPalette();
    await query('>quarterly');
    expect(labels()[0]).toBe('Quarterly budgets');
    await press('Enter', {}, input());
    expect(state().filter).toEqual({ kind: 'search', id: 'ss1' });
  });

  it('switches the theme, the sidebar and focus mode, and opens Settings', async () => {
    await openPalette();
    await query('>dark theme');
    expect(labels()[0]).toBe('Use dark theme');
    await press('Enter', {}, input());
    expect(h.settings.useSettings.getState().theme).toBe('dark');
    await setApp({ paletteOpen: true });
    await frame();
    await query('>theme');
    expect(labels()[0]).toBe('Use light theme');
    await query('>toggle sidebar');
    await press('Enter', {}, input());
    expect(h.settings.useSettings.getState().sidebarCollapsed).toBe(true);
    await setApp({ paletteOpen: true });
    await frame();
    await query('>focus');
    await press('Enter', {}, input());
    expect(state().focusMode).toBe(true);
    await setApp({ paletteOpen: true });
    await frame();
    await query('>settings');
    await press('Enter', {}, input());
    expect(state().settingsOpen).toBe(true);
  });

  it('runs commands for the open note: pin, history, duplicate, export, trash', async () => {
    await library();
    h.store.openNote('c');
    await openPalette();
    await query('>');
    expect(groups()[0]).toBe('This note');
    expect(labels().slice(0, 6)).toEqual([
      'Pin this note',
      'Version history',
      'Duplicate this note',
      'Export as PDF or Markdown',
      'Copy link to this note',
      'Move this note to trash',
    ]);
    await query('>pin this');
    await press('Enter', {}, input());
    await settle();
    expect(state().notes.c.pinned).toBe(true);
    await setApp({ paletteOpen: true });
    await frame();
    await query('>unpin');
    expect(labels()[0]).toBe('Unpin this note');
    await query('>version');
    await press('Enter', {}, input());
    expect(state().historyFor).toBe('c');
    await setApp({ paletteOpen: true });
    await frame();
    await query('>export');
    await press('Enter', {}, input());
    expect(state().exportFor).toBe('c');
    await setApp({ paletteOpen: true });
    await frame();
    await query('>move this note');
    await press('Enter', {}, input());
    await settle();
    expect(state().notes.c.deleted_at).not.toBeNull();
    expect(state().noteId).toBeNull();
  });

  it('has no note commands for a note in the trash', async () => {
    await library();
    h.store.openNote('t');
    await openPalette();
    await query('>');
    expect(groups()).not.toContain('This note');
  });

  it('copies the open note’s link', async () => {
    await library();
    const writeText = vi.fn(async () => undefined);
    clipboard({ writeText });
    h.store.openNote('c');
    await openPalette();
    await query('>copy link');
    await press('Enter', {}, input());
    await settle();
    expect(writeText).toHaveBeenCalledWith(`${location.origin}/note/c`);
    expect(toasts(h.store).at(-1)).toBe('Link copied');
  });

  it('shows the link when the clipboard can’t be used', async () => {
    await library();
    clipboard(undefined);
    h.store.openNote('c');
    await openPalette();
    await query('>copy link');
    await press('Enter', {}, input());
    await settle();
    expect(toasts(h.store).at(-1)).toBe(`${location.origin}/note/c`);
  });

  it('shows the link when copying is refused', async () => {
    await library();
    clipboard({ writeText: () => Promise.reject(new Error('denied')) });
    h.store.openNote('c');
    await openPalette();
    await query('>copy link');
    await press('Enter', {}, input());
    await settle();
    expect(toasts(h.store).at(-1)).toBe(`${location.origin}/note/c`);
  });

  it('shows each command’s shortcut', async () => {
    await openPalette();
    await query('>');
    const hint = (label: string) => textOf(options().find((o) => textOf(o.querySelector('.palette-label')) === label)!.querySelector('.palette-hint'));
    expect(hint('New note')).toBe('Alt N');
    expect(hint('Toggle sidebar')).toMatch(/^(Ctrl|⌘) \\$/);
    expect(hint('Settings')).toMatch(/^(Ctrl|⌘) ,$/);
  });
});

describe('templates', () => {
  async function templates() {
    await seedFolder('tpl', 'Templates');
    await seedNote('m', { title: 'Meeting {{date}}', content: '# {{title}}\n\nAttendees:', folder_id: 'tpl' });
    await seedNote('j', { title: 'Journal', content: 'Today', folder_id: 'tpl' });
  }

  it('offers a new note from each template but the journal’s, filled in', async () => {
    await templates();
    await openPalette();
    await query('>');
    expect(labels()).toContain('New note from “Meeting {{date}}”');
    expect(labels()).not.toContain('New note from “Journal”');
    await query('>meeting');
    await press('Enter', {}, input());
    await settle();
    const made = state().notes[state().noteId!];
    expect(made.title).toBe('Meeting 2026-11-17');
    expect(h.store.noteCache.get(made.id)!.content).toBe('# Meeting 2026-11-17\n\nAttendees:');
  });

  it('opens the journal template to edit, making it when there isn’t one', async () => {
    await openPalette();
    await query('>edit the journal');
    await press('Enter', {}, input());
    await settle();
    const made = state().notes[state().noteId!];
    expect(made.title).toBe('Journal');
    expect(state().folders.find((f) => f.id === made.folder_id)?.name).toBe('Templates');
  });

  it('opens the journal template that exists', async () => {
    await templates();
    await openPalette();
    await query('>edit the journal');
    await press('Enter', {}, input());
    await settle();
    expect(state().noteId).toBe('j');
  });
});

describe('what screen readers are told', () => {
  it('is a listbox of options the input controls, one of them selected', async () => {
    await seedNote('a', { title: 'Plan', updated_at: NOW - DAY });
    await openPalette();
    expect(input().getAttribute('aria-controls')).toBe('palette-list');
    expect(document.getElementById('palette-list')!.getAttribute('role')).toBe('listbox');
    expect(options().filter((o) => o.getAttribute('aria-selected') === 'true')).toHaveLength(1);
    expect(new Set(options().map((o) => o.id)).size).toBe(options().length);
  });

  it('keeps the shortcuts in its footer', async () => {
    await openPalette();
    expect(queryByText(/for commands/)).not.toBeNull();
    expect(textOf(dialog()!.querySelector('.palette-foot'))).toMatch(/new note/);
  });
});
