// @vitest-environment jsdom
/**
 * The sidebar (src/components/Sidebar.tsx): what it counts and lists for a library, where each of its
 * entries goes, folders (nested, opened with the arrow keys, their menus, dragging notes and folders
 * onto them), tags (counted, opened, and renamed, merged or removed from a right-click), the
 * not-synced marker, and that it's usable without a mouse. The library is encrypted, as the owner keeps it.
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  answerDialog,
  allByRole,
  boot,
  byRole,
  chooseMenuItem,
  click,
  contextMenu,
  dataTransfer,
  drag,
  focus,
  focused,
  frame,
  listNotes,
  menuLabels,
  metaFor,
  NOW,
  openMenu,
  pendingDialog,
  press,
  queryByRole,
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
  type Booted,
} from './ui-shell-helpers';

let h: Booted;
let Sidebar: typeof import('../../src/components/Sidebar').Sidebar;

beforeEach(async () => {
  h = await boot();
  ({ Sidebar } = await import('../../src/components/Sidebar'));
});
afterEach(teardown);

const show = () => render(<Sidebar />);
const nav = () => byRole('navigation', 'Library');
/** A sidebar entry ("All notes", "Trash", a folder) by its label, and the count it shows. */
const entry = (label: string) => {
  const found = allByRole('button', undefined, nav()).filter((b) => textOf(b.querySelector('.nav-label')) === label);
  if (found.length !== 1) throw new Error(`${found.length} sidebar entries named ${label}`);
  return found[0];
};
const countOf = (label: string) => textOf(entry(label).querySelector('.nav-count')) || null;
const tagPill = (tag: string) => {
  const pill = Array.from(nav().querySelectorAll<HTMLElement>('.tag-pill')).find((p) => textOf(p).replace(/\d+$/, '') === tag);
  if (!pill) throw new Error(`No tag ${tag}`);
  return pill;
};
const state = () => h.store.useApp.getState();

describe('what the sidebar shows', () => {
  it('names the workspace and is a navigation landmark called Library', async () => {
    await show();
    expect(textOf(nav().querySelector('.workspace-name'))).toBe('Lumen');
    await setSettings({ workspaceName: 'Field notes' });
    expect(textOf(nav().querySelector('.workspace-name'))).toBe('Field notes');
  });

  it('counts live notes, pinned notes and the trash separately, and hides a count of zero', async () => {
    await seedNote('a', { pinned: true });
    await seedNote('b');
    await seedNote('c', { deleted_at: NOW, pinned: true });
    await show();
    expect(countOf('All notes')).toBe('2');
    expect(countOf('Pinned')).toBe('1');
    expect(countOf('Trash')).toBe('1');
    expect(countOf('Tasks')).toBeNull();
  });

  it('counts open tasks across notes, leaving out templates and the trash', async () => {
    await seedFolder('tpl', 'Templates');
    await seedNote('a', { info: { t: [1, 4] } });
    await seedNote('b', { info: { t: [0, 2] } });
    await seedNote('t', { folder_id: 'tpl', info: { t: [0, 5] } });
    await seedNote('gone', { deleted_at: NOW, info: { t: [0, 9] } });
    await show();
    expect(countOf('Tasks')).toBe('5');
  });

  it('shows an empty library as empty: no counts, a way to create the first folder, and no tag section', async () => {
    await show();
    expect(countOf('All notes')).toBeNull();
    expect(countOf('Trash')).toBeNull();
    expect(byRole('button', 'Create a folder')).toBeTruthy();
    expect(queryByRole('region', 'Tags')).toBeNull();
  });

  it('keeps counting correctly for a large library', async () => {
    await listNotes(Array.from({ length: 1500 }, (_, i) => metaFor(`n${i}`, { tags: i % 3 ? [] : ['big'], deleted_at: i % 10 === 0 ? NOW : null })));
    await show();
    expect(countOf('All notes')).toBe('1350');
    expect(countOf('Trash')).toBe('150');
    expect(textOf(tagPill('big').querySelector('.tag-count'))).toBe('450');
  });

  it('shows who is signed in, and opens Settings from there', async () => {
    await show();
    const profile = byRole('button', /owner@example\.com/);
    expect(textOf(profile)).toContain('Signed in with Cloudflare Access');
    await setApp({ drawerOpen: true });
    await click(profile);
    expect(state()).toMatchObject({ settingsOpen: true, drawerOpen: false });
  });
});

