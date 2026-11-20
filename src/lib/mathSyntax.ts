/**
 * Where the math is in a note's Markdown, for the editor's live preview. These follow the rules of
 * @vscode/markdown-it-katex (which renders reading view), so a formula looks the same in both:
 *
 * - `$x$` inline: the opening `$` can't follow a letter or digit, and the closing `$` can't be
 *   followed by one, so "$5 and $10" stays text. `\$` is a literal dollar sign.
 * - `$$x$$` inside a line: display math.
 * - A line starting with `$$` opens a block that runs to a line ending with (or containing) `$$`;
 *   `$$x$$` alone on a line is a one-line block. ```math fences are blocks too.
 *
 * Differences, on purpose: inline math is matched within one line (reading view also allows it to
 * wrap onto the next line of a paragraph), and a `$$` block that is never closed is left as text
 * here rather than swallowing the rest of the note.
 */

export interface InlineMath {
  /** Offsets within the line: `from` at the opening `$`, `to` just past the closing one. */
  from: number;
  to: number;
  tex: string;
  /** `$$…$$` within a line: rendered as display math. */
  display: boolean;
}

export interface MathBlock {
  /** 1-based line numbers of the first and last line, delimiters included. */
  start: number;
  end: number;
  tex: string;
}

const isSpace = (c: string | undefined) => c !== undefined && /^\s$/u.test(c);
const isWordChar = (c: string | undefined) => c !== undefined && /^[\w\d]$/u.test(c);

function canOpenInline(s: string, i: number) {
  const prev = s[i - 1];
  return prev !== '$' && prev !== '\\' && (prev === undefined || isSpace(prev) || !isWordChar(prev));
}

function canCloseInline(s: string, i: number) {
  const next = s[i + 1];
  return next !== '$' && (next === undefined || isSpace(next) || !isWordChar(next));
}

function isDoubleDelim(s: string, i: number) {
  return s[i] === '$' && s[i - 1] !== '$' && s[i - 1] !== '\\' && s[i + 1] === '$' && s[i + 2] !== '$';
}

/** The next `delim` at or after `from` that isn't escaped by an odd number of backslashes. */
function findClosing(s: string, from: number, delim: string) {
  let match = from;
  while ((match = s.indexOf(delim, match)) !== -1) {
    let pos = match - 1;
    while (s[pos] === '\\') pos--;
    if ((match - pos) % 2 === 1) return match;
    match += delim.length;
  }
  return -1;
}

/** Every formula in one line of Markdown (code spans are the caller's to exclude). */
export function scanInlineMath(s: string): InlineMath[] {
  const out: InlineMath[] = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '\\') {
      i += 2; // an escape: `\$` is a literal dollar sign
      continue;
    }
    if (c !== '$') {
      i++;
      continue;
    }
    if (s[i + 1] === '$') {
      if (!isDoubleDelim(s, i)) {
        i += 2;
        continue;
      }
      const start = i + 2;
      const close = findClosing(s, start, '$$');
      if (close === -1) {
        i = start;
        continue;
      }
      if (close === start) {
        i = start + 2;
        continue;
      }
      if (!isDoubleDelim(s, close)) {
        i = start;
        continue;
      }
      out.push({ from: i, to: close + 2, tex: s.slice(start, close), display: true });
      i = close + 2;
      continue;
    }
    if (!canOpenInline(s, i)) {
      i++;
      continue;
    }
    const start = i + 1;
    const close = findClosing(s, start, '$');
    if (close === -1 || close === start || !canCloseInline(s, close)) {
      i = start;
      continue;
    }
    out.push({ from: i, to: close + 1, tex: s.slice(start, close), display: false });
    i = close + 1;
  }
  return out;
}

const FENCE_OPEN = /^\s*(`{3,}|~{3,})(.*)$/;

/** Display-math blocks in a document, given its lines (1-based, as CodeMirror numbers them). */
export function findMathBlocks(lineAt: (n: number) => string, lines: number): MathBlock[] {
  const out: MathBlock[] = [];
  for (let n = 1; n <= lines; n++) {
    const text = lineAt(n);

    const fence = FENCE_OPEN.exec(text);
    if (fence) {
      // Any fenced block: math if its info string is "math", skipped either way so `$$` inside
      // code is never taken for math.
      const mark = fence[1];
      const close = new RegExp(`^\\s*${mark[0] === '`' ? '`' : '~'}{${mark.length},}\\s*$`);
      let end = n + 1;
      while (end <= lines && !close.test(lineAt(end))) end++;
      if (end > lines) break;
      if (/^\s*math\s*$/i.test(fence[2])) {
        const body: string[] = [];
        for (let k = n + 1; k < end; k++) body.push(lineAt(k));
        out.push({ start: n, end, tex: body.join('\n') });
      }
      n = end;
      continue;
    }

    const open = /^\s*\$\$(.*)$/.exec(text);
    if (!open) continue;
    const first = open[1];
    const marks = [...first.matchAll(/\$\$/g)];
    if (marks.length === 1 && marks[0].index === first.length - 2) {
      out.push({ start: n, end: n, tex: first.slice(0, -2).trim() });
      continue;
    }
    if (marks.length > 1) continue; // several $$ on the line: inline display math, not a block

    let end = n + 1;
    let last = '';
    for (; end <= lines; end++) {
      const line = lineAt(end);
      const trimmed = line.trim();
      if (trimmed.endsWith('$$')) {
        last = line.slice(0, line.lastIndexOf('$$'));
        break;
      }
      if (trimmed.includes('$$')) {
        last = line.slice(0, line.indexOf('$$'));
        break;
      }
    }
    if (end > lines) continue; // never closed: leave it as text
    const middle: string[] = [];
    for (let k = n + 1; k < end; k++) middle.push(lineAt(k));
    const parts = [first.trim() ? first : null, ...middle, last.trim() ? last : null].filter((p): p is string => p !== null);
    out.push({ start: n, end, tex: parts.join('\n') });
    n = end;
  }
  return out;
}
