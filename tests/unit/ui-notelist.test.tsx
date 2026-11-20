// @vitest-environment jsdom
/**
 * The note list (src/components/NoteList.tsx): which notes each view lists and how they're grouped and
 * sorted, its rows, empty states, the search box (on the device, since the library is encrypted; its
 * filters and "Only in …"), the keyboard (arrows, Ctrl/⌘ A, Esc), choosing several notes (Ctrl/⌘ and
 * Shift click, "Select notes") and what the bulk bar does with them, the row menu, dragging, and the trash.
 */
import React, { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  allByRole,
  answerDialog,
  boot,
  byRole,
  chooseMenuItem,
  click,
  contextMenu,
  DAY,
  dataTransfer,
  drag,
  focus,
  focused,
  listNotes,
  menuLabels,
  metaFor,
  NOW,
  openMenu,
  pendingDialog,
  press,
  queryByRole,
  queryByText,
  render,
  scrolled,
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
let NoteList: typeof import('../../src/components/NoteList').NoteList;

async function start(opts: { encrypted?: boolean } = {}) {
  h = await boot(opts);
  ({ NoteList } = await import('../../src/components/NoteList'));
}

beforeEach(async () => {
  // Dates are fixed (for the date groups); timers run for real.
  vi.useFakeTimers({ toFake: ['Date'], now: NOW });
  await start();
});
afterEach(teardown);

const show = () => render(<NoteList />);
const pane = () => document.querySelector<HTMLElement>('section.list-pane')!;
const rows = () => Array.from(pane().querySelectorAll<HTMLAnchorElement>('a.row'));
const titles = () => rows().map((r) => textOf(r.querySelector('.row-title')));
const row = (title: string) => {
  const r = rows().find((x) => textOf(x.querySelector('.row-title')) === title);
  if (!r) throw new Error(`No row ${title}; rows are ${titles().join(', ')}`);
  return r;
};
const groups = () =>
  Array.from(pane().querySelectorAll('section.group')).map((g) => [textOf(g.querySelector('.group-label')), Array.from(g.querySelectorAll('.row-title')).map(textOf)]);
const searchBox = () => pane().querySelector<HTMLInputElement>('input[type="search"]')!;
const bulkBar = () => queryByRole('toolbar', 'Chosen notes');
const state = () => h.store.useApp.getState();

/** Types a search and waits for its debounce and the on-device search. */
async function search(q: string) {
  await type(searchBox(), q);
  await wait(260);
  await settle(30);
}

describe('what the list shows', () => {
  it('titles itself after the view, with how many notes are in it', async () => {
    await seedNote('a');
    await seedNote('b');
    await seedNote('c', { deleted_at: NOW });
    await show();
    expect(textOf(pane().querySelector('h1'))).toBe('All notes');
    expect(textOf(pane().querySelector('.list-count'))).toBe('2');
    expect(pane().getAttribute('aria-label')).toBe('All notes');
  });

  it('puts pinned notes first, then the rest by when they were last edited', async () => {
    await seedNote('today', { title: 'Today note', updated_at: NOW - 3_600_000 });
    await seedNote('pin', { title: 'Pinned old', pinned: true, updated_at: NOW - 90 * DAY });
    await seedNote('yday', { title: 'Yesterday note', updated_at: NOW - DAY });
    await seedNote('week', { title: 'This week', updated_at: NOW - 4 * DAY });
    await seedNote('month', { title: 'This month', updated_at: NOW - 20 * DAY });
    await seedNote('sept', { title: 'September note', updated_at: new Date(2026, 8, 3).getTime() });
    await seedNote('last', { title: 'Last year', updated_at: new Date(2025, 2, 3).getTime() });
    await show();
    expect(groups()).toEqual([
      ['Pinned', ['Pinned old']],
      ['Today', ['Today note']],
      ['Yesterday', ['Yesterday note']],
      ['Previous 7 days', ['This week']],
      ['Previous 30 days', ['This month']],
      ['September', ['September note']],
      ['March 2025', ['Last year']],
    ]);
  });

  it('sorts by title in one section after the pinned ones, ignoring case', async () => {
    await setSettings({ sort: 'title' });
    await seedNote('c', { title: 'cherry' });
    await seedNote('a', { title: 'Apple' });
    await seedNote('b', { title: 'banana' });
    await seedNote('p', { title: 'Zebra', pinned: true });
    await show();
    expect(groups()).toEqual([
      ['Pinned', ['Zebra']],
      ['Notes', ['Apple', 'banana', 'cherry']],
    ]);
  });

  it('sorts by date created when chosen in View options, showing that date', async () => {
    await seedNote('old', { title: 'Made first', created_at: NOW - 30 * DAY, updated_at: NOW - 1000 });
    await seedNote('new', { title: 'Made last', created_at: NOW - 2 * DAY, updated_at: NOW - 40 * DAY });
    await show();
    expect(titles()).toEqual(['Made first', 'Made last']);
    await click(byRole('button', 'View options'));
    expect(menuLabels()).toEqual(['Last edited', 'Date created', 'Title', 'Show previews', 'Select notes']);
    await chooseMenuItem('Date created');
    expect(h.settings.useSettings.getState().sort).toBe('created');
    expect(titles()).toEqual(['Made last', 'Made first']);
    expect(row('Made last').querySelector('time')!.getAttribute('datetime')).toBe(new Date(NOW - 2 * DAY).toISOString());
  });

  // Not just a tick icon: the items say whether they're checked.
  it('tells screen readers which sort is chosen and whether previews are on', async () => {
    await show();
    await click(byRole('button', 'View options'));
    const items = allByRole('menuitem', undefined, openMenu());
    const lastEdited = items.find((b) => textOf(b).startsWith('Last edited'))!;
    const previews = items.find((b) => textOf(b).startsWith('Show previews'))!;
    expect(lastEdited.getAttribute('aria-checked')).toBe('true');
    expect(previews.getAttribute('aria-checked')).toBe('true');
  });

  it('shows each row’s title, preview, folder, tags, tasks and drawings', async () => {
    await seedFolder('p', 'Projects');
    await seedNote('a', {
      title: 'Plan',
      excerpt: 'First steps',
      folder_id: 'p',
      tags: ['work', 'q4', 'big'],
      pinned: true,
      info: { t: [1, 3], d: 2, dr: 1 },
    });
    await seedNote('b', { title: '   ', excerpt: '' });
    await show();
    const r = row('Plan');
    expect(textOf(r.querySelector('.row-excerpt'))).toBe('First steps');
    expect(textOf(r.querySelector('.row-chip'))).toBe('Projects');
    expect(Array.from(r.querySelectorAll('.row-tag')).map(textOf)).toEqual(['#work', '#q4', '+1']);
    expect(textOf(r.querySelector('.row-badge'))).toBe('1/3');
    expect(r.querySelector('[data-tip="2 diagrams"]')).not.toBeNull();
    expect(r.querySelector('[data-tip="1 drawing"]')).not.toBeNull();
    expect(r.querySelector('[aria-label="Pinned"]')).not.toBeNull();
    const untitled = row('Untitled');
    expect(untitled.querySelector('.row-title')!.classList.contains('is-untitled')).toBe(true);
    expect(textOf(untitled.querySelector('.row-excerpt'))).toBe('No additional text');
  });

  it('hides previews when they’re turned off', async () => {
    await seedNote('a', { title: 'Plan', excerpt: 'First steps' });
    await show();
    await click(byRole('button', 'View options'));
    await chooseMenuItem('Show previews');
    expect(row('Plan').querySelector('.row-excerpt')).toBeNull();
  });

  it('keeps a very long title whole (the row shortens it on screen, not in the page)', async () => {
    const long = 'A very long title '.repeat(40).trim();
    await seedNote('a', { title: long });
    await show();
    expect(textOf(rows()[0].querySelector('.row-title'))).toBe(long);
  });

  it('lists a large library in full, grouped once', async () => {
    await listNotes(Array.from({ length: 800 }, (_, i) => metaFor(`n${i}`, { title: `Note ${i}`, updated_at: NOW - (i % 4) * DAY - 1000 })));
    await show();
    expect(rows()).toHaveLength(800);
    expect(groups().map((g) => g[0])).toEqual(['Today', 'Yesterday', 'Previous 7 days']);
    expect(textOf(pane().querySelector('.list-count'))).toBe('800');
  });

  it('shows placeholders while the library loads', async () => {
    await setApp({ status: 'loading' });
    await show();
    expect(pane().querySelector('.list-skeleton')!.getAttribute('aria-hidden')).toBe('true');
    expect(rows()).toHaveLength(0);
  });

  it('offers to make the first note in an empty view, in that view', async () => {
    await seedFolder('p', 'Projects');
    await setApp({ filter: { kind: 'folder', id: 'p' } });
    await show();
    expect(queryByText('No notes here yet')).not.toBeNull();
    await click(byRole('button', 'New note', pane().querySelector('.empty-state')!));
    await settle();
    expect(state().notes[state().noteId!].folder_id).toBe('p');
  });

  it('says what the pinned list and the trash are for when they’re empty', async () => {
    await setApp({ filter: { kind: 'pinned' } });
    await show();
    expect(queryByText('Nothing pinned yet')).not.toBeNull();
    await setApp({ filter: { kind: 'trash' } });
    expect(queryByText('Trash is empty')).not.toBeNull();
    expect(queryByText(/stay here for 30 days/)).not.toBeNull();
    expect(queryByRole('button', 'Empty trash')).toBeNull();
  });
});

describe('views', () => {
  it('lists a folder with its subfolders’ notes, naming only the subfolder', async () => {
    await seedFolder('p', 'Projects');
    await seedFolder('c', 'Clients', 'p');
    await seedNote('a', { title: 'In projects', folder_id: 'p' });
    await seedNote('b', { title: 'In clients', folder_id: 'c' });
    await seedNote('x', { title: 'Elsewhere' });
    await seedNote('t', { title: 'Trashed', folder_id: 'p', deleted_at: NOW });
    await setApp({ filter: { kind: 'folder', id: 'p' } });
    await show();
    expect(textOf(pane().querySelector('h1'))).toBe('Projects');
    expect(titles().sort()).toEqual(['In clients', 'In projects']);
    expect(row('In projects').querySelector('.row-chip')).toBeNull();
    expect(textOf(row('In clients').querySelector('.row-chip'))).toBe('Clients');
  });

  it('lists a tag’s notes whatever the case, with the tag’s menu', async () => {
    await seedNote('a', { title: 'One', tags: ['Work'] });
    await seedNote('b', { title: 'Two', tags: ['work'] });
    await seedNote('c', { title: 'Three', tags: ['workshop'] });
    await setApp({ filter: { kind: 'tag', tag: 'work' } });
    await show();
    expect(pane().getAttribute('aria-label')).toBe('#work');
    expect(titles().sort()).toEqual(['One', 'Two']);
    await click(byRole('button', 'Tag options'));
    expect(menuLabels()).toEqual(['Rename or merge…', 'Remove from all notes']);
  });

  it('lists only pinned notes in Pinned, without a separate Pinned section', async () => {
    await seedNote('a', { title: 'Pinned one', pinned: true });
    await seedNote('b', { title: 'Plain' });
    await setApp({ filter: { kind: 'pinned' } });
    await show();
    expect(groups()).toEqual([['Today', ['Pinned one']]]);
  });

  it('lists the trash newest deletion first, timed by when they were deleted, and can’t drag them', async () => {
    await seedNote('a', { title: 'Gone first', pinned: true, deleted_at: NOW - 5 * DAY });
    await seedNote('b', { title: 'Gone last', deleted_at: NOW - DAY });
    await seedNote('c', { title: 'Live' });
    await setApp({ filter: { kind: 'trash' } });
    await show();
    expect(groups()).toEqual([['Deleted', ['Gone last', 'Gone first']]]);
    expect(row('Gone first').querySelector('time')!.getAttribute('datetime')).toBe(new Date(NOW - 5 * DAY).toISOString());
    expect(row('Gone first').querySelector('[aria-label="Pinned"]')).toBeNull();
    expect(row('Gone last').getAttribute('draggable')).toBe('false');
    expect(queryByRole('button', 'New note')).toBeNull();
  });

  it('empties the trash after asking', async () => {
    await seedNote('a', { title: 'Gone', deleted_at: NOW });
    await seedNote('b', { title: 'Also gone', deleted_at: NOW });
    await setApp({ filter: { kind: 'trash' } });
    await show();
    await click(byRole('button', 'Empty trash'));
    expect(pendingDialog(h.store)).toMatchObject({ title: 'Delete 2 notes forever?', danger: true });
    await answerDialog(h.store, true);
    expect(rows()).toHaveLength(0);
    expect(server.rows.size).toBe(0);
    expect(queryByText('Trash is empty')).not.toBeNull();
  });

  it('opens the drawer from the menu button, and shows the sidebar again when it’s hidden', async () => {
    await show();
    expect(queryByRole('button', 'Show sidebar')).toBeNull();
    await click(byRole('button', 'Open menu'));
    expect(state().drawerOpen).toBe(true);
    await setSettings({ sidebarCollapsed: true });
    await click(byRole('button', 'Show sidebar'));
    expect(h.settings.useSettings.getState().sidebarCollapsed).toBe(false);
  });

  it('makes a new note from its button, which shows its Alt N shortcut', async () => {
    await show();
    const button = byRole('button', 'New note', pane().querySelector('header')!);
    expect(button.dataset.tipKbd).toBe('Alt N');
    await click(button);
    await settle();
    expect(state().noteId).toBe(server.requests('POST', '/api/notes')[0].body!.id);
  });
});

describe('opening notes', () => {
  it('opens a note on a click, marking its row', async () => {
    await seedNote('a', { title: 'Plan' });
    await seedNote('b', { title: 'Other' });
    await show();
    const r = row('Plan');
    expect(r.getAttribute('href')).toBe('/note/a');
    await click(r);
    expect(state().noteId).toBe('a');
    expect(location.pathname).toBe('/note/a');
    expect(row('Plan').getAttribute('aria-current')).toBe('page');
    expect(row('Other').getAttribute('aria-current')).toBeNull();
  });

  it('moves between notes with ↑ ↓, Home and End, and from the search box into the list and back', async () => {
    await seedNote('a', { title: 'First', updated_at: NOW - 1000 });
    await seedNote('b', { title: 'Second', updated_at: NOW - 2000 });
    await seedNote('c', { title: 'Third', updated_at: NOW - 3000 });
    await show();
    await focus(searchBox());
    const down = await press('ArrowDown');
    expect(down.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(row('First'));
    await press('ArrowDown');
    expect(document.activeElement).toBe(row('Second'));
    expect(scrolled.at(-1)).toBe(row('Second'));
    await press('End');
    expect(document.activeElement).toBe(row('Third'));
    await press('ArrowDown');
    expect(document.activeElement).toBe(row('Third'));
    await press('Home');
    expect(document.activeElement).toBe(row('First'));
    await press('ArrowUp');
    expect(document.activeElement).toBe(searchBox());
  });

  it('leaves the arrow keys alone with a modifier held', async () => {
    await seedNote('a', { title: 'First' });
    await show();
    await focus(row('First'));
    const ev = await press('ArrowDown', { altKey: true });
    expect(ev.defaultPrevented).toBe(false);
  });
});

describe('the row menu', () => {
  beforeEach(async () => {
    await seedFolder('p', 'Projects');
    await seedFolder('c', 'Clients', 'p');
    await seedNote('a', { title: 'Plan', content: 'The whole plan' });
  });

  it('offers pin, duplicate, every folder to move to, and trash', async () => {
    await show();
    expect(await contextMenu(row('Plan'))).toBe(true);
    expect(menuLabels()).toEqual(['Pin to top', 'Duplicate', 'No folder', 'Projects', 'Clients', 'Move to trash']);
    expect(openMenu().querySelector('.menu-item.is-checked .menu-label')!.textContent).toBe('No folder');
  });

  it('pins a note, moving it into the Pinned section', async () => {
    await seedNote('b', { title: 'Other' });
    await show();
    await contextMenu(row('Plan'));
    await chooseMenuItem('Pin to top');
    expect(groups()[0]).toEqual(['Pinned', ['Plan']]);
    expect(server.rows.get('a')!.pinned).toBe(true);
  });

  it('moves a note to a folder, which its row then names', async () => {
    await show();
    await contextMenu(row('Plan'));
    await chooseMenuItem('Clients');
    expect(textOf(row('Plan').querySelector('.row-chip'))).toBe('Clients');
  });

  it('duplicates a note’s decrypted text into a new note and opens it', async () => {
    await show();
    await contextMenu(row('Plan'));
    await chooseMenuItem('Duplicate');
    await settle();
    const copy = state().notes[state().noteId!];
    expect(copy.title).toBe('Plan (copy)');
    expect(row('Plan (copy)')).toBeTruthy();
    // Sent encrypted, like the original.
    const post = server.requests('POST', '/api/notes').at(-1)!;
    expect(post.body!.enc).toBe(true);
    expect(JSON.stringify(post.body)).not.toContain('The whole plan');
  });

  it('moves a note to the trash with Undo, and it leaves the list', async () => {
    await show();
    await contextMenu(row('Plan'));
    await chooseMenuItem('Move to trash');
    expect(rows()).toHaveLength(0);
    expect(toasts(h.store).at(-1)).toBe('Moved to trash');
    state().toasts.at(-1)!.action!.run();
    await settle();
    expect(titles()).toEqual(['Plan']);
  });

  it('offers only Restore and Delete forever in the trash', async () => {
    await seedNote('t', { title: 'Old', deleted_at: NOW });
    await setApp({ filter: { kind: 'trash' } });
    await show();
    await contextMenu(row('Old'));
    expect(menuLabels()).toEqual(['Restore', 'Delete forever']);
    await chooseMenuItem('Restore');
    expect(rows()).toHaveLength(0);
    expect(state().notes.t.deleted_at).toBeNull();
  });

  it('closes on Escape without doing anything', async () => {
    await show();
    await contextMenu(row('Plan'));
    await press('Escape');
    expect(queryByRole('menu')).toBeNull();
    expect(state().notes.a.pinned).toBe(false);
  });
});

describe('searching', () => {
  async function library() {
    await seedFolder('p', 'Projects');
    await seedNote('a', { title: 'Budget', content: 'Plan the yearly budget', folder_id: 'p' });
    await seedNote('b', { title: 'Groceries', content: 'milk and budget beans', tags: ['home'] });
    await seedNote('c', { title: 'Trip', content: 'nothing about money' });
    await seedNote('t', { title: 'Old budget', content: 'budget from last year', deleted_at: NOW });
  }

  it('searches the decrypted text on this device, never asking the server, and marks what matched', async () => {
    await library();
    await show();
    await search('budget');
    expect(textOf(pane().querySelector('.group-label'))).toBe('2 results');
    expect(titles()).toEqual(['Budget', 'Groceries']);
    expect(server.requests('GET', '/api/search')).toHaveLength(0);
    expect(textOf(row('Groceries').querySelector('.row-excerpt mark'))).toBe('budget');
    // The search went by the notes' text: its words went nowhere.
    expect(server.log.some((r) => JSON.stringify(r.body ?? '').includes('budget') || r.query.toString().includes('budget'))).toBe(false);
  });

  it('waits for two characters before searching', async () => {
    await library();
    await show();
    await search('b');
    expect(pane().querySelector('.group-label')!.textContent).not.toMatch(/result/);
    expect(rows()).toHaveLength(3);
  });

  it('narrows a search with filters, and lists every match of a filter on its own', async () => {
    await library();
    await show();
    await search('budget tag:home');
    expect(titles()).toEqual(['Groceries']);
    await search('in:Projects');
    expect(titles()).toEqual(['Budget']);
    await search('budget -beans');
    expect(titles()).toEqual(['Budget']);
  });

  it('says when nothing matches, with how to narrow a search', async () => {
    await library();
    await show();
    await search('zebra');
    expect(textOf(pane().querySelector('.group-label'))).toBe('Search results');
    expect(queryByText('Nothing matches “zebra”')).not.toBeNull();
    expect(textOf(pane().querySelector('.empty-state-body'))).toContain('across every note');
  });

  it('opens a result on a click', async () => {
    await library();
    await show();
    await search('budget');
    await click(row('Groceries'));
    expect(state().noteId).toBe('b');
  });

  it('clears the search with Escape or its clear button, and when another view is picked', async () => {
    await library();
    await show();
    await search('budget');
    await press('Escape', {}, searchBox());
    expect(searchBox().value).toBe('');
    expect(rows()).toHaveLength(3);
    await search('budget');
    await click(byRole('button', 'Clear search'));
    expect(searchBox().value).toBe('');
    await search('budget');
    await setApp({ filter: { kind: 'pinned' } });
    await settle();
    expect(searchBox().value).toBe('');
  });

  it('marks the open note among the results, as in the ordinary list', async () => {
    await library();
    await show();
    h.store.openNote('b');
    await search('budget');
    expect(row('Groceries').classList.contains('is-active')).toBe(true);
    expect(row('Groceries').getAttribute('aria-current')).toBe('page');
  });

  it('drops a result once that note is trashed from its menu', async () => {
    await library();
    await show();
    await search('budget');
    await contextMenu(row('Budget'));
    await chooseMenuItem('Move to trash');
    expect(titles()).toEqual(['Groceries']);
    expect(textOf(pane().querySelector('.group-label'))).toBe('1 result');
  });

  it('keeps a search inside the folder that’s open with Only in …, and remembers that', async () => {
    await library();
    await setApp({ filter: { kind: 'folder', id: 'p' } });
    await show();
    expect(searchBox().getAttribute('aria-label')).toBe('Search all notes');
    expect(queryByRole('button', /^Only in/)).toBeNull();
    await search('budget');
    expect(titles()).toEqual(['Budget', 'Groceries']);
    const only = byRole('button', 'Only in Projects');
    expect(only.getAttribute('aria-pressed')).toBe('false');
    await click(only);
    await wait(260);
    await settle(30);
    expect(titles()).toEqual(['Budget']);
    expect(byRole('button', 'Only in Projects').getAttribute('aria-pressed')).toBe('true');
    expect(searchBox().getAttribute('aria-label')).toBe('Search Projects');
    expect(searchBox().placeholder).toBe('Search Projects');
    expect(h.settings.useSettings.getState().searchHere).toBe(true);
    await search('zebra');
    expect(textOf(pane().querySelector('.empty-state-body'))).toContain('in Projects');
  });

  it('keeps a search inside a tag with Only in #tag', async () => {
    await library();
    await setApp({ filter: { kind: 'tag', tag: 'home' } });
    await setSettings({ searchHere: true });
    await show();
    await search('budget');
    expect(titles()).toEqual(['Groceries']);
    expect(byRole('button', 'Only in #home').getAttribute('aria-pressed')).toBe('true');
  });

  it('in a library that isn’t encrypted, asks the server’s index', async () => {
    await teardown();
    vi.useFakeTimers({ toFake: ['Date'], now: NOW });
    await start({ encrypted: false });
    await seedNote('a', { title: 'Budget' });
    server.searchHits = [{ id: 'a', title: 'Budget', folder_id: null, updated_at: NOW, tags: [], snippet: 'the \u0001budget\u0002' }];
    await show();
    await search('budget');
    expect(server.requests('GET', '/api/search')[0].query.get('q')).toBe('budget');
    expect(titles()).toEqual(['Budget']);
  });

  it('falls back to matching titles and previews when the server can’t be searched', async () => {
    await teardown();
    vi.useFakeTimers({ toFake: ['Date'], now: NOW });
    await start({ encrypted: false });
    await seedNote('a', { title: 'Budget plan' });
    await seedNote('b', { title: 'Other', excerpt: 'about the budget' });
    await seedNote('c', { title: 'Nothing' });
    server.intercept = (req) => (req.path === '/api/search' ? Promise.reject(new TypeError('Failed to fetch')) : undefined);
    await show();
    await search('budget');
    expect(titles().sort()).toEqual(['Budget plan', 'Other']);
  });
});

describe('saved searches', () => {
  async function library() {
    await seedFolder('p', 'Projects');
    await seedFolder('w', 'Work stuff');
    await seedNote('a', { title: 'Budget', content: 'Plan the yearly budget', folder_id: 'p', tags: ['money'] });
    await seedNote('b', { title: 'Groceries', content: 'milk and budget beans', tags: ['home'] });
    await seedNote('c', { title: 'Trip', content: 'nothing about money', pinned: true });
    await seedNote('d', { title: 'Report', content: 'quarterly budget report', folder_id: 'w' });
  }
  const saved = () => h.settings.useSettings.getState().savedSearches;
  const found = async () => {
    await wait(260);
    await settle(30);
  };

  it('keeps a search by name, in the sidebar and on every device, and shows what it finds', async () => {
    await library();
    await show();
    await search('budget -beans');
    await click(byRole('button', 'Save this search'));
    await settle();
    expect(pendingDialog(h.store)).toMatchObject({ kind: 'prompt', title: 'Save this search', initial: 'budget -beans' });
    await answerDialog(h.store, 'Money matters');
    await found();
    expect(saved()).toEqual([{ id: expect.stringMatching(/^[A-Za-z0-9_-]{10}$/), name: 'Money matters', query: 'budget -beans' }]);
    expect(state().filter).toEqual({ kind: 'search', id: saved()[0].id });
    expect(state().listQuery).toBe('');
    expect(location.search).toBe(`?search=${saved()[0].id}`);
    expect(textOf(pane().querySelector('h1'))).toBe('Money matters');
    expect(titles().sort()).toEqual(['Budget', 'Report']);
    expect(textOf(pane().querySelector('.list-count'))).toBe('2');
    expect(searchBox().getAttribute('placeholder')).toBe('Search in Money matters');
  });

  it('narrows further with what’s typed, and has nothing to save (it’s saved already)', async () => {
    await library();
    await setSettings({ savedSearches: [{ id: 'ss1', name: 'Budgets', query: 'budget' }] });
    await setApp({ filter: { kind: 'search', id: 'ss1' } });
    await show();
    await found();
    expect(titles().sort()).toEqual(['Budget', 'Groceries', 'Report']);
    await search('quarterly');
    expect(titles()).toEqual(['Report']);
    expect(queryByRole('button', 'Save this search')).toBeNull();
  });

  it('can be only filters: pinned notes, a folder by its name, a tag', async () => {
    await library();
    await setSettings({
      savedSearches: [
        { id: 'pin', name: 'Pinned trips', query: 'is:pinned' },
        { id: 'work', name: 'Work', query: 'in:"Work stuff"' },
        { id: 'tag', name: 'Money', query: 'tag:money' },
      ],
    });
    await show();
    for (const [id, expected] of [
      ['pin', ['Trip']],
      ['work', ['Report']],
      ['tag', ['Budget']],
    ] as const) {
      await setApp({ filter: { kind: 'search', id } });
      await found();
      expect(titles(), id).toEqual(expected);
    }
  });

  it('saves a search made "Only in" a folder or tag with that, so it finds the same', async () => {
    await library();
    await setSettings({ searchHere: true });
    await setApp({ filter: { kind: 'folder', id: 'w' } });
    await show();
    await search('budget');
    await click(byRole('button', 'Save this search'));
    await settle();
    expect(pendingDialog(h.store)).toMatchObject({ initial: 'budget in:"Work stuff"' });
    await answerDialog(h.store, null);
    await setApp({ filter: { kind: 'tag', tag: 'money' } });
    await search('budget');
    await click(byRole('button', 'Save this search'));
    await settle();
    expect(pendingDialog(h.store)).toMatchObject({ initial: 'budget tag:money' });
    await answerDialog(h.store, null);
    expect(saved()).toEqual([]);
  });

  it('says when nothing matches yet, and when it was deleted (on another device, say)', async () => {
    await library();
    await setSettings({ savedSearches: [{ id: 'none', name: 'Nothing', query: 'zebra' }] });
    await setApp({ filter: { kind: 'search', id: 'none' } });
    await show();
    await found();
    expect(textOf(pane())).toContain('Nothing matches this saved search yet');
    expect(textOf(pane())).toContain('zebra');
    await setSettings({ savedSearches: [] });
    await found();
    expect(textOf(pane())).toContain('This saved search was deleted');
    await click(byRole('button', 'Show all notes'));
    expect(state().filter).toEqual({ kind: 'all' });
  });

  it('is renamed, changed and deleted from its menu, with Undo', async () => {
    await library();
    await setSettings({
      savedSearches: [
        { id: 'ss1', name: 'Budgets', query: 'budget' },
        { id: 'ss2', name: 'Other', query: 'trip' },
      ],
    });
    await setApp({ filter: { kind: 'search', id: 'ss1' } });
    await show();
    await click(byRole('button', 'Saved search options'));
    expect(menuLabels()).toEqual(['Rename…', 'Change what it finds…', 'Delete saved search']);
    await chooseMenuItem('Rename…');
    await answerDialog(h.store, 'All budgets');
    await settle();
    expect(saved()[0]).toMatchObject({ name: 'All budgets', query: 'budget' });
    await click(byRole('button', 'Saved search options'));
    await chooseMenuItem('Change what it finds…');
    await answerDialog(h.store, 'budget -milk');
    await settle();
    expect(saved()[0]).toMatchObject({ name: 'All budgets', query: 'budget -milk' });
    await click(byRole('button', 'Saved search options'));
    await chooseMenuItem('Delete saved search');
    await settle();
    expect(saved().map((x) => x.id)).toEqual(['ss2']);
    expect(state().filter).toEqual({ kind: 'all' });
    expect(toasts(h.store).at(-1)).toBe('Deleted the saved search “All budgets”. Your notes are unchanged.');
    await act(async () => state().toasts.at(-1)!.action!.run());
    expect(saved().map((x) => x.id)).toEqual(['ss1', 'ss2']);
  });
});

describe('choosing several notes', () => {
  async function five() {
    await seedFolder('p', 'Projects');
    for (let i = 1; i <= 5; i++) await seedNote(`n${i}`, { title: `Note ${i}`, updated_at: NOW - i * 1000, tags: i === 1 ? ['work'] : [] });
    await show();
  }
  const count = () => textOf(bulkBar()?.querySelector('.bulk-count'));

  it('chooses a note on Ctrl/⌘ click instead of opening it', async () => {
    await five();
    await click(row('Note 2'), { ctrlKey: true });
    expect(state().noteId).toBeNull();
    expect(count()).toBe('1 selected');
    expect(row('Note 2').classList.contains('is-selected')).toBe(true);
    await click(row('Note 4'), { metaKey: true });
    expect(count()).toBe('2 selected');
    // Again lets it go.
    await click(row('Note 2'), { ctrlKey: true });
    expect(count()).toBe('1 selected');
  });

  it('chooses a run with Shift click', async () => {
    await five();
    await click(row('Note 2'), { ctrlKey: true });
    await click(row('Note 4'), { shiftKey: true });
    expect(count()).toBe('3 selected');
    expect(rows().filter((r) => r.classList.contains('is-selected')).map((r) => textOf(r.querySelector('.row-title')))).toEqual(['Note 2', 'Note 3', 'Note 4']);
  });

  it('picks with a plain click while choosing, and opens nothing', async () => {
    await five();
    await click(row('Note 1'), { ctrlKey: true });
    await click(row('Note 3'));
    expect(count()).toBe('2 selected');
    expect(state().noteId).toBeNull();
  });

  it('chooses every note shown with Ctrl/⌘ A in the list, or the All button', async () => {
    await five();
    await focus(row('Note 1'));
    const ev = await press('a', { ctrlKey: true });
    expect(ev.defaultPrevented).toBe(true);
    expect(count()).toBe('5 selected');
    expect(queryByRole('button', 'All', bulkBar()!)).toBeNull();
    await click(byRole('button', 'Done choosing (Esc)'));
    await click(row('Note 1'), { ctrlKey: true });
    await click(byRole('button', 'All', bulkBar()!));
    expect(count()).toBe('5 selected');
  });

  it('lets the choice go with Esc, bringing the search box back', async () => {
    await five();
    await click(row('Note 1'), { ctrlKey: true });
    expect(searchBox()).toBeNull();
    const ev = await press('Escape', {}, document.body);
    expect(ev.defaultPrevented).toBe(true);
    expect(bulkBar()).toBeNull();
    expect(searchBox()).not.toBeNull();
    expect(rows().some((r) => r.classList.contains('is-selected'))).toBe(false);
  });

  it('chooses with taps after Select notes (for phones), starting from none', async () => {
    await five();
    await click(byRole('button', 'View options'));
    await chooseMenuItem('Select notes');
    expect(count()).toBe('Choose notes');
    expect(byRole('button', 'Move to trash', bulkBar()!).hasAttribute('disabled')).toBe(true);
    await click(row('Note 5'));
    expect(count()).toBe('1 selected');
    expect(state().noteId).toBeNull();
  });

  it('tells screen readers which notes are chosen', async () => {
    await five();
    await click(row('Note 2'), { ctrlKey: true });
    // Rows stay links (a tick box inside one would be a control inside a control): the state is in
    // what's read out, and no aria-selected, which links don't support.
    const said = (title: string) => (row(title).textContent ?? '').replace(/\s+/g, ' ');
    expect(said('Note 2')).toContain(', chosen');
    expect(said('Note 1')).toContain(', not chosen');
    expect(row('Note 2').hasAttribute('aria-selected')).toBe(false);
    expect(row('Note 2').querySelector('.sr-only')).not.toBeNull();
  });

  it('moves the chosen notes to a folder, says so, and lets them go', async () => {
    await five();
    await click(row('Note 1'), { ctrlKey: true });
    await click(row('Note 2'), { ctrlKey: true });
    await click(byRole('button', 'Move to folder'));
    expect(menuLabels()).toEqual(['No folder', 'Projects']);
    await chooseMenuItem('Projects');
    expect([state().notes.n1.folder_id, state().notes.n2.folder_id]).toEqual(['p', 'p']);
    expect(toasts(h.store).at(-1)).toBe('Moved 2 notes to Projects');
    expect(bulkBar()).toBeNull();
  });

  it('adds a tag to the chosen notes that lack it, and takes it off when they all have it', async () => {
    await five();
    await click(row('Note 1'), { ctrlKey: true });
    await click(row('Note 2'), { ctrlKey: true });
    await click(byRole('button', 'Tags'));
    expect(textOf(openMenu().querySelector('.menu-heading'))).toBe('Tags on 2 notes');
    expect(textOf(openMenu().querySelector('.menu-hint'))).toBe('1 of 2');
    await chooseMenuItem('#work');
    expect(state().notes.n2.tags).toEqual(['work']);
    expect(toasts(h.store).at(-1)).toBe('Added #work to 1 note');
    await click(byRole('button', 'Tags'));
    await chooseMenuItem('#work');
    expect([state().notes.n1.tags, state().notes.n2.tags]).toEqual([[], []]);
    expect(toasts(h.store).at(-1)).toBe('Removed #work from 2 notes');
  });

  it('adds a new tag typed for the chosen notes, cleaned like any tag', async () => {
    await five();
    await click(row('Note 3'), { ctrlKey: true });
    await click(byRole('button', 'Tags'));
    await chooseMenuItem('New tag…');
    expect(pendingDialog(h.store)).toMatchObject({ kind: 'prompt', title: 'Tag 1 note' });
    await answerDialog(h.store, '#Road trip');
    expect(state().notes.n3.tags).toEqual(['Road-trip']);
  });

  it('pins the chosen notes together, then unpins them', async () => {
    await five();
    await click(row('Note 1'), { ctrlKey: true });
    await click(row('Note 2'), { ctrlKey: true });
    await click(byRole('button', 'Pin to top'));
    await settle();
    expect([state().notes.n1.pinned, state().notes.n2.pinned]).toEqual([true, true]);
    const unpin = byRole('button', 'Unpin', bulkBar()!);
    expect(unpin.getAttribute('aria-pressed')).toBe('true');
    await click(unpin);
    await settle();
    expect([state().notes.n1.pinned, state().notes.n2.pinned]).toEqual([false, false]);
  });

  it('moves the chosen notes to the trash with Undo', async () => {
    await five();
    await click(row('Note 1'), { ctrlKey: true });
    await click(row('Note 2'), { ctrlKey: true });
    await click(byRole('button', 'Move to trash', bulkBar()!));
    await settle();
    expect(titles()).toEqual(['Note 3', 'Note 4', 'Note 5']);
    expect(toasts(h.store).at(-1)).toBe('Moved 2 notes to the trash');
    expect(bulkBar()).toBeNull();
    state().toasts.at(-1)!.action!.run();
    await settle();
    expect(rows()).toHaveLength(5);
  });

  it('acts on every chosen note from a right-click on one of them', async () => {
    await five();
    await click(row('Note 1'), { ctrlKey: true });
    await click(row('Note 2'), { ctrlKey: true });
    await contextMenu(row('Note 2'));
    expect(textOf(openMenu().querySelector('.menu-heading'))).toBe('2 notes');
    await chooseMenuItem('Pin to top');
    expect([state().notes.n1.pinned, state().notes.n2.pinned]).toEqual([true, true]);
    // A right-click on a note that isn't chosen is about that note alone.
    await contextMenu(row('Note 5'));
    expect(menuLabels()[0]).toBe('Pin to top');
    expect(openMenu().querySelector('.menu-heading')!.textContent).toBe('Move to');
  });

  it('drags every chosen note together, or just the one dragged otherwise', async () => {
    await five();
    let dt = dataTransfer();
    await drag('dragstart', row('Note 3'), dt);
    expect(dt.getData('application/x-kb-note')).toBe('n3');
    expect(dt.getData('text/uri-list')).toBe(`${location.origin}/note/n3`);
    await click(row('Note 1'), { ctrlKey: true });
    await click(row('Note 2'), { ctrlKey: true });
    dt = dataTransfer();
    await drag('dragstart', row('Note 2'), dt);
    expect(dt.getData('application/x-kb-note').split(',').sort()).toEqual(['n1', 'n2']);
    dt = dataTransfer();
    await drag('dragstart', row('Note 4'), dt);
    expect(dt.getData('application/x-kb-note')).toBe('n4');
  });

  it('moves the chosen notes when they’re dragged onto a folder in the sidebar', async () => {
    const { Sidebar } = await import('../../src/components/Sidebar');
    await seedFolder('p', 'Projects');
    for (let i = 1; i <= 3; i++) await seedNote(`n${i}`, { title: `Note ${i}`, updated_at: NOW - i * 1000 });
    await render(
      <>
        <Sidebar />
        <NoteList />
      </>,
    );
    await click(row('Note 1'), { ctrlKey: true });
    await click(row('Note 3'), { ctrlKey: true });
    const dt = dataTransfer();
    await drag('dragstart', row('Note 3'), dt);
    const folder = document.querySelector('nav .nav-row')!;
    expect((await drag('dragover', folder, dt)).defaultPrevented).toBe(true);
    await drag('drop', folder, dt);
    await settle();
    expect([state().notes.n1.folder_id, state().notes.n2.folder_id, state().notes.n3.folder_id]).toEqual(['p', null, 'p']);
    expect([server.rows.get('n1')!.folder_id, server.rows.get('n3')!.folder_id]).toEqual(['p', 'p']);
  });

  it('stops counting a chosen note that leaves the list', async () => {
    await five();
    await click(row('Note 1'), { ctrlKey: true });
    await click(row('Note 2'), { ctrlKey: true });
    await setApp((s: any) => ({ notes: { ...s.notes, n2: { ...s.notes.n2, deleted_at: NOW } } }));
    expect(count()).toBe('1 selected');
  });

  it('restores or deletes chosen notes in the trash, asking before deleting', async () => {
    await seedNote('t1', { title: 'Gone 1', deleted_at: NOW - 1000 });
    await seedNote('t2', { title: 'Gone 2', deleted_at: NOW - 2000 });
    await seedNote('t3', { title: 'Gone 3', deleted_at: NOW - 3000 });
    await setApp({ filter: { kind: 'trash' } });
    await show();
    await click(byRole('button', 'Select notes'));
    await click(row('Gone 1'));
    await click(byRole('button', 'Restore', bulkBar()!));
    await settle();
    expect(titles()).toEqual(['Gone 2', 'Gone 3']);
    await click(byRole('button', 'Select notes'));
    await click(row('Gone 2'));
    await click(row('Gone 3'));
    await click(byRole('button', 'Delete forever', bulkBar()!));
    expect(pendingDialog(h.store)).toMatchObject({ title: 'Delete 2 notes forever?' });
    await answerDialog(h.store, true);
    expect(rows()).toHaveLength(0);
    expect(server.rows.has('t2') || server.rows.has('t3')).toBe(false);
    expect(server.rows.has('t1')).toBe(true);
  });

  it('starts again in another view', async () => {
    await five();
    await click(row('Note 1'), { ctrlKey: true });
    await setApp({ filter: { kind: 'pinned' } });
    expect(bulkBar()).toBeNull();
  });
});

describe('accessibility basics', () => {
  it('labels the search box and every button', async () => {
    await seedNote('a', { title: 'Plan' });
    await show();
    expect(searchBox().getAttribute('aria-label')).toBe('Search all notes');
    for (const b of allByRole('button', undefined, pane())) expect(b.getAttribute('aria-label') ?? textOf(b), b.outerHTML.slice(0, 80)).not.toBe('');
    await click(row('Plan'), { ctrlKey: true });
    for (const b of allByRole('button', undefined, bulkBar()!)) expect(b.getAttribute('aria-label') ?? textOf(b)).not.toBe('');
    expect(bulkBar()!.querySelector('.bulk-count')!.getAttribute('aria-live')).toBe('polite');
  });

  it('labels each section of the list after its group', async () => {
    await seedNote('a', { title: 'Plan', pinned: true });
    await seedNote('b', { title: 'Other' });
    await show();
    expect(Array.from(pane().querySelectorAll('section.group')).map((g) => g.getAttribute('aria-label'))).toEqual(['Pinned', 'Today']);
  });

  it('gives focus to the menu it opens from the keyboard', async () => {
    await show();
    await focus(byRole('button', 'View options'));
    await click(byRole('button', 'View options'));
    await new Promise((r) => requestAnimationFrame(r));
    await settle(2);
    expect(focused()).toMatch(/Last edited/);
  });
});
