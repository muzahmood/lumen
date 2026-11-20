// @vitest-environment jsdom
/**
 * [[Wiki links]] in reading view (src/lib/markdown.ts): resolved to the note with that title, to a
 * heading in it, with a label of their own, or offered as a note to create. Titles are whatever a
 * person typed, so odd characters must come through as text.
 */
import { describe, expect, it } from 'vitest';
import { renderMarkdown, type RenderEnv } from '../../src/lib/markdown';

const NOTES: Record<string, string> = { 'garden plan': 'garden12345', budget: 'budget12345' };

function render(src: string, env: RenderEnv = {}) {
  const asked: string[] = [];
  const html = renderMarkdown(src, {
    resolveTitle: (t) => {
      asked.push(t);
      return NOTES[t.toLowerCase()] ?? null;
    },
    ...env,
  });
  const div = document.createElement('div');
  div.innerHTML = html;
  return { div, asked, links: [...div.querySelectorAll<HTMLAnchorElement>('a.kb-wikilink')] };
}

describe('wiki links', () => {
  it('open the note with that title, matched by the resolver', () => {
    const { links, asked } = render('See [[Garden plan]] and [[ budget ]].');
    expect(links.map((a) => [a.getAttribute('href'), a.dataset.noteId, a.textContent])).toEqual([
      ['/note/garden12345', 'garden12345', 'Garden plan'],
      ['/note/budget12345', 'budget12345', 'budget'],
    ]);
    // The resolver gets the bare title: trimmed, without heading or label.
    expect(asked).toEqual(['Garden plan', 'budget']);
    expect(links[0].classList.contains('is-missing')).toBe(false);
  });

  it('land on a heading, with or without a label of their own', () => {
    const { links, asked } = render('[[Garden plan#Spring Beds]] [[Garden plan#Spring Beds|beds]] [[Budget|the budget]]');
    expect(links.map((a) => [a.getAttribute('href'), a.textContent])).toEqual([
      ['/note/garden12345#h-spring-beds', 'Garden plan#Spring Beds'],
      ['/note/garden12345#h-spring-beds', 'beds'],
      ['/note/budget12345', 'the budget'],
    ]);
    expect(asked).toEqual(['Garden plan', 'Garden plan', 'Budget']);
  });

  it('point at the same id the heading gets in that note', () => {
    const heading = renderMarkdown('## Café & Crème: “Notes”!');
    const id = /id="([^"]+)"/.exec(heading)![1];
    const { links } = render('[[Garden plan#Café & Crème: "Notes"!]]');
    expect(links[0].getAttribute('href')).toBe(`/note/garden12345#${id}`);
  });

  it('reach headings whose dashes were curled by typography', () => {
    const heading = renderMarkdown('## Pros -- cons');
    const id = /id="([^"]+)"/.exec(heading)![1];
    const { links } = render('[[Garden plan#Pros -- cons]]');
    expect(links[0].getAttribute('href')).toBe(`/note/garden12345#${id}`);
  });

  it('offer to create a note that doesn’t exist yet, by its bare title', () => {
    const { links } = render('[[New idea#Part two|later]]');
    const a = links[0];
    expect(a.classList.contains('is-missing')).toBe(true);
    expect(a.getAttribute('href')).toBe('#');
    expect(a.dataset.wikilinkNew).toBe('New idea');
    expect(a.title).toBe('Create this note');
    expect(a.textContent).toBe('later');
  });

  it('carry odd titles and labels through as text', () => {
    const odd = ['<img src=x onerror=alert(1)>', 'Tom & "Jerry" \'s', '50% of $5', 'a > b < c', '🙂 emoji note', 'Ünïcödé'];
    for (const title of odd) {
      const { div, links } = render(`[[${title}]]`);
      expect(links, title).toHaveLength(1);
      expect(links[0].dataset.wikilinkNew, title).toBe(title);
      expect(links[0].textContent, title).toBe(title);
      expect(div.querySelector('img'), title).toBeNull();
      expect(links[0].getAttributeNames().sort(), title).toEqual(['class', 'data-wikilink-new', 'href', 'title']);
    }
    const { div, links } = render('[[Budget|<b onclick="x()">bold</b> & co]]');
    expect(links[0].textContent).toBe('<b onclick="x()">bold</b> & co');
    expect(div.querySelector('b')).toBeNull();
  });

  it('take the first | as the label and the first # as the heading', () => {
    const { links } = render('[[Budget|a|b]] [[Garden plan#One#Two]]');
    expect(links[0].textContent).toBe('a');
    expect(links[1].getAttribute('href')).toBe('/note/garden12345#h-one');
  });

  it('are left as text in code, when escaped, empty, or broken across lines', () => {
    const { links, asked } = render('`[[Budget]]`\n\n```\n[[Budget]]\n```\n\n\\[[Budget]]\n\n[[ ]] [[]]\n\n[[Budget\nplan]]');
    expect(links).toHaveLength(0);
    expect(asked).toEqual([]);
  });

  it('work inside emphasis, lists, quotes, callouts and headings', () => {
    const { links } = render('*see [[Budget]]*\n\n- [[Budget]]\n\n> [!note] Title\n> [[Budget]]\n\n### About [[Budget]]');
    expect(links).toHaveLength(4);
    for (const a of links) expect(a.dataset.noteId).toBe('budget12345');
  });

  it('only resolve when a resolver is given', () => {
    const div = document.createElement('div');
    div.innerHTML = renderMarkdown('[[Budget]]');
    expect(div.querySelector('a')!.classList.contains('is-missing')).toBe(true);
  });
});
