// @vitest-environment jsdom
/**
 * Above a journal entry (src/components/JournalNav.tsx), as the README describes it: the entries before
 * and after it, and a calendar with every day that has one marked; picking any day opens or starts it.
 * Entries are notes titled with their date and tagged #journal (or kept in the journal's folder).
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  allByRole,
  boot,
  byRole,
  click,
  NOW,
  press,
  queryByRole,
  render,
  seedFolder,
  seedNote,
  server,
  settle,
  teardown,
  textOf,
  type Booted,
} from './ui-shell-helpers';

let h: Booted;
let JournalNav: typeof import('../../src/components/JournalNav').JournalNav;

beforeEach(async () => {
  // Today is Tuesday 2026-11-17.
  vi.useFakeTimers({ toFake: ['Date'], now: NOW });
  h = await boot();
  ({ JournalNav } = await import('../../src/components/JournalNav'));
});
afterEach(teardown);

const state = () => h.store.useApp.getState();
const day = (iso: string) => {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d);
};
/** Dates as the bar writes them, in this computer's language. */
const long = (iso: string) => day(iso).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
const short = (iso: string) => day(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
const bar = () => document.querySelector('.journal-nav');
const calendar = () => queryByRole('dialog', 'Journal calendar');

async function journal() {
  await seedFolder('j', 'Journal');
  await seedNote('e10', { title: '2026-11-10', tags: ['journal'], folder_id: 'j' });
  await seedNote('e12', { title: '2026-11-12', tags: ['journal'], folder_id: 'j' });
  await seedNote('e15', { title: '2026-11-15', tags: ['journal'], folder_id: 'j' });
  h.store.useApp.setState({ lastSync: Date.now() });
}
async function showFor(id: string) {
  const note = state().notes[id];
  return render(<JournalNav note={note} />);
}

describe('the bar above an entry', () => {
  it('isn’t there for a note that isn’t a journal entry', async () => {
    await journal();
    await seedNote('plain', { title: 'Shopping', tags: ['journal'] });
    await seedNote('dated', { title: '2026-11-11' });
    await showFor('plain');
    await showFor('dated');
    expect(bar()).toBeNull();
  });

  it('counts a dated note in the journal’s folder as an entry, tag or not', async () => {
    await journal();
    await seedNote('e13', { title: '2026-11-13', folder_id: 'j' });
    await showFor('e12');
    expect(byRole('button', `Next entry, ${long('2026-11-13')}`)).toBeTruthy();
  });

  it('shows the entry’s date and steps to the entries before and after it', async () => {
    await journal();
    await showFor('e12');
    expect(textOf(byRole('button', long('2026-11-12')))).toBe(long('2026-11-12'));
    const prev = byRole('button', `Previous entry, ${long('2026-11-10')}`);
    const next = byRole('button', `Next entry, ${long('2026-11-15')}`);
    expect(textOf(prev)).toBe(short('2026-11-10'));
    expect(textOf(next)).toBe(short('2026-11-15'));
    await click(prev);
    await settle();
    expect(state().noteId).toBe('e10');
    await click(next);
    await settle();
    expect(state().noteId).toBe('e15');
    expect(server.requests('POST', '/api/notes')).toHaveLength(0);
  });

  it('has nothing earlier before the first entry', async () => {
    await journal();
    await showFor('e10');
    const prev = byRole('button', 'No earlier entry');
    expect(prev.hasAttribute('disabled')).toBe(true);
  });

  it('goes on to today, starting its entry beside the others, past the last entry', async () => {
    await journal();
    await showFor('e15');
    const forward = byRole('button', `Today, ${long('2026-11-17')}`);
    expect(textOf(forward)).toBe('Today');
    await click(forward);
    await settle(40);
    const made = state().notes[state().noteId!];
    expect(made).toMatchObject({ title: '2026-11-17', tags: ['journal'], folder_id: 'j' });
  });

  it('has nothing later on today’s entry', async () => {
    await journal();
    await seedNote('e17', { title: '2026-11-17', tags: ['journal'], folder_id: 'j' });
    await showFor('e17');
    expect(byRole('button', 'No later entry').hasAttribute('disabled')).toBe(true);
  });

  it('follows entries added or trashed elsewhere', async () => {
    await journal();
    await showFor('e12');
    await seedNote('e14', { title: '2026-11-14', tags: ['journal'], folder_id: 'j' });
    expect(byRole('button', `Next entry, ${long('2026-11-14')}`)).toBeTruthy();
    await seedNote('e10', { title: '2026-11-10', tags: ['journal'], folder_id: 'j', deleted_at: NOW });
    expect(byRole('button', 'No earlier entry')).toBeTruthy();
  });
});

describe('the calendar', () => {
  const dayButtons = () => allByRole('button', undefined, calendar()!).filter((b) => b.classList.contains('journal-cal-day'));

  async function open(id = 'e12') {
    await journal();
    await showFor(id);
    const date = bar()!.querySelector<HTMLButtonElement>('.journal-date')!;
    expect(date.getAttribute('aria-expanded')).toBe('false');
    await click(date);
    expect(date.getAttribute('aria-expanded')).toBe('true');
    return date;
  }

  it('shows the entry’s month, Monday first, with the days that have an entry marked', async () => {
    await open();
    const cal = calendar()!;
    expect(textOf(cal.querySelector('.journal-cal-month'))).toBe(
      `${day('2026-11-01').toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}3 entries`,
    );
    expect(dayButtons()).toHaveLength(30);
    // 1 November 2026 is a Sunday: six empty days before it.
    const grid = cal.querySelector('.journal-cal-grid')!;
    const cells = Array.from(grid.children).filter((c) => !c.classList.contains('journal-cal-weekday'));
    expect(cells.slice(0, 7).map((c) => c.tagName)).toEqual(['SPAN', 'SPAN', 'SPAN', 'SPAN', 'SPAN', 'SPAN', 'BUTTON']);
    const marked = dayButtons().filter((b) => b.classList.contains('has-entry')).map(textOf);
    expect(marked).toEqual(['10', '12', '15']);
    expect(byRole('button', `${long('2026-11-12')}, has an entry`, cal).getAttribute('aria-current')).toBe('date');
    expect(byRole('button', long('2026-11-17'), cal).classList.contains('is-today')).toBe(true);
  });

  it('opens the entry of a marked day, closing itself', async () => {
    await open();
    await click(byRole('button', `${long('2026-11-15')}, has an entry`));
    await settle();
    expect(calendar()).toBeNull();
    expect(state().noteId).toBe('e15');
  });

  it('starts an entry for a day without one', async () => {
    await open();
    await click(byRole('button', long('2026-11-03')));
    await settle(40);
    expect(state().notes[state().noteId!]).toMatchObject({ title: '2026-11-03', tags: ['journal'], folder_id: 'j' });
  });

  it('moves between months, counting their entries', async () => {
    await open();
    await click(byRole('button', 'Previous month'));
    expect(textOf(calendar()!.querySelector('.journal-cal-count'))).toBe('No entries');
    expect(dayButtons()).toHaveLength(31);
    await click(byRole('button', 'Next month'));
    await click(byRole('button', 'Next month'));
    expect(textOf(calendar()!.querySelector('.journal-cal-month'))).toContain(day('2026-12-01').toLocaleDateString(undefined, { month: 'long', year: 'numeric' }));
  });

  it('opens today’s entry from Today', async () => {
    await open();
    await click(byRole('button', 'Today', calendar()!));
    await settle(40);
    expect(state().notes[state().noteId!].title).toBe('2026-11-17');
  });

  it('closes on Escape without the Escape reaching anything else', async () => {
    await open();
    const elsewhere = vi.fn();
    window.addEventListener('keydown', elsewhere);
    await press('Escape', {}, document.body);
    window.removeEventListener('keydown', elsewhere);
    expect(calendar()).toBeNull();
    expect(elsewhere).not.toHaveBeenCalled();
    expect(bar()!.querySelector('.journal-date')!.getAttribute('aria-expanded')).toBe('false');
  });

  it('closes on a click outside it, and from its own button', async () => {
    const date = await open();
    await click(document.body);
    expect(calendar()).toBeNull();
    await click(date);
    expect(calendar()).not.toBeNull();
    await click(date);
    expect(calendar()).toBeNull();
  });

  it('moves focus into the calendar when it opens', async () => {
    await open();
    expect(calendar()!.contains(document.activeElement)).toBe(true);
  });

  it('labels every day with its full date', async () => {
    await open();
    for (const b of dayButtons()) expect(b.getAttribute('aria-label')).toMatch(/\d{4}/);
    expect(calendar()!.querySelectorAll('.journal-cal-weekday[aria-hidden="true"]')).toHaveLength(7);
  });
});
