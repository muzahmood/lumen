// @vitest-environment jsdom
/**
 * Back as in an app (src/lib/backLayers.ts, and routing in src/lib/store.ts): it closes what's open
 * over the page first, newest first, then goes back through Lumen's pages, each with its own address
 * (folder, tag, view and search included) and title; only from the first does it leave. With
 * encryption on, tag names and searches stay out of the address and the history entry.
 */
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NOW, polyfillMatchMedia, settle, standInServer } from './cov-helpers';

polyfillMatchMedia();
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let back: typeof import('../../src/lib/backLayers');
let store: typeof import('../../src/lib/store');
const realMatchMedia = window.matchMedia;

async function load(address = '/', state: unknown = null) {
  history.replaceState(state, '', address);
  vi.resetModules();
  back = await import('../../src/lib/backLayers');
  store = await import('../../src/lib/store');
}

const app = () => store.useApp.getState();
const where = () => location.pathname + location.search + location.hash;
const onPhone = () => {
  window.matchMedia = ((q: string) => ({ matches: q.includes('max-width: 759px'), media: q, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
};
const encrypted = () => store.useApp.setState({ encryption: { on: true, pending: 0, rekey: 0, attachments: 0 } });

/** Back, and once it has arrived. */
async function goBack(until: () => void) {
  history.back();
  await vi.waitFor(until);
  await settle(5);
}

beforeEach(async () => {
  vi.stubGlobal('BroadcastChannel', undefined);
  localStorage.clear();
  sessionStorage.clear();
  standInServer();
  await load();
});

afterEach(async () => {
  window.matchMedia = realMatchMedia;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await settle(5);
});

describe('things open over a page', () => {
  it('Back closes the newest, then the next, and leaves the page as it was', async () => {
    const closed: string[] = [];
    const pageChanged = vi.fn();
    back.onPageChange(pageChanged);
    back.pushLayer(() => closed.push('settings'));
    back.pushLayer(() => closed.push('question'));
    expect(history.state).toMatchObject({ kb: true, depth: 2 });
    await goBack(() => expect(closed).toEqual(['question']));
    await goBack(() => expect(closed).toEqual(['question', 'settings']));
    expect(where()).toBe('/');
    expect(history.state.layer).toBeUndefined();
    expect(pageChanged).toHaveBeenCalledTimes(2);
    expect(app().noteId).toBeNull();
  });

  it('closed some other way, its step comes off, so Back has none left that do nothing', async () => {
    const pageChanged = vi.fn();
    back.onPageChange(pageChanged);
    const close = vi.fn();
    const release = back.pushLayer(close);
    expect(back.layerOf(history.state)).toBeGreaterThan(0);
    release();
    await vi.waitFor(() => expect(back.layerOf(history.state)).toBe(0));
    await settle(5);
    expect(close).not.toHaveBeenCalled();
    // Taking its own step off isn't Back to another page.
    expect(pageChanged).not.toHaveBeenCalled();
    release();
    await settle(5);
    expect(back.layerOf(history.state)).toBe(0);
  });

  it('opened while a step is coming off, it waits its turn, and isn’t closed by that step', async () => {
    const closed: string[] = [];
    const closeMenu = back.pushLayer(() => closed.push('menu'));
    const menuStep = back.layerOf(history.state);
    closeMenu();
    back.pushLayer(() => closed.push('dialog'));
    // Still the menu's step: the dialog's comes once that's off.
    expect(back.layerOf(history.state)).toBe(menuStep);
    await vi.waitFor(() => expect(back.layerOf(history.state)).toBeGreaterThan(menuStep));
    expect(history.state).toMatchObject({ depth: 1 });
    await settle(5);
    expect(closed).toEqual([]);
    await goBack(() => expect(closed).toEqual(['dialog']));
  });

  it('going to another page takes their steps off first: Back from it goes to the page before', async () => {
    store.openNote('n1');
    const closed = vi.fn();
    back.pushLayer(closed);
    back.pushLayer(closed);
    store.openNote('n2');
    expect(app().noteId).toBe('n2');
    await vi.waitFor(() => expect(where()).toBe('/note/n2'));
    expect(closed).toHaveBeenCalledTimes(2);
    expect(history.state.depth).toBeUndefined();
    await goBack(() => expect(app().noteId).toBe('n1'));
    expect(where()).toBe('/note/n1');
  });

  it('a step that never arrives holds nothing up for long', async () => {
    back.pushLayer(() => undefined);
    vi.spyOn(history, 'go').mockImplementation(() => undefined);
    store.openNote('n3');
    expect(app().noteId).toBe('n3');
    await vi.waitFor(() => expect(where()).toBe('/note/n3'), { timeout: 3000 });
  });

  it('one that stays open when asked to close puts its step back; gone, it takes it off', async () => {
    const asked = vi.fn();
    const Thing = () => {
      back.useBackLayer(true, asked);
      return null;
    };
    const root = createRoot(document.createElement('div'));
    await act(async () => root.render(createElement(Thing)));
    await vi.waitFor(() => expect(back.layerOf(history.state)).toBeGreaterThan(0));
    const first = back.layerOf(history.state);
    await goBack(() => expect(asked).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(back.layerOf(history.state)).toBeGreaterThan(first));
    await act(async () => root.unmount());
    await vi.waitFor(() => expect(back.layerOf(history.state)).toBe(0));
  });
});

describe('Lumen’s pages', () => {
  it('each has its own address and step, and Back goes back through them', async () => {
    store.showNotes();
    expect(where()).toBe('/notes');
    expect(app().mobileTab).toBe('notes');
    store.setFilter({ kind: 'folder', id: 'f1' });
    expect(where()).toBe('/notes?folder=f1');
    store.openNote('n1', { hash: '#h-intro' });
    expect(where()).toBe('/note/n1?folder=f1#h-intro');
    store.openTasks();
    expect(where()).toBe('/tasks?folder=f1');

    await goBack(() => expect(app().noteId).toBe('n1'));
    expect(app().anchor).toBe('h-intro');
    await goBack(() => expect(app().noteId).toBeNull());
    expect(app()).toMatchObject({ mobileTab: 'notes', screen: 'home', filter: { kind: 'folder', id: 'f1' } });
    await goBack(() => expect(app().filter).toEqual({ kind: 'all' }));
    expect(where()).toBe('/notes');
    await goBack(() => expect(app().mobileTab).toBe('home'));
    expect(where()).toBe('/');
  });

  it('puts a tag and a search in the address; typing is one step, and Back brings both back', async () => {
    store.setFilter({ kind: 'tag', tag: 'work/q1' });
    expect(location.search).toBe('?tag=work%2Fq1');
    store.setFilter({ kind: 'pinned' });
    expect(location.search).toBe('?view=pinned');
    store.setFilter({ kind: 'trash' });
    expect(location.search).toBe('?view=trash');
    store.setFilter({ kind: 'tag', tag: 'work/q1' });
    const steps = history.length;
    store.setListQuery('bud');
    store.setListQuery('budget plan');
    await vi.waitFor(() => expect(new URLSearchParams(location.search).get('q')).toBe('budget plan'));
    expect(history.length).toBe(steps);
    store.openNote('n1');
    expect(new URLSearchParams(location.search).get('q')).toBe('budget plan');
    await goBack(() => expect(app().noteId).toBeNull());
    expect(app()).toMatchObject({ filter: { kind: 'tag', tag: 'work/q1' }, listQuery: 'budget plan' });
  });

  it('keeps a search typed just before something opened over the page, for Back to bring back', async () => {
    store.setListQuery('quick');
    back.pushLayer(() => undefined);
    // The address would follow the typing a moment later: the menu is open by then.
    await new Promise((r) => setTimeout(r, 450));
    store.openNote('n1');
    // The list keeps its search beside the note.
    await vi.waitFor(() => expect(where()).toBe('/note/n1?q=quick'));
    await goBack(() => expect(app().noteId).toBeNull());
    expect(app().listQuery).toBe('quick');
    expect(where()).toBe('/?q=quick');
  });

  it('picking another view clears the search, so the list shows what was picked', async () => {
    store.setListQuery('budget');
    store.setFilter({ kind: 'pinned' });
    expect(app().listQuery).toBe('');
    store.setListQuery('budget');
    store.useApp.setState({ filter: { kind: 'trash' } });
    expect(app().listQuery).toBe('');
  });

  it('with encryption on, keeps tag names and searches out of the address and history, and still brings them back', async () => {
    store.setFilter({ kind: 'tag', tag: 'health' });
    expect(location.search).toBe('?tag=health');
    encrypted();
    // Found on: the current address loses the tag at once.
    expect(location.search).toBe('');
    store.setFilter({ kind: 'tag', tag: 'diagnosis' });
    store.setListQuery('biopsy results');
    await new Promise((r) => setTimeout(r, 450));
    store.openNote('n1');
    expect(where()).toBe('/note/n1');
    expect(JSON.stringify(history.state)).not.toMatch(/diagnosis|biopsy/);
    await goBack(() => expect(app().noteId).toBeNull());
    expect(where()).toBe('/notes');
    expect(JSON.stringify(history.state)).not.toMatch(/diagnosis|biopsy/);
    expect(app()).toMatchObject({ filter: { kind: 'tag', tag: 'diagnosis' }, listQuery: 'biopsy results' });
    // A folder's id says nothing, so it stays.
    store.setFilter({ kind: 'folder', id: 'f9' });
    expect(location.search).toBe('?folder=f9');
  });

  it('a renamed tag or deleted folder corrects the step it was on, without adding one', async () => {
    store.setFilter({ kind: 'tag', tag: 'old' });
    const steps = history.length;
    store.setFilter({ kind: 'tag', tag: 'new' }, { replace: true });
    expect(location.search).toBe('?tag=new');
    expect(history.length).toBe(steps);
  });

  it('opened at an address, shows that page', async () => {
    await load('/notes?tag=work&q=plan');
    expect(app()).toMatchObject({ mobileTab: 'notes', screen: 'home', noteId: null, filter: { kind: 'tag', tag: 'work' }, listQuery: 'plan' });
    await load('/tasks?view=pinned');
    expect(app()).toMatchObject({ screen: 'tasks', filter: { kind: 'pinned' } });
    await load('/note/abc?folder=f2#h-end');
    expect(app()).toMatchObject({ noteId: 'abc', anchor: 'h-end', filter: { kind: 'folder', id: 'f2' } });
    await load('/notes?search=ss1');
    expect(app().filter).toEqual({ kind: 'search', id: 'ss1' });
    // Not a folder or saved search id: ignored.
    await load('/?folder=../x');
    expect(app().filter).toEqual({ kind: 'all' });
    await load('/?search=a%20b');
    expect(app().filter).toEqual({ kind: 'all' });
  });

  it('on a phone, opened straight at a note, puts Home beneath it so Back goes there before leaving', async () => {
    onPhone();
    await load('/note/n9');
    expect(where()).toBe('/note/n9');
    expect(history.state.kb).toBe(true);
    await goBack(() => expect(app().noteId).toBeNull());
    expect(where()).toBe('/');
    expect(history.state.kb).toBe(false);
  });

  it('on a phone, a view picked from Tasks shows the list in its place', async () => {
    onPhone();
    store.openTasks();
    store.setFilter({ kind: 'pinned' });
    expect(app()).toMatchObject({ screen: 'home', mobileTab: 'notes' });
    expect(where()).toBe('/notes?view=pinned');
  });

  it('opened to do something (?do=new), leaves the address for that to take', async () => {
    onPhone();
    await load('/?do=new');
    expect(where()).toBe('/?do=new');
  });
});

describe('the tab’s title', () => {
  it('names the page, and the note or list by name, unless encryption is on', async () => {
    store.upsertMeta({ id: 'n1', title: 'Groceries', folder_id: null, excerpt: '', tags: [], pinned: false, version: 1, created_at: NOW, updated_at: NOW } as never);
    store.useApp.setState({ folders: [{ id: 'f1', name: 'Recipes', parent_id: null, sort: 0, created_at: NOW, updated_at: NOW }] as never });
    expect(document.title).toBe('Lumen');
    store.openTasks();
    expect(document.title).toBe('Tasks – Lumen');
    store.showNotes();
    expect(document.title).toBe('All notes – Lumen');
    store.setFilter({ kind: 'folder', id: 'f1' });
    expect(document.title).toBe('Recipes – Lumen');
    store.setFilter({ kind: 'tag', tag: 'work' });
    expect(document.title).toBe('#work – Lumen');
    const { useSettings } = await import('../../src/lib/settings');
    useSettings.setState({ savedSearches: [{ id: 'ss1', name: 'Open tasks', query: 'has:task' }] });
    store.setFilter({ kind: 'search', id: 'ss1' });
    expect(document.title).toBe('Open tasks – Lumen');
    expect(location.search).toBe('?search=ss1');
    store.setFilter({ kind: 'tag', tag: 'work' });
    store.openNote('n1');
    expect(document.title).toBe('Groceries – Lumen');
    store.openNote('missing');
    expect(document.title).toBe('Lumen');
    encrypted();
    expect(document.title).toBe('Note – Lumen');
    store.openNote(null);
    expect(document.title).toBe('Tag – Lumen');
    store.setFilter({ kind: 'folder', id: 'f1' });
    expect(document.title).toBe('Folder – Lumen');
    store.setFilter({ kind: 'search', id: 'ss1' });
    expect(document.title).toBe('Saved search – Lumen');
    expect(location.search).toBe('?search=ss1');
    store.goHome();
    expect(document.title).toBe('Lumen');
  });
});
