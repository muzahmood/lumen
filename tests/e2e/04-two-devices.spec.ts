/**
 * Journey 4, two devices: a second device (browser context) edits a note the first has open; the first
 * device's next edit is then refused by the server (409) and it shows the conflict banner. Compare
 * shows both versions; Keep mine keeps this device's text and puts the other device's in the note's
 * history; the second device then sees the kept text.
 */
import { currentNoteId, createNote, dialog, expectSaved, focusEnd, listRow, listSearch, menuItem, noteText, noteTitle, openApp, openEncrypted, rawNote, secrets, toasts, typeText, unlock } from './app';
import { expect, test } from './fixtures';

test('an edit from another device brings up the conflict banner, and Keep mine keeps theirs in history', async ({ page, device, guard }) => {
  // The first device's save that collides is refused with 409 Conflict, which Chrome logs.
  guard.allow(/status of 409 \(Conflict\)/);

  await openEncrypted(page);
  await createNote(page, 'Shared shopping list', 'Milk');
  const id = currentNoteId(page);

  // The second device opens the same note and adds a line; it saves.
  const other = await device({ label: 'device 2' });
  expect(await openApp(other.page, `/note/${id}`)).toBe('locked');
  await unlock(other.page, secrets()!.passphrase);
  await expect(noteText(other.page)).toContainText('Milk');
  await focusEnd(other.page);
  await typeText(other.page, '\nBread from device two');
  await expectSaved(other.page);

  // The first device still shows its copy and edits it: the server says it changed meanwhile.
  await expect(noteText(page)).not.toContainText('Bread');
  await focusEnd(page);
  await typeText(page, '\nCheese from device one');
  const banner = page.getByRole('alert').filter({ hasText: 'Changed on another device' });
  await expect(banner).toBeVisible({ timeout: 15_000 });
  await expect(banner).toContainText('Choose which version to keep.');
  await expect(page.locator('.note-header .save-state')).toHaveClass(/is-error/);
  await expect(page.locator('.note-header .save-state')).toContainText('Conflict');
  for (const name of ['Compare', 'Keep mine', 'Keep both', 'Use theirs']) await expect(banner.getByRole('button', { name })).toBeVisible();
  // The note waits in the sidebar's "not synced" list until a version is chosen.
  await expect(page.getByRole('button', { name: '1 note not synced' })).toBeVisible();

  // Compare shows both versions, line by line.
  await banner.getByRole('button', { name: 'Compare' }).click();
  const compare = dialog(page, 'Compare the two versions');
  await expect(compare).toBeVisible();
  await expect(compare).toContainText('Theirs (saved on the other device)');
  await expect(compare).toContainText('Mine (on this device)');
  const changes = compare.getByRole('table', { name: 'Changes' });
  await expect(changes.locator('.is-del', { hasText: 'Bread from device two' })).toBeVisible();
  await expect(changes.locator('.is-add', { hasText: 'Cheese from device one' })).toBeVisible();

  // Keep mine: this device's text wins, and saves.
  await compare.getByRole('button', { name: 'Keep mine' }).click();
  await expect(compare).toBeHidden();
  await expect(banner).toBeHidden();
  await expectSaved(page);
  await expect(page.getByRole('button', { name: '1 note not synced' })).toHaveCount(0);
  await expect(noteText(page)).toContainText('Cheese from device one');
  await expect(noteText(page)).not.toContainText('Bread from device two');

  // Theirs is kept in the note's history.
  await page.getByRole('button', { name: 'More', exact: true }).click();
  await menuItem(page, 'Version history').click();
  const history = dialog(page, 'Version history');
  await expect(history.locator('.history-item').first()).toBeVisible();
  await history.locator('.history-item').first().click();
  await history.getByRole('radio', { name: 'Preview' }).click();
  await expect(history.locator('.history-preview')).toContainText('Bread from device two');
  await history.getByRole('button', { name: 'Close', exact: true }).first().click();

  // The second device, opening the note again, gets the kept version.
  await other.page.reload();
  await expect(noteText(other.page)).toContainText('Cheese from device one', { timeout: 15_000 });
  await expect(noteText(other.page)).not.toContainText('Bread from device two');
});

