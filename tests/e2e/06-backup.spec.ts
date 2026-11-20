/**
 * Journey 6, backup and restore on the encrypted library: Settings → Data and backup → Download backup
 * gives an encrypted .lumenbackup file; after a note changes, restoring that file puts the note back as
 * it was, and the text it replaced is kept in the note's history.
 */
import fs from 'node:fs';
import { strFromU8, unzipSync } from 'fflate';
import { bootstrap, closeSettings, createNote, currentNoteId, dialog, expectSaved, focusEnd, menuItem, noteText, openEncrypted, openSettings, rawNote, toasts, typeText } from './app';
import { expect, test } from './fixtures';

test('download an encrypted backup, change a note, restore it, and find the change in history', async ({ page }, testInfo) => {
  await openEncrypted(page);
  await createNote(page, 'Backup canary', 'Version one of the canary');
  const id = currentNoteId(page);

  await openSettings(page, 'Data and backup');
  await expect(page.getByText('An encrypted file of every note, image and drawing.')).toBeVisible();
  const downloading = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download backup' }).click();
  const download = await downloading;
  expect(download.suggestedFilename()).toMatch(/\.lumenbackup$/);
  const file = testInfo.outputPath(download.suggestedFilename());
  await download.saveAs(file);
  await expect(toasts(page).getByText('Encrypted backup downloaded')).toBeVisible();
  // The settings now say when the last backup was.
  await expect(page.getByText(/Last backup (just now|\d+ (second|minute)s? ago)/)).toBeVisible();

  // Lumen's own encrypted format: nothing in it is readable.
  const bytes = fs.readFileSync(file);
  expect(bytes.subarray(0, 8).toString('latin1')).toBe('LUMENBK1');
  expect(bytes.includes(Buffer.from('canary'))).toBe(false);
  expect(bytes.includes(Buffer.from('PK\u0003\u0004', 'latin1'))).toBe(false);
  await closeSettings(page);

  // The note changes after the backup.
  await focusEnd(page);
  await typeText(page, '\nChanged after the backup');
  await expectSaved(page);

  // Restore: the backup's version of the note comes back.
  await openSettings(page, 'Data and backup');
  const choosing = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Choose file' }).first().click();
  await (await choosing).setFiles(file);
  const confirm = dialog(page, 'Restore from this backup?');
  await expect(confirm).toContainText(download.suggestedFilename());
  await confirm.getByRole('button', { name: 'Restore', exact: true }).click();
  // This device is unlocked with the backup's key, so it opens without asking for the passphrase.
  await expect(toasts(page).getByText(/^Restored \d+ notes?, \d+ files? and \d+ drawings?\.$/)).toBeVisible({ timeout: 30_000 });
  await expect(dialog(page, 'Unlock this backup')).toHaveCount(0);
  await closeSettings(page);

  // The note open behind Settings follows the restore by itself…
  expect(currentNoteId(page)).toBe(id);
  await expect(noteText(page)).not.toContainText('Changed after the backup');
  await expect(noteText(page)).toContainText('Version one of the canary');
  // …and so does a fresh load of it.
  await page.reload();
  await expect(noteText(page)).toContainText('Version one of the canary');
  await expect(noteText(page)).not.toContainText('Changed after the backup');

  // What the restore replaced is in the note's history.
  await page.getByRole('button', { name: 'More', exact: true }).click();
  await menuItem(page, 'Version history').click();
  const history = dialog(page, 'Version history');
  await history.locator('.history-item').first().click();
  await history.getByRole('radio', { name: 'Preview' }).click();
  await expect(history.locator('.history-preview')).toContainText('Changed after the backup');
});

