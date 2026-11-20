// @vitest-environment jsdom
/**
 * Home (src/components/Home.tsx), as the README describes it: a greeting with the open-task count, the
 * quick-capture box (a new note whose first line becomes the title, or added to today's journal entry
 * with the time), one-click new note / drawing / diagram / journal, pinned notes as cards, recent edits,
 * and the backup reminder after a month. The library is encrypted, as the owner keeps it.
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
  listNotes,
  metaFor,
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
  until,
  type Booted,
} from './ui-shell-helpers';

let h: Booted;
let Home: typeof import('../../src/components/Home').Home;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'], now: NOW });
  h = await boot();
  ({ Home } = await import('../../src/components/Home'));
});
afterEach(teardown);

const show = () => render(<Home />);
const home = () => byRole('region', 'Home');
const summary = () => textOf(home().querySelector('.home-summary'));
const capture = () => byRole('textbox', 'Quick capture') as HTMLTextAreaElement;
const saveButton = () => home().querySelector<HTMLButtonElement>('form.capture button[type="submit"]')!;
const state = () => h.store.useApp.getState();
const cards = () => Array.from(home().querySelectorAll('section[aria-label="Pinned"] a.card')).map((c) => textOf(c.querySelector('.card-title')));
const recent = () => Array.from(home().querySelectorAll('a.recent')).map((c) => textOf(c.querySelector('.recent-title')));
const lastPost = () => server.requests('POST', '/api/notes').at(-1)!;
/** A date as Home writes it, in this computer's language. */
const dateLabel = (d: Date) => d.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });

describe('the greeting', () => {
  it('greets by the time of day with today’s date', async () => {
    await show();
    expect(textOf(byRole('heading', 'Good morning'))).toBe('Good morning');
    expect(textOf(home().querySelector('.home-date'))).toBe(dateLabel(new Date(NOW)));
    expect(dateLabel(new Date(NOW))).toMatch(/Tuesday/);
  });

  it('keeps the date and greeting current when Home stays open past midnight', async () => {
    vi.setSystemTime(new Date(2026, 10, 17, 22, 0));
    await seedNote('a');
    await show();
    expect(textOf(home().querySelector('.home-greeting'))).toBe('Good evening');
    vi.setSystemTime(new Date(2026, 10, 18, 8, 0));
    // Anything that redraws Home: a note saved on another device, say.
    await seedNote('b');
    expect(textOf(home().querySelector('.home-date'))).toBe(dateLabel(new Date(2026, 10, 18, 8, 0)));
    expect(textOf(home().querySelector('.home-greeting'))).toBe('Good morning');
  });

  it('says an empty library is empty', async () => {
    await show();
    expect(summary()).toBe('Nothing here yet. Capture a first thought below.');
    expect(queryByText('Notes you edit show up here.')).not.toBeNull();
  });

  it('counts notes and their open tasks, leaving out templates and the trash, and opens Tasks from there', async () => {
    await seedFolder('tpl', 'Templates');
    await seedNote('a', { info: { t: [1, 4] } });
    await seedNote('b', { info: { t: [2, 2] } });
    await seedNote('c', { info: { t: [0, 1] } });
    await seedNote('t', { folder_id: 'tpl', info: { t: [0, 7] } });
    await seedNote('x', { deleted_at: NOW, info: { t: [0, 9] } });
    await show();
    expect(summary()).toBe('4 notes, with 4 open tasks across 2 notes.');
    await click(byRole('button', '4 open tasks'));
    expect(state().screen).toBe('tasks');
    expect(location.pathname).toBe('/tasks');
  });

  it('uses the singular for one note and one task, and says when there are no open tasks', async () => {
    await seedNote('a', { info: { t: [0, 1] } });
    await show();
    expect(summary()).toBe('1 note, with 1 open task across 1 note.');
    await setApp((s: any) => ({ notes: { a: { ...s.notes.a, info: { t: [1, 1] } } } }));
    expect(summary()).toBe('1 note, and no open tasks.');
  });

  it('says nothing about counts while the library loads (holding the line), and shows placeholders for recent notes', async () => {
    await setApp({ status: 'loading' });
    await show();
    const line = home().querySelector('.home-summary')!;
    expect(line.classList.contains('is-pending')).toBe(true);
    expect(line.getAttribute('aria-hidden')).toBe('true');
    expect(textOf(line).trim()).toBe('');
    expect(home().querySelectorAll('.recent-skel')).toHaveLength(4);
    expect(home().querySelector('.backup-nudge')).toBeNull();
  });

  it('replaces the placeholders whole once the notes are in, leaving everything above where it was', async () => {
    await seedNote('p1', { title: 'Pinned plan', pinned: true });
    await seedNote('r1', { title: 'Recent idea' });
    await setApp({ status: 'loading' });
    await show();
    const capture = home().querySelector('form.capture');
    const actions = home().querySelector('.quick-grid');
    const placeholders = home().querySelector('.home-loading')!;
    await setApp({ status: 'ready' });
    // The same elements, not new ones put in their place.
    expect(home().querySelector('form.capture')).toBe(capture);
    expect(home().querySelector('.quick-grid')).toBe(actions);
    // The placeholders went, rather than being filled in where a Pinned section would push them down.
    expect(placeholders.isConnected).toBe(false);
    expect(Array.from(home().querySelectorAll('section.home-section')).map((s) => s.getAttribute('aria-label'))).toEqual(['Pinned', 'Recently edited']);
    expect(summary()).toMatch(/^2 notes/);
  });
});

