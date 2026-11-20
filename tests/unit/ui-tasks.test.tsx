// @vitest-environment jsdom
/**
 * The Tasks view (src/components/TasksView.tsx), as the README describes it: every open task from every
 * note (read from the device's decrypted copy of the encrypted library), overdue, today and upcoming by
 * due date, then the rest by note; Open or All; ticking a task off right there (it stays, struck
 * through, until the view is left) and clicking one to open its note at that line.
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  allByRole,
  boot,
  byRole,
  click,
  DAY,
  NOW,
  queryByRole,
  queryByText,
  render,
  seedFolder,
  seedNote,
  server,
  setApp,
  setSettings,
  settle,
  teardown,
  textOf,
  toasts,
  until,
  type Booted,
} from './ui-shell-helpers';

let h: Booted;
let TasksView: typeof import('../../src/components/TasksView').TasksView;

async function start(opts: { phone?: boolean } = {}) {
  h = await boot(opts);
  ({ TasksView } = await import('../../src/components/TasksView'));
}

beforeEach(async () => {
  // Today is 2026-11-17.
  vi.useFakeTimers({ toFake: ['Date'], now: NOW });
  await start();
});
afterEach(teardown);

const view = () => byRole('region', 'Tasks');
const summary = () => textOf(view().querySelector('.home-summary'));
/** Each section's heading and its tasks' text. */
const sections = () =>
  Array.from(view().querySelectorAll('section.home-section')).map((s) => [
    s.getAttribute('aria-label'),
    Array.from(s.querySelectorAll('.task-text')).map(textOf),
  ]);
const box = (text: string) => byRole('checkbox', new RegExp(`: ${text}$`)) as HTMLInputElement;
const state = () => h.store.useApp.getState();

/** Shows the view and waits until it has read the notes. */
async function show() {
  const r = await render(<TasksView />);
  await settle(40);
  await until(() => {
    if (view().querySelector('.tasks-loading')) throw new Error('still reading');
  });
  return r;
}

async function library() {
  await seedNote('work', {
    title: 'Work',
    updated_at: NOW - 1000,
    content: ['# Work', '- [ ] send invoice due:2026-11-10', '- [ ] call Sam 📅 2026-11-17', '- [x] done already due:2026-11-01', '- [ ] plan Q1 due:2026-12-01', '- [ ] tidy desk'].join('\n'),
    info: { t: [1, 5] },
  });
  await seedNote('home', {
    title: 'Home',
    updated_at: NOW - 2000,
    content: '- [ ] water plants\n  - [ ] the fern too\n- [ ]\n```\n- [ ] not a task\n```',
    info: { t: [0, 3] },
  });
}

