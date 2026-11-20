// @vitest-environment jsdom
/**
 * Reading view (src/lib/markdown.ts): every piece of syntax the README lists, rendered as promised,
 * including nesting and the awkward cases (a price that isn't math, a pipe inside code in a table,
 * a task after front matter or a code fence). Sanitising lives in render-hostile.test.ts.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { extractHeadings, renderMarkdown, type RenderEnv } from '../../src/lib/markdown';
import { decodeMermaidSource } from '../../src/lib/mermaid';
import { loadExtras } from '../../src/lib/renderExtras';

// KaTeX and highlight.js load on demand (src/lib/renderExtras.ts); these tests need them in.
beforeAll(() => loadExtras());

function render(src: string, env: RenderEnv = {}, opts: Parameters<typeof renderMarkdown>[2] = {}) {
  const html = renderMarkdown(src, env, opts);
  const div = document.createElement('div');
  div.innerHTML = html;
  return { html, div };
}

const text = (el: Element | null | undefined) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim();

describe('callouts', () => {
  it('take their kind and title from the first line, and the rest becomes the body', () => {
    const { div } = render('> [!warning] Mind the gap\n> Between the train and the platform.');
    const box = div.querySelector('blockquote.kb-callout')!;
    expect(box.getAttribute('data-callout')).toBe('warning');
    expect(text(box.querySelector('.kb-callout-title'))).toBe('Mind the gap');
    expect(box.querySelector('.kb-callout-title svg.kb-callout-icon')).not.toBeNull();
    const body = box.querySelectorAll('p');
    expect(body).toHaveLength(1);
    expect(text(body[0])).toBe('Between the train and the platform.');
  });

  it('use the type as the title when there is none, and group aliases under one look', () => {
    const cases: Array<[string, string, string]> = [
      ['> [!faq]\n> Why?', 'question', 'Faq'],
      ['> [!TIP]\n> Shout', 'tip', 'Tip'],
      ['> [!done]\n> Yes', 'success', 'Done'],
      ['> [!bug]\n> Oops', 'danger', 'Bug'],
      ['> [!tldr]\n> Short', 'abstract', 'Tldr'],
      ['> [!my-own-kind]\n> Hm', 'note', 'My-own-kind'],
    ];
    for (const [src, kind, title] of cases) {
      const { div } = render(src);
      const box = div.querySelector('.kb-callout')!;
      expect(box?.getAttribute('data-callout'), src).toBe(kind);
      expect(text(box.querySelector('.kb-callout-title')), src).toBe(title);
    }
  });

  it('leave a fold marker out of the title', () => {
    for (const marker of ['-', '+']) {
      const { div } = render(`> [!tip]${marker} Fold me\n> Inside`);
      expect(text(div.querySelector('.kb-callout-title'))).toBe('Fold me');
    }
  });

  it('hold nested lists, tasks and code, each task carrying its own line', () => {
    const src = ['> [!note] Plan', '> - one', '>   - nested', '> - [ ] call Sam', '>', '> ```js', '> const a = 1;', '> ```'].join('\n');
    const { div } = render(src);
    const box = div.querySelector('blockquote.kb-callout')!;
    expect(box.querySelector('ul > li > ul > li')?.textContent).toBe('nested');
    const taskBox = box.querySelector<HTMLInputElement>('input.kb-task-box')!;
    expect(taskBox.dataset.taskLine).toBe('3');
    expect(box.querySelector('.kb-code code.language-js')?.textContent).toContain('const a = 1;');
    // Nothing of the body leaks into the title.
    expect(text(box.querySelector('.kb-callout-title'))).toBe('Plan');
  });

  it('nest inside one another', () => {
    const { div } = render('> [!note]\n> > [!warning] Inner\n> > Careful');
    const outer = div.querySelector('blockquote.kb-callout')!;
    const inner = outer.querySelector('blockquote.kb-callout')!;
    expect(outer.getAttribute('data-callout')).toBe('note');
    expect(inner.getAttribute('data-callout')).toBe('warning');
    expect(text(inner.querySelector('.kb-callout-title'))).toBe('Inner');
    expect(text(inner.querySelector('p'))).toBe('Careful');
  });

  it('show the title as text, never as HTML', () => {
    const { div } = render('> [!note] <img src=x onerror=alert(1)> & <b>co</b>\n> body');
    const title = div.querySelector('.kb-callout-title span')!;
    expect(title.textContent).toBe('<img src=x onerror=alert(1)> & <b>co</b>');
    expect(div.querySelector('img, b')).toBeNull();
  });

  it('only start on the first line of a quote', () => {
    const { div } = render('> Just a quote\n> [!tip] said later');
    expect(div.querySelector('.kb-callout')).toBeNull();
    expect(div.querySelector('blockquote')!.textContent).toContain('[!tip] said later');
  });
});

describe('highlights', () => {
  it('mark ==text==, with formatting inside', () => {
    const { div } = render('Some ==very **important** words== here.');
    const mark = div.querySelector('mark')!;
    expect(text(mark)).toBe('very important words');
    expect(mark.querySelector('strong')?.textContent).toBe('important');
  });

  it('leave code, empty pairs and escaped markers as written', () => {
    const { div } = render('`==not==` and ==== too');
    expect(div.querySelectorAll('mark')).toHaveLength(0);
    expect(div.querySelector('code')!.textContent).toBe('==not==');
    expect(render('\\==plain== too').div.querySelector('mark')).toBeNull();
  });

  it('do not reach across lines', () => {
    const { div } = render('==start\nend==');
    expect(div.querySelector('mark')).toBeNull();
  });

  it('close at the right ==, skipping code spans and escaped markers', () => {
    const { div } = render('==Always use `a === b`, never `a == b`== here');
    const mark = div.querySelector('mark');
    expect(mark).not.toBeNull();
    expect([...mark!.querySelectorAll('code')].map((c) => c.textContent)).toEqual(['a === b', 'a == b']);
    expect(div.textContent).not.toContain('`');
    const escaped = render('\\==plain== and ==real==').div;
    expect([...escaped.querySelectorAll('mark')].map((m) => m.textContent)).toEqual(['real']);
  });
});

describe('tables', () => {
  it('render with their alignment, inside a scrolling wrapper', () => {
    const { div } = render('| Left | Middle | Right |\n|:-----|:------:|------:|\n| a | **b** | `c` |');
    const table = div.querySelector('.kb-table-wrap > table')!;
    const heads = [...table.querySelectorAll('th')].map((th) => th.getAttribute('style'));
    expect(heads).toEqual([expect.stringContaining('left'), expect.stringContaining('center'), expect.stringContaining('right')]);
    const cells = table.querySelectorAll('td');
    expect(cells[1].querySelector('strong')?.textContent).toBe('b');
    expect(cells[2].querySelector('code')?.textContent).toBe('c');
  });

  it('keep an escaped pipe inside code or a link alias in its cell', () => {
    const env: RenderEnv = { resolveTitle: (t) => (t === 'Budget' ? 'budget12345' : null) };
    const { div } = render('| Expr | Link |\n|---|---|\n| `a \\|\\| b` | [[Budget\\|the budget]] |', env);
    const cells = div.querySelectorAll('tbody td');
    expect(cells).toHaveLength(2);
    expect(cells[0].querySelector('code')!.textContent).toBe('a || b');
    const link = cells[1].querySelector('a.kb-wikilink')!;
    expect(link.textContent).toBe('the budget');
    expect(link.getAttribute('href')).toBe('/note/budget12345');
  });

  it('carry the line each part starts on, for scrolling the two views together', () => {
    const { div } = render('Intro\n\n| a | b |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |');
    expect(div.querySelector('table')!.getAttribute('data-line')).toBe('2');
    expect([...div.querySelectorAll('tbody tr')].map((tr) => tr.getAttribute('data-line'))).toEqual(['4', '5']);
  });
});

describe('footnotes', () => {
  it('link each reference to its note and back', () => {
    const { div } = render('Claim[^src] and another[^2].\n\n[^src]: The source.\n[^2]: Second.');
    const refs = [...div.querySelectorAll<HTMLAnchorElement>('sup.footnote-ref a')];
    expect(refs.map((a) => a.textContent)).toEqual(['[1]', '[2]']);
    for (const a of refs) {
      const target = div.querySelector(`[id="${a.getAttribute('href')!.slice(1)}"]`)!;
      expect(target).not.toBeNull();
      const back = target.querySelector<HTMLAnchorElement>('a.footnote-backref')!;
      expect(div.querySelector(`[id="${back.getAttribute('href')!.slice(1)}"]`)).toBe(a);
    }
    expect(text(div.querySelector('section.footnotes li'))).toContain('The source.');
  });

  it('leave a reference with no note as plain text', () => {
    const { div } = render('Nothing here[^missing].');
    expect(div.querySelector('sup')).toBeNull();
    expect(div.textContent).toContain('[^missing]');
  });
});

describe('code blocks', () => {
  it('are highlighted for known languages, labelled, and copyable', () => {
    const { div } = render('```TypeScript\nconst a: string = "<b>";\n```');
    const block = div.querySelector('.kb-code')!;
    expect(block.querySelector('.kb-code-bar span')!.textContent).toBe('typescript');
    expect(block.querySelector('button[data-action="copy-code"]')).not.toBeNull();
    const code = block.querySelector('code')!;
    expect(code.className).toBe('hljs language-typescript');
    expect(code.querySelector('.hljs-keyword')?.textContent).toBe('const');
    expect(code.textContent).toBe('const a: string = "<b>";\n');
    expect(code.querySelector('b')).toBeNull();
  });

  it('show unknown languages and plain fences as escaped text', () => {
    const { div } = render('```nosuchlang\n<i>x</i>\n```\n\n~~~\n<i>y</i>\n~~~');
    const [unknown, plain] = div.querySelectorAll('.kb-code');
    expect(unknown.querySelector('.kb-code-bar span')!.textContent).toBe('nosuchlang');
    expect(unknown.querySelector('code')!.textContent).toBe('<i>x</i>\n');
    expect(plain.querySelector('.kb-code-bar span')!.textContent).toBe('text');
    expect(plain.querySelector('code')!.className).toBe('hljs');
    expect(div.querySelector('i')).toBeNull();
  });

  it('keep an odd info string inside the class attribute', () => {
    const { div } = render('```x"onmouseover="alert(1)\ncode\n```');
    const code = div.querySelector('code')!;
    expect(code.getAttribute('onmouseover')).toBeNull();
    expect(code.getAttributeNames().sort()).toEqual(['class']);
  });

  it('carry the line they start on, for scrolling the two views together', () => {
    const { div } = render('Intro\n\n```js\na\nb\n```\nafter');
    expect(div.querySelector('.kb-code')!.getAttribute('data-line')).toBe('2');
  });
});

describe('math', () => {
  it('typesets $inline$, $$display$$ and ```math blocks', () => {
    const { div } = render('Area $\\pi r^2$ here.\n\n$$\n\\int_0^1 x\\,dx\n$$\n\n```math\na^2 + b^2 = c^2\n```');
    expect(div.querySelectorAll('p > .katex')).toHaveLength(1);
    const blocks = div.querySelectorAll('.katex-block .katex-display');
    expect(blocks).toHaveLength(2);
    expect(div.querySelector('.katex-block annotation, .katex-block math')?.textContent).toContain('\\int_0^1');
    expect(div.querySelector('pre, code')).toBeNull();
  });

  it('leaves prices, escaped dollars and code alone', () => {
    const cases = [
      'It costs $5 and $6 today.',
      'Between $5-$10 or $20.',
      'Literally \\$x\\$ here.',
      'In code: `$x$` and `$$y$$`.',
      'Pay $5, get $5.',
    ];
    for (const src of cases) {
      const { div } = render(src);
      expect(div.querySelector('.katex'), src).toBeNull();
    }
    expect(render('Literally \\$x\\$ here.').div.textContent).toContain('$x$');
    expect(render('In code: `$x$`').div.querySelector('code')!.textContent).toBe('$x$');
  });

  it('leaves $$ inside a fenced code block as code', () => {
    const { div } = render('```\n$$\nx\n$$\n```');
    expect(div.querySelector('.katex')).toBeNull();
    expect(div.querySelector('code')!.textContent).toBe('$$\nx\n$$\n');
  });

  it('shows broken TeX as an error in place instead of failing the note', () => {
    const { div } = render('Before $\\frac{1}{$ after\n\n$$\n\\badcommand{x}\n$$\n\nStill here.');
    expect(div.textContent).toContain('Still here.');
    expect(div.querySelector('.katex-error')).not.toBeNull();
  });
});

describe('diagrams', () => {
  it('become placeholders holding their code and the lines they span', () => {
    const code = 'graph TD\n  A["a < b & c"] --> B\n';
    const { div } = render(`Intro\n\n\`\`\`mermaid\n${code}\`\`\`\n\nAfter`);
    const block = div.querySelector<HTMLElement>('.kb-mermaid')!;
    expect(decodeMermaidSource(block.dataset.src!)).toBe(code);
    expect(block.dataset.line).toBe('2');
    expect(block.dataset.lineEnd).toBe('6');
    // Shown as text until it draws.
    expect(block.querySelector('pre.kb-mermaid-pending')!.textContent).toBe(code);
  });

  it('are recognised with tildes and in any case', () => {
    const { div } = render('~~~Mermaid\npie\n~~~');
    expect(div.querySelector('.kb-mermaid')).not.toBeNull();
    expect(div.querySelector('.kb-code')).toBeNull();
  });
});

describe('task checkboxes', () => {
  /** Every box's line, checked against the source: the line must hold a task, ticked as the box is. */
  function boxesMatchSource(src: string) {
    const { div } = render(src);
    const lines = src.split('\n');
    const boxes = [...div.querySelectorAll<HTMLInputElement>('input.kb-task-box')];
    for (const box of boxes) {
      const line = lines[Number(box.dataset.taskLine)] ?? '';
      const m = /^(?:\s*>)*\s*(?:[-*+]|\d+[.)])\s+\[([ xX])\]/.exec(line.replace(/\r$/, ''));
      expect(m, `box on line ${box.dataset.taskLine}: ${JSON.stringify(line)}`).not.toBeNull();
      expect(box.checked, line).toBe(m![1] !== ' ');
    }
    return boxes;
  }

  it('carry their own line after front matter, code fences, math and diagrams', () => {
    const src = [
      '---',
      'title: Plans',
      'tags: [a, b]',
      '---',
      '- [ ] after front matter',
      '',
      '```',
      '- [ ] inside code: not a task',
      '```',
      '- [x] after a fence',
      '',
      '$$',
      'x',
      '$$',
      '',
      '1. [ ] numbered',
      '2) [X] other numbering',
      '',
      '```mermaid',
      'graph TD',
      '```',
      '',
      '> - [ ] quoted',
      '',
      '<div>html</div>',
      '',
      '* [ ] star',
      '  - [x] nested',
      '    + [ ] deeper',
    ].join('\n');
    const boxes = boxesMatchSource(src);
    expect(boxes.map((b) => Number(b.dataset.taskLine))).toEqual([4, 9, 15, 16, 22, 26, 27, 28]);
  });

  it('count lines the same way with Windows line endings', () => {
    const src = 'Intro\r\n\r\n```\r\ncode\r\n```\r\n- [ ] one\r\n- [x] two\r\n';
    const boxes = boxesMatchSource(src);
    expect(boxes.map((b) => b.dataset.taskLine)).toEqual(['5', '6']);
  });

  it('are made only for list items that start with a box', () => {
    const { div } = render('[ ] not in a list\n\n- text then [ ] box\n- [y] not a box\n- [ ]no space\n\n- item\n\n  [ ] second paragraph');
    expect(div.querySelectorAll('input[type=checkbox]')).toHaveLength(0);
  });

  it('mark their list and item for styling, ticked or not', () => {
    const { div } = render('- [x] done\n- [ ] open\n- plain');
    expect(div.querySelector('ul')!.classList.contains('kb-task-list')).toBe(true);
    const items = div.querySelectorAll('li');
    expect(items[0].className).toBe('kb-task is-done');
    expect(items[1].className).toBe('kb-task');
    expect(items[2].className).toBe('');
    expect(items[0].querySelector('input')!.getAttribute('aria-label')).toBe('Mark task not done');
    expect(text(items[0])).toBe('done');
  });

  it('point at the line the box is on when the item starts on the line before', () => {
    // The list marker is on the line before, so boxesMatchSource's marker check doesn't apply; the
    // reading view ticks the first [ ] on the box's line (NoteView toggleTask).
    const { div } = render('-\n  [ ] task on the next line');
    const boxes = [...div.querySelectorAll<HTMLInputElement>('input.kb-task-box')];
    expect(boxes).toHaveLength(1);
    expect(boxes[0].dataset.taskLine).toBe('1');
  });
});

