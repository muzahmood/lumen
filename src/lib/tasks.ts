/**
 * Tasks in a note's Markdown, for the Tasks view: list items starting with [ ] or [x] (bulleted or
 * numbered, in a quote or not), as reading view shows them as tick boxes. Tasks inside code blocks
 * aren't tasks, nor is an empty box with nothing after it.
 *
 * After the task, as Obsidian's Tasks plugin writes them (or in words):
 *   📅 2026-11-20   due:2026-11-20     when it's due
 *   ✅ 2026-11-20   done:2026-11-20    when it was ticked (added on ticking; see tickTaskLine)
 *   🔁 every week   repeat:every week  it comes back: ticked, the next one is added above it
 */
import { linesOutsideCode } from '../../shared/noteText';

export interface Task {
  /** 0-based line in the note. */
  line: number;
  /** The line exactly as written, to find the task again if lines moved. */
  raw: string;
  /** What the task says, without its Markdown markers or dates. */
  text: string;
  done: boolean;
  /** YYYY-MM-DD, or null. */
  due: string | null;
  /** When it was ticked (YYYY-MM-DD), or null. */
  doneOn: string | null;
  /** How it repeats ("every week"), when that's understood (see repeatRule); null if it doesn't. */
  repeat: string | null;
  /** How deeply the task is nested under other list items (0 at the top). */
  depth: number;
}

/** A task's completion date ("✅ 2026-11-20" or "done:2026-11-20"); the date is group 1. */
export const DONE_ON = /(?:✅️?|\bdone:)[ \t]*(\d{4}-\d{2}-\d{2})\b/u;
/** How a task repeats ("🔁 every week", "repeat:every 2 days"): the words, up to the next date or the end. */
const REPEAT = /(?:🔁️?|\brepeat:)[ \t]*(every\b.*?)[ \t]*(?=📅|✅|🔁|\bdue:|\bdone:|\brepeat:|$)/iu;

const DAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

export interface RepeatRule {
  unit: 'day' | 'week' | 'month' | 'year' | 'weekdays';
  /** Every this many units (1 for "every week"). */
  every: number;
  /** For 'weekdays': which days (0 Sunday … 6 Saturday). */
  days: number[];
  /** "when done": the next one counts from the day it's ticked, not from when it was due. */
  whenDone: boolean;
}

/**
 * What "every …" means: every day, week, month or year (or every 2 of them), every weekday, or every
 * Monday (or "Monday and Thursday"), optionally "when done". Null for anything else: the task then
 * doesn't come back, rather than coming back on a day nobody meant.
 */
export function repeatRule(words: string): RepeatRule | null {
  let w = words.trim().toLowerCase().replace(/\s+/g, ' ');
  const whenDone = /\bwhen done$/.test(w);
  w = w.replace(/,? ?when done$/, '').trim();
  const m = /^every (?:(\d{1,3}) )?(day|week|month|year)s?$/.exec(w);
  if (m) {
    const every = m[1] ? Number(m[1]) : 1;
    if (every < 1) return null;
    return { unit: m[2] as RepeatRule['unit'], every, days: [], whenDone };
  }
  if (w === 'every weekday') return { unit: 'weekdays', every: 1, days: [1, 2, 3, 4, 5], whenDone };
  const named = /^every ([a-z, ]+)$/.exec(w);
  if (named) {
    const parts = named[1].split(/,|\band\b/).map((p) => p.trim()).filter(Boolean);
    const days = parts.map((p) => DAY_NAMES.findIndex((d) => d === p || d.slice(0, 3) === p));
    if (days.length && days.every((d) => d >= 0)) return { unit: 'weekdays', every: 1, days: [...new Set(days)].sort(), whenDone };
  }
  return null;
}

const toDate = (iso: string) => {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d);
};
const toIso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/**
 * The next date after `from` (YYYY-MM-DD) by `rule`. A month on from the 31st is the month's last day
 * (31 January, then 28 or 29 February), as is a year on from 29 February.
 */
