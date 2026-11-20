import { Hono, type Context } from 'hono';
import type { AppEnv, Env } from './env';
import { ensureSchema } from './schema';
import { authenticate, claimSetup, refuse, secureResponse, serveAsset, SETUP_PATH } from './gate';
import {
  activeStorage,
  deleteBlob,
  drawingKey,
  fileKey,
  getBlob,
  getBlobRange,
  maxUploadBytes,
  putBlob,
  plainFileKey,
  sealedFileKey,
  type StorageKind,
} from './storage';
import {
  HttpError,
  META_COLUMNS,
  MAX_CONTENT_BYTES,
  assert,
  byteRange,
  fitsBytes,
  cleanSealed,
  cleanTags,
  cleanTitle,
  encryptionOn,
  ftsQuery,
  isCipher,
  isId,
  makeExcerpt,
  makeInfo,
  newId,
  parseSealed,
  safeFileName,
  toMeta,
  type NoteRow,
  type Sealed,
} from './util';

type Ctx = Context<AppEnv>;

/** The ids of the note's last saves (see migration 6), tolerant of anything malformed. */
function savesOf(row: NoteRow): string[] {
  try {
    const list = JSON.parse(row.saves ?? '[]') as unknown;
    return Array.isArray(list) ? list.filter((s): s is string => typeof s === 'string') : [];
  } catch {
    return [];
  }
}

const SNAPSHOT_INTERVAL_MS = 10 * 60 * 1000;
const MAX_VERSIONS_PER_NOTE = 50;
/** How many of a note's last saves are remembered by id (see migration 6). */
const MAX_SAVES_KEPT = 16;
const SAVE_ID_RE = /^[A-Za-z0-9_-]{6,40}$/;
const TRASH_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

const api = new Hono<AppEnv>();

/* ---------------------------------------------------------------- auth --- */

// Who the visitor is was settled by the gate in front of everything (see gate.ts and the
// app setup at the bottom of this file); by the time a request gets here, Access has signed it in.
api.use('*', async (c, next) => {
  // Cross-site request forgery guard: browsers can't add custom headers to
  // cross-origin requests without a CORS preflight, which this API never grants.
  const method = c.req.method;
  if (method !== 'GET' && method !== 'HEAD' && c.req.header('x-kb-client') !== '1') {
    return c.json({ error: 'forbidden', message: 'Missing client header.' }, 403);
  }

  await ensureSchema(c.env.DB);
  await next();
  // Note data must never sit in a shared cache or the browser's disk cache.
  if (!c.res.headers.has('Cache-Control')) c.res.headers.set('Cache-Control', 'private, no-store');
});

/** The request's JSON body, which every route expects to be an object (null, a list or a number is a 400). */
async function readJson<T = Record<string, unknown>>(c: Ctx): Promise<T> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    throw new HttpError(400, 'bad_json', 'Request body must be JSON.');
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new HttpError(400, 'bad_json', 'Request body must be a JSON object.');
  return body as T;
}

function idParam(c: Ctx, name = 'id'): string {
  const id = c.req.param(name);
  assert(isId(id), 400, 'bad_id', 'Invalid id.');
  return id;
}

async function meInfo(c: Ctx) {
  const user = c.get('user');
  return {
    email: user.email,
    verified: user.verified,
    via: user.via,
    accessConfigured: user.verified,
    storage: activeStorage(c.env),
    maxUploadBytes: maxUploadBytes(c.env),
  };
}

/* ----------------------------------------------------------- bootstrap --- */

api.get('/me', async (c) => c.json(await meInfo(c)));

api.get('/bootstrap', async (c) => {
  const db = c.env.DB;
  const [folders, notes, backup, settings] = await db.batch([
    db.prepare('SELECT id, parent_id, name, sort, created_at, updated_at, enc, sealed, kgen FROM folders ORDER BY sort, name COLLATE NOCASE'),
    db.prepare(`SELECT ${META_COLUMNS} FROM notes`),
    db.prepare("SELECT value FROM kb_meta WHERE key = 'last_backup'"),
    db.prepare("SELECT value FROM kb_meta WHERE key = 'settings'"),
  ]);
  const on = await encryptionOn(db);
  return c.json({
    me: await meInfo(c),
    folders: (folders.results as Array<Record<string, unknown>>).map(folderOut),
    notes: (notes.results as unknown as NoteRow[]).map(toMeta),
    // Once encryption is on, anything still in plaintext (a conversion that was interrupted) is
    // counted so the app can finish the job.
    encryption: {
      on,
      pending: on ? pendingCounts(await finishIfDone(db)) : null,
      // Uploads and drawings from before they were encrypted, for the app to encrypt.
      ...(on ? { attachments: await plainAttachments(db) } : {}),
      // After the key was replaced: what's still encrypted with an earlier key, for the app to finish.
      ...(on ? await (async () => {
        const gen = await currentGen(db);
        return { gen, rekey: gen > 0 ? await rekeyLeft(db, gen) : { notes: 0, versions: 0, folders: 0, files: 0, drawings: 0 } };
      })() : {}),
    },
    // When a backup of the whole library was last downloaded (from any device), for the reminder on Home.
    lastBackup: Number((backup.results[0] as { value?: string } | undefined)?.value) || null,
    // The settings that follow the person to every device (encrypted with the notes when they are).
    settings: storedSettings((settings.results[0] as { value?: string } | undefined)?.value),
    serverTime: Date.now(),
  });
});

/** How much is still stored in plaintext: notes, history snapshots and folder names. */
async function plaintextLeft(db: D1Database) {
  const row = await db
    .prepare(
      `SELECT (SELECT COUNT(*) FROM notes WHERE enc = 0) AS notes,
              (SELECT COUNT(*) FROM note_versions WHERE enc = 0) AS versions,
              (SELECT COUNT(*) FROM folders WHERE enc = 0) AS folders,
              EXISTS (SELECT 1 FROM kb_meta WHERE key = 'plaintext_wiped') AS wiped`,
    )
    .first<{ notes: number; versions: number; folders: number; wiped: number }>();
  return { notes: row?.notes ?? 0, versions: row?.versions ?? 0, folders: row?.folders ?? 0, wiped: !!row?.wiped };
}

/**
 * Ends the one-time encryption pass once nothing is left in plaintext: empties the full-text search
 * index, whose internal tables still hold every word of every note even after each note's entry was
 * removed, and the text kept from drawings. The server does this itself, from whichever request sees
 * the pass complete, so a tab closed just before the app's last step can't leave the words behind.
 * Returns what's still in plaintext (all zero once done).
 */
async function finishIfDone(db: D1Database) {
  const left = await plaintextLeft(db);
  if (left.notes || left.versions || left.folders || left.wiped) return left;
  // Only now: emptying the index while any note is still in it would break the index's own updates.
  await db.batch([
    db.prepare(`INSERT INTO notes_fts(notes_fts) VALUES ('delete-all')`),
    db.prepare(`UPDATE drawings SET text = '' WHERE text != ''`),
    db.prepare(`INSERT INTO kb_meta (key, value) VALUES ('plaintext_wiped', ?) ON CONFLICT(key) DO NOTHING`).bind(String(Date.now())),
  ]);
  return { ...left, wiped: true };
}

/**
 * From when encryption is turned on, a note leaving the search index has its words erased from the
 * index's storage straight away (FTS5 'secure-delete'), not just marked deleted until a later merge.
 */
async function eraseIndexOnDelete(db: D1Database) {
  try {
    await db.prepare(`INSERT INTO notes_fts(notes_fts, rank) VALUES ('secure-delete', 1)`).run();
  } catch (err) {
    // An SQLite without the option: the wipe at the end of the pass still removes everything.
    console.warn('FTS secure-delete unavailable', err);
  }
}

const pendingCounts = ({ notes, versions, folders }: { notes: number; versions: number; folders: number }) => ({ notes, versions, folders });

/** Runs a seal batch (UPDATE … RETURNING): how many rows it changed, then the end-of-pass check. */
async function sealBatch(db: D1Database, statements: D1PreparedStatement[]) {
  const results = await db.batch(statements);
  await finishIfDone(db);
  // Counted from RETURNING: D1's change count also includes the search index's own rows.
  return results.reduce((n, r) => n + r.results.length, 0);
}

const ENCRYPTED_ONLY =
  'Your notes are end-to-end encrypted, and this copy of Lumen is out of date and can’t encrypt. Reload the page to update it; your edits are kept on this device.';

/** One item of a list sent in a request: an object, or the request is refused (400) rather than failing (500). */
function objectItem(raw: unknown): Record<string, unknown> {
  assert(raw !== null && typeof raw === 'object' && !Array.isArray(raw), 400, 'bad_request', 'Each item in the list must be an object.');
  return raw as Record<string, unknown>;
}

/** Once there's a keyring, note text and folder names may only be stored encrypted. */
async function refusePlaintext(db: D1Database) {
  assert(!(await encryptionOn(db)), 409, 'encryption_required', ENCRYPTED_ONLY);
}

const KEY_CHANGED =
  'Your encryption key was replaced on another device. Unlock again with your passphrase; your unsaved edits are kept on this device.';

/** The keyring's key generation: 0 until the encryption key is first replaced (see migration 4). */
async function currentGen(db: D1Database): Promise<number> {
  const row = await db
    .prepare(`SELECT COALESCE(json_extract(data, '$.gen'), 0) AS gen FROM keyring ORDER BY id DESC LIMIT 1`)
    .first<{ gen: number }>();
  return Number(row?.gen ?? 0);
}

/**
 * Ciphertext is only accepted from the current key. Once the key was replaced on another device, one
 * still unlocked with the old key would otherwise go on writing text that has to be re-encrypted all
 * over again. The app sends the generation it encrypted with (`kgen`); versions from before keys could
 * be replaced send none, which counts as 0. Returns the current generation.
 */
async function requireKeyGen(db: D1Database, kgen: unknown): Promise<number> {
  const gen = await currentGen(db);
  assert((typeof kgen === 'number' ? kgen : 0) === gen, 409, 'key_changed', KEY_CHANGED);
  return gen;
}

api.get('/stats', async (c) => {
  const db = c.env.DB;
  const [notes, files, drawings] = await db.batch([
    db.prepare(
      `SELECT SUM(CASE WHEN deleted_at IS NULL THEN 1 ELSE 0 END) AS active,
              SUM(CASE WHEN deleted_at IS NOT NULL THEN 1 ELSE 0 END) AS trashed,
              COALESCE(SUM(length(content)), 0) AS chars
       FROM notes`,
    ),
    db.prepare('SELECT COUNT(*) AS count, COALESCE(SUM(size), 0) AS bytes FROM files'),
    db.prepare('SELECT COUNT(*) AS count, COALESCE(SUM(size), 0) AS bytes FROM drawings'),
  ]);
  return c.json({
    notes: notes.results[0],
    files: files.results[0],
    drawings: drawings.results[0],
    storage: activeStorage(c.env),
  });
});

/* --------------------------------------------------------------- notes --- */

api.get('/notes/:id', async (c) => {
  const id = idParam(c);
  const row = await c.env.DB.prepare('SELECT * FROM notes WHERE id = ?').bind(id).first<NoteRow>();
  assert(row, 404, 'not_found', 'Note not found.');
  // kgen: a device still on a replaced key can tell from it that it needs to unlock again.
  return c.json({ ...toMeta(row), content: row.content, ...(row.enc ? { kgen: row.kgen ?? 0 } : {}) });
});

/**
 * Several notes by id, as stored (ciphertext for encrypted notes), for the copy each device keeps:
 * it asks only for notes whose version moved on since it last had them, so D1 reads those rows alone.
 */
api.post('/notes/batch', async (c) => {
  const body = await readJson<{ ids?: unknown }>(c);
  const ids = Array.isArray(body.ids) ? [...new Set(body.ids.filter(isId))] : [];
  assert(ids.length > 0 && ids.length <= 90, 400, 'bad_request', 'Send between 1 and 90 note ids.');
  const { results } = await c.env.DB.prepare(`SELECT * FROM notes WHERE id IN (${ids.map(() => '?').join(',')})`)
    .bind(...ids)
    .all<NoteRow>();
  return c.json({
    notes: results.map((row) => ({ ...toMeta(row), content: row.content, ...(row.enc ? { kgen: row.kgen ?? 0 } : {}) })),
  });
});

const TOO_LARGE = 'Note is too large (limit is about 1.8 MB of text, or 1.3 MB once encrypted).';
const BAD_CIPHER = 'This note isn’t encrypted the way Lumen expects, so it wasn’t saved.';

