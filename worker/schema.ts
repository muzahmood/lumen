/**
 * Schema migrations. The Worker applies these on first use, so a fresh D1
 * database needs no manual setup. Each inner array runs as one atomic batch.
 * Never edit a released migration; append a new one instead.
 */
const MIGRATIONS: string[][] = [
  [
    `CREATE TABLE IF NOT EXISTS folders (
      id TEXT PRIMARY KEY,
      parent_id TEXT,
      name TEXT NOT NULL,
      sort INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS notes (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL UNIQUE,
      folder_id TEXT,
      title TEXT NOT NULL DEFAULT '',
      content TEXT NOT NULL DEFAULT '',
      excerpt TEXT NOT NULL DEFAULT '',
      info TEXT NOT NULL DEFAULT '{}',
      tags TEXT NOT NULL DEFAULT '[]',
      pinned INTEGER NOT NULL DEFAULT 0,
      version INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      deleted_at INTEGER
    )`,
    `CREATE INDEX IF NOT EXISTS notes_folder_idx ON notes(folder_id)`,
    `CREATE INDEX IF NOT EXISTS notes_deleted_idx ON notes(deleted_at)`,
    `CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
      title, content, tags,
      content='notes', content_rowid='seq',
      tokenize='unicode61 remove_diacritics 2'
    )`,
    `CREATE TRIGGER IF NOT EXISTS notes_ai AFTER INSERT ON notes BEGIN
      INSERT INTO notes_fts(rowid, title, content, tags) VALUES (new.seq, new.title, new.content, new.tags);
    END`,
    `CREATE TRIGGER IF NOT EXISTS notes_ad AFTER DELETE ON notes BEGIN
      INSERT INTO notes_fts(notes_fts, rowid, title, content, tags) VALUES ('delete', old.seq, old.title, old.content, old.tags);
    END`,
    `CREATE TRIGGER IF NOT EXISTS notes_au AFTER UPDATE OF title, content, tags ON notes BEGIN
      INSERT INTO notes_fts(notes_fts, rowid, title, content, tags) VALUES ('delete', old.seq, old.title, old.content, old.tags);
      INSERT INTO notes_fts(rowid, title, content, tags) VALUES (new.seq, new.title, new.content, new.tags);
    END`,
    `CREATE TABLE IF NOT EXISTS note_versions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      note_id TEXT NOT NULL,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS note_versions_idx ON note_versions(note_id, created_at)`,
    `CREATE TABLE IF NOT EXISTS files (
      id TEXT PRIMARY KEY,
      note_id TEXT,
      name TEXT NOT NULL,
      mime TEXT NOT NULL,
      size INTEGER NOT NULL,
      storage TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS drawings (
      id TEXT PRIMARY KEY,
      note_id TEXT,
      rev TEXT NOT NULL,
      storage TEXT NOT NULL,
      text TEXT NOT NULL DEFAULT '',
      size INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`,
  ],
  // 2: end-to-end encryption. An encrypted row (enc = 1) keeps its text only as ciphertext: the
  // note body in `content`, and title, tags and preview in `sealed` (a JSON object of ciphertexts);
  // the plaintext columns are left empty. Encrypted notes are never put in the search index.
  [
    `ALTER TABLE notes ADD COLUMN enc INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE notes ADD COLUMN sealed TEXT NOT NULL DEFAULT '{}'`,
    `ALTER TABLE note_versions ADD COLUMN enc INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE note_versions ADD COLUMN sealed TEXT NOT NULL DEFAULT '{}'`,
    `ALTER TABLE folders ADD COLUMN enc INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE folders ADD COLUMN sealed TEXT NOT NULL DEFAULT ''`,
    // Counting what's still in plaintext happens on every load once encryption is on.
    `CREATE INDEX IF NOT EXISTS notes_enc_idx ON notes(enc)`,
    `CREATE INDEX IF NOT EXISTS note_versions_enc_idx ON note_versions(enc)`,
    `DROP TRIGGER IF EXISTS notes_ai`,
    `DROP TRIGGER IF EXISTS notes_ad`,
    `DROP TRIGGER IF EXISTS notes_au`,
    `CREATE TRIGGER notes_ai AFTER INSERT ON notes WHEN new.enc = 0 BEGIN
      INSERT INTO notes_fts(rowid, title, content, tags) VALUES (new.seq, new.title, new.content, new.tags);
    END`,
    `CREATE TRIGGER notes_ad AFTER DELETE ON notes WHEN old.enc = 0 BEGIN
      INSERT INTO notes_fts(notes_fts, rowid, title, content, tags) VALUES ('delete', old.seq, old.title, old.content, old.tags);
    END`,
    // One trigger, so the old entry always leaves the index before the new one goes in.
    `CREATE TRIGGER notes_au AFTER UPDATE OF title, content, tags, enc ON notes BEGIN
      INSERT INTO notes_fts(notes_fts, rowid, title, content, tags)
        SELECT 'delete', old.seq, old.title, old.content, old.tags WHERE old.enc = 0;
      INSERT INTO notes_fts(rowid, title, content, tags)
        SELECT new.seq, new.title, new.content, new.tags WHERE new.enc = 0;
    END`,
    // The wrapped (encrypted) master key: one current row. A change adds a row and then removes the
    // older ones, so an id always identifies one version (the app replaces only the version it read).
    `CREATE TABLE IF NOT EXISTS keyring (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      data TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )`,
  ],
  // 3: the note list (/bootstrap reads it on every load) from an index holding exactly its columns
  // (META_COLUMNS in util.ts), so the database never reads past each note's text to get them. Measured
  // locally: 56 ms for 2,000 notes of 40 KB, against 3 ms. Each save writes one more row (the index's).
  [
    `CREATE INDEX IF NOT EXISTS notes_list_idx ON notes(
      id, folder_id, title, excerpt, info, tags, pinned, version, created_at, updated_at, deleted_at, enc, sealed
    )`,
  ],
  // 4: replacing the encryption key. Each encrypted row records the key generation it was written
  // under (the keyring's `gen`), so re-encryption can pick up where it stopped, and finding what's
  // left reads only those rows (the indexes).
  [
    `ALTER TABLE notes ADD COLUMN kgen INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE note_versions ADD COLUMN kgen INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE folders ADD COLUMN kgen INTEGER NOT NULL DEFAULT 0`,
    `CREATE INDEX IF NOT EXISTS notes_kgen_idx ON notes(kgen)`,
    `CREATE INDEX IF NOT EXISTS note_versions_kgen_idx ON note_versions(kgen)`,
    `CREATE INDEX IF NOT EXISTS folders_kgen_idx ON folders(kgen)`,
  ],
  // 5: end-to-end encryption of uploads and drawings. Each encrypted file (and each revision of a
  // drawing) has its own random key; `sealed` holds that key, wrapped by the master key (for a file,
  // with its name and type too), so replacing the master key re-wraps these small keys and never
  // re-uploads the files. An encrypted file's bytes live under a key of their own (`blob`), never the
  // plaintext's, so converting a file can't race another device into overwriting it.
  [
    `ALTER TABLE files ADD COLUMN enc INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE files ADD COLUMN sealed TEXT NOT NULL DEFAULT ''`,
    `ALTER TABLE files ADD COLUMN kgen INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE files ADD COLUMN blob TEXT NOT NULL DEFAULT ''`,
    `ALTER TABLE drawings ADD COLUMN enc INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE drawings ADD COLUMN sealed TEXT NOT NULL DEFAULT ''`,
    `ALTER TABLE drawings ADD COLUMN kgen INTEGER NOT NULL DEFAULT 0`,
    `CREATE INDEX IF NOT EXISTS files_enc_idx ON files(enc, kgen)`,
    `CREATE INDEX IF NOT EXISTS drawings_enc_idx ON drawings(enc, kgen)`,
  ],
  // 6: the ids of the last few saves that changed each note's text (a JSON array, oldest first). A
  // device whose save landed but never heard back (a phone that locked, a dropped connection) can then
  // tell, when its next save is refused, that the note was built on its own text rather than changed
  // without it, and needn't ask which version to keep.
  [`ALTER TABLE notes ADD COLUMN saves TEXT NOT NULL DEFAULT '[]'`],
  // 7: blobs (uploads, drawing parts) waiting to be deleted from KV or R2, each from `due` on: listed
  // before they're deleted and taken off once they're gone, so a delete that fails (or a Worker stopped
  // partway) is tried again by the nightly job rather than leaving the blob in storage for good.
  [
    `CREATE TABLE IF NOT EXISTS blob_gc (
      key TEXT PRIMARY KEY,
      storage TEXT NOT NULL,
      due INTEGER NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS blob_gc_due_idx ON blob_gc(due)`,
  ],
];