describe('what it lists', () => {
  it('reads the notes first, then groups overdue, today and upcoming, then the rest by note', async () => {
    await library();
    await show();
    expect(sections()).toEqual([
      ['Overdue', ['send invoice']],
      ['Today', ['call Sam']],
      ['Upcoming', ['plan Q1']],
      ['Work', ['tidy desk']],
      ['Home', ['water plants', 'the fern too']],
    ]);
    expect(summary()).toBe('6 open tasks, 1 overdue.');
    // The texts came from the server encrypted, and were read on this device.
    expect(server.requests('POST', '/api/notes/batch')).toHaveLength(1);
  });

  it('shows a spinner while the library is loading', async () => {
    await setApp({ status: 'loading' });
    await render(<TasksView />);
    expect(byRole('progressbar', 'Reading your notes')).toBeTruthy();
    expect(view().querySelector('.home-summary')).toBeNull();
  });

  it('shows each dated task’s due day and its note, which opens at the task’s line', async () => {
    await library();
    await show();
    const overdue = view().querySelector('section[aria-label="Overdue"]')!;
    expect(overdue.querySelector('.task-due')!.classList.contains('is-overdue')).toBe(true);
    expect(textOf(view().querySelector('section[aria-label="Today"] .task-due'))).toBe('Today');
    expect(view().querySelector('section[aria-label="Today"] .task-due')!.classList.contains('is-today')).toBe(true);
    await click(byRole('button', 'Work', overdue));
    expect(state().noteId).toBe('work');
    expect(location.pathname + location.hash).toBe('/note/work#L1');
    expect(state().anchor).toBe('L1');
  });

  it('opens a note at a task’s line from the task itself', async () => {
    await library();
    await show();
    // Lines count from 0 here and in the note view (NoteView's jumpToLine).
    await click(byRole('button', 'the fern too'));
    expect(location.pathname + location.hash).toBe('/note/home#L1');
    // The note's heading opens it at the top.
    h.store.openTasks();
    await click(byRole('button', 'Home'));
    expect(location.pathname + location.hash).toBe('/note/home');
    expect(state().anchor).toBeNull();
  });

  it('indents nested tasks', async () => {
    await library();
    await show();
    const nested = box('the fern too').closest('li') as HTMLElement;
    const top = box('water plants').closest('li') as HTMLElement;
    expect(parseInt(nested.style.paddingLeft)).toBeGreaterThan(parseInt(top.style.paddingLeft));
  });

  it('names a task’s folder by its note', async () => {
    await seedFolder('p', 'Projects');
    await seedNote('a', { title: 'Plan', folder_id: 'p', content: '- [ ] step one' });
    await show();
    expect(textOf(view().querySelector('.tasks-folder'))).toBe('Projects');
  });

  it('leaves out templates, notes in the trash and tasks in code', async () => {
    await seedFolder('tpl', 'Templates');
    await seedNote('t', { title: 'Meeting', folder_id: 'tpl', content: '- [ ] agenda item' });
    await seedNote('x', { title: 'Gone', deleted_at: NOW, content: '- [ ] lost task' });
    await seedNote('c', { title: 'Code', content: '```\n- [ ] in code\n```' });
    await show();
    expect(summary()).toBe('No open tasks.');
    expect(queryByText(/agenda item|lost task|in code/)).toBeNull();
    expect(textOf(view().querySelector('.tasks-empty'))).toMatch(/^Nothing left to do\./);
  });

  it('puts pinned notes’ tasks first among the undated ones', async () => {
    await seedNote('a', { title: 'Recent', updated_at: NOW, content: '- [ ] recent task' });
    await seedNote('b', { title: 'Pinned', pinned: true, updated_at: NOW - 10 * DAY, content: '- [ ] pinned task' });
    await show();
    expect(sections().map((s) => s[0])).toEqual(['Pinned', 'Recent']);
  });

  it('suggests a due date until a task has one', async () => {
    await seedNote('a', { title: 'Plan', content: '- [ ] step one' });
    await show();
    expect(summary()).toBe('1 open task. Give a task a due date by adding “due:2026-11-20” after it, or type /due.');
  });

  it('lists done tasks too under All, and says when there are no tasks at all', async () => {
    await library();
    await show();
    const show_ = byRole('radiogroup', 'Show');
    await click(byRole('radio', 'All', show_));
    expect(byRole('radio', 'All', show_).getAttribute('aria-checked')).toBe('true');
    expect(box('done already').checked).toBe(true);
    // Done tasks go with their note, not under a due date.
    expect(sections().find((s) => s[0] === 'Work')![1]).toEqual(['done already', 'tidy desk']);
    await teardown();
    vi.useFakeTimers({ toFake: ['Date'], now: NOW });
    await start();
    await show();
    await click(byRole('radio', 'All'));
    expect(textOf(view().querySelector('.tasks-empty'))).toMatch(/^No tasks yet\./);
  });

  it('says how many notes with tasks couldn’t be read (offline), and lists the rest', async () => {
    await seedNote('a', { title: 'Readable', content: '- [ ] fine' });
    await seedNote('b', { title: 'Unread', content: '- [ ] far away', info: { t: [0, 1] } });
    await seedNote('c', { title: 'Also unread', content: '- [ ] far too', info: { t: [0, 2] } });
    // Only the first was read before the connection went.
    server.intercept = async (req) => {
      if (req.path !== '/api/notes/batch') return undefined;
      const ids = req.body!.ids as string[];
      if (ids.includes('b')) {
        return new Response(JSON.stringify({ notes: [server.rows.get('a')] }), { headers: { 'content-type': 'application/json' } });
      }
      return undefined;
    };
    await show();
    expect(sections()).toEqual([['Readable', ['fine']]]);
    expect(textOf(view().querySelector('.tasks-unread'))).toBe('2 notes with tasks couldn’t be read right now. They appear once Lumen can reach them.');
  });

  it('copes with a great many tasks', async () => {
    const lines = Array.from({ length: 400 }, (_, i) => `- [${i % 4 ? ' ' : 'x'}] task ${i}${i % 5 === 0 ? ' due:2026-11-2' + (i % 9) : ''}`);
    await seedNote('big', { title: 'Big', content: lines.join('\n') });
    await show();
    expect(summary()).toMatch(/^300 open tasks/);
    expect(view().querySelectorAll('li.task-row')).toHaveLength(300);
  });
});

