import { EditorSelection } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import { useSettings } from './settings';
import { tickTaskLine } from './tasks';
import { todayIso } from './utils';

/** How many `ch` in a row end `text` (fromEnd) or start it. */
function runOf(text: string, ch: string, fromEnd: boolean): number {
  let n = 0;
  while (n < text.length && text[fromEnd ? text.length - 1 - n : n] === ch) n++;
  return n;
}

/**
 * Whether a run of `run` star (or underscore) markers holds the marker `m`: "*" (italic) is in runs of
 * 1 and 3, "**" (bold) in runs of 2 and 3. So Ctrl/⌘ I on a bold word makes it bold italic, rather
 * than taking one star of its bold for an italic marker.
 */
const runHolds = (run: number, m: string) => (m.length === 1 ? run % 2 === 1 : run >= 2);

/** Wrap (or unwrap) each selection in markers like ** or ==. */
export function toggleWrap(view: EditorView, before: string, after = before, placeholder = 'text') {
  const { state } = view;
  // Star and underscore emphasis nest ("***bold italic***"), so they're read by their runs.
  const emphasis = before === after && /^(\*{1,2}|_{1,2})$/.test(before) ? before[0] : null;
  const tr = state.changeByRange((range) => {
    const text = state.sliceDoc(range.from, range.to);
    const outerBefore = state.sliceDoc(Math.max(0, range.from - before.length), range.from);
    const outerAfter = state.sliceDoc(range.to, range.to + after.length);
    if (emphasis) {
      const around = Math.min(runOf(state.sliceDoc(Math.max(0, range.from - 3), range.from), emphasis, true), runOf(state.sliceDoc(range.to, range.to + 3), emphasis, false));
      const inside = text.length > 2 * before.length ? Math.min(runOf(text, emphasis, false), runOf(text, emphasis, true), 3) : 0;
      if (around && runHolds(around, before)) {
        return {
          changes: [
            { from: range.from - before.length, to: range.from, insert: '' },
            { from: range.to, to: range.to + after.length, insert: '' },
          ],
          range: EditorSelection.range(range.from - before.length, range.to - before.length),
        };
      }
      if (!around && inside && runHolds(inside, before)) {
        const inner = text.slice(before.length, text.length - after.length);
        return {
          changes: { from: range.from, to: range.to, insert: inner },
          range: EditorSelection.range(range.from, range.from + inner.length),
        };
      }
    } else if (outerBefore === before && outerAfter === after) {
      return {
        changes: [
          { from: range.from - before.length, to: range.from, insert: '' },
          { from: range.to, to: range.to + after.length, insert: '' },
        ],
        range: EditorSelection.range(range.from - before.length, range.to - before.length),
      };
    }
    if (!emphasis && text.length >= before.length + after.length && text.startsWith(before) && text.endsWith(after)) {
      const inner = text.slice(before.length, text.length - after.length);
      return {
        changes: { from: range.from, to: range.to, insert: inner },
        range: EditorSelection.range(range.from, range.from + inner.length),
      };
    }
    if (range.empty) {
      return {
        changes: { from: range.from, insert: before + placeholder + after },
        range: EditorSelection.range(range.from + before.length, range.from + before.length + placeholder.length),
      };
    }
    return {
      changes: { from: range.from, to: range.to, insert: before + text + after },
      range: EditorSelection.range(range.from + before.length, range.to + before.length),
    };
  });
  view.dispatch(state.update(tr, { scrollIntoView: true, userEvent: 'input.format' }));
  view.focus();
}

function selectedLines(view: EditorView) {
  const { state } = view;
  const lines = new Set<number>();
  for (const r of state.selection.ranges) {
    const a = state.doc.lineAt(r.from).number;
    // A selection ending at the very start of a line (as a triple-click selects) doesn't take that line.
    const end = state.doc.lineAt(r.to);
    const b = !r.empty && r.to === end.from && end.number > a ? end.number - 1 : end.number;
    for (let n = a; n <= b; n++) lines.add(n);
  }
  return [...lines].sort((x, y) => x - y).map((n) => state.doc.line(n));
}

// Group 1: a quote's "> " markers (kept: a list in a callout stays in it) and the indent; then the marker.
const MARKER_RE = /^((?:[ \t]*>)*[ \t]*)(?:(?:[-*+]|\d+[.)])\s\[[ xX]\]\s|[-*+]\s|\d+[.)]\s)?/;

export type LineKind = 'bullet' | 'number' | 'task' | 'quote';

