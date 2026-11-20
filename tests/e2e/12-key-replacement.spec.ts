/**
 * Replacing the encryption key (Settings → Security → Encryption key → Replace key), run last since it
 * re-encrypts the whole library: everything is encrypted again with a new key and there's a new
 * recovery key, the passphrase stays. Another device that was unlocked notices on its next save,
 * locks, says why, and sends the edit it had with the new key once unlocked; the old recovery key no
 * longer opens the library, the new one does.
 */
import { createNote, currentNoteId, expectSaved, focusEnd, noteText, openApp, openEncrypted, openSettings, saveSecrets, toasts, typeText, unlock } from './app';
import { expect, test } from './fixtures';

test('replacing the key: everything re-encrypted, other devices re-unlock, the old recovery key stops working', async ({ page, device, guard }) => {
  // The other device's first save after the replacement is refused (409, key changed): that's how it notices.
  guard.allow(/status of 409 \(Conflict\)/);

  const { passphrase, recoveryKey: oldRecovery } = await openEncrypted(page);
  await createNote(page, 'Before the new key', 'Written under the first key');
  const id = currentNoteId(page);

  // A second device, unlocked and with the note open, before the key changes.
  const other = await device({ label: 'device 2' });
  expect(await openApp(other.page, `/note/${id}`)).toBe('locked');
  await unlock(other.page, passphrase);
  await expect(noteText(other.page)).toContainText('Written under the first key');

  await openSettings(page, 'Security');
  await page.getByRole('button', { name: 'Replace key' }).click();
  await page.getByRole('textbox', { name: 'Passphrase', exact: true }).fill(passphrase);
  await page.getByRole('button', { name: 'Continue' }).click();
  const shown = page.getByLabel('Recovery key', { exact: true });
  await expect(shown).toBeVisible({ timeout: 30_000 });
  const newRecovery = (await shown.textContent())!.trim();
  expect(newRecovery).not.toBe(oldRecovery);
  await page.getByRole('checkbox', { name: 'I’ve saved my new recovery key somewhere safe' }).check();
  await page.getByRole('button', { name: 'Replace key' }).click();
  await expect(toasts(page).getByText('Your notes now use the new key')).toBeVisible({ timeout: 60_000 });
  saveSecrets({ passphrase, recoveryKey: newRecovery });
  await expect(noteText(page)).toContainText('Written under the first key');

  // The other device edits: refused for the old key, it locks and says why.
  await focusEnd(other.page);
  await typeText(other.page, '\nTyped on the other device just after');
  await expect(other.page.getByRole('heading', { name: 'Unlock your notes' })).toBeVisible({ timeout: 30_000 });
  await expect(other.page.getByText('Your encryption key was replaced on another device. Unlock with your passphrase to continue.')).toBeVisible();
  // The passphrase stays the same; once unlocked, the edit it had goes out with the new key.
  await unlock(other.page, passphrase);
  await other.page.goto(`/note/${id}`);
  await expect(noteText(other.page)).toContainText('Typed on the other device just after', { timeout: 15_000 });
  await expectSaved(other.page, 30_000);
  await page.reload();
  await expect(noteText(page)).toContainText('Typed on the other device just after');

  // A third device with only the old recovery key: refused. The new one gets in.
  const third = await device({ label: 'device 3' });
  expect(await openApp(third.page)).toBe('locked');
  await third.page.getByRole('button', { name: 'Forgot your passphrase?' }).click();
  await third.page.getByRole('textbox', { name: 'Recovery key' }).fill(oldRecovery);
  await third.page.getByRole('textbox', { name: 'New passphrase', exact: true }).fill(passphrase);
  await third.page.getByRole('textbox', { name: 'New passphrase again' }).fill(passphrase);
  await third.page.getByRole('button', { name: 'Unlock and save passphrase' }).click();
  await expect(third.page.getByRole('alert')).toContainText('That recovery key didn’t unlock your notes');
  await third.page.getByRole('textbox', { name: 'Recovery key' }).fill(newRecovery);
  await third.page.getByRole('button', { name: 'Unlock and save passphrase' }).click();
  await expect(toasts(third.page).getByText('Unlocked. Your new passphrase works on every device.')).toBeVisible({ timeout: 30_000 });
  await third.page.goto(`/note/${id}`);
  await expect(noteText(third.page)).toContainText('Typed on the other device just after');
});
