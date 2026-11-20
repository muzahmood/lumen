/**
 * Journey 3, end-to-end encryption (run second, so every later journey works on an encrypted library,
 * as the owner keeps it): set up with a passphrase and recovery key; the server then hands out only
 * ciphertext; lock; a wrong passphrase is refused; unlock; and a second device that has only the
 * recovery key gets in and sets a new passphrase, which from then on replaces the old one.
 */
import {
  bootstrap,
  createNote,
  dialog,
  expectSaved,
  focusEnd,
  folderItem,
  listRow,
  menuItem,
  newFolder,
  noteText,
  noteTitle,
  openApp,
  openEncrypted,
  openSettings,
  PASSPHRASE,
  rawNote,
  saveSecrets,
  setUpEncryption,
  sidebar,
  toasts,
  unlock,
  waitLoaded,
} from './app';
import { expect, test } from './fixtures';

const NEW_PASSPHRASE = 'lumen e2e passphrase two';
const SECRET_TITLE = 'Treasure map';
const SECRET_TEXT = 'The chest is buried under the old oak tree';
// A 1×1 PNG.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

/** The server's bytes for an uploaded file, past the service worker. */
const fileBytes = (page: import('@playwright/test').Page, id: string) =>
  page.evaluate(async (fileId) => Array.from(new Uint8Array(await (await fetch(`/api/files/${fileId}?fresh=${Date.now()}`)).arrayBuffer()).slice(0, 8)), id);