test('restore an earlier version from the note’s history', async ({ page }) => {
  await openEncrypted(page);
  await createNote(page, 'Essay', 'First draft of the essay');
  // A second save: the server keeps the first text as a snapshot (the first one of a note's text).
  await focusEnd(page);
  await typeText(page, '\nA second paragraph, later regretted');
  await expectSaved(page);

  await page.getByRole('button', { name: 'More', exact: true }).click();
  await menuItem(page, 'Version history').click();
  const history = dialog(page, 'Version history');
  await expect(history.locator('.history-item')).toHaveCount(1);
  await history.locator('.history-item').first().click();
  // What restoring it would change: the second paragraph goes.
  await expect(history.getByRole('table', { name: 'Changes' }).locator('.is-add', { hasText: 'A second paragraph, later regretted' })).toBeVisible();
  await history.getByRole('button', { name: 'Restore this version' }).click();
  const confirm = dialog(page, 'Restore this version?');
  await confirm.getByRole('button', { name: 'Restore version' }).click();
  await expect(toasts(page).getByText('Version restored')).toBeVisible();
  await expect(history).toBeHidden();

  await expect(noteText(page)).toContainText('First draft of the essay');
  await expect(noteText(page)).not.toContainText('A second paragraph');
  await expectSaved(page);
  await page.reload();
  await expect(noteText(page)).toContainText('First draft of the essay');
  await expect(noteText(page)).not.toContainText('A second paragraph');

  // The text it replaced went into the history, so the restore can be undone the same way.
  await page.getByRole('button', { name: 'More', exact: true }).click();
  await menuItem(page, 'Version history').click();
  await expect(history.locator('.history-item')).toHaveCount(2);
  await history.locator('.history-item').first().click();
  await history.getByRole('radio', { name: 'Preview' }).click();
  await expect(history.locator('.history-preview')).toContainText('A second paragraph, later regretted');
});

test('a readable .zip backup restored into the encrypted library is encrypted as it goes in', async ({ page }, testInfo) => {
  await openEncrypted(page);
  const id = await createNote(page, 'Zip canary', 'Plain words in a readable backup');

  await openSettings(page, 'Data and backup');
  await page.getByRole('button', { name: 'Readable .zip' }).click();
  const warn = dialog(page, 'Download a readable copy?');
  await expect(warn).toContainText('anyone who gets the file can read every note');
  const downloading = page.waitForEvent('download');
  await warn.getByRole('button', { name: 'Download readable copy' }).click();
  const download = await downloading;
  expect(download.suggestedFilename()).toMatch(/\.zip$/);
  const file = testInfo.outputPath(download.suggestedFilename());
  await download.saveAs(file);
  await expect(toasts(page).getByText('Backup downloaded', { exact: true })).toBeVisible();
  // A .zip of Markdown files, readable anywhere, with the manifest Lumen restores from.
  const entries = unzipSync(new Uint8Array(fs.readFileSync(file)));
  expect(Object.keys(entries)).toContain('kb-backup.json');
  const markdown = Object.entries(entries).find(([name]) => name.endsWith('.md') && strFromU8(entries[name]).includes('Plain words in a readable backup'));
  expect(markdown, 'the note as a Markdown file').toBeTruthy();
  await closeSettings(page);

  await focusEnd(page);
  await typeText(page, '\nChanged since the zip');
  await expectSaved(page);

  await openSettings(page, 'Data and backup');
  const choosing = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Choose file' }).first().click();
  await (await choosing).setFiles(file);
  await dialog(page, 'Restore from this backup?').getByRole('button', { name: 'Restore', exact: true }).click();
  await expect(toasts(page).getByText(/^Restored \d+ notes/)).toBeVisible({ timeout: 30_000 });
  await closeSettings(page);

  await expect(noteText(page)).toContainText('Plain words in a readable backup');
  await expect(noteText(page)).not.toContainText('Changed since the zip');
  // Stored encrypted, like everything else in this library.
  const raw = await rawNote(page, id);
  expect(raw.enc).toBe(true);
  expect(raw.content).toMatch(/^e1:/);
  expect(JSON.stringify(raw)).not.toContain('Plain words');
  expect(JSON.stringify(await bootstrap(page))).not.toContain('Zip canary');
});
