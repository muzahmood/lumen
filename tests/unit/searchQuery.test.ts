import { describe, expect, it } from 'vitest';
import { foldersNamed, noteFilter, parseQuery, serverText } from '../../src/lib/searchQuery';
import type { Folder, NoteMeta } from '../../src/lib/types';

describe('reading a search', () => {
  it('separates words, phrases, filters and what to leave out', () => {
    expect(parseQuery('budget "next quarter" tag:Work #urgent -draft -"old plan" in:"Home stuff" is:Pinned has:tasks')).toEqual({
      words: ['budget'],
      phrases: ['next quarter'],
      without: ['draft', 'old plan'],
      filters: [
        { kind: 'tag', value: 'Work', not: false },
        { kind: 'tag', value: 'urgent', not: false },
        { kind: 'in', value: 'Home stuff', not: false },
        { kind: 'is', value: 'pinned', not: false },
        { kind: 'has', value: 'task', not: false },
      ],
    });
  });

  it('negates filters, and keeps unknown ones and links as words', () => {
    const q = parseQuery('-tag:draft -is:pinned is:nothing see:also https://x.test/a -');
    expect(q.filters).toEqual([
      { kind: 'tag', value: 'draft', not: true },
      { kind: 'is', value: 'pinned', not: true },
    ]);
    expect(q.words).toEqual(['is:nothing', 'see:also', 'https://x.test/a']);
  });

  it('matches a quoted word as a whole word, and ignores what names nothing', () => {
    // in:/ and tag:# name no folder or tag, so they're read as text rather than matching everything.
    expect(parseQuery('"plan" "-foo" "!!!" in:/ tag:#')).toEqual({ words: ['in:/', 'tag:#'], phrases: ['plan', '-foo'], without: [], filters: [] });
    expect(serverText(parseQuery('"-foo"'))).toBe('"-foo"');
  });

  it('copes with a quote still being typed', () => {
    expect(parseQuery('"half typed').phrases).toEqual(['half typed']);
    expect(parseQuery('in:"Home st').filters).toEqual([{ kind: 'in', value: 'Home st', not: false }]);
  });

  it('gives the server only the text, quoted as it reads it', () => {
    expect(serverText(parseQuery('budget "next quarter" -draft -"old plan" tag:x'))).toBe('budget "next quarter" -draft -"old plan"');
  });
});

const folder = (id: string, name: string, parent_id: string | null = null) => ({ id, name, parent_id }) as Folder;
const folders = [folder('p', 'Projects'), folder('c', 'Clients', 'p'), folder('a', 'Acme', 'c'), folder('h', 'Home stuff'), folder('c2', 'Clients', 'h')];

describe('folders by name', () => {
  it('match a name with everything inside it, a path, or the start of a name', () => {
    expect([...foldersNamed(folders, 'projects')].sort()).toEqual(['a', 'c', 'p']);
    expect([...foldersNamed(folders, 'Clients')].sort()).toEqual(['a', 'c', 'c2']);
    expect([...foldersNamed(folders, 'projects/clients')].sort()).toEqual(['a', 'c']);
    expect([...foldersNamed(folders, 'home')]).toEqual(['h', 'c2']);
    expect(foldersNamed(folders, 'nowhere').size).toBe(0);
  });
});

describe('filtering notes', () => {
  const note = (id: string, fields: Partial<NoteMeta>) => ({ id, title: id, tags: [], folder_id: null, pinned: false, ...fields }) as NoteMeta;
  const notes = [
    note('a', { tags: ['work/clients'], folder_id: 'a', info: { t: [1, 3] } }),
    note('b', { tags: ['Work'], pinned: true, info: { th: '/api/files/x/p.png', t: [2, 2] } }),
    note('c', { tags: ['home'], folder_id: 'h', info: { d: 1, dr: 2 } }),
  ];
  const ctx = { folders, isJournal: (n: NoteMeta) => n.id === 'c', isTemplate: () => false };
  const run = (q: string) => notes.filter(noteFilter(parseQuery(q), ctx)).map((n) => n.id);

  it('by tag (with the tags under it), folder, kind and contents', () => {
    expect(run('tag:work')).toEqual(['a', 'b']);
    expect(run('#WORK/clients')).toEqual(['a']);
    expect(run('in:projects')).toEqual(['a']);
    expect(run('is:pinned')).toEqual(['b']);
    expect(run('is:journal')).toEqual(['c']);
    expect(run('has:task')).toEqual(['a']);
    expect(run('has:done')).toEqual(['a', 'b']);
    expect(run('has:image')).toEqual(['b']);
    expect(run('has:drawing has:diagram')).toEqual(['c']);
  });

  it('leaving out what a negated filter matches, all filters together', () => {
    expect(run('tag:work -is:pinned')).toEqual(['a']);
    expect(run('-tag:work -in:home')).toEqual([]);
    expect(run('-has:task')).toEqual(['b', 'c']);
  });
});