api.post('/notes', async (c) => {
  const body = await readJson<Record<string, unknown>>(c);
  const db = c.env.DB;
  const restore = body.restore === true;
  const enc = body.enc === true || body.enc === 1;
  if (!enc) await refusePlaintext(db);
  const gen = enc ? await requireKeyGen(db, body.kgen) : 0;
  let id: string;
  if (body.id !== undefined) {
    assert(isId(body.id), 400, 'bad_id', 'Invalid note id.');
    id = body.id;
  } else {
    // An encrypted note's ciphertext is bound to its id, so the app chooses the id.
    assert(!enc, 400, 'bad_id', 'An encrypted note needs its id.');
    id = newId();
  }
  const content = typeof body.content === 'string' ? body.content : '';
  let sealed: Sealed = {};
  if (enc) {
    assert(content.length <= MAX_CONTENT_BYTES, 413, 'too_large', TOO_LARGE);
    const s = cleanSealed(body.sealed);
    assert(isCipher(content) && s && s.t && s.g && s.p, 400, 'bad_cipher', BAD_CIPHER);
    sealed = s;
  } else {
    assert(fitsBytes(content, MAX_CONTENT_BYTES), 413, 'too_large', TOO_LARGE);
  }
  const folderId = isId(body.folder_id) ? body.folder_id : null;
  const now = Date.now();
  const createdAt = restore && typeof body.created_at === 'number' ? body.created_at : now;
  const updatedAt = restore && typeof body.updated_at === 'number' ? body.updated_at : now;
  const deletedAt = restore && typeof body.deleted_at === 'number' ? body.deleted_at : null;

  // A new note in a folder that no longer exists (deleted on another device) is filed under no folder.
  const sql = `INSERT INTO notes (id, folder_id, title, content, excerpt, info, tags, pinned, version, created_at, updated_at, deleted_at, enc, sealed, kgen)
     VALUES (?, (SELECT id FROM folders WHERE id = ?), ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)
     ${
       restore
         ? `ON CONFLICT(id) DO UPDATE SET folder_id = excluded.folder_id, title = excluded.title, content = excluded.content,
            excerpt = excluded.excerpt, info = excluded.info, tags = excluded.tags, pinned = excluded.pinned, version = notes.version + 1,
            created_at = excluded.created_at, updated_at = excluded.updated_at, deleted_at = excluded.deleted_at,
            enc = excluded.enc, sealed = excluded.sealed, kgen = excluded.kgen, saves = '[]'`
         : ''
     }
     RETURNING ${META_COLUMNS}`;
  // Restoring a backup over a note that still exists keeps the note's current text in its history, so
  // an older backup can't silently undo newer work.
  const keepCurrent = restore
    ? [
        db
          .prepare(
            `INSERT INTO note_versions (note_id, title, content, created_at, enc, sealed, kgen)
             SELECT id, title, content, ?2, enc, CASE WHEN enc = 1 THEN json_object('t', json_extract(sealed, '$.t')) ELSE '{}' END, kgen
             FROM notes WHERE id = ?1 AND content != ?3 AND (CASE WHEN enc = 1 THEN length(content) > 41 ELSE trim(content) != '' END)`,
          )
          .bind(id, now, content),
        db
          .prepare(
            `DELETE FROM note_versions WHERE note_id = ?1 AND id NOT IN
               (SELECT id FROM note_versions WHERE note_id = ?1 ORDER BY id DESC LIMIT ${MAX_VERSIONS_PER_NOTE})`,
          )
          .bind(id),
      ]
    : [];
  try {
    const insert = db
      .prepare(sql)
      .bind(
        id,
        folderId,
        // Encrypted notes keep nothing readable outside `content` and `sealed`.
        enc ? '' : cleanTitle(body.title),
        content,
        enc ? '' : makeExcerpt(content),
        enc ? '{}' : makeInfo(content),
        enc ? '[]' : JSON.stringify(cleanTags(body.tags)),
        body.pinned ? 1 : 0,
        createdAt,
        updatedAt,
        deletedAt,
        enc ? 1 : 0,
        JSON.stringify(sealed),
        gen,
      );
    const results = await db.batch([...keepCurrent, insert]);
    const row = results[results.length - 1].results[0] as NoteRow | undefined;
    assert(row, 500, 'insert_failed');
    return c.json(toMeta(row), 201);
  } catch (err) {
    if (err instanceof HttpError) throw err;
    if (/UNIQUE/i.test(String(err))) throw new HttpError(409, 'exists', 'A note with this id already exists.');
    throw err;
  }
});

api.patch('/notes/:id', async (c) => {
  const id = idParam(c);
  const body = await readJson<Record<string, unknown>>(c);
  const db = c.env.DB;
  const row = await db
    .prepare(
      `SELECT n.*, (SELECT MAX(created_at) FROM note_versions v WHERE v.note_id = n.id) AS last_snapshot
       FROM notes n WHERE n.id = ?`,
    )
    .bind(id)
    .first<NoteRow & { last_snapshot: number | null }>();
  assert(row, 404, 'not_found', 'Note not found.');

  const enc = body.enc === true || body.enc === 1;
  const hasText = 'title' in body || 'content' in body || 'tags' in body || 'sealed' in body;
  if (hasText) {
    if (row.enc) assert(enc, 409, 'encryption_required', ENCRYPTED_ONLY);
    // Plaintext notes become encrypted only through /notes/seal, which keeps no plaintext copy.
    else assert(!enc, 409, 'not_encrypted', 'This note hasn’t been encrypted yet. Reload Lumen to finish encrypting your notes.');
    if (!enc) await refusePlaintext(db);
    // Some fields may be rewritten here and not others, so the row keeps its generation (kgen): the
    // re-encryption after a key replacement still covers it.
    else await requireKeyGen(db, body.kgen);
  }

  const sets: string[] = [];
  const params: unknown[] = [];
  let bumpsUpdated = false;
  let textChanged: boolean;
  const rowSealed = parseSealed(row.sealed);
  if (row.enc) {
    // Encrypted: the body's text arrives as ciphertext. Title, tags and preview are separate sealed
    // fields, so each can change on its own, as in a plaintext note.
    const patch = 'sealed' in body ? cleanSealed(body.sealed) : {};
    assert(patch, 400, 'bad_cipher', BAD_CIPHER);
    const nextContent = 'content' in body ? body.content : row.content;
    assert(isCipher(nextContent), 400, 'bad_cipher', BAD_CIPHER);
    assert(nextContent.length <= MAX_CONTENT_BYTES, 413, 'too_large', TOO_LARGE);
    const contentChanged = nextContent !== row.content;
    const titleChanged = patch.t !== undefined && patch.t !== rowSealed.t;
    const tagsChanged = patch.g !== undefined && patch.g !== rowSealed.g;
    const sealedChanged = titleChanged || tagsChanged || (patch.p !== undefined && patch.p !== rowSealed.p);
    textChanged = contentChanged || titleChanged;
    if (contentChanged) {
      sets.push('content = ?');
      params.push(nextContent);
    }
    if (sealedChanged) {
      // Merged into the stored fields, not the copy read above: a tag change doesn't move the version,
      // so another device's tags saved meanwhile must survive this device's new title.
      sets.push(`sealed = json_patch(CASE WHEN json_valid(sealed) THEN sealed ELSE '{}' END, ?)`);
      params.push(JSON.stringify(patch));
    }
    bumpsUpdated = contentChanged || titleChanged || tagsChanged;
  } else {
    const nextTitle = 'title' in body ? cleanTitle(body.title) : row.title;
    const nextContent = typeof body.content === 'string' ? body.content : row.content;
    textChanged = nextTitle !== row.title || nextContent !== row.content;
    if (nextContent !== row.content) {
      assert(fitsBytes(nextContent, MAX_CONTENT_BYTES), 413, 'too_large', TOO_LARGE);
      sets.push('content = ?', 'excerpt = ?', 'info = ?');
      params.push(nextContent, makeExcerpt(nextContent), makeInfo(nextContent));
      bumpsUpdated = true;
    }
    if (nextTitle !== row.title) {
      sets.push('title = ?');
      params.push(nextTitle);
      bumpsUpdated = true;
    }
    if ('tags' in body) {
      const tags = JSON.stringify(cleanTags(body.tags));
      if (tags !== row.tags) {
        sets.push('tags = ?');
        params.push(tags);
        bumpsUpdated = true;
      }
    }
  }

  const force = body.force === true;
  const baseVersion = typeof body.baseVersion === 'number' ? body.baseVersion : null;
  if (textChanged && baseVersion !== null && baseVersion !== row.version && !force) {
    return conflict(c, row);
  }
  // The app names each save, so a device that never heard back can later tell that it landed.
  if (textChanged && SAVE_ID_RE.test(String(body.saveId ?? ''))) {
    sets.push('saves = ?');
    params.push(JSON.stringify([...savesOf(row), body.saveId as string].slice(-MAX_SAVES_KEPT)));
  }
  if ('folder_id' in body) {
    const folderId = body.folder_id === null ? null : body.folder_id;
    assert(folderId === null || isId(folderId), 400, 'bad_folder', 'Invalid folder.');
    if (folderId !== null && folderId !== row.folder_id) {
      // Another device may have deleted the folder since this one last loaded the list.
      const folder = await db.prepare('SELECT 1 AS ok FROM folders WHERE id = ?').bind(folderId).first();
      assert(folder, 409, 'folder_missing', 'That folder no longer exists. It may have been deleted on another device.');
    }
    sets.push('folder_id = ?');
    params.push(folderId);
  }
  if ('pinned' in body) {
    sets.push('pinned = ?');
    params.push(body.pinned ? 1 : 0);
  }
  if (!sets.length) return c.json(toMeta(row));

  const now = Date.now();
  if (textChanged) sets.push('version = version + 1');
  if (bumpsUpdated) {
    sets.push('updated_at = ?');
    params.push(now);
  }

  const statements: D1PreparedStatement[] = [];
  const snapshotDue =
    textChanged &&
    // Not of an empty note (checked again below on the stored text, which a forced save may not have seen).
    (force || (row.enc ? row.content.length > 41 : row.content.trim() !== '')) &&
    // A forced save ("Keep mine" in a conflict) replaces text this device never saw: keep it in history.
    (body.snapshot === true || force || !row.last_snapshot || now - row.last_snapshot > SNAPSHOT_INTERVAL_MS);
  if (snapshotDue) {
    statements.push(
      // Taken from the stored row inside the batch, not the copy read above: a save that loses a race
      // (the version moved on) keeps no snapshot, and a forced save keeps whatever it really replaces,
      // even text saved by another device a moment ago. An encrypted note's snapshot stays encrypted:
      // its ciphertext body and sealed title. Not of an empty note (an encrypted empty body is exactly
      // 41 characters: "e1:" and the IV and tag).
      db
        .prepare(
          `INSERT INTO note_versions (note_id, title, content, created_at, enc, sealed, kgen)
           SELECT id, title, content, ?2, enc, CASE WHEN enc = 1 THEN json_object('t', json_extract(sealed, '$.t')) ELSE '{}' END, kgen
           FROM notes WHERE id = ?1 AND (CASE WHEN enc = 1 THEN length(content) > 41 ELSE trim(content, ' ' || char(9, 10, 13)) != '' END)
           ${force ? '' : 'AND version = ?3'}`,
        )
        .bind(...(force ? [row.id, now] : [row.id, now, row.version])),
      db
        .prepare(
          `DELETE FROM note_versions WHERE note_id = ?1 AND id NOT IN
             (SELECT id FROM note_versions WHERE note_id = ?1 ORDER BY id DESC LIMIT ${MAX_VERSIONS_PER_NOTE})`,
        )
        .bind(row.id),
    );
  }
  // The version guard makes concurrent saves from two devices fail loudly instead of silently overwriting.
  const guard = textChanged && !force ? ' AND version = ?' : '';
  const guardParams = textChanged && !force ? [row.version] : [];
  statements.push(
    db
      .prepare(`UPDATE notes SET ${sets.join(', ')} WHERE id = ?${guard} RETURNING ${META_COLUMNS}`)
      .bind(...params, id, ...guardParams),
  );
  const results = await db.batch(statements);
  const updated = results[results.length - 1].results[0] as NoteRow | undefined;
  if (!updated) {
    const current = await db.prepare('SELECT * FROM notes WHERE id = ?').bind(id).first<NoteRow>();
    return conflict(c, current);
  }
  return c.json(toMeta(updated));
});

/**
 * A save on top of a version that isn't the note's current one. The reply carries the note as it is
 * now, the saves its text includes (see migration 6), and the server's clock, so the device can work
 * out how long ago that version was saved without comparing two devices' clocks.
 */
function conflict(c: Ctx, row: NoteRow | null) {
  return c.json(
    { error: 'conflict', note: row ? { ...toMeta(row), content: row.content } : null, saves: row ? savesOf(row) : [], now: Date.now() },
    409,
  );
}

/**
 * Keeps a version of a note that's no longer its text in the note's history, without changing the
 * note: a device's older edits, set aside because the note was changed on another device after them.
 * `at` is when those edits were made (within the last year). An encrypted note's version is encrypted
 * like its text: the body as ciphertext and the title in `sealed.t`.
 */
api.post('/notes/:id/versions', async (c) => {
  const id = idParam(c);
  const body = await readJson<Record<string, unknown>>(c);
  const db = c.env.DB;
  const row = await db.prepare('SELECT id, enc FROM notes WHERE id = ?').bind(id).first<{ id: string; enc: number }>();
  assert(row, 404, 'not_found', 'Note not found.');
  const enc = body.enc === true || body.enc === 1;
  let title = '';
  let content: string;
  let sealed: Sealed = {};
  let gen = 0;
  if (row.enc) {
    assert(enc, 409, 'encryption_required', ENCRYPTED_ONLY);
    gen = await requireKeyGen(db, body.kgen);
    const s = cleanSealed(body.sealed, ['t']);
    assert(s?.t && isCipher(body.content), 400, 'bad_cipher', BAD_CIPHER);
    assert(body.content.length <= MAX_CONTENT_BYTES, 413, 'too_large', TOO_LARGE);
    content = body.content;
    sealed = s;
  } else {
    assert(!enc, 409, 'not_encrypted', 'This note hasn’t been encrypted yet. Reload Lumen to finish encrypting your notes.');
    await refusePlaintext(db);
    title = cleanTitle(body.title);
    content = typeof body.content === 'string' ? body.content : '';
    assert(fitsBytes(content, MAX_CONTENT_BYTES), 413, 'too_large', TOO_LARGE);
  }
  const now = Date.now();
  const at = typeof body.at === 'number' && Number.isFinite(body.at) ? Math.min(now, Math.max(now - 365 * 86_400_000, Math.round(body.at))) : now;
  const [inserted] = await db.batch([
    db
      .prepare(
        `INSERT INTO note_versions (note_id, title, content, created_at, enc, sealed, kgen)
         SELECT id, ?2, ?3, ?4, ?5, ?6, ?7 FROM notes WHERE id = ?1 RETURNING id`,
      )
      .bind(id, title, content, at, row.enc ? 1 : 0, JSON.stringify(sealed), gen),
    db
      .prepare(
        `DELETE FROM note_versions WHERE note_id = ?1 AND id NOT IN
           (SELECT id FROM note_versions WHERE note_id = ?1 ORDER BY id DESC LIMIT ${MAX_VERSIONS_PER_NOTE})`,
      )
      .bind(id),
  ]);
  const vid = (inserted.results[0] as { id: number } | undefined)?.id;
  assert(vid, 404, 'not_found', 'Note not found.');
  return c.json({ ok: true, id: vid }, 201);
});

