// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { sharedNote } from '../../src/lib/launch';

describe('a note from something shared into Lumen', () => {
  it('keeps the text and adds the link under its title', () => {
    expect(sharedNote({ title: 'An article', text: 'Worth reading later', url: 'https://example.com/a' }, [])).toEqual({
      title: 'An article',
      content: 'Worth reading later\n\n[An article](https://example.com/a)\n',
    });
  });

  it('reads a link shared as the text as a link, titled by its site', () => {
    expect(sharedNote({ title: '', text: 'https://www.example.com/post/1', url: '' }, [])).toEqual({
      title: 'example.com',
      content: '<https://www.example.com/post/1>\n',
    });
  });

  it('doesn’t repeat a link the text already has, and titles a note by its first line', () => {
    const note = sharedNote({ title: '', text: '# Idea\nsee https://x.test', url: 'https://x.test' }, ['![photo](/api/files/abc/p.jpg)']);
    expect(note.title).toBe('Idea');
    expect(note.content).toBe('# Idea\nsee https://x.test\n\n![photo](/api/files/abc/p.jpg)\n');
  });

  it('keeps an odd title or address from breaking the link, and only links web addresses', () => {
    expect(sharedNote({ title: 'Notes [draft] \\', text: '', url: 'https://x.test/a b(c)' }, []).content).toBe('[Notes \\[draft\\] \\\\](<https://x.test/a%20b(c)>)\n');
    expect(sharedNote({ title: '[]', text: '', url: 'https://x.test/<p>' }, []).content).toBe('<https://x.test/%3Cp%3E>\n');
    expect(sharedNote({ title: 'Run', text: '', url: 'javascript:alert(1)' }, []).content).toBe('javascript:alert(1)\n');
    // A longer address in the text isn't the shared one.
    expect(sharedNote({ title: '', text: 'see https://x.com/page', url: 'https://x.com' }, []).content).toBe('see https://x.com/page\n\n<https://x.com>\n');
  });

  it('names files-only shares plainly', () => {
    expect(sharedNote({ title: '', text: '', url: '' }, ['[📎 a.pdf](/api/files/x/a.pdf)']).title).toBe('Shared');
  });
});