describe('quick capture', () => {
  it('keeps Save off until something is typed', async () => {
    await show();
    expect(saveButton().disabled).toBe(true);
    await type(capture(), '   ');
    expect(saveButton().disabled).toBe(true);
    await type(capture(), 'Buy milk');
    expect(saveButton().disabled).toBe(false);
    expect(textOf(saveButton())).toBe('Save note');
    expect(textOf(home().querySelector('.capture-hint'))).toBe('The first line becomes the title.');
  });

  it('saves a new note whose first line is the title, without leaving Home, encrypted', async () => {
    await show();
    await type(capture(), 'Buy milk\nand eggs\nand bread');
    await click(saveButton());
    await settle();
    const id = lastPost().body!.id as string;
    expect(state().notes[id].title).toBe('Buy milk');
    expect(h.store.noteCache.get(id)!.content).toBe('and eggs\nand bread');
    expect(state().noteId).toBeNull();
    expect(capture().value).toBe('');
    expect(toasts(h.store).at(-1)).toBe('Saved to your notes');
    expect(JSON.stringify(lastPost().body)).not.toContain('milk');
    state().toasts.at(-1)!.action!.run();
    expect(state().noteId).toBe(id);
  });

  it('saves with Ctrl/⌘ Enter', async () => {
    await show();
    await type(capture(), 'Call Sam');
    const ev = await press('Enter', { ctrlKey: true }, capture());
    expect(ev.defaultPrevented).toBe(true);
    await settle();
    expect(Object.values(state().notes).map((n) => n.title)).toEqual(['Call Sam']);
    await type(capture(), 'Call Ann');
    await press('Enter', { metaKey: true }, capture());
    await settle();
    expect(Object.values(state().notes)).toHaveLength(2);
  });

  it('takes Markdown off a first line used as the title, and keeps a long first line whole in the text', async () => {
    await show();
    await type(capture(), '## - [ ] **Ship** it');
    await click(saveButton());
    await settle();
    expect(state().notes[lastPost().body!.id as string].title).toBe('Ship it');
    const long = 'word '.repeat(30).trim();
    await type(capture(), long);
    await click(saveButton());
    await settle();
    const id = lastPost().body!.id as string;
    expect(state().notes[id].title).toBe(`${long.slice(0, 60).trim()}…`);
    expect(h.store.noteCache.get(id)!.content).toBe(long);
  });

  it('saves once however many times Save is pressed while it saves', async () => {
    await show();
    let release: (() => void) | undefined;
    server.intercept = (req) => (req.method === 'POST' && req.path === '/api/notes' ? new Promise<undefined>((r) => (release = () => r(undefined))) : undefined);
    await type(capture(), 'Once');
    await click(saveButton());
    await click(saveButton());
    await press('Enter', { ctrlKey: true }, capture());
    expect(saveButton().disabled).toBe(true);
    // The note is encrypted before it's sent: wait until it's on its way.
    await until(() => expect(release).toBeDefined());
    release!();
    await settle();
    expect(server.requests('POST', '/api/notes')).toHaveLength(1);
  });

  it('keeps what was typed when it can’t be saved, and says why', async () => {
    await show();
    server.intercept = (req) => (req.method === 'POST' ? Promise.reject(new TypeError('Failed to fetch')) : undefined);
    await type(capture(), 'Keep me');
    await click(saveButton());
    await settle();
    expect(capture().value).toBe('Keep me');
    expect(toasts(h.store).at(-1)).toMatch(/Can’t reach the server/);
    expect(saveButton().disabled).toBe(false);
  });

  it('keeps an unsaved capture on this device until it’s saved', async () => {
    const first = await show();
    await type(capture(), 'Half a thought');
    await first.unmount();
    await show();
    expect(capture().value).toBe('Half a thought');
    await click(saveButton());
    await settle();
    expect(localStorage.getItem('kb.capture')).toBeNull();
  });

  it('adds to the end of today’s journal entry with the time, making the entry the first time', async () => {
    await show();
    const where = byRole('radiogroup', 'Save to');
    await click(byRole('radio', 'Journal', where));
    expect(h.settings.useSettings.getState().captureTo).toBe('journal');
    expect(byRole('radio', 'Journal', where).getAttribute('aria-checked')).toBe('true');
    expect(textOf(saveButton())).toBe('Add');
    expect(textOf(home().querySelector('.capture-hint'))).toBe('Added to today’s entry, with the time.');
    await type(capture(), 'Walked to the lake');
    await click(saveButton());
    await settle(40);
    const entry = Object.values(state().notes).find((n) => n.title === '2026-11-17')!;
    expect(entry.tags).toEqual(['journal']);
    const time = new Date(NOW).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    expect(h.store.noteCache.get(entry.id)!.content.endsWith(`**${time}** Walked to the lake\n`)).toBe(true);
    expect(toasts(h.store).at(-1)).toBe('Added to today’s journal');
    expect(capture().value).toBe('');
    expect(state().noteId).toBeNull();

    // A second capture goes into the same entry, after the first.
    await type(capture(), '- [ ] buy bread');
    await click(saveButton());
    await settle(40);
    const { knownText } = await import('../../src/lib/liveEdit');
    expect(knownText(entry.id)!.content).toMatch(/Walked to the lake\n\n- \[ \] buy bread\n$/);
    expect(Object.values(state().notes).filter((n) => n.title === '2026-11-17')).toHaveLength(1);
  });
});

