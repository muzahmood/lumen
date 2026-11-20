// @vitest-environment jsdom
/**
 * Pasting and dropping into the editor (src/lib/editorExtensions.ts): formatted text becomes Markdown,
 * plain text (what Ctrl/⌘ Shift V sends: no HTML) goes in exactly as copied, code and formulas only
 * ever get text, an address pasted over words links them, and files go to the upload.
 */
import { EditorSelection, EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { ensureSyntaxTree } from '@codemirror/language';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { pasteAndDrop, type EditorHost, type HostRef } from '../../src/lib/editorExtensions';

beforeAll(() => {
  // jsdom has no layout; CodeMirror measures after scrolling a paste into view.
  const rects = () => Object.assign([], { item: () => null }) as unknown as DOMRectList;
  Range.prototype.getClientRects ??= rects;
  Range.prototype.getBoundingClientRect ??= () => new DOMRect();
});

const views: EditorView[] = [];
afterEach(() => {
  for (const v of views.splice(0)) v.destroy();
});

function setup(doc: string, from: number, to = from) {
  const uploads: File[][] = [];
  const host = { uploadFiles: (files: File[]) => void uploads.push(files) } as unknown as EditorHost;
  const ref: HostRef = { current: host };
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  const view = new EditorView({
    parent,
    state: EditorState.create({ doc, selection: EditorSelection.single(from, to), extensions: [markdown({ base: markdownLanguage }), pasteAndDrop(ref)] }),
  });
  views.push(view);
  ensureSyntaxTree(view.state, view.state.doc.length, 5000);
  view.dispatch({});
  return {
    view,
    uploads,
    text: () => view.state.doc.toString(),
    head: () => view.state.selection.main.head,
    paste(data: { plain?: string; html?: string; files?: File[] }) {
      const types = [...(data.plain !== undefined ? ['text/plain'] : []), ...(data.html !== undefined ? ['text/html'] : []), ...(data.files?.length ? ['Files'] : [])];
      const clipboard = {
        types,
        files: data.files ?? [],
        getData: (type: string) => (type === 'text/plain' ? (data.plain ?? '') : type === 'text/html' ? (data.html ?? '') : ''),
      };
      const event = new Event('paste', { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'clipboardData', { value: clipboard });
      view.contentDOM.dispatchEvent(event);
      return event.defaultPrevented;
    },
  };
}

describe('pasting', () => {
  it('turns formatted text into Markdown', () => {
    const e = setup('Notes: ', 7);
    e.paste({ plain: 'Big news and a link', html: '<p><b>Big</b> news and <a href="https://example.com/x">a link</a></p>' });
    expect(e.text()).toBe('Notes: **Big** news and [a link](https://example.com/x)');
    expect(e.head()).toBe(e.text().length);
  });

  it('puts plain text in exactly as copied, Markdown characters and spacing included (Ctrl/⌘ Shift V)', () => {
    const e = setup('ab', 1);
    e.paste({ plain: ' **not bold** # nor a heading\n- nor a list ' });
    expect(e.text()).toBe('a **not bold** # nor a heading\n- nor a list b');
  });

  it('puts a pasted list or heading on lines of its own, not in the middle of a sentence', () => {
    const e = setup('Before after', 7);
    e.paste({ plain: 'One\nTwo', html: '<ul><li>One</li><li>Two</li></ul>' });
    expect(e.text()).toBe('Before \n\n- One\n- Two\n\nafter');
  });

  it('gives code blocks, inline code and formulas only the text', () => {
    const html = '<p><b>bold</b> <i>it</i></p>';
    const plain = 'bold it';
    const fence = setup('```\nx\n```', 5);
    fence.paste({ plain, html });
    expect(fence.text()).toBe('```\nxbold it\n```');
    const inline = setup('a `cd` e', 4);
    inline.paste({ plain, html });
    expect(inline.text()).toBe('a `cbold itd` e');
    const formula = setup('see $x+y$ here', 6);
    formula.paste({ plain, html });
    expect(formula.text()).toBe('see $xbold it+y$ here');
    const block = setup('$$\na\n\n$$', 5);
    block.paste({ plain, html });
    expect(block.text()).toBe('$$\na\nbold it\n$$');
  });

  it('links the selected words to an address pasted over them', () => {
    const e = setup('Read the docs today', 5, 13);
    e.paste({ plain: ' https://example.com/docs \n' });
    expect(e.text()).toBe('Read [the docs](https://example.com/docs) today');
  });

  it('replaces a link’s address when a new one is pasted over it', () => {
    const e = setup('[docs](https://old.example/a) and more', 7, 28);
    e.paste({ plain: 'https://new.example/b' });
    expect(e.text()).toBe('[docs](https://new.example/b) and more');
    // "https://old.example" runs from 11 to 30.
    const code = setup('```\nfetch("https://old.example")\n```', 11, 30);
    code.paste({ plain: 'https://new.example' });
    expect(code.text()).toBe('```\nfetch("https://new.example")\n```');
  });

  it('sends pasted files to the upload and inserts nothing itself', () => {
    const e = setup('x', 1);
    const file = new File(['png'], 'shot.png', { type: 'image/png' });
    expect(e.paste({ files: [file], plain: 'shot.png' })).toBe(true);
    expect(e.uploads).toEqual([[file]]);
    expect(e.text()).toBe('x');
  });

  it('leaves a lone address to the ordinary paste when nothing is selected', () => {
    const e = setup('See ', 4);
    e.paste({ plain: 'https://example.com', html: '<a href="https://example.com">https://example.com</a>' });
    expect(e.text()).toBe('See https://example.com');
  });
});