describe('headings', () => {
  it('get ids from their text, formatting and code included, made unique', () => {
    const { div } = render('# Hello *big* `world`\n\n## Same\n\n## Same\n\n### Café & Crème!');
    expect([...div.querySelectorAll('h1, h2, h3')].map((h) => h.id)).toEqual(['h-hello-big-world', 'h-same', 'h-same-1', 'h-cafe-creme']);
  });

  it('never give two headings the same id', () => {
    const { div } = render('# Step\n\n# Step\n\n# Step 1');
    const ids = [...div.querySelectorAll('h1')].map((h) => h.id);
    expect(new Set(ids).size).toBe(3);
    // The real "Step 1" heading keeps its own anchor, so [[Note#Step 1]] lands on it.
    expect(div.querySelector('h1#h-step-1')!.textContent).toBe('Step 1');
  });

  it('list the outline with levels and lines, skipping code', () => {
    const headings = extractHeadings('Intro\n\n## Two\n\n```\n# not one\n```\n\n#### Four\n\nSetext\n======');
    expect(headings.map(({ level, text: t, line }) => [level, t, line])).toEqual([
      [2, 'Two', 2],
      [4, 'Four', 8],
      [1, 'Setext', 10],
    ]);
  });

  it('keep a linked note’s name in the outline and the id', () => {
    const [h] = extractHeadings('# Meeting with [[Sam]]');
    expect(h.text).toBe('Meeting with Sam');
    const { div } = render('# Meeting with [[Sam]]\n\nSee [[This#Meeting with Sam]].', { resolveTitle: (t) => (t === 'This' ? 'this123456' : null) });
    const link = div.querySelector<HTMLAnchorElement>('a[data-note-id="this123456"]')!;
    expect(div.querySelector('h1')!.id).toBe(link.getAttribute('href')!.split('#')[1]);
  });
});

