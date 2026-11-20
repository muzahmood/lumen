import DOMPurify from 'dompurify';
import { TOP_LAYER_ATTRS, TOP_LAYER_TAGS, cssLoadsRemote, dropRemoteCss, keepPositionInNote, positionStaysInNote, srcsetLoadsRemote } from './htmlSafety';
import { isChunkError } from './recovery';
import { useSettings } from './settings';
import { escapeHtml } from './utils';

type Mermaid = (typeof import('mermaid'))['default'];

const FONT = '"Geist Variable", "Geist", system-ui, sans-serif';

// Lumen palette (Prussian Ink): ink-blue nodes, marigold notes and secondary shapes.
const THEMES = {
  light: {
    background: '#EEF2F7',
    primaryColor: '#E7EEF7',
    primaryTextColor: '#142030',
    primaryBorderColor: '#1E4E80',
    secondaryColor: '#FCEFD2',
    secondaryTextColor: '#142030',
    secondaryBorderColor: '#B7760C',
    tertiaryColor: '#F1F4F8',
    tertiaryTextColor: '#142030',
    tertiaryBorderColor: '#C9D3DF',
    lineColor: '#46566A',
    textColor: '#142030',
    mainBkg: '#E7EEF7',
    nodeBorder: '#1E4E80',
    clusterBkg: '#F1F4F8',
    clusterBorder: '#C9D3DF',
    edgeLabelBackground: '#EEF2F7',
    noteBkgColor: '#FCEFD2',
    noteTextColor: '#142030',
    noteBorderColor: '#B7760C',
    actorBkg: '#E7EEF7',
    actorBorder: '#1E4E80',
    signalColor: '#142030',
    fontFamily: FONT,
    fontSize: '15px',
  },
  dark: {
    darkMode: true,
    background: '#151E2A',
    primaryColor: '#1A2C44',
    primaryTextColor: '#E3E9F0',
    primaryBorderColor: '#7EB0E6',
    secondaryColor: '#3A2F17',
    secondaryTextColor: '#FBEBC4',
    secondaryBorderColor: '#F0B550',
    tertiaryColor: '#18222F',
    tertiaryTextColor: '#E3E9F0',
    tertiaryBorderColor: '#2F3F52',
    lineColor: '#A2B0C0',
    textColor: '#E3E9F0',
    mainBkg: '#1A2C44',
    nodeBorder: '#7EB0E6',
    clusterBkg: '#18222F',
    clusterBorder: '#2F3F52',
    edgeLabelBackground: '#151E2A',
    noteBkgColor: '#3A2F17',
    noteTextColor: '#FBEBC4',
    noteBorderColor: '#F0B550',
    actorBkg: '#1A2C44',
    actorBorder: '#7EB0E6',
    signalColor: '#E3E9F0',
    fontFamily: FONT,
    fontSize: '15px',
  },
} as const;

let loader: Promise<Mermaid> | null = null;
let configuredTheme: 'light' | 'dark' | null = null;
let queue: Promise<unknown> = Promise.resolve();
let seq = 0;
const cache = new Map<string, string>();

function load(): Promise<Mermaid> {
  if (!loader) {
    loader = import('mermaid')
      .then((m) => m.default)
      .catch((err) => {
        // A failed download (offline) isn't remembered, so the next diagram tries again.
        loader = null;
        throw err;
      });
  }
  return loader;
}

/** The diagram library couldn't be downloaded (offline, before it was ever loaded on this device). */
export const OFFLINE_DIAGRAM_MESSAGE = 'This diagram can’t be drawn offline yet. It appears once you’re back online.';

function configure(mermaid: Mermaid, theme: 'light' | 'dark') {
  if (configuredTheme === theme) return;
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    theme: 'base',
    themeVariables: THEMES[theme],
    fontFamily: FONT,
    flowchart: { curve: 'basis', htmlLabels: true },
    suppressErrorRendering: true,
  } as Parameters<Mermaid['initialize']>[0]);
  configuredTheme = theme;
}

/**
 * Mermaid cleans its own output, but less strictly than Lumen cleans notes: form fields, buttons and
 * stray style rules could get through from a crafted diagram. So every diagram is cleaned again here.
 * Labels keep their HTML (inside foreignObject); form controls go; and of the CSS, only Mermaid's own
 * stylesheet at the top of the SVG stays, and in it only rules scoped to this diagram's id (plus its
 * font variables and animations), so nothing written in a diagram can style the rest of the app.
 */