export function nextDate(rule: RepeatRule, from: string): string {
  const d = toDate(from);
  if (rule.unit === 'day') d.setDate(d.getDate() + rule.every);
  else if (rule.unit === 'week') d.setDate(d.getDate() + 7 * rule.every);
  else if (rule.unit === 'month' || rule.unit === 'year') {
    const day = d.getDate();
    d.setDate(1);
    if (rule.unit === 'month') d.setMonth(d.getMonth() + rule.every);
    else d.setFullYear(d.getFullYear() + rule.every);
    const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
    d.setDate(Math.min(day, last));
  } else {
    do d.setDate(d.getDate() + 1);
    while (!rule.days.includes(d.getDay()));
  }
  return toIso(d);
}

/** Which ticked tasks get the day they were ticked: those with a due date or a repeat, every one, or none. */
export type DoneDates = 'dated' | 'all' | 'off';

// A task line's box, after its quote markers, indent and list marker: group 2 is what's in it.
const BOX = /^((?:[ \t]*>[ \t]?)*[ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]+\[)([ xX])\]/;

/** Whether a line is a ticked task (true), an unticked one (false), or not a task (null). */
export function isTicked(line: string): boolean | null {
  const box = BOX.exec(line);
  return box ? box[2] !== ' ' : null;
}

/**
 * A task line ticked (`done`) or unticked on `today`. Ticked, it gets that date ("✅ 2026-11-20"),
 * unless `dates` says not to; unticked, the date goes. A repeating task ticked also gives `next`: the
 * same task unticked, due on its next date (from when it was due, or from today "when done" or with no
 * due date), to go on the line above it, as Obsidian's Tasks plugin does. Not a task line: unchanged.
 */
export function tickTaskLine(line: string, done: boolean, today: string, dates: DoneDates = 'dated'): { line: string; next: string | null } {
  const box = BOX.exec(line);
  if (!box) return { line, next: null };
  const was = box[2] !== ' ';
  if (was === done) return { line, next: null };
  const withBox = (l: string, tick: boolean) => l.replace(BOX, (_m, head: string) => `${head}${tick ? 'x' : ' '}]`);
  const withoutDone = (l: string) => l.replace(new RegExp(`[ \\t]*${DONE_ON.source}`, 'u'), '');
  const repeatWords = REPEAT.exec(line)?.[1];
  const rule = repeatWords ? repeatRule(repeatWords) : null;
  const due = DUE.exec(line)?.[1] ?? null;

  if (!done) return { line: withoutDone(withBox(line, false)), next: null };

  const stamp = dates === 'all' || (dates === 'dated' && (!!due || !!rule));
  const ticked = withBox(withoutDone(line), true).replace(/[ \t]+$/, '');
  let next: string | null = null;
  if (rule) {
    const nextDue = nextDate(rule, rule.whenDone || !due ? today : due);
    const fresh = withBox(withoutDone(line), false).replace(/[ \t]+$/, '');
    next = due ? fresh.replace(DUE, (m, d: string) => m.replace(d, nextDue)) : `${fresh} 📅 ${nextDue}`;
  }
  return { line: stamp ? `${ticked} ✅ ${today}` : ticked, next };
}

