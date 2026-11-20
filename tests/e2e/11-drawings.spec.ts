/**
 * A drawing (Excalidraw) on the encrypted library: drawn, saved with Done into a new note, shown
 * decrypted in the note and the list, stored as ciphertext on the server, and opened again to edit.
 */
import { listRow, noteTitle, openEncrypted, preview, sidebar } from './app';
import { expect, test } from './fixtures';

test('a drawing is saved encrypted and shown decrypted', async ({ page }) => {
  await openEncrypted(page);
  await sidebar(page).getByRole('button', { name: 'Create something else' }).click();
  await page.getByRole('menu').getByRole('menuitem', { name: 'Drawing', exact: true }).click();

  const editor = page.getByRole('dialog', { name: 'Drawing editor' });
  await expect(editor).toBeVisible();
  const done = editor.getByRole('button', { name: 'Done' });
  await expect(done).toBeEnabled({ timeout: 30_000 });
  // A rectangle: the R key picks the tool, then a drag on the canvas.
  const canvas = editor.locator('canvas.interactive');
  await expect(canvas).toBeVisible();
  const box = (await canvas.boundingBox())!;
  await canvas.click({ position: { x: box.width / 2, y: box.height / 2 } });
  await page.keyboard.press('r');
  await page.mouse.move(box.x + box.width * 0.35, box.y + box.height * 0.35);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.55, box.y + box.height * 0.5, { steps: 8 });
  await page.mouse.up();
  await done.click();
  await expect(editor).toBeHidden({ timeout: 30_000 });

  // A new note with the drawing, in reading view, decrypted on this device.
  await expect(noteTitle(page)).toHaveValue('Untitled drawing');
  const drawing = preview(page).getByRole('img').first();
  await expect(drawing).toHaveAttribute('src', /^blob:/, { timeout: 15_000 });
  await expect.poll(() => drawing.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(true);
  const id = await page.evaluate(() => {
    const el = document.querySelector('.kb-prose [data-drawing-id]');
    return el?.getAttribute('data-drawing-id') ?? null;
  });
  expect(id).toBeTruthy();

  // On the server it's ciphertext, not an SVG.
  const stored = await page.evaluate(async (drawingId) => (await fetch(`/api/drawings/${drawingId}.svg?fresh=${Date.now()}`)).text(), id);
  expect(stored).not.toContain('<svg');
  expect(stored).not.toContain('<rect');

  // The list shows it as the note's thumbnail, decrypted too.
  await sidebar(page).getByRole('button', { name: /^All notes/ }).click();
  const thumb = listRow(page, 'Untitled drawing').locator('img');
  await expect(thumb).toHaveAttribute('src', /^blob:/, { timeout: 15_000 });

  // Opened again to edit, from the note.
  await listRow(page, 'Untitled drawing').click();
  await preview(page).getByRole('button', { name: /Edit drawing/ }).first().click();
  await expect(editor).toBeVisible();
  await expect(editor.getByRole('button', { name: 'Done' })).toBeEnabled({ timeout: 30_000 });
  await editor.getByRole('button', { name: 'Cancel' }).click();
  await expect(editor).toBeHidden();
});