describe('images, media and drawings', () => {
  it('take a width, or width and height, after a pipe in the alt text', () => {
    const { div } = render('![Chart|300](/api/files/abcdef12/c.png) ![Wide | 640x480](/api/files/abcdef12/w.png "Title")');
    const [a, b] = div.querySelectorAll('img');
    expect([a.alt, a.getAttribute('width'), a.getAttribute('height')]).toEqual(['Chart', '300', null]);
    expect([b.alt, b.getAttribute('width'), b.getAttribute('height'), b.title]).toEqual(['Wide', '640', '480', 'Title']);
    expect(a.getAttribute('loading')).toBe('lazy');
  });

  it('play video and audio inline, by file type', () => {
    const { div } = render('![clip](/api/files/abcdef12/Clip.MP4?x=1) ![memo](/api/files/abcdef12/memo.m4a) ![pic](/api/files/abcdef12/mp4.png)');
    expect(div.querySelector('video.kb-media')!.getAttribute('src')).toBe('/api/files/abcdef12/Clip.MP4?x=1');
    expect(div.querySelector('audio.kb-media')!.getAttribute('src')).toBe('/api/files/abcdef12/memo.m4a');
    expect(div.querySelector('video')!.hasAttribute('controls')).toBe(true);
    expect(div.querySelectorAll('img')).toHaveLength(1);
  });

  it('show drawings at their latest version, with an Edit button', () => {
    const { div } = render('![|200](/api/drawings/draw_123.svg)', { drawingRevs: { draw_123: 7 } });
    const wrap = div.querySelector<HTMLElement>('.kb-drawing')!;
    expect(wrap.dataset.drawingId).toBe('draw_123');
    const img = wrap.querySelector('img')!;
    expect(img.getAttribute('src')).toBe('/api/drawings/draw_123.svg?v=7');
    expect(img.alt).toBe('Drawing');
    expect(img.getAttribute('width')).toBe('200');
    expect(wrap.querySelector<HTMLElement>('button[data-action="edit-drawing"]')!.dataset.drawingId).toBe('draw_123');
  });

  it('attach other files as plain links in this tab', () => {
    const { div } = render('[report.pdf](/api/files/abcdef12/report.pdf)');
    const a = div.querySelector('a')!;
    expect(a.getAttribute('href')).toBe('/api/files/abcdef12/report.pdf');
    expect(a.hasAttribute('target')).toBe(false);
  });

  it('in an encrypted library, name uploads and drawings for decrypting instead of loading them', () => {
    const src = '![p](/api/files/abcdef12/p.png) ![v](/api/files/abcdef12/v.webm) ![d](/api/drawings/abcdef1.svg) ![w](https://img.example/x.png)\n\n<img src="/api/files/abcdef12/raw.png">';
    const { div } = render(src, {}, { assets: 'decrypt' });
    const pending = [...div.querySelectorAll<HTMLElement>('[data-kb-asset]')];
    expect(pending.map((el) => el.dataset.kbAsset)).toEqual([
      '/api/files/abcdef12/p.png',
      '/api/files/abcdef12/v.webm',
      '/api/drawings/abcdef1.svg',
      '/api/files/abcdef12/raw.png',
    ]);
    for (const el of pending) {
      expect(el.getAttribute('src')).toBeNull();
      expect(el.classList.contains('kb-asset-pending')).toBe(true);
    }
    expect(div.querySelector('video')!.getAttribute('preload')).toBe('none');
    // Other websites' images aren't uploads.
    expect(div.querySelector('img[src="https://img.example/x.png"]')).not.toBeNull();
  });
});