const DIAGRAM_PURIFY = {
  USE_PROFILES: { svg: true, svgFilters: true, html: true },
  ADD_TAGS: ['foreignObject', 'foreignobject'],
  HTML_INTEGRATION_POINTS: { foreignobject: true },
  // Labels' HTML can't open a dialog or popover over the app either (see htmlSafety.ts).
  FORBID_TAGS: ['form', 'input', 'button', 'textarea', 'select', 'option', 'script', ...TOP_LAYER_TAGS],
  FORBID_ATTR: TOP_LAYER_ATTRS,
};

function scopedCss(css: string, id: string): string {
  let sheet: CSSStyleSheet;
  try {
    sheet = new CSSStyleSheet();
    sheet.replaceSync(css);
  } catch {
    return '';
  }
  const scope = `#${id}`;
  const scoped = (selector: string) => {
    const s = selector.trim();
    return s.startsWith(scope) && !/[\w-]/.test(s.charAt(scope.length));
  };
  const keep = (rule: CSSRule): string | null => {
    if (rule instanceof CSSStyleRule) {
      // Not even its own box may pin itself over the app (a fake lock screen, say), as in notes: only
      // positioning that stays in the note, so not a variable that turns into "fixed" either.
      if (!positionStaysInNote(rule.style.getPropertyValue('position'))) rule.style.removeProperty('position');
      if (rule.selectorText.split(',').every(scoped)) return rule.cssText;
      const style = rule.style;
      const onlyFontVars = Array.from({ length: style.length }, (_, i) => style.item(i)).every((p) => p.startsWith('--mermaid'));
      return rule.selectorText.trim() === ':root' && onlyFontVars ? rule.cssText : null;
    }
    if (rule instanceof CSSKeyframesRule) return rule.cssText;
    if (rule instanceof CSSMediaRule) {
      const inner = Array.from(rule.cssRules, keep).filter(Boolean);
      return inner.length ? `@media ${rule.conditionText}{${inner.join('')}}` : null;
    }
    return null;
  };
  return Array.from(sheet.cssRules, keep).filter(Boolean).join('\n');
}

export function sanitizeDiagram(svg: string, id: string): string {
  const clean = DOMPurify.sanitize(svg, DIAGRAM_PURIFY) as unknown as string;
  const box = document.createElement('template');
  box.innerHTML = clean;
  const root = box.content.querySelector('svg');
  for (const style of Array.from(box.content.querySelectorAll('style'))) {
    if (style.parentNode !== root) style.remove();
    else style.textContent = scopedCss(style.textContent ?? '', id);
  }
  // Labels' own styles: the same positioning rule.
  for (const el of Array.from(box.content.querySelectorAll('[style]'))) keepPositionInNote(el);
  return box.innerHTML;
}

/** An address on another site (http, https or protocol-relative). */
function remote(url: string | null): boolean {
  if (!url) return false;
  try {
    const u = new URL(url.trim(), location.href);
    return (u.protocol === 'http:' || u.protocol === 'https:') && u.origin !== location.origin;
  } catch {
    return false;
  }
}

/**
 * A stylesheet without any declaration that loads from another site, read as the browser reads it
 * (so `u\72 l(//host/x)`, an escaped url(), is caught as one). Rules inside @media and @keyframes too.
 */
function withoutRemoteRules(css: string): string {
  let sheet: CSSStyleSheet;
  try {
    sheet = new CSSStyleSheet();
    sheet.replaceSync(css);
  } catch {
    return '';
  }
  const clean = (rules: CSSRuleList) => {
    for (const rule of Array.from(rules)) {
      const style = (rule as CSSRule & { style?: CSSStyleDeclaration }).style;
      if (style) {
        for (const prop of Array.from({ length: style.length }, (_, i) => style.item(i))) {
          if (cssLoadsRemote(style.getPropertyValue(prop), remote)) style.removeProperty(prop);
        }
      }
      const inner = (rule as CSSRule & { cssRules?: CSSRuleList }).cssRules;
      if (inner) clean(inner);
    }
  };
  clean(sheet.cssRules);
  return Array.from(sheet.cssRules, (r) => r.cssText).join('\n');
}

/**
 * A cleaned diagram with nothing that loads from another website (Settings → Images from other
 * websites: Ask first): image nodes, pictures in labels, stylesheet backgrounds. A diagram has no
 * click-to-load box, so they're simply left out. Addresses are read as the browser reads them
 * (htmlSafety.ts), never by pattern.
 */
