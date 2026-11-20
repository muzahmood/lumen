// @vitest-environment jsdom
/**
 * Pasting formatted text: README promises that pasting from a web page, Google Docs, Word or an email
 * keeps headings, lists, links, tables and code as Markdown. These are the clipboard shapes those
 * apps really produce (Chrome on Windows wraps every fragment in <html><body> and StartFragment
 * comments; Docs nests lists as <ul> inside <ul>; desktop Word writes lists as styled paragraphs).
 */
import { describe, expect, it } from 'vitest';
import { endsWithBlock, htmlToMarkdown, markdownForPaste, startsWithBlock } from '../../src/lib/pasteHtml';
import { expectQuick } from './timing';

function clipboard(data: Record<string, string>): DataTransfer {
  return { types: Object.keys(data), getData: (type: string) => data[type] ?? '' } as unknown as DataTransfer;
}

/** How Chrome on Windows hands over copied HTML. */
const windowsClipboard = (fragment: string) => `<html>\r\n<body>\r\n<!--StartFragment-->${fragment}<!--EndFragment-->\r\n</body>\r\n</html>`;

const docsSpan = (text: string, style = '') =>
  `<span style="font-size:11pt;font-family:Arial,sans-serif;color:#000000;background-color:transparent;font-weight:400;font-style:normal;font-variant:normal;text-decoration:none;vertical-align:baseline;white-space:pre;white-space:pre-wrap;${style}">${text}</span>`;
const docsItem = (text: string, level: number) =>
  `<li dir="ltr" style="list-style-type:${level === 1 ? 'disc' : 'circle'};font-size:11pt;font-family:Arial,sans-serif;" aria-level="${level}"><p dir="ltr" style="line-height:1.38;margin-top:0pt;margin-bottom:0pt;" role="presentation">${docsSpan(text)}</p></li>`;
const docs = (body: string) => `<meta charset="utf-8"><b style="font-weight:normal;" id="docs-internal-guid-6c0b4a1e-7fff-1234-5678-9abcdef01234">${body}</b>`;

describe('pasting from Google Docs', () => {
  it('keeps bold, italic, code-font and links inside a paragraph', () => {
    const html = docs(
      `<p dir="ltr" style="line-height:1.38;margin-top:0pt;margin-bottom:0pt;">${docsSpan('Run ')}${docsSpan('npm test', "font-family:'Courier New',monospace;")}${docsSpan(' then ')}${docsSpan('ship it', 'font-weight:700;font-style:italic;')}${docsSpan(' — see ')}<a href="https://example.com/guide" style="text-decoration:none;">${docsSpan('the guide', 'color:#1155cc;text-decoration:underline;')}</a></p>`,
    );
    expect(htmlToMarkdown(html)).toBe('Run `npm test` then ***ship it*** — see [the guide](https://example.com/guide)');
  });

  it('keeps headings without making their text bold', () => {
    const html = docs(`<h2 dir="ltr" style="line-height:1.38;margin-top:18pt;margin-bottom:6pt;">${docsSpan('Next steps', 'font-size:16pt;font-weight:400;')}</h2>`);
    expect(htmlToMarkdown(html)).toBe('## Next steps');
  });

  it('keeps a nested list nested', () => {
    const ul = (items: string) => `<ul style="margin-top:0;margin-bottom:0;padding-inline-start:48px;">${items}</ul>`;
    const html = docs(ul(`${docsItem('Parent', 1)}${ul(docsItem('Child', 2))}${docsItem('Sibling', 1)}`));
    expect(htmlToMarkdown(html)).toBe('- Parent\n  - Child\n- Sibling');
  });

  it('turns a table into a pipe table', () => {
    const cell = (text: string) => `<td style="border-left:solid #000000 1pt;vertical-align:top;padding:5pt 5pt 5pt 5pt;overflow:hidden;overflow-wrap:break-word;"><p dir="ltr" style="line-height:1.2;margin-top:0pt;margin-bottom:0pt;">${docsSpan(text)}</p></td>`;
    const html = docs(
      `<div dir="ltr" style="margin-left:0pt;" align="left"><table style="border:none;border-collapse:collapse;"><colgroup><col width="301"><col width="301"></colgroup><tbody><tr style="height:0pt">${cell('Name')}${cell('Qty')}</tr><tr style="height:0pt">${cell('Eggs')}${cell('12')}</tr></tbody></table></div>`,
    );
    expect(htmlToMarkdown(html)).toBe('| Name | Qty |\n| --- | --- |\n| Eggs | 12 |');
  });
});

