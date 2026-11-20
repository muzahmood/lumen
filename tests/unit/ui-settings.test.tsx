// @vitest-environment jsdom
/**
 * Settings (src/components/SettingsDialog.tsx) as the person uses it: each section, every switch,
 * choice and field applying at once, synced settings sent to the other devices and per-device ones
 * (text size, auto-lock) kept here as the README says, the Data section's stats, backups (a readable
 * copy of an encrypted library only after a warning), removing unused files and restoring a backup
 * only after asking, signing out, the Shortcuts list against the README, and the dialog's basics
 * (named, Escape and the close button, focus, not closing mid-task).
 */
import {
  FAKE_TIMERS,
  advance,
  allByName,
  byName,
  choose,
  click,
  dialog,
  fakeServer,
  mount,
  nameOf,
  press,
  queryByName,
  settle,
  settleUntil,
  text,
  typeInto,
  unmountAll,
  useServer,
  type FakeServer,
} from './ui-note-helpers';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const backup = vi.hoisted(() => ({
  exportBackup: vi.fn(),
  restoreBackup: vi.fn(),
  importMarkdownFiles: vi.fn(),
}));
vi.mock('../../src/lib/backup', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/lib/backup')>()),
  ...backup,
}));
const picked = vi.hoisted(() => ({ files: [] as File[], accept: [] as string[] }));
vi.mock('../../src/lib/upload', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/lib/upload')>()),
  pickFiles: async (accept: string) => {
    picked.accept.push(accept);
    return picked.files;
  },
}));
const downloads = vi.hoisted(() => [] as Array<{ blob: Blob; name: string }>);
vi.mock('../../src/lib/utils', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/lib/utils')>()),
  downloadBlob: (blob: Blob, name: string) => void downloads.push({ blob, name }),
}));

import { SettingsDialog } from '../../src/components/SettingsDialog';
import { DialogHost } from '../../src/components/ui';
// Back up now loads this on demand. Loaded here first: the first load on a fresh build machine is real
// disk and compile work that can outlast any number of turns a test waits, and a backup still on its
// way from a failed first attempt would then land in the retry, which would fail too.
import '../../src/lib/autoBackup';
import { useSettings } from '../../src/lib/settings';
import { useApp } from '../../src/lib/store';

const NOW = 1_763_400_000_000;
const initialSettings = { ...useSettings.getState() };
let server: FakeServer;

const me = { email: 'owner@example.com', verified: true, via: 'access' as const, accessConfigured: true, storage: 'kv' as const, maxUploadBytes: 25 << 20 };

beforeEach(() => {
  vi.useFakeTimers({ ...FAKE_TIMERS, now: NOW, toFake: [...FAKE_TIMERS.toFake] });
  useSettings.setState(initialSettings);
  vi.clearAllTimers();
  localStorage.clear();
  sessionStorage.clear();
  server = fakeServer();
  useServer(server);
  backup.exportBackup.mockReset().mockResolvedValue({ blob: new Blob(['zip']), filename: 'lumen-backup.zip', missing: [], unreadable: [] });
  backup.restoreBackup.mockReset().mockResolvedValue({ notes: 4, files: 2, drawings: 1, keptDrawings: 0, failed: [] });
  backup.importMarkdownFiles.mockReset().mockResolvedValue(2);
  picked.files = [];
  picked.accept = [];
  downloads.length = 0;
  useApp.setState({
    settingsOpen: true,
    settingsSection: null,
    me,
    encryption: { on: false, pending: 0, rekey: 0, attachments: 0 },
    lastBackup: null,
    dialog: null,
    toasts: [],
  });
});

