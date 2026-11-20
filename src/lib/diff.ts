/**
 * Comparing two versions of a note, for version history and for a conflict between devices: which
 * lines are only in one, which are in both, and within a changed line, which words changed.
 *
 * Myers' O(ND) algorithm: fast when the versions are mostly the same, which they usually are. Past a
 * limit on how much differs it gives up (null) rather than make the page wait.
 */

export type Op = 'same' | 'add' | 'del';

/** One line of the comparison. A changed line paired with its counterpart carries word-level `parts`. */
export interface DiffRow {
  op: Op;
  text: string;
  parts?: Array<{ text: string; changed: boolean }>;
}

/** A run of unchanged lines folded away, shown on request. */
export interface DiffFold {
  op: 'fold';
  rows: DiffRow[];
}

export interface Diff {
  rows: Array<DiffRow | DiffFold>;
  added: number;
  removed: number;
}

/** Edits of `a` into `b`: each step keeps, adds (from b) or deletes (from a) one item. Null past `maxEdits`. */
function myers<T>(a: T[], b: T[], maxEdits: number): Array<{ op: Op; i: number }> | null {
  const n = a.length;
  const m = b.length;
  // V for each number of edits d, over the diagonals k = -d..d (index k + d).
  const trace: Int32Array[] = [];
  let found = false;
  for (let d = 0; d <= Math.min(maxEdits, n + m); d++) {
    const prev = trace[d - 1];
    const v = new Int32Array(2 * d + 1);
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (d === 0) x = 0;
      else if (k === -d || (k !== d && prev[k - 1 + d - 1] < prev[k + 1 + d - 1])) x = prev[k + 1 + d - 1];
      else x = prev[k - 1 + d - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[k + d] = x;
      if (x >= n && y >= m) found = true;
    }
    trace.push(v);
    if (found) break;
  }
  if (!found) return null;

  const ops: Array<{ op: Op; i: number }> = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d > 0; d--) {
    const prev = trace[d - 1];
    const k = x - y;
    const prevK = k === -d || (k !== d && prev[k - 1 + d - 1] < prev[k + 1 + d - 1]) ? k + 1 : k - 1;
    const prevX = prev[prevK + d - 1];
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      ops.push({ op: 'same', i: x - 1 });
      x--;
      y--;
    }
    if (x === prevX) ops.push({ op: 'add', i: y - 1 });
    else ops.push({ op: 'del', i: x - 1 });
    x = prevX;
    y = prevY;
  }
  while (x > 0 && y > 0) {
    ops.push({ op: 'same', i: x - 1 });
    x--;
    y--;
  }
  return ops.reverse();
}

const TOKEN = /\s+|[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]/gu;

/** Which words changed between two versions of a line, or null when there's no useful answer. */
function wordParts(before: string, after: string): { del: DiffRow['parts']; add: DiffRow['parts'] } | null {
  if (before.length > 2000 || after.length > 2000) return null;
  const a = before.match(TOKEN) ?? [];
  const b = after.match(TOKEN) ?? [];
  const ops = myers(a, b, 120);
  if (!ops) return null;
  const del: NonNullable<DiffRow['parts']> = [];
  const add: NonNullable<DiffRow['parts']> = [];
  const push = (list: NonNullable<DiffRow['parts']>, text: string, changed: boolean) => {
    const last = list[list.length - 1];
    if (last && last.changed === changed) last.text += text;
    else list.push({ text, changed });
  };
  let common = 0;
  for (const o of ops) {
    if (o.op === 'same') {
      push(del, a[o.i], false);
      push(add, a[o.i], false);
      // Only words count as shared: lines alike in nothing but a full stop aren't "the same line, edited".
      common += /[\p{L}\p{N}]/u.test(a[o.i]) ? 1 : 0;
    } else if (o.op === 'del') push(del, a[o.i], true);
    else push(add, b[o.i], true);
  }
  // Lines with almost nothing in common read better as wholly changed.
  return common ? { del, add } : null;
}

/** Unchanged lines kept around each change. */
const CONTEXT = 3;

/**
 * The comparison of `before` with `after`, line by line: unchanged stretches folded down to a few
 * lines around each change. Null when they differ too much to compare quickly.
 */