api.post('/notes/:id/trash', async (c) => {
  const id = idParam(c);
  const row = await c.env.DB.prepare(`UPDATE notes SET deleted_at = ? WHERE id = ? RETURNING ${META_COLUMNS}`)
    .bind(Date.now(), id)
    .first<NoteRow>();
  assert(row, 404, 'not_found', 'Note not found.');
  return c.json(toMeta(row));
});

api.post('/notes/:id/restore', async (c) => {
  const id = idParam(c);
  const row = await c.env.DB.prepare(
    `UPDATE notes SET deleted_at = NULL,
       folder_id = CASE WHEN folder_id IS NULL OR EXISTS (SELECT 1 FROM folders f WHERE f.id = notes.folder_id)
                   THEN folder_id ELSE NULL END
     WHERE id = ? RETURNING ${META_COLUMNS}`,
  )
    .bind(id)
    .first<NoteRow>();
  assert(row, 404, 'not_found', 'Note not found.');
  return c.json(toMeta(row));
});

/**
 * Deletes a note for good, with its history. `?ifVersion=` deletes it only while it's still at that
 * version: the app's clean-up of a note left empty uses it, so it can never delete text that another
 * device saved into the note in the meantime.
 */
api.delete('/notes/:id', async (c) => {
  const id = idParam(c);
  const db = c.env.DB;
  const ifVersion = c.req.query('ifVersion');
  const expected = ifVersion === undefined ? null : Number(ifVersion);
  assert(expected === null || Number.isInteger(expected), 400, 'bad_version', 'Invalid version.');
  const [deleted] = await db.batch([
    db.prepare(`DELETE FROM notes WHERE id = ?1 AND (?2 IS NULL OR version = ?2) RETURNING id`).bind(id, expected),
    db.prepare('DELETE FROM note_versions WHERE note_id = ?1 AND NOT EXISTS (SELECT 1 FROM notes WHERE id = ?1)').bind(id),
  ]);
  return c.json({ ok: true, deleted: deleted.results.length > 0 });
});

api.post('/trash/empty', async (c) => {
  const db = c.env.DB;
  // Counted from RETURNING: D1's change count also includes the search index's own rows.
  const [, deleted] = await db.batch([
    db.prepare('DELETE FROM note_versions WHERE note_id IN (SELECT id FROM notes WHERE deleted_at IS NOT NULL)'),
    db.prepare('DELETE FROM notes WHERE deleted_at IS NOT NULL RETURNING id'),
  ]);
  return c.json({ ok: true, deleted: deleted.results.length });
});

api.get('/notes/:id/versions', async (c) => {
  const id = idParam(c);
  const { results } = await c.env.DB.prepare(
    `SELECT id, title, enc, sealed, length(content) AS size, created_at FROM note_versions
     WHERE note_id = ? ORDER BY created_at DESC LIMIT 100`,
  )
    .bind(id)
    .all<{ id: number; title: string; enc: number; sealed: string; size: number; created_at: number }>();
  return c.json({ versions: results.map((v) => ({ ...v, enc: !!v.enc, sealed: parseSealed(v.sealed) })) });
});

/** Plaintext history snapshots, a page at a time, for the app's one-time encryption pass. */
api.get('/versions/plain', async (c) => {
  const after = Number(c.req.query('after') ?? 0) || 0;
  const { results } = await c.env.DB.prepare(
    'SELECT id, note_id, title, content FROM note_versions WHERE enc = 0 AND id > ? ORDER BY id LIMIT 50',
  )
    .bind(after)
    .all<{ id: number; note_id: string; title: string; content: string }>();
  return c.json({ versions: results, next: results.length === 50 ? results[results.length - 1].id : null });
});

/**
 * Every saved version as it's stored (ciphertext when encrypted), 25 at a time (a version can be
 * large): for the app to find which uploads and drawings older versions still link to, before it offers
 * any for deletion (/files/cleanup).
 */
api.get('/versions/export', async (c) => {
  const after = Number(c.req.query('after') ?? 0) || 0;
  const { results } = await c.env.DB.prepare(
    'SELECT id, note_id, title, content, created_at, enc, sealed FROM note_versions WHERE id > ? ORDER BY id LIMIT 25',
  )
    .bind(after)
    .all<{ id: number; note_id: string; title: string; content: string; created_at: number; enc: number; sealed: string }>();
  return c.json({
    versions: results.map((v) => ({ ...v, enc: !!v.enc, sealed: parseSealed(v.sealed) })),
    next: results.length === 25 ? results[results.length - 1].id : null,
  });
});

/** Replaces plaintext snapshots with their encrypted form (body and title), or drops one marked `drop`. */
api.post('/versions/seal', async (c) => {
  const db = c.env.DB;
  assert(await encryptionOn(db), 409, 'no_keyring', 'Turn on encryption first.');
  const body = await readJson<{ versions?: unknown; kgen?: unknown }>(c);
  const gen = await requireKeyGen(db, body.kgen);
  const items = Array.isArray(body.versions) ? body.versions : [];
  assert(items.length > 0 && items.length <= 100, 400, 'bad_request', 'Send between 1 and 100 versions.');
  const statements = items.map((raw) => {
    const item = objectItem(raw) as { id?: unknown; content?: unknown; sealed?: unknown; drop?: unknown };
    // A snapshot too large to store once encrypted is removed rather than kept in plaintext.
    if (item.drop === true && Number.isInteger(item.id)) {
      return db.prepare('DELETE FROM note_versions WHERE id = ? AND enc = 0 RETURNING id').bind(item.id);
    }
    const sealed = cleanSealed(item.sealed, ['t']);
    assert(Number.isInteger(item.id) && isCipher(item.content, MAX_CONTENT_BYTES) && sealed?.t, 400, 'bad_cipher', BAD_CIPHER);
    return db
      .prepare(`UPDATE note_versions SET enc = 1, content = ?, sealed = ?, title = '', kgen = ? WHERE id = ? AND enc = 0 RETURNING id`)
      .bind(item.content, JSON.stringify(sealed), gen, item.id);
  });
  return c.json({ sealed: await sealBatch(db, statements) });
});

api.get('/versions/:vid', async (c) => {
  const vid = Number(c.req.param('vid'));
  assert(Number.isInteger(vid) && vid > 0, 400, 'bad_id', 'Invalid version id.');
  const row = await c.env.DB.prepare('SELECT * FROM note_versions WHERE id = ?').bind(vid).first<{ enc: number; sealed: string }>();
  assert(row, 404, 'not_found', 'Version not found.');
  return c.json({ ...row, enc: !!row.enc, sealed: parseSealed(row.sealed) });
});

/**
 * Encrypts notes in place, for the app's one-time encryption pass: each note's text is replaced by
 * its ciphertext and the plaintext columns are emptied, without a history snapshot (which would keep
 * a plaintext copy). A note edited since the app read it is skipped (its version moved on) and is
 * picked up on the next pass. The version stays the same: the text didn't change, so edits waiting on
 * a device (based on that version) still apply without a conflict.
 */
api.post('/notes/seal', async (c) => {
  const db = c.env.DB;
  assert(await encryptionOn(db), 409, 'no_keyring', 'Turn on encryption first.');
  const body = await readJson<{ notes?: unknown; kgen?: unknown }>(c);
  const gen = await requireKeyGen(db, body.kgen);
  const items = Array.isArray(body.notes) ? body.notes : [];
  assert(items.length > 0 && items.length <= 100, 400, 'bad_request', 'Send between 1 and 100 notes.');
  const statements = items.map((raw) => {
    const item = objectItem(raw) as { id?: unknown; version?: unknown; content?: unknown; sealed?: unknown };
    const sealed = cleanSealed(item.sealed);
    assert(isId(item.id) && typeof item.version === 'number', 400, 'bad_request', 'Each note needs its id and version.');
    assert(isCipher(item.content) && sealed?.t && sealed.g && sealed.p, 400, 'bad_cipher', BAD_CIPHER);
    assert(item.content.length <= MAX_CONTENT_BYTES, 413, 'too_large', TOO_LARGE);
    return db
      .prepare(
        `UPDATE notes SET enc = 1, content = ?, sealed = ?, title = '', tags = '[]', excerpt = '', info = '{}', kgen = ?
         WHERE id = ? AND enc = 0 AND version = ? RETURNING id`,
      )
      .bind(item.content, JSON.stringify(sealed), gen, item.id, item.version);
  });
  return c.json({ sealed: await sealBatch(db, statements) });
});

/**
 * Replaces encrypted notes' previews (the sealed `p`: excerpt, list summary and the notes each links
 * to), for the app's one-time upgrade of previews saved before they listed links. Only a note still at
 * the version the app read changes, and nothing else about it does: not its text, version or dates.
 */
api.post('/notes/previews', async (c) => {
  const db = c.env.DB;
  const body = await readJson<{ notes?: unknown; kgen?: unknown }>(c);
  await requireKeyGen(db, body.kgen);
  const items = Array.isArray(body.notes) ? body.notes : [];
  assert(items.length > 0 && items.length <= 100, 400, 'bad_request', 'Send between 1 and 100 notes.');
  const statements = items.map((raw) => {
    const item = objectItem(raw) as { id?: unknown; version?: unknown; p?: unknown };
    assert(isId(item.id) && Number.isInteger(item.version), 400, 'bad_request', 'Each note needs its id and version.');
    assert(isCipher(item.p, 200_000), 400, 'bad_cipher', BAD_CIPHER);
    return db
      .prepare(
        `UPDATE notes SET sealed = json_set(CASE WHEN json_valid(sealed) THEN sealed ELSE '{}' END, '$.p', ?)
         WHERE id = ? AND enc = 1 AND version = ? RETURNING id`,
      )
      .bind(item.p, item.id, item.version);
  });
  const results = await db.batch(statements);
  return c.json({ updated: results.flatMap((r) => (r.results as Array<{ id: string }>).map((row) => row.id)) });
});

api.get('/notes/:id/backlinks', async (c) => {
  const id = idParam(c);
  const db = c.env.DB;
  const note = await db.prepare('SELECT title FROM notes WHERE id = ?').bind(id).first<{ title: string }>();
  assert(note, 404, 'not_found', 'Note not found.');
  const title = note.title.trim();
  const phrases = [`note ${id}`];
  if (title) phrases.push(title);
  const match = phrases.map((p) => `"${p.replace(/"/g, '""')}"`).join(' OR ');
  let rows: Array<{ id: string; title: string; excerpt: string; updated_at: number; content: string }> = [];
  try {
    const res = await db
      .prepare(
        `SELECT n.id, n.title, n.excerpt, n.updated_at, n.content FROM notes_fts
         JOIN notes n ON n.seq = notes_fts.rowid
         WHERE notes_fts MATCH ? AND n.deleted_at IS NULL AND n.id != ? LIMIT 200`,
      )
      .bind(match, id)
      .all();
    rows = res.results as typeof rows;
  } catch (err) {
    console.warn('backlink search failed', err);
  }
  const escaped = title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const wiki = title ? new RegExp(`\\[\\[\\s*${escaped}\\s*(\\||#|\\]\\])`, 'i') : null;
  const links = rows
    .filter((r) => r.content.includes(`/note/${id}`) || (wiki && wiki.test(r.content)))
    .slice(0, 50)
    .map(({ content: _c, ...rest }) => rest);
  return c.json({ backlinks: links });
});

/* ------------------------------------------------------------- folders --- */

/** A folder row as the app sees it: `sealed` holds the encrypted name when `enc` is set. */
function folderOut(row: Record<string, unknown> | null) {
  return row ? { ...row, enc: !!row.enc } : row;
}

const BAD_FOLDER_CIPHER = 'This folder name isn’t encrypted the way Lumen expects, so it wasn’t saved.';
const FOLDER_CYCLE = 'A folder can’t be moved inside itself or one of its own subfolders.';

/**
 * `anc`: the folder bound to the first `?` and every folder above it. UNION (not UNION ALL) stops at
 * a folder already seen, so this ends even if older data already loops.
 */
const ANCESTORS = `anc(id) AS (
  SELECT ? UNION SELECT f.parent_id FROM folders f JOIN anc ON f.id = anc.id WHERE f.parent_id IS NOT NULL
)`;

