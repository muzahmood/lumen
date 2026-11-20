// @vitest-environment jsdom
/**
 * Signing out of the device (src/lib/signout.ts), beyond e2ee-vault.test.ts: asking first (and
 * changing nothing when the answer is no), warning about edits that haven't reached the server, the
 * Cache Storage copies, going offline, and a browser where part of the clearing fails.
 */
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { json, polyfillMatchMedia, settle, standInServer, type StandIn } from './cov-helpers';

polyfillMatchMedia();

let signout: typeof import('../../src/lib/signout');
let store: typeof import('../../src/lib/store');
let saver: typeof import('../../src/lib/saver');
let server: StandIn;
const nav = { href: '' };
const posted: unknown[] = [];

class FakeChannel {
  constructor(public name: string) {}
  postMessage(msg: unknown) {
    posted.push(msg);
  }
  addEventListener() {}
  close() {}
}

function fakeCaches(names: string[], fail = false) {
  const deleted: string[] = [];
  vi.stubGlobal('caches', {
    keys: async () => {
      if (fail) throw new DOMException('The operation is insecure.', 'SecurityError');
      return [...names];
    },
    delete: async (n: string) => (deleted.push(n), true),
  });
  return deleted;
}

/** Answers the confirmation the sign-out asks for, once it's showing. */
async function answer(yes: boolean) {
  await vi.waitFor(() => expect(store.useApp.getState().dialog).not.toBeNull());
  const d = store.useApp.getState().dialog!;
  store.useApp.setState({ dialog: null });
  d.resolve(yes);
  return d;
}

const kbKeys = () => Object.keys(localStorage).filter((k) => k.startsWith('kb.')).sort();

beforeEach(async () => {
  vi.stubGlobal('indexedDB', new IDBFactory());
  vi.stubGlobal('BroadcastChannel', FakeChannel);
  posted.length = 0;
  nav.href = '';
  vi.stubGlobal('location', {
    origin: 'http://localhost',
    pathname: '/',
    search: '',
    hash: '',
    get href() {
      return 'http://localhost/';
    },
    set href(v: string) {
      nav.href = v;
    },
    reload: () => undefined,
    replace: () => undefined,
  });
  localStorage.clear();
  sessionStorage.clear();
  sessionStorage.setItem('kb.tab-id', 'signouttab');
  server = standInServer();
  server.on('POST', '/api/signout', () => json(200, { ok: true }, { 'clear-site-data': '"cache"' }));
  vi.resetModules();
  store = await import('../../src/lib/store');
  saver = await import('../../src/lib/saver');
  signout = await import('../../src/lib/signout');
  localStorage.setItem('kb.settings', '{"theme":"dark"}');
  localStorage.setItem('kb.vault.sealed', '1');
  localStorage.setItem('kb.filter-something', 'x');
  localStorage.setItem('not-lumen', 'kept');
  sessionStorage.setItem('kb.filter', '{}');
});

