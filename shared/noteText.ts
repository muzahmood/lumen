/**
 * Note text helpers: cleaning titles and tags, and the summaries shown in lists. Shared by the Worker
 * (plaintext notes) and the app (end-to-end encrypted notes, whose text the Worker never sees).
 */

export function cleanTitle(value: unknown): string {
  if (typeof value !== 'string') return '';
  return cutAt(value.replace(/[\r\n\t]+/g, ' ').trim(), 300);
}

export function cleanTags(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of value) {
    if (typeof raw !== 'string') continue;
    // Spaces around the tag (and around a leading #) are dropped, not made into dashes: " #job" is "job".
    const tag = raw.trim().replace(/^#+/, '').trim().replace(/\s+/g, '-').slice(0, 60);
    if (!tag) continue;
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
    if (out.length >= 40) break;
  }
  return out;
}

/*
 * These run in the Worker on every save, under a CPU limit of a few milliseconds, so every pattern must
 * stay linear on any input:
 * - A bracket's contents exclude the opening character too ([^\[\]]*, [^()]*, [^<>]+), so a scan stops
 *   at the next opener instead of running to the end of the note from every one of them. (40 KB of
 *   "![" took over a second before.)
 * - Line starts use [ \t], not \s: with the m flag, \s* also runs across blank lines, so a long run of
 *   them was rescanned from every line (20,000 blank lines took half a second).
 */
const IMAGE_RE = /!\[[^[\]]*\]\([^()]*\)/g;
const LINK_RE = /\[([^[\]]*)\]\([^()]*\)/g;

/** Plain-text preview of a Markdown body, used in note lists. */
/* ------------------------------------------------- math as plain text --- */

const TEX_SYMBOLS: Record<string, string> = {
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε', varepsilon: 'ε', zeta: 'ζ', eta: 'η', theta: 'θ', vartheta: 'ϑ',
  iota: 'ι', kappa: 'κ', lambda: 'λ', mu: 'μ', nu: 'ν', xi: 'ξ', pi: 'π', rho: 'ρ', sigma: 'σ', tau: 'τ', upsilon: 'υ',
  phi: 'φ', varphi: 'φ', chi: 'χ', psi: 'ψ', omega: 'ω', Gamma: 'Γ', Delta: 'Δ', Theta: 'Θ', Lambda: 'Λ', Xi: 'Ξ', Pi: 'Π',
  Sigma: 'Σ', Phi: 'Φ', Psi: 'Ψ', Omega: 'Ω', times: '×', cdot: '·', div: '÷', pm: '±', mp: '∓', le: '≤', leq: '≤',
  ge: '≥', geq: '≥', ne: '≠', neq: '≠', approx: '≈', equiv: '≡', sim: '∼', propto: '∝', infty: '∞', partial: '∂',
  nabla: '∇', sum: '∑', prod: '∏', int: '∫', oint: '∮', to: '→', rightarrow: '→', leftarrow: '←', Rightarrow: '⇒',
  Leftarrow: '⇐', leftrightarrow: '↔', iff: '⇔', implies: '⇒', mapsto: '↦', in: '∈', notin: '∉', subset: '⊂',
  subseteq: '⊆', supset: '⊃', cup: '∪', cap: '∩', emptyset: '∅', forall: '∀', exists: '∃', neg: '¬', land: '∧',
  lor: '∨', ldots: '…', cdots: '⋯', dots: '…', circ: '∘', angle: '∠', perp: '⊥', parallel: '∥', degree: '°',
};
const SUPERSCRIPT: Record<string, string> = {
  0: '⁰', 1: '¹', 2: '²', 3: '³', 4: '⁴', 5: '⁵', 6: '⁶', 7: '⁷', 8: '⁸', 9: '⁹', '+': '⁺', '-': '⁻', '=': '⁼', '(': '⁽', ')': '⁾', n: 'ⁿ', i: 'ⁱ',
};
const SUBSCRIPT: Record<string, string> = {
  0: '₀', 1: '₁', 2: '₂', 3: '₃', 4: '₄', 5: '₅', 6: '₆', 7: '₇', 8: '₈', 9: '₉', '+': '₊', '-': '₋', '=': '₌', '(': '₍', ')': '₎',
};

