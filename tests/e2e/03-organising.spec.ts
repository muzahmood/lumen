/**
 * Journey 2, organising, on the encrypted library: nested folders, moving a note into one, tags, pinning,
 * trash and restore, and the search filters (which run on the device once notes are encrypted). Every
 * note here has the word "orchid", so searches are checked against exactly these three notes whatever
 * else the library holds.
 */
import type { Page } from '@playwright/test';
import { createNote, dialog, folderItem, listRow, listSearch, menuItem, newFolder, noteList, noteTitle, openApp, openEncrypted, secrets, sidebar, toasts } from './app';
import { expect, test } from './fixtures';

const KICKOFF = 'Orchid kickoff';
const BUDGET = 'Orchid budget';
const HOLIDAY = 'Orchid holiday';

async function open(page: Page, title: string) {
  await sidebar(page).getByRole('button', { name: /^All notes/ }).click();
  await listRow(page, title).click();
  await expect(noteTitle(page)).toHaveValue(title);
}

/** Types a search into the note list and returns the titles found, once the results are in. */
async function search(page: Page, query: string, expected: string[]) {
  await listSearch(page).fill(query);
  const titles = noteList(page).locator('a.row .row-title');
  await expect
    .poll(async () => (await titles.allTextContents()).sort(), { message: `results for ${query}`, timeout: 15_000 })
    .toEqual([...expected].sort());
  await expect(noteList(page).getByText(expected.length ? new RegExp(`^${expected.length} results?$`) : 'Search results')).toBeVisible();
}