api.post('/folders', async (c) => {
  const body = await readJson<Record<string, unknown>>(c);
  const db = c.env.DB;
  const enc = body.enc === true || body.enc === 1;
  let name = '';
  let gen = 0;
  if (enc) {
    // Bound to the folder's id, so the app chooses it.
    assert(isId(body.id), 400, 'bad_id', 'An encrypted folder needs its id.');
    assert(isCipher(body.sealed, 4000), 400, 'bad_cipher', BAD_FOLDER_CIPHER);
    gen = await requireKeyGen(db, body.kgen);
  } else {
    await refusePlaintext(db);
    name = cleanTitle(body.name);
    assert(name, 400, 'bad_name', 'Folder name is required.');
  }
  const id = body.id === undefined ? newId() : body.id;
  assert(isId(id), 400, 'bad_id', 'Invalid folder id.');
  const parentId = isId(body.parent_id) ? body.parent_id : null;
  const now = Date.now();
  // Reusing an existing id (a restored backup) updates that folder, so the new parent mustn't be
  // inside it. Checked in the same statement, like a move.
  const row = await db
    .prepare(
      `WITH RECURSIVE ${ANCESTORS}
       INSERT INTO folders (id, parent_id, name, sort, created_at, updated_at, enc, sealed, kgen)
       SELECT ?2, ?1, ?3, ?4, ?5, ?5, ?6, ?7, ?8 WHERE NOT EXISTS (SELECT 1 FROM anc WHERE anc.id = ?2)
       ON CONFLICT(id) DO UPDATE SET parent_id = excluded.parent_id, name = excluded.name, updated_at = excluded.updated_at,
         enc = excluded.enc, sealed = excluded.sealed, kgen = excluded.kgen
       RETURNING *`,
    )
    .bind(parentId, id, name, typeof body.sort === 'number' ? body.sort : 0, now, enc ? 1 : 0, enc ? body.sealed : '', gen)
    .first();
  assert(row, 400, 'cycle', FOLDER_CYCLE);
  return c.json(folderOut(row), 201);
});

api.patch('/folders/:id', async (c) => {
  const id = idParam(c);
  const body = await readJson<Record<string, unknown>>(c);
  const db = c.env.DB;
  const sets: string[] = [];
  const params: unknown[] = [];
  if ('sealed' in body) {
    // A new encrypted name (a rename, or the one-time encryption of the folder's name).
    assert(isCipher(body.sealed, 4000), 400, 'bad_cipher', BAD_FOLDER_CIPHER);
    // The name is the folder's only encrypted field, so a new one is wholly in the current key.
    const gen = await requireKeyGen(db, body.kgen);
    sets.push('enc = 1', "name = ''", 'sealed = ?', 'kgen = ?');
    params.push(body.sealed, gen);
  } else if ('name' in body) {
    await refusePlaintext(db);
    const name = cleanTitle(body.name);
    assert(name, 400, 'bad_name', 'Folder name is required.');
    sets.push('name = ?');
    params.push(name);
  }
  let newParent: string | null = null;
  if ('parent_id' in body) {
    const parentId = body.parent_id === null ? null : body.parent_id;
    assert(parentId === null || isId(parentId), 400, 'bad_parent', 'Invalid parent folder.');
    assert(parentId !== id, 400, 'cycle', FOLDER_CYCLE);
    newParent = parentId;
    sets.push('parent_id = ?');
    params.push(parentId);
  }
  if (typeof body.sort === 'number') {
    sets.push('sort = ?');
    params.push(body.sort);
  }
  assert(sets.length, 400, 'nothing_to_update');
  sets.push('updated_at = ?');
  params.push(Date.now());
  // The move and the check that it doesn't put the folder inside itself are one statement, so two
  // devices moving folders into each other at the same moment can't both succeed and make a loop.
  const noCycle = newParent ? ` AND NOT EXISTS (WITH RECURSIVE ${ANCESTORS} SELECT 1 FROM anc WHERE anc.id = ?)` : '';
  const row = await db
    .prepare(`UPDATE folders SET ${sets.join(', ')} WHERE id = ?${noCycle} RETURNING *`)
    .bind(...params, id, ...(newParent ? [newParent, id] : []))
    .first();
  if (!row && newParent) {
    const exists = await db.prepare('SELECT 1 AS ok FROM folders WHERE id = ?').bind(id).first();
    assert(!exists, 400, 'cycle', FOLDER_CYCLE);
  }
  assert(row, 404, 'not_found', 'Folder not found.');
  return c.json(folderOut(row));
});

/**
 * Encrypts folder names in place, for the app's one-time encryption pass. Only folders still in
 * plaintext change, so a second device running the same pass can't undo a rename made since.
 */
api.post('/folders/seal', async (c) => {
  const db = c.env.DB;
  assert(await encryptionOn(db), 409, 'no_keyring', 'Turn on encryption first.');
  const body = await readJson<{ folders?: unknown; kgen?: unknown }>(c);
  const gen = await requireKeyGen(db, body.kgen);
  const items = Array.isArray(body.folders) ? body.folders : [];
  assert(items.length > 0 && items.length <= 100, 400, 'bad_request', 'Send between 1 and 100 folders.');
  const statements = items.map((raw) => {
    const item = objectItem(raw) as { id?: unknown; sealed?: unknown };
    assert(isId(item.id) && isCipher(item.sealed, 4000), 400, 'bad_cipher', BAD_FOLDER_CIPHER);
    return db
      .prepare(`UPDATE folders SET enc = 1, name = '', sealed = ?, kgen = ? WHERE id = ? AND enc = 0 RETURNING id`)
      .bind(item.sealed, gen, item.id);
  });
  return c.json({ sealed: await sealBatch(db, statements) });
});

/* ------------------------------------------- replacing the encryption key --- */

/**
 * After the encryption key is replaced, everything encrypted under an earlier key generation is
 * encrypted again by the app, a page at a time: notes, history snapshots and folder names. The app
 * reads what's left, decrypts it (it holds the earlier keys, wrapped by the new one), encrypts it with
 * the new key and sends it back. Each write only changes rows still on an older generation, and notes
 * only at the version the app read, so an edit made meanwhile is never undone (it comes up again).
 */
async function rekeyLeft(db: D1Database, gen: number) {
  const row = await db
    .prepare(
      `SELECT (SELECT COUNT(*) FROM notes WHERE kgen < ?1 AND enc = 1) AS notes,
              (SELECT COUNT(*) FROM note_versions WHERE kgen < ?1 AND enc = 1) AS versions,
              (SELECT COUNT(*) FROM folders WHERE kgen < ?1 AND enc = 1) AS folders,
              (SELECT COUNT(*) FROM files WHERE enc = 1 AND kgen < ?1) AS files,
              (SELECT COUNT(*) FROM drawings WHERE enc = 1 AND kgen < ?1) AS drawings`,
    )
    .bind(gen)
    .first<{ notes: number; versions: number; folders: number; files: number; drawings: number }>();
  return {
    notes: row?.notes ?? 0,
    versions: row?.versions ?? 0,
    folders: row?.folders ?? 0,
    files: row?.files ?? 0,
    drawings: row?.drawings ?? 0,
  };
}

/** Uploads and drawings still stored unencrypted, for the app to encrypt (see encryptAttachments in e2ee.ts). */
async function plainAttachments(db: D1Database) {
  const row = await db
    .prepare(
      `SELECT (SELECT COUNT(*) FROM files WHERE enc = 0) AS files, (SELECT COUNT(*) FROM drawings WHERE enc = 0) AS drawings`,
    )
    .first<{ files: number; drawings: number }>();
  return { files: row?.files ?? 0, drawings: row?.drawings ?? 0 };
}

/** The key wrapped for one encrypted file or drawing: re-wrapped with the current key after a replacement. */
function rekeyList(table: 'files' | 'drawings') {
  return async (c: Ctx) => {
    const db = c.env.DB;
    const gen = await currentGen(db);
    const after = c.req.query('after') ?? '';
    const { results } = await db
      .prepare(`SELECT id, sealed FROM ${table} WHERE enc = 1 AND kgen < ? AND id > ? ORDER BY id LIMIT 100`)
      .bind(gen, after)
      .all<{ id: string; sealed: string }>();
    return c.json({ items: results, next: results.length === 100 ? results[results.length - 1].id : null });
  };
}

function rekeySave(table: 'files' | 'drawings') {
  return async (c: Ctx) => {
    const db = c.env.DB;
    const body = await readJson<{ items?: unknown; kgen?: unknown }>(c);
    const gen = await requireKeyGen(db, body.kgen);
    const items = Array.isArray(body.items) ? body.items : [];
    assert(items.length > 0 && items.length <= 100, 400, 'bad_request', 'Send between 1 and 100 items.');
    const statements = items.map((raw) => {
      const item = objectItem(raw) as { id?: unknown; sealed?: unknown };
      assert(isId(item.id) && isCipher(item.sealed, 4000), 400, 'bad_cipher', BAD_FILE_CIPHER);
      return db
        .prepare(`UPDATE ${table} SET sealed = ?, kgen = ? WHERE id = ? AND enc = 1 AND kgen < ? RETURNING id`)
        .bind(item.sealed, gen, item.id, gen);
    });
    const results = await db.batch(statements);
    return c.json({ rekeyed: results.reduce((n, r) => n + r.results.length, 0) });
  };
}

api.get('/rekey/files', rekeyList('files'));
api.post('/rekey/files', rekeySave('files'));
api.get('/rekey/drawings', rekeyList('drawings'));
api.post('/rekey/drawings', rekeySave('drawings'));

api.get('/rekey/notes', async (c) => {
  const db = c.env.DB;
  const gen = await currentGen(db);
  const after = Number(c.req.query('after') ?? 0) || 0;
  const { results } = await db
    .prepare('SELECT seq, id, version, updated_at, content, sealed FROM notes WHERE kgen < ? AND enc = 1 AND seq > ? ORDER BY seq LIMIT 50')
    .bind(gen, after)
    .all<{ seq: number; id: string; version: number; updated_at: number; content: string; sealed: string }>();
  return c.json({
    notes: results.map(({ seq: _s, sealed, ...n }) => ({ ...n, sealed: parseSealed(sealed) })),
    next: results.length === 50 ? results[results.length - 1].seq : null,
  });
});

api.post('/rekey/notes', async (c) => {
  const db = c.env.DB;
  const body = await readJson<{ notes?: unknown; kgen?: unknown }>(c);
  const gen = await requireKeyGen(db, body.kgen);
  const items = Array.isArray(body.notes) ? body.notes : [];
  assert(items.length > 0 && items.length <= 100, 400, 'bad_request', 'Send between 1 and 100 notes.');
  const statements = items.map((raw) => {
    const item = objectItem(raw) as { id?: unknown; version?: unknown; updated_at?: unknown; content?: unknown; sealed?: unknown };
    const sealed = cleanSealed(item.sealed);
    assert(isId(item.id) && Number.isInteger(item.version), 400, 'bad_request', 'Each note needs its id and version.');
    assert(isCipher(item.content) && sealed?.t && sealed.g && sealed.p, 400, 'bad_cipher', BAD_CIPHER);
    assert(item.content.length <= MAX_CONTENT_BYTES, 413, 'too_large', TOO_LARGE);
    // A title or tag change doesn't move the version, but does move updated_at: given the one the app
    // read, a note changed that way since is left for the next pass, rather than having its new title
    // or tags written over with the old ones, encrypted again. (Older versions of the app don't send it.)
    const unchanged = Number.isInteger(item.updated_at);
    return db
      .prepare(
        `UPDATE notes SET content = ?, sealed = ?, kgen = ? WHERE id = ? AND enc = 1 AND version = ? AND kgen < ?${
          unchanged ? ' AND updated_at = ?' : ''
        } RETURNING id`,
      )
      .bind(item.content, JSON.stringify(sealed), gen, item.id, item.version, gen, ...(unchanged ? [item.updated_at] : []));
  });
  const results = await db.batch(statements);
  return c.json({ rekeyed: results.reduce((n, r) => n + r.results.length, 0) });
});

api.get('/rekey/versions', async (c) => {
  const db = c.env.DB;
  const gen = await currentGen(db);
  const after = Number(c.req.query('after') ?? 0) || 0;
  const { results } = await db
    .prepare('SELECT id, note_id, content, sealed FROM note_versions WHERE kgen < ? AND enc = 1 AND id > ? ORDER BY id LIMIT 50')
    .bind(gen, after)
    .all<{ id: number; note_id: string; content: string; sealed: string }>();
  return c.json({
    versions: results.map((v) => ({ ...v, sealed: parseSealed(v.sealed) })),
    next: results.length === 50 ? results[results.length - 1].id : null,
  });
});

api.post('/rekey/versions', async (c) => {
  const db = c.env.DB;
  const body = await readJson<{ versions?: unknown; kgen?: unknown }>(c);
  const gen = await requireKeyGen(db, body.kgen);
  const items = Array.isArray(body.versions) ? body.versions : [];
  assert(items.length > 0 && items.length <= 100, 400, 'bad_request', 'Send between 1 and 100 versions.');
  const statements = items.map((raw) => {
    const item = objectItem(raw) as { id?: unknown; content?: unknown; sealed?: unknown };
    const sealed = cleanSealed(item.sealed, ['t']);
    assert(Number.isInteger(item.id) && isCipher(item.content, MAX_CONTENT_BYTES) && sealed?.t, 400, 'bad_cipher', BAD_CIPHER);
    return db
      .prepare('UPDATE note_versions SET content = ?, sealed = ?, kgen = ? WHERE id = ? AND enc = 1 AND kgen < ? RETURNING id')
      .bind(item.content, JSON.stringify(sealed), gen, item.id, gen);
  });
  const results = await db.batch(statements);
  return c.json({ rekeyed: results.reduce((n, r) => n + r.results.length, 0) });
});

