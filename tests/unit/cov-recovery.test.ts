// @vitest-environment jsdom
/**
 * Recovering when part of the app fails to download (src/lib/recovery.ts): telling a new version
 * from being offline, reloading onto the new version at most once in 30 seconds (never in a loop),
 * and asking first where a reload could cost unsaved work.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { polyfillMatchMedia } from './cov-helpers';

polyfillMatchMedia();

let recovery: typeof import('../../src/lib/recovery');
let store: typeof import('../../src/lib/store');
let reloads: number;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'], now: 1_700_000_000_000 });
  reloads = 0;
  sessionStorage.clear();
  vi.stubGlobal('location', { pathname: '/', hash: '', search: '', origin: 'http://localhost', href: 'http://localhost/', reload: () => void reloads++ });
  vi.resetModules();
  store = await import('../../src/lib/store');
  recovery = await import('../../src/lib/recovery');
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('recognising a part of the app that failed to load', () => {
  it('knows each browser’s wording, and Vite’s', () => {
    for (const message of [
      'Failed to fetch dynamically imported module: https://kb.example/assets/Editor-abc.js',
      'error loading dynamically imported module',
      'Importing a module script failed.',
      'Unable to preload CSS for /assets/Settings-1.css',
    ]) {
      expect(recovery.isChunkError(new TypeError(message)), message).toBe(true);
    }
    const chunk = new Error('Loading chunk 7 failed');
    chunk.name = 'ChunkLoadError';
    expect(recovery.isChunkError(chunk)).toBe(true);
    expect(recovery.isChunkError('Failed to fetch dynamically imported module')).toBe(true);
  });

  it('leaves every other error alone', () => {
    expect(recovery.isChunkError(new TypeError('Failed to fetch'))).toBe(false);
    expect(recovery.isChunkError(new Error('Cannot read properties of undefined'))).toBe(false);
    expect(recovery.isChunkError(null)).toBe(false);
  });
});

describe('working out why', () => {
  it('offline by the browser’s own account, without asking the server', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    expect(await recovery.diagnoseLoadFailure()).toBe('offline');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('a new version when the server answers at all, even with a sign-in redirect', async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    expect(await recovery.diagnoseLoadFailure()).toBe('updated');
    expect(fetch).toHaveBeenCalledWith('/', { method: 'HEAD', cache: 'no-store', redirect: 'manual', credentials: 'same-origin' });
  });

  it('offline when the server can’t be reached', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('Failed to fetch'))));
    expect(await recovery.diagnoseLoadFailure()).toBe('offline');
  });
});

describe('reloading onto the new version', () => {
  it('reloads once, then not again for 30 seconds, so a broken file can’t cause a loop', () => {
    expect(recovery.reloadForNewVersion()).toBe(true);
    expect(reloads).toBe(1);
    vi.advanceTimersByTime(29_000);
    expect(recovery.reloadForNewVersion()).toBe(false);
    expect(reloads).toBe(1);
    vi.advanceTimersByTime(2_000);
    expect(recovery.reloadForNewVersion()).toBe(true);
    expect(reloads).toBe(2);
  });

  it('without session storage, reloads only a page that didn’t itself come from a reload', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError');
    });
    const entries = vi.spyOn(performance, 'getEntriesByType');
    entries.mockReturnValue([{ type: 'navigate' } as PerformanceNavigationTiming]);
    expect(recovery.reloadForNewVersion()).toBe(true);
    entries.mockReturnValue([{ type: 'reload' } as PerformanceNavigationTiming]);
    expect(recovery.reloadForNewVersion()).toBe(false);
    expect(reloads).toBe(1);
  });
});

describe('telling the person when a reload could cost unsaved work', () => {
  it('says so once per page, staying until they choose Reload', () => {
    recovery.announceUpdate();
    recovery.announceUpdate();
    const toasts = store.useApp.getState().toasts;
    expect(toasts).toHaveLength(1);
    expect(toasts[0]).toMatchObject({ message: 'Lumen has been updated. Reload when you’re ready to get the new version.', timeout: 0 });
    vi.advanceTimersByTime(60_000);
    expect(store.useApp.getState().toasts).toHaveLength(1);
    toasts[0].action!.run();
    expect(reloads).toBe(1);
  });
});