function withoutRemoteLoads(svg: string): string {
  const box = document.createElement('template');
  box.innerHTML = svg;
  for (const el of Array.from(box.content.querySelectorAll('*'))) {
    const tag = el.localName.toLowerCase();
    for (const name of ['src', 'srcset', 'href', 'xlink:href', 'poster', 'background']) {
      const value = el.getAttribute(name);
      if (value === null) continue;
      // href only where it loads something (SVG image, use, feImage), not on links.
      if (name.endsWith('href') && tag !== 'image' && tag !== 'use' && tag !== 'feimage') continue;
      if (name === 'srcset' ? srcsetLoadsRemote(value, remote) : remote(value)) el.removeAttribute(name);
    }
    dropRemoteCss(el, remote);
  }
  for (const sheet of Array.from(box.content.querySelectorAll('style'))) {
    sheet.textContent = withoutRemoteRules(sheet.textContent ?? '');
  }
  return box.innerHTML;
}

/*
 * A diagram draws a moment after its note opens, and the text below jumped down when it did. Each
 * diagram's drawn height is remembered (per view: editor or reading), so the space is kept from the
 * start next time. Keyed by a short hash of the diagram's code, never the code itself, since this is
 * kept in browser storage that encryption doesn't cover.
 */
const HEIGHTS_KEY = 'kb.diagram-heights';
const MAX_HEIGHTS = 300;
let heights: Map<string, number> | null = null;

function heightKey(source: string, where: 'editor' | 'reading'): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < source.length; i++) {
    h ^= source.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `${where[0]}${(h >>> 0).toString(36)}`;
}

function loadHeights(): Map<string, number> {
  if (!heights) {
    try {
      heights = new Map(Object.entries(JSON.parse(localStorage.getItem(HEIGHTS_KEY) || '{}') as Record<string, number>));
    } catch {
      heights = new Map();
    }
  }
  return heights;
}

export function knownDiagramHeight(source: string, where: 'editor' | 'reading'): number | undefined {
  const h = loadHeights().get(heightKey(source, where));
  return typeof h === 'number' && h > 0 ? h : undefined;
}

export function rememberDiagramHeight(source: string, where: 'editor' | 'reading', px: number) {
  if (!(px > 0)) return;
  const map = loadHeights();
  const key = heightKey(source, where);
  const rounded = Math.round(px);
  if (map.get(key) === rounded) return;
  map.delete(key);
  map.set(key, rounded);
  while (map.size > MAX_HEIGHTS) map.delete(map.keys().next().value!);
  try {
    localStorage.setItem(HEIGHTS_KEY, JSON.stringify(Object.fromEntries(map)));
  } catch {
    /* storage full or unavailable: only the jump comes back */
  }
}

/** Render one diagram to an SVG string. Calls are serialized; mermaid isn't re-entrant. */
export function renderMermaid(source: string, theme: 'light' | 'dark'): Promise<string> {
  // What may load from other websites is part of the result, so part of what it's cached by.
  const askFirst = useSettings.getState().remoteImages === 'ask';
  const key = `${theme}${askFirst ? 'A' : ''}\u0000${source}`;
  const hit = cache.get(key);
  if (hit) return Promise.resolve(hit);
  const job = queue.then(async () => {
    const again = cache.get(key);
    if (again) return again;
    const mermaid = await load();
    configure(mermaid, theme);
    const id = `kbm-${++seq}`;
    try {
      const { svg: raw } = await mermaid.render(id, source);
      const clean = sanitizeDiagram(raw, id);
      const svg = askFirst ? withoutRemoteLoads(clean) : clean;
      cache.set(key, svg);
      if (cache.size > 200) cache.delete(cache.keys().next().value!);
      return svg;
    } finally {
      document.getElementById(id)?.remove();
      document.getElementById(`d${id}`)?.remove();
    }
  });
  queue = job.catch(() => undefined);
  return job;
}

export function mermaidErrorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return raw.replace(/^Error:\s*/, '').split('\n').slice(0, 6).join('\n');
}

