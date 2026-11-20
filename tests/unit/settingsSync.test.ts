// @vitest-environment jsdom
/** Settings that follow you to every device: what's taken from another device's save, and what's sent. */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const saved: Array<{ json: string; base: number }> = [];
let refuseOnce: { at: number; enc: boolean; data: string; kgen: number } | null = null;
let serverAt = 100;

vi.mock('../../src/lib/api', () => {
  class ApiError extends Error {}
  class NetworkError extends Error {}
  return {
    ApiError,
    NetworkError,
    currentCodec: () => null,
    currentKeyGen: () => 0,
    libraryEncrypted: () => false,
    api: {
      openSettings: async (s: { data: string }) => s.data,
      saveSettings: async (json: string, base: number) => {
        saved.push({ json, base });
        if (refuseOnce) {
          const settings = refuseOnce;
          refuseOnce = null;
          return { ok: false, settings };
        }
        serverAt += 10;
        return { ok: true, at: serverAt };
      },
    },
  };
});

// jsdom has no matchMedia; settings.ts reads the system theme at load.
window.matchMedia ??= ((query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;

const { receiveSettings, usable } = await import('../../src/lib/settingsSync');
const { useSettings } = await import('../../src/lib/settings');

const stored = (values: object, at: number) => ({ at, enc: false, data: JSON.stringify(values), kgen: 0 });
const stamp = () => JSON.parse(localStorage.getItem('kb.settings.sync') || 'null');

beforeEach(() => {
  localStorage.clear();
  saved.length = 0;
  refuseOnce = null;
  useSettings.getState().update({ theme: 'system', accent: 'iris', noteFont: 'sans', fontSize: 16, workspaceName: 'Lumen' });
  localStorage.removeItem('kb.settings.sync');
});

describe('another device’s settings', () => {
  it('are taken only where they fit this version, and never for text size or layout', () => {
    expect(usable({ theme: 'dark', accent: 'nope', fontSize: 30, noteFont: 7, exportPaper: null, workspaceName: 'Mine' })).toEqual({ theme: 'dark', workspaceName: 'Mine' });
    expect(usable({ theme: 'dark', workspaceName: 'Mine' }, ['theme'])).toEqual({ workspaceName: 'Mine' });
  });

  it('leave out values this version doesn’t know, one by one, keeping the rest', () => {
    const unknown = {
      theme: 'purple',
      defaultMode: 'zoom',
      sort: 'sideways',
      readingWidth: 'huge',
      noteFont: 'comic',
      remoteImages: 'never',
      captureTo: 'inbox',
      exportFormat: 'docx',
      exportPaper: 'a3',
      livePreview: 'yes',
      // In every object, but not an accent: the old `in` check let it through.
      accent: 'toString',
    };
    expect(usable(unknown)).toEqual({});
    expect(usable({ ...unknown, defaultMode: 'read', sort: 'title', exportPaper: 'letter' })).toEqual({ defaultMode: 'read', sort: 'title', exportPaper: 'letter' });
    expect(usable({ workspaceName: 'x'.repeat(500) })).toEqual({ workspaceName: 'x'.repeat(40) });
  });

  it('that can’t be read as settings at all change nothing', () => {
    for (const v of [null, 5, 'theme', ['dark']]) expect(usable(v)).toEqual({});
  });

  it('apply when newer, except what was changed here since, which is then sent on top', async () => {
    useSettings.getState().update({ accent: 'teal' }); // changed here, not yet sent
    expect(stamp().dirty).toEqual(['accent']);
    await receiveSettings(stored({ theme: 'dark', accent: 'rose', noteFont: 'serif' }, 50), false);
    const s = useSettings.getState();
    expect([s.theme, s.accent, s.noteFont]).toEqual(['dark', 'teal', 'serif']);
    expect(saved).toHaveLength(1);
    expect(saved[0].base).toBe(50);
    expect(JSON.parse(saved[0].json)).toMatchObject({ theme: 'dark', accent: 'teal', noteFont: 'serif' });
    expect(stamp()).toEqual({ at: 110, dirty: [] });
  });

  it('that arrive while a save is on its way are merged in, and the save tried again', async () => {
    localStorage.setItem('kb.settings.sync', JSON.stringify({ at: 10, dirty: [] }));
    useSettings.getState().update({ noteFont: 'mono' });
    refuseOnce = stored({ theme: 'light', noteFont: 'serif' }, 40);
    await receiveSettings(stored({}, 10), false); // nothing new, but there's a change to send
    expect(saved.map((x) => x.base)).toEqual([10, 40]);
    expect(JSON.parse(saved[1].json)).toMatchObject({ theme: 'light', noteFont: 'mono' });
    expect(useSettings.getState().theme).toBe('light');
  });

  it('are left alone when nothing changed anywhere', async () => {
    localStorage.setItem('kb.settings.sync', JSON.stringify({ at: 70, dirty: [] }));
    await receiveSettings(stored({ theme: 'dark' }, 70), false);
    expect(saved).toEqual([]);
    expect(useSettings.getState().theme).toBe('system');
  });

  it('start from this device’s when none were saved, and are re-saved once encryption is on', async () => {
    localStorage.setItem('kb.settings.sync', JSON.stringify({ at: 70, dirty: [] }));
    await receiveSettings(null, false);
    expect(saved).toHaveLength(1);
    await receiveSettings(stored({ theme: 'system' }, stamp().at), true);
    expect(saved).toHaveLength(2);
  });
});

describe('settings stored in this browser', () => {
  async function loadWith(stored: unknown) {
    localStorage.setItem('kb.settings', JSON.stringify(stored));
    vi.resetModules();
    const fresh = await import('../../src/lib/settings');
    return fresh.useSettings.getState();
  }

  it('keep what fits, bring numbers into range, and fall back to the default for the rest', async () => {
    const s = await loadWith({
      theme: 'dark',
      defaultMode: 'zoom',
      sort: 7,
      accent: 'blue',
      fontSize: 40,
      sidebarWidth: 'wide',
      listWidth: 100,
      autoLockMinutes: -5,
      expandedFolders: ['a', 3, 'b'],
      exportPaper: 'a3',
      workspaceName: 'Field notes',
    });
    expect(s).toMatchObject({
      theme: 'dark',
      defaultMode: 'edit',
      sort: 'updated',
      accent: 'iris',
      fontSize: 21,
      sidebarWidth: 252,
      listWidth: 260,
      autoLockMinutes: 0,
      expandedFolders: ['a', 'b'],
      exportPaper: null,
      workspaceName: 'Field notes',
    });
  });

  it('start from the defaults when what’s stored isn’t settings', async () => {
    for (const v of [null, 5, 'x', [1]]) expect((await loadWith(v)).theme).toBe('system');
  });

  it('still take a font chosen under its earlier name, if it’s one there is', async () => {
    expect((await loadWith({ editorFont: 'serif' })).noteFont).toBe('serif');
    expect((await loadWith({ editorFont: 'comic' })).noteFont).toBe('sans');
    expect((await loadWith({ editorFont: 'serif', noteFont: 'mono' })).noteFont).toBe('mono');
  });
});
