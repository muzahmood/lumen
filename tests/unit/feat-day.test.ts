// @vitest-environment jsdom
/**
 * The date moves on at midnight (src/lib/store.ts, `day`), so what says "Today" or "Yesterday" (the
 * note list, Tasks, the journal) is drawn again: by a timer, and, since phones pause timers while
 * Lumen is in the background, whenever Lumen is back on screen.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { polyfillMatchMedia, standInServer } from './cov-helpers';

polyfillMatchMedia();

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function storeAt(now: Date) {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'], now });
  vi.stubGlobal('BroadcastChannel', undefined);
  standInServer();
  history.replaceState(null, '', '/');
  vi.resetModules();
  return import('../../src/lib/store');
}

describe('the date', () => {
  it('moves on at midnight, with nothing else happening', async () => {
    const store = await storeAt(new Date(2026, 10, 20, 23, 59, 58));
    const day = () => store.useApp.getState().day;
    expect(day()).toBe('2026-11-20');
    vi.advanceTimersByTime(1000);
    expect(day()).toBe('2026-11-20');
    vi.advanceTimersByTime(4000);
    expect(day()).toBe('2026-11-21');
    // And again the next night.
    vi.advanceTimersByTime(24 * 60 * 60 * 1000);
    expect(day()).toBe('2026-11-22');
  });

  it('is looked at again when Lumen comes back on screen (a phone paused its timers)', async () => {
    const store = await storeAt(new Date(2026, 10, 20, 21, 0));
    const day = () => store.useApp.getState().day;
    // Two days in the background, its timer never run.
    vi.setSystemTime(new Date(2026, 10, 22, 8, 30));
    expect(day()).toBe('2026-11-20');
    document.dispatchEvent(new Event('visibilitychange'));
    expect(day()).toBe('2026-11-22');
    vi.setSystemTime(new Date(2026, 10, 23, 7, 0));
    window.dispatchEvent(new Event('focus'));
    expect(day()).toBe('2026-11-23');
  });

  it('doesn’t redraw anything while it’s still the same day', async () => {
    const store = await storeAt(new Date(2026, 10, 20, 9, 0));
    const changed = vi.fn();
    store.useApp.subscribe((s, prev) => s.day !== prev.day && changed());
    vi.setSystemTime(new Date(2026, 10, 20, 18, 0));
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new Event('focus'));
    expect(changed).not.toHaveBeenCalled();
  });
});