/** Fill every `.kb-mermaid` placeholder inside root with its rendered SVG. */
export async function hydrateMermaid(root: HTMLElement, theme: 'light' | 'dark') {
  const blocks = Array.from(root.querySelectorAll<HTMLElement>('.kb-mermaid')).filter(
    (el) => !(el.dataset.rendered === `${theme}:${(el.dataset.src ?? '').length}` && el.dataset.renderedSrc === el.dataset.src),
  );
  // Keep each diagram's space before the first one draws, so the text below doesn't jump.
  for (const el of blocks) {
    const known = knownDiagramHeight(decodeMermaidSource(el.dataset.src ?? ''), 'reading');
    if (known) el.style.minHeight = `${known}px`;
  }
  for (const el of blocks) {
    const encoded = el.dataset.src ?? '';
    const src = decodeMermaidSource(encoded);
    const token = String(++seq);
    el.dataset.token = token;
    try {
      const svg = await renderMermaid(src, theme);
      if (el.dataset.token !== token || !el.isConnected) continue;
      el.innerHTML = `<div class="kb-mermaid-svg" data-action="zoom-diagram">${svg}</div><button type="button" class="kb-block-edit" data-action="edit-mermaid">Edit diagram</button>`;
      el.style.minHeight = '';
      rememberDiagramHeight(src, 'reading', el.offsetHeight);
      el.classList.remove('is-error');
    } catch (err) {
      if (el.dataset.token !== token || !el.isConnected) continue;
      el.style.minHeight = '';
      el.classList.add('is-error');
      if (isChunkError(err)) {
        // Not the diagram's fault, and not marked as drawn: the next update tries again.
        el.innerHTML = `<div class="kb-mermaid-error"><strong>${OFFLINE_DIAGRAM_MESSAGE}</strong></div><pre class="kb-mermaid-pending">${escapeHtml(src)}</pre>`;
        continue;
      }
      el.innerHTML = `<div class="kb-mermaid-error"><strong>This diagram has a syntax error.</strong><pre>${escapeHtml(
        mermaidErrorMessage(err),
      )}</pre></div><pre class="kb-mermaid-pending">${escapeHtml(src)}</pre><button type="button" class="kb-block-edit" data-action="edit-mermaid">Fix diagram</button>`;
    }
    el.dataset.rendered = `${theme}:${encoded.length}`;
    el.dataset.renderedSrc = encoded;
  }
}

export function decodeMermaidSource(encoded: string): string {
  try {
    return decodeURIComponent(encoded);
  } catch {
    return encoded;
  }
}

export const MERMAID_TEMPLATES: Array<{ id: string; label: string; code: string }> = [
  {
    id: 'flowchart',
    label: 'Flowchart',
    code: `flowchart TD
    A[Idea] --> B{Worth doing?}
    B -- Yes --> C[Plan it]
    B -- No --> D[Park it]
    C --> E[Ship it]`,
  },
  {
    id: 'sequence',
    label: 'Sequence',
    code: `sequenceDiagram
    participant U as User
    participant A as App
    participant S as Server
    U->>A: Opens a note
    A->>S: GET /note
    S-->>A: Note content
    A-->>U: Rendered note`,
  },
  {
    id: 'mindmap',
    label: 'Mind map',
    code: `mindmap
  root((Topic))
    Research
      Articles
      Interviews
    Ideas
      Quick wins
      Long shots
    Next steps`,
  },
  {
    id: 'class',
    label: 'Class',
    code: `classDiagram
    class Note {
      +String title
      +String content
      +save()
    }
    class Folder {
      +String name
    }
    Folder "1" --> "*" Note : contains`,
  },
  {
    id: 'state',
    label: 'State',
    code: `stateDiagram-v2
    [*] --> Draft
    Draft --> Review : submit
    Review --> Draft : changes requested
    Review --> Published : approve
    Published --> [*]`,
  },
  {
    id: 'er',
    label: 'Entity relationship',
    code: `erDiagram
    CUSTOMER ||--o{ ORDER : places
    ORDER ||--|{ LINE_ITEM : contains
    PRODUCT ||--o{ LINE_ITEM : "appears in"`,
  },
  {
    id: 'gantt',
    label: 'Gantt',
    code: `gantt
    title Project plan
    dateFormat YYYY-MM-DD
    section Discovery
    Research        :a1, 2026-01-05, 7d
    Interviews      :after a1, 5d
    section Build
    Prototype       :2026-01-19, 10d
    Launch          :milestone, 2026-02-02, 0d`,
  },
  {
    id: 'timeline',
    label: 'Timeline',
    code: `timeline
    title Milestones
    2024 : Started the project
    2025 : First release
         : 1,000 users
    2026 : Version 2`,
  },
  {
    id: 'pie',
    label: 'Pie',
    code: `pie title Where the time goes
    "Writing" : 45
    "Research" : 30
    "Meetings" : 25`,
  },
  {
    id: 'journey',
    label: 'User journey',
    code: `journey
    title Morning routine
    section Wake up
      Alarm: 2: Me
      Coffee: 5: Me
    section Work
      Inbox: 3: Me
      Deep work: 5: Me`,
  },
  {
    id: 'quadrant',
    label: 'Quadrant',
    code: `quadrantChart
    title Effort vs impact
    x-axis Low effort --> High effort
    y-axis Low impact --> High impact
    quadrant-1 Plan carefully
    quadrant-2 Do now
    quadrant-3 Maybe later
    quadrant-4 Skip
    Idea A: [0.3, 0.8]
    Idea B: [0.7, 0.6]
    Idea C: [0.2, 0.2]`,
  },
  {
    id: 'git',
    label: 'Git graph',
    code: `gitGraph
    commit
    branch feature
    checkout feature
    commit
    commit
    checkout main
    merge feature
    commit`,
  },
];