test('folders, moving, tags, pins, trash and search filters', async ({ page }) => {
  await openEncrypted(page);

  await createNote(page, KICKOFF, 'Kickoff for the orchid account: the quarterly budget review.\n- [ ] Send the orchid proposal');
  await createNote(page, BUDGET, 'The orchid budget spreadsheet for the quarterly review');
  await createNote(page, HOLIDAY, 'An orchid trip to the coast');

  // Nested folders: Projects, and Clients inside it.
  await newFolder(page, 'Projects');
  await newFolder(page, 'Clients', 'Projects');
  // The new subfolder shows under its parent, which is open.
  await expect(folderItem(page, 'Projects')).toHaveAttribute('aria-expanded', 'true');
  await expect(folderItem(page, 'Clients')).toBeVisible();

  // Move notes into them from the folder chip under the title.
  await open(page, KICKOFF);
  await page.getByRole('button', { name: 'No folder, change folder' }).click();
  await menuItem(page, 'Clients').click();
  await expect(page.getByRole('button', { name: 'Clients, change folder' })).toBeVisible();
  // The whole path is shown above the note.
  const crumbs = page.getByRole('navigation', { name: 'Location' });
  await expect(crumbs.getByRole('button', { name: 'Projects' })).toBeVisible();
  await expect(crumbs.getByRole('button', { name: 'Clients' })).toBeVisible();

  await open(page, BUDGET);
  await page.getByRole('button', { name: 'No folder, change folder' }).click();
  await menuItem(page, 'Projects').click();
  await expect(page.getByRole('button', { name: 'Projects, change folder' })).toBeVisible();

  // A folder lists its subfolders' notes too, and counts them.
  await folderItem(page, 'Projects').click();
  await expect(noteList(page).getByRole('heading', { name: 'Projects', level: 1 })).toBeVisible();
  await expect(listRow(page, KICKOFF)).toBeVisible();
  await expect(listRow(page, BUDGET)).toBeVisible();
  await expect(listRow(page, HOLIDAY)).toHaveCount(0);
  await expect(folderItem(page, 'Projects').locator('.nav-count')).toHaveText('2');
  await folderItem(page, 'Clients').click();
  await expect(listRow(page, KICKOFF)).toBeVisible();
  await expect(listRow(page, BUDGET)).toHaveCount(0);

  // Tags.
  await open(page, KICKOFF);
  await page.getByRole('textbox', { name: 'Add tag' }).fill('work');
  await page.getByRole('textbox', { name: 'Add tag' }).press('Enter');
  await expect(page.getByRole('button', { name: 'Remove tag work' })).toBeVisible();
  await open(page, HOLIDAY);
  await page.getByRole('textbox', { name: 'Add tag' }).fill('travel');
  await page.getByRole('textbox', { name: 'Add tag' }).press('Enter');
  const tags = sidebar(page).getByRole('region', { name: 'Tags' });
  await expect(tags.getByRole('button', { name: /^work/ })).toBeVisible();
  await tags.getByRole('button', { name: /^travel/ }).click();
  await expect(noteList(page).getByRole('heading', { name: 'travel', level: 1 })).toBeVisible();
  await expect(listRow(page, HOLIDAY)).toBeVisible();
  await expect(listRow(page, KICKOFF)).toHaveCount(0);

  // Pin.
  await open(page, KICKOFF);
  await page.getByRole('button', { name: 'Pin to top' }).click();
  await expect(page.getByRole('button', { name: 'Unpin' })).toHaveAttribute('aria-pressed', 'true');
  await sidebar(page).getByRole('button', { name: /^Pinned/ }).click();
  await expect(listRow(page, KICKOFF)).toBeVisible();

  // Trash, and back.
  await open(page, HOLIDAY);
  await page.getByRole('button', { name: 'More', exact: true }).click();
  await menuItem(page, 'Move to trash').click();
  await expect(toasts(page).getByText('Moved to trash')).toBeVisible();
  await expect(listRow(page, HOLIDAY)).toHaveCount(0);
  await sidebar(page).getByRole('button', { name: /^Trash/ }).click();
  await expect(noteList(page).getByRole('heading', { name: 'Trash', level: 1 })).toBeVisible();
  await listRow(page, HOLIDAY).click();
  await expect(page.getByText('This note is in the trash')).toBeVisible();
  await page.getByRole('button', { name: 'Restore', exact: true }).click();
  await expect(toasts(page).getByText('Note restored')).toBeVisible();
  await expect(page.getByText('This note is in the trash')).toHaveCount(0);
  await expect(listRow(page, HOLIDAY)).toHaveCount(0);
  await sidebar(page).getByRole('button', { name: /^All notes/ }).click();
  await expect(listRow(page, HOLIDAY)).toBeVisible();

  // Search with filters, on this device (the library is encrypted).
  await search(page, 'orchid', [KICKOFF, BUDGET, HOLIDAY]);
  await search(page, 'orchid tag:work', [KICKOFF]);
  await search(page, 'orchid #travel', [HOLIDAY]);
  await search(page, 'orchid in:Projects', [KICKOFF, BUDGET]);
  await search(page, 'orchid in:Projects/Clients', [KICKOFF]);
  await search(page, 'orchid is:pinned', [KICKOFF]);
  await search(page, 'orchid has:task', [KICKOFF]);
  await search(page, '"quarterly budget"', [KICKOFF]);
  await search(page, 'orchid -budget', [HOLIDAY]);
  await search(page, 'orchid -tag:work', [BUDGET, HOLIDAY]);
  await search(page, 'orchid -in:Projects', [HOLIDAY]);
  await search(page, 'orchid zebra', []);
  await page.getByRole('button', { name: 'Clear search' }).click();
  await expect(listSearch(page)).toHaveValue('');
});

