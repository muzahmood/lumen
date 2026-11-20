/**
 * Journey 8, sharing into Lumen (the web app manifest's share target), on the encrypted library: a
 * multipart form POSTed to /share, as a phone's share sheet sends it, is kept by the service worker and
 * the app asks before saving it ("Save what was shared?"); saved, it's a note with the text, the link
 * and the file attached (encrypted on the server, decrypted when opened).
 */
import type { Page } from '@playwright/test';
import { currentNoteId, dialog, listRow, noteTitle, openEncrypted, preview, toasts, waitLoaded } from './app';
import { expect, test } from './fixtures';

const SHARED = {
  title: 'Moss gardens of Kyoto',
  text: 'Worth a visit in the rainy season.',
  url: 'https://example.com/kyoto-moss',
  file: { name: 'field-notes.txt', type: 'text/plain', body: 'Saiho-ji has over a hundred kinds of moss.' },
};

type Share = { title: string; text: string; url: string; file?: { name: string; type: string; body: string } };

/** What a share sheet sends: a multipart form POSTed to /share (title, text, url and files). */
async function share(page: Page, shared: Share) {
  // Shares are received by the service worker, so it must be in control of the page.
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller), { timeout: 15_000 }).toBe(true);
  await page.evaluate((shared) => {
    const form = document.createElement('form');
    form.method = 'POST';
    form.action = '/share';
    form.enctype = 'multipart/form-data';
    for (const name of ['title', 'text', 'url'] as const) {
      const input = document.createElement('input');
      input.type = 'hidden';
      input.name = name;
      input.value = shared[name];
      form.append(input);
    }
    if (shared.file) {
      const files = document.createElement('input');
      files.type = 'file';
      files.name = 'files';
      const dt = new DataTransfer();
      dt.items.add(new File([shared.file.body], shared.file.name, { type: shared.file.type }));
      files.files = dt.files;
      form.append(files);
    }
    document.body.append(form);
    form.submit();
  }, shared);
}

/** Shares waiting on this device to be saved or discarded. */
const waiting = (page: Page) => page.evaluate(async () => (await (await caches.open('kb-share')).keys()).length);

test('something shared to Lumen is offered, then saved as a note with its file', async ({ page, context }) => {
  await openEncrypted(page);
  await share(page, SHARED);

  // The service worker answers with the app, which asks first.
  const ask = dialog(page, 'Save what was shared?');
  await expect(ask).toBeVisible({ timeout: 30_000 });
  await expect(ask).toContainText(SHARED.title);
  await expect(ask).toContainText(SHARED.text);
  await expect(ask).toContainText(SHARED.url);
  await expect(ask).toContainText(`1 file: ${SHARED.file.name}`);
  for (const name of ['Later', 'Discard', 'Save as a note']) await expect(ask.getByRole('button', { name })).toBeVisible();
  // The address no longer carries the share, so a reload doesn't do it again.
  await expect(page).toHaveURL(/\/$/);
  await waitLoaded(page);

  await ask.getByRole('button', { name: 'Save as a note' }).click();
  await expect(toasts(page).getByText('Saved what was shared, with a file')).toBeVisible({ timeout: 30_000 });

  // The note: titled from the share, with its text, the link and the file, shown in reading view.
  await expect(noteTitle(page)).toHaveValue(SHARED.title);
  const doc = preview(page);
  await expect(doc).toContainText(SHARED.text);
  await expect(doc.getByRole('link', { name: SHARED.title })).toHaveAttribute('href', SHARED.url);
  const attachment = doc.getByRole('link', { name: new RegExp(SHARED.file.name.replace('.', '\\.')) });
  await expect(attachment).toBeVisible();
  const href = (await attachment.getAttribute('href'))!;
  expect(href).toMatch(/^\/api\/files\//);

  // On the server the file is ciphertext…
  const stored = await page.evaluate(async (url) => new Uint8Array(await (await fetch(url, { headers: { 'x-kb-client': '1' } })).arrayBuffer()).length, href);
  expect(stored).toBeGreaterThan(0);
  const storedText = await page.evaluate(async (url) => (await (await fetch(url)).text()), href);
  expect(storedText).not.toContain('Saiho-ji');

  // …and opening it from the note decrypts it, in a tab of its own.
  const opening = context.waitForEvent('page');
  await attachment.click();
  const tab = await opening;
  await expect(tab.locator('body')).toContainText(SHARED.file.body, { timeout: 15_000 });
  await tab.close();

  // Saved once: nothing is left waiting on the device to be offered again.
  await expect.poll(() => waiting(page)).toBe(0);
  const id = currentNoteId(page);
  await page.reload();
  await waitLoaded(page);
  await expect(noteTitle(page)).toHaveValue(SHARED.title);
  expect(currentNoteId(page)).toBe(id);
  await expect(dialog(page, 'Save what was shared?')).toHaveCount(0);
});

test('a share left for later is offered again; a discarded one is gone', async ({ page }) => {
  await openEncrypted(page);
  const later = { title: 'A recipe to try later', text: 'Miso-glazed aubergine', url: '' };
  await share(page, later);
  const ask = dialog(page, 'Save what was shared?');
  await expect(ask).toContainText(later.title);
  await ask.getByRole('button', { name: 'Later' }).click();
  await expect(ask).toBeHidden();
  expect(await waiting(page)).toBeGreaterThan(0);

  // Next time the app opens, it asks again.
  await page.reload();
  await expect(ask).toBeVisible({ timeout: 30_000 });
  await expect(ask).toContainText(later.title);
  await ask.getByRole('button', { name: 'Discard' }).click();
  await expect(ask).toBeHidden();
  await expect.poll(() => waiting(page)).toBe(0);
  await expect(listRow(page, later.title)).toHaveCount(0);

  await page.reload();
  await waitLoaded(page);
  expect(await waiting(page)).toBe(0);
  await expect(dialog(page, 'Save what was shared?')).toHaveCount(0);
});
