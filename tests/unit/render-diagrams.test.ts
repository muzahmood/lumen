// @vitest-environment jsdom
/**
 * Mermaid diagrams (src/lib/mermaid.ts). Mermaid itself needs a real layout engine, so it's replaced
 * here by a stand-in that returns whatever SVG a test gives it: what's under test is what Lumen does
 * with that output (cleaning it with its own rules, caching, filling in reading view's placeholders).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let svgFor: (id: string, source: string) => string = (id) => `<svg id="${id}" xmlns="http://www.w3.org/2000/svg"><g><text>ok</text></g></svg>`;
const renderCalls: string[] = [];

vi.mock('mermaid', () => ({
  default: {
    initialize: () => {},
    render: async (id: string, source: string) => {
      renderCalls.push(source);
      if (source.includes('syntax error')) throw new Error('Parse error on line 2:\n<img src=x onerror=alert(1)>');
      return { svg: svgFor(id, source) };
    },
  },
}));

// The app-wide sanitizer rules (markdown.ts) are always loaded alongside diagrams in the app.
import { renderMarkdown } from '../../src/lib/markdown';
import { decodeMermaidSource, hydrateMermaid, renderMermaid, sanitizeDiagram } from '../../src/lib/mermaid';
import { useSettings } from '../../src/lib/settings';

let unique = 0;
/** A diagram source no earlier test rendered (renderMermaid caches by source). */
const fresh = (body = 'graph TD\n  A --> B') => `${body}\n%% ${++unique}`;

beforeEach(() => {
  renderCalls.length = 0;
  svgFor = (id) => `<svg id="${id}" xmlns="http://www.w3.org/2000/svg"><g><text>ok</text></g></svg>`;
});

afterEach(() => {
  useSettings.setState({ remoteImages: 'load' });
});

const CSS = `#kbm-1 .node rect{fill:red}
#kbm-10 .x{color:blue}
body{display:none}
#kbm-1 .a, .b{color:green}
:root{--mermaid-font-family:Geist}
:root{--x:1;color:red}
@media (min-width:1px){#kbm-1 .m{color:pink} .outside{color:black}}
@keyframes dash{to{stroke-dashoffset:0}}
@import url(https://evil.example/x.css);
@font-face{font-family:x;src:url(https://evil.example/f.woff)}`;

