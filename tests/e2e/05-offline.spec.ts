/**
 * Journey 5, offline: with the connection gone, an edit is kept on the device and shown as not synced
 * (the note's save indicator, the sidebar's "not synced" list, the offline banner); once back online
 * it saves by itself, and another device reads it.
 */
import type { BrowserContext, Page } from '@playwright/test';
import { createNote, currentNoteId, dialog, expectSaved, focusEnd, listRow, listSearch, menuItem, noteText, openApp, openEncrypted, openSettings, rawNote, saveState, secrets, sidebar, toasts, typeText, unlock } from './app';
import { expect, test } from './fixtures';

/**
 * What Chrome logs while offline: each request that fails, and (ERR_FAILED) each one the service
 * worker answers with a failure because it had no copy to fall back on.
 */
const OFFLINE_ERRORS = [/ERR_INTERNET_DISCONNECTED/, /net::ERR_FAILED \(http:\/\/localhost:\d+\/api\//];

/**
 * A limit of simulating "offline" in Chrome: the save Lumen sends with `keepalive` as a page unloads
 * (a reload while offline, with an edit not yet sent) can still reach the server, past the offline
 * emulation (always, in testing) and even request routing (now and then). Back online, the next save
 * then gets 409 for a version this device made itself, which Lumen recognises (no conflict prompt) but
 * Chrome logs. No real offline device would send it; tests that reload while offline allow that log
 * line, and check that no conflict prompt appears.
 */
const UNLOAD_SAVE_LEAK = /status of 409 \(Conflict\)/;
const conflictBanner = (page: Page) => page.getByRole('alert').filter({ hasText: 'Changed on another device' });

/** No connection: offline emulation, and every request to the API refused as well (see above). */
async function goOffline(context: BrowserContext) {
  await context.setOffline(true);
  await context.route('**/api/**', (route) => route.abort('internetdisconnected'));
}

/** Ids of the notes in this browser's own (encrypted) copy of the library, IndexedDB "lumen-notes". */
function storedNoteIds(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    // Only opened once the app has made it (opening it first would make an empty one).
    if (!(await indexedDB.databases()).some((d) => d.name === 'lumen-notes')) return [];
    return new Promise<string[]>((resolve) => {
      const req = indexedDB.open('lumen-notes');
      req.onsuccess = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('notes')) return resolve([]);
        const all = db.transaction('notes').objectStore('notes').getAllKeys();
        all.onsuccess = () => {
          db.close();
          resolve(all.result.map(String));
        };
      };
      req.onerror = () => resolve([]);
    });
  });
}

async function goOnline(context: BrowserContext) {
  await context.unrouteAll();
  await context.setOffline(false);
}

test('an edit made offline is kept, shown as not synced, and syncs on reconnecting', async ({ page, context, device, guard }) => {
  guard.allow(...OFFLINE_ERRORS);

  await openEncrypted(page);
  await createNote(page, 'Train notes', 'Left at nine');
  const id = currentNoteId(page);
  const before = await rawNote(page, id);

  await goOffline(context);
  await expect(page.getByRole('status').filter({ hasText: 'You’re offline. Edits are saved here and sync when you reconnect.' })).toBeVisible();

  await focusEnd(page);
  await typeText(page, '\nWritten in the tunnel');
  await expect(saveState(page)).toHaveClass(/is-offline/, { timeout: 15_000 });
  await expect(saveState(page)).toContainText('Offline');
  const marker = sidebar(page).getByRole('button', { name: '1 note not synced' });
  await expect(marker).toBeVisible();
  await marker.click();
  await expect(menuItem(page, /Train notes\s*Offline/)).toBeVisible();
  await page.keyboard.press('Escape');
  // Kept on the device meanwhile (encrypted at rest only once locked; it's unlocked here).
  expect(await page.evaluate(() => Object.keys(localStorage).some((k) => k.startsWith('kb.draft.')))).toBe(true);

  await goOnline(context);
  await expectSaved(page, 30_000);
  await expect(marker).toHaveCount(0);
  await expect(page.getByText('You’re offline.')).toHaveCount(0);
  expect(await page.evaluate(() => Object.keys(localStorage).some((k) => k.startsWith('kb.draft.')))).toBe(false);
  await expect.poll(async () => (await rawNote(page, id)).version).toBeGreaterThan(before.version);

  // Really on the server: another device reads it.
  const other = await device({ label: 'device 2' });
  expect(await openApp(other.page, `/note/${id}`)).toBe('locked');
  await unlock(other.page, secrets()!.passphrase);
  await expect(noteText(other.page)).toContainText('Written in the tunnel');
});

