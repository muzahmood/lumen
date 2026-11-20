/**
 * Every search filter README's "Finding" lists, alone and together: tag:, #tag, in: (a name, a quoted
 * name, a path), is:, has:, "phrases", -words and -filters, and a filter on its own.
 */
import { describe, expect, it } from 'vitest';
import { makeInfo } from '../../shared/noteText';
import { foldersNamed, hasText, isEmpty, noteFilter, parseQuery, serverText, type ParsedQuery } from '../../src/lib/searchQuery';
import type { Folder, NoteMeta } from '../../src/lib/types';

const filter = (kind: string, value: string, not = false) => ({ kind, value, not });

describe('reading each filter on its own', () => {
  const cases: Array<[string, ReturnType<typeof filter>]> = [
    ['tag:work', filter('tag', 'work')],
    ['#work', filter('tag', 'work')],
    ['##work', filter('tag', 'work')],
    ['tag:#work', filter('tag', 'work')],
    ['tag:work/clients', filter('tag', 'work/clients')],
    ['in:Projects', filter('in', 'Projects')],
    ['in:"Home stuff"', filter('in', 'Home stuff')],
    ['in:Projects/Clients', filter('in', 'Projects/Clients')],
    ['in:"Home stuff/Bills"', filter('in', 'Home stuff/Bills')],
    ['is:pinned', filter('is', 'pinned')],
    ['is:journal', filter('is', 'journal')],
    ['is:template', filter('is', 'template')],
    ['has:task', filter('has', 'task')],
    ['has:done', filter('has', 'done')],
    ['has:image', filter('has', 'image')],
    ['has:drawing', filter('has', 'drawing')],
    ['has:diagram', filter('has', 'diagram')],
    ['-tag:old', filter('tag', 'old', true)],
    ['-#old', filter('tag', 'old', true)],
    ['-in:"Home stuff"', filter('in', 'Home stuff', true)],
    ['-is:template', filter('is', 'template', true)],
    ['-has:image', filter('has', 'image', true)],
  ];
  for (const [typed, expected] of cases) {
    it(`reads ${typed} as a filter, and as a search of its own`, () => {
      const q = parseQuery(typed);
      expect(q).toEqual({ words: [], phrases: [], without: [], filters: [expected] });
      expect(hasText(q)).toBe(false);
      expect(isEmpty(q)).toBe(false);
      expect(serverText(q)).toBe('');
    });
  }

  it('reads the filter name in any case, and is: and has: values in any case or plural', () => {
    expect(parseQuery('TAG:Work Is:PINNED HAS:Images in:"X"').filters).toEqual([
      filter('tag', 'Work'),
      filter('is', 'pinned'),
      filter('has', 'image'),
      filter('in', 'X'),
    ]);
    expect(parseQuery('has:tasks has:diagrams has:drawings').filters.map((f) => f.value)).toEqual(['task', 'diagram', 'drawing']);
  });

  it('reads words, phrases and what to leave out', () => {
    expect(parseQuery('budget "next   quarter" -draft -"old  plan"')).toEqual({
      words: ['budget'],
      phrases: ['next quarter'],
      without: ['draft', 'old plan'],
      filters: [],
    });
  });

  it('is empty for nothing, spaces, or punctuation alone', () => {
    for (const typed of ['', '   ', '-', '- -', '""', '"  "', '#', '&', '!!!']) expect(isEmpty(parseQuery(typed)), typed).toBe(true);
  });
});

