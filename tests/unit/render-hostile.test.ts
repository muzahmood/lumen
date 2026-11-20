// @vitest-environment jsdom
/**
 * Hostile notes in reading view (src/lib/markdown.ts), beyond the payloads in markdown.test.ts: every
 * way Markdown can write a link or image, SVG and MathML tricks, style, attributes that would clobber
 * the page or imitate the app's own markers, images from other websites when Settings say ask first,
 * attachments in an encrypted library, and input built to make the renderer slow.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { renderMarkdown } from '../../src/lib/markdown';
import { expectQuick } from './timing';

function render(src: string, opts: Parameters<typeof renderMarkdown>[2] = {}) {
  const html = renderMarkdown(src, {}, opts);
  const div = document.createElement('div');
  div.innerHTML = html;
  return { html, div };
}

const URL_ATTRS = ['src', 'srcset', 'poster', 'background', 'data', 'to', 'values', 'from'];
const NAVIGATING = ['href', 'xlink:href', 'action', 'formaction'];

/**
 * No handler attributes, and nothing that runs script when followed or loaded. (A data: address in an
 * image's src is only ever decoded as a picture, so it's allowed there; never on a link.)
 */
function expectInert(div: HTMLElement, label: string) {
  for (const el of div.querySelectorAll('*')) {
    for (const name of el.getAttributeNames()) {
      expect(name.startsWith('on'), `${label}: ${el.tagName} ${name}`).toBe(false);
      const value = (el.getAttribute(name) ?? '').replace(/[\u0000- ]/g, '');
      if (URL_ATTRS.includes(name)) expect(value, `${label}: ${el.tagName} ${name}`).not.toMatch(/^(javascript|vbscript):/i);
      if (NAVIGATING.includes(name) || name.endsWith(':href')) {
        expect(value, `${label}: ${el.tagName} ${name}`).not.toMatch(/^(javascript|vbscript|data):/i);
      }
    }
  }
  expect(div.querySelector('script, iframe, frame, object, embed, form, meta, base, link, style, animate, set, foreignObject'), label).toBeNull();
}

describe('links and images in every Markdown form', () => {
  const schemes = ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'vbscript:msgbox(1)', 'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==', 'data:image/svg+xml,<svg onload=alert(1)>'];
  for (const url of schemes) {
    const forms = [
      `[inline](${url})`,
      `[angle](<${url}>)`,
      `[ref][r]\n\n[r]: ${url}`,
      `[collapsed][]\n\n[collapsed]: ${url}`,
      `<${url}>`,
      `![image](${url})`,
      `![ref image][i]\n\n[i]: ${url}`,
      `[![nested](${url})](${url})`,
      `<a href="${url}">html</a>`,
      `<img src="${url}">`,
      `<a href=" ${url}">space</a>`,
      `[[${url}]]`,
      `[[Note|${url}]]`,
    ];
    for (const src of forms) {
      it(`never makes a live ${url.slice(0, 14)} from ${src.split(url).join('…').slice(0, 40)}`, () => {
        expectInert(render(src).div, src);
      });
    }
  }

  it('turns entity- and whitespace-disguised schemes into nothing clickable', () => {
    const src = ['<a href="&#106;avascript:alert(1)">a</a>', '<a href="java&#x09;script:alert(1)">b</a>', '<a href="&#x6A;&#x61;vascript&colon;alert(1)">c</a>', '[d](java\nscript:alert(1))', '[e](&#106;avascript:alert(1))'].join('\n\n');
    expectInert(render(src).div, src);
  });
});