describe('one-click actions', () => {
  it('makes a new note and opens it, showing its Alt N shortcut', async () => {
    await show();
    const quick = byRole('button', /^New note/, home().querySelector('.quick-grid')!);
    expect(textOf(quick.querySelector('kbd'))).toBe('Alt N');
    await click(quick);
    await settle();
    expect(state().noteId).toBe(lastPost().body!.id);
  });

  it('opens the drawing editor, and makes a note only once a drawing is saved', async () => {
    await show();
    await click(byRole('button', /^Drawing/));
    expect(state().drawing).toMatchObject({ drawingId: null, noteId: null });
    state().drawing!.resolve(null);
    await settle();
    expect(server.requests('POST', '/api/notes')).toHaveLength(0);
    await click(byRole('button', /^Drawing/));
    state().drawing!.resolve('d1');
    await settle();
    expect(state().notes[state().noteId!].title).toBe('Untitled drawing');
  });

  it('opens the diagram editor, and makes a note from the diagram drawn', async () => {
    await show();
    await click(byRole('button', /^Diagram/));
    expect(state().mermaid).toMatchObject({ code: '', isNew: true });
    state().mermaid!.resolve('graph TD; A-->B');
    await settle();
    const id = state().noteId!;
    expect(h.store.noteCache.get(id)!.content).toBe('```mermaid\ngraph TD; A-->B\n```\n');
  });

  it('opens today’s journal entry', async () => {
    await show();
    await click(byRole('button', /^Journal/, home().querySelector('.quick-grid')!));
    await settle(40);
    expect(state().notes[state().noteId!].title).toBe('2026-11-17');
  });

  it('shows Search and Settings in the header (phones), and Show sidebar when it’s hidden', async () => {
    await show();
    await click(byRole('button', 'Search'));
    expect(state().paletteOpen).toBe(true);
    await click(byRole('button', 'Settings'));
    expect(state().settingsOpen).toBe(true);
    expect(queryByRole('button', 'Show sidebar')).toBeNull();
    await setSettings({ sidebarCollapsed: true });
    await click(byRole('button', 'Show sidebar'));
    expect(h.settings.useSettings.getState().sidebarCollapsed).toBe(false);
  });
});

