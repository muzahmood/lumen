/** Settings that follow the person to every device: one record, saved only on top of the version read. */
import { beforeEach, describe, expect, it } from 'vitest';
import { call, cipher, get, resetLibrary, turnOnEncryption } from './helpers';

beforeEach(resetLibrary);

const put = (body: unknown) => call('PUT', '/settings', body);

describe('synced settings', () => {
  it('start empty, then come back with the bootstrap', async () => {
    expect((await get('/bootstrap')).body.settings).toBeNull();
    const saved = await put({ enc: false, data: '{"theme":"dark"}', base: 0 });
    expect(saved.body).toMatchObject({ ok: true, at: expect.any(Number) });
    expect((await get('/bootstrap')).body.settings).toEqual({ at: saved.body.at, enc: false, data: '{"theme":"dark"}', kgen: 0 });
  });

  it('refuse a save that started from an older version, and say what’s there now', async () => {
    const first = await put({ enc: false, data: '{"accent":"teal"}', base: 0 });
    const second = await put({ enc: false, data: '{"accent":"rose"}', base: first.body.at });
    expect(second.body.ok).toBe(true);
    expect(second.body.at).toBeGreaterThan(first.body.at);
    // A device that last saw the first version.
    const stale = await put({ enc: false, data: '{"accent":"green"}', base: first.body.at });
    expect(stale.body).toMatchObject({ ok: false, settings: { at: second.body.at, data: '{"accent":"rose"}' } });
  });

  it('accept only a JSON object, of a sensible size', async () => {
    expect((await put({ enc: false, data: 'not json', base: 0 })).status).toBe(400);
    expect((await put({ enc: false, data: '[1]', base: 0 })).status).toBe(400);
    expect((await put({ enc: false, data: JSON.stringify({ x: 'y'.repeat(20_000) }), base: 0 })).status).toBe(400);
  });

  it('are only stored encrypted, in the current key, once encryption is on', async () => {
    await turnOnEncryption();
    const plain = await put({ enc: false, data: '{"theme":"dark"}', base: 0 });
    expect(plain.status).toBe(409);
    expect(plain.body.error).toBe('encryption_required');
    expect((await put({ enc: true, data: 'not a cipher', kgen: 0, base: 0 })).status).toBe(400);
    expect((await put({ enc: true, data: cipher(40), kgen: 3, base: 0 })).body.error).toBe('key_changed');
    const sealed = cipher(40);
    expect((await put({ enc: true, data: sealed, kgen: 0, base: 0 })).body.ok).toBe(true);
    expect((await get('/bootstrap')).body.settings).toMatchObject({ enc: true, data: sealed, kgen: 0 });
  });
});