describe('pasting from desktop Word and Outlook', () => {
  const word = (body: string) =>
    windowsClipboard(
      `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word" xmlns="http://www.w3.org/TR/REC-html40"><head><meta name=ProgId content=Word.Document><style><!-- p.MsoNormal {margin:0cm;} --></style></head><body lang=EN-US>${body}</body></html>`,
    );
  const item = (marker: string, text: string, cls: string, font = '') =>
    `<p class=${cls} style='text-indent:-18.0pt;mso-list:l0 level1 lfo1'><![if !supportLists]><span style='${font}'><span style='mso-list:Ignore'>${marker}<span style='font:7.0pt "Times New Roman"'>&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; </span></span></span><![endif]>${text}<o:p></o:p></p>`;

  it('keeps headings, bold, italic and links, and drops Word’s own markup', () => {
    const html = word(`<h1>Report<o:p></o:p></h1><p class=MsoNormal><b>Bold</b> and <i>italic</i> and <a href="https://example.com/">a link</a><o:p></o:p></p>`);
    expect(htmlToMarkdown(html)).toBe('# Report\n\n**Bold** and *italic* and [a link](https://example.com/)');
  });

  it('keeps bulleted and numbered lists as lists', () => {
    const bullets = word(item('·', 'First', 'MsoListParagraphCxSpFirst', 'font-family:Symbol') + item('·', 'Second', 'MsoListParagraphCxSpLast', 'font-family:Symbol'));
    expect(htmlToMarkdown(bullets)).toBe('- First\n- Second');
    const numbers = word(item('1.', 'One', 'MsoListParagraphCxSpFirst') + item('2.', 'Two', 'MsoListParagraphCxSpLast'));
    expect(htmlToMarkdown(numbers)).toBe('1. One\n2. Two');
  });

  it('turns a Word table into a pipe table', () => {
    const cell = (text: string) => `<td width=301 valign=top style='width:225.4pt;border:solid windowtext 1.0pt;padding:0cm 5.4pt 0cm 5.4pt'><p class=MsoNormal>${text}<o:p></o:p></p></td>`;
    const html = word(`<table class=MsoTableGrid border=1 cellspacing=0 cellpadding=0><tr>${cell('<b>Name</b>')}${cell('<b>Qty</b>')}</tr><tr>${cell('Eggs')}${cell('12')}</tr></table>`);
    expect(htmlToMarkdown(html)).toBe('| **Name** | **Qty** |\n| --- | --- |\n| Eggs | 12 |');
  });
});

describe('pasting from an email', () => {
  it('keeps a Gmail message’s lines, list and quoted reply', () => {
    const html =
      '<div dir="ltr">Hi team,<div><br></div><div>Agenda:</div><ol><li>Budget</li><li>Hiring</li></ol><div>Thanks,</div></div><br>' +
      '<div class="gmail_quote"><div dir="ltr" class="gmail_attr">On Mon, Nov 16, 2026 at 9:00 AM Sam &lt;sam@example.com&gt; wrote:<br></div>' +
      '<blockquote class="gmail_quote" style="margin:0px 0px 0px 0.8ex;border-left:1px solid rgb(204,204,204);padding-left:1ex"><div dir="ltr">Original message</div></blockquote></div>';
    const md = htmlToMarkdown(html)!;
    expect(md).toContain('Hi team,');
    expect(md).toContain('1. Budget\n2. Hiring');
    expect(md).toContain('> Original message');
    expect(md).toContain('Sam \\<sam@example.com> wrote:');
  });

  it('leaves no lines of stray spaces where an email had an empty line', () => {
    expect(htmlToMarkdown('<div dir="ltr">Hi team,<div><br></div><div>Agenda:</div></div>')).toBe('Hi team,\n\nAgenda:');
  });

  it('drops images that only exist inside the email', () => {
    expect(htmlToMarkdown('<p>Logo <img src="cid:image001.png@01DA" alt="logo"> here</p>')).toBe('Logo here');
  });
});