describe('going places', () => {
  it('opens each list from its entry and marks it as the current page', async () => {
    await seedNote('a');
    await show();
    await click(entry('Pinned'));
    expect(state().filter).toEqual({ kind: 'pinned' });
    expect(entry('Pinned').getAttribute('aria-current')).toBe('page');
    expect(entry('All notes').getAttribute('aria-current')).toBeNull();
    await click(entry('Trash'));
    expect(state().filter).toEqual({ kind: 'trash' });
    expect(entry('Trash').getAttribute('aria-current')).toBe('page');
    await click(entry('All notes'));
    expect(state().filter).toEqual({ kind: 'all' });
  });

  it('opens the list on phones and closes the drawer when a list is picked', async () => {
    await show();
    await setApp({ drawerOpen: true, mobileTab: 'home' });
    await click(entry('Pinned'));
    expect(state()).toMatchObject({ drawerOpen: false, mobileTab: 'notes' });
  });

  it('goes Home, leaving an open note', async () => {
    await seedNote('a');
    await show();
    h.store.openNote('a');
    await click(entry('Home'));
    expect(state()).toMatchObject({ noteId: null, screen: 'home', mobileTab: 'home' });
    expect(location.pathname).toBe('/');
  });

  it('opens every task at /tasks, and marks Tasks as current there', async () => {
    await show();
    await click(entry('Tasks'));
    expect(state().screen).toBe('tasks');
    expect(location.pathname).toBe('/tasks');
    expect(entry('Tasks').getAttribute('aria-current')).toBe('page');
  });

  it('marks Home as the current page while Home is showing', async () => {
    await show();
    await click(entry('Tasks'));
    await click(entry('Home'));
    expect(entry('Home').getAttribute('aria-current')).toBe('page');
    expect(entry('Tasks').getAttribute('aria-current')).toBeNull();
  });

  it('opens the switcher from Search, closing the drawer', async () => {
    await show();
    await setApp({ drawerOpen: true });
    await click(byRole('button', /^Search/));
    expect(state()).toMatchObject({ paletteOpen: true, drawerOpen: false });
  });

  it('makes a note with New note and opens it, encrypted before it leaves the device', async () => {
    await show();
    await click(byRole('button', 'New note'));
    await settle();
    const post = server.requests('POST', '/api/notes')[0];
    expect(post.body).toMatchObject({ enc: true });
    expect(post.body!.title).toBeUndefined();
    expect(state().noteId).toBe(post.body!.id);
    expect(location.pathname).toBe(`/note/${post.body!.id}`);
  });

  it('makes a new note in the folder being viewed', async () => {
    await seedFolder('p', 'Projects');
    await show();
    await click(entry('Projects'));
    await click(byRole('button', 'New note'));
    await settle();
    expect(state().notes[state().noteId!].folder_id).toBe('p');
  });

  it('opens today’s journal entry, making it (tagged #journal, in a Journal folder) the first time', async () => {
    await show();
    await click(entry('Today’s journal'));
    await settle();
    const id = state().noteId!;
    const made = state().notes[id];
    const today = new Date();
    const iso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    expect(made).toMatchObject({ title: iso, tags: ['journal'] });
    expect(state().folders.find((f) => f.id === made.folder_id)?.name).toBe('Journal');
    // A second time opens the same entry.
    h.store.goHome();
    await click(entry('Today’s journal'));
    await settle();
    expect(state().noteId).toBe(id);
    expect(server.requests('POST', '/api/notes')).toHaveLength(1);
  });

  it('hides itself from its own button, and closes as a drawer from Close menu', async () => {
    await show();
    await click(byRole('button', 'Hide sidebar'));
    expect(h.settings.useSettings.getState().sidebarCollapsed).toBe(true);
    await setApp({ drawerOpen: true });
    await click(byRole('button', 'Close menu'));
    expect(state().drawerOpen).toBe(false);
  });
});

