// @vitest-environment jsdom
/**
 * Where a search runs (src/lib/search.ts): an encrypted library is searched on this device, from the
 * decrypted copy of every note (library.ts), filters and all, and the server never sees the words.
 * Otherwise the server's index finds the words and the filters are applied here; a query of filters
 * alone doesn't go to the server. A search can be cancelled while it waits.
 */
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { encryptText, newMasterKey } from '../../src/lib/crypto';

window.matchMedia ??= ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;

const NOW = 1_700_000_000_000;

let apiMod: typeof import('../../src/lib/api');
let store: typeof import('../../src/lib/store');
let search: typeof import('../../src/lib/search');
let e2ee: typeof import('../../src/lib/e2ee');
let key: CryptoKey;

/* --------------------------------------------------- stand-in server --- */

interface Req {
  method: string;
  path: string;
  query: URLSearchParams;
  body: Record<string, any> | undefined;
}
interface Note {
  id: string;
  folder_id: string | null;
  title: string;
  excerpt: string;
  info: Record<string, unknown>;
  tags: string[];
  pinned: boolean;
  version: number;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
  content: string;
}

/** Encrypted rows as the server keeps them (for the on-device search). */
const sealedRows = new Map<string, Record<string, unknown>>();
/** What the server's full-text index answers (unencrypted libraries). */
let serverHits: Array<{ id: string; title: string; folder_id: string | null; updated_at: number; tags: string[]; snippet: string }> = [];
let log: Req[] = [];
let holdSearch = false;

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

async function fakeFetch(input: string, init: RequestInit = {}) {
  const url = new URL(input, 'http://localhost');
  const req: Req = { method: init.method ?? 'GET', path: url.pathname, query: url.searchParams, body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined };
  log.push(req);
  if (req.path === '/api/search') {
    if (holdSearch) {
      // Waits until cancelled, like a slow request.
      await new Promise((_, reject) => {
        const signal = init.signal!;
        if (signal.aborted) reject(signal.reason);
        signal.addEventListener('abort', () => reject(signal.reason));
      });
    }
    return json(200, { results: serverHits.slice(0, Number(req.query.get('limit'))) });
  }
  if (req.path === '/api/notes/batch') {
    return json(200, { notes: (req.body!.ids as string[]).filter((id) => sealedRows.has(id)).map((id) => sealedRows.get(id)) });
  }
  return json(404, { error: 'no_route', message: 'No such route.' });
}

const searches = () => log.filter((r) => r.path === '/api/search');
const at = (id: string, f: string) => `lumen/1/note/${id}/${f}`;

/** A note in this device's list; with encryption on, also its ciphertext on the server. */
async function note(id: string, init: Partial<Note> = {}) {
  const n: Note = {
    id,
    folder_id: null,
    title: id,
    excerpt: '',
    info: {},
    tags: [],
    pinned: false,
    version: 1,
    created_at: NOW,
    updated_at: NOW,
    deleted_at: null,
    content: '',
    ...init,
  };
  const { content, ...meta } = n;
  store.upsertMeta({ ...meta, excerpt: n.excerpt || content.slice(0, 60) });
  if (apiMod.currentCodec()) {
    sealedRows.set(id, {
      ...meta,
      title: '',
      tags: [],
      enc: true,
      kgen: 0,
      content: await encryptText(key, content, at(id, 'content')),
      sealed: {
        t: await encryptText(key, n.title, at(id, 'title')),
        g: await encryptText(key, JSON.stringify(n.tags), at(id, 'tags')),
        p: await encryptText(key, JSON.stringify({ v: 6, e: n.excerpt, i: n.info, l: { n: [], w: [] } }), at(id, 'preview')),
      },
    });
  }
  return n;
}

const hit = (id: string, updated_at = NOW) => ({ id, title: id, folder_id: null, updated_at, tags: [], snippet: '' });
const ids = (hits: Array<{ id: string }>) => hits.map((h) => h.id);

function unlock() {
  apiMod.setKeyGen(0);
  apiMod.setCodec(e2ee.createCodec(key));
}

beforeAll(async () => {
  key = await newMasterKey();
});

beforeEach(async () => {
  vi.stubGlobal('indexedDB', new IDBFactory());
  vi.stubGlobal('BroadcastChannel', undefined);
  vi.stubGlobal('fetch', fakeFetch);
  localStorage.clear();
  sealedRows.clear();
  serverHits = [];
  log = [];
  holdSearch = false;
  vi.resetModules();
  apiMod = await import('../../src/lib/api');
  store = await import('../../src/lib/store');
  search = await import('../../src/lib/search');
  e2ee = await import('../../src/lib/e2ee');
  store.useApp.setState({
    status: 'ready',
    folders: [
      { id: 'proj', parent_id: null, name: 'Projects', sort: 0, created_at: NOW, updated_at: NOW },
      { id: 'clients', parent_id: 'proj', name: 'Clients', sort: 0, created_at: NOW, updated_at: NOW },
      { id: 'home', parent_id: null, name: 'Home stuff', sort: 0, created_at: NOW, updated_at: NOW },
    ],
  });
});

