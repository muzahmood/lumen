/**
 * How the journeys drive Lumen: by the roles and labels people (and screen readers) use, through the
 * real built app and API. A few things have no role or name of their own (the save indicator, the note
 * list, a folder's row, the reading view) and are found by their class.
 */
import fs from 'node:fs';
import path from 'node:path';
import { expect, type Locator, type Page } from '@playwright/test';

export const PASSPHRASE = 'lumen e2e passphrase one';

/* ------------------------------------------------------------ regions --- */

export const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Library' });
export const noteTitle = (page: Page) => page.getByRole('textbox', { name: 'Note title' });
export const noteText = (page: Page) => page.getByRole('textbox', { name: 'Note text' });
/** The note list (its accessible name is the list's heading, e.g. "All notes"). */
export const noteList = (page: Page) => page.locator('section.list-pane');
export const listSearch = (page: Page) => noteList(page).getByRole('searchbox');
/** The note header's save indicator (no role of its own beyond status; its class says the state). */
export const saveState = (page: Page) => page.locator('.note-header .save-state');
export const toasts = (page: Page) => page.locator('.toasts');
export const dialog = (page: Page, name?: string | RegExp) => page.getByRole('dialog', name ? { name } : undefined);
export const menu = (page: Page) => page.getByRole('menu');
/** An item of the open menu, whether a plain item or one that shows a tick (a folder to move to, a sort order). */
export function menuItem(page: Page, name: string | RegExp): Locator {
  const m = menu(page);
  return m.getByRole('menuitem', { name }).or(m.getByRole('menuitemcheckbox', { name })).or(m.getByRole('menuitemradio', { name }));
}
/** The phone layout's bottom tab bar. */
export const tabBar = (page: Page) => page.getByRole('navigation', { name: 'Sections' });

/* ------------------------------------------------------------ opening --- */

/** Opens Lumen and waits until it's either showing the notes or asking to be unlocked. */
export async function openApp(page: Page, url = '/'): Promise<'ready' | 'locked'> {
  await page.goto(url);
  const unlock = page.getByRole('heading', { name: 'Unlock your notes' });
  await expect(unlock.or(appShell(page)).first()).toBeVisible({ timeout: 30_000 });
  if (await unlock.isVisible()) return 'locked';
  await waitLoaded(page);
  return 'ready';
}

/** The app's frame: the sidebar on wide screens, the bottom tab bar on a phone (its sidebar is a drawer). */
export const appShell = (page: Page) => sidebar(page).or(tabBar(page));

/** The note list has loaded (no skeleton rows left). */
export async function waitLoaded(page: Page) {
  await expect(appShell(page).first()).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('.list-skeleton')).toHaveCount(0, { timeout: 30_000 });
}

export async function unlock(page: Page, passphrase: string) {
  await expect(page.getByRole('heading', { name: 'Unlock your notes' })).toBeVisible();
  await page.getByRole('textbox', { name: 'Passphrase' }).fill(passphrase);
  await page.getByRole('button', { name: 'Unlock', exact: true }).click();
  await waitLoaded(page);
}

/* -------------------------------------------------------------- notes --- */

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** A note's row in the note list, by its whole title (or a pattern). */
export function listRow(page: Page, title: string | RegExp): Locator {
  const text = typeof title === 'string' ? new RegExp(`^${escapeRe(title)}$`) : title;
  return noteList(page).getByRole('link').filter({ has: page.locator('.row-title', { hasText: text }) });
}

export async function expectSaved(page: Page, timeout = 15_000) {
  await expect(saveState(page)).toHaveClass(/is-saved/, { timeout });
}

/** Puts the cursor at the end of the note's text. */
export async function focusEnd(page: Page) {
  await noteText(page).click();
  await page.keyboard.press('Control+End');
}

/**
 * Types into the note's text at the cursor. insertText goes in as one input (like a paste of plain
 * text), so the editor's own typing helpers (closing brackets, list continuation) don't add to it.
 */
export async function typeText(page: Page, text: string) {
  await page.keyboard.insertText(text);
}

/** A new note from the sidebar's New note button, with a title and text; waits until it's saved. */
export async function createNote(page: Page, title: string, text = ''): Promise<string> {
  await sidebar(page).getByRole('button', { name: 'New note', exact: true }).click();
  await expect(noteTitle(page)).toBeFocused();
  await noteTitle(page).fill(title);
  if (text) {
    await noteTitle(page).press('Enter');
    await expect(noteText(page)).toBeFocused();
    await typeText(page, text);
  }
  await expectSaved(page);
  return currentNoteId(page);
}

export function currentNoteId(page: Page): string {
  const m = /\/note\/([A-Za-z0-9_-]+)/.exec(page.url());
  if (!m) throw new Error(`Not on a note: ${page.url()}`);
  return m[1];
}

export async function setMode(page: Page, mode: 'Edit' | 'Split' | 'Read') {
  const radio = page.getByRole('radiogroup', { name: 'View' }).getByRole('radio', { name: mode });
  await radio.click();
  await expect(radio).toHaveAttribute('aria-checked', 'true');
}

/** The note's rendered text (reading view), for checking what a note says without Markdown symbols. */
export function preview(page: Page): Locator {
  return page.locator('.note-pane .kb-prose').first();
}

/* ----------------------------------------------------------- folders --- */

/** A folder's row in the sidebar (its button's name also holds its note count and expand toggle). */
export function folderRow(page: Page, name: string) {
  return sidebar(page)
    .getByRole('region', { name: 'Folders' })
    .locator('.nav-row')
    .filter({ has: page.locator('.nav-label').getByText(name, { exact: true }) });
}
export const folderItem = (page: Page, name: string) => folderRow(page, name).locator('button.nav-item');