api.post('/rekey/folders', async (c) => {
  const db = c.env.DB;
  const body = await readJson<{ folders?: unknown; kgen?: unknown }>(c);
  const gen = await requireKeyGen(db, body.kgen);
  const items = Array.isArray(body.folders) ? body.folders : [];
  assert(items.length > 0 && items.length <= 100, 400, 'bad_request', 'Send between 1 and 100 folders.');
  const statements = items.map((raw) => {
    const item = objectItem(raw) as { id?: unknown; sealed?: unknown };
    assert(isId(item.id) && isCipher(item.sealed, 4000), 400, 'bad_cipher', BAD_FOLDER_CIPHER);
    return db
      .prepare('UPDATE folders SET sealed = ?, kgen = ? WHERE id = ? AND enc = 1 AND kgen < ? RETURNING id')
      .bind(item.sealed, gen, item.id, gen);
  });
  const results = await db.batch(statements);
  return c.json({ rekeyed: results.reduce((n, r) => n + r.results.length, 0) });
});

api.delete('/folders/:id', async (c) => {
  const id = idParam(c);
  const db = c.env.DB;
  // UNION, not UNION ALL: it stops at a folder already seen, so a loop in older data can't make it run forever.
  const sub = `WITH RECURSIVE sub(id) AS (SELECT ?1 UNION SELECT f.id FROM folders f JOIN sub ON f.parent_id = sub.id)`;
  const [trashed] = await db.batch([
    db
      .prepare(
        `${sub} UPDATE notes SET deleted_at = COALESCE(deleted_at, ?2), folder_id = NULL
         WHERE folder_id IN (SELECT id FROM sub)`,
      )
      .bind(id, Date.now()),
    db.prepare(`${sub} DELETE FROM folders WHERE id IN (SELECT id FROM sub)`).bind(id),
  ]);
  return c.json({ ok: true, trashed: trashed.meta.changes ?? 0 });
});

/* -------------------------------------------------------------- search --- */

api.get('/search', async (c) => {
  const q = (c.req.query('q') ?? '').slice(0, 200);
  const limit = Math.min(Math.max(Number(c.req.query('limit') ?? 30) || 30, 1), 100);
  const match = ftsQuery(q);
  if (!match) return c.json({ results: [] });
  const db = c.env.DB;
  type Hit = { id: string; title: string; folder_id: string | null; updated_at: number; tags: string; snippet: string };
  let hits: Hit[];
  try {
    const res = await db
      .prepare(
        `SELECT n.id, n.title, n.folder_id, n.updated_at, n.tags,
                snippet(notes_fts, 1, char(1), char(2), '…', 18) AS snippet
         FROM notes_fts JOIN notes n ON n.seq = notes_fts.rowid
         WHERE notes_fts MATCH ?1 AND n.deleted_at IS NULL
         ORDER BY bm25(notes_fts, 8.0, 1.0, 4.0)
         LIMIT ?2`,
      )
      .bind(match, limit)
      .all<Hit>();
    hits = res.results;
  } catch (err) {
    console.warn('FTS query failed, falling back to LIKE', err);
    // What was typed, matched as typed: LIKE's wildcards (% and _) and the escape character itself are
    // escaped rather than dropped, so "100%" doesn't find "1000" and "file_name" finds "file_name".
    const like = `%${q.trim().replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
    const res = await db
      .prepare(
        `SELECT id, title, folder_id, updated_at, tags, excerpt AS snippet FROM notes
         WHERE deleted_at IS NULL AND (title LIKE ?1 ESCAPE '\\' OR content LIKE ?1 ESCAPE '\\')
         ORDER BY updated_at DESC LIMIT ?2`,
      )
      .bind(like, limit)
      .all<Hit>();
    hits = res.results;
  }
  return c.json({
    results: hits.map((h) => {
      let tags: string[] = [];
      try {
        tags = JSON.parse(h.tags);
      } catch {
        /* ignore */
      }
      return { ...h, tags };
    }),
  });
});

/* ----------------------------------------------------- blobs to delete --- */

/**
 * A blob that no row points at any more is listed in blob_gc before it's deleted (in the same batch as
 * whatever stops pointing at it, where there is one) and taken off the list once the delete succeeds.
 * A delete that fails (KV's 1,000 a day used up, a passing error) or a Worker stopped partway leaves it
 * listed, and the nightly job tries again, so nothing is forgotten in storage: not the plaintext left
 * when a file is encrypted either. A drawing's parts are listed as they're uploaded, due a day later,
 * and taken off when the drawing is saved with them: parts whose save never came are cleared too.
 */
interface BlobRef {
  storage: StorageKind;
  key: string;
}

const DAY_MS = 86_400_000;
/** Deletes tried in one request or nightly run, well within a Worker's limits; the rest wait their turn. */
const SWEEP_MAX = 200;

function listBlob(db: D1Database, b: BlobRef, due: number, onlyIf?: { sql: string; params: unknown[] }): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO blob_gc (key, storage, due) SELECT ?, ?, ? WHERE ${onlyIf ? onlyIf.sql : '1'}
       ON CONFLICT(key) DO UPDATE SET due = MIN(blob_gc.due, excluded.due)`,
    )
    .bind(b.key, b.storage, due, ...(onlyIf?.params ?? []));
}

/**
 * Lists blobs to delete from `due` on, in one statement however many there are (as a JSON list: the
 * free plan allows a Worker 50 D1 queries a request, so not one statement each).
 */
const listBlobs = (db: D1Database, blobs: BlobRef[], due = Date.now()): D1PreparedStatement[] =>
  blobs.length
    ? [
        db
          .prepare(
            `INSERT INTO blob_gc (key, storage, due)
             SELECT json_extract(value, '$.key'), json_extract(value, '$.storage'), ?2 FROM json_each(?1) WHERE true
             ON CONFLICT(key) DO UPDATE SET due = MIN(blob_gc.due, excluded.due)`,
          )
          .bind(JSON.stringify(blobs.map(({ key, storage }) => ({ key, storage }))), due),
      ]
    : [];

/** Deletes listed blobs now (up to SWEEP_MAX: the nightly job takes the rest), taking each that's gone off the list. */
async function sweepBlobs(env: Env, blobs: BlobRef[]): Promise<void> {
  const gone: string[] = [];
  await Promise.all(
    blobs.slice(0, SWEEP_MAX).map(async (b) => {
      if (await deleteBlob(env, b.storage, b.key)) gone.push(b.key);
    }),
  );
  if (gone.length) await env.DB.prepare('DELETE FROM blob_gc WHERE key IN (SELECT value FROM json_each(?))').bind(JSON.stringify(gone)).run();
}

/** Blobs nothing points at (a lost race, a refused save): listed, then deleted. */
async function dropBlobs(env: Env, blobs: BlobRef[]): Promise<void> {
  if (!blobs.length) return;
  await env.DB.batch(listBlobs(env.DB, blobs));
  await sweepBlobs(env, blobs);
}

/** The nightly job's part: whatever is due, oldest first. One that fails again waits another day, so it can't hold up the rest. */
async function sweepDueBlobs(env: Env): Promise<void> {
  const now = Date.now();
  const { results } = await env.DB.prepare('SELECT key, storage FROM blob_gc WHERE due <= ? ORDER BY due LIMIT ?')
    .bind(now, SWEEP_MAX)
    .all<BlobRef>();
  if (!results.length) return;
  // Pushed back a day first: the ones deleted below come off the list, the rest try again tomorrow.
  await env.DB.prepare('UPDATE blob_gc SET due = ? WHERE key IN (SELECT value FROM json_each(?))')
    .bind(now + DAY_MS, JSON.stringify(results.map((r) => r.key)))
    .run();
  await sweepBlobs(env, results);
}

const drawingParts = (storage: StorageKind, id: string, rev: string): BlobRef[] => [
  { storage, key: drawingKey(id, rev, 'scene') },
  { storage, key: drawingKey(id, rev, 'svg') },
];

/* --------------------------------------------------------------- files --- */

interface FileRow {
  id: string;
  note_id: string | null;
  name: string;
  mime: string;
  size: number;
  storage: StorageKind;
  created_at: number;
  /** 1 when end-to-end encrypted: name and type are in `sealed` with the file's key, the bytes under `blob`. */
  enc?: number;
  sealed?: string;
  kgen?: number;
  blob?: string;
}

/** An encrypted file's address has only its id: its name is in the note that links to it, encrypted. */
const fileUrl = (f: Pick<FileRow, 'id' | 'name' | 'enc'>) => (f.enc ? `/api/files/${f.id}` : `/api/files/${f.id}/${encodeURIComponent(f.name)}`);

/** A file row as the app sees it (the storage key stays on the server). */
function fileOut(f: FileRow) {
  const { blob: _b, ...rest } = f;
  return { ...rest, enc: !!f.enc, url: fileUrl(f) };
}

const BAD_FILE_CIPHER = 'This file isn’t encrypted the way Lumen expects, so it wasn’t saved.';

/** A short random suffix, so each encrypted copy of a file has a storage key of its own. */
const blobSuffix = () => newId(8);

/** A single, well-formed MIME type (no parameters, no lists). Anything else is stored as a generic download. */
const MIME_RE = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,127}$/;
/** Exactly these types may be shown in the browser; everything else is served as a plain download. */
const INLINE_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/avif',
  'image/bmp',
  'image/svg+xml',
  'image/x-icon',
  'image/vnd.microsoft.icon',
  'video/mp4',
  'video/webm',
  'video/ogg',
  'video/quicktime',
  'audio/mpeg',
  'audio/mp4',
  'audio/ogg',
  'audio/wav',
  'audio/x-wav',
  'audio/webm',
  'audio/aac',
  'audio/flac',
  'audio/x-m4a',
  'application/pdf',
  'text/plain',
]);
/** Uploaded content can't run script, even when opened directly in a tab. (PDFs are exempt: the browser's viewer needs scripting.) */
const SANDBOX_CSP = "default-src 'none'; img-src data: blob:; media-src 'self'; style-src 'unsafe-inline'; font-src data:; sandbox";

function cleanMime(value: string | null | undefined): string {
  const mime = (value ?? '').split(';')[0].trim().toLowerCase();
  return MIME_RE.test(mime) ? mime : 'application/octet-stream';
}

function contentDisposition(kind: 'inline' | 'attachment', name: string) {
  return `${kind}; filename*=UTF-8''${encodeURIComponent(name)}`;
}

/** The wrapped key (and name and type) of an encrypted upload, from its request headers. */
function sealedHeader(c: Ctx): string {
  const sealed = c.req.header('x-kb-sealed') ?? '';
  assert(isCipher(sealed, 4000), 400, 'bad_cipher', BAD_FILE_CIPHER);
  return sealed;
}

function kgenHeader(c: Ctx): number {
  const n = Number(c.req.header('x-kb-kgen') ?? '0');
  return Number.isInteger(n) ? n : -1;
}

/** The size of an upload's body, within the storage's limit. An encrypted file is 28 bytes longer (IV and tag). */
function uploadLength(c: Ctx): number {
  const length = Number(c.req.header('content-length') ?? '0');
  assert(length > 0, 400, 'empty', 'The file is empty.');
  const limit = maxUploadBytes(c.env);
  assert(length <= limit, 413, 'too_large', `Files can be up to ${Math.floor(limit / 1024 / 1024)} MB.`);
  return length;
}

api.get('/files', async (c) => {
  const { results } = await c.env.DB.prepare('SELECT * FROM files ORDER BY created_at DESC').all<FileRow>();
  return c.json({ files: results.map(fileOut) });
});

/**
 * Uploads a file. With encryption on, only an encrypted one (x-kb-enc: 1): the bytes are ciphertext, the
 * id is the app's (the ciphertext is bound to it), and x-kb-sealed holds the file's own key with its
 * name and type, wrapped by the master key. The server keeps no name or type for it.
 */
api.post('/files', async (c) => {
  const kind = activeStorage(c.env);
  assert(kind, 503, 'no_storage', 'No file storage is set up. Add a KV namespace (FILES_KV) or an R2 bucket (FILES_BUCKET).');
  const length = uploadLength(c);
  const body = c.req.raw.body;
  assert(body, 400, 'empty', 'The file is empty.');
  const db = c.env.DB;
  const enc = c.req.header('x-kb-enc') === '1';
  let sealed = '';
  let gen = 0;
  if (enc) {
    sealed = sealedHeader(c);
    gen = await requireKeyGen(db, kgenHeader(c));
  } else {
    await refusePlaintext(db);
  }

  let rawName = 'file';
  try {
    rawName = decodeURIComponent(c.req.header('x-file-name') ?? 'file');
  } catch {
    /* keep default */
  }
  const name = enc ? '' : safeFileName(rawName);
  const mime = enc ? 'application/octet-stream' : cleanMime(c.req.header('content-type'));
  const noteHeader = c.req.header('x-note-id');
  const noteId = isId(noteHeader) ? noteHeader : null;

  const requestedId = c.req.header('x-file-id');
  let id: string;
  if (requestedId) {
    assert(isId(requestedId), 400, 'bad_id', 'Invalid file id.');
    const existing = await db.prepare('SELECT * FROM files WHERE id = ?').bind(requestedId).first<FileRow>();
    if (existing) {
      await body.cancel();
      return c.json(fileOut(existing));
    }
    id = requestedId;
  } else {
    assert(!enc, 400, 'bad_id', 'An encrypted file needs its id.');
    id = newId(16);
  }

  // Every upload under a key of its own (older plaintext ones are at files/<id>, blob ''): see plainFileKey.
  const blob = enc ? sealedFileKey(id, blobSuffix()) : plainFileKey(id, blobSuffix());
  await putBlob(c.env, kind, fileKey(id, blob), body, mime);
  const createdAt = Date.now();
  const row = await db
    .prepare(
      `INSERT INTO files (id, note_id, name, mime, size, storage, created_at, enc, sealed, kgen, blob) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO NOTHING RETURNING *`,
    )
    .bind(id, noteId, name, mime, length, kind, createdAt, enc ? 1 : 0, sealed, gen, blob)
    .first<FileRow>();
  if (!row) {
    // The same file arrived twice at once (a restore on two devices): the first one stays.
    c.executionCtx.waitUntil(dropBlobs(c.env, [{ storage: kind, key: fileKey(id, blob) }]));
    const existing = await db.prepare('SELECT * FROM files WHERE id = ?').bind(id).first<FileRow>();
    assert(existing, 409, 'exists', 'A file with this id already exists.');
    return c.json(fileOut(existing));
  }
  return c.json(fileOut(row), 201);
});