describe('SVG and MathML', () => {
  const payloads = [
    '<svg><animate attributeName="href" to="javascript:alert(1)"/><a><animate attributeName="xlink:href" values="javascript:alert(1)"/><text>x</text></a></svg>',
    '<svg><set attributeName="onmouseover" to="alert(1)"/></svg>',
    '<svg><foreignObject><img src=x onerror=alert(1)><div onclick="x()">d</div></foreignObject></svg>',
    '<svg><style>@import url(https://evil.example/x.css)</style><rect/></svg>',
    '<svg><script href="data:,alert(1)"/></svg>',
    '<svg><a href="javascript:alert(1)"><rect width="9" height="9"/></a></svg>',
    '<math><mtext><table><mglyph><style><img src=x onerror=alert(1)>',
    '<math><annotation-xml encoding="text/html"><img src=x onerror=alert(1)></annotation-xml></math>',
    '<math href="javascript:alert(1)"><mi>x</mi></math>',
    '<noscript><p title="</noscript><img src=x onerror=alert(1)>">',
    '<form><math><mtext></form><form><mglyph><svg><mtext><textarea><path id="</textarea><img onerror=alert(1) src=1>">',
    '<svg></p><style><a id="</style><img src=1 onerror=alert(1)>">',
  ];
  for (const p of payloads) {
    it(`neutralises ${p.slice(0, 70)}`, () => {
      expectInert(render(p).div, p);
    });
  }
});

describe('style', () => {
  it('keeps note HTML from pinning itself over the app, however it is written', () => {
    const { div } = render(
      '<p style="position: fixed !important; color: red">a</p>\n\n<p style="inset:0;position :  fixed ;z-index:9">b</p>\n\n<svg style="position:fixed;inset:0"><rect/></svg>\n\n<span style="position:sticky;top:0">c</span>',
    );
    for (const el of div.querySelectorAll<HTMLElement | SVGElement>('[style]')) {
      expect(el.style.position, el.outerHTML).not.toMatch(/fixed|sticky/);
    }
    expect([...div.querySelectorAll<HTMLElement>('p')].find((p) => p.textContent === 'a')!.style.color).toBe('red');
  });

  it('keeps only positioning that stays in the note: not a variable that turns into fixed, nor anything unknown', () => {
    const { div } = render(
      [
        '<div style="--p:fixed;position:var(--p);inset:0;z-index:2147483647;background:#fff">Session expired</div>',
        '<div style="position:var(--q, fixed);color:red">b</div>',
        '<div style="position:-webkit-sticky">c</div>',
        '<div style="position:relative">d</div>',
        '<div style="position:absolute;top:0">e</div>',
      ].join('\n\n'),
    );
    const byText = (t: string) => [...div.querySelectorAll<HTMLElement>('div')].find((d) => d.textContent === t);
    for (const t of ['Session expired', 'b', 'c']) expect(byText(t)!.style.position, t).toBe('');
    expect(byText('b')!.style.color).toBe('red');
    expect(byText('d')!.style.position).toBe('relative');
    expect(byText('e')!.style.position).toBe('absolute');
  });

  it('opens nothing in the browser’s top layer (over the whole app): no popover, dialog or command buttons', () => {
    const { div } = render(
      [
        '<button popovertarget="x" popovertargetaction="show" style="all:unset">Read more</button><div id="x" popover>Your session expired. <a href="https://evil.example/unlock">Unlock</a></div>',
        '<dialog id="d" open>Enter your passphrase</dialog><button commandfor="d" command="show-modal">More</button>',
        '<svg><foreignObject><div popover="manual">svg</div></foreignObject></svg>',
      ].join('\n\n'),
    );
    expect(div.querySelector('dialog')).toBeNull();
    for (const name of ['popover', 'popovertarget', 'popovertargetaction', 'command', 'commandfor']) {
      expect(div.querySelector(`[${name}]`), name).toBeNull();
    }
  });
});

describe('attributes that would clobber the page', () => {
  it('drops ids and names that shadow document properties', () => {
    const { html } = render('<img name="getElementById"><img id="cookie"><a name="body">x</a><img id="location"><img name="defaultView">');
    const host = document.createElement('div');
    host.innerHTML = html;
    document.body.appendChild(host);
    try {
      expect(typeof document.getElementById).toBe('function');
      expect(typeof document.cookie).toBe('string');
      expect(document.body.tagName).toBe('BODY');
      expect(document.location).toBe(window.location);
      expect(host.querySelector('[name], [id]')).toBeNull();
    } finally {
      host.remove();
    }
  });
});

