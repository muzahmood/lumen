// @vitest-environment jsdom
/**
 * The app shell (src/App.tsx): what shows while the device checks its key, while the library is locked,
 * when it didn't load, and once it has (sidebar, list, and Home, a note or Tasks); the README's
 * keyboard shortcuts (Ctrl/⌘ K, Ctrl/⌘ \, Ctrl/⌘ ,, Alt N, Esc); the offline and signed-out banners;
 * focus mode; the phone layout's bottom tab bar and drawer; the pane resizers; and a dialog that fails
 * to open. The library is encrypted and unlocked, as the owner keeps it; the note view and the big
 * dialogs are stand-ins here (they have tests of their own).
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/components/NoteView', () => ({
  NoteView: ({ noteId }: { noteId: string }) => (
    <section className="note-pane" aria-label="Note">
      Note {noteId}
    </section>
  ),
}));
vi.mock('../../src/components/HistoryDialog', () => ({ HistoryDialog: () => <div role="dialog" aria-label="Version history" /> }));
vi.mock('../../src/components/DrawingEditor', () => ({ default: () => <div role="dialog" aria-label="Drawing editor" /> }));
let settingsFails = false;
vi.mock('../../src/components/SettingsDialog', () => ({
  SettingsDialog: () => {
    if (settingsFails) throw new Error('Settings broke');
    return <div role="dialog" aria-label="Settings" />;
  },
}));
vi.mock('../../src/lib/vault', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../src/lib/vault')>();
  // The device's key is the test's (see boot): the vault's state is set by each test.
  return { ...mod, initVault: vi.fn(async () => mod.useVault.getState().state), noticeEncryption: vi.fn() };
});

import {
  allByRole,
  boot,
  byRole,
  click,
  press,
  queryByRole,
  queryByText,
  render,
  seedNote,
  server,
  setApp,
  setSettings,
  settle,
  teardown,
  textOf,
  toasts,
  until,
  type Booted,
} from './ui-shell-helpers';

let h: Booted;
let App: typeof import('../../src/App').App;
let vault: typeof import('../../src/lib/vault');

async function start(opts: { phone?: boolean; vault?: 'checking' | 'off' | 'locked' | 'unlocked' } = {}) {
  h = await boot({ phone: opts.phone, status: 'loading' });
  vault = await import('../../src/lib/vault');
  vault.useVault.setState({ state: opts.vault ?? 'unlocked' });
  ({ App } = await import('../../src/App'));
}

beforeEach(async () => {
  settingsFails = false;
  await start();
});
afterEach(teardown);

const state = () => h.store.useApp.getState();
const app = () => document.querySelector<HTMLElement>('.app');
const main = () => document.querySelector<HTMLElement>('main.main-slot');
const tabbar = () => queryByRole('navigation', 'Sections');
const tab = (name: string) => {
  const t = allByRole('button', undefined, tabbar()!).find((b) => (b.getAttribute('aria-label') ?? textOf(b)).startsWith(name));
  if (!t) throw new Error(`No tab ${name}`);
  return t;
};

/** Renders the app and waits for the library to load from the server. */
async function show() {
  const r = await render(<App />);
  await settle(30);
  return r;
}