/** A raised or lowered part as small characters where Unicode has them all, else as ^(…) or _(…). */
function script(text: string, map: Record<string, string>, mark: string): string {
  const chars = [...text];
  if (chars.length && chars.every((c) => map[c])) return chars.map((c) => map[c]).join('');
  return chars.length === 1 ? `${mark}${text}` : `${mark}(${text})`;
}

/**
 * A formula's TeX as plain text for list previews: Greek letters and common symbols as characters,
 * powers and indices as small digits where possible, fractions and roots spelled out. Not typesetting,
 * just readable: "e^{i\pi}" reads "e^(iπ)", "x^2" reads "x²".
 */
export function texToText(tex: string): string {
  const simple = (s: string) => (/^[\p{L}\p{N}.]+$/u.test(s) ? s : `(${s})`);
  // Innermost first, a few levels deep: a root inside a fraction, or a fraction inside a root.
  let spelled = tex;
  for (let depth = 0; depth < 4; depth++) {
    const next = spelled
      .replace(/\\[dt]?frac\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g, (_m, a: string, b: string) => `${simple(a)}/${simple(b)}`)
      .replace(/\\sqrt\s*\{([^{}]*)\}/g, (_m, a: string) => `√${simple(a)}`);
    if (next === spelled) break;
    spelled = next;
  }
  return spelled
    .replace(/\\(?:mathrm|mathbf|mathit|mathcal|mathbb|text|textbf|textit|operatorname)\s*\{([^{}]*)\}/g, '$1')
    .replace(/\\(?:left|right|displaystyle)\b/g, '')
    .replace(/\\([A-Za-z]+)/g, (_m: string, name: string) => TEX_SYMBOLS[name] ?? name)
    .replace(/\\[,;:! ]/g, ' ')
    .replace(/\^\{([^{}]*)\}|\^([^\s{}])/g, (_m, group: string | undefined, one: string | undefined) => script(group ?? one ?? '', SUPERSCRIPT, '^'))
    .replace(/_\{([^{}]*)\}|_([^\s{}])/g, (_m, group: string | undefined, one: string | undefined) => script(group ?? one ?? '', SUBSCRIPT, '_'))
    .replace(/[{}]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** `$…$` inline math, by the same rules as reading view (a "$5 and $10" stays text). */
const INLINE_MATH = /(^|[^\\$\w])\$(?=\S)([^$\n]*?\S)\$(?![\w$])/g;

/** At most `n` UTF-16 units of `s`, never ending on the first half of an emoji (or other surrogate pair). */
export function cutAt(s: string, n: number): string {
  if (s.length <= n) return s;
  const last = s.charCodeAt(n - 1);
  return s.slice(0, last >= 0xd800 && last <= 0xdbff ? n - 1 : n);
}

/** An HTML tag (not "x < 5 and y > 3") or comment; an unclosed comment runs to the end, so it's scanned once. */
const HTML_TAG = /<\/?[A-Za-z][A-Za-z0-9-]*(?:\s[^<>]*)?\/?>|<!--[\s\S]*?(?:-->|$)/g;

/** Plain-text preview of a Markdown body, used in note lists. */
export function makeExcerpt(md: string): string {
  const text = md
    .slice(0, 6000)
    .replace(/(```|~~~)[\s\S]*?(?:\1|$)/g, ' ')
    .replace(/\$\$[\s\S]*?\$\$/g, ' ')
    // Tables by their cells: no delimiter row, cells apart (an escaped \| is a pipe in a cell).
    .replace(/^[ \t]*\|[ \t|:-]+$/gm, ' ')
    .replace(/^[ \t]*\|.*$/gm, (row) => row.replace(/\\\|/g, '\u0000').replace(/\|/g, ' ').replace(/\u0000/g, '|'))
    .replace(INLINE_MATH, (_m, before: string, tex: string) => `${before}${texToText(tex)}`)
    .replace(IMAGE_RE, ' ')
    .replace(LINK_RE, '$1')
    .replace(/\[\[([^[\]|#]*)(?:#[^[\]|]*)?(?:\|([^[\]]*))?\]\]/g, (_m, a: string, b?: string) => b || a);
  return cutAt(
    outsideInlineCode(text, (part) => part.replace(HTML_TAG, ' '))
      .replace(/^[ \t]{0,3}>[ \t]*\[![^[\]\n]*\][+-]?/gm, '')
      // List and quote markers, however many a line starts with ("> - [ ] a task in a quote").
      .replace(/^[ \t]{0,3}(?:(?:#{1,6}|>|[-*+]|\d+[.)])[ \t]+)+/gm, '')
      .replace(/^[ \t]{0,3}>/gm, '')
      .replace(/\[[ xX]\]\s/g, '')
      .replace(/^[ \t]*[-*_]{3,}[ \t]*$/gm, ' ')
      .replace(/(\*\*|__|~~|==|`)/g, '')
      // Single-star or underscore emphasis around words, not a star or underscore used as text.
      .replace(/(^|[\s(])[*_]([^*_\s][^*_]*?)[*_](?=[\s).,;:!?]|$)/gm, '$1$2')
      // Backslash escapes, last: "\*" stays a star.
      .replace(/\\([!-/:-@[-`{-~])/g, '$1')
      .replace(/\s+/g, ' ')
      .trim(),
    240,
  );
}

/* ----------------------------------------------------- outside code --- */

/**
 * `fn` applied to the parts of an inline run that aren't code spans (`code`, ``code``), as CommonMark
 * reads them: a span closes at the next run of exactly as many backticks. Linear time: each length's
 * runs are walked once, so a note full of unmatched backticks can't make this slow.
 */
function outsideInlineCode(text: string, fn: (part: string) => string, code: (part: string) => string = (part) => part): string {
  const runs: Array<[number, number]> = [];
  for (let i = 0; i < text.length; ) {
    if (text.charCodeAt(i) !== 96) {
      i++;
      continue;
    }
    let j = i;
    while (text.charCodeAt(j) === 96) j++;
    runs.push([i, j - i]);
    i = j;
  }
  if (!runs.length) return fn(text);
  const byLength = new Map<number, number[]>();
  runs.forEach(([, length], index) => {
    const list = byLength.get(length);
    if (list) list.push(index);
    else byLength.set(length, [index]);
  });
  const next = new Map<number, number>();
  let out = '';
  let plainStart = 0;
  let r = 0;
  while (r < runs.length) {
    const [start, length] = runs[r];
    const list = byLength.get(length)!;
    let p = next.get(length) ?? 0;
    while (p < list.length && list[p] <= r) p++;
    next.set(length, p);
    // No closing run: these backticks are just text.
    if (p >= list.length) {
      r++;
      continue;
    }
    const closeAt = runs[list[p]][0];
    out += fn(text.slice(plainStart, start)) + code(text.slice(start, closeAt + length));
    plainStart = closeAt + length;
    r = list[p] + 1;
  }
  return out + fn(text.slice(plainStart));
}

const same = (part: string) => part;

/**
 * `fn` applied to a note's Markdown outside fenced code blocks and code spans, and `code` (by default
 * nothing) to the code: each fenced line, fences included, and each code span, backticks included.
 */
export function outsideCode(src: string, fn: (part: string) => string, code: (part: string) => string = same): string {
  const out: string[] = [];
  let prose: string[] = [];
  let fence: string | null = null;
  let fenceDepth = 0;
  const flush = () => {
    if (prose.length) out.push(outsideInlineCode(prose.join('\n'), fn, code));
    prose = [];
  };
  for (const line of src.split('\n')) {
    // As linesOutsideCode reads fences: one can sit in a quote or callout (its lines start with the
    // same ">" markers, and it ends when that quote does) or under a list item (indented past 3
    // spaces). In doubt it counts as code: renaming a note then leaves a link alone rather than
    // rewriting code.
    const quote = QUOTE_PREFIX.exec(line)![1];
    const depth = quote.split('>').length - 1;
    const inner = line.slice(quote.length);
    if (fence && depth < fenceDepth) fence = null;
    if (fence) {
      out.push(code(line));
      const close = /^[ \t]*(`{3,}|~{3,})\s*$/.exec(inner);
      if (close && close[1][0] === fence[0] && close[1].length >= fence.length) fence = null;
      continue;
    }
    // A run of backticks followed by more backticks on the line is code in the text, not a fence.
    const open = /^[ \t]*(?:(`{3,})(?![^\n]*`)|(~{3,}))/.exec(inner);
    if (open) {
      flush();
      fence = open[1] ?? open[2];
      fenceDepth = depth;
      out.push(code(line));
      continue;
    }
    // A code span can't reach past its paragraph: a blank line ends one, and a heading is one of its own.
    // So a lone backtick in one paragraph doesn't pair with another paragraphs later, hiding the links between.
    if (/^ {0,3}#{1,6}(?:[ \t]|$)/.test(line)) {
      flush();
      prose.push(line);
      flush();
      continue;
    }
    prose.push(line);
    if (!line.trim()) flush();
  }
  flush();
  return out.join('\n');
}

/** The note's Markdown with code (fenced blocks and code spans) left out. */
function proseOnly(md: string): string {
  const parts: string[] = [];
  outsideCode(md, (part) => {
    parts.push(part);
    return part;
  });
  return parts.join('\n');
}

/** The notes a note links to: by id (`/note/<id>` links) and by title (`[[Title]]`, lower case). */
export interface NoteLinks {
  n: string[];
  w: string[];
}

/**
 * The links a note makes to other notes. Encrypted notes keep these in their encrypted preview, so the
 * app can tell which notes link to which from the note list alone. Capped, so a note made of nothing
 * but links can't push its preview past the server's size limit. Links written inside code aren't links.
 */
export function makeLinks(source: string): NoteLinks {
  const md = proseOnly(source);
  const ids = new Set<string>();
  for (const m of md.matchAll(/\/note\/([A-Za-z0-9_-]{6,64})/g)) {
    ids.add(m[1]);
    if (ids.size >= 500) break;
  }
  const titles = new Set<string>();
  let chars = 0;
  // [[Title]], [[Title|alias]] and [[Title#Heading]]: the target is what comes before | or #.
  for (const m of md.matchAll(/\[\[([^[\]|#\n]{1,300})(?:[|#][^[\]\n]*)?\]\]/g)) {
    const title = m[1].trim().toLowerCase();
    if (!title || titles.has(title)) continue;
    chars += title.length;
    if (titles.size >= 500 || chars > 40_000) break;
    titles.add(title);
  }
  return { n: [...ids], w: [...titles] };
}

/**
 * Small summary shown in note lists: first image (thumbnail), task progress,
 * diagram/drawing counts and a word count. Stored as compact JSON.
 */
// The quote markers ("> > ") can be read only one way, so a line of many of them fails fast instead of
// trying every way to split their spaces (exponential in the depth).
const TASK_BOX = /^(?:[ \t]*>)*[ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]+\[([ xX])\](?:[ \t]|$)/;
const FENCE_LINE = /^ {0,3}(`{3,}|~{3,})/;
/** A line's quote markers, taken whole (a lookahead isn't backtracked into), so many of them fail fast. */
const QUOTE_PREFIX = /^(?=((?:[ \t]*>[ \t]?)*))\1/;

/**
 * Calls `fn` for each line outside fenced code, as CommonMark reads it: a fence can sit in a quote or
 * callout (its lines then start with the same ">" markers), and ends when that quote does. Lines are
 * passed without a Windows "\r" (`raw` keeps it). Shared by the list's task count and the Tasks view.
 */
export function linesOutsideCode(md: string, fn: (line: string, index: number, raw: string) => void) {
  const lines = md.split('\n');
  let fence: string | null = null;
  let fenceDepth = 0;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    const quote = QUOTE_PREFIX.exec(line)![1];
    const depth = quote.split('>').length - 1;
    const inner = line.slice(quote.length);
    if (fence && depth < fenceDepth) fence = null;
    const f = FENCE_LINE.exec(inner);
    if (fence) {
      if (f && f[1][0] === fence[0] && f[1].length >= fence.length && /^ {0,3}(`{3,}|~{3,})\s*$/.test(inner)) fence = null;
      continue;
    }
    if (f) {
      fence = f[1];
      fenceDepth = depth;
      continue;
    }
    fn(line, i, raw);
  }
}

/**
 * Tasks as [done, total]: list items starting with [ ] or [x] and something after it, bulleted or
 * numbered, quoted or not, outside code blocks. The same rule as the Tasks view (src/lib/tasks.ts),
 * so the counts agree.
 */
function countTasks(md: string): [number, number] {
  if (!/\[[ xX]\]/.test(md)) return [0, 0];
  let done = 0;
  let total = 0;
  linesOutsideCode(md, (line) => {
    const m = TASK_BOX.exec(line);
    // An empty box isn't a task until it says something (as the Tasks view reads it).
    if (!m || !line.slice(m[0].length).trim()) return;
    total++;
    if (m[1] !== ' ') done++;
  });
  return [done, total];
}

export function makeInfo(md: string): string {
  const info: { th?: string; t?: [number, number]; d?: number; dr?: number; w?: number; im?: number } = {};
  const media = /\.(mp4|webm|mov|m4v|ogv|mp3|m4a|wav|ogg|oga|flac|aac)$/i;
  // At most one path segment (the file name) after the id, so a link such as /api/files/x/../../… can't
  // point the list's thumbnail at some other address of the site.
  const thumb = /!\[[^[\]]*\]\((\/api\/(?:files\/[A-Za-z0-9_-]+(?:\/[^\s)/]*)?|drawings\/[A-Za-z0-9_-]+\.svg))\)/g;
  let m: RegExpExecArray | null;
  while ((m = thumb.exec(md))) {
    if (!media.test(m[1])) {
      info.th = m[1];
      break;
    }
  }
  // Pictures (for has:image): uploaded or from other websites, not drawings, video or audio, and not
  // an example written in code.
  let images = 0;
  for (const img of (md.includes('![') ? proseOnly(md) : '').matchAll(/!\[[^[\]]*\]\(([^()]*)\)/g)) {
    const url = img[1].trim().replace(/^<|>$/g, '').split(/\s/)[0];
    if (url && !url.startsWith('/api/drawings/') && !media.test(url) && ++images >= 99) break;
  }
  if (images) info.im = images;
  const tasks = countTasks(md);
  if (tasks[1]) info.t = tasks;
  const diagrams = md.match(/^[ \t]*```+[ \t]*mermaid/gm)?.length ?? 0;
  if (diagrams) info.d = diagrams;
  const drawings = md.match(/\/api\/drawings\/[A-Za-z0-9_-]+\.svg/g)?.length ?? 0;
  if (drawings) info.dr = drawings;
  const words = md
    .replace(/```[\s\S]*?(```|$)/g, ' ')
    .replace(IMAGE_RE, ' ')
    .match(/[\p{L}\p{N}][\p{L}\p{N}'’]*/gu)?.length;
  if (words) info.w = words;
  return JSON.stringify(info);
}