describe('pinned and recent notes', () => {
  it('shows up to six pinned notes as cards, newest first, and the rest as recent edits', async () => {
    await listNotes(
      Array.from({ length: 8 }, (_, i) => metaFor(`p${i}`, { title: `Pinned ${i}`, pinned: true, updated_at: NOW - i * 1000 })).concat(
        Array.from({ length: 10 }, (_, i) => metaFor(`r${i}`, { title: `Recent ${i}`, updated_at: NOW - i * 1000 })),
        [metaFor('gone', { title: 'Trashed', deleted_at: NOW, updated_at: NOW + 1 })],
      ),
    );
    await show();
    expect(cards()).toEqual(['Pinned 0', 'Pinned 1', 'Pinned 2', 'Pinned 3', 'Pinned 4', 'Pinned 5']);
    expect(recent()).toEqual(['Recent 0', 'Recent 1', 'Recent 2', 'Recent 3', 'Recent 4', 'Recent 5', 'Recent 6', 'Recent 7']);
  });

  it('shows a card’s folder, tasks and preview, and opens the note on a click', async () => {
    await seedFolder('p', 'Projects');
    await seedNote('a', { title: 'Plan', pinned: true, folder_id: 'p', excerpt: 'Steps', info: { t: [1, 3] } });
    await show();
    const card = home().querySelector('a.card')!;
    expect(textOf(card.querySelector('.card-excerpt'))).toBe('Steps');
    expect(textOf(card.querySelector('.card-meta'))).toContain('Projects');
    expect(textOf(card.querySelector('.card-meta'))).toContain('1/3');
    await click(card);
    expect(state().noteId).toBe('a');
  });

  it('leaves a Ctrl/⌘ click on a card or recent note to the browser (a new tab)', async () => {
    await seedNote('a', { title: 'Plan', pinned: true });
    await seedNote('b', { title: 'Other' });
    await show();
    let prevented: boolean | null = null;
    const watch = (e: Event) => (prevented = e.defaultPrevented);
    document.addEventListener('click', watch);
    await click(home().querySelector('a.card'), { ctrlKey: true });
    expect(prevented).toBe(false);
    await click(home().querySelector('a.recent'), { metaKey: true });
    expect(prevented).toBe(false);
    document.removeEventListener('click', watch);
    expect(state().noteId).toBeNull();
    await click(home().querySelector('a.recent'));
    expect(state().noteId).toBe('b');
  });

  it('opens Pinned and All notes from their links', async () => {
    await seedNote('a', { pinned: true });
    await seedNote('b');
    await show();
    await click(byRole('button', 'Show all'));
    expect(state().filter).toEqual({ kind: 'pinned' });
    await click(byRole('button', 'All notes'));
    expect(state().filter).toEqual({ kind: 'all' });
  });

  it('points to the pinned cards when every note is pinned', async () => {
    await seedNote('a', { pinned: true });
    await show();
    expect(queryByText('Your pinned notes are above. Other notes show up here as you edit them.')).not.toBeNull();
    expect(queryByRole('button', 'All notes')).toBeNull();
  });

  it('keeps a very long title whole on its card', async () => {
    const long = 'Long title '.repeat(50).trim();
    await seedNote('a', { title: long, pinned: true });
    await show();
    expect(cards()).toEqual([long]);
  });
});

