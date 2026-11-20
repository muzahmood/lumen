// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { htmlToMarkdown, markdownForPaste } from '../../src/lib/pasteHtml';
import { expectQuick } from './timing';

function clipboard(data: Record<string, string>): DataTransfer {
  return { types: Object.keys(data), getData: (type: string) => data[type] ?? '' } as unknown as DataTransfer;
}

describe('pasting awkward HTML', () => {
  it('keeps angle brackets, tildes and dollar signs as text', () => {
    const md = htmlToMarkdown('<p>Use Vec&lt;String&gt; and &lt;img src=x&gt;, ~~not struck~~, $5 and $10</p>')!;
    expect(md).toBe('Use Vec\\<String> and \\<img src=x>, ~\\~not struck~\\~, \\$5 and \\$10');
  });

  it('turns layout tables nested many deep into one table, quickly', { retry: 2 }, () => {
    let html = 'deep';
    for (let i = 0; i < 18; i++) html = `<table><tr><td>${html}</td><td>x${i}</td></tr></table>`;
    const start = performance.now();
    const md = htmlToMarkdown(html)!;
    expectQuick(performance.now() - start, 1500);
    expect(md.split('\n').filter((l) => l.startsWith('|'))).toHaveLength(2);
    expect(md).toContain('deep');
  });

  it('ignores comments without slowing down on unclosed ones', { retry: 2 }, () => {
    const html = `<p>Hi</p>${'<!--'.repeat(50_000)}`;
    const start = performance.now();
    markdownForPaste(clipboard({ 'text/html': html, 'text/plain': 'Hi' }));
    expectQuick(performance.now() - start, 1500);
  });
});

describe('htmlToMarkdown', () => {
  it('reads Google Docs formatting from its inline styles', () => {
    const html =
      '<meta charset="utf-8"><b style="font-weight:normal;" id="docs-internal-guid-1a2b"><h1 dir="ltr"><span style="font-size:20pt;font-weight:400">Plan</span></h1>' +
      '<p dir="ltr"><span style="font-weight:700">Bold</span><span> and </span><span style="font-style:italic">italic</span><span> and </span><span style="text-decoration:line-through">gone</span></p>' +
      '<ul><li dir="ltr"><p dir="ltr"><span>One</span></p></li><li dir="ltr"><p dir="ltr"><span>Two</span></p></li></ul></b>';
    expect(htmlToMarkdown(html)).toBe('# Plan\n\n**Bold** and *italic* and ~~gone~~\n\n- One\n- Two');
  });

  it('writes lists the way Lumen does, nested and numbered', () => {
    const html = '<ol start="3"><li>Three</li><li>Four<ul><li>Inner</li></ul></li></ol>';
    expect(htmlToMarkdown(html)).toBe('3. Three\n4. Four\n   - Inner');
  });

  it('turns tables into pipe tables, the first row as the header', () => {
    const html = '<table><tr><td>Name</td><td align="right">Qty</td></tr><tr><td>Eggs | large</td><td>12</td></tr></table>';
    expect(htmlToMarkdown(html)).toBe('| Name | Qty |\n| --- | ---: |\n| Eggs \\| large | 12 |');
  });

  it('keeps fenced code with its language, including <pre> without <code>', () => {
    expect(htmlToMarkdown('<pre><code class="language-ts">const a = 1;\n</code></pre>')).toBe('```ts\nconst a = 1;\n```');
    expect(htmlToMarkdown('<div class="highlight-python"><pre>print("hi")</pre></div>')).toBe('```python\nprint("hi")\n```');
  });

  it('brings Lumen’s own reading view back to its Markdown', () => {
    const html =
      '<ul><li class="kb-task"><input type="checkbox" class="kb-task-box" checked> Done</li><li class="kb-task"><input type="checkbox" class="kb-task-box"> Open</li></ul>' +
      '<p>See <a class="kb-wikilink" href="/note/abc123def">Roadmap</a></p>' +
      '<blockquote class="kb-callout" data-callout="tip"><div class="kb-callout-title"><span>Heads up</span></div><p>Body text</p></blockquote>' +
      '<div class="kb-code"><div class="kb-code-bar"><span>js</span><button>Copy</button></div><pre><code class="hljs language-js">x()</code></pre></div>' +
      '<p>Euler: <span class="katex"><span class="katex-mathml"><math><semantics><mrow></mrow><annotation encoding="application/x-tex">e^{i\\pi}</annotation></semantics></math></span><span class="katex-html">e</span></span></p>';
    expect(htmlToMarkdown(html)).toBe(
      '- [x] Done\n- [ ] Open\n\nSee [[Roadmap]]\n\n> [!tip] Heads up\n> Body text\n\n```js\nx()\n```\n\nEuler: $e^{i\\pi}$',
    );
  });

  it('drops links and images that only work on the page they came from', () => {
    const html =
      '<p><a href="/relative/page">Relative</a> <a href="javascript:alert(1)">Bad</a> <a href="https://example.com/x">Good</a></p>' +
      '<p><img src="data:image/png;base64,AAAA" alt="inline"><img src="https://example.com/a.png" alt="remote"></p>';
    expect(htmlToMarkdown(html)).toBe('Relative Bad [Good](https://example.com/x)\n\n![remote](https://example.com/a.png)');
  });

  it('turns absolute links to this site back into Lumen paths', () => {
    const html = `<p><a href="${location.origin}/note/abc123def">Note</a> <img src="${location.origin}/api/files/f1234567/pic.png" alt="pic"></p>`;
    expect(htmlToMarkdown(html)).toBe('[Note](/note/abc123def) ![pic](/api/files/f1234567/pic.png)');
  });

  it('escapes Markdown characters but leaves words with underscores alone', () => {
    expect(htmlToMarkdown('<p>my_var_name and *stars* and _lead</p>')).toBe('my_var_name and \\*stars\\* and \\_lead');
  });

  it('never runs or keeps scripts and styles', () => {
    expect(htmlToMarkdown('<p>Text<script>alert(1)</script><style>p{}</style></p>')).toBe('Text');
  });
});

describe('markdownForPaste', () => {
  it('leaves plain paragraphs to the normal paste', () => {
    expect(markdownForPaste(clipboard({ 'text/plain': 'Hello world', 'text/html': '<p>Hello world</p>' }))).toBeNull();
  });

  it('leaves a lone link to the normal paste', () => {
    const url = 'https://example.com/page';
    expect(markdownForPaste(clipboard({ 'text/plain': url, 'text/html': `<a href="${url}">${url}</a>` }))).toBeNull();
  });

  it('leaves code copied from an editor as text', () => {
    expect(markdownForPaste(clipboard({ 'text/plain': 'a = 1', 'text/html': '<div>a = 1</div>', 'vscode-editor-data': '{}' }))).toBeNull();
    expect(markdownForPaste(clipboard({ 'text/plain': 'a = 1', 'text/html': '<pre>a = 1</pre>' }))).toBeNull();
  });

  it('converts formatted text', () => {
    const data = clipboard({ 'text/plain': 'One\nTwo', 'text/html': '<ul><li>One</li><li>Two</li></ul>' });
    expect(markdownForPaste(data)).toBe('- One\n- Two');
  });

  it('ignores clipboards without HTML', () => {
    expect(markdownForPaste(clipboard({ 'text/plain': '- a' }))).toBeNull();
  });
});
