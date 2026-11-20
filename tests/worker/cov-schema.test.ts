/**
 * The schema sets itself up (worker/schema.ts). Every other test file starts from an empty database,
 * so only the fresh-install path ever runs there; this one starts from a database made by the first
 * version of Lumen, with notes, history, files and drawings in it, the way a long-running copy is
 * upgraded when a new migration ships. It must run first in this file: the database is shared by
 * its tests, and the first request is what upgrades it.
 */
import { env } from 'cloudflare:workers';
import { describe, expect, it, vi } from 'vitest';
import { row, withEnv } from './api-helpers';
import { get, LOCAL, patch, post } from './helpers';

const NOW = 1_700_000_000_000;

/** Migration 1 as it was released (worker/schema.ts), and the version marker it left. */
const V1 = [
  `CREATE TABLE IF NOT EXISTS folders (id TEXT PRIMARY KEY, parent_id TEXT, name TEXT NOT NULL, sort INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS notes (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, folder_id TEXT, title TEXT NOT NULL DEFAULT '', content TEXT NOT NULL DEFAULT '', excerpt TEXT NOT NULL DEFAULT '', info TEXT NOT NULL DEFAULT '{}', tags TEXT NOT NULL DEFAULT '[]', pinned INTEGER NOT NULL DEFAULT 0, version INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER)`,
  `CREATE INDEX IF NOT EXISTS notes_folder_idx ON notes(folder_id)`,
  `CREATE INDEX IF NOT EXISTS notes_deleted_idx ON notes(deleted_at)`,
  `CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(title, content, tags, content='notes', content_rowid='seq', tokenize='unicode61 remove_diacritics 2')`,
  `CREATE TRIGGER IF NOT EXISTS notes_ai AFTER INSERT ON notes BEGIN INSERT INTO notes_fts(rowid, title, content, tags) VALUES (new.seq, new.title, new.content, new.tags); END`,
  `CREATE TRIGGER IF NOT EXISTS notes_ad AFTER DELETE ON notes BEGIN INSERT INTO notes_fts(notes_fts, rowid, title, content, tags) VALUES ('delete', old.seq, old.title, old.content, old.tags); END`,
  `CREATE TRIGGER IF NOT EXISTS notes_au AFTER UPDATE OF title, content, tags ON notes BEGIN INSERT INTO notes_fts(notes_fts, rowid, title, content, tags) VALUES ('delete', old.seq, old.title, old.content, old.tags); INSERT INTO notes_fts(rowid, title, content, tags) VALUES (new.seq, new.title, new.content, new.tags); END`,
  `CREATE TABLE IF NOT EXISTS note_versions (id INTEGER PRIMARY KEY AUTOINCREMENT, note_id TEXT NOT NULL, title TEXT NOT NULL, content TEXT NOT NULL, created_at INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS note_versions_idx ON note_versions(note_id, created_at)`,
  `CREATE TABLE IF NOT EXISTS files (id TEXT PRIMARY KEY, note_id TEXT, name TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL, storage TEXT NOT NULL, created_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS drawings (id TEXT PRIMARY KEY, note_id TEXT, rev TEXT NOT NULL, storage TEXT NOT NULL, text TEXT NOT NULL DEFAULT '', size INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS kb_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
  `INSERT INTO kb_meta (key, value) VALUES ('schema_version', '1')`,
];

const schemaVersion = async () => (await row<{ value: string }>(`SELECT value FROM kb_meta WHERE key = 'schema_version'`))?.value;
const columns = async (table: string) => (await env.DB.prepare(`PRAGMA table_info(${table})`).all<{ name: string }>()).results.map((c) => c.name);

/** The real database, except that batches fail (D1 overloaded, say). */
const failingBatches = () =>
  new Proxy(env.DB, {
    get(target, prop) {
      if (prop === 'batch') return () => Promise.reject(new Error('D1_ERROR: overloaded'));
      const value = Reflect.get(target, prop);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });

describe('a database made by the first version', () => {
  it('is upgraded on the first request, keeping every note, version, file and drawing', async () => {
    await env.DB.batch(V1.map((sql) => env.DB.prepare(sql)));
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO folders (id, parent_id, name, sort, created_at, updated_at) VALUES ('oldfold1', NULL, 'Archive', 0, ?, ?)`).bind(NOW, NOW),
      env.DB.prepare(
        `INSERT INTO notes (id, folder_id, title, content, excerpt, info, tags, pinned, version, created_at, updated_at) VALUES ('oldnote1', 'oldfold1', 'Lighthouse keeper', 'The lamp needs trimming at dusk', 'The lamp', '{}', '["coast"]', 1, 3, ?, ?)`,
      ).bind(NOW, NOW),
      env.DB.prepare(`INSERT INTO note_versions (note_id, title, content, created_at) VALUES ('oldnote1', 'Lighthouse keeper', 'An earlier draft', ?)`).bind(NOW),
      env.DB.prepare(`INSERT INTO files (id, note_id, name, mime, size, storage, created_at) VALUES ('oldfile1', 'oldnote1', 'map.png', 'image/png', 4, 'kv', ?)`).bind(NOW),
      env.DB.prepare(`INSERT INTO drawings (id, note_id, rev, storage, text, size, created_at, updated_at) VALUES ('olddraw1', 'oldnote1', 'rev0001', 'kv', 'beacon', 9, ?, ?)`).bind(NOW, NOW),
    ]);

    // A request while the database is failing: nothing is half-applied, and the error is a plain 500.
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const failed = await withEnv({ DB: failingBatches() }, `${LOCAL}/api/me`);
    expect(failed.status).toBe(500);
    expect(failed.body).toEqual({ error: 'server_error', message: expect.any(String) });
    expect(JSON.stringify(failed.body)).not.toContain('overloaded');
    expect(await schemaVersion()).toBe('1');
    error.mockRestore();

    // The next request (same Worker instance) tries the upgrade again, and it goes through.
    const boot = await withEnv({}, `${LOCAL}/api/bootstrap`);
    expect(boot.status).toBe(200);
    expect(await schemaVersion()).toBe('7');
    expect(await columns('notes')).toEqual(expect.arrayContaining(['enc', 'sealed', 'kgen', 'saves']));
    expect(await columns('files')).toEqual(expect.arrayContaining(['enc', 'sealed', 'kgen', 'blob']));
    expect(await columns('drawings')).toEqual(expect.arrayContaining(['enc', 'sealed', 'kgen']));

    const note = boot.body.notes.find((n: { id: string }) => n.id === 'oldnote1');
    expect(note).toMatchObject({ title: 'Lighthouse keeper', folder_id: 'oldfold1', tags: ['coast'], pinned: true, version: 3, enc: false });
    expect(boot.body.folders).toEqual([expect.objectContaining({ id: 'oldfold1', name: 'Archive', enc: false })]);
    expect(boot.body.encryption.on).toBe(false);
    expect((await get('/notes/oldnote1')).body.content).toBe('The lamp needs trimming at dusk');
    expect((await get('/notes/oldnote1/versions')).body.versions).toHaveLength(1);
    expect((await get('/files')).body.files).toEqual([expect.objectContaining({ id: 'oldfile1', name: 'map.png', enc: false })]);
    expect((await get('/drawings')).body.drawings).toEqual([expect.objectContaining({ id: 'olddraw1', enc: false })]);
  });

  it('keeps searching the upgraded notes, and the replaced search triggers follow edits', async () => {
    expect((await get('/search?q=lamp')).body.results.map((r: { id: string }) => r.id)).toEqual(['oldnote1']);
    const saved = await patch('/notes/oldnote1', { content: 'Fog horn drill on Tuesdays', baseVersion: 3 });
    expect(saved.status).toBe(200);
    expect((await get('/search?q=lamp')).body.results).toEqual([]);
    expect((await get('/search?q=horn')).body.results.map((r: { id: string }) => r.id)).toEqual(['oldnote1']);
    // New notes made after the upgrade are found too, and leave the index when deleted.
    const fresh = await post('/notes', { title: 'Tide tables', content: 'Spring tides peak' });
    expect((await get('/search?q=tides')).body.results.map((r: { id: string }) => r.id)).toEqual([fresh.body.id]);
    await post(`/notes/${fresh.body.id}/trash`);
    await post('/trash/empty');
    expect((await get('/search?q=tides')).body.results).toEqual([]);
  });

  it('isn’t migrated again once it’s at the latest version', async () => {
    vi.resetModules();
    const { ensureSchema } = await import('../../worker/schema');
    const seen: string[] = [];
    const watching = new Proxy(env.DB, {
      get(target, prop) {
        if (prop === 'batch') return (stmts: D1PreparedStatement[]) => (seen.push(`batch of ${stmts.length}`), target.batch(stmts));
        const value = Reflect.get(target, prop);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    await ensureSchema(watching);
    await ensureSchema(watching);
    expect(seen).toEqual([]);
    expect(await schemaVersion()).toBe('7');
  });

  /** The real database, except for how reading the schema version goes (`read` answers instead). */
  const versionReads = (read: (real: () => Promise<unknown>) => Promise<unknown>) =>
    new Proxy(env.DB, {
      get(target, prop) {
        if (prop === 'prepare') {
          return (sql: string) => {
            const stmt = target.prepare(sql);
            if (!/^SELECT value FROM kb_meta/.test(sql)) return stmt;
            return { first: () => read(() => stmt.first()) };
          };
        }
        const value = Reflect.get(target, prop);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });

  it('doesn’t take a failed first read (D1 busy, a dropped connection) for a database that was never set up', async () => {
    vi.resetModules();
    const { ensureSchema } = await import('../../worker/schema');
    let fail = true;
    const flaky = versionReads((real) => (fail ? ((fail = false), Promise.reject(new Error('D1_ERROR: Network connection lost.'))) : real()));
    await expect(ensureSchema(flaky)).rejects.toThrow(/Network connection lost/);
    // Nothing was migrated again or marked as older, so the next try finds the database as it was.
    expect(await schemaVersion()).toBe('7');
    await ensureSchema(flaky);
    expect(await schemaVersion()).toBe('7');
    expect((await get('/notes/oldnote1')).status).toBe(200);
  });

  it('carries on when another Worker instance applied a migration first, and never marks the version lower', async () => {
    vi.resetModules();
    const { ensureSchema } = await import('../../worker/schema');
    // Read as it was before another instance finished upgrading: migration 2 is then already there,
    // so its ALTER TABLEs fail here, and the version read again says how far the other one got.
    let stale = true;
    const behind = versionReads((real) => (stale ? ((stale = false), Promise.resolve({ value: '1' })) : real()));
    await ensureSchema(behind);
    expect(await schemaVersion()).toBe('7');

    // An instance that read 0 re-runs migration 1 (all IF NOT EXISTS): its version write leaves 6 alone.
    vi.resetModules();
    const fresh = await import('../../worker/schema');
    let zero = true;
    const fromScratch = versionReads((real) => (zero ? ((zero = false), Promise.resolve(null)) : real()));
    await fresh.ensureSchema(fromScratch);
    expect(await schemaVersion()).toBe('7');
    expect((await get('/bootstrap')).status).toBe(200);
  });
});