test('choosing several notes to move and tag together, and renaming a tag everywhere with Undo', async ({ page }) => {
  await openEncrypted(page);
  const id = Math.random().toString(36).slice(2, 6);
  const names = [`Heron ${id} one`, `Heron ${id} two`, `Heron ${id} three`];
  for (const n of names) await createNote(page, n, `A heron note ${id}`);
  await newFolder(page, `Birds ${id}`);

  // Ctrl click picks notes instead of opening them; the bar acts on all of them.
  await sidebar(page).getByRole('button', { name: /^All notes/ }).click();
  await listRow(page, names[0]).click({ modifiers: ['Control'] });
  await listRow(page, names[1]).click({ modifiers: ['Control'] });
  const bar = page.getByRole('toolbar', { name: 'Chosen notes' });
  await expect(bar).toContainText('2 selected');
  await bar.getByRole('button', { name: 'Move to folder' }).click();
  await menuItem(page, `Birds ${id}`).click();
  await expect(toasts(page).getByText(`Moved 2 notes to Birds ${id}`)).toBeVisible();
  await expect(bar).toBeHidden();
  await folderItem(page, `Birds ${id}`).click();
  await expect(noteList(page).locator('a.row')).toHaveCount(2);

  // Tag both, from the bar.
  await listRow(page, names[0]).click({ modifiers: ['Control'] });
  await listRow(page, names[1]).click({ modifiers: ['Control'] });
  await bar.getByRole('button', { name: 'Tags' }).click();
  await menuItem(page, 'New tag…').click();
  const ask = dialog(page, 'Tag 2 notes');
  await ask.getByRole('textbox', { name: 'Tag name' }).fill(`wader-${id}`);
  await ask.getByRole('button', { name: 'Add tag' }).click();
  await expect(toasts(page).getByText(`Added #wader-${id} to 2 notes`)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(bar).toBeHidden();

  // Rename the tag across every note that has it (from its menu in the sidebar), then Undo.
  const tags = sidebar(page).getByRole('region', { name: 'Tags' });
  await tags.getByRole('button', { name: new RegExp(`^wader-${id}`) }).click({ button: 'right' });
  await menuItem(page, 'Rename or merge…').click();
  const rename = dialog(page, `Rename #wader-${id}`);
  await rename.getByRole('textbox').fill(`heron-${id}`);
  await rename.getByRole('button', { name: 'Rename' }).click();
  const renamed = toasts(page).locator('.toast', { hasText: `Renamed #wader-${id} to #heron-${id} in 2 notes` });
  await expect(renamed).toBeVisible();
  await expect(tags.getByRole('button', { name: new RegExp(`^heron-${id}`) })).toBeVisible();
  await expect(tags.getByRole('button', { name: new RegExp(`^wader-${id}`) })).toHaveCount(0);
  // Saved encrypted, so it follows a reload.
  await page.reload();
  await expect(tags.getByRole('button', { name: new RegExp(`^heron-${id} 2`) })).toBeVisible({ timeout: 15_000 });

  // Undo (from the toast, on another rename) puts the old tag back.
  await tags.getByRole('button', { name: new RegExp(`^heron-${id}`) }).click({ button: 'right' });
  await menuItem(page, 'Rename or merge…').click();
  await dialog(page, `Rename #heron-${id}`).getByRole('textbox').fill(`egret-${id}`);
  await dialog(page, `Rename #heron-${id}`).getByRole('button', { name: 'Rename' }).click();
  await toasts(page).locator('.toast', { hasText: `to #egret-${id}` }).getByRole('button', { name: 'Undo' }).click();
  await expect(tags.getByRole('button', { name: new RegExp(`^heron-${id} 2`) })).toBeVisible();
  await expect(tags.getByRole('button', { name: new RegExp(`^egret-${id}`) })).toHaveCount(0);
});

// A search typed while the notes are still loading (a slow connection, a phone opening the app) runs
// again once they've arrived: in an encrypted library it runs on the device, over a note list that was
// still empty (NoteList's and the palette's searches also depend on the notes being ready).
test('a search typed while the notes are still loading finds them once they arrive', async ({ page, device }) => {
  await openEncrypted(page);
  const word = `kestrel${Math.random().toString(36).slice(2, 6)}`;
  await createNote(page, 'Slow start note', `Seen from the train: a ${word} hovering`);

  // Another device on a slow connection: the note list takes a while to arrive after unlocking.
  const other = await device({ label: 'device 2' });
  expect(await openApp(other.page)).toBe('locked');
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  await other.context.route('**/api/bootstrap**', async (route) => {
    await held;
    await route.continue();
  });
  await other.page.getByRole('textbox', { name: 'Passphrase' }).fill(secrets()!.passphrase);
  await other.page.getByRole('button', { name: 'Unlock', exact: true }).click();
  await expect(other.page.locator('.list-skeleton')).toBeVisible({ timeout: 15_000 });

  // Searched before the notes are in; then they arrive.
  await listSearch(other.page).fill(word);
  await expect(other.page.getByRole('progressbar', { name: 'Searching' })).toHaveCount(0, { timeout: 15_000 });
  release();
  await expect(other.page.locator('.list-skeleton')).toHaveCount(0, { timeout: 15_000 });
  await expect(other.page.getByRole('region', { name: 'Recently edited' }).getByRole('link', { name: /Slow start note/ })).toBeVisible();

  // Expected: the search shows the note. Actual: "Nothing matches “kestrel…”" until the query changes.
  await expect(listRow(other.page, 'Slow start note')).toBeVisible({ timeout: 10_000 });
});