describe('the app’s own markers', () => {
  it('can’t be written into note HTML, on HTML or SVG elements', () => {
    const forged = [
      '<a href="/note/x" data-note-id="victim12345">x</a>',
      '<div data-rendered="light:9" data-line-end="3">y</div>',
      '<svg class="kb-mermaid kb-drawing" data-src="graph" data-action="edit-mermaid"><rect/></svg>',
      '<img src="/api/files/abcdef12/p.png" data-kb-asset="/api/files/abcdef12/other.png">',
      '<span class="kb-task-box kb-other" data-task-line="0">z</span>',
    ].join('\n\n');
    for (const assets of ['load', 'decrypt'] as const) {
      const { div } = render(forged, { assets });
      expect(div.querySelector('[data-note-id], [data-rendered], [data-line-end], [data-src], [data-action], [data-task-line]')).toBeNull();
      expect(div.querySelector('.kb-mermaid, .kb-drawing, .kb-task-box')).toBeNull();
      // The forged decrypt address is gone; only the image's real address is used.
      const pending = [...div.querySelectorAll('[data-kb-asset]')].map((el) => el.getAttribute('data-kb-asset'));
      expect(pending).toEqual(assets === 'decrypt' ? ['/api/files/abcdef12/p.png'] : []);
    }
    // Ordinary classes stay.
    expect(render(forged).div.querySelector('.kb-other')).not.toBeNull();
  });

  it('can’t fake the click-to-load box for an image from another website', () => {
    const fake = '<img data-remote-src="https://tracker.example/pixel.png" class="kb-remote" alt="Image from wikipedia.org: click to load">';
    expect(render(fake).div.querySelector('[data-remote-src]')).toBeNull();
    const { div } = render(`${fake}\n\n![real](https://img.example/x.png)`, { remoteImages: 'ask' });
    for (const box of div.querySelectorAll<HTMLImageElement>('[data-remote-src]')) {
      const host = new URL(box.dataset.remoteSrc!).host;
      expect(box.alt, box.outerHTML).toContain(host);
    }
  });

  it('puts only a note id of the usual form into a [[link]], so a forged one can’t add to the app’s own markup', () => {
    const forged = 'x" data-action="edit-drawing" data-drawing-id="abc';
    const html = renderMarkdown('[[Plan]] and [[Other]]', { resolveTitle: (t) => (t === 'Plan' ? forged : 'okid1234') }, {});
    const div = document.createElement('div');
    div.innerHTML = html;
    expect(div.querySelector('[data-action]')).toBeNull();
    const [plan, other] = [...div.querySelectorAll('a.kb-wikilink')];
    // An id that isn't one is treated as no note found.
    expect(plan.classList.contains('is-missing')).toBe(true);
    expect(other.getAttribute('data-note-id')).toBe('okid1234');
  });

  it('keeps every link that opens another window from reaching back into this one', () => {
    const { div } = render('<a href="https://evil.example" target="w">a</a>\n\n<map name="m"><area href="https://evil.example" target="w" shape="rect" coords="0,0,9,9"></map>');
    const openers = [...div.querySelectorAll('[target]')];
    expect(openers.map((el) => el.tagName)).toEqual(['A', 'AREA']);
    for (const el of openers) expect(el.getAttribute('rel') ?? '', el.tagName).toMatch(/noopener/);
  });
});

