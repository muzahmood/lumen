/**
 * Filling in a template's placeholders, with no app state (see journal.ts for templates themselves).
 *
 *   {{date}} 2026-11-17   {{time}} 14:05   {{datetime}} 2026-11-17 14:05
 *   {{weekday}} Tuesday   {{longdate}} Tuesday, November 17, 2026
 *   {{year}} 2026   {{month}} 11   {{day}} 17   {{title}} the new note's title
 *
 * Any other {{…}} is left as it is.
 */

const pad = (n: number) => String(n).padStart(2, '0');

export function isoDate(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** A YYYY-MM-DD date as a local date (at the given time of day), or null if it isn't one. */
export function parseIsoDate(text: string, at: Date = new Date(0, 0, 1, 12)): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text.trim());
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), at.getHours(), at.getMinutes());
  return isoDate(d) === text.trim() ? d : null;
}

export function fillTemplate(text: string, vars: { date: Date; title?: string }): string {
  const d = vars.date;
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const values: Record<string, string> = {
    date: isoDate(d),
    time,
    datetime: `${isoDate(d)} ${time}`,
    weekday: d.toLocaleDateString(undefined, { weekday: 'long' }),
    longdate: d.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }),
    year: String(d.getFullYear()),
    month: pad(d.getMonth() + 1),
    day: pad(d.getDate()),
    title: vars.title ?? '',
  };
  // Own keys only: {{constructor}} and the like are left as typed.
  return text.replace(/\{\{\s*([A-Za-z]+)\s*\}\}/g, (m, name: string) => (Object.hasOwn(values, name.toLowerCase()) ? values[name.toLowerCase()] : m));
}

/** A new journal entry's text when there's no journal template of one's own. */
export const DEFAULT_JOURNAL = '*{{longdate}}*\n\n## Focus\n\n- [ ] \n\n## Notes\n\n';