/**
 * Replaces an unencrypted upload with its encrypted form, for the app's one-time pass over files saved
 * before they were encrypted. The ciphertext goes under a key of its own, then the row moves to it in
 * one step that only succeeds while the file is still unencrypted, so two devices doing this at once
 * can't undo each other; the loser's copy is deleted, and the plaintext only once the row has moved.
 */
api.put('/files/:id/seal', async (c) => {
  const id = idParam(c);
  const db = c.env.DB;
  assert(await encryptionOn(db), 409, 'no_keyring', 'Turn on encryption first.');
  const sealed = sealedHeader(c);
  const gen = await requireKeyGen(db, kgenHeader(c));
  const length = uploadLength(c);
  const body = c.req.raw.body;
  assert(body, 400, 'empty', 'The file is empty.');
  const row = await db.prepare('SELECT * FROM files WHERE id = ?').bind(id).first<FileRow>();
  assert(row, 404, 'not_found', 'File not found.');
  if (row.enc) {
    await body.cancel();
    return c.json({ sealed: false, file: fileOut(row) });
  }
  const blob = sealedFileKey(id, blobSuffix());
  await putBlob(c.env, row.storage, blob, body, 'application/octet-stream');
  const plain: BlobRef = { storage: row.storage, key: fileKey(id, row.blob) };
  // The plaintext copy goes on the list to delete in the same step as the row moves to the ciphertext,
  // so it can't be left behind in storage: not by a delete that fails, nor by the Worker stopping.
  const [result] = await db.batch([
    db
      .prepare(
        `UPDATE files SET enc = 1, sealed = ?, kgen = ?, blob = ?, name = '', mime = 'application/octet-stream', size = ?
         WHERE id = ? AND enc = 0 RETURNING *`,
      )
      .bind(sealed, gen, blob, length, id),
    listBlob(db, plain, Date.now(), { sql: 'EXISTS (SELECT 1 FROM files WHERE id = ? AND blob = ?)', params: [id, blob] }),
  ]);
  const updated = (result.results as FileRow[])[0];
  if (!updated) {
    c.executionCtx.waitUntil(dropBlobs(c.env, [{ storage: row.storage, key: blob }]));
    const current = await db.prepare('SELECT * FROM files WHERE id = ?').bind(id).first<FileRow>();
    return c.json({ sealed: false, file: current ? fileOut(current) : null });
  }
  c.executionCtx.waitUntil(sweepBlobs(c.env, [plain]));
  return c.json({ sealed: true, file: fileOut(updated) });
});

async function serveFile(c: Ctx) {
  const id = idParam(c);
  const cacheControl = 'private, max-age=31536000, immutable';
  // An encrypted file never changes under its id, so that copy is answered without a lookup.
  const inm = c.req.header('if-none-match');
  if (inm === `"${id}.e"`) {
    return new Response(null, { status: 304, headers: { ETag: inm, 'Cache-Control': cacheControl } });
  }
  const row = await c.env.DB.prepare('SELECT * FROM files WHERE id = ?').bind(id).first<FileRow>();
  assert(row, 404, 'not_found', 'File not found.');
  const etag = row.enc ? `"${id}.e"` : `"${id}"`;
  if (inm === etag) {
    return new Response(null, { status: 304, headers: { ETag: etag, 'Cache-Control': cacheControl } });
  }
  if (row.enc) {
    const stream = await getBlob(c.env, row.storage, fileKey(id, row.blob));
    assert(stream, 404, 'not_found', 'File content is missing from storage.');
    // Ciphertext, for the app to decrypt; the wrapped key (and the name and type inside it) travels in a header.
    return new Response(stream, {
      headers: {
        ETag: etag,
        'Cache-Control': cacheControl,
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': contentDisposition('attachment', 'encrypted'),
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': SANDBOX_CSP,
        'X-Kb-Key': row.sealed ?? '',
      },
    });
  }

  // Checked again here, not only at upload, so older rows and restored backups get the same treatment.
  const stored = cleanMime(row.mime);
  const inline = INLINE_TYPES.has(stored) && c.req.query('download') === undefined;
  const type = INLINE_TYPES.has(stored) ? stored : 'application/octet-stream';
  const headers = new Headers({
    ETag: etag,
    'Cache-Control': cacheControl,
    'Content-Type': type,
    'Content-Disposition': contentDisposition(inline ? 'inline' : 'attachment', row.name),
    'X-Content-Type-Options': 'nosniff',
  });
  if (type !== 'application/pdf') headers.set('Content-Security-Policy', SANDBOX_CSP);
  // Video and audio players ask for parts (Safari on iPhones and iPads won't play without them). An
  // encrypted file is always fetched whole: the app decrypts it and plays it from memory.
  headers.set('Accept-Ranges', 'bytes');
  const ifRange = c.req.header('if-range');
  const range = ifRange && ifRange !== etag ? null : byteRange(c.req.header('range'), row.size);
  if (range === 'unsatisfiable') {
    headers.set('Content-Range', `bytes */${row.size}`);
    return new Response(null, { status: 416, headers });
  }
  if (range) {
    const part = await getBlobRange(c.env, row.storage, fileKey(id, row.blob), range.start, range.end);
    assert(part, 404, 'not_found', 'File content is missing from storage.');
    headers.set('Content-Range', `bytes ${range.start}-${range.end}/${row.size}`);
    headers.set('Content-Length', String(range.end - range.start + 1));
    return new Response(part, { status: 206, headers });
  }
  const stream = await getBlob(c.env, row.storage, fileKey(id, row.blob));
  assert(stream, 404, 'not_found', 'File content is missing from storage.');
  return new Response(stream, { headers });
}

api.get('/files/:id/:name', serveFile);
api.get('/files/:id', serveFile);

api.delete('/files/:id', async (c) => {
  const id = idParam(c);
  const row = await c.env.DB.prepare('SELECT * FROM files WHERE id = ?').bind(id).first<FileRow>();
  assert(row, 404, 'not_found', 'File not found.');
  const bytes: BlobRef = { storage: row.storage, key: fileKey(id, row.blob) };
  await c.env.DB.batch([...listBlobs(c.env.DB, [bytes]), c.env.DB.prepare('DELETE FROM files WHERE id = ?').bind(id)]);
  await sweepBlobs(c.env, [bytes]);
  return c.json({ ok: true });
});

/**
 * The browser's HTTP cache keeps opened files for a year. Once a library's files are encrypted, the app
 * asks for this once, so copies from before (plaintext) are dropped there too.
 */
api.post('/cache/clear', (c) => c.json({ ok: true }, 200, { 'Clear-Site-Data': '"cache"' }));

/** Files and drawings added or changed this recently are never offered for deletion. */
const CLEANUP_GRACE_MS = 7 * DAY_MS;

/**
 * Finds uploads and drawings nothing links to and, when asked (dryRun: false), deletes those of them
 * the person agreed to (`confirm`), and no others.
 * - What links to them comes from the app (`referenced`): every note (the trash too), every saved
 *   version, and its own unsent edits, read (and decrypted, for an encrypted library) on the device.
 *   Reading them all here would take more of the Worker's time than it has; and versions count, so
 *   putting back an older version never brings back missing images.
 * - Anything added or changed in the last week is left out: a note linking to it may not have reached
 *   the server yet (a phone that was offline, say).
 */
api.post('/files/cleanup', async (c) => {
  const body = await readJson<{ dryRun?: boolean; referenced?: unknown; confirm?: unknown }>(c).catch(() => ({ dryRun: true }) as { dryRun: boolean; referenced?: unknown; confirm?: unknown });
  const dryRun = body.dryRun !== false;
  assert(Array.isArray(body.referenced), 409, 'needs_client', 'This copy of Lumen is out of date. Reload the page and try again.');
  const refs = new Set(body.referenced.filter(isId));
  let agreed: { files: Set<string>; drawings: Set<string> } | null = null;
  if (!dryRun) {
    const confirm = body.confirm as { files?: unknown; drawings?: unknown } | undefined;
    assert(confirm && Array.isArray(confirm.files) && Array.isArray(confirm.drawings), 400, 'bad_request', 'Say which files to delete.');
    agreed = { files: new Set(confirm.files.filter(isId)), drawings: new Set(confirm.drawings.filter(isId)) };
  }
  const db = c.env.DB;
  const before = Date.now() - CLEANUP_GRACE_MS;
  const [files, drawings] = await db.batch([
    db.prepare('SELECT id, name, size, storage, enc, sealed, blob FROM files WHERE created_at < ?').bind(before),
    db.prepare('SELECT id, rev, size, storage FROM drawings WHERE updated_at < ?').bind(before),
  ]);
  type Unused = Pick<FileRow, 'id' | 'name' | 'size' | 'storage' | 'enc' | 'sealed' | 'blob'>;
  let unusedFiles = (files.results as unknown as Unused[]).filter((f) => !refs.has(f.id));
  let unusedDrawings = (drawings.results as unknown as DrawingRow[]).filter((d) => !refs.has(d.id));

  if (agreed) {
    // Only what was shown and agreed to: anything the check finds unused now that wasn't, stays.
    const ok = agreed;
    unusedFiles = unusedFiles.filter((f) => ok.files.has(f.id));
    unusedDrawings = unusedDrawings.filter((d) => ok.drawings.has(d.id));
    const blobs: BlobRef[] = [
      ...unusedFiles.map((f) => ({ storage: f.storage, key: fileKey(f.id, f.blob) })),
      ...unusedDrawings.flatMap((d) => drawingParts(d.storage, d.id, d.rev)),
    ];
    // Listed to delete in the same batch as their rows go, then deleted (the nightly job takes over
    // any that fail, or past SWEEP_MAX).
    const each = (ids: string[]) => JSON.stringify(ids);
    const stmts: D1PreparedStatement[] = [
      ...listBlobs(db, blobs),
      db.prepare('DELETE FROM files WHERE id IN (SELECT value FROM json_each(?))').bind(each(unusedFiles.map((f) => f.id))),
      db.prepare('DELETE FROM drawings WHERE id IN (SELECT value FROM json_each(?))').bind(each(unusedDrawings.map((d) => d.id))),
    ];
    await db.batch(stmts);
    await sweepBlobs(c.env, blobs);
  }
  const bytes = unusedFiles.reduce((s, f) => s + f.size, 0) + unusedDrawings.reduce((s, d) => s + d.size, 0);
  return c.json({
    dryRun,
    // An encrypted file's name is in `sealed`, for the app to show.
    files: unusedFiles.map((f) => ({ id: f.id, name: f.name, size: f.size, ...(f.enc ? { enc: true, sealed: f.sealed } : {}) })),
    drawings: unusedDrawings.map((d) => ({ id: d.id, size: d.size })),
    bytes,
  });
});

/* ------------------------------------------------------------ drawings --- */

interface DrawingRow {
  id: string;
  note_id: string | null;
  rev: string;
  storage: StorageKind;
  text: string;
  size: number;
  created_at: number;
  updated_at: number;
  /** 1 when end-to-end encrypted: this revision's key, wrapped by the master key, is in `sealed`. */
  enc?: number;
  sealed?: string;
  kgen?: number;
}

const REV_RE = /^[0-9a-z]{4,24}$/;

api.get('/drawings', async (c) => {
  const { results } = await c.env.DB.prepare(
    'SELECT id, note_id, rev, storage, size, created_at, updated_at, enc FROM drawings ORDER BY updated_at DESC',
  ).all<{ enc: number }>();
  return c.json({ drawings: results.map((d) => ({ ...d, enc: !!d.enc })) });
});

/** Headers for an encrypted drawing's parts: ciphertext, with the revision's wrapped key. */
function sealedDrawingHeaders(row: DrawingRow, cacheControl: string): Record<string, string> {
  return {
    ETag: `"${row.rev}"`,
    'Cache-Control': cacheControl,
    'Content-Type': 'application/octet-stream',
    'Content-Security-Policy': SANDBOX_CSP,
    'X-Content-Type-Options': 'nosniff',
    'X-Kb-Key': row.sealed ?? '',
  };
}

// Registered before '/drawings/:id' so "<id>.svg" isn't captured as an id.
api.get('/drawings/:file{[A-Za-z0-9_-]+\\.svg}', async (c) => {
  const id = c.req.param('file').slice(0, -4);
  assert(isId(id), 400, 'bad_id', 'Invalid drawing id.');
  const row = await c.env.DB.prepare('SELECT * FROM drawings WHERE id = ?').bind(id).first<DrawingRow>();
  assert(row, 404, 'not_found', 'Drawing not found.');
  const etag = `"${row.rev}"`;
  const headers = row.enc
    ? sealedDrawingHeaders(row, 'private, no-cache')
    : {
        ETag: etag,
        'Cache-Control': 'private, no-cache',
        'Content-Type': 'image/svg+xml',
        'Content-Security-Policy': SANDBOX_CSP,
        'X-Content-Type-Options': 'nosniff',
      };
  if (c.req.header('if-none-match') === etag) return new Response(null, { status: 304, headers });
  const stream = await getBlob(c.env, row.storage, drawingKey(id, row.rev, 'svg'));
  assert(stream, 404, 'not_found', 'Drawing image is missing from storage.');
  return new Response(stream, { headers });
});

