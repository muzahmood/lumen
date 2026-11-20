import { useEffect, useMemo, useRef, useState } from 'react';
import { CalendarDays, ChevronLeft, ChevronRight } from 'lucide-react';
import { isJournalEntry, journalEntries, journalFolderId, openJournal } from '../lib/journal';
import { useBackLayer } from '../lib/backLayers';
import { useApp } from '../lib/store';
import { isoDate, parseIsoDate } from '../lib/templateText';
import type { NoteMeta } from '../lib/types';

const short = (iso: string) => parseIsoDate(iso)?.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) ?? iso;
const long = (iso: string) =>
  parseIsoDate(iso)?.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }) ?? iso;

/** A month of days, Monday first, with the days that have an entry marked. Picking one opens (or starts) it. */
function JournalCalendar({ current, days, onClose }: { current: string; days: Set<string>; onClose: () => void }) {
  const start = parseIsoDate(current) ?? new Date();
  const [month, setMonth] = useState(() => new Date(start.getFullYear(), start.getMonth(), 1));
  const ref = useRef<HTMLDivElement>(null);
  const today = isoDate(new Date());
  // Back (a phone's back gesture) closes it.
  useBackLayer(true, onClose);

  // A dialog: focus goes to the day shown when it opens, and back to the date button when it closes
  // (unless something else took it, the entry it opened, say).
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    ref.current?.querySelector<HTMLElement>('.journal-cal-day.is-current, .journal-cal-day.is-today, .journal-cal-day')?.focus({ preventScroll: true });
    return () => {
      const active = document.activeElement;
      if (opener?.isConnected && (!active || active === document.body)) opener.focus({ preventScroll: true });
    };
  }, []);

  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node) && !(e.target as Element).closest?.('.journal-date')) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [onClose]);

  const cells: Array<string | null> = [];
  const lead = (month.getDay() + 6) % 7;
  for (let i = 0; i < lead; i++) cells.push(null);
  const count = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
  for (let d = 1; d <= count; d++) cells.push(isoDate(new Date(month.getFullYear(), month.getMonth(), d)));
  const weekdays = Array.from({ length: 7 }, (_, i) => new Date(2024, 0, 1 + i).toLocaleDateString(undefined, { weekday: 'narrow' }));
  const shift = (n: number) => setMonth(new Date(month.getFullYear(), month.getMonth() + n, 1));
  const entriesThisMonth = cells.filter((c) => c && days.has(c)).length;

  return (
    <div className="journal-cal" ref={ref} role="dialog" aria-label="Journal calendar">
      <div className="journal-cal-head">
        <button type="button" className="icon-btn icon-btn-sm" aria-label="Previous month" onClick={() => shift(-1)}>
          <ChevronLeft size={15} />
        </button>
        <span className="journal-cal-month">
          {month.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}
          <span className="journal-cal-count">{entriesThisMonth ? `${entriesThisMonth} ${entriesThisMonth === 1 ? 'entry' : 'entries'}` : 'No entries'}</span>
        </span>
        <button type="button" className="icon-btn icon-btn-sm" aria-label="Next month" onClick={() => shift(1)}>
          <ChevronRight size={15} />
        </button>
      </div>
      <div className="journal-cal-grid">
        {weekdays.map((w, i) => (
          <span key={`w${i}`} className="journal-cal-weekday" aria-hidden="true">
            {w}
          </span>
        ))}
        {cells.map((iso, i) =>
          iso ? (
            <button
              key={iso}
              type="button"
              className={`journal-cal-day${days.has(iso) ? ' has-entry' : ''}${iso === today ? ' is-today' : ''}${iso === current ? ' is-current' : ''}`}
              aria-label={`${long(iso)}${days.has(iso) ? ', has an entry' : ''}`}
              aria-current={iso === current ? 'date' : undefined}
              onClick={() => {
                onClose();
                void openJournal(iso);
              }}
            >
              {Number(iso.slice(8))}
            </button>
          ) : (
            <span key={`e${i}`} />
          ),
        )}
      </div>
      <button
        type="button"
        className="link-btn journal-cal-today"
        onClick={() => {
          onClose();
          void openJournal(today);
        }}
      >
        Today
      </button>
    </div>
  );
}

/** Above a journal entry: the entries before and after it, and a calendar of every day with one. */
export function JournalNav({ note }: { note: NoteMeta }) {
  const notes = useApp((s) => s.notes);
  const folders = useApp((s) => s.folders);
  // Drawn again when the date moves on: "Today" is then the next day.
  useApp((s) => s.day);
  const [calendar, setCalendar] = useState(false);
  // Recomputed when notes or folders change (the functions read them from the store).
  const { entry, dates } = useMemo(() => {
    const folderId = journalFolderId();
    return { entry: isJournalEntry(note, folderId), dates: [...journalEntries().keys()].sort() };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [note, notes, folders]);
  if (!entry) return null;

  const date = note.title.trim();
  const today = isoDate(new Date());
  const i = dates.indexOf(date);
  const prev = i > 0 ? dates[i - 1] : undefined;
  const next = i >= 0 && i < dates.length - 1 ? dates[i + 1] : undefined;
  // Past the last entry, "next" goes to today (and starts it).
  const forward = next ?? (date < today ? today : undefined);

  return (
    <div className="journal-nav">
      <button type="button" className="journal-step" disabled={!prev} onClick={() => prev && void openJournal(prev)} aria-label={prev ? `Previous entry, ${long(prev)}` : 'No earlier entry'}>
        <ChevronLeft size={15} aria-hidden="true" />
        {prev && <span>{short(prev)}</span>}
      </button>
      <button type="button" className="journal-date" aria-expanded={calendar} onClick={() => setCalendar((v) => !v)}>
        <CalendarDays size={14} aria-hidden="true" />
        <span>{long(date)}</span>
      </button>
      <button
        type="button"
        className="journal-step"
        disabled={!forward}
        onClick={() => forward && void openJournal(forward)}
        aria-label={forward ? `${next ? 'Next entry' : 'Today'}, ${long(forward)}` : 'No later entry'}
      >
        {forward && <span>{next ? short(next) : 'Today'}</span>}
        <ChevronRight size={15} aria-hidden="true" />
      </button>
      {calendar && <JournalCalendar current={date} days={new Set(dates)} onClose={() => setCalendar(false)} />}
    </div>
  );
}