export function toggleLinePrefix(view: EditorView, kind: LineKind) {
  const lines = selectedLines(view);
  const changes: Array<{ from: number; to: number; insert: string }> = [];
  if (kind === 'quote') {
    for (const line of lines) {
      const m = /^\s{0,3}>\s?/.exec(line.text);
      if (m) changes.push({ from: line.from, to: line.from + m[0].length, insert: '' });
      else changes.push({ from: line.from, to: line.from, insert: '> ' });
    }
    view.dispatch({ changes, scrollIntoView: true, userEvent: 'input.format' });
    view.focus();
    return;
  }
  const parsed = lines.map((line) => {
    const m = MARKER_RE.exec(line.text)!;
    const indent = m[1];
    const marker = m[0].slice(indent.length);
    const isTask = /^(?:[-*+]|\d+[.)])\s\[[ xX]\]\s/.test(marker);
    const isBullet = !isTask && /^[-*+]\s/.test(marker);
    const isNumber = !isTask && /^\d+[.)]\s/.test(marker);
    const already = (kind === 'task' && isTask) || (kind === 'bullet' && isBullet) || (kind === 'number' && isNumber);
    return { line, indent, marker, already };
  });
  // Every selected line becomes that kind of list, extending one that's there; only when all of them
  // are already does it go (as Ctrl/⌘ Enter treats a mixed selection).
  const remove = parsed.every((p) => p.already);
  let n = 1;
  for (const { line, indent, marker, already } of parsed) {
    const from = line.from + indent.length;
    const to = from + marker.length;
    if (remove) changes.push({ from, to, insert: '' });
    else if (kind === 'number') changes.push({ from, to, insert: `${n++}. ` });
    // A task keeps its tick, a bullet its own marker.
    else if (!already) changes.push({ from, to, insert: kind === 'task' ? '- [ ] ' : '- ' });
  }
  view.dispatch({ changes, scrollIntoView: true, userEvent: 'input.format' });
  view.focus();
}

// A task as the Tasks view reads one: bulleted or numbered, in a quote or callout too.
const TASK_RE = /^((?:[ \t]*>)*[ \t]*(?:[-*+]|\d+[.)])\s\[)([ xX])\]/;

/**
 * Ctrl/⌘ Enter: ticks the tasks on the selected lines (or unticks them, when all are ticked already);
 * lines with no task become tasks.
 */
export function toggleTask(view: EditorView): boolean {
  const lines = selectedLines(view);
  const tasks = lines.filter((l) => TASK_RE.test(l.text));
  if (!tasks.length) {
    toggleLinePrefix(view, 'task');
    return true;
  }
  const tick = tasks.some((l) => TASK_RE.exec(l.text)![2] === ' ');
  const today = todayIso();
  const dates = useSettings.getState().taskDoneDates;
  // Only the tasks that change: one already ticked keeps its own "x" or "X". Each is dated, and a
  // repeating one gets its next one above it (see tickTaskLine).
  const changes = tasks
    .filter((l) => (TASK_RE.exec(l.text)![2] === ' ') === tick)
    .map((l) => {
      const { line, next } = tickTaskLine(l.text, tick, today, dates);
      if (line === l.text && next === null) {
        const at = l.from + TASK_RE.exec(l.text)![1].length;
        return { from: at, to: at + 1, insert: tick ? 'x' : ' ' };
      }
      return { from: l.from, to: l.to, insert: next === null ? line : `${next}\n${line}` };
    });
  view.dispatch({ changes, userEvent: 'input.format' });
  view.focus();
  return true;
}

// A line's quote markers, taken whole (a lookahead isn't backtracked into).
const QUOTE_PREFIX = /^(?=((?:[ \t]*>[ \t]?)*))\1/;

export function setHeading(view: EditorView, level: number) {
  const lines = selectedLines(view);
  const parsed = lines.map((line) => {
    // A heading in a quote or callout stays in it: "> ## Next steps", not "## > Next steps".
    const quote = QUOTE_PREFIX.exec(line.text)![1];
    const rest = line.text.slice(quote.length);
    const m = /^(#{1,6})\s+/.exec(rest);
    return { line, quote, rest, m, current: m ? m[1].length : 0 };
  });
  // Several lines all become the heading, unless every one is already (then they're text again).
  const content = parsed.filter((p) => p.rest.trim() || parsed.length === 1);
  const off = level === 0 || content.every((p) => p.current === level);
  const changes = content.map(({ line, quote, rest, m }) => {
    let strip = m ? m[0].length : 0;
    const insert = off ? '' : `${'#'.repeat(level)} `;
    // A list item or task made a heading stops being one (as in Google Docs), rather than "## - [ ] …".
    if (!m && insert) strip = /^\s*(?:[-*+]\s\[[ xX]\]\s|[-*+]\s|\d+[.)]\s)?/.exec(rest)![0].length;
    const from = line.from + quote.length;
    return { from, to: from + strip, insert };
  });
  view.dispatch({ changes, scrollIntoView: true, userEvent: 'input.format' });
  view.focus();
}