describe('links, line breaks and typography', () => {
  it('opens web links in a new tab, and keeps note and anchor links in this one', () => {
    const { div } = render('[web](https://example.com) [note](/note/abc123def) [here](#h-x) https://auto.example/path');
    const [web, note, anchor, auto] = div.querySelectorAll('a');
    expect([web.target, web.rel]).toEqual(['_blank', 'noopener noreferrer']);
    expect(note.hasAttribute('target')).toBe(false);
    expect(anchor.hasAttribute('target')).toBe(false);
    expect([auto.getAttribute('href'), auto.target]).toEqual(['https://auto.example/path', '_blank']);
  });

  it('starts a new line wherever Enter was pressed, unless Settings say otherwise', () => {
    expect(render('one\ntwo').div.querySelector('br')).not.toBeNull();
    expect(render('one\ntwo', {}, { breaks: false }).div.querySelector('br')).toBeNull();
    // The setting doesn't stick to the next render.
    expect(render('one\ntwo').div.querySelector('br')).not.toBeNull();
  });

  it('curls quotes and dashes', () => {
    expect(render('"Quoted" -- and \'single\'...').div.textContent!.trim()).toBe('“Quoted” – and ‘single’…');
  });

  it('keeps <details> sections working with Markdown inside', () => {
    const { div } = render('<details>\n<summary>More</summary>\n\n**Hidden** text\n\n</details>');
    expect(div.querySelector('details > summary')!.textContent).toBe('More');
    expect(div.querySelector('details strong')!.textContent).toBe('Hidden');
  });
});