afterEach(() => {
  apiMod.setCodec(null);
  store.useApp.setState({ status: 'loading', notes: {} });
  vi.unstubAllGlobals();
});

/* ------------------------------------------------------------ tests --- */

describe('a library that isn’t encrypted', () => {
  it('asks nothing for an empty query, or one of punctuation alone', async () => {
    expect(await search.searchNotes('')).toEqual([]);
    expect(await search.searchNotes('  - & ')).toEqual([]);
    expect(searches()).toEqual([]);
  });

  it('sends the words to the server’s index and shows what it finds, leaving out notes in the trash', async () => {
    await note('a');
    await note('t', { deleted_at: NOW });
    serverHits = [hit('a'), hit('t'), hit('unlisted')];
    const hits = await search.searchNotes('budget "next quarter" -draft');
    expect(searches()[0].query.get('q')).toBe('budget "next quarter" -draft');
    expect(searches()[0].query.get('limit')).toBe('40');
    expect(ids(hits)).toEqual(['a', 'unlisted']);
  });

  it('applies filters here to what the server finds, asking it for more', async () => {
    await note('w1', { tags: ['work'] });
    await note('w2', { tags: ['work/clients'] });
    await note('h1', { tags: ['home'] });
    serverHits = [hit('h1'), hit('w1'), hit('unlisted'), hit('w2')];
    const hits = await search.searchNotes('budget tag:work', { limit: 1 });
    expect(searches()[0].query.get('q')).toBe('budget');
    expect(searches()[0].query.get('limit')).toBe('100');
    expect(ids(hits)).toEqual(['w1']);
    expect(ids(await search.searchNotes('budget #work'))).toEqual(['w1', 'w2']);
  });

  it('keeps a search inside the folder it was made from (Only in …)', async () => {
    await note('in', { folder_id: 'clients' });
    await note('out', { folder_id: 'home' });
    serverHits = [hit('in'), hit('out'), hit('unlisted')];
    const hits = await search.searchNotes('budget', { scope: (n) => n.folder_id === 'clients' });
    expect(searches()[0].query.get('limit')).toBe('100');
    expect(ids(hits)).toEqual(['in']);
  });

  it('answers a query of filters alone from the note list, newest first, without asking the server', async () => {
    await note('old', { folder_id: 'proj', pinned: true, updated_at: NOW - 10 });
    await note('new', { folder_id: 'clients', pinned: true, updated_at: NOW });
    await note('loose', { pinned: true });
    await note('trashed', { folder_id: 'proj', pinned: true, deleted_at: NOW });
    await note('unpinned', { folder_id: 'proj' });
    expect(ids(await search.searchNotes('in:Projects is:pinned'))).toEqual(['new', 'old']);
    expect(ids(await search.searchNotes('in:Projects/Clients'))).toEqual(['new']);
    expect(ids(await search.searchNotes('in:"Home stuff"'))).toEqual([]);
    expect(ids(await search.searchNotes('is:pinned -in:Projects'))).toEqual(['loose']);
    expect(searches()).toEqual([]);
  });

  it('leaves out words with - when listing by filters alone, from the titles, tags and previews it knows', async () => {
    await note('a', { title: 'Draft budget', tags: ['work'] });
    await note('b', { title: 'Budget', tags: ['work'], excerpt: 'final' });
    await note('c', { title: 'Plan', tags: ['work', 'draft'] });
    expect(ids(await search.searchNotes('tag:work -draft'))).toEqual(['b']);
    expect(searches()).toEqual([]);
  });

  it('leaves out, with -, only notes with a word starting with it, as a search for that word would find', async () => {
    await note('a', { title: 'Start here', tags: ['work'] });
    await note('b', { title: 'Art supplies', tags: ['work'] });
    expect(ids(await search.searchNotes('tag:work -art'))).toEqual(['a']);
  });

  it('finds notes with open or done tasks, images, drawings and diagrams from what the list knows', async () => {
    await note('open', { info: { t: [1, 3] } });
    await note('done', { info: { t: [2, 2] } });
    await note('pic', { info: { th: '/api/files/abcdef/x.png' } });
    await note('drawn', { info: { dr: 1 } });
    await note('chart', { info: { d: 2 } });
    expect(ids(await search.searchNotes('has:task')).sort()).toEqual(['open']);
    expect(ids(await search.searchNotes('has:done')).sort()).toEqual(['done', 'open']);
    expect(ids(await search.searchNotes('has:image'))).toEqual(['pic']);
    expect(ids(await search.searchNotes('has:drawing'))).toEqual(['drawn']);
    expect(ids(await search.searchNotes('has:diagrams'))).toEqual(['chart']);
  });

  it('can be cancelled while it waits, without the app thinking it’s offline', async () => {
    holdSearch = true;
    const ctl = new AbortController();
    const pending = search.searchNotes('budget', { signal: ctl.signal });
    await vi.waitFor(() => expect(searches()).toHaveLength(1));
    ctl.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(store.useApp.getState().online).toBe(true);
  });
});

