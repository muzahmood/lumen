// @vitest-environment jsdom
/**
 * Automatic backups (src/lib/autoBackup.ts): about once a week, the device that has Lumen open makes
 * the backup "Download backup" makes (encrypted on it when the library is) and keeps it on the server.
 * Not when they're off or not set up, nor offline, locked, mid-encryption or saving data; one at a time.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { polyfillMatchMedia, standInServer } from './cov-helpers';

polyfillMatchMedia();

const DAY = 24 * 3_600_000;
const exportBackup = vi.fn();
const deviceKeys = vi.fn((): unknown[] => [{}]);
vi.mock('../../src/lib/backup', () => ({ exportBackup: (...a: unknown[]) => exportBackup(...a) }));
vi.mock('../../src/lib/vault', async (real) => ({ ...(await real<object>()), deviceKeys: () => deviceKeys() }));

let auto: typeof import('../../src/lib/autoBackup');
let api: typeof import('../../src/lib/api')['api'];
let ApiError: typeof import('../../src/lib/api')['ApiError'];
let store: typeof import('../../src/lib/store');
let settings: typeof import('../../src/lib/settings');
let list: ReturnType<typeof vi.fn>;
let keep: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  vi.stubGlobal('BroadcastChannel', undefined);
  standInServer();
  vi.resetModules();
  ({ api, ApiError } = await import('../../src/lib/api'));
  store = await import('../../src/lib/store');
  settings = await import('../../src/lib/settings');
  auto = await import('../../src/lib/autoBackup');
  store.useApp.setState({ status: 'ready', online: true, encryption: { on: true, pending: 0, rekey: 0, attachments: 0 }, toasts: [] });
  settings.useSettings.setState({ autoBackup: true });
  exportBackup.mockReset().mockResolvedValue({ blob: new Blob(['LUMENBK1…']), filename: 'x', missing: [], unreadable: [] });
  deviceKeys.mockReset().mockReturnValue([{}]);
  list = vi.spyOn(api, 'listBackups').mockResolvedValue({ available: true, keep: 8, backups: [{ name: 'a', size: 9, made_at: Date.now() - 8 * DAY, encrypted: true }] });
  keep = vi.spyOn(api, 'keepBackup').mockResolvedValue({ ok: true, name: 'b', at: 12345 });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const toasts = () => store.useApp.getState().toasts.map((t) => t.message);

describe('once a week', () => {
  it('makes an encrypted backup when the last is a week old, keeps it, and counts it for the reminder', async () => {
    expect(await auto.backUpIfDue()).toBe(true);
    expect(exportBackup).toHaveBeenCalledWith(expect.any(Function), { encrypted: true });
    expect(keep).toHaveBeenCalledWith(expect.any(Blob), { sealed: true, auto: true });
    expect(store.useApp.getState().lastBackup).toBe(12345);
    // Quietly: nothing to say when all went well.
    expect(toasts()).toEqual([]);
  });

  it('makes a readable one for a library that isn’t encrypted', async () => {
    store.useApp.setState({ encryption: { on: false, pending: 0, rekey: 0, attachments: 0 } });
    await auto.backUpIfDue();
    expect(exportBackup).toHaveBeenCalledWith(expect.any(Function), { encrypted: false });
    expect(keep).toHaveBeenCalledWith(expect.any(Blob), { sealed: false, auto: true });
  });

  it('waits when the last is less than a week old, and starts with none at all', async () => {
    list.mockResolvedValue({ available: true, keep: 8, backups: [{ name: 'a', size: 9, made_at: Date.now() - 6 * DAY, encrypted: true }] });
    expect(await auto.backUpIfDue()).toBe(false);
    expect(exportBackup).not.toHaveBeenCalled();
    list.mockResolvedValue({ available: true, keep: 8, backups: [] });
    expect(await auto.backUpIfDue()).toBe(true);
  });

  it('is made now when asked ("Back up now"), however recent the last, and even when turned off', async () => {
    settings.useSettings.setState({ autoBackup: false });
    list.mockResolvedValue({ available: true, keep: 8, backups: [{ name: 'a', size: 9, made_at: Date.now() - DAY, encrypted: true }] });
    expect(await auto.backUpIfDue()).toBe(false);
    expect(await auto.backUpIfDue({ force: true })).toBe(true);
    expect(keep).toHaveBeenCalledWith(expect.any(Blob), { sealed: true, auto: false });
    expect(toasts()).toEqual(['Backed up your library']);
  });
});

describe('not now', () => {
  it('when not set up on the server, or turned off', async () => {
    list.mockResolvedValue({ available: false, keep: 8, backups: [] });
    expect(await auto.backUpIfDue()).toBe(false);
    list.mockResolvedValue({ available: true, keep: 8, backups: [] });
    settings.useSettings.setState({ autoBackup: false });
    expect(await auto.backUpIfDue()).toBe(false);
    expect(exportBackup).not.toHaveBeenCalled();
  });

  it('offline, locked, still encrypting the library, or saving data', async () => {
    const tries: Array<() => void> = [
      () => store.useApp.setState({ online: false }),
      () => deviceKeys.mockReturnValue([]),
      () => store.useApp.setState({ encryption: { on: true, pending: 3, rekey: 0, attachments: 0 } }),
      () => store.useApp.setState({ encryption: { on: true, pending: 0, rekey: 0, attachments: 2 } }),
      () => Object.defineProperty(navigator, 'connection', { value: { saveData: true }, configurable: true }),
      () => store.useApp.setState({ status: 'loading' }),
    ];
    for (const [i, make] of tries.entries()) {
      store.useApp.setState({ status: 'ready', online: true, encryption: { on: true, pending: 0, rekey: 0, attachments: 0 } });
      deviceKeys.mockReturnValue([{}]);
      delete (navigator as { connection?: unknown }).connection;
      make();
      expect(await auto.backUpIfDue(), String(i)).toBe(false);
    }
    expect(exportBackup).not.toHaveBeenCalled();
  });

  it('one at a time: asked again while making one, it’s the same one', async () => {
    let finish!: () => void;
    exportBackup.mockReturnValue(new Promise((r) => (finish = () => r({ blob: new Blob(['x']), filename: 'x', missing: [], unreadable: [] }))));
    const a = auto.backUpIfDue();
    const b = auto.backUpIfDue();
    await vi.waitFor(() => expect(exportBackup).toHaveBeenCalled());
    finish();
    expect(await a).toBe(true);
    expect(await b).toBe(true);
    expect(exportBackup).toHaveBeenCalledTimes(1);
  });
});

describe('when it can’t be kept', () => {
  it('says once when the library has grown too big, and quietly tries again later otherwise', async () => {
    keep.mockRejectedValue(new ApiError(413, 'too_large', 'too big'));
    await auto.backUpIfDue();
    await auto.backUpIfDue();
    expect(toasts()).toEqual(['Your library is now too big to back up automatically (over 95 MB). Download a backup from Settings → Data instead.']);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    keep.mockRejectedValue(new TypeError('Failed to fetch'));
    expect(await auto.backUpIfDue()).toBe(false);
    expect(warn).toHaveBeenCalled();
    expect(toasts()).toHaveLength(1);
    // Another device made one just now: nothing to say.
    keep.mockRejectedValue(new ApiError(409, 'recent', 'recent'));
    expect(await auto.backUpIfDue()).toBe(false);
    expect(toasts()).toHaveLength(1);
  });

  it('says what it left out, if anything', async () => {
    exportBackup.mockResolvedValue({ blob: new Blob(['x']), filename: 'x', missing: ['a.png'], unreadable: ['Old note'] });
    await auto.backUpIfDue();
    expect(toasts()[0]).toMatch(/^Backed up your library, without 2 items/);
  });
});

describe('looking for one that’s due', () => {
  it('a minute and a half after Lumen opens, then every six hours', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval'] });
    list.mockResolvedValue({ available: true, keep: 8, backups: [{ name: 'a', size: 9, made_at: Date.now(), encrypted: true }] });
    auto.startAutoBackups();
    auto.startAutoBackups();
    await vi.advanceTimersByTimeAsync(89_000);
    expect(list).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(list).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(6 * 3_600_000);
    expect(list).toHaveBeenCalledTimes(2);
  });
});