test('the other answers to a conflict: Use theirs, and Keep both', async ({ page, device, guard }) => {
  guard.allow(/status of 409 \(Conflict\)/);

  await openEncrypted(page);
  const theirsId = await createNote(page, 'Packing list', 'Passport');
  const bothId = await createNote(page, 'Gift ideas', 'A good pen');
  const other = await device({ label: 'device 2' });
  expect(await openApp(other.page, `/note/${theirsId}`)).toBe('locked');
  await unlock(other.page, secrets()!.passphrase);

  // Use theirs: this device's edit is dropped for the other device's text.
  await page.goto(`/note/${theirsId}`);
  await expect(noteText(page)).toContainText('Passport');
  await other.page.goto(`/note/${theirsId}`);
  await focusEnd(other.page);
  await typeText(other.page, '\nSunscreen');
  await expectSaved(other.page);
  await focusEnd(page);
  await typeText(page, '\nUmbrella');
  const banner = page.getByRole('alert').filter({ hasText: 'Changed on another device' });
  await expect(banner).toBeVisible({ timeout: 15_000 });
  await banner.getByRole('button', { name: 'Use theirs' }).click();
  await expect(banner).toBeHidden();
  await expectSaved(page);
  await expect(noteText(page)).toContainText('Sunscreen');
  await expect(noteText(page)).not.toContainText('Umbrella');
  // Editing on from their version saves normally: no second conflict.
  const version = (await rawNote(page, theirsId)).version;
  await focusEnd(page);
  await typeText(page, '\nA sun hat');
  await expectSaved(page);
  await expect(banner).toHaveCount(0);
  await expect.poll(async () => (await rawNote(page, theirsId)).version).toBe(version + 1);

  // Keep both: this device's version becomes a note of its own, and this note takes theirs.
  await page.getByRole('navigation', { name: 'Library' }).getByRole('button', { name: /^All notes/ }).click();
  await listRow(page, 'Gift ideas').click();
  await expect(noteText(page)).toContainText('A good pen');
  await other.page.goto(`/note/${bothId}`);
  await focusEnd(other.page);
  await typeText(other.page, '\nA scarf');
  await expectSaved(other.page);
  await focusEnd(page);
  await typeText(page, '\nA book');
  await expect(banner).toBeVisible({ timeout: 15_000 });
  await banner.getByRole('button', { name: 'Keep both' }).click();
  await expect(toasts(page).getByText('Your version was saved as a separate note')).toBeVisible();
  await expect(banner).toBeHidden();
  await expectSaved(page);
  expect(currentNoteId(page)).toBe(bothId);
  await expect(noteText(page)).toContainText('A scarf');
  await expect(noteText(page)).not.toContainText('A book');
  await listRow(page, 'Gift ideas (my version)').click();
  await expect(noteText(page)).toContainText('A book');
  await expect(noteText(page)).not.toContainText('A scarf');
});

test('a note deleted for good on another device keeps this device’s edits, as a new note', async ({ page, device, guard }) => {
  // This device's save of the deleted note is answered 404 Not Found.
  guard.allow(/status of 404 \(Not Found\)/);

  await openEncrypted(page);
  const id = await createNote(page, 'Doomed note', 'The original text');

  const other = await device({ label: 'device 2' });
  expect(await openApp(other.page, `/note/${id}`)).toBe('locked');
  await unlock(other.page, secrets()!.passphrase);
  await expect(noteText(other.page)).toContainText('The original text');
  await other.page.getByRole('button', { name: 'More', exact: true }).click();
  await menuItem(other.page, 'Move to trash').click();
  await other.page.goto(`/note/${id}`);
  await other.page.getByRole('button', { name: 'More', exact: true }).click();
  await menuItem(other.page, 'Delete forever').click();
  await dialog(other.page, 'Delete this note forever?').getByRole('button', { name: 'Delete forever' }).click();
  await expect(toasts(other.page).getByText('Note deleted forever')).toBeVisible();

  // This device, still showing it, adds a line: it becomes a new note rather than being lost.
  await focusEnd(page);
  await typeText(page, '\nLast words, kept');
  await expect(toasts(page).getByText('This note was deleted on another device, so your edits here were saved as a new note.')).toBeVisible({ timeout: 15_000 });
  await expect.poll(() => currentNoteId(page)).not.toBe(id);
  await expect(noteTitle(page)).toHaveValue('Doomed note');
  await expect(noteText(page)).toContainText('The original text');
  await expect(noteText(page)).toContainText('Last words, kept');
  await expectSaved(page);
  const copy = currentNoteId(page);
  await other.page.goto(`/note/${copy}`);
  await expect(noteText(other.page)).toContainText('Last words, kept');
});

