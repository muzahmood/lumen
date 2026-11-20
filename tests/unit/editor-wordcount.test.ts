/**
 * The word count shown for a selection (wordCount in src/lib/utils.ts, fed the selected text by the
 * editor and by reading view): words as a reader counts them, whatever Markdown is around them.
 */
import { describe, expect, it } from 'vitest';
import { wordCount } from '../../src/lib/utils';

describe('word count of a selection', () => {
  it('counts words, not Markdown symbols', () => {
    expect(wordCount('## Plans for **next** week')).toBe(4);
    expect(wordCount('- [x] call Sam\n  - [X] buy milk\n* [ ] go')).toBe(5);
    expect(wordCount('- one\n+ two\n* three')).toBe(3);
    expect(wordCount('==highlighted== and ~~struck~~ and `code`')).toBe(5);
    expect(wordCount('| a | b |\n|---|---|')).toBe(2);
    expect(wordCount('---\n\n***')).toBe(0);
  });

  it('doesn’t count the numbers of a numbered list', () => {
    expect(wordCount('1. one\n2) two\n10. [x] ten')).toBe(3);
  });

  it('doesn’t count the x of ticked tasks inside quotes and callouts', () => {
    expect(wordCount('> - [x] call Sam\n> - [X] buy milk')).toBe(4);
  });

  it('keeps apostrophes inside words, straight or curly', () => {
    expect(wordCount("don't won’t it's")).toBe(3);
  });

  it('counts link text, and leaves images and fenced code out', () => {
    expect(wordCount('See [the docs](https://example.com) now')).toBe(4);
    expect(wordCount('![a chart of sales](/api/files/abcdef12/c.png) Done')).toBe(1);
    expect(wordCount('Before\n```js\nconst a = 1;\n```\nafter')).toBe(2);
  });

  it('counts a partial selection’s fragments, and nothing in blank space', () => {
    expect(wordCount('lo wor')).toBe(2);
    expect(wordCount(' \n\t ')).toBe(0);
    expect(wordCount('')).toBe(0);
  });

  it('counts words in other alphabets', () => {
    expect(wordCount('Привет мир')).toBe(2);
    expect(wordCount('Γειά σου κόσμε')).toBe(3);
    expect(wordCount('café naïve über')).toBe(3);
  });

  it('keeps combining marks inside their word', () => {
    expect(wordCount('नमस्ते दुनिया')).toBe(2);
    expect(wordCount('مُحَمَّد رَسُول')).toBe(2);
    // "café naïve" with each accent as its own character (decomposed, as macOS and some keyboards write it).
    expect(wordCount('café naïve')).toBe(2);
  });
});