describe('cleaning a diagram', () => {
  it('keeps labels, and drops script, handlers and script links', () => {
    const svg = `<svg id="kbm-1" xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script><g onclick="alert(1)"><foreignObject width="9" height="9"><div xmlns="http://www.w3.org/1999/xhtml"><span onmouseover="x()">Label <b>bold</b></span><a href="javascript:alert(1)">l</a><iframe src="https://evil.example"></iframe></div></foreignObject><a href="javascript:alert(2)"><text>t</text></a></g></svg>`;
    const div = document.createElement('div');
    div.innerHTML = sanitizeDiagram(svg, 'kbm-1');
    expect(div.textContent).toContain('Label bold');
    expect(div.querySelector('foreignObject b, foreignobject b')).not.toBeNull();
    expect(div.querySelector('script, iframe')).toBeNull();
    for (const el of div.querySelectorAll('*')) {
      for (const name of el.getAttributeNames()) {
        expect(name.startsWith('on'), `${el.tagName} ${name}`).toBe(false);
        expect(el.getAttribute(name), `${el.tagName} ${name}`).not.toMatch(/javascript:/i);
      }
    }
  });

  it('keeps only its own stylesheet’s rules for this diagram, its font variables and animations', () => {
    const div = document.createElement('div');
    div.innerHTML = sanitizeDiagram(`<svg id="kbm-1" xmlns="http://www.w3.org/2000/svg"><style>${CSS}</style><g><style>body{display:none}</style></g></svg>`, 'kbm-1');
    const styles = div.querySelectorAll('style');
    expect(styles).toHaveLength(1);
    const css = styles[0].textContent!;
    expect(css).toContain('#kbm-1 .node rect');
    expect(css).toContain('--mermaid-font-family');
    expect(css).toMatch(/@keyframes dash/);
    expect(css).toMatch(/@media[^{]*\{#kbm-1 \.m/);
    for (const gone of ['#kbm-10', 'body', '.b{', '.b {', '--x', '.outside', '@import', '@font-face', 'evil.example']) expect(css, gone).not.toContain(gone);
  });

  it('can’t pin anything over the app through a style attribute', () => {
    const div = document.createElement('div');
    div.innerHTML = sanitizeDiagram(`<svg id="kbm-1" xmlns="http://www.w3.org/2000/svg"><g style="position:fixed;inset:0;fill:red"><rect/></g></svg>`, 'kbm-1');
    const g = div.querySelector<SVGGElement>('g')!;
    expect(g.style.position).toBe('');
    expect(g.style.fill).toBe('red');
  });

  it('can’t pin anything over the app through its stylesheet', () => {
    const css = '#kbm-1{position:fixed;inset:0;z-index:99999;width:100vw;height:100vh;background:#fff}\n#kbm-1 .cover > *{position:fixed !important;inset:0}\n#kbm-1 .stick{position:sticky;top:0}';
    const div = document.createElement('div');
    div.innerHTML = sanitizeDiagram(`<svg id="kbm-1" xmlns="http://www.w3.org/2000/svg"><style>${css}</style><g class="cover"><rect/></g></svg>`, 'kbm-1');
    const kept = div.querySelector('style')?.textContent ?? '';
    expect(kept).not.toMatch(/position\s*:\s*(fixed|sticky)/i);
  });

  it('can’t pin anything over the app with a variable, or open anything in the top layer', () => {
    const css = '#kbm-1{--p:fixed;position:var(--p);inset:0}\n#kbm-1 .ok{position:relative}';
    const div = document.createElement('div');
    div.innerHTML = sanitizeDiagram(
      `<svg id="kbm-1" xmlns="http://www.w3.org/2000/svg"><style>${css}</style><g style="position:var(--p)"><foreignObject><div xmlns="http://www.w3.org/1999/xhtml"><span popover="">x</span><dialog open="">y</dialog></div></foreignObject></g></svg>`,
      'kbm-1',
    );
    const kept = div.querySelector('style')?.textContent ?? '';
    expect(kept).not.toMatch(/position\s*:\s*var/i);
    expect(kept).toMatch(/position\s*:\s*relative/);
    expect(div.querySelector<SVGGElement>('g')!.style.position).toBe('');
    expect(div.querySelector('[popover], dialog')).toBeNull();
  });
});

describe('drawing a diagram', () => {
  it('cleans what Mermaid returns, and draws each source once per theme', async () => {
    svgFor = (id) => `<svg id="${id}" xmlns="http://www.w3.org/2000/svg"><g onclick="alert(1)"><text>A</text></g></svg>`;
    const source = fresh();
    const first = await renderMermaid(source, 'light');
    expect(first).not.toContain('onclick');
    expect(first).toContain('<text>A</text>');
    expect(await renderMermaid(source, 'light')).toBe(first);
    expect(renderCalls).toEqual([source]);
    await renderMermaid(source, 'dark');
    expect(renderCalls).toEqual([source, source]);
  });

  it('draws one diagram at a time, and a failure doesn’t hold up the next', async () => {
    const [a, broken, b] = [fresh(), fresh('graph TD\nsyntax error'), fresh()];
    const results = await Promise.allSettled([renderMermaid(a, 'light'), renderMermaid(broken, 'light'), renderMermaid(b, 'light')]);
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'rejected', 'fulfilled']);
    expect(renderCalls).toEqual([a, broken, b]);
  });

  it('loads nothing from other websites when Settings say ask first', async () => {
    useSettings.setState({ remoteImages: 'ask' });
    svgFor = (id) =>
      `<svg id="${id}" xmlns="http://www.w3.org/2000/svg"><style>#${id} .bg{background:url(https://evil.example/bg.png)}</style><g><image href="https://evil.example/node.png" width="9" height="9"/><foreignObject width="9" height="9"><div xmlns="http://www.w3.org/1999/xhtml"><img src="https://evil.example/label.png"/></div></foreignObject></g></svg>`;
    const svg = await renderMermaid(fresh(), 'light');
    expect(svg).not.toMatch(/https:\/\/evil\.example/);
  });

  it('when asked first, also catches addresses written to slip past a pattern: escapes, /\\host, srcset', async () => {
    useSettings.setState({ remoteImages: 'ask' });
    svgFor = (id) =>
      `<svg id="${id}" xmlns="http://www.w3.org/2000/svg"><style>#${id} .bg{background:u\\72 l(//evil.example/esc.png)} #${id} .ok{fill:red}</style><g style="background:u\\72 l(//evil.example/inline.png)"><foreignObject width="9" height="9"><div xmlns="http://www.w3.org/1999/xhtml"><img srcset="/\\evil.example/s.png"/><span style="background-image:url('/\\\\evil.example/t.png')">x</span></div></foreignObject></g></svg>`;
    const svg = await renderMermaid(fresh(), 'light');
    expect(svg).not.toMatch(/evil\.example/);
    expect(svg).toMatch(/fill:\s*red/);
  });
});

describe('reading view’s diagram placeholders', () => {
  function placeholders(md: string) {
    const root = document.createElement('article');
    root.innerHTML = renderMarkdown(md);
    document.body.appendChild(root);
    return root;
  }

  it('fill in with the drawing and an Edit button, and aren’t drawn again unchanged', async () => {
    const source = fresh();
    const root = placeholders(`\`\`\`mermaid\n${source}\n\`\`\``);
    const block = root.querySelector<HTMLElement>('.kb-mermaid')!;
    expect(decodeMermaidSource(block.dataset.src!)).toBe(`${source}\n`);
    await hydrateMermaid(root, 'light');
    expect(block.querySelector('.kb-mermaid-svg[data-action="zoom-diagram"] svg')).not.toBeNull();
    expect(block.querySelector('button[data-action="edit-mermaid"]')).not.toBeNull();
    expect(block.querySelector('pre')).toBeNull();
    const svg = block.querySelector('svg');
    await hydrateMermaid(root, 'light');
    expect(block.querySelector('svg')).toBe(svg);
    root.remove();
  });

  it('show a syntax error as text, with the code and a Fix button', async () => {
    const source = fresh('graph TD\nsyntax error <b>here</b>');
    const root = placeholders(`\`\`\`mermaid\n${source}\n\`\`\``);
    await hydrateMermaid(root, 'light');
    const block = root.querySelector<HTMLElement>('.kb-mermaid')!;
    expect(block.classList.contains('is-error')).toBe(true);
    expect(block.querySelector('.kb-mermaid-error')!.textContent).toContain('<img src=x onerror=alert(1)>');
    expect(block.querySelector('img, b')).toBeNull();
    expect(block.querySelector('pre.kb-mermaid-pending')!.textContent).toBe(`${source}\n`);
    expect(block.querySelector('button[data-action="edit-mermaid"]')!.textContent).toBe('Fix diagram');
    root.remove();
  });

  it('come from the note’s own fences only, never from HTML written to look like one', async () => {
    const source = fresh();
    const root = placeholders(`<div class="kb-mermaid" data-src="${encodeURIComponent(source)}">x</div>`);
    await hydrateMermaid(root, 'light');
    expect(renderCalls).toEqual([]);
    root.remove();
  });
});