afterEach(async () => {
  await unmountAll();
  useApp.setState({ settingsOpen: false, dialog: null, toasts: [] });
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function open(section?: string) {
  if (section) useApp.setState({ settingsSection: section });
  const view = await mount(
    <>
      <SettingsDialog />
      <DialogHost />
    </>,
  );
  await settle();
  return view;
}

const settingsDialog = () => document.querySelector<HTMLElement>('.modal.settings');
const toasts = () => useApp.getState().toasts.map((t) => t.message);
const stored = () => JSON.parse(localStorage.getItem('kb.settings') ?? '{}');
const syncStamp = () => JSON.parse(localStorage.getItem('kb.settings.sync') ?? '{"dirty":[]}') as { at: number; dirty: string[] };
const puts = () => server.requests('PUT', '/api/settings');
const section = (label: string) => click(byName(label, '.settings-nav button'));
const switchNamed = (name: string) => byName(name, '[role="switch"]');
const question = () => document.querySelector<HTMLElement>('.modal.dialog');

/** Answers the confirmation dialog on screen. */
async function answer(label: string) {
  const q = question();
  if (!q) throw new Error('No question on screen');
  await click(byName(label, 'button', q));
  await settle();
}

describe('opening and closing Settings', () => {
  it('opens on General, names the dialog, and marks the section shown in the list', async () => {
    await open();
    const d = settingsDialog()!;
    expect(d.getAttribute('role')).toBe('dialog');
    expect(d.getAttribute('aria-modal')).toBe('true');
    expect(nameOf(d)).toBe('Settings');
    expect(d.querySelector('.settings-head h2')?.textContent).toBe('General');
    expect(byName('General', '.settings-nav button').getAttribute('aria-current')).toBe('page');
    expect(byName('Editor', '.settings-nav button').getAttribute('aria-current')).toBeNull();
  });

  it('shows each section when it is picked from the list', async () => {
    await open();
    const want: Record<string, string> = {
      Appearance: 'Accent color',
      Editor: 'Open notes in',
      'Data and backup': 'Back up everything',
      Security: 'Images from other websites',
      Shortcuts: 'Switch between reading and editing',
      General: 'Workspace name',
    };
    for (const [label, shows] of Object.entries(want)) {
      await section(label);
      expect(settingsDialog()!.querySelector('.settings-head h2')?.textContent).toBe(label);
      expect(byName(label, '.settings-nav button').getAttribute('aria-current')).toBe('page');
      expect(text(settingsDialog()!)).toContain(shows);
    }
  });

  it('opens straight on the section it was asked for (the backup reminder opens Data)', async () => {
    await open('data');
    expect(settingsDialog()!.querySelector('.settings-head h2')?.textContent).toBe('Data and backup');
    expect(useApp.getState().settingsSection).toBeNull();
  });

  it('closes with Escape and with its close button', async () => {
    await open();
    await press('Escape', {}, settingsDialog());
    expect(useApp.getState().settingsOpen).toBe(false);
    expect(settingsDialog()).toBeNull();

    useApp.setState({ settingsOpen: true });
    await settle();
    await click(byName('Close settings'));
    expect(useApp.getState().settingsOpen).toBe(false);
  });

  it('moves focus into the dialog when it opens and gives it back when it closes', async () => {
    const before = document.createElement('button');
    before.textContent = 'Open settings';
    document.body.appendChild(before);
    before.focus();
    await open();
    await advance(20);
    expect(settingsDialog()!.contains(document.activeElement)).toBe(true);
    await click(byName('Close settings'));
    expect(document.activeElement).toBe(before);
  });

  it('stays open while a task is under way, even on Escape', async () => {
    let release: () => void = () => undefined;
    server.intercept = (req) =>
      req.path === '/api/files/cleanup'
        ? new Promise((resolve) => {
            release = () => resolve(new Response(JSON.stringify({ dryRun: true, files: [], drawings: [], bytes: 0 }), { headers: { 'content-type': 'application/json' } }));
          })
        : undefined;
    await open('data');
    await click(byName('Remove unused files'));
    await settle();
    expect(text(settingsDialog()!.querySelector('.progress')!)).toContain('Checking for unused files…');
    expect(byName('Remove unused files')).toHaveProperty('disabled', true);
    expect(byName('Download backup')).toHaveProperty('disabled', true);
    expect(byName('Choose file')).toHaveProperty('disabled', true);
    await press('Escape', {}, settingsDialog());
    await click(byName('Close settings'));
    expect(useApp.getState().settingsOpen).toBe(true);
    release();
    await settle();
    expect(toasts()).toContain('Every file is used by a note or one of its saved versions');
    expect(byName('Remove unused files')).toHaveProperty('disabled', false);
  });

  it('Escape on a question asked from Settings closes only the question', async () => {
    useApp.setState({ encryption: { on: true, pending: 0, rekey: 0, attachments: 0 } });
    await open('data');
    await click(byName('Readable .zip'));
    expect(question()).not.toBeNull();
    await press('Escape', {}, question());
    await settle();
    expect(question()).toBeNull();
    expect(backup.exportBackup).not.toHaveBeenCalled();
    expect(useApp.getState().settingsOpen).toBe(true);
  });
});

describe('General', () => {
  it('renames the workspace as it is typed', async () => {
    await open();
    const input = settingsDialog()!.querySelector<HTMLInputElement>('.settings-body input.input')!;
    expect(input.value).toBe('Lumen');
    await typeInto(input, 'Atlas');
    expect(useSettings.getState().workspaceName).toBe('Atlas');
    expect(stored().workspaceName).toBe('Atlas');
    expect(input.maxLength).toBe(40);
  });

  it('turns note previews and the outline off and on, saying so to screen readers', async () => {
    await open();
    for (const [name, key] of [
      ['Note previews in lists', 'listPreviews'],
      ['Outline on wide screens', 'showOutline'],
    ] as const) {
      const sw = switchNamed(name);
      expect(sw.getAttribute('aria-checked')).toBe('true');
      await click(sw);
      expect(useSettings.getState()[key]).toBe(false);
      expect(sw.getAttribute('aria-checked')).toBe('false');
      expect(stored()[key]).toBe(false);
      await click(sw);
      expect(useSettings.getState()[key]).toBe(true);
    }
  });

  it('says which settings stay with this device, as the README does', async () => {
    await open();
    const note = text(settingsDialog()!.querySelector('.setting-note')!);
    expect(note).toContain('text size');
    expect(note).toContain('width of the sidebar and note list');
    expect(note).toContain('which folders are open');
    expect(note).toContain('locking automatically');
  });
});

describe('Appearance', () => {
  it('switches the theme at once and marks the chosen card', async () => {
    await open();
    await section('Appearance');
    const group = byName('Theme', '[role="radiogroup"]');
    const dark = byName('Dark', '[role="radio"]', group);
    await click(dark);
    expect(useSettings.getState().theme).toBe('dark');
    expect(stored().theme).toBe('dark');
    expect(dark.getAttribute('aria-checked')).toBe('true');
    expect(byName('System', '[role="radio"]', group).getAttribute('aria-checked')).toBe('false');
  });

  it('picks an accent color, each swatch named for screen readers', async () => {
    await open();
    await section('Appearance');
    const group = byName('Accent color', '[role="radiogroup"]');
    const swatches = group.querySelectorAll('[role="radio"]');
    expect(swatches.length).toBe(7);
    for (const s of swatches) expect(nameOf(s)).not.toBe('');
    await click(byName('Rose', '[role="radio"]', group));
    expect(useSettings.getState().accent).toBe('rose');
    expect(byName('Rose', '[role="radio"]', group).getAttribute('aria-checked')).toBe('true');
    expect(byName('Lumen', '[role="radio"]', group).getAttribute('aria-checked')).toBe('false');
  });

  it('changes the note font, the text size and the line width', async () => {
    await open();
    await section('Appearance');
    await click(byName(/^Ag\s*Serif/, '[role="radio"]'));
    expect(useSettings.getState().noteFont).toBe('serif');
    const size = byName<HTMLInputElement>('Text size', 'input');
    await choose(size, '19');
    expect(useSettings.getState().fontSize).toBe(19);
    expect(text(settingsDialog()!)).toContain('19px');
    await click(byName('Wide', '[role="radio"]', byName('Line width', '[role="radiogroup"]')));
    expect(useSettings.getState().readingWidth).toBe('wide');
  });
});

describe('Editor', () => {
  it('chooses how notes open', async () => {
    await open();
    await section('Editor');
    const group = byName('Open notes in', '[role="radiogroup"]');
    await click(byName('Read', '[role="radio"]', group));
    expect(useSettings.getState().defaultMode).toBe('read');
    expect(byName('Read', '[role="radio"]', group).getAttribute('aria-checked')).toBe('true');
  });

  it('offers image thumbnails only while live preview is off', async () => {
    await open();
    await section('Editor');
    expect(queryByName('Image thumbnails', '[role="switch"]')).toBeNull();
    await click(switchNamed('Live preview'));
    expect(useSettings.getState().livePreview).toBe(false);
    await click(switchNamed('Image thumbnails'));
    expect(useSettings.getState().editorImages).toBe(false);
  });

  it('turns line breaks, spell check and photo shrinking off', async () => {
    await open();
    await section('Editor');
    for (const [name, key] of [
      ['Single line breaks', 'lineBreaks'],
      ['Spell check', 'spellcheck'],
      ['Shrink large photos', 'compressImages'],
    ] as const) {
      await click(switchNamed(name));
      expect(useSettings.getState()[key]).toBe(false);
      expect(stored()[key]).toBe(false);
    }
  });
});

describe('settings on every device', () => {
  it('sends a synced setting to the server a moment after it changes', async () => {
    await open();
    await section('Appearance');
    await click(byName('Dark', '[role="radio"]'));
    expect(syncStamp().dirty).toContain('theme');
    expect(puts()).toHaveLength(0);
    await advance(1600);
    expect(puts()).toHaveLength(1);
    const body = puts()[0].body!;
    expect(body.enc).toBe(false);
    expect(JSON.parse(body.data).theme).toBe('dark');
    expect(syncStamp().dirty).toEqual([]);
  });

  it('sends several quick changes together, once', async () => {
    await open();
    await section('Editor');
    await click(switchNamed('Spell check'));
    await advance(500);
    await click(switchNamed('Single line breaks'));
    await advance(1600);
    expect(puts()).toHaveLength(1);
    const data = JSON.parse(puts()[0].body!.data);
    expect(data.spellcheck).toBe(false);
    expect(data.lineBreaks).toBe(false);
  });

  it('keeps the text size on this device only', async () => {
    await open();
    await section('Appearance');
    await choose(byName('Text size', 'input'), '20');
    expect(useSettings.getState().fontSize).toBe(20);
    await advance(2000);
    expect(syncStamp().dirty).not.toContain('fontSize');
    expect(puts()).toHaveLength(0);
  });

  it('keeps locking automatically on this device only', async () => {
    const vault = await import('../../src/lib/vault');
    vault.useVault.setState({ state: 'unlocked' });
    useApp.setState({ encryption: { on: true, pending: 0, rekey: 0, attachments: 0 } });
    await open();
    await section('Security');
    await choose(byName('Lock automatically', 'select'), '60');
    expect(useSettings.getState().autoLockMinutes).toBe(60);
    expect(stored().autoLockMinutes).toBe(60);
    await advance(2000);
    expect(syncStamp().dirty).not.toContain('autoLockMinutes');
    expect(puts()).toHaveLength(0);
    vault.useVault.setState({ state: 'checking' });
  });

  it('sends a change to images from other websites, which is synced', async () => {
    await open();
    await section('Security');
    await choose(byName('Images from other websites', 'select'), 'ask');
    expect(useSettings.getState().remoteImages).toBe('ask');
    await advance(1600);
    expect(JSON.parse(puts()[0].body!.data).remoteImages).toBe('ask');
  });
});

describe('Data and backup', () => {
  it('shows how many notes, files and drawings there are', async () => {
    await open('data');
    const stats = Array.from(settingsDialog()!.querySelectorAll('.stat')).map(
      (s) => `${s.querySelector('.stat-value')!.textContent} ${s.querySelector('.stat-label')!.textContent}`,
    );
    expect(stats).toEqual(['3 Notes', '2.0 KB 2 files', '512 B 1 drawings']);
    expect(text(settingsDialog()!)).toContain('Cloudflare Workers KV, 1 GB free.');
  });

  it('downloads a backup, says when, and remembers it for every device', async () => {
    server.intercept = (req) =>
      req.path === '/api/backups/made' ? new Response(JSON.stringify({ ok: true, at: NOW }), { headers: { 'content-type': 'application/json' } }) : undefined;
    await open('data');
    expect(text(settingsDialog()!)).toContain('No backup made yet.');
    await click(byName('Download backup'));
    await settle();
    expect(backup.exportBackup).toHaveBeenCalledWith(expect.any(Function), { encrypted: false });
    expect(downloads.map((d) => d.name)).toEqual(['lumen-backup.zip']);
    expect(server.requests('POST', '/api/backups/made')).toHaveLength(1);
    expect(useApp.getState().lastBackup).toBe(NOW);
    expect(toasts()).toContain('Backup downloaded');
    expect(text(settingsDialog()!)).toContain('Last backup');
  });

  describe('automatic backups', () => {
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    const KEPT = [
      { name: '2026-11-16T03-17-00-000Z.zip', size: 2048, made_at: NOW - 86_400_000, encrypted: false },
      { name: '2026-11-09T03-17-00-000Z.zip', size: 1024, made_at: NOW - 8 * 86_400_000, encrypted: false },
    ];

    it('says they aren’t set up when the server has no bucket for them', async () => {
      server.intercept = (req) => (req.path === '/api/backups' ? json({ available: false, keep: 8, backups: [] }) : undefined);
      await open('data');
      expect(text(settingsDialog()!)).toContain('Not set up on this Lumen: they need an R2 bucket of their own.');
      expect(queryByName('Automatic backups', '[role="switch"]')).toBeNull();
      expect(queryByName('Back up now')).toBeNull();
    });

    it('lists those kept, restores one through the usual restore, downloads one, and can be turned off', async () => {
      const { fullDate } = await import('../../src/lib/utils');
      server.intercept = (req) => {
        if (req.path === '/api/backups') return json({ available: true, keep: 8, backups: KEPT });
        if (req.path === `/api/backups/${KEPT[1].name}`) return new Response('PK zip bytes');
        return undefined;
      };
      await open('data');
      expect(text(settingsDialog()!)).toContain('The newest 8 are kept.');
      const items = Array.from(settingsDialog()!.querySelectorAll('.kept-backup .kept-when')).map((el) => el.textContent);
      expect(items).toEqual([`${fullDate(KEPT[0].made_at)}2.0 KB`, `${fullDate(KEPT[1].made_at)}1.0 KB`]);

      await click(byName(`Restore the backup from ${fullDate(KEPT[1].made_at)}`));
      await answer('Restore');
      await settle();
      const [file] = backup.restoreBackup.mock.calls[0] as [File];
      expect(file.name).toBe(KEPT[1].name);
      expect(await file.text()).toBe('PK zip bytes');
      expect(toasts().some((t) => t.startsWith('Restored'))).toBe(true);

      await click(byName(`Download the backup from ${fullDate(KEPT[1].made_at)}`));
      await settle();
      expect(downloads.map((d) => d.name)).toEqual([`lumen-${KEPT[1].name}`]);

      await click(switchNamed('Automatic backups'));
      expect(useSettings.getState().autoBackup).toBe(false);
    });

    it('makes one now when asked, and lists it', async () => {
      useApp.setState({ status: 'ready', online: true });
      let kept = [...KEPT];
      server.intercept = (req) => {
        if (req.path === '/api/backups' && req.method === 'GET') return json({ available: true, keep: 8, backups: kept });
        if (req.path === '/api/backups' && req.method === 'POST') {
          kept = [{ name: '2026-11-17T09-00-00-000Z.zip', size: 3, made_at: NOW, encrypted: false }, ...kept];
          return json({ ok: true, name: kept[0].name, at: NOW }, 201);
        }
        return undefined;
      };
      await open('data');
      await click(byName('Back up now'));
      // Making the backup takes a varying number of turns (more on a busy build machine), so wait for
      // it to be kept and listed rather than for a fixed number.
      await settleUntil(
        () => server.requests('POST', '/api/backups').length > 0 && settingsDialog()?.querySelectorAll('.kept-backup').length === 3,
        'the backup to be kept and listed',
      );
      expect(backup.exportBackup).toHaveBeenCalledWith(expect.any(Function), { encrypted: false });
      expect(server.requests('POST', '/api/backups')).toHaveLength(1);
      expect(toasts()).toContain('Backed up your library');
      expect(settingsDialog()!.querySelectorAll('.kept-backup')).toHaveLength(3);
      expect(useApp.getState().lastBackup).toBe(NOW);
    });
  });

  it('with encryption on, downloads the encrypted backup without asking', async () => {
    useApp.setState({ encryption: { on: true, pending: 0, rekey: 0, attachments: 0 } });
    await open('data');
    expect(text(settingsDialog()!)).toContain('An encrypted file of every note');
    await click(byName('Download backup'));
    await settle();
    expect(question()).toBeNull();
    expect(backup.exportBackup).toHaveBeenCalledWith(expect.any(Function), { encrypted: true });
    expect(toasts()).toContain('Encrypted backup downloaded');
  });

  it('with encryption on, warns before a readable copy and makes none on Cancel', async () => {
    useApp.setState({ encryption: { on: true, pending: 0, rekey: 0, attachments: 0 } });
    await open('data');
    await click(byName('Readable .zip'));
    expect(text(question()!)).toContain('anyone who gets the file can read every note');
    await answer('Cancel');
    expect(backup.exportBackup).not.toHaveBeenCalled();
    expect(downloads).toHaveLength(0);

    await click(byName('Readable .zip'));
    await answer('Download readable copy');
    expect(backup.exportBackup).toHaveBeenCalledWith(expect.any(Function), { encrypted: false });
    expect(downloads).toHaveLength(1);
  });

  it('has no readable copy to offer while encryption is off', async () => {
    await open('data');
    expect(queryByName('Readable .zip')).toBeNull();
  });

  it('says which files a backup left out', async () => {
    backup.exportBackup.mockResolvedValue({ blob: new Blob(['zip']), filename: 'b.zip', missing: ['a.png', 'b.pdf', 'c.mp4', 'd.txt'], unreadable: [] });
    await open('data');
    await click(byName('Download backup'));
    await settle();
    expect(toasts().at(-1)).toBe('Backup downloaded, but 4 files couldn’t be included: a.png, b.pdf, c.mp4, and 1 more. Check your connection and try again.');
  });

  it('says which notes a backup left out because this device can’t decrypt them', async () => {
    backup.exportBackup.mockResolvedValue({ blob: new Blob(['zip']), filename: 'b.zip', missing: [], unreadable: ['Unlucky note'] });
    await open('data');
    await click(byName('Download backup'));
    await settle();
    expect(toasts().at(-1)).toBe(
      'Backup downloaded without one note this device can’t decrypt: “Unlucky note”. It was encrypted with a different key, or changed outside Lumen.',
    );
  });

  it('says both when a backup left out notes and files', async () => {
    backup.exportBackup.mockResolvedValue({ blob: new Blob(['zip']), filename: 'b.zip', missing: ['a.png'], unreadable: ['One', 'Two'] });
    await open('data');
    await click(byName('Download backup'));
    await settle();
    expect(toasts().at(-1)).toBe(
      'Backup downloaded without 2 notes this device can’t decrypt: “One”, “Two”. They were encrypted with a different key, or changed outside Lumen. 1 file couldn’t be included either: a.png. Check your connection and try again.',
    );
  });

  it('shows the progress of a backup, and says what went wrong if it fails', async () => {
    let fail: (err: Error) => void = () => undefined;
    backup.exportBackup.mockImplementation(
      (progress: (m: string, f?: number) => void) =>
        new Promise((_, reject) => {
          progress('Adding files…', 0.5);
          fail = reject;
        }),
    );
    await open('data');
    await click(byName('Download backup'));
    await settle();
    const bar = settingsDialog()!.querySelector('.progress')!;
    expect(bar.getAttribute('role')).toBe('status');
    expect(text(bar)).toContain('Adding files…');
    expect(bar.querySelector<HTMLElement>('.progress-bar div')!.style.width).toBe('50%');
    fail(new Error('The connection dropped.'));
    await settle();
    expect(settingsDialog()!.querySelector('.progress')).toBeNull();
    expect(toasts()).toContain('The connection dropped.');
  });

  it('asks before removing unused files, and removes nothing on Cancel', async () => {
    server.intercept = (req) =>
      req.path === '/api/files/cleanup'
        ? new Response(
            JSON.stringify({ dryRun: req.body!.dryRun, files: [{ id: 'f1', name: 'old.png', size: 3000 }], drawings: [{ id: 'd1', size: 100 }], bytes: 3100 }),
            { headers: { 'content-type': 'application/json' } },
          )
        : undefined;
    await open('data');
    await click(byName('Remove unused files'));
    await settle();
    expect(text(question()!)).toContain('Delete 2 unused files?');
    expect(text(question()!)).toContain('This frees 3.0 KB');
    await answer('Cancel');
    const cleanups = () => server.requests('POST', '/api/files/cleanup').map((r) => r.body!.dryRun);
    expect(cleanups()).toEqual([true]);

    await click(byName('Remove unused files'));
    await settle();
    await answer('Delete files');
    expect(cleanups()).toEqual([true, true, false]);
    expect(toasts()).toContain('Freed 3.0 KB');
  });

  it('Escape on the question about unused files removes nothing', async () => {
    server.intercept = (req) =>
      req.path === '/api/files/cleanup'
        ? new Response(JSON.stringify({ dryRun: true, files: [{ id: 'f1', name: 'old.png', size: 30 }], drawings: [], bytes: 30 }), {
            headers: { 'content-type': 'application/json' },
          })
        : undefined;
    await open('data');
    await click(byName('Remove unused files'));
    await settle();
    await press('Escape', {}, question());
    await settle();
    expect(server.requests('POST', '/api/files/cleanup').map((r) => r.body!.dryRun)).toEqual([true]);
  });

  it('asks before restoring a backup, and restores nothing on Cancel', async () => {
    picked.files = [new File(['x'], 'lumen-backup.zip')];
    await open('data');
    await click(byName('Choose file'));
    await settle();
    expect(picked.accept[0]).toContain('.lumenbackup');
    expect(text(question()!)).toContain('Notes in lumen-backup.zip replace notes with the same id here.');
    await answer('Cancel');
    expect(backup.restoreBackup).not.toHaveBeenCalled();

    await click(byName('Choose file'));
    await settle();
    await answer('Restore');
    expect(backup.restoreBackup).toHaveBeenCalledTimes(1);
    expect(toasts()).toContain('Restored 4 notes, 2 files and 1 drawing.');
  });

  it('does nothing when no backup file is picked', async () => {
    await open('data');
    await click(byName('Choose file'));
    await settle();
    expect(question()).toBeNull();
    expect(backup.restoreBackup).not.toHaveBeenCalled();
  });

  it('asks for an encrypted backup’s passphrase with the text hidden', async () => {
    picked.files = [new File(['x'], 'old.lumenbackup')];
    let typed: string | null = null;
    backup.restoreBackup.mockImplementation(async (_f: File, _p: unknown, ask: (retry: boolean) => Promise<string | null>) => {
      typed = await ask(false);
      return null;
    });
    await open('data');
    await click(byName('Choose file'));
    await settle();
    await answer('Restore');
    const prompt = question()!;
    expect(text(prompt)).toContain('Unlock this backup');
    const input = prompt.querySelector('input')!;
    expect(input.type).toBe('password');
    expect(nameOf(input)).toBe('Passphrase or recovery key');
    await typeInto(input, 'old secret words');
    await answer('Unlock');
    expect(typed).toBe('old secret words');
  });

  it('never puts a backup’s passphrase into the page’s markup while it is typed', async () => {
    picked.files = [new File(['x'], 'old.lumenbackup')];
    backup.restoreBackup.mockImplementation(async (_f: File, _p: unknown, ask: (retry: boolean) => Promise<string | null>) => {
      await ask(false);
      return null;
    });
    await open('data');
    await click(byName('Choose file'));
    await settle();
    await answer('Restore');
    const input = question()!.querySelector('input')!;
    await typeInto(input, 'old secret words');
    expect(input.getAttribute('value')).not.toBe('old secret words');
    expect(document.body.innerHTML).not.toContain('old secret words');
    await answer('Cancel');
  });

  it('imports Markdown files as notes', async () => {
    picked.files = [new File(['# a'], 'a.md'), new File(['b'], 'b.txt')];
    await open('data');
    await click(byName('Choose files'));
    await settle();
    expect(backup.importMarkdownFiles).toHaveBeenCalledWith(picked.files, expect.any(Function));
    expect(toasts()).toContain('Imported 2 notes');
  });
});

describe('Security', () => {
  it('says the app is behind Cloudflare Access, and who is signed in', async () => {
    await open();
    await section('Security');
    expect(text(settingsDialog()!)).toContain('Protected by Cloudflare Access');
    expect(text(settingsDialog()!)).toContain('Signed in as owner@example.com.');
  });

  it('says when it runs locally without Cloudflare Access', async () => {
    useApp.setState({ me: { ...me, verified: false, via: 'local', email: null } });
    await open();
    await section('Security');
    expect(text(settingsDialog()!)).toContain('Running locally without Cloudflare Access');
  });

  it('offers to set up encryption while it is off', async () => {
    await open();
    await section('Security');
    expect(text(settingsDialog()!)).toContain('End-to-end encryption is off');
    expect(byName('Set up encryption')).toBeTruthy();
  });

  it('warns about who can change the app while encryption is on', async () => {
    const vault = await import('../../src/lib/vault');
    vault.useVault.setState({ state: 'unlocked' });
    useApp.setState({ encryption: { on: true, pending: 0, rekey: 0, attachments: 0 } });
    await open();
    await section('Security');
    expect(text(settingsDialog()!)).toContain('End-to-end encryption is on');
    expect(text(settingsDialog()!)).toContain('could capture your passphrase');
    vault.useVault.setState({ state: 'checking' });
  });

  it('asks before signing out of this device, and keeps everything on Cancel', async () => {
    localStorage.setItem('kb.draft.n1~tab', JSON.stringify({ content: 'unsent' }));
    await open();
    await section('Security');
    await click(byName(/Sign out/, 'button', settingsDialog()!));
    await settle();
    expect(text(question()!)).toContain('Sign out of this device?');
    expect(text(question()!)).toContain('Some edits haven’t reached the server yet and will be lost.');
    expect(byName('Sign out and discard', 'button', question()!)).toBeTruthy();
    await answer('Cancel');
    expect(server.requests('POST', '/api/signout')).toHaveLength(0);
    expect(localStorage.getItem('kb.draft.n1~tab')).not.toBeNull();
  });
});

describe('Shortcuts', () => {
  const shown = async () => {
    await open();
    await section('Shortcuts');
    return Array.from(settingsDialog()!.querySelectorAll('.shortcut')).map((row) => ({
      does: row.querySelector('span')!.textContent!,
      keys: Array.from(row.querySelectorAll('kbd')).map((k) => k.textContent),
    }));
  };

  it('lists the README’s main shortcuts with their keys', async () => {
    const rows = await shown();
    const keysFor = (does: string) => rows.find((r) => r.does === does)?.keys.join(' ');
    expect(keysFor('Search notes and run commands')).toBe('Ctrl K');
    expect(keysFor('Switch between reading and editing')).toBe('Ctrl E');
    expect(keysFor('Save now')).toBe('Ctrl S');
    expect(keysFor('Show or hide the sidebar')).toBe('Ctrl \\');
    expect(keysFor('Open settings')).toBe('Ctrl ,');
    expect(keysFor('Highlight')).toBe('Ctrl Shift H');
    expect(keysFor('Insert link')).toBe('Ctrl Shift K');
    expect(keysFor('Heading 1 to 6')).toBe('Ctrl Alt 1–6');
    expect(keysFor('Tick a task (or make the line one)')).toBe('Ctrl Enter');
    expect(keysFor('New note')).toBe('Alt N');
  });

  it('lists every shortcut in the README’s table', async () => {
    const readme = readFileSync(join(process.cwd(), 'README.md'), 'utf8');
    const table = readme.slice(readme.indexOf('## Keyboard shortcuts'), readme.indexOf('## Brand'));
    expect(table).toContain('Ctrl/⌘ Shift V');
    const rows = await shown();
    const all = rows.map((r) => `${r.keys.join(' ')} ${r.does}`).join('\n');
    expect(all).toMatch(/Ctrl Shift V .*plain text/i);
    expect(all).toMatch(/Ctrl A .*(all|every)/i);
    expect(all).toMatch(/Shift click/i);
  });
});

describe('accessibility basics', () => {
  it('gives every field in every section a name', async () => {
    const vault = await import('../../src/lib/vault');
    vault.useVault.setState({ state: 'unlocked' });
    useApp.setState({ encryption: { on: true, pending: 0, rekey: 0, attachments: 0 } });
    await open();
    const unnamed: string[] = [];
    for (const label of ['General', 'Appearance', 'Editor', 'Data and backup', 'Security', 'Shortcuts']) {
      await section(label);
      for (const el of settingsDialog()!.querySelectorAll<HTMLElement>('input:not([hidden]), select, textarea, button, [role="switch"], [role="radio"]')) {
        if (!nameOf(el)) unnamed.push(`${label}: ${el.outerHTML.slice(0, 80)}`);
      }
    }
    vault.useVault.setState({ state: 'checking' });
    expect(unnamed).toEqual([]);
  });

  it('marks switches as switches with their state', async () => {
    await open();
    await section('Editor');
    const switches = settingsDialog()!.querySelectorAll('[role="switch"]');
    expect(switches.length).toBe(4);
    for (const s of switches) expect(['true', 'false']).toContain(s.getAttribute('aria-checked'));
  });

  it('names its list of sections', async () => {
    await open();
    expect(allByName('Settings sections', 'nav')).toHaveLength(1);
    expect(dialog()).toBe(settingsDialog());
  });
});