// The quote prefix is taken once, as a whole (a lookahead isn't backtracked into), so a line of many
// "> " markers fails fast instead of trying every way to split their spaces (exponential in the depth).
const TASK_LINE = /^(?=((?:[ \t]*>[ \t]?)*))\1([ \t]*)(?:[-*+]|\d{1,9}[.)])[ \t]+\[([ xX])\](?:[ \t]+(.*))?$/;
/** A task's due date ("📅 2026-11-20" or "due:2026-11-20"); the date is group 1. */
export const DUE = /(?:📅️?|\bdue:)[ \t]*(\d{4}-\d{2}-\d{2})\b/u;
/** A task line's text as plain words: links as their text, formatting markers dropped. */
export function plainTaskText(text: string): string {
  // Each pattern stops at the next opening bracket or parenthesis, so a line of unclosed "![" or "[x]("
  // is scanned once rather than once from each of them.
  return text
    .replace(DUE, '')
    .replace(DONE_ON, '')
    .replace(REPEAT, '')
    .replace(/!\[([^[\]]*)\]\([^()]*\)/g, '$1')
    .replace(/\[\[([^[\]|#]*)(?:#([^[\]|]*))?(?:\|([^[\]]*))?\]\]/g, (_m, t: string, h?: string, a?: string) => a || (h ? `${t} › ${h}` : t))
    .replace(/\[([^[\]]*)\]\([^()]*\)/g, '$1')
    .replace(/(\*\*|__|~~|==)/g, '')
    .replace(/(^|[\s(])[*_]([^*_\s][^*_]*?)[*_](?=[\s).,;:!?]|$)/g, '$1$2')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

export function parseTasks(md: string): Task[] {
  const out: Task[] = [];
  linesOutsideCode(md, (line, i, raw) => {
    const m = TASK_LINE.exec(line);
    if (!m) return;
    const body = m[4] ?? '';
    // An empty box (the journal template's "- [ ] ", say) isn't a task until it says something.
    if (!body.trim()) return;
    // Two spaces make a level, and so does a tab (as Obsidian indents).
    const indent = m[2].replace(/\t/g, '  ').length;
    out.push({
      line: i,
      raw,
      text: plainTaskText(body),
      done: m[3] !== ' ',
      due: DUE.exec(body)?.[1] ?? null,
      doneOn: DONE_ON.exec(body)?.[1] ?? null,
      repeat: ((words) => (words && repeatRule(words) ? words.trim() : null))(REPEAT.exec(body)?.[1]),
      depth: Math.min(6, Math.floor(indent / 2)),
    });
  });
  return out;
}

/**
 * The note's text with the task ticked or unticked on `today` (see tickTaskLine: its date, and the
 * next one of a repeating task, above it). Found by its line, or by its exact text if lines moved
 * since; null if it isn't there any more.
 */
export function toggleTaskIn(md: string, task: Pick<Task, 'line' | 'raw'>, done: boolean, today: string, dates: DoneDates = 'dated'): string | null {
  const lines = md.split('\n');
  let i = task.line < lines.length && lines[task.line] === task.raw ? task.line : lines.indexOf(task.raw);
  if (i < 0) {
    // Ticked or unticked elsewhere meanwhile: the same task with the other box (and maybe its date).
    const same = (l: string) => l.replace(BOX, '$1 ]').replace(new RegExp(`[ \\t]*${DONE_ON.source}`, 'u'), '');
    const want = same(task.raw);
    i = task.line < lines.length && same(lines[task.line]) === want ? task.line : lines.findIndex((l) => BOX.test(l) && same(l) === want);
    if (i < 0) return null;
  }
  const { line, next } = tickTaskLine(lines[i], done, today, dates);
  lines[i] = line;
  if (next !== null) lines.splice(i, 0, next);
  return lines.join('\n');
}

/** Lines of `md` (0-based) ticked or unticked, each as tickTaskLine does (a repeating task's next one above it). */
export function tickLines(md: string, ticks: Array<{ line: number; done: boolean }>, today: string, dates: DoneDates = 'dated'): string {
  const lines = md.split('\n');
  // From the bottom up, so lines added above one don't move the ones still to do.
  for (const { line: at, done } of [...ticks].sort((a, b) => b.line - a.line)) {
    if (at < 0 || at >= lines.length) continue;
    const { line, next } = tickTaskLine(lines[at], done, today, dates);
    lines[at] = line;
    if (next !== null) lines.splice(at, 0, next);
  }
  return lines.join('\n');
}

/** A due date for people: Today, Tomorrow, a weekday this week, or the date. */
export function dueLabel(due: string, today: string): string {
  const day = (iso: string) => {
    const [y, m, d] = iso.split('-').map(Number);
    return new Date(y, m - 1, d);
  };
  const diff = Math.round((day(due).getTime() - day(today).getTime()) / 86_400_000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Tomorrow';
  if (diff === -1) return 'Yesterday';
  const date = day(due);
  if (diff > 1 && diff < 7) return date.toLocaleDateString(undefined, { weekday: 'long' });
  const sameYear = due.slice(0, 4) === today.slice(0, 4);
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }) });
}
