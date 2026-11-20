/**
 * Journey 9, the phone layout (390×844, touch), on the encrypted library: the bottom tab bar, the note
 * list and a note each taking the whole screen with Back between them, a new note from the tab bar,
 * the Library drawer, and search from the tab bar. Then the phone's Back: closing what's open, then
 * back through Lumen's pages (each with its own address and title), and only then away.
 */
import { expect, test } from './fixtures';
import { expectSaved, listRow, openApp, listSearch, noteList, noteText, noteTitle, openEncrypted, sidebar, tabBar, typeText } from './app';

test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

test('the tab bar and moving between the list and a note on a phone', async ({ page }) => {
  await openEncrypted(page);
  const tabs = tabBar(page);
  await expect(tabs).toBeVisible();
  for (const name of ['Home', 'Notes', 'New note', 'Search', 'Library']) await expect(tabs.getByRole('button', { name, exact: true })).toBeVisible();
  // The sidebar is a drawer here, closed until asked for.
  await expect(sidebar(page)).toBeHidden();
  await expect(page.getByRole('region', { name: 'Home' })).toBeVisible();

  // A new note from the tab bar takes the whole screen, without the tab bar.
  await tabs.getByRole('button', { name: 'New note', exact: true }).tap();
  await expect(noteTitle(page)).toBeFocused();
  await noteTitle(page).fill('Written on the bus');
  await noteTitle(page).press('Enter');
  // Enter moves to the note's text (a frame later): type once it's there.
  await expect(noteText(page)).toBeFocused();
  await typeText(page, 'Two stops to go');
  await expectSaved(page);
  await expect(tabs).toBeHidden();
  await expect(noteList(page)).toBeHidden();
  // The phone has one Edit/Read button instead of the three-way switch.
  await expect(page.getByRole('radiogroup', { name: 'View' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Read', exact: true }).tap();
  await expect(page.locator('.kb-prose')).toContainText('Two stops to go');
  await page.getByRole('button', { name: 'Edit', exact: true }).tap();
  await expect(noteText(page)).toBeVisible();

  // Back: the tab bar returns; Notes shows the list on its own.
  await page.getByRole('button', { name: 'Back' }).tap();
  await expect(tabs).toBeVisible();
  await tabs.getByRole('button', { name: 'Notes', exact: true }).tap();
  await expect(noteList(page).getByRole('heading', { name: 'All notes', level: 1 })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Home' })).toBeHidden();
  await listRow(page, 'Written on the bus').tap();
  await expect(noteTitle(page)).toHaveValue('Written on the bus');
  await expect(noteList(page)).toBeHidden();
  await page.getByRole('button', { name: 'Back' }).tap();
  await expect(noteList(page).getByRole('heading', { name: 'All notes', level: 1 })).toBeVisible();
  await expect(listRow(page, 'Written on the bus')).toBeVisible();
  // The phone's own back gesture (the browser's Back) does the same.
  await listRow(page, 'Written on the bus').tap();
  await expect(noteTitle(page)).toHaveValue('Written on the bus');
  await page.goBack();
  await expect(noteList(page).getByRole('heading', { name: 'All notes', level: 1 })).toBeVisible();
  await expect(tabs).toBeVisible();
  await expect(noteTitle(page)).toHaveCount(0);

  // Library opens the sidebar as a drawer; picking a view closes it and shows that list.
  await tabs.getByRole('button', { name: 'Library', exact: true }).tap();
  await expect(sidebar(page)).toBeVisible();
  await sidebar(page).getByRole('button', { name: /^Pinned/ }).tap();
  await expect(sidebar(page)).toBeHidden();
  await expect(noteList(page).getByRole('heading', { name: 'Pinned', level: 1 })).toBeVisible();
  await expect(listRow(page, 'Written on the bus')).toHaveCount(0);

  // Search from the tab bar finds the note and opens it.
  await tabs.getByRole('button', { name: 'Search', exact: true }).tap();
  const palette = page.getByRole('dialog', { name: 'Search and commands' });
  await palette.getByRole('textbox', { name: 'Search notes or commands' }).fill('bus');
  await palette.getByRole('option', { name: /Written on the bus/ }).first().tap();
  await expect(noteTitle(page)).toHaveValue('Written on the bus');

  // Home from the note: Back, then the Home tab.
  await page.getByRole('button', { name: 'Back' }).tap();
  await tabs.getByRole('button', { name: 'Home', exact: true }).tap();
  await expect(page.getByRole('region', { name: 'Home' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Recently edited' }).getByRole('link', { name: /Written on the bus/ })).toBeVisible();
});

test('the phone’s Back goes back through Lumen: what’s open first, then each page, and only then away', async ({ page }) => {
  await openEncrypted(page);
  const tabs = tabBar(page);
  const allNotes = noteList(page).getByRole('heading', { name: 'All notes', level: 1 });
  const palette = page.getByRole('dialog', { name: 'Search and commands' });
  await tabs.getByRole('button', { name: 'New note', exact: true }).tap();
  await noteTitle(page).fill('Back and forth');
  await expectSaved(page);
  const id = new URL(page.url()).pathname.split('/').pop()!;

  // Lumen opened from somewhere else: Back leaves only from Lumen's first page.
  await page.goto('about:blank');
  await openApp(page);
  await expect(page).toHaveTitle('Lumen');

  // The Notes tab is a page of its own.
  await tabs.getByRole('button', { name: 'Notes', exact: true }).tap();
  await expect(allNotes).toBeVisible();
  await expect(page).toHaveURL(/\/notes$/);
  await expect(page).toHaveTitle('All notes – Lumen');

  // Back closes the drawer, search and Settings, and stays on the list.
  await tabs.getByRole('button', { name: 'Library', exact: true }).tap();
  await expect(sidebar(page)).toBeVisible();
  await page.goBack();
  await expect(sidebar(page)).toBeHidden();
  await expect(allNotes).toBeVisible();
  await tabs.getByRole('button', { name: 'Search', exact: true }).tap();
  await expect(palette).toBeVisible();
  await page.goBack();
  await expect(palette).toBeHidden();
  await expect(allNotes).toBeVisible();
  await tabs.getByRole('button', { name: 'Library', exact: true }).tap();
  await sidebar(page).locator('button.profile').tap();
  const settings = page.getByRole('dialog', { name: 'Settings' });
  await expect(settings).toBeVisible();
  await expect(sidebar(page)).toBeHidden();
  await page.goBack();
  await expect(settings).toBeHidden();
  await expect(sidebar(page)).toBeHidden();
  await expect(allNotes).toBeVisible();

  // A view picked in the drawer is a page; with encryption on, a search stays out of the address.
  await tabs.getByRole('button', { name: 'Library', exact: true }).tap();
  await sidebar(page).getByRole('button', { name: /^Pinned/ }).tap();
  await expect(noteList(page).getByRole('heading', { name: 'Pinned', level: 1 })).toBeVisible();
  await expect(page).toHaveURL(/\/notes\?view=pinned$/);
  await expect(page).toHaveTitle('Pinned – Lumen');
  await page.goBack();
  await expect(allNotes).toBeVisible();
  await expect(sidebar(page)).toBeHidden();
  await listSearch(page).fill('forth');
  await expect(listRow(page, 'Back and forth')).toBeVisible();
  await page.waitForTimeout(600);
  expect(page.url()).not.toContain('forth');

  // A note, then Back to the list (its search still there), Home, and away.
  await listRow(page, 'Back and forth').tap();
  await expect(noteTitle(page)).toHaveValue('Back and forth');
  await expect(page).toHaveTitle('Note – Lumen');
  await page.goBack();
  await expect(listSearch(page)).toHaveValue('forth');
  await page.goBack();
  await expect(page.getByRole('region', { name: 'Home' })).toBeVisible();
  await expect(page).toHaveURL(/\/$/);
  await page.goBack();
  await expect(page).toHaveURL('about:blank');

  // Opened straight at a note (a link, a shortcut): Back goes Home before leaving.
  await page.goto(`/note/${id}`);
  await expect(noteTitle(page)).toHaveValue('Back and forth');
  await page.goBack();
  await expect(page.getByRole('region', { name: 'Home' })).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL('about:blank');
});