describe('before the library is shown', () => {
  it('shows only a spinner while the device checks for its key', async () => {
    await teardown();
    await start({ vault: 'checking' });
    await seedNote('a', { title: 'Secret plans' });
    await render(<App />);
    expect(byRole('progressbar', 'Opening Lumen')).toBeTruthy();
    expect(queryByText(/Secret plans/)).toBeNull();
    expect(server.requests('GET', '/api/bootstrap')).toHaveLength(0);
  });

  it('shows the unlock screen while the library is locked, and nothing of the notes', async () => {
    await teardown();
    await start({ vault: 'locked' });
    await seedNote('a', { title: 'Secret plans', tags: ['private'] });
    await render(<App />);
    await settle();
    expect(byRole('heading', 'Unlock your notes')).toBeTruthy();
    expect(queryByRole('navigation', 'Library')).toBeNull();
    expect(textOf(document.body)).not.toMatch(/Secret plans|private/);
    expect(server.requests('GET', '/api/bootstrap')).toHaveLength(0);
  });

  it('loads the library once unlocked, its titles decrypted here', async () => {
    await teardown();
    await start({ vault: 'locked' });
    await seedNote('a', { title: 'Secret plans' });
    // The note list as this device starts: empty, until loaded.
    await setApp({ notes: {} });
    await render(<App />);
    await (await import('react')).act(async () => vault.useVault.setState({ state: 'unlocked' }));
    await settle(30);
    expect(server.rows.get('a')!.title).toBe('');
    expect(textOf(document.querySelector('.list-pane'))).toContain('Secret plans');
  });

  it('says the notes didn’t load, with why and Try again', async () => {
    server.intercept = (req) => (req.path === '/api/bootstrap' ? new Response(JSON.stringify({ error: 'internal', message: 'The database is busy.' }), { status: 500, headers: { 'content-type': 'application/json' } }) : undefined);
    await show();
    expect(byRole('heading', 'Your notes didn’t load')).toBeTruthy();
    expect(queryByText('The database is busy.')).not.toBeNull();
    expect(byRole('button', 'Try again')).toBeTruthy();
  });

  it('asks to sign in again when the Access session has ended', async () => {
    await show();
    await setApp({ status: 'error', authExpired: true, loadError: 'whatever' });
    expect(byRole('heading', 'Your session has ended')).toBeTruthy();
    expect(byRole('button', 'Sign in again')).toBeTruthy();
  });

  it('encrypts what’s left unencrypted before showing the library', async () => {
    await show();
    await setApp({ encryption: { on: true, pending: 3, rekey: 0, attachments: 0 } });
    expect(queryByRole('navigation', 'Library')).toBeNull();
    expect(allByRole('heading').length).toBeGreaterThan(0);
  });
});

describe('the library', () => {
  it('shows the sidebar, the note list and Home, with the library loaded from the server', async () => {
    await seedNote('a', { title: 'Plan' });
    await setApp({ notes: {} });
    await show();
    expect(state().status).toBe('ready');
    expect(byRole('navigation', 'Library')).toBeTruthy();
    expect(byRole('region', 'All notes')).toBeTruthy();
    expect(main()!.querySelector('[aria-label="Home"]')).not.toBeNull();
    expect(textOf(document.querySelector('.list-pane'))).toContain('Plan');
  });

  it('opens a new, empty library with the guide note', async () => {
    await setApp({ notes: {} });
    await show();
    const notes = Object.values(state().notes);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ pinned: true, tags: ['guide'] });
    expect(server.requests('POST', '/api/notes')[0].body!.enc).toBe(true);
  });

  it('shows the open note in the main pane, and Tasks at /tasks', async () => {
    await seedNote('a', { title: 'Plan' });
    await show();
    h.store.openNote('a');
    await settle();
    await until(() => expect(textOf(main())).toBe('Note a'));
    expect(app()!.classList.contains('has-note')).toBe(true);
    h.store.openTasks();
    await settle();
    expect(main()!.querySelector('[aria-label="Tasks"]')).not.toBeNull();
    h.store.goHome();
    await settle();
    expect(main()!.querySelector('[aria-label="Home"]')).not.toBeNull();
  });

  it('follows the browser’s Back and Forward between notes', async () => {
    await seedNote('a', { title: 'Plan' });
    await seedNote('b', { title: 'Other' });
    await show();
    h.store.openNote('a');
    h.store.openNote('b');
    await settle();
    await (await import('react')).act(async () => {
      window.history.replaceState({ kb: true }, '', '/note/a');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    await until(() => expect(textOf(main())).toBe('Note a'));
  });

  it('applies the theme and accent to the page', async () => {
    await show();
    await setSettings({ theme: 'dark', accent: 'green' });
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(document.documentElement.style.getPropertyValue('--accent')).toBe('#62BF97');
    await setSettings({ theme: 'light' });
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(document.documentElement.style.getPropertyValue('--accent')).toBe('#1F6B50');
  });
});

