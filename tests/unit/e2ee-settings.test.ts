// @vitest-environment jsdom
/**
 * Settings that follow the person to every device, in an encrypted library (src/lib/settingsSync.ts
 * with the real API client and codec): sealed under "lumen/1/settings" with the key generation, merged
 * with another device's newer save, and never sent in readable form. The merge rules on their own are
 * in settingsSync.test.ts. A stand-in server keeps the one settings record like the Worker does.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { decryptText, encryptText, newMasterKey } from '../../src/lib/crypto';
import type { StoredSettings } from '../../src/lib/types';

window.matchMedia ??= ((query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;

let apiMod: typeof import('../../src/lib/api');
let e2ee: typeof import('../../src/lib/e2ee');
let sync: typeof import('../../src/lib/settingsSync');
let useSettings: typeof import('../../src/lib/settings')['useSettings'];
let key: CryptoKey;

let stored: StoredSettings | null;
let gen: number;
let clock: number;
const puts: Array<{ enc: boolean; data: string; kgen?: number; base: number }> = [];

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function server(path: string, init: RequestInit = {}): Response {
  if (path === '/api/settings' && init.method === 'PUT') {
    const body = JSON.parse(init.body as string);
    puts.push(body);
    if (body.enc === true) {
      if ((body.kgen ?? 0) !== gen) return json({ error: 'key_changed', message: 'Replaced.' }, 409);
    } else if (gen >= 0) {
      // Encryption is on in every test here: plaintext is refused.
      return json({ error: 'encryption_required', message: 'Encrypted only.' }, 409);
    }
    if (stored && stored.at > body.base) return json({ ok: false, settings: stored });
    clock = Math.max(clock + 1, (stored?.at ?? 0) + 1);
    stored = { at: clock, enc: body.enc === true, data: body.data, kgen: body.enc ? body.kgen : 0 };
    return json({ ok: true, at: clock });
  }
  return json({ error: 'not_found', message: 'Not found.' }, 404);
}

const SETTINGS_CTX = 'lumen/1/settings';
const sealed = async (values: object, at: number, k: CryptoKey = key, kgen = gen): Promise<StoredSettings> => ({ at, enc: true, data: await encryptText(k, JSON.stringify(values), SETTINGS_CTX), kgen });
const open = async (s: StoredSettings | null, k: CryptoKey = key) => JSON.parse(await decryptText(k, s!.data, SETTINGS_CTX));
const stamp = () => JSON.parse(localStorage.getItem('kb.settings.sync') || 'null');

beforeEach(async () => {
  // The debounced save isn't left to fire on its own: each test sends what it means to.
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  localStorage.clear();
  vi.resetModules();
  apiMod = await import('../../src/lib/api');
  e2ee = await import('../../src/lib/e2ee');
  sync = await import('../../src/lib/settingsSync');
  ({ useSettings } = await import('../../src/lib/settings'));
  key = await newMasterKey();
  apiMod.setCodec(e2ee.createCodec(key));
  stored = null;
  gen = 0;
  clock = 100;
  puts.length = 0;
  localStorage.removeItem('kb.settings.sync');
  vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => server(path, init)));
});

afterEach(() => {
  apiMod.setCodec(null);
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('synced settings in an encrypted library', () => {
  it('are saved encrypted under the current key generation, and open with the key', async () => {
    gen = 2;
    apiMod.setKeyGen(2);
    useSettings.getState().update({ theme: 'dark', workspaceName: 'Project Nightingale', remoteImages: 'ask' });
    await sync.receiveSettings(null, true);
    expect(puts).toHaveLength(1);
    expect(puts[0]).toMatchObject({ enc: true, kgen: 2 });
    expect(JSON.stringify(puts)).not.toMatch(/"dark"|Project Nightingale|remoteImages/);
    expect(await open(stored)).toMatchObject({ theme: 'dark', workspaceName: 'Project Nightingale', remoteImages: 'ask' });
    // Only synced settings travel: not auto-lock, not text size.
    expect(await open(stored)).not.toHaveProperty('autoLockMinutes');
    expect(await open(stored)).not.toHaveProperty('fontSize');
    expect(stamp()).toEqual({ at: stored!.at, dirty: [] });
  });

  it('take another device’s newer save, except what was changed here since, and send the result encrypted', async () => {
    localStorage.setItem('kb.settings.sync', JSON.stringify({ at: 10, dirty: [] }));
    useSettings.getState().update({ accent: 'teal' });
    stored = await sealed({ theme: 'dark', accent: 'rose', noteFont: 'serif' }, 50);
    await sync.receiveSettings(stored, true);
    const s = useSettings.getState();
    expect([s.theme, s.accent, s.noteFont]).toEqual(['dark', 'teal', 'serif']);
    expect(puts.map((p) => p.base)).toEqual([50]);
    expect(await open(stored)).toMatchObject({ theme: 'dark', accent: 'teal', noteFont: 'serif' });
  });

  it('merge with an encrypted save that arrives while this one is on its way, and try again', async () => {
    localStorage.setItem('kb.settings.sync', JSON.stringify({ at: 10, dirty: [] }));
    useSettings.getState().update({ noteFont: 'mono' });
    // Saved from another device after this one last looked.
    stored = await sealed({ theme: 'light', noteFont: 'serif' }, 40);
    await sync.receiveSettings({ ...stored, at: 10 }, true);
    expect(puts.map((p) => p.base)).toEqual([10, 40]);
    expect(useSettings.getState().theme).toBe('light');
    expect(await open(stored)).toMatchObject({ theme: 'light', noteFont: 'mono' });
  });

  it('under a key this device doesn’t have aren’t applied, and are replaced with this device’s', async () => {
    useSettings.getState().update({ theme: 'light' });
    localStorage.setItem('kb.settings.sync', JSON.stringify({ at: 10, dirty: [] }));
    stored = await sealed({ theme: 'dark', workspaceName: 'Someone else' }, 50, await newMasterKey());
    await sync.receiveSettings(stored, true);
    expect(useSettings.getState().theme).toBe('light');
    expect(useSettings.getState().workspaceName).toBe('Lumen');
    expect(await open(stored)).toMatchObject({ theme: 'light', workspaceName: 'Lumen' });
  });

  it('moved from a note can’t pass as settings', async () => {
    localStorage.setItem('kb.settings.sync', JSON.stringify({ at: 10, dirty: [] }));
    stored = { at: 50, enc: true, data: await encryptText(key, '{"theme":"dark"}', 'lumen/1/note/note000001/title'), kgen: 0 };
    await sync.receiveSettings(stored, true);
    expect(useSettings.getState().theme).toBe('system');
    expect(await open(stored)).toMatchObject({ theme: 'system' });
  });

  it('saved under an earlier key open through the key kept, and are saved again under the current one', async () => {
    const oldKey = await newMasterKey();
    stored = await sealed({ theme: 'dark' }, 50, oldKey, 0);
    gen = 1;
    apiMod.setKeyGen(1);
    apiMod.setCodec(e2ee.createCodec(key, [oldKey]));
    localStorage.setItem('kb.settings.sync', JSON.stringify({ at: 10, dirty: [] }));
    await sync.receiveSettings(stored, true);
    expect(useSettings.getState().theme).toBe('dark');
    expect(stored).toMatchObject({ enc: true, kgen: 1 });
    expect(await open(stored, key)).toMatchObject({ theme: 'dark' });
    await expect(open(stored, oldKey)).rejects.toThrow();
  });

  it('wait while the library is locked, then go encrypted once it’s unlocked', async () => {
    localStorage.setItem('kb.vault.sealed', '1');
    apiMod.setCodec(null);
    localStorage.setItem('kb.settings.sync', JSON.stringify({ at: 50, dirty: [] }));
    stored = await sealed({ theme: 'system' }, 50);
    useSettings.getState().update({ theme: 'dark' });
    await sync.receiveSettings(stored, true);
    expect(puts).toEqual([]);
    expect(stamp().dirty).toEqual(['theme']);

    apiMod.setCodec(e2ee.createCodec(key));
    await sync.receiveSettings(stored, true);
    expect(puts).toHaveLength(1);
    expect(puts[0].enc).toBe(true);
    expect(await open(stored)).toMatchObject({ theme: 'dark' });
  });

  it('a save refused because the key moved on keeps the change for later', async () => {
    gen = 1; // replaced elsewhere; this device still writes generation 0
    localStorage.setItem('kb.settings.sync', JSON.stringify({ at: 50, dirty: [] }));
    useSettings.getState().update({ theme: 'dark' });
    await sync.receiveSettings(await sealed({ theme: 'system' }, 50), true);
    expect(puts).toHaveLength(1);
    expect(stamp().dirty).toEqual(['theme']);
  });

  it('arriving unencrypted once the library is known to be encrypted aren’t taken, and this device’s replace them', async () => {
    localStorage.setItem('kb.vault.sealed', '1');
    useSettings.getState().update({ remoteImages: 'ask' });
    // Nothing changed here since the last sync: another device's newer save would be taken.
    localStorage.setItem('kb.settings.sync', JSON.stringify({ at: 10, dirty: [] }));
    expect(apiMod.libraryEncrypted()).toBe(true);
    // Not written by Lumen: the server refuses plaintext settings once encryption is on.
    const injected: StoredSettings = { at: 50, enc: false, data: JSON.stringify({ remoteImages: 'load', workspaceName: 'Injected' }), kgen: 0 };
    await sync.receiveSettings(injected, true);
    expect(useSettings.getState().remoteImages).toBe('ask');
    expect(useSettings.getState().workspaceName).toBe('Lumen');
    expect(await open(stored)).toMatchObject({ remoteImages: 'ask', workspaceName: 'Lumen' });
  });
});