describe('what’s marked current', () => {
  const current = () => Array.from(nav().querySelectorAll('[aria-current="page"]')).map((el) => textOf(el).replace(/\d+$/, '').trim());

  it('marks the list and the page beside it on a tablet or wider, where both show', async () => {
    await show();
    await setApp({ screen: 'home', noteId: null, filter: { kind: 'all' } });
    expect(current()).toEqual(['Home', 'All notes']);
  });

  describe('on a phone, where one page shows at a time', () => {
    beforeEach(async () => {
      await teardown();
      h = await boot({ phone: true });
      ({ Sidebar } = await import('../../src/components/Sidebar'));
    });

    it('marks only All notes while the list is showing, not Home', async () => {
      await show();
      await setApp({ screen: 'home', noteId: null, filter: { kind: 'all' }, mobileTab: 'notes', drawerOpen: true });
      expect(current()).toEqual(['All notes']);
    });

    it('marks only Tasks on the Tasks page, not the list it came from', async () => {
      await show();
      await setApp({ filter: { kind: 'all' }, mobileTab: 'notes' });
      await click(entry('Tasks'));
      expect(state()).toMatchObject({ screen: 'tasks', mobileTab: 'home', filter: { kind: 'all' } });
      expect(current()).toEqual(['Tasks']);
    });

    it('marks only Home on Home, whichever list was open last', async () => {
      await seedFolder('p', 'Projects');
      await seedNote('a', { folder_id: 'p', tags: ['work'], pinned: true });
      await show();
      for (const filter of [{ kind: 'all' }, { kind: 'folder', id: 'p' }, { kind: 'tag', tag: 'work' }, { kind: 'pinned' }, { kind: 'trash' }]) {
        await setApp({ filter, screen: 'home', noteId: null, mobileTab: 'home' });
        expect(current(), JSON.stringify(filter)).toEqual(['Home']);
      }
    });

    it('marks a folder or tag once its list is showing, and Home again on going back', async () => {
      await seedFolder('p', 'Projects');
      await seedNote('a', { folder_id: 'p', tags: ['work'] });
      await show();
      await click(entry('Projects'));
      expect(current()).toEqual(['Projects']);
      await click(tagPill('work'));
      expect(current()).toEqual(['work']);
      await click(entry('Home'));
      expect(current()).toEqual(['Home']);
    });
  });
});

describe('the New menu', () => {
  it('offers notes, drawings, diagrams, the journal, a folder and each template but the journal’s', async () => {
    await seedFolder('tpl', 'Templates');
    await seedNote('t1', { title: 'Meeting {{date}}', folder_id: 'tpl' });
    await seedNote('t2', { title: 'Journal', folder_id: 'tpl' });
    await show();
    const more = byRole('button', 'Create something else');
    expect(more.getAttribute('aria-haspopup')).toBe('menu');
    await click(more);
    expect(more.getAttribute('aria-expanded')).toBe('true');
    expect(menuLabels()).toEqual(['Note', 'Drawing', 'Diagram', 'Today’s journal', 'Folder', 'Meeting {{date}}', 'New template']);
  });

  it('starts a note from a template with its placeholders filled in', async () => {
    await seedFolder('tpl', 'Templates');
    await seedNote('t1', { title: 'Meeting {{date}}', folder_id: 'tpl', content: 'Agenda for {{title}}', tags: ['template', 'work'] });
    await show();
    await click(byRole('button', 'Create something else'));
    await chooseMenuItem('Meeting {{date}}');
    await settle();
    const made = state().notes[state().noteId!];
    expect(made.title).toMatch(/^Meeting \d{4}-\d{2}-\d{2}$/);
    expect(made.tags).toEqual(['work']);
    expect(made.folder_id).toBeNull();
  });

  it('closes on Escape and gives focus back to the button that opened it', async () => {
    await show();
    const more = byRole('button', 'Create something else');
    await focus(more);
    await click(more);
    await frame();
    // The menu takes focus, so the arrow keys move through it.
    expect(openMenu().contains(document.activeElement)).toBe(true);
    await press('ArrowDown');
    expect(textOf(document.activeElement)).toContain('Drawing');
    await press('Escape');
    expect(queryByRole('menu')).toBeNull();
    expect(more.getAttribute('aria-expanded')).toBe('false');
    // Focus goes back to the button that opened the menu, not to the page.
    expect(focused()).toBe('Create something else');
  });
});