describe('reading filters together', () => {
  it('keeps every filter, word and phrase from one search', () => {
    expect(parseQuery('tag:work in:"Home stuff" -is:pinned has:task "exact words" -draft budget #urgent -tag:old')).toEqual({
      words: ['budget'],
      phrases: ['exact words'],
      without: ['draft'],
      filters: [
        filter('tag', 'work'),
        filter('in', 'Home stuff'),
        filter('is', 'pinned', true),
        filter('has', 'task'),
        filter('tag', 'urgent'),
        filter('tag', 'old', true),
      ],
    });
  });

  it('reads filters right next to quotes and words', () => {
    expect(parseQuery('in:"A B"tag:x').filters).toEqual([filter('in', 'A B'), filter('tag', 'x')]);
    expect(parseQuery('"one"two')).toMatchObject({ phrases: ['one'], words: ['two'] });
  });

  it('keeps unknown filters and addresses as words, quoted unknown ones as phrases', () => {
    const q = parseQuery('is:archived has:video see:also 12:30 https://x.test/a?b=c mailto:a@b.c');
    expect(q.filters).toEqual([]);
    expect(q.words).toEqual(['is:archived', 'has:video', 'see:also', '12:30', 'https://x.test/a?b=c', 'mailto:a@b.c']);
  });

  it('only reads the first 300 characters', () => {
    const q = parseQuery(`${'a '.repeat(150)}tag:late`);
    expect(q.filters).toEqual([]);
  });

  it('treats control characters as spaces', () => {
    expect(parseQuery('tag:work\u0000budget\ttag:home\nx').filters.map((f) => f.value)).toEqual(['work', 'home']);
  });

  it('gives the server words, phrases and exclusions only, quoting what has spaces', () => {
    expect(serverText(parseQuery('tag:x budget -draft "a b" -"c d" in:y'))).toBe('budget "a b" -draft -"c d"');
  });
});

describe('reading searches in other languages', () => {
  it('reads tags and folders in any script', () => {
    expect(parseQuery('#日本 in:Été tag:Ελλάδα').filters).toEqual([filter('tag', '日本'), filter('in', 'Été'), filter('tag', 'Ελλάδα')]);
  });

  it('keeps words and phrases in any script', () => {
    expect(parseQuery('Café "数据 分析" -Привет')).toEqual({ words: ['Café'], phrases: ['数据 分析'], without: ['Привет'], filters: [] });
  });
});

const folder = (id: string, name: string, parent_id: string | null = null) => ({ id, name, parent_id }) as Folder;
const folders = [
  folder('p', 'Projects'),
  folder('c', 'Clients', 'p'),
  folder('a', 'Acme', 'c'),
  folder('h', 'Home stuff'),
  folder('b', 'Bills', 'h'),
  folder('w', 'Work'),
  folder('ws', 'Workshop'),
  folder('e', 'Été'),
  folder('cafe', 'Café notes'),
];
const sorted = (s: Set<string>) => [...s].sort();

describe('which folders in: names', () => {
  it('prefers a folder named exactly over ones that start the same way', () => {
    expect(sorted(foldersNamed(folders, 'work'))).toEqual(['w']);
    expect(sorted(foldersNamed(folders, 'works'))).toEqual(['ws']);
  });

  it('matches names without regard to case or accents', () => {
    expect(sorted(foldersNamed(folders, 'ETE'))).toEqual(['e']);
    expect(sorted(foldersNamed(folders, 'cafe'))).toEqual(['cafe']);
  });

  it('matches a path from any level, and the start of its last name', () => {
    expect(sorted(foldersNamed(folders, 'Clients/Acme'))).toEqual(['a']);
    expect(sorted(foldersNamed(folders, 'projects/cli'))).toEqual(['a', 'c']);
    expect(sorted(foldersNamed(folders, '/Home stuff/Bills/'))).toEqual(['b']);
  });

  it('includes every folder inside the ones named', () => {
    expect(sorted(foldersNamed(folders, 'projects'))).toEqual(['a', 'c', 'p']);
  });

  it('copes with folders whose parents form a loop', () => {
    const loop = [folder('x', 'X', 'y'), folder('y', 'Y', 'x')];
    expect(sorted(foldersNamed(loop, 'x'))).toEqual(['x', 'y']);
  });
});