export async function newFolder(page: Page, name: string, parent?: string) {
  if (parent) {
    const row = folderRow(page, parent);
    await row.hover();
    await row.getByRole('button', { name: `${parent} options` }).click();
    await menuItem(page, 'New subfolder').click();
  } else {
    await sidebar(page).getByRole('button', { name: 'New folder' }).click();
  }
  const ask = dialog(page, parent ? 'New subfolder' : 'New folder');
  await ask.getByRole('textbox', { name: 'Folder name' }).fill(name);
  await ask.getByRole('button', { name: 'Create folder' }).click();
  await expect(ask).toBeHidden();
  await expect(folderItem(page, name)).toBeVisible();
}

/* ------------------------------------------------------------ the API --- */

/** What the server hands this page as the library: the raw /api/bootstrap JSON, straight from the server. */
export async function bootstrap(page: Page): Promise<{
  notes: Array<Record<string, unknown> & { id: string; title: string; excerpt: string; tags: unknown; enc?: boolean }>;
  folders: Array<Record<string, unknown> & { id: string; name: string }>;
  encryption?: { on: boolean };
}> {
  return page.evaluate(async () => {
    const res = await fetch(`/api/bootstrap?fresh=${Date.now()}`, { headers: { 'x-kb-client': '1' } });
    return res.json();
  });
}

/** One note as the server stores it (/api/notes/:id), bypassing the service worker's copy. */
export async function rawNote(page: Page, id: string): Promise<Record<string, unknown> & { title: string; content: string; version: number }> {
  return page.evaluate(async (noteId) => {
    const res = await fetch(`/api/notes/${noteId}?fresh=${Date.now()}`, { headers: { 'x-kb-client': '1' } });
    return res.json();
  }, id);
}

/* ---------------------------------------------------------- settings --- */

export async function openSettings(page: Page, section: 'General' | 'Appearance' | 'Editor' | 'Data and backup' | 'Security' | 'Shortcuts') {
  // On a phone the sidebar is a drawer, opened from the tab bar's Library.
  if (!(await sidebar(page).isVisible()) && (await tabBar(page).isVisible())) await tabBar(page).getByRole('button', { name: 'Library', exact: true }).click();
  await sidebar(page).getByRole('button', { name: /Settings and backup|Signed in with Cloudflare Access/ }).click();
  const nav = page.getByRole('navigation', { name: 'Settings sections' });
  await nav.getByRole('button', { name: section }).click();
  // (A phone shows the sections without the section's heading.)
  await expect(nav.getByRole('button', { name: section })).toHaveAttribute('aria-current', 'page');
}

export async function closeSettings(page: Page) {
  const close = page.getByRole('button', { name: 'Close settings' });
  if (await close.isVisible()) await close.click();
  else await page.keyboard.press('Escape');
  await expect(page.getByRole('navigation', { name: 'Settings sections' })).toBeHidden();
}

/* -------------------------------------------------------- encryption --- */

interface Secrets {
  passphrase: string;
  recoveryKey: string;
}

const secretsFile = () => path.join(process.env.LUMEN_E2E_DIR ?? '.', 'secrets.json');

/** The passphrase and recovery key of this run's library, once encryption is on. */
export function secrets(): Secrets | null {
  try {
    return JSON.parse(fs.readFileSync(secretsFile(), 'utf8')) as Secrets;
  } catch {
    return null;
  }
}

export function saveSecrets(s: Secrets) {
  fs.writeFileSync(secretsFile(), JSON.stringify(s));
}

/**
 * Turns on end-to-end encryption from Settings → Security on an open, unlocked app: passphrase twice,
 * then the recovery key shown once, ticked as saved. Waits until the library is encrypted. Returns the
 * recovery key.
 */
export async function setUpEncryption(page: Page, passphrase: string): Promise<string> {
  await openSettings(page, 'Security');
  await page.getByRole('button', { name: 'Set up encryption' }).click();
  await page.getByRole('textbox', { name: 'Passphrase', exact: true }).fill(passphrase);
  await page.getByRole('textbox', { name: 'Passphrase again' }).fill(passphrase);
  await page.getByRole('button', { name: 'Continue' }).click();
  const key = page.getByLabel('Recovery key', { exact: true });
  await expect(key).toBeVisible({ timeout: 30_000 });
  const recoveryKey = (await key.textContent())!.trim();
  await page.getByRole('checkbox', { name: 'I’ve saved my recovery key somewhere safe' }).check();
  await page.getByRole('button', { name: 'Turn on encryption' }).click();
  await expect(toasts(page).getByText('Your notes are end-to-end encrypted')).toBeVisible({ timeout: 60_000 });
  await waitLoaded(page);
  saveSecrets({ passphrase, recoveryKey });
  return recoveryKey;
}

/**
 * Opens the app on an encrypted library, unlocked: turns encryption on first if this run's library
 * isn't encrypted yet (a file run on its own), otherwise unlocks with the run's passphrase.
 */
export async function openEncrypted(page: Page, url = '/'): Promise<Secrets> {
  const state = await openApp(page, url);
  if (state === 'locked') {
    const s = secrets();
    if (!s) throw new Error('The library is encrypted but this run has no record of its passphrase.');
    await unlock(page, s.passphrase);
    return s;
  }
  const { encryption } = await bootstrap(page);
  if (encryption?.on) throw new Error('Encryption is on but this device opened unlocked without a passphrase.');
  const recoveryKey = await setUpEncryption(page, PASSPHRASE);
  return { passphrase: PASSPHRASE, recoveryKey };
}
