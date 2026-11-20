/**
 * Worker problems found by testing the whole app, kept here so they stay fixed.
 */
import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { keyringData, post, resetLibrary, turnOnEncryption } from './helpers';
import { encNote, replaceKey } from './api-helpers';

beforeEach(resetLibrary);

describe('a keyring put back after the server lost it', () => {
  it('is taken at the generation the stored notes are under, even after several key replacements', async () => {
    await turnOnEncryption();
    await replaceKey();
    const gen = await replaceKey();
    expect(gen).toBe(2);
    await encNote({ kgen: gen });
    await env.DB.prepare('DELETE FROM keyring').run();

    // An older keyring can't come back over newer ciphertext.
    const older = await post('/keyring', { data: { ...keyringData(), gen: 1 }, replaces: null });
    expect([older.status, older.body.error]).toEqual([400, 'bad_keyring']);

    const back = await post('/keyring', { data: { ...keyringData(), gen: 2 }, replaces: null });
    expect(back.status).toBe(201);
    // Writes under the put-back key go through again (encNote throws unless the note is created).
    await expect(encNote({ kgen: 2 })).resolves.toMatchObject({ enc: true });
  });
});