describe('keyboard shortcuts from the README', () => {
  // A library with a note in it (an empty one gets the guide note made on load).
  beforeEach(() => seedNote('a', { title: 'Plan' }));

  it('opens and closes the switcher with Ctrl/⌘ K, but not with Shift', async () => {
    await show();
    const ev = await press('k', { ctrlKey: true }, document.body);
    expect(ev.defaultPrevented).toBe(true);
    expect(state().paletteOpen).toBe(true);
    expect(byRole('dialog', 'Search and commands')).toBeTruthy();
    await press('K', { metaKey: true }, document.body);
    expect(state().paletteOpen).toBe(false);
    await press('K', { ctrlKey: true, shiftKey: true }, document.body);
    expect(state().paletteOpen).toBe(false);
  });

  it('shows and hides the sidebar with Ctrl/⌘ \\', async () => {
    await show();
    await press('\\', { ctrlKey: true }, document.body);
    expect(h.settings.useSettings.getState().sidebarCollapsed).toBe(true);
    expect(app()!.classList.contains('sidebar-collapsed')).toBe(true);
    await press('\\', { metaKey: true }, document.body);
    expect(app()!.classList.contains('sidebar-collapsed')).toBe(false);
  });

  it('leaves the keyboard to a dialog that’s open: no switcher under it, no note behind it, no sidebar change', async () => {
    await show();
    await press(',', { ctrlKey: true }, document.body);
    await settle();
    expect(byRole('dialog', 'Settings')).toBeTruthy();
    const ev = await press('k', { ctrlKey: true }, document.activeElement ?? document.body);
    expect(ev.defaultPrevented).toBe(false);
    expect(state().paletteOpen).toBe(false);
    await press('\\', { ctrlKey: true }, document.activeElement ?? document.body);
    expect(h.settings.useSettings.getState().sidebarCollapsed).toBe(false);
    const notesBefore = Object.keys(state().notes).length;
    await press('n', { altKey: true }, document.activeElement ?? document.body);
    await settle();
    expect(Object.keys(state().notes)).toHaveLength(notesBefore);
  });

  it('lets AltGr type a backslash (Windows reports it as Ctrl Alt), in a text field and anywhere else', async () => {
    await show();
    // A German, French or Nordic keyboard: AltGr ß, AltGr 8 or AltGr + types \ (LaTeX, paths, the passphrase).
    const field = document.createElement('input');
    document.body.append(field);
    for (const target of [field, document.body]) {
      const ev = await press('\\', { ctrlKey: true, altKey: true }, target);
      expect(ev.defaultPrevented).toBe(false);
      expect(h.settings.useSettings.getState().sidebarCollapsed).toBe(false);
    }
    // Nor do AltGr letters that happen to match the other shortcuts.
    expect((await press('k', { ctrlKey: true, altKey: true }, field)).defaultPrevented).toBe(false);
    expect(state().paletteOpen).toBe(false);
    field.remove();
  });

  it('opens Settings with Ctrl/⌘ ,', async () => {
    await show();
    await press(',', { ctrlKey: true }, document.body);
    await settle();
    expect(byRole('dialog', 'Settings')).toBeTruthy();
  });

  it('makes a new note with Alt N, also where Alt N types a letter (⌥N on a Mac)', async () => {
    await show();
    await press('n', { altKey: true }, document.body);
    await settle();
    expect(server.requests('POST', '/api/notes')).toHaveLength(1);
    await press('˜', { altKey: true, code: 'KeyN' }, document.body);
    await settle();
    expect(server.requests('POST', '/api/notes')).toHaveLength(2);
    // Ctrl Alt N isn't Alt N.
    await press('n', { altKey: true, ctrlKey: true }, document.body);
    await settle();
    expect(server.requests('POST', '/api/notes')).toHaveLength(2);
  });

  it('lets ⌥N type its letter in a text field on a Mac keyboard where it makes one', async () => {
    await show();
    const field = document.createElement('textarea');
    document.body.appendChild(field);
    field.focus();
    const polish = await press('ń', { altKey: true, code: 'KeyN' }, field);
    const spanish = await press('Dead', { altKey: true, code: 'KeyN' }, field);
    await settle();
    expect(polish.defaultPrevented).toBe(false);
    expect(spanish.defaultPrevented).toBe(false);
    expect(server.requests('POST', '/api/notes')).toHaveLength(0);
  });

  it('closes the drawer with Esc, then leaves focus mode', async () => {
    await show();
    await setApp({ drawerOpen: true, focusMode: true });
    await press('Escape', {}, document.body);
    expect(state()).toMatchObject({ drawerOpen: false, focusMode: true });
    await press('Escape', {}, document.body);
    expect(state().focusMode).toBe(false);
  });

  it('leaves Esc to whatever is open on top (a dialog, the switcher) or already used it', async () => {
    await show();
    await setApp({ drawerOpen: true, paletteOpen: true });
    await press('Escape', {}, document.body);
    expect(state().drawerOpen).toBe(true);
    await setApp({ paletteOpen: false });
    const used = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    used.preventDefault();
    await (await import('react')).act(async () => void document.body.dispatchEvent(used));
    expect(state().drawerOpen).toBe(true);
  });

  it('ignores every shortcut while the drawing editor is open', async () => {
    await show();
    await setApp({ drawing: { drawingId: null, noteId: null, resolve: () => undefined } });
    await press('k', { ctrlKey: true }, document.body);
    await press('n', { altKey: true }, document.body);
    await settle();
    expect(state().paletteOpen).toBe(false);
    expect(server.requests('POST', '/api/notes')).toHaveLength(0);
  });
});