api.get('/drawings/:id', async (c) => {
  const id = idParam(c);
  const row = await c.env.DB.prepare('SELECT * FROM drawings WHERE id = ?').bind(id).first<DrawingRow>();
  assert(row, 404, 'not_found', 'Drawing not found.');
  return c.json(row);
});

api.get('/drawings/:id/scene', async (c) => {
  const id = idParam(c);
  const row = await c.env.DB.prepare('SELECT * FROM drawings WHERE id = ?').bind(id).first<DrawingRow>();
  assert(row, 404, 'not_found', 'Drawing not found.');
  const stream = await getBlob(c.env, row.storage, drawingKey(id, row.rev, 'scene'));
  assert(stream, 404, 'not_found', 'Drawing data is missing from storage.');
  return new Response(stream, {
    headers: row.enc
      ? sealedDrawingHeaders(row, 'private, no-cache')
      : { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-cache', ETag: `"${row.rev}"` },
  });
});

/** Step 1 & 2 of a save: upload scene and SVG for a new revision (raw bodies, streamed). */
api.put('/drawings/:id/blob/:part', async (c) => {
  const id = idParam(c);
  const part = c.req.param('part');
  assert(part === 'scene' || part === 'svg', 400, 'bad_part');
  const rev = c.req.query('rev') ?? '';
  assert(REV_RE.test(rev), 400, 'bad_rev', 'Invalid revision.');
  const kind = activeStorage(c.env);
  assert(kind, 503, 'no_storage', 'No file storage is set up. Add a KV namespace (FILES_KV) or an R2 bucket (FILES_BUCKET).');
  const length = Number(c.req.header('content-length') ?? '0');
  assert(length > 0, 400, 'empty');
  assert(length <= maxUploadBytes(c.env), 413, 'too_large', 'This drawing is too large to save.');
  const body = c.req.raw.body;
  assert(body, 400, 'empty');
  const db = c.env.DB;
  // With encryption on, only ciphertext (the app sends it as application/octet-stream; readable parts
  // go as JSON and SVG). Refused here rather than at step 3, so a copy of the app from before encryption
  // was turned on can't leave readable parts in storage.
  const sealedPart = (c.req.header('content-type') ?? '').split(';')[0].trim() === 'application/octet-stream';
  if (!sealedPart) await refusePlaintext(db);
  // A revision already in use is never written over: its parts are what the drawing shows.
  const current = await db.prepare('SELECT rev FROM drawings WHERE id = ?').bind(id).first<{ rev: string }>();
  assert(current?.rev !== rev, 409, 'rev_in_use', 'That drawing revision is already saved.');
  // Listed to delete a day from now, and taken off the list when step 3 saves the drawing with it: a
  // save that never gets that far (closed, offline, refused) leaves nothing behind.
  const key = drawingKey(id, rev, part);
  await db.batch(listBlobs(db, [{ storage: kind, key }], Date.now() + DAY_MS));
  await putBlob(c.env, kind, key, body, part === 'svg' ? 'image/svg+xml' : 'application/json');
  return c.json({ ok: true, size: length });
});

/** Step 3: point the drawing at the uploaded revision and drop the old one. */
api.put('/drawings/:id', async (c) => {
  const id = idParam(c);
  const body = await readJson<{
    rev?: string;
    note_id?: string | null;
    text?: string;
    size?: number;
    created_at?: number;
    base_rev?: unknown;
    enc?: unknown;
    sealed?: unknown;
    kgen?: unknown;
  }>(c);
  const rev = body.rev ?? '';
  assert(REV_RE.test(rev), 400, 'bad_rev', 'Invalid revision.');
  // The revision the editor started from (null: a new drawing). Given it, a save on top of a newer
  // revision is refused, so two devices editing one drawing can't silently overwrite each other.
  // Older versions of the app don't send it, and save as before.
  const checked = 'base_rev' in body;
  const baseRev = body.base_rev ?? null;
  assert(!checked || baseRev === null || (typeof baseRev === 'string' && REV_RE.test(baseRev)), 400, 'bad_rev', 'Invalid base revision.');
  const kind = activeStorage(c.env);
  assert(kind, 503, 'no_storage');
  const db = c.env.DB;
  const parts = drawingParts(kind, id, rev);
  // Parts of a revision that won't be used (the save was refused, or another device saved first) are
  // deleted, unless the drawing does show that revision (this step sent again after its answer was lost).
  const dropRevision = async () => {
    const now = await db.prepare('SELECT rev FROM drawings WHERE id = ?').bind(id).first<{ rev: string }>();
    if (now?.rev !== rev) await dropBlobs(c.env, parts);
  };
  // With encryption on, a drawing is only stored encrypted: its parts are ciphertext under this
  // revision's own key, which comes wrapped by the master key in `sealed`.
  const enc = body.enc === true;
  let sealed = '';
  let gen = 0;
  try {
    if (enc) {
      assert(isCipher(body.sealed, 4000), 400, 'bad_cipher', 'This drawing isn’t encrypted the way Lumen expects, so it wasn’t saved.');
      sealed = body.sealed;
      gen = await requireKeyGen(db, body.kgen);
    } else {
      await refusePlaintext(db);
    }
  } catch (err) {
    // Its parts were uploaded first; they'll never be used.
    c.executionCtx.waitUntil(dropRevision());
    throw err;
  }
  const previous = await db.prepare('SELECT * FROM drawings WHERE id = ?').bind(id).first<DrawingRow>();
  const now = Date.now();
  const noteId = isId(body.note_id) ? body.note_id : previous?.note_id ?? null;
  // A drawing's text was kept for search; an encrypted library keeps none of it readable.
  const text = typeof body.text === 'string' && !enc ? body.text.slice(0, 20000) : '';
  const size = typeof body.size === 'number' ? Math.max(0, Math.floor(body.size)) : 0;
  const replaced = previous && previous.rev !== rev ? drawingParts(previous.storage, id, previous.rev) : [];
  const showsThis = { sql: 'EXISTS (SELECT 1 FROM drawings WHERE id = ? AND rev = ?)', params: [id, rev] };
  const [saved] = await db.batch([
    db
      .prepare(
        `INSERT INTO drawings (id, note_id, rev, storage, text, size, created_at, updated_at, enc, sealed, kgen) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET note_id = excluded.note_id, rev = excluded.rev, storage = excluded.storage,
           text = excluded.text, size = excluded.size, updated_at = excluded.updated_at,
           enc = excluded.enc, sealed = excluded.sealed, kgen = excluded.kgen
         ${checked ? 'WHERE drawings.rev IS ?' : ''}
         RETURNING *`,
      )
      .bind(
        id,
        noteId,
        rev,
        kind,
        text,
        size,
        typeof body.created_at === 'number' ? body.created_at : now,
        now,
        enc ? 1 : 0,
        sealed,
        gen,
        ...(checked ? [baseRev] : []),
      ),
    // Saved with these parts: they're the drawing now, no longer left to delete…
    db
      .prepare(`DELETE FROM blob_gc WHERE key IN (?, ?) AND ${showsThis.sql}`)
      .bind(parts[0].key, parts[1].key, ...showsThis.params),
    // …and the revision they replace is (in the same step, so never forgotten in storage).
    ...replaced.map((b) => listBlob(db, b, now, showsThis)),
  ]);
  const row = (saved.results as DrawingRow[])[0];
  if (!row) {
    // Saved elsewhere first: this revision's files will never be used.
    c.executionCtx.waitUntil(dropRevision());
    const current = await db.prepare('SELECT * FROM drawings WHERE id = ?').bind(id).first<DrawingRow>();
    return c.json(
      { error: 'drawing_conflict', message: 'This drawing was changed on another device since you opened it.', drawing: current },
      409,
    );
  }
  if (replaced.length) c.executionCtx.waitUntil(sweepBlobs(c.env, replaced));
  return c.json(row);
});

api.delete('/drawings/:id', async (c) => {
  const id = idParam(c);
  const row = await c.env.DB.prepare('SELECT * FROM drawings WHERE id = ?').bind(id).first<DrawingRow>();
  assert(row, 404, 'not_found', 'Drawing not found.');
  const parts = drawingParts(row.storage, id, row.rev);
  await c.env.DB.batch([...listBlobs(c.env.DB, parts), c.env.DB.prepare('DELETE FROM drawings WHERE id = ?').bind(id)]);
  await sweepBlobs(c.env, parts);
  return c.json({ ok: true });
});

/* ---------------------------------------------- end-to-end encryption --- */

/**
 * The keyring: the master key wrapped (encrypted) by the passphrase and by the recovery key, plus
 * the key-derivation settings. Nothing in it can decrypt anything without one of those secrets,
 * which never reach the server.
 */
api.get('/keyring', async (c) => {
  const row = await c.env.DB.prepare('SELECT id, data, created_at FROM keyring ORDER BY id DESC LIMIT 1').first<{
    id: number;
    data: string;
    created_at: number;
  }>();
  return c.json({ keyring: row ? { id: row.id, created_at: row.created_at, data: JSON.parse(row.data) as unknown } : null });
});

/**
 * Stores a new keyring (turning encryption on, a new passphrase, a new recovery key), only on top of
 * the one the app last read (`replaces`), so two devices changing it at once can't silently
 * overwrite each other. Earlier keyrings are then deleted: they hold the same key wrapped by the old
 * passphrase or recovery key, which must stop working once replaced.
 */
api.post('/keyring', async (c) => {
  const body = await readJson<{ data?: unknown; replaces?: unknown }>(c);
  const data = body.data;
  assert(data && typeof data === 'object' && !Array.isArray(data), 400, 'bad_keyring', 'Missing keyring.');
  const text = JSON.stringify(data);
  assert(text.length <= 16_000, 400, 'bad_keyring', 'Keyring is too large.');
  const k = data as { v?: unknown; kdf?: { salt?: unknown }; pass?: { key?: unknown }; recovery?: { key?: unknown } };
  assert(
    k.v === 1 && typeof k.kdf?.salt === 'string' && typeof k.pass?.key === 'string' && typeof k.recovery?.key === 'string',
    400,
    'bad_keyring',
    'Keyring is incomplete.',
  );
  const replaces = typeof body.replaces === 'number' ? body.replaces : null;
  const db = c.env.DB;
  // The key generation goes up by one when the key is replaced, and otherwise stays: never back
  // (writes under an earlier key would be accepted again), never skipping one. Earlier keys travel
  // with the keyring, wrapped by the current one.
  const extra = data as { gen?: unknown; prev?: unknown };
  const gen = extra.gen === undefined ? 0 : extra.gen;
  const stored = await db.prepare('SELECT 1 AS ok FROM keyring LIMIT 1').first();
  if (stored) {
    const before = await currentGen(db);
    assert(Number.isInteger(gen) && (gen === before || gen === before + 1), 400, 'bad_keyring', 'Keyring generation is out of step. Reload and try again.');
  } else {
    // None stored: encryption being turned on, or a device putting its copy back after the keyring
    // went missing (vault.fetchKeyring), perhaps after several key replacements. Any generation the
    // stored items aren't ahead of: an older keyring can't come back over newer ciphertext.
    const newest = await db
      .prepare(
        `SELECT MAX(g) AS g FROM (SELECT MAX(kgen) AS g FROM notes UNION ALL SELECT MAX(kgen) FROM note_versions
           UNION ALL SELECT MAX(kgen) FROM folders UNION ALL SELECT MAX(kgen) FROM files UNION ALL SELECT MAX(kgen) FROM drawings)`,
      )
      .first<{ g: number | null }>();
    assert(Number.isInteger(gen) && (gen as number) >= (newest?.g ?? 0), 400, 'bad_keyring', 'Keyring generation is out of step. Reload and try again.');
  }
  assert(
    extra.prev === undefined ||
      (Array.isArray(extra.prev) &&
        extra.prev.length <= 20 &&
        extra.prev.every((w) => w && typeof (w as { iv?: unknown }).iv === 'string' && typeof (w as { key?: unknown }).key === 'string')),
    400,
    'bad_keyring',
    'Keyring is incomplete.',
  );
  // One transaction: the insert only happens on top of the keyring the app read (so two devices
  // can't overwrite each other), and the older one goes with it.
  const [inserted] = await db.batch([
    db
      .prepare('INSERT INTO keyring (data, created_at) SELECT ?1, ?2 WHERE (SELECT MAX(id) FROM keyring) IS ?3 RETURNING id, created_at')
      .bind(text, Date.now(), replaces),
    db.prepare('DELETE FROM keyring WHERE id < (SELECT MAX(id) FROM keyring)'),
  ]);
  const row = (inserted.results as Array<{ id: number; created_at: number }>)[0];
  assert(row, 409, 'keyring_changed', 'Encryption settings were changed on another device. Reload and try again.');
  if (replaces === null) await eraseIndexOnDelete(db);
  return c.json({ keyring: { ...row, data } }, 201);
});

/** The app's last step of the encryption pass. The server also does this on its own (see finishIfDone). */
api.post('/encryption/finish', async (c) => {
  const db = c.env.DB;
  assert(await encryptionOn(db), 409, 'no_keyring', 'Turn on encryption first.');
  const left = await finishIfDone(db);
  if (!left.wiped) return c.json({ error: 'pending', pending: pendingCounts(left) }, 409);
  return c.json({ ok: true });
});

/* -------------------------------------------------------------- export --- */

api.get('/export/notes', async (c) => {
  const after = Number(c.req.query('after') ?? 0) || 0;
  const limit = Math.min(Math.max(Number(c.req.query('limit') ?? 100) || 100, 1), 200);
  const { results } = await c.env.DB.prepare('SELECT * FROM notes WHERE seq > ? ORDER BY seq LIMIT ?')
    .bind(after, limit)
    .all<NoteRow>();
  return c.json({
    notes: results.map((r) => ({ ...toMeta(r), content: r.content })),
    next: results.length === limit ? results[results.length - 1].seq : null,
  });
});

/* ------------------------------------------------------------- backups --- */

/** When the last backup of the whole library was made, from any device (for the reminder on Home). */
async function noteBackupMade(db: D1Database): Promise<number> {
  const at = Date.now();
  await db.prepare("INSERT INTO kb_meta (key, value) VALUES ('last_backup', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(String(at)).run();
  return at;
}

/** A backup of the whole library was downloaded: remembered (for every device) so Home can remind when it's been a while. */
api.post('/backups/made', async (c) => {
  const at = await noteBackupMade(c.env.DB);
  return c.json({ ok: true, at });
});

/*
 * Automatic backups, kept in an R2 bucket of their own (BACKUP_BUCKET; off without one). The app makes
 * each one as "Download backup" does (src/lib/autoBackup.ts), about once a week, and sends it here:
 * with encryption on, sealed on the device with the library key, so this keeps only ciphertext. The
 * newest KEEP_BACKUPS are kept. Restoring one is the app's ordinary restore, from the file sent back.
 */
const KEEP_BACKUPS = 8;
/** Under the Workers request size limit (100 MB on the free plan). */
const MAX_AUTO_BACKUP = 95 * 1024 * 1024;
const BACKUP_NAME = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.(?:lumenbackup|zip)$/;
/** How an encrypted backup file starts (src/lib/sealedBackup.ts). */
const SEALED_MAGIC = 'LUMENBK1';

interface BackupInfo {
  name: string;
  size: number;
  made_at: number;
  encrypted: boolean;
}

function backupBucket(c: Ctx): R2Bucket {
  const bucket = c.env.BACKUP_BUCKET;
  assert(bucket, 404, 'backups_off', 'Automatic backups aren’t set up on this Lumen. The README says how to turn them on.');
  return bucket;
}

async function listBackups(bucket: R2Bucket): Promise<BackupInfo[]> {
  const out: BackupInfo[] = [];
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix: 'backups/', cursor, include: ['customMetadata'] });
    for (const o of page.objects) {
      const name = o.key.slice('backups/'.length);
      if (!BACKUP_NAME.test(name)) continue;
      out.push({ name, size: o.size, made_at: Number(o.customMetadata?.made_at) || o.uploaded.getTime(), encrypted: name.endsWith('.lumenbackup') });
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return out.sort((a, b) => b.made_at - a.made_at);
}

/** The body as it arrives, refused partway if it doesn't start as an encrypted backup does. */
function sealedOnly(body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  let head = '';
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, ctl) {
        if (head.length < SEALED_MAGIC.length) {
          head += new TextDecoder().decode(chunk.subarray(0, SEALED_MAGIC.length - head.length));
          if (head.length >= SEALED_MAGIC.length && head !== SEALED_MAGIC) {
            ctl.error(new HttpError(400, 'not_sealed', 'That isn’t an encrypted Lumen backup.'));
            return;
          }
        }
        ctl.enqueue(chunk);
      },
      flush(ctl) {
        if (head !== SEALED_MAGIC) ctl.error(new HttpError(400, 'not_sealed', 'That isn’t an encrypted Lumen backup.'));
      },
    }),
  );
}