describe('the backup reminder', () => {
  const nudge = () => home().querySelector('.backup-nudge');

  it('stays away for a small library or a recent backup', async () => {
    await setApp({ lastBackup: null });
    await seedNote('a');
    await seedNote('b');
    await show();
    expect(nudge()).toBeNull();
    await seedNote('c');
    expect(nudge()).not.toBeNull();
    await setApp({ lastBackup: NOW - 29 * DAY });
    expect(nudge()).toBeNull();
  });

  it('says there’s never been a backup, that it’s encrypted, and opens Settings at Data', async () => {
    await setApp({ lastBackup: null });
    for (const id of ['a', 'b', 'c']) await seedNote(id);
    await show();
    expect(nudge()!.getAttribute('role')).toBe('status');
    expect(textOf(nudge())).toContain('You haven’t backed up your notes yet');
    expect(textOf(nudge())).toContain('It’s encrypted, and takes a minute.');
    await click(byRole('button', 'Back up now'));
    expect(state()).toMatchObject({ settingsOpen: true, settingsSection: 'data' });
  });

  it('says how long ago the last backup was, after a month', async () => {
    await setApp({ lastBackup: NOW - 45 * DAY });
    for (const id of ['a', 'b', 'c']) await seedNote(id);
    await show();
    expect(textOf(nudge())).toContain('Your last backup was 45 days ago');
  });

  it('goes for a week on this device with Later', async () => {
    await setApp({ lastBackup: null });
    for (const id of ['a', 'b', 'c']) await seedNote(id);
    const first = await show();
    await click(byRole('button', 'Later'));
    expect(nudge()).toBeNull();
    await first.unmount();
    vi.setSystemTime(NOW + 6 * DAY);
    await show();
    expect(nudge()).toBeNull();
  });

  it('comes back once the week is up', async () => {
    await setApp({ lastBackup: null });
    for (const id of ['a', 'b', 'c']) await seedNote(id);
    localStorage.setItem('kb.backup.snooze', String(NOW - 1));
    await show();
    expect(nudge()).not.toBeNull();
  });
});

describe('accessibility basics', () => {
  it('is a region called Home with a heading, a labelled capture box and buttons with names', async () => {
    await seedNote('a', { pinned: true });
    await show();
    expect(home().querySelector('h1')).not.toBeNull();
    expect(capture().getAttribute('aria-label')).toBe('Quick capture');
    expect(allByRole('radio', undefined, byRole('radiogroup', 'Save to')).map((r) => [textOf(r), r.getAttribute('aria-checked')])).toEqual([
      ['New note', 'true'],
      ['Journal', 'false'],
    ]);
    for (const b of allByRole('button', undefined, home())) expect(b.getAttribute('aria-label') ?? textOf(b), b.outerHTML.slice(0, 80)).not.toBe('');
  });

  it('can be used from the keyboard: the capture box takes focus and saves with Ctrl/⌘ Enter', async () => {
    await show();
    await focus(capture());
    expect(document.activeElement).toBe(capture());
    await type(capture(), 'From the keyboard');
    await press('Enter', { ctrlKey: true });
    await settle();
    expect(Object.values(state().notes).map((n) => n.title)).toEqual(['From the keyboard']);
  });
});
