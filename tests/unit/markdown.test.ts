// @vitest-environment jsdom
/**
 * Markdown rendering (src/lib/markdown.ts): what notes may contain once rendered. A note can come from
 * an imported file or a restored backup, so nothing in it may run script or reach outside the note.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { extractHeadings, renderMarkdown, renderMath } from '../../src/lib/markdown';
import { loadExtras } from '../../src/lib/renderExtras';
import { escapeHtml, safeName, snippetToHtml } from '../../src/lib/utils';

// KaTeX and highlight.js load on demand (src/lib/renderExtras.ts); these tests need them in.
beforeAll(() => loadExtras());

const render = (md: string) => {
  const html = renderMarkdown(md);
  const div = document.createElement('div');
  div.innerHTML = html;
  return { html, div };
};

describe('sanitising', () => {
  const payloads = [
    '<script>alert(1)</script>',
    '<img src=x onerror=alert(1)>',
    '<svg><script>alert(1)</script></svg>',
    '<svg onload=alert(1)></svg>',
    '<iframe src="https://evil.example"></iframe>',
    '<object data="x"></object><embed src="x">',
    '<form action="https://evil.example"><button>go</button></form>',
    '<meta http-equiv="refresh" content="0;url=https://evil.example">',
    '<base href="https://evil.example/">',
    '<link rel="stylesheet" href="https://evil.example/x.css">',
    '<style>body{display:none}</style>',
    '<a href="javascript:alert(1)">x</a>',
    '[x](javascript:alert(1))',
    '[x](vbscript:msgbox(1))',
    '[x](data:text/html,<script>alert(1)</script>)',
    '<a href="&#106;avascript:alert(1)">x</a>',
    '<math><maction actiontype="statusline" xlink:href="javascript:alert(1)">x</maction></math>',
    '<svg><a xlink:href="javascript:alert(1)"><text>x</text></a></svg>',
    '<svg><use href="data:image/svg+xml,<svg id=x onload=alert(1)>#x"/></svg>',
    '<details open ontoggle=alert(1)>',
    '<input autofocus onfocus=alert(1)>',
  ];
  for (const p of payloads) {
    it(`neutralises ${p.slice(0, 60)}`, () => {
      const { div } = render(p);
      for (const el of div.querySelectorAll('*')) {
        for (const attr of el.getAttributeNames()) {
          expect(attr.startsWith('on'), `${el.tagName} ${attr}`).toBe(false);
          expect(el.getAttribute(attr) ?? '', `${el.tagName} ${attr}`).not.toMatch(/^\s*(javascript|vbscript|data:text\/html)/i);
        }
      }
      expect(div.querySelector('script, iframe, object, embed, form, meta, base, link, style, use')).toBeNull();
    });
  }

  it('opens outside links safely', () => {
    const { div } = render('[site](https://example.com)');
    const a = div.querySelector('a')!;
    expect(a.getAttribute('href')).toBe('https://example.com');
    if (a.getAttribute('target') === '_blank') expect(a.getAttribute('rel') ?? '').toMatch(/noopener/);
  });

  it('escapes code and keeps it as text', () => {
    const { div } = render('```html\n<script>alert(1)</script>\n```\n\n`<img src=x onerror=alert(1)>`');
    expect(div.querySelector('script, img')).toBeNull();
    expect(div.textContent).toContain('<script>alert(1)</script>');
  });

  it('typesets math without letting TeX add links or HTML', () => {
    for (const tex of ['\\href{javascript:alert(1)}{x}', '\\url{javascript:alert(1)}', '\\htmlClass{x}{y}', '\\includegraphics{https://evil/x.png}']) {
      // With trust off, KaTeX shows these as an error (the TeX as text), never as a link or image.
      const div = document.createElement('div');
      div.innerHTML = renderMath(tex, false);
      expect(div.querySelector('a, img, [href], [src]'), tex).toBeNull();
      expect(div.innerHTML).not.toMatch(/="\s*javascript:/i);
    }
    expect(renderMath('x^2', false)).toContain('katex');
  });
});

describe('the app’s own controls', () => {
  const forged = [
    '<input type="checkbox" class="kb-task-box" data-task-line="0">',
    '<div class="kb-mermaid" data-src="x" data-line="0" data-line-end="99"><button data-action="edit-mermaid">Edit</button></div>',
    '<a href="#" data-wikilink-new="Planted note">make a note</a>',
    '<span class="kb-drawing" data-drawing-id="abcdef1"><button data-action="edit-drawing" data-drawing-id="abcdef1">Edit</button></span>',
    '<span data-kb="0123456789abcdef01234567" data-action="edit-mermaid">guessing the stamp</span>',
  ];

  it('can’t be imitated by HTML written in a note', () => {
    const { div } = render(forged.join('\n\n'));
    expect(div.querySelector('[data-action], [data-task-line], [data-wikilink-new], [data-drawing-id], [data-src], [data-line-end]')).toBeNull();
    expect(div.querySelector('.kb-task-box, .kb-mermaid, .kb-drawing')).toBeNull();
  });

  it('still work when the note itself makes them', () => {
    const { div, html } = render('- [ ] task\n\n```mermaid\ngraph TD\n```\n\n```js\nx\n```\n\n[[Missing note]]\n\n![d](/api/drawings/abcdef1.svg)');
    expect(div.querySelector('input.kb-task-box[data-task-line]')).not.toBeNull();
    expect(div.querySelector('.kb-mermaid[data-src][data-line-end]')).not.toBeNull();
    expect(div.querySelector('button[data-action="copy-code"]')).not.toBeNull();
    expect(div.querySelector('a[data-wikilink-new="Missing note"]')).not.toBeNull();
    expect(div.querySelector('.kb-drawing[data-drawing-id] button[data-action="edit-drawing"]')).not.toBeNull();
    // The stamp never reaches the page, so a note can't copy it from an earlier render.
    expect(html).not.toContain('data-kb');
  });

  it('keeps note HTML from pinning itself over the app', () => {
    const { div } = render('<div style="position: fixed; inset: 0; z-index: 99">cover</div>\n\n<p style="position:sticky;top:0;color:red">x</p>\n\n<span style="position:absolute;left:0">ok</span>');
    const byText = (text: string) => [...div.querySelectorAll<HTMLElement>('*')].find((el) => el.textContent === text && el.children.length === 0)!;
    const [fixed, sticky, absolute] = [byText('cover'), byText('x'), byText('ok')];
    expect(fixed.style.position).toBe('');
    expect(sticky.style.position).toBe('');
    expect(sticky.style.color).toBe('red');
    expect(absolute.style.position).toBe('absolute');
  });
});

describe('images from other websites', () => {
  const md = '![chart](https://img.example/chart.png)\n\n![mine](/api/files/abcdef12/p.png)\n\n<div style="background-image:url(https://img.example/bg.png);color:red">bg</div>\n\n<video poster="https://img.example/p.jpg" src="/api/files/abcdef12/v.mp4"></video>';

  it('are held back as click-to-load boxes when Settings say ask first', async () => {
    const { renderMarkdown } = await import('../../src/lib/markdown');
    const div = document.createElement('div');
    div.innerHTML = renderMarkdown(md, {}, { remoteImages: 'ask' });
    const held = div.querySelector<HTMLImageElement>('img.kb-remote')!;
    expect(held.getAttribute('src')).toBeNull();
    expect(held.dataset.remoteSrc).toBe('https://img.example/chart.png');
    expect(held.alt).toContain('img.example');
    expect(div.querySelector('img[src="/api/files/abcdef12/p.png"]')).not.toBeNull();
    const bg = [...div.querySelectorAll<HTMLElement>('div')].find((d) => d.textContent === 'bg')!;
    expect(bg.style.backgroundImage).toBe('');
    expect(bg.style.color).toBe('red');
    expect(div.querySelector('video')!.getAttribute('poster')).toBeNull();
  });

  it('load as before by default, and once allowed', async () => {
    const { allowRemote, renderMarkdown } = await import('../../src/lib/markdown');
    const div = document.createElement('div');
    div.innerHTML = renderMarkdown(md);
    expect(div.querySelector('img[src="https://img.example/chart.png"]')).not.toBeNull();
    allowRemote('https://img.example/chart.png');
    div.innerHTML = renderMarkdown(md, {}, { remoteImages: 'ask' });
    expect(div.querySelector('img[src="https://img.example/chart.png"]')).not.toBeNull();
  });
});

describe('diagram output', () => {
  it('loses form controls and any stylesheet but its own', async () => {
    const { sanitizeDiagram } = await import('../../src/lib/mermaid');
    const svg = `<svg id="kbm-1" xmlns="http://www.w3.org/2000/svg"><style>#kbm-1 .node{fill:red}</style><g><foreignObject width="10" height="10"><div xmlns="http://www.w3.org/1999/xhtml"><span>Label</span><form action="https://evil.example"><input name="p"><button>Go</button></form><style>input{background:url(https://evil.example/x)}</style></div></foreignObject></g></svg>`;
    const div = document.createElement('div');
    div.innerHTML = sanitizeDiagram(svg, 'kbm-1');
    expect(div.textContent).toContain('Label');
    expect(div.querySelector('form, input, button')).toBeNull();
    expect(div.querySelectorAll('style')).toHaveLength(1);
    expect(div.querySelector('style')!.parentElement!.tagName.toLowerCase()).toBe('svg');
  });
});

describe('rendering', () => {
  it('renders tasks, callouts, wiki links and tables', () => {
    const { div } = render('- [x] done\n- [ ] todo\n\n> [!tip] Hint\n> body\n\n[[Other note]]\n\n| a | b |\n|---|---|\n| 1 | 2 |');
    expect(div.querySelectorAll('input[type=checkbox]')).toHaveLength(2);
    expect(div.querySelector('table')).not.toBeNull();
    expect(div.textContent).toContain('Other note');
  });

  it('lists headings for the outline', () => {
    const headings = extractHeadings('# One\n\ntext\n\n## Two `code`\n\n```\n# not a heading\n```');
    expect(headings.map((h) => h.text)).toEqual(['One', 'Two code']);
  });
});

describe('helpers that build HTML or file names', () => {
  it('escapes HTML', () => {
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe('&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;');
  });

  it('turns search snippets into safe HTML, highlighting only the markers', () => {
    const html = snippetToHtml('before \u0001<img src=x onerror=alert(1)>\u0002 after');
    const div = document.createElement('div');
    div.innerHTML = html;
    expect(div.querySelector('img')).toBeNull();
    expect(div.querySelector('mark')?.textContent).toBe('<img src=x onerror=alert(1)>');
  });

  it('never makes a path step out of a name in a backup', () => {
    expect(safeName('..')).toBe('Untitled');
    expect(safeName('...', 'Folder')).toBe('Folder');
    expect(safeName('a/b:c')).toBe('a b c');
    expect(safeName('.hidden')).toBe('.hidden');
  });
});
