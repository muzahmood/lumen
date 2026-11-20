/**
 * Journey 13, on the encrypted library, at desktop size: a note shown inside another with ![[…]], the
 * preview on resting over a [[link]], a search kept by name in the sidebar (with Back going through
 * the list's views), a repeating task ticked in Tasks coming back for its next date, and Back closing
 * Settings before it leaves the page.
 */
import { createNote, listRow, listSearch, noteList, openEncrypted, openSettings, preview, setMode, sidebar } from './app';
import { expect, test } from './fixtures';

test('embeds, link previews, saved searches and repeating tasks', async ({ page }) => {
  // Names of their own, so the test can run again on the same library.
  const id = Math.random().toString(36).slice(2, 6);
  const seeds = `Seed list ${id}`;
  await openEncrypted(page);
  await createNote(page, seeds, `Tomatoes and basil ${id}`);

  // Shown inside another note, read-only, and previewed from a link.
  await createNote(page, `Garden plan ${id}`, `Water daily.\n\n![[${seeds}]]\n\nSee [[${seeds}]].`);
  await setMode(page, 'Read');
  const embed = preview(page).locator('.kb-embed.is-filled');
  await expect(embed).toContainText(`Tomatoes and basil ${id}`);
  await expect(embed.locator('.kb-embed-head')).toHaveText(seeds);
  await preview(page).locator('a.kb-wikilink:not(.kb-embed-link)').filter({ hasText: seeds }).hover();
  const peek = page.locator('.note-peek');
  await expect(peek).toContainText(`Tomatoes and basil ${id}`);
  await expect(peek.locator('.note-peek-title')).toHaveText(seeds);
  await page.mouse.move(5, 5);
  await expect(peek).toBeHidden();

  // A search kept by name: in the sidebar, with an address of its own.
  await sidebar(page).getByRole('button', { name: /^All notes/ }).click();
  await listSearch(page).fill(`basil ${id}`);
  await expect(listRow(page, seeds)).toBeVisible();
  await noteList(page).getByRole('button', { name: 'Save this search' }).click();
  const naming = page.getByRole('dialog', { name: 'Save this search' });
  await naming.getByRole('textbox').fill(`Herbs ${id}`);
  await naming.getByRole('button', { name: 'Save' }).click();
  await expect(noteList(page).getByRole('heading', { name: `Herbs ${id}`, level: 1 })).toBeVisible();
  await expect(page).toHaveURL(/[?&]search=[A-Za-z0-9_-]+/);
  await expect(listRow(page, seeds)).toBeVisible();
  const saved = sidebar(page).getByRole('region', { name: 'Saved searches' }).getByRole('button', { name: `Herbs ${id}`, exact: true });
  await expect(saved).toBeVisible();
  // Back: the list as it was, search and all; then the saved search again from the sidebar.
  await page.goBack();
  await expect(noteList(page).getByRole('heading', { name: 'All notes', level: 1 })).toBeVisible();
  await expect(listSearch(page)).toHaveValue(`basil ${id}`);
  await saved.click();
  await expect(noteList(page).getByRole('heading', { name: `Herbs ${id}`, level: 1 })).toBeVisible();

  // A repeating task, ticked in Tasks: dated, and back for next week.
  await createNote(page, `Chores ${id}`, `- [ ] water the ferns ${id} 🔁 every week 📅 2026-11-17`);
  await sidebar(page).getByRole('button', { name: /^Tasks/ }).click();
  await page.getByRole('checkbox', { name: `Mark done: water the ferns ${id}` }).click();
  await expect(page.getByRole('checkbox', { name: `Mark not done: water the ferns ${id}` })).toBeVisible();
  await expect(page.getByRole('checkbox', { name: `Mark done: water the ferns ${id}` })).toBeVisible();
  await expect(page.locator('.task-row.is-done .task-done-on')).toContainText('Done');
  await expect(page.locator('.task-row:not(.is-done) .task-repeat').first()).toHaveText('Every week');

  // Back closes Settings, and stays on Tasks.
  await openSettings(page, 'General');
  const settings = page.getByRole('dialog', { name: 'Settings' });
  await expect(settings).toBeVisible();
  await page.goBack();
  await expect(settings).toBeHidden();
  await expect(page).toHaveURL(/\/tasks/);
  await expect(page).toHaveTitle('Tasks – Lumen');
});