describe('banners and focus mode', () => {
  it('says when the device is offline, as a status', async () => {
    await show();
    expect(queryByText(/You’re offline/)).toBeNull();
    await setApp({ online: false });
    const banner = byRole('status', /You’re offline/);
    expect(textOf(banner)).toBe('You’re offline. Edits are saved here and sync when you reconnect.');
  });

  it('says when the Access session ended, as an alert, instead of the offline banner', async () => {
    await show();
    await setApp({ online: false, authExpired: true });
    expect(textOf(byRole('alert'))).toContain('Your Cloudflare Access session ended. Edits are kept on this device.');
    expect(queryByText(/You’re offline/)).toBeNull();
    expect(byRole('button', 'Sign in again')).toBeTruthy();
  });

  it('shows the way out of focus mode', async () => {
    await show();
    await setApp({ focusMode: true });
    expect(app()!.classList.contains('focus-mode')).toBe(true);
    await click(byRole('button', 'Exit focus'));
    expect(state().focusMode).toBe(false);
  });
});

describe('on a phone', () => {
  beforeEach(async () => {
    await teardown();
    await start({ phone: true });
  });

  it('has a tab bar of sections, gone while a note is open', async () => {
    await seedNote('a');
    await show();
    expect(allByRole('button', undefined, tabbar()!).map((b) => b.getAttribute('aria-label') ?? textOf(b))).toEqual([
      'Home',
      'Notes',
      'New note',
      'Search',
      'Library',
    ]);
    h.store.openNote('a');
    await settle();
    expect(tabbar()).toBeNull();
  });

  it('moves between Home and Notes, and opens the switcher and the library drawer', async () => {
    await show();
    expect(app()!.classList.contains('mobile-home')).toBe(true);
    expect(tab('Home').classList.contains('is-active')).toBe(true);
    await click(tab('Notes'));
    expect(app()!.classList.contains('mobile-notes')).toBe(true);
    expect(tab('Notes').classList.contains('is-active')).toBe(true);
    await click(tab('Search'));
    expect(state().paletteOpen).toBe(true);
    await setApp({ paletteOpen: false });
    await click(tab('Library'));
    expect(app()!.classList.contains('drawer-open')).toBe(true);
    expect(tab('Library').classList.contains('is-active')).toBe(true);
    // A tap outside the drawer closes it.
    await click(document.querySelector('.scrim'));
    expect(state().drawerOpen).toBe(false);
    await click(tab('Home'));
    expect(app()!.classList.contains('mobile-home')).toBe(true);
  });

  it('tells screen readers which section is showing', async () => {
    await show();
    await click(tab('Notes'));
    expect(tab('Notes').getAttribute('aria-current')).toBe('page');
    expect(tab('Home').getAttribute('aria-current')).toBeNull();
  });

  it('makes a new note from the tab bar', async () => {
    await show();
    await click(tab('New note'));
    await settle();
    expect(state().noteId).toBe(server.requests('POST', '/api/notes').at(-1)!.body!.id);
  });

  it('says on the Library tab how many notes haven’t synced', async () => {
    await seedNote('a', { title: 'Shopping' });
    await show();
    expect(tab('Library').getAttribute('aria-label')).toBeNull();
    server.intercept = (req) => (req.method === 'PATCH' ? Promise.reject(new TypeError('Failed to fetch')) : undefined);
    h.saver.edit('a', { content: 'milk' }, 1);
    await h.saver.flush('a');
    await settle();
    expect(tab('Library').getAttribute('aria-label')).toBe('Library, 1 note not synced');
    expect(tab('Library').querySelector('.tab-dot')).not.toBeNull();
  });

  it('opens Tasks with a way back Home', async () => {
    await show();
    h.store.openTasks();
    await settle();
    await click(byRole('button', 'Back'));
    expect(state().screen).toBe('home');
  });
});