describe('an encrypted library', () => {
  it('is searched on this device: the server never sees the words', async () => {
    unlock();
    await note('a', { title: 'Groceries', content: 'buy oat milk and bread' });
    await note('b', { title: 'Work', content: 'quarterly budget review' });
    const hits = await search.searchNotes('milk');
    expect(ids(hits)).toEqual(['a']);
    expect(hits[0].snippet).toContain('\u0001milk\u0002');
    expect(searches()).toEqual([]);
    expect(JSON.stringify(log)).not.toContain('milk');
  });

  it('finds words at the start of words in the text, every word, ranking title matches first', async () => {
    unlock();
    await note('body', { title: 'Notes', content: 'the budget for next year' });
    await note('title', { title: 'Budget', content: 'numbers for next year' });
    await note('half', { title: 'Other', content: 'budget only' });
    expect(ids(await search.searchNotes('budg year'))).toEqual(['title', 'body']);
    expect(ids(await search.searchNotes('udget'))).toEqual([]);
  });

  it('matches "exact words" as whole words in order, across line breaks', async () => {
    unlock();
    await note('a', { content: 'plans for next\nquarter here' });
    await note('b', { content: 'next quarterly report' });
    expect(ids(await search.searchNotes('"next quarter"'))).toEqual(['a']);
  });

  it('leaves out notes with a word after -, read from their full text, as the start of a word', async () => {
    unlock();
    await note('a', { content: 'budget, still a draft in the body' });
    await note('b', { content: 'budget, final' });
    await note('c', { content: 'budget for the redraft' });
    expect(ids(await search.searchNotes('budget -draft')).sort()).toEqual(['b', 'c']);
    expect(ids(await search.searchNotes('budget -"still a draft"')).sort()).toEqual(['b', 'c']);
  });

  it('applies filters and the scope on this device, and leaves out the trash', async () => {
    unlock();
    await note('w', { tags: ['work'], content: 'budget', folder_id: 'clients' });
    await note('h', { tags: ['home'], content: 'budget', folder_id: 'clients' });
    await note('t', { tags: ['work'], content: 'budget', deleted_at: NOW });
    await note('x', { tags: ['work'], content: 'budget', folder_id: 'home' });
    expect(ids(await search.searchNotes('budget tag:work')).sort()).toEqual(['w', 'x']);
    expect(ids(await search.searchNotes('budget tag:work', { scope: (n) => n.folder_id === 'clients' }))).toEqual(['w']);
    expect(searches()).toEqual([]);
  });

  it('lists a query of filters alone from the note list without reading any note’s text', async () => {
    unlock();
    await note('a', { pinned: true, updated_at: NOW - 5 });
    await note('b', { pinned: true, updated_at: NOW });
    await note('c');
    expect(ids(await search.searchNotes('is:pinned'))).toEqual(['b', 'a']);
    expect(log).toEqual([]);
  });

  it('falls back to the preview of a note whose text can’t be read', async () => {
    unlock();
    await note('a', { content: 'ok' });
    await note('bad', { excerpt: 'preview mentions zebra' });
    sealedRows.get('bad')!.content = 'e1:not-really-ciphertext';
    expect(ids(await search.searchNotes('zebra'))).toEqual(['bad']);
  });

  it('can be cancelled: a cancelled search gives no results', async () => {
    unlock();
    await note('a', { content: 'budget' });
    const ctl = new AbortController();
    const pending = search.searchNotes('budget', { signal: ctl.signal });
    ctl.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('keeps to the limit', async () => {
    unlock();
    for (let i = 0; i < 5; i++) await note(`n${i}`, { content: 'common word', updated_at: NOW + i });
    expect(ids(await search.searchNotes('common', { limit: 2 }))).toEqual(['n4', 'n3']);
  });
});