describe('which notes a search keeps', () => {
  const note = (id: string, fields: Partial<NoteMeta>) => ({ id, title: id, tags: [], folder_id: null, pinned: false, info: {}, ...fields }) as NoteMeta;
  const notes = [
    note('acme', { tags: ['work/clients'], folder_id: 'a', info: { t: [1, 3] } }),
    note('work', { tags: ['Work'], folder_id: 'w', pinned: true, info: { th: '/api/files/abcdef/p.png', t: [2, 2] } }),
    note('shop', { tags: ['workshop'], folder_id: 'ws', info: { d: 1 } }),
    note('bills', { tags: ['Café'], folder_id: 'b', info: { dr: 1 } }),
    note('loose', { tags: [], folder_id: null }),
    note('journal', { tags: ['journal'], folder_id: null }),
    note('tmpl', { tags: [], folder_id: 'p' }),
  ];
  const ctx = { folders, isJournal: (n: NoteMeta) => n.id === 'journal', isTemplate: (n: NoteMeta) => n.id === 'tmpl' };
  const run = (q: string) => notes.filter(noteFilter(parseQuery(q), ctx)).map((n) => n.id);

  it('keeps a tag and the tags under it, never a tag that only starts the same way', () => {
    expect(run('tag:work')).toEqual(['acme', 'work']);
    expect(run('#work/clients')).toEqual(['acme']);
    expect(run('tag:cafe')).toEqual(['bills']);
  });

  it('keeps notes in a folder and its subfolders, and leaves out notes in no folder', () => {
    expect(run('in:projects')).toEqual(['acme', 'tmpl']);
    expect(run('in:"Home stuff"')).toEqual(['bills']);
    expect(run('in:nowhere')).toEqual([]);
    expect(run('-in:projects')).toEqual(['work', 'shop', 'bills', 'loose', 'journal']);
  });

  it('keeps notes by kind', () => {
    expect(run('is:pinned')).toEqual(['work']);
    expect(run('is:journal')).toEqual(['journal']);
    expect(run('is:template')).toEqual(['tmpl']);
    expect(run('-is:template -is:journal -is:pinned')).toEqual(['acme', 'shop', 'bills', 'loose']);
  });

  it('keeps notes by what they hold, only open tasks counting for has:task', () => {
    expect(run('has:task')).toEqual(['acme']);
    expect(run('has:done')).toEqual(['acme', 'work']);
    expect(run('has:diagram')).toEqual(['shop']);
    expect(run('has:drawing')).toEqual(['bills']);
  });

  it('needs every filter to hold', () => {
    expect(run('tag:work in:projects has:task')).toEqual(['acme']);
    expect(run('tag:work is:pinned -has:task')).toEqual(['work']);
    expect(run('tag:work -tag:work')).toEqual([]);
  });

  it('keeps every note for a search with no filters', () => {
    expect(run('just words "and a phrase" -minus')).toHaveLength(notes.length);
  });

  it('copes with notes whose summary is missing', () => {
    const bare = { id: 'bare', title: '', tags: [], folder_id: null, pinned: false } as unknown as NoteMeta;
    for (const q of ['has:task', 'has:done', 'has:image', 'has:drawing', 'has:diagram']) {
      expect(noteFilter(parseQuery(q), ctx)(bare), q).toBe(false);
    }
  });
});

describe('has:image and has:drawing on real notes', () => {
  const ctx = { folders: [], isJournal: () => false, isTemplate: () => false };
  const keeps = (q: string, md: string) => noteFilter(parseQuery(q) as ParsedQuery, ctx)({ id: 'n', tags: [], folder_id: null, pinned: false, info: JSON.parse(makeInfo(md)) } as unknown as NoteMeta);

  it('finds a note with an uploaded image, and one with a drawing', () => {
    expect(keeps('has:image', '![photo](/api/files/abcdef12/photo.jpg)')).toBe(true);
    expect(keeps('has:drawing', '![sketch](/api/drawings/abcdef12.svg)')).toBe(true);
  });

  it('doesn’t take a note whose only picture is a drawing for one with an image', () => {
    expect(keeps('has:image', '![sketch](/api/drawings/abcdef12.svg)')).toBe(false);
  });

  it('doesn’t count a video as an image', () => {
    expect(keeps('has:image', '![clip](/api/files/abcdef12/clip.mp4)')).toBe(false);
  });
});