export function diffText(before: string, after: string, maxEdits = 1500): Diff | null {
  const a = before.split('\n');
  const b = after.split('\n');
  // The same start and end are common and cost nothing to set aside first.
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const ops = myers(a.slice(start, endA), b.slice(start, endB), maxEdits);
  if (!ops) return null;

  const lines: DiffRow[] = [];
  for (let i = 0; i < start; i++) lines.push({ op: 'same', text: a[i] });
  let added = 0;
  let removed = 0;
  // A run of deletions and additions together is a change: its lines are paired for word highlights.
  let dels: DiffRow[] = [];
  let adds: DiffRow[] = [];
  const flush = () => {
    const pairs = Math.min(dels.length, adds.length);
    for (let p = 0; p < pairs; p++) {
      const parts = wordParts(dels[p].text, adds[p].text);
      if (parts) {
        dels[p].parts = parts.del;
        adds[p].parts = parts.add;
      }
    }
    lines.push(...dels, ...adds);
    dels = [];
    adds = [];
  };
  for (const o of ops) {
    if (o.op === 'same') {
      flush();
      lines.push({ op: 'same', text: a[start + o.i] });
    } else if (o.op === 'del') {
      dels.push({ op: 'del', text: a[start + o.i] });
      removed++;
    } else {
      adds.push({ op: 'add', text: b[start + o.i] });
      added++;
    }
  }
  flush();
  for (let i = endA; i < a.length; i++) lines.push({ op: 'same', text: a[i] });

  // Fold long unchanged stretches, keeping CONTEXT lines next to each change.
  const rows: Diff['rows'] = [];
  let i = 0;
  while (i < lines.length) {
    if (lines[i].op !== 'same') {
      rows.push(lines[i++]);
      continue;
    }
    let j = i;
    while (j < lines.length && lines[j].op === 'same') j++;
    const keepBefore = i === 0 ? 0 : CONTEXT;
    const keepAfter = j === lines.length ? 0 : CONTEXT;
    if (j - i > keepBefore + keepAfter + 1) {
      rows.push(...lines.slice(i, i + keepBefore));
      rows.push({ op: 'fold', rows: lines.slice(i + keepBefore, j - keepAfter) });
      rows.push(...lines.slice(j - keepAfter, j));
    } else rows.push(...lines.slice(i, j));
    i = j;
  }
  return { rows, added, removed };
}

/* ------------------------------------------------------------- merging --- */

/** A change one side made: base lines [from, to) replaced by `lines` (from === to: lines inserted before `from`). */
interface Hunk {
  from: number;
  to: number;
  lines: string[];
}

/** How `other` changes `base`, as hunks in base order. Null when they differ too much to compare quickly. */
function hunksOf(base: string[], other: string[], maxEdits: number): Hunk[] | null {
  let start = 0;
  while (start < base.length && start < other.length && base[start] === other[start]) start++;
  let endA = base.length;
  let endB = other.length;
  while (endA > start && endB > start && base[endA - 1] === other[endB - 1]) {
    endA--;
    endB--;
  }
  const ops = myers(base.slice(start, endA), other.slice(start, endB), maxEdits);
  if (!ops) return null;
  const hunks: Hunk[] = [];
  let open: Hunk | null = null;
  let bi = start;
  let oi = start;
  for (const o of ops) {
    if (o.op === 'same') {
      open = null;
      bi++;
      oi++;
      continue;
    }
    if (!open) {
      open = { from: bi, to: bi, lines: [] };
      hunks.push(open);
    }
    if (o.op === 'del') {
      bi++;
      open.to = bi;
    } else {
      open.lines.push(other[oi]);
      oi++;
    }
  }
  return hunks;
}

/**
 * Whether two sides' changes collide: they change a line in common, or one adds lines where the other
 * changes or adds them (which would go first isn't known).
 */
function collide(a: Hunk, b: Hunk): boolean {
  if (a.from < b.to && b.from < a.to) return true;
  const inserts = (h: Hunk, other: Hunk) => h.from === h.to && other.from <= h.from && h.from <= other.to;
  return inserts(a, b) || inserts(b, a);
}

const sameHunk = (a: Hunk, b: Hunk) => a.from === b.from && a.to === b.to && a.lines.length === b.lines.length && a.lines.every((l, i) => l === b.lines[i]);

/**
 * Both sets of changes to `base`, line by line: `mine`'s and `theirs`', when they don't touch the same
 * lines (a change both made the same way counts once). Null when they collide, or when either differs
 * from `base` too much to compare quickly: then a person has to choose.
 */
export function merge3(base: string, mine: string, theirs: string, maxEdits = 1500): string | null {
  if (mine === theirs || theirs === base) return mine;
  if (mine === base) return theirs;
  const b = base.split('\n');
  const ours = hunksOf(b, mine.split('\n'), maxEdits);
  const other = ours && hunksOf(b, theirs.split('\n'), maxEdits);
  if (!ours || !other) return null;
  const out: string[] = [];
  let pos = 0;
  let i = 0;
  let j = 0;
  const take = (h: Hunk) => {
    for (let k = pos; k < h.from; k++) out.push(b[k]);
    out.push(...h.lines);
    pos = h.to;
  };
  while (i < ours.length || j < other.length) {
    const a = ours[i];
    const t = other[j];
    if (a && t && collide(a, t)) {
      if (!sameHunk(a, t)) return null;
      take(a);
      i++;
      j++;
    } else if (a && (!t || a.from < t.from)) {
      take(a);
      i++;
    } else {
      take(t);
      j++;
    }
  }
  for (let k = pos; k < b.length; k++) out.push(b[k]);
  return out.join('\n');
}
