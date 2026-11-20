// @vitest-environment jsdom
/**
 * Version history (src/components/HistoryDialog.tsx), against a stand-in server through the app's real
 * API client: the snapshots newest first, what restoring one would change compared with the note now
 * (README: "Version history shows what each snapshot would change before you restore it"), a preview
 * of it, and restoring only after saying yes, with the replaced text kept in history.
 */
import {
  byName,
  click,
  dialog,
  fakeServer,
  metaOf,
  mount,
  press,
  settle,
  text,
  unmountAll,
  useServer,
  type FakeServer,
} from './ui-note-helpers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('mermaid', () => ({ default: { initialize: () => {}, render: async (id: string) => ({ svg: `<svg id="${id}"></svg>` }) } }));

import { HistoryDialog } from '../../src/components/HistoryDialog';
import { DialogHost } from '../../src/components/ui';
import { edit, statusOf, track } from '../../src/lib/saver';
import { noteCache, upsertMeta, useApp } from '../../src/lib/store';

const HOUR = 3_600_000;
let server: FakeServer;
let seq = 0;
let id: string;

/** A note open on this device with two earlier snapshots on the server. */
function seed(opts: { versions?: boolean } = {}) {
  id = `hist${++seq}`;
  const now = Date.now();
  const row = server.add({ id, title: 'Plan', content: 'one\ntwo\nthree', version: 3, updated_at: now });
  if (opts.versions !== false) {
    server.addVersion(id, { title: 'Plan', content: 'one\ntwo', created_at: now - 2 * HOUR });
    server.addVersion(id, { title: 'Old plan', content: 'one', created_at: now - 26 * HOUR });
  }
  upsertMeta(metaOf(row));
  noteCache.set(id, { ...row });
  track({ ...row });
}

async function openHistory() {
  await mount(
    <>
      <HistoryDialog />
      <DialogHost />
    </>,
  );
  useApp.setState({ historyFor: id });
  await settle();
}

const items = () => Array.from(document.querySelectorAll<HTMLButtonElement>('.history-item'));
const restoreButton = () => byName<HTMLButtonElement>('Restore this version');
const patches = () => server.requests('PATCH').map((r) => r.body!);

beforeEach(() => {
  server = fakeServer();
  useServer(server);
  localStorage.clear();
  useApp.setState({ historyFor: null, dialog: null, toasts: [], notes: {}, reloadToken: 0 });
});
afterEach(async () => {
  useApp.setState({ historyFor: null, dialog: null });
  await unmountAll();
  vi.unstubAllGlobals();
});

describe('the list of snapshots', () => {
  it('is a dialog named Version history that lists the snapshots newest first, with the newest picked', async () => {
    seed();
    await openHistory();
    expect(dialog()?.getAttribute('aria-label')).toBe('Version history');
    expect(items()).toHaveLength(2);
    expect(items()[0].textContent).toContain('2 hours ago');
    expect(items()[1].textContent).toContain('yesterday');
    expect(items()[0].className).toContain('is-active');
  });

  it('shows what restoring the picked snapshot would change, compared with the note now', async () => {
    seed();
    await openHistory();
    expect(text(dialog()!)).toContain('− In this version');
    expect(text(dialog()!)).toContain('+ In the note now');
    const added = Array.from(dialog()!.querySelectorAll('.diff-line.is-add .diff-text')).map((l) => l.textContent);
    expect(added).toEqual(['three']);
  });

  it('compares with this device’s unsaved text, after sending it first', async () => {
    seed();
    edit(id, { content: 'one\ntwo\nthree\nfour' });
    await openHistory();
    // Opening history saves what's typed, so the snapshots include it.
    expect(patches()).toEqual([expect.objectContaining({ content: 'one\ntwo\nthree\nfour' })]);
    const versionsAt = server.log.findIndex((r) => r.path.endsWith('/versions'));
    const patchAt = server.log.findIndex((r) => r.method === 'PATCH');
    expect(patchAt).toBeLessThan(versionsAt);
    const added = Array.from(dialog()!.querySelectorAll('.diff-line.is-add .diff-text')).map((l) => l.textContent);
    expect(added).toContain('four');
  });

  it('shows another snapshot when it’s picked, with its title change', async () => {
    seed();
    await openHistory();
    await click(items()[1]);
    await settle();
    expect(items()[1].className).toContain('is-active');
    const title = dialog()!.querySelector('.diff-title');
    expect(title?.querySelector('.is-del')?.textContent).toContain('Old plan');
    expect(title?.querySelector('.is-add')?.textContent).toContain('Plan');
  });

  it('shows, and restores, the snapshot picked last, even when an earlier pick’s answer arrives after it', async () => {
    seed();
    await openHistory();
    const [newest, older] = server.versions.filter((v) => v.note_id === id).sort((a, b) => b.created_at - a.created_at);
    // The older snapshot's answer is slow: picked, then the newest picked again before it arrives.
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    server.intercept = async (req) => {
      if (req.path === `/api/versions/${older.id}`) await held;
      return undefined;
    };
    await click(items()[1]);
    await click(items()[0]);
    await settle();
    release();
    await settle();
    expect(items()[0].className).toContain('is-active');
    await click(restoreButton());
    await click(byName('Restore version'));
    await settle();
    expect(patches()).toEqual([expect.objectContaining({ content: newest.content })]);
  });

  it('clears the reason one snapshot couldn’t be shown once another is picked', async () => {
    seed();
    await openHistory();
    const older = server.versions.filter((v) => v.note_id === id).sort((a, b) => a.created_at - b.created_at)[0];
    server.intercept = (req) =>
      req.path === `/api/versions/${older.id}`
        ? new Response(JSON.stringify({ error: 'boom', message: 'That snapshot is unavailable.' }), { status: 503, headers: { 'content-type': 'application/json' } })
        : undefined;
    await click(items()[1]);
    await settle();
    expect(dialog()!.querySelector('.error-text')?.textContent).toBe('That snapshot is unavailable.');
    await click(items()[0]);
    await settle();
    expect(dialog()!.querySelector('.error-text')).toBeNull();
    expect(restoreButton().disabled).toBe(false);
  });

  it('shows the snapshot as it reads, read-only, under Preview', async () => {
    seed();
    server.addVersion(id, { title: 'Tasks', content: '# Heading\n\n- [ ] a task', created_at: Date.now() - 60_000 });
    await openHistory();
    await click(byName('Preview', '[role="radio"]'));
    expect(dialog()!.querySelector('.history-title')?.textContent).toBe('Tasks');
    const box = dialog()!.querySelector<HTMLInputElement>('input.kb-task-box');
    expect(box).not.toBeNull();
    await click(box);
    expect(box!.checked).toBe(false);
    expect(patches()).toEqual([]);
  });

  it('says there are no snapshots yet, with Restore unavailable', async () => {
    seed({ versions: false });
    await openHistory();
    expect(text(dialog()!)).toContain('No earlier versions yet.');
    expect(restoreButton().disabled).toBe(true);
  });

  it('says why when the snapshots can’t be loaded', async () => {
    seed();
    server.intercept = (req) =>
      req.path.endsWith('/versions') ? new Response(JSON.stringify({ error: 'boom', message: 'The database is busy.' }), { status: 503, headers: { 'content-type': 'application/json' } }) : undefined;
    await openHistory();
    expect(dialog()!.querySelector('.error-text')?.textContent).toBe('The database is busy.');
    expect(restoreButton().disabled).toBe(true);
  });

  it('closes with Close or Escape', async () => {
    seed();
    await openHistory();
    await click(byName('Close', 'button.btn-ghost'));
    expect(useApp.getState().historyFor).toBeNull();
    useApp.setState({ historyFor: id });
    await settle();
    await press('Escape', {}, document.body);
    expect(useApp.getState().historyFor).toBeNull();
  });
});