describe('images from other websites, with Settings set to ask first', () => {
  const remote = (div: HTMLElement) =>
    [...div.querySelectorAll('*')].flatMap((el) =>
      ['src', 'srcset', 'poster', 'background', 'href', 'xlink:href']
        .filter((name) => !(name === 'href' && el.tagName === 'A'))
        .map((name) => el.getAttribute(name))
        .filter((v): v is string => !!v && /(^|[\s,])(https?:)?\/\//i.test(v)),
    );

  it('load nothing from elsewhere, however the note asks for it', () => {
    const src = [
      '<picture><source srcset="https://evil.example/a.png"><img src="/api/files/abcdef12/local.png"></picture>',
      '<video src="https://evil.example/v.mp4" poster="https://evil.example/p.png"><source src="https://evil.example/s.mp4"><track src="https://evil.example/t.vtt"></video>',
      '<audio src="//evil.example/a.mp3"></audio>',
      '<input type="image" src="HTTPS://EVIL.EXAMPLE/i.png">',
      '<svg><image href="https://evil.example/i.png"/><image xlink:href="https://evil.example/j.png"/></svg>',
      '<table background="https://evil.example/bg.png"><tr><td>x</td></tr></table>',
      '<img src="https://evil.example/q.png" srcset="https://evil.example/q2.png 2x">',
      '<img src="/api/files/abcdef12/ok.png" srcset="/api/files/abcdef12/ok2.png 2x, https://evil.example/q3.png 3x">',
      '<div style="background:url(//evil.example/r.png) no-repeat; color: red">bg</div>',
      '[![inside a link](https://evil.example/in.png)](https://example.com)',
      '![protocol-relative](//evil.example/pr.png)',
    ].join('\n\n');
    const { div } = render(src, { remoteImages: 'ask' });
    expect(remote(div)).toEqual([]);
    // Each image is a box to click, named after its site; links and local files are untouched.
    const boxes = [...div.querySelectorAll<HTMLImageElement>('img.kb-remote')];
    expect(boxes.map((b) => b.dataset.remoteSrc)).toEqual(['https://evil.example/q.png', 'https://evil.example/in.png', '//evil.example/pr.png']);
    for (const b of boxes) expect(b.alt).toMatch(/evil\.example: click to load$/);
    expect(div.querySelector('a[href="https://example.com"]')).not.toBeNull();
    expect(div.querySelector('img[src="/api/files/abcdef12/local.png"]')).not.toBeNull();
    expect(div.querySelector<HTMLElement>('div[style]')?.style.color).toBe('red');
  });

  it('read every address as the browser does: /\\host and \\\\host are other sites, in srcset and CSS alike', () => {
    const src = [
      '<img srcset="/\\evil.example/a.png">',
      '<img srcset="\\\\evil.example/b.png 2x">',
      '<img srcset="//,evil.example/c.png">',
      '<picture><source srcset="/api/files/abcdef12/ok.png 1x, /\\evil.example/d.png 2x"><img src="/api/files/abcdef12/ok.png"></picture>',
      `<div style="background:url('/\\\\evil.example/e.png')">e</div>`,
      `<div style="background-image:url('\\2f\\2f evil.example/f.png')">f</div>`,
      '<div style="cursor:url(https://evil.example/g.cur), auto">g</div>',
      // In CSS a lone \ starts an escape (\e is U+000E), so /\host is written /\\host there.
      '<svg><rect fill="url(https://evil.example/p.svg#g)" mask="url(//evil.example/m.svg#m)" filter="url(/\\\\evil.example/f.svg#f)" stroke="red"/></svg>',
    ].join('\n\n');
    const { div } = render(src, { remoteImages: 'ask' });
    const isRemote = (v: string) => {
      try {
        const u = new URL(v, location.href);
        return u.origin !== location.origin;
      } catch {
        return false;
      }
    };
    for (const el of div.querySelectorAll('[srcset]')) {
      for (const token of el.getAttribute('srcset')!.split(/[\s,]+/)) expect(isRemote(token), el.outerHTML).toBe(false);
    }
    expect(div.querySelector('source[srcset="/api/files/abcdef12/ok.png 1x, /\\evil.example/d.png 2x"]')).toBeNull();
    expect(div.querySelector('img[src="/api/files/abcdef12/ok.png"]')).not.toBeNull();
    for (const el of div.querySelectorAll<HTMLElement>('[style]')) expect(el.getAttribute('style'), el.outerHTML).not.toMatch(/url\(|evil/i);
    const rect = div.querySelector('rect')!;
    for (const name of ['fill', 'mask', 'filter']) expect(rect.getAttribute(name), name).toBeNull();
    expect(rect.getAttribute('stroke')).toBe('red');
  });

  it('keep local backgrounds and in-page SVG paints', () => {
    const { div } = render('<div style="background:url(data:image/png;base64,iVBORw0KGgo=)">a</div>\n\n<svg><rect fill="url(#grad)"/></svg>', { remoteImages: 'ask' });
    expect(div.querySelector<HTMLElement>('div[style]')?.style.background).toMatch(/data:image\/png/);
    expect(div.querySelector('rect')?.getAttribute('fill')).toBe('url(#grad)');
  });

  it('still show images from this site and inline data', () => {
    const { div } = render('![a](/api/files/abcdef12/a.png) ![b](http://localhost:3000/api/files/abcdef12/b.png) ![c](data:image/png;base64,iVBORw0KGgo=)', { remoteImages: 'ask' });
    expect(div.querySelectorAll('img[src]')).toHaveLength(3);
    expect(div.querySelector('.kb-remote')).toBeNull();
  });

  it('are loaded again once the setting is back to load', () => {
    expect(render('![x](https://img.example/again.png)', { remoteImages: 'ask' }).div.querySelector('img[src]')).toBeNull();
    expect(render('![x](https://img.example/again.png)').div.querySelector('img[src="https://img.example/again.png"]')).not.toBeNull();
  });
});

describe('attachments in an encrypted library', () => {
  it('are never requested straight from the server by note HTML', () => {
    const src = [
      '<img srcset="/api/files/abcdef12/holiday.png 2x">',
      '<video poster="/api/files/abcdef12/poster.png"></video>',
      '<svg><image href="/api/files/abcdef12/diagram.png"/></svg>',
      '<input type="image" src="/api/files/abcdef12/button.png">',
      '<div style="background-image:url(/api/files/abcdef12/bg.png)">x</div>',
    ].join('\n\n');
    const { div } = render(src, { assets: 'decrypt' });
    const direct = [...div.querySelectorAll('*')].flatMap((el) =>
      el
        .getAttributeNames()
        .filter((name) => name !== 'data-kb-asset')
        .map((name) => `${el.tagName} ${name}=${el.getAttribute(name)}`)
        .filter((v) => v.includes('/api/files/')),
    );
    expect(direct).toEqual([]);
  });
});

describe('cost on hostile input', () => {
  afterEach(() => {
    // Leaves no setting behind for the next render.
    expect(render('![x](https://img.example/x.png)').div.querySelector('img[src]')).not.toBeNull();
  });

  const cases: Array<[string, string]> = [
    ['wiki openers', '[[a '.repeat(10_000)],
    ['mark openers', '==a '.repeat(5_000)],
    ['an unclosed mark', `==${'a '.repeat(20_000)}`],
    ['dollar openers', '$a '.repeat(20_000)],
    ['unclosed display math', `$$${'x\n'.repeat(5_000)}`],
    ['unclosed callouts', '> [!x\n'.repeat(5_000)],
    ['deep quotes', `${'>'.repeat(2_000)} x`],
    ['task lines', '- [ ] x\n'.repeat(1_000)],
    ['image openers', '!['.repeat(10_000)],
  ];
  for (const [name, md] of cases) {
    it(`stays quick on ${name}`, { retry: 2 }, () => {
      const start = performance.now();
      renderMarkdown(md);
      expectQuick(performance.now() - start, 1500);
    });
  }

  // Each was quadratic: every opener searched the rest of its line (or the text) for a closer.
  const large: Array<[string, string, number]> = [
    ['160 KB of highlight openers on one line', '==a '.repeat(40_000), 600],
    ['highlight openers inside a highlight', `==x ${'==a '.repeat(30_000)}y==`, 600],
    ['80 KB of wiki-link openers before one closer', `${'[['.repeat(40_000)}]]`, 300],
    ['wiki-link openers each with text, never closed', '[[a b '.repeat(20_000), 300],
  ];
  for (const [name, md, limit] of large) {
    it(`stays quick on ${name}`, { retry: 2 }, () => {
      const start = performance.now();
      renderMarkdown(md);
      expectQuick(performance.now() - start, limit);
    });
  }

  it('still reads highlights and wiki links as before around those openers', () => {
    const { div } = render('==a ==b== and ==c\n\n[[a]b]] [[x [[Real]] [[Two|alias]]', {});
    expect([...div.querySelectorAll('mark')].map((m) => m.textContent)).toEqual(['a ==b']);
    expect(div.textContent).toContain('and ==c');
    expect([...div.querySelectorAll('a.kb-wikilink')].map((a) => a.textContent)).toEqual(['a]b', 'Real', 'alias']);
  });

  it('stays quick on an image whose alt text is a long run of spaces', { retry: 2 }, () => {
    const md = `![a${' '.repeat(30_000)}|x](/api/files/abcdef12/a.png)`;
    const start = performance.now();
    renderMarkdown(md);
    expectQuick(performance.now() - start, 250);
  });
});