describe('ticking tasks off', () => {
  it('ticks a task off and keeps it there, struck through, until the view is left', async () => {
    await library();
    const first = await show();
    await click(box('tidy desk'));
    await settle();
    expect(box('tidy desk').checked).toBe(true);
    expect(box('tidy desk').closest('li')!.classList.contains('is-done')).toBe(true);
    expect(summary()).toBe('5 open tasks, 1 overdue.');
    expect(box('tidy desk').getAttribute('aria-label')).toBe('Mark not done: tidy desk');
    // The note's text changed, to be saved like any edit.
    const { knownText } = await import('../../src/lib/liveEdit');
    expect(knownText('work')!.content).toContain('- [x] tidy desk');
    expect(h.saver.statusOf('work')).toBe('pending');
    // Left and come back: it's gone from the open tasks.
    await first.unmount();
    await show();
    expect(queryByRole('checkbox', /tidy desk/)).toBeNull();
  });

  it('saves the tick to the server, encrypted, after the usual pause', async () => {
    await library();
    await show();
    await click(box('call Sam'));
    await h.saver.flush('work');
    await settle();
    const patch = server.requests('PATCH', '/api/notes/work').at(-1)!;
    expect(patch.body!.enc).toBe(true);
    expect(JSON.stringify(patch.body)).not.toContain('call Sam');
  });

  it('unticks a task ticked by mistake', async () => {
    await library();
    await show();
    await click(box('send invoice'));
    await settle();
    await click(box('send invoice'));
    await settle();
    expect(box('send invoice').checked).toBe(false);
    const { knownText } = await import('../../src/lib/liveEdit');
    expect(knownText('work')!.content).toContain('- [ ] send invoice due:2026-11-10');
    expect(summary()).toBe('6 open tasks, 1 overdue.');
  });

  it('keeps a ticked dated task in its section rather than moving it', async () => {
    await library();
    await show();
    await click(box('plan Q1'));
    await settle();
    expect(sections().find((s) => s[0] === 'Upcoming')![1]).toEqual(['plan Q1']);
  });

  it('says so, with a way to the note, when the task changed since the list was made', async () => {
    await library();
    await show();
    // The line is rewritten elsewhere (another device, or the note open in another tab).
    const { knownText } = await import('../../src/lib/liveEdit');
    h.saver.edit('work', { content: knownText('work')!.content.replace('- [ ] tidy desk', '- [ ] tidy the whole office') }, 1);
    await click(box('tidy desk'));
    await settle();
    expect(toasts(h.store).at(-1)).toBe('That task has changed since this list was made. Open the note to see it.');
    expect(queryByRole('checkbox', /tidy desk$/)).toBeNull();
    expect(box('tidy the whole office').checked).toBe(false);
    state().toasts.at(-1)!.action!.run();
    expect(state().noteId).toBe('work');
  });
});

describe('repeating tasks', () => {
  it('ticked, come back due on their next date, the ticked one dated and kept in view', async () => {
    await seedNote('chores', { title: 'Chores', updated_at: NOW - 1000, content: '- [ ] water plants 🔁 every week 📅 2026-11-17', info: { t: [0, 1] } });
    await show();
    expect(textOf(box('water plants').closest('li')!.querySelector('.task-repeat'))).toBe('Every week');
    await click(box('water plants'));
    await settle();
    const { knownText } = await import('../../src/lib/liveEdit');
    expect(knownText('chores')!.content).toBe('- [ ] water plants 🔁 every week 📅 2026-11-24\n- [x] water plants 🔁 every week 📅 2026-11-17 ✅ 2026-11-17');
    // The ticked one stays in Today, struck through; the next one is Upcoming.
    expect(sections()).toEqual([
      ['Today', ['water plants']],
      ['Upcoming', ['water plants']],
    ]);
    expect(textOf(view().querySelector('li.is-done .task-done-on'))).toBe('Done today');
    expect(summary()).toBe('1 open task.');
  });

  it('are dated only when they have a date or repeat, unless set otherwise', async () => {
    await seedNote('list', { title: 'List', updated_at: NOW - 1000, content: '- [ ] milk\n- [ ] eggs', info: { t: [0, 2] } });
    await show();
    await click(box('milk'));
    await setSettings({ taskDoneDates: 'all' });
    await click(box('eggs'));
    await settle();
    const { knownText } = await import('../../src/lib/liveEdit');
    expect(knownText('list')!.content).toBe('- [x] milk\n- [x] eggs ✅ 2026-11-17');
  });
});

describe('around the view', () => {
  it('has a Back button on phones, going Home', async () => {
    await teardown();
    vi.useFakeTimers({ toFake: ['Date'], now: NOW });
    await start({ phone: true });
    await show();
    await click(byRole('button', 'Back'));
    expect(state().screen).toBe('home');
    expect(queryByRole('button', 'Show sidebar')).toBeNull();
  });

  it('offers to show the sidebar on a wide screen when it’s hidden', async () => {
    await show();
    expect(queryByRole('button', 'Back')).toBeNull();
    await setSettings({ sidebarCollapsed: true });
    await click(byRole('button', 'Show sidebar'));
    expect(h.settings.useSettings.getState().sidebarCollapsed).toBe(false);
  });

  it('labels every tick box with what ticking it does and the task, and each section', async () => {
    await library();
    await show();
    const boxes = allByRole('checkbox', undefined, view());
    expect(boxes).toHaveLength(6);
    for (const b of boxes) expect(b.getAttribute('aria-label')).toMatch(/^Mark done: .+/);
    expect(allByRole('heading', undefined, view())[0].textContent).toBe('Tasks');
    for (const s of view().querySelectorAll('section.home-section')) expect(s.getAttribute('aria-label')).toBeTruthy();
  });
});