let ready: Promise<void> | null = null;

export function ensureSchema(db: D1Database): Promise<void> {
  if (!ready) {
    ready = migrate(db).catch((err) => {
      ready = null;
      throw err;
    });
  }
  return ready;
}

/**
 * The version the database is at: 0 only for one that was never set up (no kb_meta table yet). Any
 * other failure (D1 busy, a dropped connection) is thrown: taken for 0, it would run the migrations
 * again over a set-up database, whose ALTER TABLEs then fail on every request from then on.
 */
async function schemaVersion(db: D1Database): Promise<number> {
  try {
    const row = await db.prepare(`SELECT value FROM kb_meta WHERE key = 'schema_version'`).first<{ value: string }>();
    return row ? Number(row.value) || 0 : 0;
  } catch (err) {
    if (!/no such table/i.test(err instanceof Error ? err.message : String(err))) throw err;
    await db.prepare(`CREATE TABLE IF NOT EXISTS kb_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`).run();
    return 0;
  }
}

async function migrate(db: D1Database): Promise<void> {
  for (let v = await schemaVersion(db); v < MIGRATIONS.length; v++) {
    const statements = MIGRATIONS[v].map((sql) => db.prepare(sql));
    statements.push(
      db
        .prepare(
          // Only ever up: an instance that started from an older reading mustn't mark the database
          // as older than another instance already made it.
          `INSERT INTO kb_meta (key, value) VALUES ('schema_version', ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value
           WHERE CAST(kb_meta.value AS INTEGER) < CAST(excluded.value AS INTEGER)`,
        )
        .bind(String(v + 1)),
    );
    try {
      await db.batch(statements);
    } catch (err) {
      // Another Worker instance may have applied this migration meanwhile (its ALTER TABLEs then fail
      // here, and the batch is rolled back): carry on from wherever it got to.
      const now = await schemaVersion(db);
      if (now <= v) throw err;
      v = now - 1;
    }
  }
}