test('the app itself opens offline, with the unsynced edit still there', async ({ page, context, device, guard }) => {
  guard.allow(...OFFLINE_ERRORS, UNLOAD_SAVE_LEAK);

  await openEncrypted(page);
  await createNote(page, 'Cabin notes', 'No signal up here');
  const id = currentNoteId(page);
  // The service worker keeps the app for offline use from the first visit it controls.
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller), { timeout: 15_000 }).toBe(true);
  await page.reload();
  await expect(noteText(page)).toContainText('No signal up here');

  await goOffline(context);
  await focusEnd(page);
  await typeText(page, '\nWritten by candlelight');
  await expect(saveState(page)).toHaveClass(/is-offline/, { timeout: 15_000 });

  // Closed and opened again with no connection: the app, the unlocked key and the edit are all here.
  await page.reload();
  await expect(noteText(page)).toContainText('Written by candlelight', { timeout: 30_000 });
  await expect(page.getByRole('status').filter({ hasText: 'You’re offline.' })).toBeVisible();
  await expect(sidebar(page).getByRole('button', { name: '1 note not synced' })).toBeVisible();

  await goOnline(context);
  await expectSaved(page, 30_000);
  await expect(conflictBanner(page)).toHaveCount(0);
  const other = await device({ label: 'device 2' });
  expect(await openApp(other.page, `/note/${id}`)).toBe('locked');
  await unlock(other.page, secrets()!.passphrase);
  await expect(noteText(other.page)).toContainText('Written by candlelight');
});

test('locked while offline, the unsent edit is encrypted on the device, and comes back on unlocking', async ({ page, context, guard }) => {
  guard.allow(...OFFLINE_ERRORS, UNLOAD_SAVE_LEAK);

  const { passphrase } = await openEncrypted(page);
  await createNote(page, 'Locked diary', 'Dear diary');
  const id = currentNoteId(page);
  const before = await rawNote(page, id);
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller), { timeout: 15_000 }).toBe(true);
  await page.reload();
  await expect(noteText(page)).toContainText('Dear diary');

  await goOffline(context);
  await focusEnd(page);
  await typeText(page, '\nA secret written offline');
  await expect(saveState(page)).toHaveClass(/is-offline/, { timeout: 15_000 });

  // Lock now, still offline: the app reloads (from the service worker) to the unlock screen.
  await openSettings(page, 'Security');
  await page.getByRole('button', { name: 'Lock now' }).click();
  await expect(page.getByRole('heading', { name: 'Unlock your notes' })).toBeVisible({ timeout: 30_000 });
  // While locked, nothing this browser keeps holds the edit in readable form.
  const stored = await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }));
  expect(stored).not.toContain('secret written offline');
  expect(stored).not.toContain('Dear diary');
  expect(stored).not.toContain('Locked diary');

  // Unlocked again (offline: the passphrase is checked against the copy of the key kept here).
  await unlock(page, passphrase);
  // Back on the note it was locked on.
  expect(currentNoteId(page)).toBe(id);
  await expect(noteText(page)).toContainText('A secret written offline', { timeout: 30_000 });
  await expect(sidebar(page).getByRole('button', { name: '1 note not synced' })).toBeVisible();

  await goOnline(context);
  await expectSaved(page, 30_000);
  await expect(conflictBanner(page)).toHaveCount(0);
  await expect.poll(async () => (await rawNote(page, id)).version).toBeGreaterThan(before.version);
  await page.reload();
  await expect(noteText(page)).toContainText('A secret written offline');
});

test('every note opens offline, even one never opened on this device', async ({ page, context, device, guard }) => {
  guard.allow(...OFFLINE_ERRORS);
  const word = `lighthouse${Math.random().toString(36).slice(2, 6)}`;
  const far = `Far-away note ${word}`;

  // Written on another device: this one has never opened it.
  await openEncrypted(page);
  const other = await device({ label: 'device 2' });
  expect(await openApp(other.page)).toBe('locked');
  await unlock(other.page, secrets()!.passphrase);
  await createNote(other.page, far, `Only written on the other device, about the ${word}`);

  await page.reload();
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller), { timeout: 15_000 }).toBe(true);
  // This device keeps an encrypted copy of every note, brought up to date in the background a few
  // seconds after the list changes: wait for the new note to be in it.
  const farId = (await listRow(page, far).getAttribute('href'))!.split('/').pop()!;
  await expect.poll(() => storedNoteIds(page), { timeout: 30_000 }).toContain(farId);
  // Searching finds it by its text.
  await listSearch(page).fill(word);
  await expect(listRow(page, far)).toBeVisible();
  await listSearch(page).fill('');

  await goOffline(context);
  await page.reload();
  await expect(listRow(page, far)).toBeVisible({ timeout: 30_000 });
  await listRow(page, far).click();
  await expect(noteText(page)).toContainText(`Only written on the other device, about the ${word}`, { timeout: 15_000 });
  await goOnline(context);
});

