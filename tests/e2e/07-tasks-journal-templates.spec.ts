/**
 * Journey 7, on the encrypted library: Today's journal (made once, in a Journal folder, tagged
 * #journal, from the default journal template), a template made from the New menu and a note started
 * from it (placeholders filled in, title too), and ticking a task off in the Tasks view, which changes
 * the note it's in. Tasks in templates, and the journal's empty tick box, stay out of the Tasks view.
 */
import type { Page } from '@playwright/test';
import { currentNoteId, expectSaved, focusEnd, listRow, menu, menuItem, noteText, noteTitle, openEncrypted, preview, setMode, sidebar, typeText, waitLoaded } from './app';
import { expect, test } from './fixtures';

const todayIn = (page: Page) =>
  page.evaluate(() => {
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  });

async function newMenu(page: Page) {
  await sidebar(page).getByRole('button', { name: 'Create something else' }).click();
  return menu(page);
}

test('journal, templates and ticking a task off in the Tasks view', async ({ page }) => {
  await openEncrypted(page);

  // Today's journal: an entry titled with today's date, in a Journal folder, tagged #journal.
  await sidebar(page).getByRole('button', { name: 'Today’s journal' }).click();
  const today = await todayIn(page);
  await expect(noteTitle(page)).toHaveValue(today);
  const journalId = currentNoteId(page);
  await expect(page.getByRole('button', { name: 'Journal, change folder' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Remove tag journal' })).toBeVisible();
  // Made from the default journal template: a Focus section with an empty tick box, and Notes.
  await expect(noteText(page)).toContainText('Focus');
  await expect(noteText(page)).toContainText('Notes');
  await expect(noteText(page).getByRole('checkbox')).toHaveCount(1);
  await focusEnd(page);
  await typeText(page, `- [ ] Water the plants due:${today}\n`);
  await expectSaved(page);

  // Asking again opens the same entry rather than a second one.
  await sidebar(page).getByRole('button', { name: 'Home', exact: true }).click();
  await sidebar(page).getByRole('button', { name: 'Today’s journal' }).click();
  await expect(noteTitle(page)).toHaveValue(today);
  expect(currentNoteId(page)).toBe(journalId);
  await expect(noteText(page)).toContainText('Water the plants');

  // A template, from the New menu: it goes in a Templates folder.
  await newMenu(page);
  await menuItem(page, 'New template').click();
  await expect(page.getByRole('button', { name: 'Templates, change folder' })).toBeVisible();
  await noteTitle(page).fill('Standup {{date}}');
  await noteTitle(page).press('Enter');
  await expect(noteText(page)).toBeFocused();
  await typeText(page, '## Yesterday\n\n- [ ] Follow up on {{title}}\n');
  await expectSaved(page);

  // A note from that template: the placeholders are filled in, the title's too, outside Templates.
  await newMenu(page);
  await menuItem(page, 'Standup {{date}}').click();
  await expect(noteTitle(page)).toHaveValue(`Standup ${today}`);
  await expect(noteText(page)).toContainText(`Follow up on Standup ${today}`);
  await expect(page.getByRole('button', { name: 'No folder, change folder' })).toBeVisible();
  await expectSaved(page);

  // The Tasks view: the journal's task and the new note's, but not the template's own task, nor the
  // journal's empty tick box.
  await sidebar(page).getByRole('button', { name: /^Tasks/ }).click();
  const tasks = page.getByRole('region', { name: 'Tasks' });
  await expect(tasks.getByRole('heading', { name: 'Tasks', level: 1 })).toBeVisible();
  const water = tasks.getByRole('checkbox', { name: 'Mark done: Water the plants' });
  await expect(water).toBeVisible({ timeout: 15_000 });
  await expect(tasks.getByRole('region', { name: 'Today' }).getByRole('checkbox', { name: 'Mark done: Water the plants' })).toBeVisible();
  await expect(tasks.getByRole('checkbox', { name: `Mark done: Follow up on Standup ${today}` })).toBeVisible();
  await expect(tasks.getByRole('checkbox', { name: /Follow up on \{\{title\}\}/ })).toHaveCount(0);
  await expect(tasks.getByRole('checkbox', { name: /Untitled task/ })).toHaveCount(0);

  // Tick it off here: it stays, struck through, until the view is left, and the note changes.
  await water.check();
  await expect(tasks.getByRole('checkbox', { name: 'Mark not done: Water the plants' })).toBeChecked();
  await sidebar(page).getByRole('button', { name: 'All notes', exact: false }).first().click();
  await listRow(page, today).click();
  await expect(noteText(page).getByRole('checkbox', { name: 'Mark task not done' })).toHaveCount(1);
  await expectSaved(page);

  // After a reload (the change reached the server), the task is done and gone from the open tasks.
  await page.reload();
  await waitLoaded(page);
  await sidebar(page).getByRole('button', { name: /^Tasks/ }).click();
  await expect(tasks.getByRole('checkbox', { name: `Mark done: Follow up on Standup ${today}` })).toBeVisible({ timeout: 15_000 });
  await expect(tasks.getByRole('checkbox', { name: /Water the plants/ })).toHaveCount(0);
  await tasks.getByRole('radio', { name: 'All' }).click();
  await expect(tasks.getByRole('checkbox', { name: 'Mark not done: Water the plants' })).toBeChecked();

  // A task in a note not opened since the reload: ticked from here, from the device's copy of it.
  await tasks.getByRole('radio', { name: 'Open' }).click();
  await tasks.getByRole('checkbox', { name: `Mark done: Follow up on Standup ${today}` }).check();
  await expect(tasks.getByRole('checkbox', { name: `Mark not done: Follow up on Standup ${today}` })).toBeChecked();
  await tasks.getByRole('button', { name: `Follow up on Standup ${today}` }).first().click();
  await expect(noteTitle(page)).toHaveValue(`Standup ${today}`);
  // Opened at the task's line, with the cursor on it (so shown as Markdown there).
  await expect(noteText(page)).toContainText(`- [x] Follow up on Standup ${today}`);
  await expectSaved(page);
  await page.reload();
  await setMode(page, 'Read');
  await expect(preview(page).getByRole('checkbox')).toBeChecked();
  await expect(page.getByRole('alert')).toHaveCount(0);
});