api.get('/backups', async (c) => {
  const bucket = c.env.BACKUP_BUCKET;
  if (!bucket) return c.json({ available: false, keep: KEEP_BACKUPS, backups: [] });
  return c.json({ available: true, keep: KEEP_BACKUPS, backups: await listBackups(bucket) });
});

api.post('/backups', async (c) => {
  const bucket = backupBucket(c);
  const length = Number(c.req.header('content-length') ?? '0');
  assert(length > 0, 400, 'empty', 'The backup is empty.');
  assert(length <= MAX_AUTO_BACKUP, 413, 'too_large', 'This backup is too big to keep on the server (over 95 MB). Download it from Settings instead.');
  const sealed = c.req.header('x-kb-backup') === 'sealed';
  // With encryption on, only an encrypted backup: what's kept here stays unreadable without your key.
  assert(sealed || !(await encryptionOn(c.env.DB)), 409, 'encryption_required', 'With encryption on, only an encrypted backup can be kept.');
  // Made automatically on two devices at once: one is enough.
  if (c.req.header('x-kb-auto') === '1') {
    const newest = (await listBackups(bucket))[0];
    assert(!newest || Date.now() - newest.made_at > 6 * 3_600_000, 409, 'recent', 'A backup was made in the last few hours already.');
  }
  const body = c.req.raw.body;
  assert(body, 400, 'empty', 'The backup is empty.');
  const madeAt = Date.now();
  // When it was made, to the millisecond ("2026-11-20T03-17-00-123Z"): two never share a name.
  const name = `${new Date(madeAt).toISOString().replace(/[:.]/g, '-')}.${sealed ? 'lumenbackup' : 'zip'}`;
  // A known length, as R2 needs (the check in between would lose it otherwise).
  const fixed = new FixedLengthStream(length);
  let refused: unknown = null;
  const piped = (sealed ? sealedOnly(body) : body).pipeTo(fixed.writable).catch((err: unknown) => {
    refused = err;
  });
  try {
    await bucket.put(`backups/${name}`, fixed.readable, {
      httpMetadata: { contentType: 'application/octet-stream' },
      customMetadata: { made_at: String(madeAt) },
    });
    await piped;
    if (refused) throw refused;
  } catch (err) {
    await piped;
    await bucket.delete(`backups/${name}`).catch(() => undefined);
    // Why the body was refused (not an encrypted backup) over how storing it then failed.
    const reason = refused ?? err;
    if (reason instanceof HttpError) throw reason;
    throw new HttpError(400, 'incomplete', 'The backup didn’t arrive whole. Try again.');
  }
  const at = await noteBackupMade(c.env.DB);
  // Only the newest are kept.
  const old = (await listBackups(bucket)).slice(KEEP_BACKUPS);
  if (old.length) await bucket.delete(old.map((b) => `backups/${b.name}`));
  return c.json({ ok: true, name, at }, 201);
});

api.get('/backups/:name', async (c) => {
  const bucket = backupBucket(c);
  const name = c.req.param('name');
  assert(BACKUP_NAME.test(name), 404, 'not_found', 'Backup not found.');
  const obj = await bucket.get(`backups/${name}`);
  assert(obj, 404, 'not_found', 'Backup not found.');
  return new Response(obj.body, {
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(obj.size),
      'Content-Disposition': contentDisposition('attachment', `lumen-${name}`),
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
});

api.delete('/backups/:name', async (c) => {
  const bucket = backupBucket(c);
  const name = c.req.param('name');
  assert(BACKUP_NAME.test(name), 404, 'not_found', 'Backup not found.');
  await bucket.delete(`backups/${name}`);
  return c.json({ ok: true });
});

/* ------------------------------------------------------------ settings --- */

/**
 * The settings that follow the person to every device (theme, fonts, editor options and so on; the
 * app decides which). One record: the settings as JSON, or encrypted like a folder name once the
 * library is, with the server's time of the save. A save names the time of the version it started
 * from, and is refused if another device saved since, so the app can merge and try again.
 */
interface StoredSettings {
  at: number;
  enc: boolean;
  data: string;
  kgen: number;
}

const MAX_SETTINGS = 16_000;

function storedSettings(value: string | undefined): StoredSettings | null {
  if (!value) return null;
  try {
    const v = JSON.parse(value) as Partial<StoredSettings>;
    if (typeof v.at !== 'number' || typeof v.data !== 'string') return null;
    return { at: v.at, enc: !!v.enc, data: v.data, kgen: Number(v.kgen) || 0 };
  } catch {
    return null;
  }
}

api.put('/settings', async (c) => {
  const body = await readJson<{ enc?: unknown; data?: unknown; kgen?: unknown; base?: unknown }>(c);
  const db = c.env.DB;
  let kgen = 0;
  if (body.enc === true) {
    assert(isCipher(body.data, MAX_SETTINGS), 400, 'bad_cipher', 'Those settings aren’t encrypted the way Lumen expects.');
    kgen = await requireKeyGen(db, body.kgen);
  } else {
    await refusePlaintext(db);
    assert(typeof body.data === 'string' && fitsBytes(body.data, MAX_SETTINGS), 400, 'bad_settings', 'Those settings can’t be saved.');
    let parsed: unknown;
    try {
      parsed = JSON.parse(body.data);
    } catch {
      /* checked below */
    }
    assert(parsed && typeof parsed === 'object' && !Array.isArray(parsed), 400, 'bad_settings', 'Those settings can’t be saved.');
  }
  const base = typeof body.base === 'number' ? body.base : 0;
  // Strictly later than anything stored, even within the same millisecond.
  const current = storedSettings((await db.prepare("SELECT value FROM kb_meta WHERE key = 'settings'").first<{ value: string }>())?.value);
  const at = Math.max(Date.now(), (current?.at ?? 0) + 1);
  const record: StoredSettings = { at, enc: body.enc === true, data: body.data as string, kgen };
  // Saved only if nothing newer than the version this save started from was stored meanwhile.
  const saved = await db
    .prepare(
      `INSERT INTO kb_meta (key, value) VALUES ('settings', ?1)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value
       WHERE COALESCE(json_extract(kb_meta.value, '$.at'), 0) <= ?2
       RETURNING value`,
    )
    .bind(JSON.stringify(record), base)
    .first<{ value: string }>();
  if (saved) return c.json({ ok: true, at });
  const now = storedSettings((await db.prepare("SELECT value FROM kb_meta WHERE key = 'settings'").first<{ value: string }>())?.value);
  return c.json({ ok: false, settings: now });
});

/* ------------------------------------------------------------ sign out --- */

/**
 * "Sign out of this device" calls this before ending the Access session. Clear-Site-Data empties the
 * browser's HTTP cache for this site, where opened files and images otherwise stay for a year
 * (they're served as immutable). The app clears its own storage and caches itself.
 */
api.post('/signout', (c) => c.json({ ok: true }, 200, { 'Clear-Site-Data': '"cache"' }));

/* ------------------------------------------------------------ app root --- */

/**
 * A Cloudflare free-tier daily allowance used up: D1's rows read or written ("Your account has exceeded
 * D1's free tier daily row read limit"), KV's writes. Each resets at 00:00 UTC, so a retry before then
 * only fails again (and spends a request of the day's 100,000): the app is told when to come back.
 */
const DAILY_LIMIT = /\b(?:daily|for the day|per day|free tier)\b/i;
const OVER = /exceed|limit/i;

function nextUtcMidnight(now: number): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
}

function handleError(err: Error, c: Ctx) {
  if (err instanceof HttpError) {
    return c.json({ error: err.code, message: err.message }, err.status as 400);
  }
  const text = err instanceof Error ? err.message : String(err);
  if (DAILY_LIMIT.test(text) && OVER.test(text)) {
    console.error(err);
    const now = Date.now();
    const resetAt = nextUtcMidnight(now);
    return c.json(
      {
        error: 'quota_exceeded',
        message: 'Lumen has used up one of Cloudflare’s free daily allowances. It resets at midnight UTC.',
        resetAt,
      },
      429,
      { 'Retry-After': String(Math.ceil((resetAt - now) / 1000)) },
    );
  }
  // Details go to the Worker logs, not to the browser.
  console.error(err);
  return c.json({ error: 'server_error', message: 'Something went wrong on the server. Try again in a moment.' }, 500);
}

api.onError(handleError);

const app = new Hono<AppEnv>();
app.onError((err, c) => secureResponse(handleError(err, c)));

// The gate: runs for every request (wrangler.jsonc sends all paths to the Worker first),
// so the app shell, scripts, files and API are all closed to anyone Access hasn't signed in.
app.use('*', async (c, next) => {
  // The setup page's form, which claims a Lumen that has no Access settings yet (see gate.ts).
  if (c.req.method === 'POST' && new URL(c.req.url).pathname === SETUP_PATH) return secureResponse(await claimSetup(c));
  const result = await authenticate(c);
  if (!result.ok) return secureResponse(refuse(c, result));
  c.set('user', result.user);
  await next();
  c.res = secureResponse(c.res);
});

app.route('/api', api);
// Something shared into Lumen from another app is received by the service worker, on the device. This
// only answers when there's none yet (the first visit): the body isn't read, and the app says to try again.
app.post('/share', (c) => c.redirect('/?share=unavailable', 303));
// Unmatched API paths must answer JSON, not fall through to the HTML app shell. The code differs from
// a missing note's 'not_found', which the app treats as "deleted on another device".
app.all('/api/*', (c) => c.json({ error: 'no_route', message: 'Unknown API route.' }, 404));
app.all('*', serveAsset);

async function purgeOldTrash(env: Env) {
  await ensureSchema(env.DB);
  const cutoff = Date.now() - TRASH_RETENTION_MS;
  await env.DB.batch([
    env.DB.prepare(
      'DELETE FROM note_versions WHERE note_id IN (SELECT id FROM notes WHERE deleted_at IS NOT NULL AND deleted_at < ?)',
    ).bind(cutoff),
    env.DB.prepare('DELETE FROM notes WHERE deleted_at IS NOT NULL AND deleted_at < ?').bind(cutoff),
  ]);
}

export default {
  fetch: app.fetch,
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(purgeOldTrash(env).then(() => sweepDueBlobs(env)));
  },
} satisfies ExportedHandler<Env>;