test('encrypt the library, lock it, and unlock it on this and a second device', async ({ page, device }) => {
  expect(await openApp(page)).toBe('ready');
  const id = await createNote(page, SECRET_TITLE, SECRET_TEXT);
  // Before encryption the note is filed in a folder, tagged, and has an image: all stored as they are.
  await newFolder(page, 'Hideout');
  await listRow(page, SECRET_TITLE).click();
  await page.getByRole('button', { name: 'No folder, change folder' }).click();
  await menuItem(page, 'Hideout').click();
  await page.getByRole('textbox', { name: 'Add tag' }).fill('pirate');
  await page.getByRole('textbox', { name: 'Add tag' }).press('Enter');
  await focusEnd(page);
  const choosing = page.waitForEvent('filechooser');
  await page.getByRole('toolbar', { name: 'Formatting' }).getByRole('button', { name: 'Image' }).click();
  await (await choosing).setFiles({ name: 'compass-rose.png', mimeType: 'image/png', buffer: PNG });
  await expect.poll(async () => (await rawNote(page, id)).content, { timeout: 15_000 }).toMatch(/!\[compass rose\]\(\/api\/files\/[A-Za-z0-9_-]+/);
  await expectSaved(page);
  const plain = await rawNote(page, id);
  expect(plain.title).toBe(SECRET_TITLE);
  expect(plain.tags).toEqual(['pirate']);
  const fileId = /\/api\/files\/([A-Za-z0-9_-]+)/.exec(plain.content)![1];
  expect(await fileBytes(page, fileId)).toEqual([...PNG.subarray(0, 8)]);
  expect(JSON.stringify((await bootstrap(page)).folders)).toContain('Hideout');

  // A passphrase that's too short, or typed differently twice, is caught before anything changes.
  await openSettings(page, 'Security');
  await page.getByRole('button', { name: 'Set up encryption' }).click();
  await page.getByRole('textbox', { name: 'Passphrase', exact: true }).fill(PASSPHRASE);
  await page.getByRole('textbox', { name: 'Passphrase again' }).fill(`${PASSPHRASE}!`);
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('alert')).toHaveText('The two passphrases don’t match.');
  await page.getByRole('button', { name: 'Cancel' }).click();
  await page.getByRole('button', { name: 'Close settings' }).click();

  const recoveryKey = await setUpEncryption(page, PASSPHRASE);
  expect(recoveryKey).toMatch(/^[A-Z0-9]{4}(-[A-Z0-9]{4})+$/);

  // This device shows everything decrypted: the note, its folder, its tag and its image.
  await expect(listRow(page, SECRET_TITLE)).toBeVisible();
  await listRow(page, SECRET_TITLE).click();
  await expect(noteTitle(page)).toHaveValue(SECRET_TITLE);
  await expect(page.locator('.note-pane')).toContainText(SECRET_TEXT);
  await expect(page.getByRole('button', { name: 'Hideout, change folder' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Remove tag pirate' })).toBeVisible();
  await expect(folderItem(page, 'Hideout')).toBeVisible();
  await expect(sidebar(page).getByRole('region', { name: 'Tags' }).getByRole('button', { name: /^pirate/ })).toBeVisible();
  await page.getByRole('radiogroup', { name: 'View' }).getByRole('radio', { name: 'Read' }).click();
  const image = page.locator('.kb-prose').getByRole('img', { name: 'compass rose' });
  await expect(image).toHaveAttribute('src', /^blob:/, { timeout: 15_000 });
  await expect.poll(() => image.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth)).toBe(1);

  // …while the server only ever hands out ciphertext: titles, previews, tags and text.
  const data = await bootstrap(page);
  expect(data.encryption?.on).toBe(true);
  expect(data.notes.length).toBeGreaterThan(0);
  const everything = JSON.stringify(data);
  for (const plain of [SECRET_TITLE, 'buried under', 'Welcome to Lumen', '"guide"', 'Hideout', 'pirate', 'compass']) expect(everything).not.toContain(plain);
  for (const f of data.folders) {
    expect(f.enc, `folder ${f.id} is encrypted`).toBe(true);
    expect(f.name).toBe('');
  }
  // The image too: no longer a PNG on the server.
  const stored = await fileBytes(page, fileId);
  expect(stored.length).toBeGreaterThan(0);
  expect(stored).not.toEqual([...PNG.subarray(0, 8)]);
  // And the note's history, kept from before encryption.
  const versions = await page.evaluate(async (noteId) => (await fetch(`/api/notes/${noteId}/versions?fresh=1`, { headers: { 'x-kb-client': '1' } })).text(), id);
  expect(versions).not.toContain('oak tree');
  expect(versions).not.toContain(SECRET_TITLE);
  for (const n of data.notes) {
    // The readable fields are empty; title, tags and preview travel sealed ("e1:" + AES-GCM, base64url).
    expect(n.enc, `note ${n.id} is encrypted`).toBe(true);
    expect(n.title).toBe('');
    expect(n.excerpt).toBe('');
    expect(n.tags).toEqual([]);
    const sealed = n.sealed as Record<string, string>;
    expect(sealed.t).toMatch(/^e1:[A-Za-z0-9_-]+$/);
    for (const value of Object.values(sealed)) expect(value).toMatch(/^e1:/);
  }
  const raw = await rawNote(page, id);
  expect(raw.enc).toBe(true);
  expect(raw.title).toBe('');
  expect(raw.content).toMatch(/^e1:[A-Za-z0-9_-]+$/);
  expect(JSON.stringify(raw)).not.toContain('oak tree');

  // Lock: back to the unlock screen, the key gone from this browser.
  await openSettings(page, 'Security');
  await page.getByRole('button', { name: 'Lock now' }).click();
  await expect(page.getByRole('heading', { name: 'Unlock your notes' })).toBeVisible();
  await expect(page.getByText(SECRET_TITLE)).toHaveCount(0);

  // A wrong passphrase is refused, and says so.
  await page.getByRole('textbox', { name: 'Passphrase' }).fill('not the passphrase at all');
  await page.getByRole('button', { name: 'Unlock', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('That passphrase didn’t unlock your notes');
  await expect(page.getByRole('heading', { name: 'Unlock your notes' })).toBeVisible();

  // The right one opens the notes again.
  await unlock(page, PASSPHRASE);
  await expect(listRow(page, SECRET_TITLE)).toBeVisible();

  // A second device, with only the recovery key: it gets in and sets a new passphrase.
  const second = await device({ label: 'device 2' });
  expect(await openApp(second.page)).toBe('locked');
  await second.page.getByRole('button', { name: 'Forgot your passphrase?' }).click();
  await expect(second.page.getByRole('heading', { name: 'Use your recovery key' })).toBeVisible();
  await second.page.getByRole('textbox', { name: 'Recovery key' }).fill(recoveryKey);
  await second.page.getByRole('textbox', { name: 'New passphrase', exact: true }).fill(NEW_PASSPHRASE);
  await second.page.getByRole('textbox', { name: 'New passphrase again' }).fill(NEW_PASSPHRASE);
  await second.page.getByRole('button', { name: 'Unlock and save passphrase' }).click();
  await expect(toasts(second.page).getByText('Unlocked. Your new passphrase works on every device.')).toBeVisible();
  await waitLoaded(second.page);
  saveSecrets({ passphrase: NEW_PASSPHRASE, recoveryKey });
  await listRow(second.page, SECRET_TITLE).click();
  await expect(second.page.locator('.note-pane')).toContainText(SECRET_TEXT);

  // From now on the new passphrase is the one: the old one no longer opens the library.
  await openSettings(second.page, 'Security');
  await second.page.getByRole('button', { name: 'Lock now' }).click();
  await second.page.getByRole('textbox', { name: 'Passphrase' }).fill(PASSPHRASE);
  await second.page.getByRole('button', { name: 'Unlock', exact: true }).click();
  await expect(second.page.getByRole('alert')).toContainText('That passphrase didn’t unlock your notes');
  await unlock(second.page, NEW_PASSPHRASE);
  await expect(listRow(second.page, SECRET_TITLE)).toBeVisible();

  // The first device stayed unlocked throughout, and still reads the note.
  await page.reload();
  await waitLoaded(page);
  await listRow(page, SECRET_TITLE).click();
  await expect(noteText(page).or(page.locator('.kb-prose')).first()).toContainText(SECRET_TEXT);
});

test('Lock automatically: the device locks itself after the chosen time without use', async ({ page }) => {
  // The page's clock is Playwright's, so a quarter of an hour can pass in a moment.
  await page.clock.install();
  const { passphrase } = await openEncrypted(page);
  await openSettings(page, 'Security');
  const auto = page.getByRole('combobox', { name: 'Lock automatically' });
  await auto.selectOption({ label: 'After 15 minutes' });
  await expect(auto).toHaveValue('15');
  await page.getByRole('button', { name: 'Close settings' }).click();

  // Ten idle minutes: still open.
  await page.clock.fastForward('10:00');
  await expect(page.getByRole('heading', { name: 'Unlock your notes' })).toHaveCount(0);
  // Past fifteen: locked, and the passphrase is needed again.
  await page.clock.fastForward('06:00');
  await expect(page.getByRole('heading', { name: 'Unlock your notes' })).toBeVisible({ timeout: 15_000 });
  await unlock(page, passphrase);

  // Per device, and left as it was for the rest of the suite.
  await openSettings(page, 'Security');
  await expect(auto).toHaveValue('15');
  await auto.selectOption({ label: 'Never' });
  await page.getByRole('button', { name: 'Close settings' }).click();
});

test('locking one tab locks the others, unlocking one opens them, and signing out clears this browser', async ({ page, context }) => {
  const { passphrase } = await openEncrypted(page);
  await createNote(page, 'Note in two tabs', 'Seen from both tabs');
  const tab = await context.newPage();
  // The same browser: the second tab opens unlocked, from the key the first one stored.
  expect(await openApp(tab)).toBe('ready');
  await expect(listRow(tab, 'Note in two tabs')).toBeVisible();

  await openSettings(page, 'Security');
  await page.getByRole('button', { name: 'Lock now' }).click();
  await expect(page.getByRole('heading', { name: 'Unlock your notes' })).toBeVisible();
  await expect(tab.getByRole('heading', { name: 'Unlock your notes' })).toBeVisible({ timeout: 15_000 });
  await expect(tab.getByText('Note in two tabs')).toHaveCount(0);

  await unlock(page, passphrase);
  await waitLoaded(tab);
  await expect(listRow(tab, 'Note in two tabs')).toBeVisible();

  // Sign out of this device (from the second tab): both tabs leave, and nothing of the library stays.
  await openSettings(tab, 'Security');
  await tab.getByRole('button', { name: 'Sign out', exact: true }).click();
  await dialog(tab, 'Sign out of this device?').getByRole('button', { name: 'Sign out', exact: true }).click();
  for (const p of [page, tab]) await expect(p.getByRole('heading', { name: 'Unlock your notes' })).toBeVisible({ timeout: 30_000 });
  const left = await page.evaluate(async () => {
    const dbs = (await indexedDB.databases()).map((d) => d.name);
    const kept: string[] = [];
    for (const name of await caches.keys()) {
      for (const req of await (await caches.open(name)).keys()) {
        const path = new URL(req.url).pathname;
        if (path.startsWith('/api/')) kept.push(path);
      }
    }
    return { dbs, kept, storage: Object.keys(localStorage).filter((k) => k.startsWith('kb.') && k !== 'kb.settings') };
  });
  // No key, no copy of the notes, no cached notes or files: the passphrase is needed again.
  expect(left.dbs).not.toContain('lumen-notes');
  expect(left.kept.filter((p) => p.startsWith('/api/notes') || p.startsWith('/api/files') || p.startsWith('/api/drawings'))).toEqual([]);
  expect(left.storage.filter((k) => k.startsWith('kb.draft.') || k === 'kb.vault.sealed')).toEqual([]);
  await unlock(page, passphrase);
  await expect(listRow(page, 'Note in two tabs')).toBeVisible();
});