test('an offline edit that clashes with a later one from another device: the later one shows, the offline one is kept in history', async ({ page, context, device, guard }) => {
  guard.allow(...OFFLINE_ERRORS, /status of 409 \(Conflict\)/);

  await openEncrypted(page);
  const recipe = `Shared recipe ${Math.random().toString(36).slice(2, 6)}`;
  const id = await createNote(page, recipe, 'Two eggs');
  await goOffline(context);
  await focusEnd(page);
  await typeText(page, '\nA pinch of salt (offline)');
  await expect(saveState(page)).toHaveClass(/is-offline/, { timeout: 15_000 });

  // Afterwards another device, online, adds a line in the same place.
  const other = await device({ label: 'device 2' });
  expect(await openApp(other.page, `/note/${id}`)).toBe('locked');
  await unlock(other.page, secrets()!.passphrase);
  await focusEnd(other.page);
  await typeText(other.page, '\nA spoon of sugar (other device)');
  await expectSaved(other.page);

  // Back online: one person picking up where they left off on the other device, so the later version
  // stays, without asking; the offline edit isn't lost, it's in the note's history.
  await goOnline(context);
  const told = toasts(page).getByText('was changed on another device after your edits here');
  await expect(told).toBeVisible({ timeout: 30_000 });
  await expect(conflictBanner(page)).toHaveCount(0);
  await expectSaved(page);
  await expect(noteText(page)).toContainText('A spoon of sugar (other device)');
  await expect(noteText(page)).not.toContainText('A pinch of salt (offline)');
  await toasts(page).getByRole('button', { name: 'Version history' }).click();
  const history = dialog(page, 'Version history');
  const items = history.locator('.history-item');
  await expect(items.first()).toBeVisible();
  let found = false;
  for (let i = 0; i < (await items.count()) && !found; i++) {
    await items.nth(i).click();
    await history.getByRole('radio', { name: 'Preview' }).click();
    found = ((await history.locator('.history-preview').textContent()) ?? '').includes('A pinch of salt (offline)');
  }
  expect(found).toBe(true);
  // Nothing more to send from here.
  await history.getByRole('button', { name: 'Close', exact: true }).first().click();
  await expect(page.getByRole('button', { name: /not synced/ })).toHaveCount(0);
});

test('an offline edit and another device’s edit to other lines of a note are combined on reconnecting', async ({ page, context, device, guard }) => {
  guard.allow(...OFFLINE_ERRORS, /status of 409 \(Conflict\)/);

  await openEncrypted(page);
  const title = `Packing ${Math.random().toString(36).slice(2, 6)}`;
  const id = await createNote(page, title, 'Passport\nCharger\nBook');
  await goOffline(context);
  // The first line, offline.
  await noteText(page).click();
  await page.keyboard.press('Control+Home');
  await page.keyboard.press('End');
  await typeText(page, ' (in the blue bag)');
  await expect(saveState(page)).toHaveClass(/is-offline/, { timeout: 15_000 });

  // The last line, on another device.
  const other = await device({ label: 'device 2' });
  expect(await openApp(other.page, `/note/${id}`)).toBe('locked');
  await unlock(other.page, secrets()!.passphrase);
  await focusEnd(other.page);
  await typeText(other.page, ' (the novel)');
  await expectSaved(other.page);

  await goOnline(context);
  await expect(toasts(page).getByText('Both sets of changes are kept')).toBeVisible({ timeout: 30_000 });
  await expect(conflictBanner(page)).toHaveCount(0);
  await expectSaved(page);
  await expect(noteText(page)).toContainText('Passport (in the blue bag)');
  await expect(noteText(page)).toContainText('Book (the novel)');
  await other.page.reload();
  await expect(noteText(other.page)).toContainText('Passport (in the blue bag)', { timeout: 15_000 });
  await expect(noteText(other.page)).toContainText('Book (the novel)');
});
