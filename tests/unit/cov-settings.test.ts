// @vitest-environment jsdom
/**
 * Settings on this device (src/lib/settings.ts) and the edges of sending them to others
 * (src/lib/settingsSync.ts), beyond settingsSync.test.ts: settings saved by earlier versions, a store
 * that can't be read or written, changes made in another tab, the system theme, and saves that fail
 * in unexpected ways.
 */
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let settings: typeof import('../../src/lib/settings');
let sync: typeof import('../../src/lib/settingsSync');
let saveSettings: ReturnType<typeof vi.fn>;
let openSettings: ReturnType<typeof vi.fn>;
let mq: { matches: boolean; listeners: Set<() => void> };

class FakeApiError extends Error {}
class FakeNetworkError extends Error {}

async function load() {
  vi.resetModules();
  vi.doMock('../../src/lib/api', () => ({
    ApiError: FakeApiError,
    NetworkError: FakeNetworkError,
    currentCodec: () => null,
    currentKeyGen: () => 0,
    libraryEncrypted: () => false,
    api: { saveSettings: (...a: unknown[]) => saveSettings(...a), openSettings: (...a: unknown[]) => openSettings(...a) },
  }));
  settings = await import('../../src/lib/settings');
  sync = await import('../../src/lib/settingsSync');
}

const stored = () => JSON.parse(localStorage.getItem('kb.settings') || '{}');
const stamp = () => JSON.parse(localStorage.getItem('kb.settings.sync') || 'null');

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  localStorage.clear();
  mq = { matches: false, listeners: new Set() };
  window.matchMedia = ((q: string) => ({
    get matches() {
      return q.includes('dark') ? mq.matches : false;
    },
    media: q,
    addEventListener: (_: string, fn: () => void) => mq.listeners.add(fn),
    removeEventListener: (_: string, fn: () => void) => mq.listeners.delete(fn),
  })) as unknown as typeof window.matchMedia;
  let at = 100;
  saveSettings = vi.fn(async () => ({ ok: true, at: (at += 10) }));
  openSettings = vi.fn(async (s: { data: string }) => s.data);
  await load();
});

afterEach(() => {
  vi.useRealTimers();
  vi.doUnmock('../../src/lib/api');
  vi.restoreAllMocks();
});

describe('settings saved by earlier versions', () => {
  it('carry over: the old font setting, a retired accent and the old default names', async () => {
    localStorage.setItem('kb.settings', JSON.stringify({ editorFont: 'serif', accent: 'blue', workspaceName: 'Knowledgebase', fontSize: 18 }));
    await load();
    expect(settings.useSettings.getState()).toMatchObject({ noteFont: 'serif', accent: 'iris', workspaceName: 'Lumen', fontSize: 18 });
    localStorage.setItem('kb.settings', JSON.stringify({ workspaceName: 'Constella' }));
    await load();
    expect(settings.useSettings.getState().workspaceName).toBe('Lumen');
    localStorage.setItem('kb.settings', JSON.stringify({ workspaceName: 'My notes', noteFont: 'mono', editorFont: 'serif' }));
    await load();
    expect(settings.useSettings.getState()).toMatchObject({ workspaceName: 'My notes', noteFont: 'mono' });
  });

  it('that can’t be read give the defaults', async () => {
    localStorage.setItem('kb.settings', '{not json');
    await load();
    expect(settings.useSettings.getState()).toMatchObject({ theme: 'system', accent: 'iris', fontSize: 16, autoLockMinutes: 0 });
  });
});

describe('changing a setting', () => {
  it('stores only what changed, on top of what another tab stored since this one opened', () => {
    // Another tab turned on auto-lock after this one loaded.
    localStorage.setItem('kb.settings', JSON.stringify({ autoLockMinutes: 5 }));
    settings.useSettings.getState().update({ theme: 'dark' });
    expect(stored()).toEqual({ autoLockMinutes: 5, theme: 'dark' });
  });

  it('starts again from the change when what’s stored can’t be read', () => {
    localStorage.setItem('kb.settings', 'garbage');
    settings.useSettings.getState().update({ fontSize: 20 });
    expect(stored()).toEqual({ fontSize: 20 });
  });

  it('still applies for this session when storage refuses writes', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('full', 'QuotaExceededError');
    });
    expect(() => settings.useSettings.getState().update({ accent: 'teal' })).not.toThrow();
    expect(settings.useSettings.getState().accent).toBe('teal');
  });

  it('made in another tab applies here too, without this tab sending it to other devices again', async () => {
    localStorage.setItem('kb.settings', JSON.stringify({ theme: 'dark', accent: 'rose' }));
    window.dispatchEvent(new StorageEvent('storage', { key: 'kb.settings' }));
    expect(settings.useSettings.getState()).toMatchObject({ theme: 'dark', accent: 'rose' });
    expect(stamp()).toBeNull();
    await vi.advanceTimersByTimeAsync(2000);
    expect(saveSettings).not.toHaveBeenCalled();
    // Other keys changing elsewhere are none of its business.
    localStorage.setItem('kb.settings', JSON.stringify({ theme: 'light' }));
    window.dispatchEvent(new StorageEvent('storage', { key: 'kb.draft.x' }));
    expect(settings.useSettings.getState().theme).toBe('dark');
  });
});

