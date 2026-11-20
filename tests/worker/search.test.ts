/** Full-text search (SQLite FTS5) and backlinks. */
import { describe, expect, it } from 'vitest';
import { del, get, newNote, patch, post } from './helpers';

const search = async (q: string) => (await get(`/search?q=${encodeURIComponent(q)}`)).body.results as Array<{ id: string; snippet: string; tags: string[] }>;

describe('search', () => {
  it('finds words in titles, bodies and tags, by prefix, ignoring accents', async () => {
    const a = await newNote({ title: 'Quarterly planning', content: 'Budget for the café opening', tags: ['finance'] });
    expect((await search('quarter')).map((r) => r.id)).toContain(a.id);
    expect((await search('cafe')).map((r) => r.id)).toContain(a.id);
    expect((await search('#finance')).map((r) => r.id)).toContain(a.id);
    expect((await search('budget opening')).map((r) => r.id)).toContain(a.id);
    expect((await search('budget nonsenseword')).map((r) => r.id)).not.toContain(a.id);
    const hit = (await search('budget')).find((r) => r.id === a.id)!;
    expect(hit.snippet).toContain('\u0001Budget\u0002');
    expect(hit.tags).toEqual(['finance']);
  });

  it('matches "phrases" in order, and leaves out words after a minus', async () => {
    const a = await newNote({ title: 'Plan', content: 'the next quarter budget' });
    const b = await newNote({ title: 'Plan draft', content: 'quarter next, budget' });
    const ids = async (q: string) => (await search(q)).map((r) => r.id);
    expect(await ids('"next quarter"')).toContain(a.id);
    expect(await ids('"next quarter"')).not.toContain(b.id);
    expect(await ids('budget -draft')).toContain(a.id);
    expect(await ids('budget -draft')).not.toContain(b.id);
    expect(await ids('plan -"next quarter"')).toContain(b.id);
    expect(await ids('plan -"next quarter"')).not.toContain(a.id);
    // Only things to leave out: nothing to search for.
    expect(await ids('-draft')).toEqual([]);
  });

  it('survives query syntax in what the user types', async () => {
    await newNote({ content: 'plain words here' });
    for (const q of ['"', '"unclosed', 'a AND', 'NEAR(', '*', '-x', 'col:val', '(()', "'; DROP TABLE notes; --", '\\', '\u0000']) {
      const res = await get(`/search?q=${encodeURIComponent(q)}`);
      expect(res.status, q).toBe(200);
    }
    expect((await get('/search?q=')).body.results).toEqual([]);
  });

  it('follows edits and deletions, and leaves out the trash', async () => {
    const n = await newNote({ content: 'zebrafish' });
    await patch(`/notes/${n.id}`, { content: 'axolotl' });
    expect((await search('zebrafish')).map((r) => r.id)).not.toContain(n.id);
    expect((await search('axolotl')).map((r) => r.id)).toContain(n.id);
    await post(`/notes/${n.id}/trash`);
    expect((await search('axolotl')).map((r) => r.id)).not.toContain(n.id);
    await post(`/notes/${n.id}/restore`);
    expect((await search('axolotl')).map((r) => r.id)).toContain(n.id);
    await del(`/notes/${n.id}`);
    expect((await search('axolotl')).map((r) => r.id)).not.toContain(n.id);
  });

  it('clamps the result limit', async () => {
    for (let i = 0; i < 4; i++) await newNote({ content: `limitword ${i}` });
    expect((await get('/search?q=limitword&limit=2')).body.results).toHaveLength(2);
    expect((await get('/search?q=limitword&limit=-5')).body.results.length).toBeGreaterThanOrEqual(1);
    expect((await get('/search?q=limitword&limit=abc')).body.results.length).toBeGreaterThanOrEqual(4);
  });
});

describe('backlinks', () => {
  it('lists notes linking by id, by [[title]], [[title|alias]] and [[title#heading]]', async () => {
    const target = await newNote({ title: 'Garden plan (2026)', content: 'beds' });
    const byId = await newNote({ title: 'By id', content: `See [it](/note/${target.id}).` });
    const byWiki = await newNote({ title: 'By wiki', content: 'See [[Garden plan (2026)]].' });
    const byAlias = await newNote({ title: 'By alias', content: 'See [[ garden plan (2026) |the plan]].' });
    const byHeading = await newNote({ title: 'By heading', content: 'See [[Garden plan (2026)#Beds]].' });
    const mention = await newNote({ title: 'Mention only', content: 'Garden plan (2026) mentioned but not linked.' });
    const trashed = await newNote({ title: 'Trashed', content: 'See [[Garden plan (2026)]].' });
    await post(`/notes/${trashed.id}/trash`);
    const res = await get(`/notes/${target.id}/backlinks`);
    const ids = res.body.backlinks.map((b: { id: string }) => b.id);
    expect(ids.sort()).toEqual([byId.id, byWiki.id, byAlias.id, byHeading.id].sort());
    expect(ids).not.toContain(mention.id);
    expect(res.body.backlinks[0]).not.toHaveProperty('content');
  });

  it('still finds id links when the title has no searchable words', async () => {
    const target = await newNote({ title: '!!!', content: 'x' });
    const linker = await newNote({ content: `[go](/note/${target.id})` });
    const ids = (await get(`/notes/${target.id}/backlinks`)).body.backlinks.map((b: { id: string }) => b.id);
    expect(ids).toContain(linker.id);
  });

  it('404s for a missing note', async () => {
    expect((await get('/notes/missingnote1/backlinks')).status).toBe(404);
  });
});