describe('pasting from web pages', () => {
  it('keeps code blocks with their language from common highlighters', () => {
    expect(htmlToMarkdown('<pre class="lang-js s-code-block"><code class="hljs language-javascript">const a = 1;\n</code></pre>')).toBe('```javascript\nconst a = 1;\n```');
    expect(htmlToMarkdown('<div class="highlight highlight-source-shell"><pre>npm install</pre></div>')).toBe('```shell\nnpm install\n```');
  });

  it('keeps a code block that holds triple backticks intact, with a longer fence', () => {
    const md = htmlToMarkdown('<pre><code>```js\nx\n```\n</code></pre>')!;
    expect(md).toMatch(/^````+\n```js\nx\n```\n````+$/);
  });

  it('keeps a highlighted block that holds triple backticks intact', () => {
    const md = htmlToMarkdown('<div class="highlight highlight-source-shell"><pre>cat &lt;&lt;EOF\n```js\nx\n```\nEOF</pre></div><p>after</p>')!;
    expect(md).toMatch(/^(````+)shell\ncat <<EOF\n```js\nx\n```\nEOF\n\1\n\nafter$/);
  });

  it('reads the language of GitHub’s text grammars, such as Markdown', () => {
    expect(htmlToMarkdown('<div class="highlight highlight-text-md"><pre># Title</pre></div>')).toBe('```md\n# Title\n```');
  });

  it('keeps inline code with backticks in it readable', () => {
    expect(htmlToMarkdown('<p>Use <code>a`b</code> here</p>')).toBe('Use ``a`b`` here');
  });

  it('turns GitHub’s task lists into tasks', () => {
    const html = '<ul class="contains-task-list"><li class="task-list-item"><input type="checkbox" class="task-list-item-checkbox" disabled checked> Done</li><li class="task-list-item"><input type="checkbox" class="task-list-item-checkbox" disabled> Open</li></ul>';
    expect(htmlToMarkdown(html)).toBe('- [x] Done\n- [ ] Open');
  });

  it('keeps links whose addresses have parentheses, and their titles', () => {
    const md = htmlToMarkdown('<p><a href="https://en.wikipedia.org/wiki/Python_(programming_language)" title="Python">Python</a></p>')!;
    expect(md).toMatch(/^\[Python\]\(https:\/\/en\.wikipedia\.org\/wiki\/Python_\\?\(programming_language\\?\) "Python"\)$/);
  });

  it('escapes text that would otherwise read as Markdown', () => {
    expect(htmlToMarkdown('<p>1. Not a list</p><p># Not a heading</p><p>- not a bullet</p><p>[[Not a link]]</p><p>==not marked==</p>')).toBe(
      '1\\. Not a list\n\n\\# Not a heading\n\n\\- not a bullet\n\n\\[\\[Not a link\\]\\]\n\n=\\=not marked=\\=',
    );
  });

  it('keeps cells in their columns when a cell spans rows', () => {
    const html = '<table><tr><th>Day</th><th>Slot</th><th>Who</th></tr><tr><td rowspan="2">Mon</td><td>AM</td><td>Ann</td></tr><tr><td>PM</td><td>Bo</td></tr></table>';
    expect(htmlToMarkdown(html)).toBe('| Day | Slot | Who |\n| --- | --- | --- |\n| Mon | AM | Ann |\n|  | PM | Bo |');
  });

  it('spreads a cell that spans columns', () => {
    expect(htmlToMarkdown('<table><tr><td colspan="2">Both</td></tr><tr><td>a</td><td>b</td></tr></table>')).toBe('| Both |  |\n| --- | --- |\n| a | b |');
  });

  it('keeps the page’s attributes out of the <sup>, <sub> and <kbd> it keeps (a link’s address stays)', () => {
    expect(
      htmlToMarkdown(
        '<p>x<sup id="r" style="position:fixed;inset:0" popover onclick="go()">2</sup> <kbd class="k" popovertarget="x">Esc</kbd> ref<sup class="c"><a class="l" href="https://en.wikipedia.org/wiki/X#cite_note-1">[1]</a></sup></p>',
      ),
    ).toBe('x<sup>2</sup> <kbd>Esc</kbd> ref<sup><a href="https://en.wikipedia.org/wiki/X#cite_note-1">[1]</a></sup>');
  });

  it('keeps <sup>, <sub> and <kbd> as they are', () => {
    expect(htmlToMarkdown('<p>x<sup>2</sup> H<sub>2</sub>O <kbd>Ctrl</kbd></p>')).toBe('x<sup>2</sup> H<sub>2</sub>O <kbd>Ctrl</kbd>');
  });

  it('drops forms, frames and media players but keeps the text around them', () => {
    expect(htmlToMarkdown('<p>Before</p><form><button>Go</button><select><option>x</option></select><textarea>t</textarea></form><iframe src="https://x"></iframe><svg><text>s</text></svg><p>After</p>')).toBe(
      'Before\n\nAfter',
    );
  });
});