describe('saved searches', () => {
  it('go to other devices with the rest', async () => {
    settings.useSettings.getState().update({ savedSearches: [{ id: 'ss1', name: 'Budgets', query: 'budget' }] });
    await vi.advanceTimersByTimeAsync(1600);
    expect(JSON.parse(saveSettings.mock.calls[0][0] as string).savedSearches).toEqual([{ id: 'ss1', name: 'Budgets', query: 'budget' }]);
  });

  it('keep only what fits: a usable id, a name, at least two characters to look for, at most 50', () => {
    const many = Array.from({ length: 60 }, (_, i) => ({ id: `s${i}`, name: `S${i}`, query: 'tag:x' }));
    expect(settings.validSettings({ savedSearches: many }).savedSearches).toHaveLength(50);
    expect(
      settings.validSettings({
        savedSearches: [
          { id: 'ok', name: '  Trimmed  ', query: '  is:pinned  ' },
          { id: 'ok', name: 'Same id again', query: 'x y' },
          { id: 'bad id!', name: 'Bad id', query: 'x y' },
          { id: 'noname', name: '   ', query: 'x y' },
          { id: 'short', name: 'Short', query: 'x' },
          { id: 'long', name: 'N'.repeat(100), query: 'q'.repeat(900) },
          'not an object',
          null,
          { id: 7, name: 'Number id', query: 'x y' },
        ],
      }).savedSearches,
    ).toEqual([
      { id: 'ok', name: 'Trimmed', query: 'is:pinned' },
      { id: 'long', name: 'N'.repeat(60), query: 'q'.repeat(500) },
    ]);
    expect(settings.validSettings({ savedSearches: 'tag:x' }).savedSearches).toBeUndefined();
  });
});

describe('the system theme', () => {
  it('is followed while the theme is “system”, and ignored otherwise', async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const seen: string[] = [];
    function Probe() {
      seen.push(settings.useResolvedTheme());
      return null;
    }
    const host = document.createElement('div');
    const root = createRoot(host);
    await act(async () => root.render(createElement(Probe)));
    expect(seen.at(-1)).toBe('light');
    await act(async () => {
      mq.matches = true;
      mq.listeners.forEach((fn) => fn());
    });
    expect(seen.at(-1)).toBe('dark');
    await act(async () => settings.useSettings.getState().update({ theme: 'light' }));
    expect(seen.at(-1)).toBe('light');
    await act(async () => root.unmount());
    expect(mq.listeners.size).toBe(0);
  });
});

describe('sending settings to other devices', () => {
  it('a change goes a moment later, in one save', async () => {
    settings.useSettings.getState().update({ theme: 'dark' });
    settings.useSettings.getState().update({ accent: 'green' });
    expect(stamp().dirty.sort()).toEqual(['accent', 'theme']);
    await vi.advanceTimersByTimeAsync(1400);
    expect(saveSettings).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(200);
    expect(saveSettings).toHaveBeenCalledTimes(1);
    expect(JSON.parse(saveSettings.mock.calls[0][0] as string)).toMatchObject({ theme: 'dark', accent: 'green' });
    expect(stamp()).toEqual({ at: 110, dirty: [] });
  });

  it('a per-device setting is never sent', async () => {
    settings.useSettings.getState().update({ fontSize: 22, sidebarWidth: 300, autoLockMinutes: 10, expandedFolders: ['a'] });
    await vi.advanceTimersByTimeAsync(2000);
    expect(saveSettings).not.toHaveBeenCalled();
  });

  it('nothing happens with a server too old to keep settings', async () => {
    await sync.receiveSettings(undefined, false);
    expect(saveSettings).not.toHaveBeenCalled();
  });

  it('settings stored as something other than JSON are replaced with this device’s', async () => {
    await sync.receiveSettings({ at: 50, enc: false, data: 'not json at all', kgen: 0 }, false);
    expect(saveSettings).toHaveBeenCalledTimes(1);
    expect(saveSettings.mock.calls[0][1]).toBe(0);
  });

  it('another device’s save read while this device’s own save landed isn’t taken over it', async () => {
    localStorage.setItem('kb.settings.sync', JSON.stringify({ at: 10, dirty: [] }));
    openSettings.mockImplementation(async (s: { data: string }) => {
      // While this was being read, a save from here finished, at a later version.
      localStorage.setItem('kb.settings.sync', JSON.stringify({ at: 80, dirty: [] }));
      return s.data;
    });
    await sync.receiveSettings({ at: 60, enc: false, data: JSON.stringify({ theme: 'dark' }), kgen: 0 }, false);
    expect(settings.useSettings.getState().theme).toBe('system');
    expect(stamp().at).toBe(80);
  });

  it('a save that fails unexpectedly is logged, kept marked, and doesn’t throw', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    saveSettings.mockRejectedValueOnce(new TypeError('boom'));
    settings.useSettings.getState().update({ theme: 'dark' });
    await vi.advanceTimersByTimeAsync(1600);
    expect(warn).toHaveBeenCalledWith('Settings not synced', expect.any(TypeError));
    expect(stamp().dirty).toEqual(['theme']);
    // Offline or refused: quietly kept for the next refresh.
    warn.mockClear();
    saveSettings.mockRejectedValueOnce(new FakeNetworkError('offline'));
    await sync.receiveSettings({ at: 0, enc: false, data: '{}', kgen: 0 }, false);
    expect(warn).not.toHaveBeenCalled();
    expect(stamp().dirty).toEqual(['theme']);
  });
});
