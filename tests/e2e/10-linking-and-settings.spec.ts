/**
 * More of everyday use, on the encrypted library (where links, backlinks and renames all work from
 * the device's own copy of the notes): a [[link]] typed with its completion, the backlink it makes,
 * renaming the linked note and updating the link; settings following to another device (encrypted on
 * the server); Home's capture into the journal; Ctrl K creating a note; an untouched new note going away.
 */
import type { Page } from '@playwright/test';
import {
  bootstrap,
  createNote,
  currentNoteId,
  expectSaved,
  focusEnd,
  listRow,
  noteList,
  noteText,
  noteTitle,
  openApp,
  openEncrypted,
  openSettings,
  closeSettings,
  preview,
  secrets,
  setMode,
  sidebar,
  toasts,
  unlock,
} from './app';
import { expect, test } from './fixtures';

const open = async (page: Page, title: string) => {
  await sidebar(page).getByRole('button', { name: /^All notes/ }).click();
  await listRow(page, title).click();
  await expect(noteTitle(page)).toHaveValue(title);
};

test('a [[link]], its backlink, and renaming the linked note', async ({ page }) => {
  // Titles of their own, so the test can run again on the same library.
  const id = Math.random().toString(36).slice(2, 6);
  const keeper = `Lighthouse keeper ${id}`;
  const walk = `Coastal walk ${id}`;
  const renamed = `Old lighthouse ${id}`;
  await openEncrypted(page);
  await createNote(page, keeper, 'Lives by the sea');
  await createNote(page, walk, 'Ended the walk at the ');

  // Typing [[ offers the notes to link to.
  await focusEnd(page);
  await page.keyboard.type('[[Lighth');
  const option = page.getByRole('listbox').getByRole('option', { name: keeper });
  // Picked with the pointer: the editor ignores Enter for a moment after the list opens, so a
  // keypress straight after it appears would be a new line instead (CodeMirror's interactionDelay).
  await option.click();
  await expect(noteText(page)).not.toContainText('Lighth]]');
  await expectSaved(page);
  await setMode(page, 'Read');
  await expect(preview(page).getByRole('link', { name: keeper })).toBeVisible();

  // The linked note shows where it's linked from.
  await preview(page).getByRole('link', { name: keeper }).click();
  await expect(noteTitle(page)).toHaveValue(keeper);
  await expect(page.getByRole('button', { name: /^1 backlink/ })).toBeVisible({ timeout: 15_000 });
  await setMode(page, 'Read');
  await expect(page.getByRole('complementary', { name: 'Linked from' }).getByRole('link', { name: new RegExp(walk) })).toBeVisible();

  // Renamed: Lumen offers to update the link that still uses the old title.
  await noteTitle(page).fill(renamed);
  await noteTitle(page).blur();
  const offer = toasts(page).locator('.toast', { hasText: `A note links to this note as “${keeper}”. Update it to “${renamed}”?` });
  await expect(offer).toBeVisible({ timeout: 15_000 });
  await offer.getByRole('button', { name: 'Update links' }).click();
  await expect(toasts(page).getByText('Updated links in 1 note')).toBeVisible();
  await expectSaved(page);

  await open(page, walk);
  await setMode(page, 'Read');
  await expect(preview(page).getByRole('link', { name: renamed })).toBeVisible();
  await expect(preview(page).getByRole('link', { name: keeper })).toHaveCount(0);
  await expectSaved(page);
});

/** Picks a theme in Settings → Appearance and waits until it's been sent to the server. */
async function chooseTheme(page: Page, theme: 'System' | 'Light' | 'Dark') {
  await openSettings(page, 'Appearance');
  const radio = page.getByRole('radiogroup', { name: 'Theme' }).getByRole('radio', { name: new RegExp(theme) });
  if ((await radio.getAttribute('aria-checked')) !== 'true') {
    const saved = page.waitForResponse((r) => r.url().endsWith('/api/settings') && r.request().method() === 'PUT' && r.ok());
    await radio.click();
    await saved;
  }
  await expect(radio).toHaveAttribute('aria-checked', 'true');
  await closeSettings(page);
}

test('settings follow to another device, encrypted on the way', async ({ page, device }) => {
  await openEncrypted(page);
  await chooseTheme(page, 'Dark');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

  // Stored encrypted: the server can't read them.
  const stored = (await bootstrap(page)) as unknown as { settings: { enc: boolean; data: string } };
  expect(stored.settings.enc).toBe(true);
  expect(stored.settings.data).toMatch(/^e1:/);
  expect(JSON.stringify(stored.settings)).not.toContain('dark');

  const other = await device({ label: 'device 2' });
  expect(await openApp(other.page)).toBe('locked');
  await unlock(other.page, secrets()!.passphrase);
  await expect(other.page.locator('html')).toHaveAttribute('data-theme', 'dark');

  // Back to following the system.
  await chooseTheme(page, 'System');
});