describe('the pane resizers', () => {
  const sidebarResizer = () => byRole('separator', 'Resize sidebar');

  it('are labelled separators that say their width and limits', async () => {
    await show();
    const r = sidebarResizer();
    expect(r.getAttribute('aria-orientation')).toBe('vertical');
    expect([r.getAttribute('aria-valuemin'), r.getAttribute('aria-valuemax'), r.getAttribute('aria-valuenow')]).toEqual(['200', '360', '252']);
    expect(r.tabIndex).toBe(0);
    expect(byRole('separator', 'Resize note list').getAttribute('aria-valuenow')).toBe('336');
  });

  it('widen and narrow with the arrow keys, within their limits, and reset on a double-click', async () => {
    await show();
    await press('ArrowRight', {}, sidebarResizer());
    expect(h.settings.useSettings.getState().sidebarWidth).toBe(268);
    expect(sidebarResizer().getAttribute('aria-valuenow')).toBe('268');
    expect(document.documentElement.style.getPropertyValue('--sidebar-w')).toBe('268px');
    for (let i = 0; i < 20; i++) await press('ArrowRight', {}, sidebarResizer());
    expect(h.settings.useSettings.getState().sidebarWidth).toBe(360);
    for (let i = 0; i < 20; i++) await press('ArrowLeft', {}, sidebarResizer());
    expect(h.settings.useSettings.getState().sidebarWidth).toBe(200);
    await (await import('react')).act(async () => void sidebarResizer().dispatchEvent(new MouseEvent('dblclick', { bubbles: true })));
    expect(h.settings.useSettings.getState().sidebarWidth).toBe(252);
  });
});

describe('a dialog that fails to open', () => {
  it('closes itself and says so, with Reload, leaving the rest of the app working', async () => {
    settingsFails = true;
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await show();
    await setApp({ settingsOpen: true });
    await settle();
    expect(state().settingsOpen).toBe(false);
    expect(toasts(h.store).at(-1)).toBe('Settings couldn’t open. Reloading usually fixes it; your edits are kept on this device.');
    expect(state().toasts.at(-1)!.action!.label).toBe('Reload');
    expect(byRole('navigation', 'Library')).toBeTruthy();
    // It opens again once it works.
    settingsFails = false;
    await setApp({ settingsOpen: true });
    await settle();
    expect(byRole('dialog', 'Settings')).toBeTruthy();
    vi.restoreAllMocks();
  });
});