describe('when the plain text is better', () => {
  it('leaves a lone code block to the plain paste, also as Chrome on Windows sends it', () => {
    expect(markdownForPaste(clipboard({ 'text/plain': 'a = 1', 'text/html': '<meta charset="utf-8"><pre>a = 1</pre>' }))).toBeNull();
    expect(markdownForPaste(clipboard({ 'text/plain': 'a = 1', 'text/html': '<!--StartFragment--><pre>a = 1</pre><!--EndFragment-->' }))).toBeNull();
  });

  it('leaves a lone code block wrapped in <html><body> to the plain paste', () => {
    expect(markdownForPaste(clipboard({ 'text/plain': 'a = 1\nb = 2', 'text/html': windowsClipboard('<pre>a = 1\nb = 2</pre>') }))).toBeNull();
  });

  it('converts a selection that starts and ends with code but has more between', () => {
    const html = '<pre>one()</pre><h2>Then</h2><p>Some <b>bold</b> text</p><pre>two()</pre>';
    expect(markdownForPaste(clipboard({ 'text/plain': 'one()\nThen\nSome bold text\ntwo()', 'text/html': html }))).toBe('```\none()\n```\n\n## Then\n\nSome **bold** text\n\n```\ntwo()\n```');
  });

  it('converts formatted text that arrives wrapped by Chrome on Windows', () => {
    expect(markdownForPaste(clipboard({ 'text/plain': 'Title\nBody', 'text/html': windowsClipboard('<h1>Title</h1><p>Body</p>') }))).toBe('# Title\n\nBody');
  });

  it('leaves a lone link, even with spaces around it, to the plain paste', () => {
    expect(markdownForPaste(clipboard({ 'text/plain': '  https://example.com/a  ', 'text/html': '<a href="https://example.com/a">Example</a>' }))).toBeNull();
  });

  it('leaves HTML that only differs from its text by escapes to the plain paste', () => {
    expect(markdownForPaste(clipboard({ 'text/plain': 'Costs $5 * 2', 'text/html': '<span>Costs $5 * 2</span>' }))).toBeNull();
  });

  it('falls back to the plain paste for very large HTML', () => {
    expect(markdownForPaste(clipboard({ 'text/plain': 'x', 'text/html': `<p>${'x'.repeat(1_600_000)}</p>` }))).toBeNull();
  });
});

describe('fitting pasted Markdown into the line', () => {
  it('tells blocks from running text at the start', () => {
    for (const md of ['# H', '- a', '* a', '+ a', '1. a', '2) a', '> q', '```js', '~~~', '| a |', '$$', '---']) expect(startsWithBlock(md), md).toBe(true);
    for (const md of ['plain', '**bold** text', '#hashtag', '-dash', '1.5 litres', '[link](x)']) expect(startsWithBlock(md), md).toBe(false);
  });

  it('treats anything spanning lines, or a last line that is a block, as ending in a block', () => {
    expect(endsWithBlock('a\nb')).toBe(true);
    expect(endsWithBlock('- item')).toBe(true);
    expect(endsWithBlock('plain words')).toBe(false);
  });
});

describe('cost on large pastes', () => {
  it('converts a long list quickly', { retry: 2 }, () => {
    const html = `<ul>${Array.from({ length: 3000 }, (_, i) => `<li>Item ${i}</li>`).join('')}</ul>`;
    const start = performance.now();
    const md = htmlToMarkdown(html)!;
    expectQuick(performance.now() - start, 3000);
    expect(md.split('\n')).toHaveLength(3000);
  });

  it('converts a large table quickly', { retry: 2 }, () => {
    const row = (i: number) => `<tr>${Array.from({ length: 8 }, (_, j) => `<td><p><span>r${i}c${j}</span></p></td>`).join('')}</tr>`;
    const html = `<table>${Array.from({ length: 400 }, (_, i) => row(i)).join('')}</table>`;
    const start = performance.now();
    const md = htmlToMarkdown(html)!;
    expectQuick(performance.now() - start, 3000);
    expect(md.split('\n')).toHaveLength(401);
  });

  it('converts a long run of spaces before text quickly (code a page put on the clipboard, say)', { retry: 2 }, () => {
    const html = `<pre>${' '.repeat(40_000)}x</pre><p>a${' \t'.repeat(20_000)}b</p>`;
    const start = performance.now();
    const md = htmlToMarkdown(html)!;
    expectQuick(performance.now() - start, 300);
    expect(md).toContain('x');
  });

  it('still keeps two trailing spaces (a line break) and drops one', () => {
    expect(htmlToMarkdown('<pre>one   \ntwo \nthree</pre>')).toBe('```\none   \ntwo\nthree\n```');
  });

  it('keeps long runs of spaces and tabs in code exactly as they were', () => {
    const run = ' \t'.repeat(20);
    expect(htmlToMarkdown(`<pre>a${run}b\n${' '.repeat(40)}c</pre>`)).toBe(`\`\`\`\na${run}b\n${' '.repeat(40)}c\n\`\`\``);
    expect(htmlToMarkdown(`<p>x</p><pre>${' '.repeat(40)}</pre>`)).toBe('x');
  });

  it('survives very deep nesting', () => {
    const html = `${'<div>'.repeat(3000)}deep${'</div>'.repeat(3000)}`;
    expect(() => markdownForPaste(clipboard({ 'text/plain': 'deep', 'text/html': html }))).not.toThrow();
  });
});