/** Insert a block on its own lines, with blank lines around it. */
export function insertBlock(view: EditorView, block: string, select?: [number, number]) {
  const { state } = view;
  const sel = state.selection.main;
  const line = state.doc.lineAt(sel.head);
  let from: number;
  let to: number;
  if (line.text.trim() === '') {
    from = line.from;
    to = line.to;
  } else {
    from = to = line.to;
  }
  const before = state.sliceDoc(0, from);
  const after = state.sliceDoc(to);
  const lead = before.length === 0 || before.endsWith('\n\n') ? '' : before.endsWith('\n') ? '\n' : '\n\n';
  const trail = after.startsWith('\n\n') ? '' : after.startsWith('\n') ? '\n' : after.length ? '\n\n' : '\n';
  const insert = lead + block + trail;
  const base = from + lead.length;
  const selection = select
    ? EditorSelection.range(base + select[0], base + select[1])
    : EditorSelection.cursor(base + block.length);
  view.dispatch({ changes: { from, to, insert }, selection, scrollIntoView: true, userEvent: 'input' });
  view.focus();
}

export function insertText(view: EditorView, text: string, cursorOffset?: number) {
  const sel = view.state.selection.main;
  view.dispatch({
    changes: { from: sel.from, to: sel.to, insert: text },
    selection: { anchor: sel.from + (cursorOffset ?? text.length) },
    scrollIntoView: true,
    userEvent: 'input',
  });
  view.focus();
}

export function insertLink(view: EditorView) {
  const sel = view.state.selection.main;
  const text = view.state.sliceDoc(sel.from, sel.to);
  if (/^https?:\/\/\S+$/.test(text)) {
    const insert = `[link text](${text})`;
    view.dispatch({ changes: { from: sel.from, to: sel.to, insert }, selection: { anchor: sel.from + 1, head: sel.from + 10 } });
  } else {
    const label = text || 'link text';
    const insert = `[${label}](https://)`;
    const urlStart = sel.from + label.length + 3;
    view.dispatch({
      changes: { from: sel.from, to: sel.to, insert },
      selection: text ? { anchor: urlStart, head: urlStart + 8 } : { anchor: sel.from + 1, head: sel.from + 1 + label.length },
    });
  }
  view.focus();
}

export function insertTable(view: EditorView, cols = 3, rows = 2) {
  const header = `| ${Array.from({ length: cols }, (_, i) => `Column ${i + 1}`).join(' | ')} |`;
  const sep = `| ${Array.from({ length: cols }, () => '---').join(' | ')} |`;
  const row = `| ${Array.from({ length: cols }, () => '   ').join(' | ')} |`;
  const block = [header, sep, ...Array.from({ length: rows }, () => row)].join('\n');
  insertBlock(view, block, [2, 10]);
}

export function insertCodeBlock(view: EditorView, lang = '') {
  const sel = view.state.selection.main;
  const text = view.state.sliceDoc(sel.from, sel.to);
  if (text && !text.includes('\n')) {
    toggleWrap(view, '`');
    return;
  }
  const body = text || '';
  const block = `\`\`\`${lang}\n${body}\n\`\`\``;
  const start = 4 + lang.length;
  if (text) {
    view.dispatch({ changes: { from: sel.from, to: sel.to, insert: block } });
    view.focus();
    return;
  }
  insertBlock(view, block, [start, start]);
}

export function insertFootnote(view: EditorView) {
  const doc = view.state.doc.toString();
  let n = 1;
  while (doc.includes(`[^${n}]`)) n++;
  const sel = view.state.selection.main;
  const ref = `[^${n}]`;
  const def = `${doc.endsWith('\n') ? '' : '\n'}\n[^${n}]: `;
  view.dispatch({
    changes: [
      { from: sel.to, insert: ref },
      { from: doc.length, insert: def },
    ],
    selection: { anchor: doc.length + ref.length + def.length },
    scrollIntoView: true,
  });
  view.focus();
}