afterEach(() => {
  saver.discardAll();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('signing out of the device', () => {
  it('changes nothing when the answer is no', async () => {
    const deleted = fakeCaches(['lumen-app-v1']);
    const done = signout.signOutOfDevice(false);
    await answer(false);
    await done;
    expect(kbKeys()).toEqual(['kb.filter-something', 'kb.settings', 'kb.tab.signouttab', 'kb.vault.sealed']);
    expect(sessionStorage.getItem('kb.filter')).toBe('{}');
    expect(deleted).toEqual([]);
    expect(posted.filter((m) => !!m && typeof m === 'object' && 'signout' in m)).toEqual([]);
    expect(server.requests('POST', '/api/signout')).toEqual([]);
    expect(nav.href).toBe('');
  });

  it('first tries to send what’s unsent, then warns about what still couldn’t go', async () => {
    fakeCaches([]);
    server.on('PATCH', /^\/api\/notes\//, () => Promise.reject(new TypeError('Failed to fetch')));
    localStorage.setItem('kb.draft.n1~closedtab', JSON.stringify({ content: 'offline words', baseVersion: 1, at: 1 }));
    saver.recoverDrafts();
    const done = signout.signOutOfDevice(false);
    const d = await answer(true);
    await done;
    expect(server.requests('PATCH', '/api/notes/n1').length).toBeGreaterThan(0);
    expect(d).toMatchObject({ confirmLabel: 'Sign out and discard', danger: true });
    expect(d.message).toMatch(/haven’t reached the server yet and will be lost/);
  });

  it('discards for good: leaving the page, or a retry, never writes the discarded edits back', async () => {
    fakeCaches([]);
    server.on('PATCH', /^\/api\/notes\//, () => Promise.reject(new TypeError('Failed to fetch')));
    localStorage.setItem('kb.draft.n1~closedtab', JSON.stringify({ content: 'offline words', baseVersion: 1, at: 1 }));
    saver.recoverDrafts();
    const done = signout.signOutOfDevice(false);
    await answer(true);
    await done;
    const sent = server.requests('PATCH', '/api/notes/n1').length;
    // The page goes to Access's sign-out: hidden, then gone (what a shared computer's next person
    // would otherwise find, and send, as unsent edits).
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new Event('pagehide'));
    await settle();
    await saver.flushAll();
    await settle();
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    expect(kbKeys().filter((k) => k.startsWith('kb.draft.'))).toEqual([]);
    expect(saver.hasUnsaved()).toBe(false);
    expect(server.requests('PATCH', '/api/notes/n1')).toHaveLength(sent);
  });

  it('with nothing unsent, says plainly what goes, and ends the Access session', async () => {
    const deleted = fakeCaches(['lumen-app-v1', 'lumen-files']);
    const done = signout.signOutOfDevice(false);
    const d = await answer(true);
    await done;
    expect(d).toMatchObject({ confirmLabel: 'Sign out', danger: false });
    expect(deleted.sort()).toEqual(['lumen-app-v1', 'lumen-files']);
    expect(kbKeys()).toEqual(['kb.settings']);
    expect(localStorage.getItem('not-lumen')).toBe('kept');
    expect(sessionStorage.length).toBe(0);
    expect(posted).toContainEqual({ signout: '/cdn-cgi/access/logout' });
    expect(server.requests('POST', '/api/signout')).toHaveLength(1);
    expect(nav.href).toBe('/cdn-cgi/access/logout');
  });

  it('offline, clears everything it can, says the browser still holds opened files before leaving, and empties them next time', async () => {
    fakeCaches(['lumen-app-v1']);
    server.on('POST', '/api/signout', () => Promise.reject(new TypeError('Failed to fetch')));
    const done = signout.signOutOfDevice(true);
    await answer(true);
    // The browser's own cache of opened pictures and files only the server's answer could empty.
    const notice = await answer(true);
    expect(notice).toMatchObject({ notice: true, title: 'Pictures and files opened here are still in this browser', confirmLabel: 'Sign out' });
    expect(notice.message).toMatch(/clear this site’s data in the browser’s settings/);
    await done;
    expect(kbKeys()).toEqual(['kb.settings', 'kb.signout.clear-cache']);
    expect(nav.href).toBe('/');
    expect(store.useApp.getState().toasts).toEqual([]);

    // The next time Lumen opens in this browser (and is online): emptied, once.
    server.on('POST', '/api/cache/clear', () => json(200, { ok: true }, { 'clear-site-data': '"cache"' }));
    signout.clearCacheLeftBySignOut();
    await settle();
    expect(server.requests('POST', '/api/cache/clear')).toHaveLength(1);
    expect(kbKeys()).toEqual(['kb.settings']);
    signout.clearCacheLeftBySignOut();
    await settle();
    expect(server.requests('POST', '/api/cache/clear')).toHaveLength(1);
  });

  it('when the browser won’t list its caches, says to clear the site data before leaving', async () => {
    fakeCaches(['lumen-app-v1'], true);
    const done = signout.signOutOfDevice(true);
    await answer(true);
    const notice = await answer(true);
    expect(notice).toMatchObject({ notice: true, title: 'Not everything here could be cleared' });
    await done;
    expect(nav.href).toBe('/');
  });

  it('in a browser without IndexedDB (some private windows), still removes the drafts and markers kept here', async () => {
    fakeCaches([]);
    vi.stubGlobal('indexedDB', undefined);
    localStorage.setItem('kb.draft.n9~closedtab', JSON.stringify({ content: 'private words', baseVersion: 1, at: 1 }));
    const done = signout.signOutOfDevice(true);
    await answer(true);
    await done;
    await settle();
    expect(kbKeys()).toEqual(['kb.settings']);
    expect(sessionStorage.length).toBe(0);
    expect(nav.href).toBe('/');
  });
});