test('capture into the journal, Ctrl K to make a note, and an untouched new note goes away', async ({ page }) => {
  await openEncrypted(page);

  // Home's capture box, switched to Journal: added to the end of today's entry, with the time.
  await sidebar(page).getByRole('button', { name: 'Home', exact: true }).click();
  await page.getByRole('radiogroup', { name: 'Save to' }).getByRole('radio', { name: 'Journal' }).click();
  await page.getByRole('textbox', { name: 'Quick capture' }).fill('Bought stamps for the postcards');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  const added = toasts(page).locator('.toast', { hasText: 'Added to today’s journal' });
  await expect(added).toBeVisible();
  await added.getByRole('button', { name: 'Open' }).click();
  await expect(noteTitle(page)).toHaveValue(/^\d{4}-\d{2}-\d{2}$/);
  await expect(noteText(page)).toContainText('Bought stamps for the postcards');
  await expectSaved(page);
  await sidebar(page).getByRole('button', { name: 'Home', exact: true }).click();
  await page.getByRole('radiogroup', { name: 'Save to' }).getByRole('radio', { name: 'New note' }).click();

  // Ctrl K, a title nothing has yet, Ctrl Enter: a new note with that title.
  await page.keyboard.press('Control+k');
  const palette = page.getByRole('dialog', { name: 'Search and commands' });
  await palette.getByRole('textbox', { name: 'Search notes or commands' }).fill('Pottery class');
  await page.keyboard.press('Control+Enter');
  await expect(noteTitle(page)).toHaveValue('Pottery class');
  const pottery = currentNoteId(page);
  await expectSaved(page);
  expect((await bootstrap(page)).notes.some((n) => n.id === pottery)).toBe(true);

  // A new note left without a word in it is cleaned up.
  const count = (await bootstrap(page)).notes.length;
  await sidebar(page).getByRole('button', { name: 'New note', exact: true }).click();
  await expect(noteTitle(page)).toBeFocused();
  const empty = currentNoteId(page);
  await expect.poll(async () => (await bootstrap(page)).notes.length).toBe(count + 1);
  await sidebar(page).getByRole('button', { name: 'Home', exact: true }).click();
  await expect.poll(async () => (await bootstrap(page)).notes.some((n) => n.id === empty), { timeout: 10_000 }).toBe(false);
  await sidebar(page).getByRole('button', { name: /^All notes/ }).click();
  await expect(noteList(page).locator('a.row .row-title.is-untitled')).toHaveCount(0);
});

test('images from other websites wait for a click when set to Ask first', async ({ page, context }) => {
  // The "other website", answered here, so every request it gets is counted.
  const asked: string[] = [];
  const PIXEL = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
  await context.route('https://tracker.example/**', (route) => {
    asked.push(route.request().url());
    return route.fulfill({ status: 200, contentType: 'image/png', body: PIXEL });
  });

  await openEncrypted(page);
  await openSettings(page, 'Security');
  await page.getByRole('combobox', { name: 'Images from other websites' }).selectOption('ask');
  await closeSettings(page);

  await createNote(page, 'Postcard', 'Greetings from the coast\n\n![Beach](https://tracker.example/beach.png)\n\n<img src="https://tracker.example/html.png" alt="Pier">\n');
  // While editing (live preview), the image is a button to load it, not a request.
  const askButton = noteText(page).getByRole('button', { name: /Beach: image from tracker\.example\. Click to load/ });
  await expect(askButton).toBeVisible();
  await setMode(page, 'Split');
  await setMode(page, 'Read');
  const held = preview(page).getByRole('img', { name: /Beach\. Image from tracker\.example: click to load/ });
  await expect(held).toBeVisible();
  await page.reload();
  await expect(noteTitle(page)).toHaveValue('Postcard');
  await setMode(page, 'Read');
  await expect(preview(page).getByRole('img', { name: /click to load/ }).first()).toBeVisible();
  expect(asked).toEqual([]);

  // A click loads that one image, and only it.
  await preview(page).getByRole('img', { name: /Beach\. Image from tracker\.example/ }).click();
  await expect.poll(() => asked).toEqual(['https://tracker.example/beach.png']);

  await openSettings(page, 'Security');
  await page.getByRole('combobox', { name: 'Images from other websites' }).selectOption('load');
  await closeSettings(page);
});