describe('folders', () => {
  async function tree() {
    await seedFolder('p', 'Projects', null, 0);
    await seedFolder('c', 'Clients', 'p', 0);
    await seedFolder('x', 'Acme', 'c', 0);
    await seedFolder('h', 'Home stuff', null, 1);
    await seedNote('n1', { folder_id: 'p' });
    await seedNote('n2', { folder_id: 'c' });
    await seedNote('n3', { folder_id: 'x' });
    await seedNote('n4', { folder_id: 'x', deleted_at: NOW });
    await show();
  }

  it('lists top-level folders in their order, each counting the notes in its subfolders too', async () => {
    await tree();
    const names = Array.from(nav().querySelectorAll('.nav-section[aria-label="Folders"] .nav-row .nav-label')).map(textOf);
    expect(names).toEqual(['Projects', 'Home stuff']);
    expect(countOf('Projects')).toBe('3');
    expect(countOf('Home stuff')).toBeNull();
  });

  it('opens and closes a folder’s subfolders from its chevron, remembering it', async () => {
    await tree();
    const projects = entry('Projects');
    expect(projects.getAttribute('aria-expanded')).toBe('false');
    // The chevron is a mouse shortcut inside the folder's button (the keyboard uses → and ←).
    await click(projects.querySelector('.folder-toggle')!);
    expect(entry('Clients')).toBeTruthy();
    expect(countOf('Clients')).toBe('2');
    expect(projects.getAttribute('aria-expanded')).toBe('true');
    expect(h.settings.useSettings.getState().expandedFolders).toEqual(['p']);
    // The chevron doesn't also open the folder's list.
    expect(state().filter).toEqual({ kind: 'all' });
    await click(projects.querySelector('.folder-toggle')!);
    expect(() => entry('Clients')).toThrow();
  });

  it('opens a folder’s subfolders with → and closes them with ←, as the README says', async () => {
    await tree();
    const projects = entry('Projects');
    await focus(projects);
    const right = await press('ArrowRight');
    expect(right.defaultPrevented).toBe(true);
    expect(entry('Clients')).toBeTruthy();
    // Again on an open folder does nothing more.
    await press('ArrowRight');
    expect(h.settings.useSettings.getState().expandedFolders).toEqual(['p']);
    await press('ArrowLeft');
    expect(() => entry('Clients')).toThrow();
    // A folder without subfolders has no expanded state at all.
    expect(entry('Home stuff').hasAttribute('aria-expanded')).toBe(false);
  });

  it('opens a folder’s list, marked as the current page', async () => {
    await tree();
    await click(entry('Projects'));
    expect(state().filter).toEqual({ kind: 'folder', id: 'p' });
    expect(entry('Projects').getAttribute('aria-current')).toBe('page');
  });

  it('has no control nested inside another', async () => {
    await tree();
    const nested = allByRole('button', undefined, nav()).filter((b) => b.parentElement?.closest('button, [role="button"]'));
    expect(nested.map((b) => b.getAttribute('aria-label') ?? textOf(b))).toEqual([]);
  });

  it('asks for a name to create a folder, and shows it at once', async () => {
    await show();
    await click(byRole('button', 'New folder'));
    expect(pendingDialog(h.store)).toMatchObject({ kind: 'prompt', title: 'New folder' });
    await answerDialog(h.store, '  Reading list ');
    expect(entry('Reading list')).toBeTruthy();
    // The name went to the server encrypted.
    const post = server.requests('POST', '/api/folders')[0];
    expect(JSON.stringify(post.body)).not.toContain('Reading list');
  });

  it('creates nothing when the name prompt is cancelled', async () => {
    await show();
    await click(byRole('button', 'Create a folder'));
    await answerDialog(h.store, null);
    expect(server.requests('POST', '/api/folders')).toHaveLength(0);
    expect(byRole('button', 'Create a folder')).toBeTruthy();
  });

  it('offers a folder’s actions from its menu, moving it anywhere but into itself', async () => {
    await tree();
    await click(byRole('button', 'Projects options'));
    expect(menuLabels()).toEqual(['New note here', 'New subfolder', 'Rename', 'Top level', 'Home stuff', 'Delete folder']);
    await chooseMenuItem('Home stuff');
    expect(state().folders.find((f) => f.id === 'p')?.parent_id).toBe('h');
  });

  it('makes a note in a folder from its menu', async () => {
    await tree();
    await click(byRole('button', 'Home stuff options'));
    await chooseMenuItem('New note here');
    await settle();
    expect(state().notes[state().noteId!].folder_id).toBe('h');
  });

  it('opens the folder once a subfolder is made in it', async () => {
    await tree();
    await click(byRole('button', 'Home stuff options'));
    await chooseMenuItem('New subfolder');
    expect(pendingDialog(h.store)).toMatchObject({ title: 'New subfolder' });
    await answerDialog(h.store, 'Garden');
    expect(entry('Garden')).toBeTruthy();
    expect(entry('Home stuff').getAttribute('aria-expanded')).toBe('true');
  });

  it('asks before deleting a folder, saying how many notes go to the trash', async () => {
    await tree();
    await click(entry('Projects'));
    await click(byRole('button', 'Projects options'));
    await chooseMenuItem('Delete folder');
    expect(pendingDialog(h.store)).toMatchObject({ title: 'Delete “Projects”?', message: expect.stringContaining('3 notes move to the trash') });
    await answerDialog(h.store, true);
    expect(() => entry('Projects')).toThrow();
    expect(state().filter).toEqual({ kind: 'all' });
  });

  it('moves a note dropped on a folder into it', async () => {
    await tree();
    const row = entry('Home stuff').closest('.nav-row')!;
    const dt = dataTransfer({ 'application/x-kb-note': 'n1' });
    const over = await drag('dragover', row, dt);
    expect(over.defaultPrevented).toBe(true);
    expect(row.classList.contains('is-drop')).toBe(true);
    await drag('drop', row, dt);
    await settle();
    expect(row.classList.contains('is-drop')).toBe(false);
    expect(state().notes.n1.folder_id).toBe('h');
    expect(server.rows.get('n1')!.folder_id).toBe('h');
  });

  it('moves several chosen notes dropped together', async () => {
    await tree();
    await drag('drop', entry('Home stuff').closest('.nav-row'), dataTransfer({ 'application/x-kb-note': 'n1,n2' }));
    await settle();
    expect([state().notes.n1.folder_id, state().notes.n2.folder_id]).toEqual(['h', 'h']);
  });

  it('takes notes out of their folder when dropped on All notes, and pins them on Pinned', async () => {
    await tree();
    await drag('drop', entry('All notes'), dataTransfer({ 'application/x-kb-note': 'n1,n2' }));
    await settle();
    expect([state().notes.n1.folder_id, state().notes.n2.folder_id]).toEqual([null, null]);
    await drag('drop', entry('Pinned'), dataTransfer({ 'application/x-kb-note': 'n3' }));
    await settle();
    expect(state().notes.n3.pinned).toBe(true);
  });

  it('ignores drags that aren’t notes (a file from the desktop) on All notes', async () => {
    await tree();
    const over = await drag('dragover', entry('All notes'), dataTransfer({ Files: '' }));
    expect(over.defaultPrevented).toBe(false);
  });

  it('moves a folder dropped on another, but never into its own subfolder', async () => {
    await tree();
    await click(entry('Projects').querySelector('.folder-toggle')!);
    await drag('drop', entry('Clients').closest('.nav-row'), dataTransfer({ 'application/x-kb-folder': 'p' }));
    await settle();
    expect(state().folders.find((f) => f.id === 'p')?.parent_id).toBeNull();
    expect(server.requests('PATCH', /^\/api\/folders\//)).toHaveLength(0);
    await drag('drop', entry('Home stuff').closest('.nav-row'), dataTransfer({ 'application/x-kb-folder': 'c' }));
    await settle();
    expect(state().folders.find((f) => f.id === 'c')?.parent_id).toBe('h');
  });

  it('keeps the Folders section open or closed from its heading', async () => {
    await tree();
    const head = byRole('button', 'Folders');
    expect(head.getAttribute('aria-expanded')).toBe('true');
    await click(head);
    expect(head.getAttribute('aria-expanded')).toBe('false');
    expect(() => entry('Projects')).toThrow();
  });
});

describe('saved searches', () => {
  it('are listed by name once there are some, open their list, and have a menu', async () => {
    await show();
    expect(queryByRole('region', 'Saved searches')).toBeNull();
    await setSettings({
      savedSearches: [
        { id: 'ss1', name: 'Budgets', query: 'budget' },
        { id: 'ss2', name: 'Open tasks', query: 'has:task' },
      ],
    });
    const section = byRole('region', 'Saved searches');
    expect(Array.from(section.querySelectorAll('.nav-label')).map(textOf)).toEqual(['Budgets', 'Open tasks']);
    await click(byRole('button', 'Open tasks', section));
    expect(state().filter).toEqual({ kind: 'search', id: 'ss2' });
    expect(byRole('button', 'Open tasks', section).getAttribute('aria-current')).toBe('page');
    await click(byRole('button', 'Budgets options', section));
    expect(menuLabels()).toEqual(['Rename…', 'Change what it finds…', 'Delete saved search']);
    await press('Escape');
    await contextMenu(byRole('button', 'Budgets', section));
    await chooseMenuItem('Delete saved search');
    expect(h.settings.useSettings.getState().savedSearches.map((s) => s.id)).toEqual(['ss2']);
  });
});

describe('tags', () => {
  async function tagged() {
    await seedNote('a', { tags: ['work', 'ideas'] });
    await seedNote('b', { tags: ['Work'] });
    await seedNote('c', { tags: ['ideas'] });
    await seedNote('d', { tags: ['zeta'] });
    await seedNote('e', { tags: ['work'], deleted_at: NOW });
    await show();
  }

  it('lists each tag once whatever its case, most used first, with how many live notes have it', async () => {
    await tagged();
    const pills = Array.from(nav().querySelectorAll('.tag-pill')).map((p) => [textOf(p).replace(/\d+$/, ''), textOf(p.querySelector('.tag-count'))]);
    expect(pills).toEqual([
      ['ideas', '2'],
      ['work', '2'],
      ['zeta', '1'],
    ]);
  });

  it('opens a tag’s list, in whatever case it was clicked', async () => {
    await tagged();
    await click(tagPill('work'));
    expect(state().filter).toEqual({ kind: 'tag', tag: 'work' });
    expect(tagPill('work').getAttribute('aria-current')).toBe('page');
    await setApp({ filter: { kind: 'tag', tag: 'WORK' } });
    expect(tagPill('work').getAttribute('aria-current')).toBe('page');
  });

  it('opens a tag’s menu on a right-click: rename or merge, or remove from all notes', async () => {
    await tagged();
    const prevented = await contextMenu(tagPill('ideas'));
    expect(prevented).toBe(true);
    expect(textOf(openMenu().querySelector('.menu-heading'))).toBe('#ideas');
    expect(menuLabels()).toEqual(['Rename or merge…', 'Remove from all notes']);
    await press('Escape');
    expect(queryByRole('menu')).toBeNull();
  });

  it('renames a tag on every note that has it, in the trash too, with Undo', async () => {
    await tagged();
    await contextMenu(tagPill('work'));
    await chooseMenuItem('Rename or merge…');
    expect(pendingDialog(h.store)).toMatchObject({ kind: 'prompt', title: 'Rename #work', initial: 'work' });
    await answerDialog(h.store, 'job');
    expect(state().notes.a.tags).toEqual(['job', 'ideas']);
    expect(state().notes.b.tags).toEqual(['job']);
    expect(state().notes.e.tags).toEqual(['job']);
    expect(toasts(h.store).at(-1)).toBe('Renamed #work to #job in 3 notes');
    const undo = state().toasts.at(-1)!.action!;
    undo.run();
    await settle();
    expect(state().notes.a.tags).toEqual(['work', 'ideas']);
  });

  it('asks before merging a tag into one that exists', async () => {
    await tagged();
    await contextMenu(tagPill('zeta'));
    await chooseMenuItem('Rename or merge…');
    await answerDialog(h.store, 'ideas');
    expect(pendingDialog(h.store)).toMatchObject({ title: 'Merge #zeta into #ideas?' });
    await answerDialog(h.store, true);
    expect(state().notes.d.tags).toEqual(['ideas']);
    expect(textOf(tagPill('ideas').querySelector('.tag-count'))).toBe('3');
  });

  it('asks before removing a tag from every note, and follows to All notes if that tag was open', async () => {
    await tagged();
    await click(tagPill('zeta'));
    await contextMenu(tagPill('zeta'));
    await chooseMenuItem('Remove from all notes');
    expect(pendingDialog(h.store)).toMatchObject({ title: 'Remove #zeta?', danger: true });
    await answerDialog(h.store, true);
    expect(state().notes.d.tags).toEqual([]);
    expect(state().filter).toEqual({ kind: 'all' });
    expect(() => tagPill('zeta')).toThrow();
  });

  it('collapses the tag list from its heading, remembered in settings', async () => {
    await tagged();
    await click(byRole('button', 'Tags'));
    expect(h.settings.useSettings.getState().tagsOpen).toBe(false);
    expect(nav().querySelector('.tag-pill')).toBeNull();
  });
});

describe('notes that haven’t synced', () => {
  it('says nothing while everything is synced', async () => {
    await seedNote('a');
    await show();
    expect(queryByRole('button', /not synced/)).toBeNull();
  });

  it('lists notes whose edits are stuck on this device, and opens one from the list', async () => {
    await seedNote('a', { title: 'Shopping' });
    await seedNote('b', { title: 'Plans' });
    await show();
    server.intercept = (req) => (req.method === 'PATCH' ? Promise.reject(new TypeError('Failed to fetch')) : undefined);
    h.saver.edit('a', { content: 'milk' }, 1);
    h.saver.edit('b', { content: 'later' }, 1);
    await h.saver.flush('a');
    await h.saver.flush('b');
    await settle();
    const marker = byRole('button', '2 notes not synced');
    await setApp({ drawerOpen: true });
    await click(marker);
    expect(textOf(openMenu().querySelector('.menu-heading'))).toBe('Saved on this device only');
    expect(menuLabels()).toEqual(['Shopping', 'Plans']);
    expect(Array.from(openMenu().querySelectorAll('.menu-hint')).map(textOf)).toEqual(['Offline', 'Offline']);
    await chooseMenuItem('Plans');
    expect(state()).toMatchObject({ noteId: 'b', drawerOpen: false });
  });
});

describe('keyboard and screen readers', () => {
  it('makes every control a real button with a name', async () => {
    await seedFolder('p', 'Projects');
    await seedNote('a', { tags: ['work'], folder_id: 'p' });
    await show();
    const controls = Array.from(nav().querySelectorAll<HTMLElement>('button, [role="button"], a[href]'));
    expect(controls.length).toBeGreaterThan(10);
    for (const c of controls) {
      expect(c.tagName, c.outerHTML.slice(0, 80)).toBe('BUTTON');
      expect(c.getAttribute('type'), c.outerHTML.slice(0, 80)).toBe('button');
    }
    for (const c of allByRole('button', undefined, nav())) expect(c.getAttribute('aria-label') ?? textOf(c), c.outerHTML.slice(0, 80)).not.toBe('');
  });

  it('shows the Ctrl/⌘ K shortcut on Search and the shortcut on Hide sidebar', async () => {
    await show();
    expect(textOf(byRole('button', /^Search/).querySelector('.search-kbd'))).toMatch(/^(Ctrl|⌘)K$/);
    expect(byRole('button', 'Hide sidebar').dataset.tipKbd).toMatch(/^(Ctrl|⌘) \\$/);
  });
});
