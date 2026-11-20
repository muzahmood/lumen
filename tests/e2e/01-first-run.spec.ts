/**
 * Journey 1, first run: a brand-new, empty library (not yet encrypted: encryption can only be turned
 * on once Lumen is running). The welcome note appears; a note is written, saves itself, and is still
 * there after a reload; Home's quick capture makes a note whose first line is the title.
 */
import { createNote, currentNoteId, expectSaved, focusEnd, listRow, noteList, noteText, noteTitle, openApp, rawNote, sidebar, toasts, typeText } from './app';
import { expect, test } from './fixtures';

test.describe.configure({ mode: 'serial' });

test('the welcome note greets a new library', async ({ page }) => {
  expect(await openApp(page)).toBe('ready');
  const home = page.getByRole('region', { name: 'Home' });
  // Pinned, so it's a card on Home and first in the list, tagged #guide.
  await expect(home.getByRole('region', { name: 'Pinned' }).getByRole('link', { name: /Welcome to Lumen/ })).toBeVisible();
  await expect(listRow(page, 'Welcome to Lumen')).toBeVisible();
  await expect(sidebar(page).getByRole('button', { name: /guide/ })).toBeVisible();

  await listRow(page, 'Welcome to Lumen').click();
  await expect(noteTitle(page)).toHaveValue('Welcome to Lumen');
  // Live preview: its task list shows as tick boxes while editing (one of three ticked).
  await expect(noteText(page)).toContainText('Tick a box right here in reading view');
  await expect(noteText(page).getByRole('checkbox', { name: 'Mark task not done' })).toHaveCount(1);
  await expect(noteText(page).getByRole('checkbox', { name: 'Mark task done' })).toHaveCount(2);
  // Reading view renders the same note as a document.
  await page.getByRole('radiogroup', { name: 'View' }).getByRole('radio', { name: 'Read' }).click();
  await expect(page.locator('.kb-prose').getByRole('heading', { name: 'Tasks', level: 2 })).toBeVisible();
});

test('a new note saves itself and survives a reload', async ({ page }) => {
  await openApp(page);
  const id = await createNote(page, 'Groceries', 'Oat milk and a dozen eggs');
  await expect(noteText(page)).toContainText('Oat milk and a dozen eggs');
  // In the list straight away, with its first words as the preview.
  await expect(listRow(page, 'Groceries')).toContainText('Oat milk');

  // Saved to the server, not just shown.
  await expect.poll(async () => (await rawNote(page, id)).content).toBe('Oat milk and a dozen eggs');

  // An edit to it saves on its own too, with no Save button.
  await focusEnd(page);
  await typeText(page, '\nAnd coffee beans');
  await expect(page.locator('.note-header .save-state')).not.toHaveClass(/is-saved/);
  await expectSaved(page);
  await expect.poll(async () => (await rawNote(page, id)).content).toBe('Oat milk and a dozen eggs\nAnd coffee beans');

  await page.reload();
  await expect(noteTitle(page)).toHaveValue('Groceries');
  await expect(noteText(page).or(page.locator('.kb-prose')).first()).toContainText('And coffee beans');
  expect(currentNoteId(page)).toBe(id);
});

test('quick capture on Home: the first line becomes the title', async ({ page }) => {
  await openApp(page);
  const capture = page.getByRole('textbox', { name: 'Quick capture' });
  await capture.fill('Call the plumber\nThe kitchen tap drips at night');
  await page.getByRole('button', { name: 'Save note' }).click();
  await expect(toasts(page).getByText('Saved to your notes')).toBeVisible();
  await expect(capture).toHaveValue('');

  await expect(listRow(page, 'Call the plumber')).toBeVisible();
  await listRow(page, 'Call the plumber').click();
  await expect(noteTitle(page)).toHaveValue('Call the plumber');
  await expect(page.locator('.note-pane')).toContainText('The kitchen tap drips at night');
  await expect(page.locator('.note-pane')).not.toContainText('Call the plumber\nThe kitchen');

  // A reload keeps every note: the welcome note and the two written here.
  await page.reload();
  await expect(noteList(page).getByRole('link')).toHaveCount(3);
});