describe('restoring a snapshot', () => {
  it('asks first, and changes nothing on Cancel', async () => {
    seed();
    await openHistory();
    await click(restoreButton());
    const ask = dialog()!;
    expect(ask.getAttribute('aria-label')).toBe('Restore this version?');
    expect(text(ask)).toContain('The current text is kept in history');
    await click(byName('Cancel', 'button', ask));
    await settle();
    expect(patches()).toEqual([]);
    expect(useApp.getState().historyFor).toBe(id);
    expect(server.notes.get(id)!.content).toBe('one\ntwo\nthree');
  });

  it('puts the snapshot back once confirmed, keeping the replaced text in history, and reloads the note', async () => {
    seed();
    await openHistory();
    await click(items()[1]);
    await settle();
    await click(restoreButton());
    await click(byName('Restore version'));
    await settle();
    expect(patches()).toEqual([expect.objectContaining({ title: 'Old plan', content: 'one', force: true, snapshot: true })]);
    expect(server.notes.get(id)).toMatchObject({ title: 'Old plan', content: 'one' });
    expect(server.versions.some((v) => v.note_id === id && v.content === 'one\ntwo\nthree')).toBe(true);
    expect(noteCache.get(id)).toMatchObject({ title: 'Old plan', content: 'one', version: 4 });
    expect(useApp.getState().notes[id]).toMatchObject({ title: 'Old plan', version: 4 });
    expect(useApp.getState().reloadToken).toBe(1);
    expect(useApp.getState().historyFor).toBeNull();
    expect(useApp.getState().toasts.map((t) => t.message)).toEqual(['Version restored']);
    expect(statusOf(id)).toBe('saved');
  });

  it('keeps the note’s title when the snapshot’s couldn’t be decrypted', async () => {
    seed();
    const v = server.addVersion(id, { title: '', content: 'recovered', created_at: Date.now() - 1000 });
    server.intercept = (req) =>
      req.path === `/api/versions/${v.id}`
        ? new Response(JSON.stringify({ ...v, titleUnreadable: true }), { headers: { 'content-type': 'application/json' } })
        : undefined;
    await openHistory();
    await click(restoreButton());
    await click(byName('Restore version'));
    await settle();
    expect(patches()).toHaveLength(1);
    expect(patches()[0]).not.toHaveProperty('title');
    expect(server.notes.get(id)).toMatchObject({ title: 'Plan', content: 'recovered' });
  });

  it('says why, and stays open, when the restore doesn’t save', async () => {
    seed();
    await openHistory();
    server.offline = true;
    await click(restoreButton());
    await click(byName('Restore version'));
    await settle();
    expect(useApp.getState().historyFor).toBe(id);
    expect(useApp.getState().toasts).toEqual([expect.objectContaining({ kind: 'error', message: expect.stringContaining('reach the server') })]);
    expect(useApp.getState().reloadToken).toBe(0);
  });
});