test('a phone whose save landed as it locked, opened again after the computer carried on, shows the newest and asks nothing', async ({ page, device, guard }) => {
  // The phone's save that never hears back, and its next session's save, refused (409) for the newer version.
  guard.allow(/net::ERR_FAILED/, /status of 409 \(Conflict\)/);

  await openEncrypted(page);
  const id = await createNote(page, 'Groceries', 'Milk');

  // Unlocked once at Home (a phone showing a note has no tab bar to wait for), then the note.
  const phone = await device({ label: 'phone', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  expect(await openApp(phone.page)).toBe('locked');
  await unlock(phone.page, secrets()!.passphrase);
  await phone.page.goto(`/note/${id}`);
  await expect(noteText(phone.page)).toContainText('Milk', { timeout: 30_000 });

  // The phone's save reaches the server, but the reply never gets back (the phone locked), and the
  // page is gone before it tries again.
  let landed = false;
  await phone.context.route('**/api/notes/*', async (route) => {
    if (route.request().method() !== 'PATCH') return route.fallback();
    await route.fetch();
    landed = true;
    await route.abort('failed');
  });
  await focusEnd(phone.page);
  await typeText(phone.page, '\nEggs');
  await expect.poll(() => landed, { timeout: 15_000 }).toBe(true);
  await phone.page.close();
  await phone.context.unroute('**/api/notes/*');

  // On the computer: the phone's line is there, and that same line is changed further.
  await page.reload();
  await expect(noteText(page)).toContainText('Eggs', { timeout: 15_000 });
  await focusEnd(page);
  await typeText(page, ' (a dozen)');
  await expectSaved(page);

  // The phone, picked up hours later (its closed tab long gone): the computer's version, no question.
  const again = await phone.context.newPage();
  await again.addInitScript(() => {
    for (const k of Object.keys(localStorage)) if (k.startsWith('kb.tab.')) localStorage.setItem(k, '0');
  });
  // Still unlocked: this device keeps its key until it's locked.
  await again.goto(`/note/${id}`);
  await expect(noteText(again)).toContainText('Eggs (a dozen)', { timeout: 30_000 });
  await expectSaved(again);
  await expect(again.getByRole('alert').filter({ hasText: 'Changed on another device' })).toHaveCount(0);
  await expect(toasts(again).getByText(/after your edits here|Both sets of changes/)).toHaveCount(0);
  expect(await again.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('kb.draft.')))).toEqual([]);
  expect((await rawNote(again, id)).content).not.toBe('');

  // Back to the computer, still open: picked up again, it shows the phone's next edit before anything is typed.
  await focusEnd(again);
  await typeText(again, '\nBread');
  await expectSaved(again);
  await expect
    .poll(
      async () => {
        await page.evaluate(() => window.dispatchEvent(new Event('focus')));
        return noteText(page).textContent();
      },
      { timeout: 20_000, intervals: [1000] },
    )
    .toContain('Bread');
});

test('a note written on another device turns up in this device’s search', async ({ page, device }) => {
  await openEncrypted(page);
  const word = `zanzibar${Math.random().toString(36).slice(2, 6)}`;
  const other = await device({ label: 'device 2' });
  expect(await openApp(other.page)).toBe('locked');
  await unlock(other.page, secrets()!.passphrase);
  await createNote(other.page, 'Spice market', `Cloves and cardamom from ${word}`);

  // Searched on this device (the library is encrypted, so search runs here, on its own copy).
  await page.reload();
  await listSearch(page).fill(word);
  await expect(listRow(page, 'Spice market')).toBeVisible({ timeout: 15_000 });
  await expect(listRow(page, 'Spice market')).toContainText(word);
  await listRow(page, 'Spice market').click();
  await expect(noteText(page)).toContainText(`Cloves and cardamom from ${word}`);
});
