// @vitest-environment jsdom
/**
 * Encrypted previews made by an earlier version of Lumen (no `v`, tasks counted the old way, links
 * inside code counted) are remade from each note's text on the device and stored, without touching the
 * note itself. Runs the app's real API client, codec and on-device copy against a stubbed server.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { decryptText, encryptText, newMasterKey } from '../../src/lib/crypto';

let key: CryptoKey;
let sent: Array<{ id: string; version: number; p: string }> = [];

const NOW = 1_700_000_000_000;
const TEXT = '1. [ ] numbered task\n- [x] done\n\nSee [[Real]] but not `[[In Code]]`.';

async function oldNote(id: string) {
  const at = (f: string) => `lumen/1/note/${id}/${f}`;
  // A preview as Lumen wrote it before: no version, the numbered task and the link in code counted.
  const oldPreview = JSON.stringify({ e: 'old', i: { t: [1, 1] }, l: { n: [], w: ['real', 'in code'] } });
  return {
    id,
    folder_id: null,
    title: '',
    excerpt: '',
    info: {},
    tags: [],
    pinned: false,
    version: 4,
    created_at: NOW,
    updated_at: NOW,
    deleted_at: null,
    enc: true,
    content: await encryptText(key, TEXT, at('content')),
    sealed: {
      t: await encryptText(key, 'Old note', at('title')),
      g: await encryptText(key, '[]', at('tags')),
      p: await encryptText(key, oldPreview, at('preview')),
    },
  };
}

beforeEach(() => {
  localStorage.clear();
  vi.resetModules();
  sent = [];
});

afterEach(() => vi.unstubAllGlobals());

describe('out-of-date previews', () => {
  it('are remade from the note’s text, counting tasks and links as now', async () => {
    key = await newMasterKey();
    const note = await oldNote('old1234567');
    const { content: _c, ...meta } = note;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (path: string, init: RequestInit = {}) => {
        const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
        if (path === '/api/bootstrap') {
          return json({ me: {}, notes: [meta], folders: [], encryption: { on: true, pending: { notes: 0, versions: 0, folders: 0 }, gen: 0 }, serverTime: NOW });
        }
        if (path === '/api/notes/batch') return json({ notes: [note] });
        if (path === '/api/notes/previews') {
          sent = JSON.parse(String(init.body)).notes;
          return json({ updated: sent.map((n) => n.id) });
        }
        return new Response(JSON.stringify({ error: 'not_found', message: 'Not found.' }), { status: 404, headers: { 'content-type': 'application/json' } });
      }),
    );
    const { setCodec } = await import('../../src/lib/api');
    const e2ee = await import('../../src/lib/e2ee');
    const { syncLibrary } = await import('../../src/lib/library');
    const { loadAll, useApp } = await import('../../src/lib/store');
    setCodec(e2ee.createCodec(key));
    await loadAll(true);
    expect(useApp.getState().notes.old1234567.pv).toBe(1);

    await syncLibrary();
    await e2ee.refreshStalePreviews();

    expect(sent.map((n) => [n.id, n.version])).toEqual([['old1234567', 4]]);
    const preview = JSON.parse(await decryptText(key, sent[0].p, 'lumen/1/note/old1234567/preview'));
    expect(preview).toMatchObject({ v: 6, i: { t: [1, 2] }, l: { n: [], w: ['real'] } });
    const updated = useApp.getState().notes.old1234567;
    expect(updated).toMatchObject({ pv: 6, info: { t: [1, 2] }, links: { n: [], w: ['real'] } });

    // Nothing more to do once they're current.
    sent = [];
    await e2ee.refreshStalePreviews();
    expect(sent).toEqual([]);
  });
});
