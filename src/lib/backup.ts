import { strToU8, strFromU8, unzipSync, zipSync, type Zippable } from 'fflate';
import { api, ApiError, errorMessage, NetworkError } from './api';
import { DAMAGED_KEY, openSealedBackup, readSealedBackup, sealBackup } from './sealedBackup';
import { loadAll, useApp } from './store';
import type { DrawingInfo, FileInfo, Folder, KeyringData, Note } from './types';
import { currentKeyring, deviceKeys, keysFromSecret } from './vault';
import { safeName, todayIso, uploadSafeName } from './utils';

/**
 * Backup format (a .zip):
 *   kb-backup.json        everything needed to restore (folders, notes, file + drawing metadata)
 *   files/<id>-<name>     uploaded files
 *   drawings/<id>.excalidraw / .svg
 *   notes/<folders>/<title>.md   readable copies with relative links (open in any Markdown app)
 */

interface Manifest {
  format: 'kb-backup';
  version: 1;
  exported_at: number;
  folders: Folder[];
  notes: Note[];
  files: FileInfo[];
  drawings: DrawingInfo[];
}

export type Progress = (message: string, fraction?: number) => void;

/** An upload's or drawing's bytes, decrypted when the library is encrypted (a backup holds readable copies). */
const fetchBytes = (url: string): Promise<Uint8Array> => api.assetBytes(url);

/** With one retry, for a connection that drops for a moment during a long backup. */
async function fetchBytesRetry(url: string): Promise<Uint8Array> {
  try {
    return await fetchBytes(url);
  } catch {
    await new Promise((r) => setTimeout(r, 1500));
    return fetchBytes(url);
  }
}

/** YAML front matter (title, tags, dates) as Obsidian and most Markdown tools read it. */
export function frontMatter(n: Pick<Note, 'title' | 'tags' | 'created_at' | 'updated_at'>): string {
  const esc = (s: string) => JSON.stringify(s);
  const lines = ['---', `title: ${esc(n.title || 'Untitled')}`];
  if (n.tags.length) lines.push(`tags: [${n.tags.map(esc).join(', ')}]`);
  lines.push(`created: ${new Date(n.created_at).toISOString()}`, `updated: ${new Date(n.updated_at).toISOString()}`, '---', '');
  return lines.join('\n');
}

/**
 * `missing` names the files and drawings that couldn't be downloaded into the backup even after a
 * retry, so the person is told now rather than finding out when they need them. `unreadable` names the
 * notes this device can't decrypt (encrypted with another key, or changed outside Lumen): they're left
 * out, rather than one of them stopping the whole backup. `encrypted`: the .zip encrypted on this
 * device (a .lumenbackup, see sealedBackup.ts), which needs the library unlocked here. Otherwise a
 * readable .zip.
 */
export async function exportBackup(
  onProgress: Progress,
  opts: { encrypted?: boolean } = {},
): Promise<{ blob: Blob; filename: string; missing: string[]; unreadable: string[] }> {
  // Checked first, so a long download isn't wasted on a backup that can't be encrypted.
  const sealing = opts.encrypted ? await sealingKey() : null;
  onProgress('Reading notes…', 0);
  const boot = await api.bootstrap();
  const notes: Note[] = [];
  const unreadableIds: string[] = [];
  let after = 0;
  for (;;) {
    const page = await api.exportNotes(after);
    notes.push(...page.notes);
    unreadableIds.push(...page.unreadable);
    onProgress(`Reading notes… ${notes.length}`, 0.1);
    if (page.next === null) break;
    after = page.next;
  }
  const [{ files }, { drawings }] = await Promise.all([api.listFiles(), api.listDrawings()]);

  const zip: Zippable = {};
  const total = files.length + drawings.length;
  let done = 0;
  const fileNames = new Map<string, string>();
  const missing: string[] = [];
  for (const f of files) {
    const path = `files/${f.id}-${uploadSafeName(f.name)}`;
    fileNames.set(f.id, path);
    try {
      zip[path] = [await fetchBytesRetry(`/api/files/${f.id}`), { level: /^(image|video|audio)\/|zip|pdf/.test(f.mime) ? 0 : 6 }];
    } catch {
      // Keep going so one bad file doesn't sink the backup, but say so at the end.
      missing.push(f.name);
    }
    onProgress(`Downloading files… ${++done} of ${total}`, 0.15 + (0.75 * done) / Math.max(1, total));
  }
  for (const d of drawings) {
    try {
      zip[`drawings/${d.id}.excalidraw`] = await fetchBytesRetry(`/api/drawings/${d.id}/scene`);
      zip[`drawings/${d.id}.svg`] = await fetchBytesRetry(`/api/drawings/${d.id}.svg`);
    } catch {
      missing.push(`a drawing (${d.id})`);
    }
    onProgress(`Downloading drawings… ${++done} of ${total}`, 0.15 + (0.75 * done) / Math.max(1, total));
  }

  // Readable Markdown copies.
  const byId = new Map(boot.folders.map((f) => [f.id, f]));
  const folderDir = (id: string | null): string[] => {
    const parts: string[] = [];
    let cur = id ? byId.get(id) : undefined;
    let guard = 0;
    while (cur && guard++ < 50) {
      parts.unshift(safeName(cur.name, 'Folder'));
      cur = cur.parent_id ? byId.get(cur.parent_id) : undefined;
    }
    return parts;
  };
  const used = new Set<string>();
  for (const n of notes) {
    if (n.deleted_at) continue;
    const dir = ['notes', ...folderDir(n.folder_id)];
    const base = safeName(n.title || 'Untitled');
    let path = `${dir.join('/')}/${base}.md`;
    for (let i = 2; used.has(path.toLowerCase()); i++) path = `${dir.join('/')}/${base} ${i}.md`;
    used.add(path.toLowerCase());
    const up = '../'.repeat(dir.length);
    const body = n.content
      .replace(/\/api\/files\/([A-Za-z0-9_-]+)(?:\/[^\s)"]*)?/g, (m, id: string) => (fileNames.has(id) ? up + fileNames.get(id) : m))
      .replace(/\/api\/drawings\/([A-Za-z0-9_-]+)\.svg/g, (_m, id: string) => `${up}drawings/${id}.svg`);
    zip[path] = strToU8(frontMatter(n) + body);
  }

  const manifest: Manifest = {
    format: 'kb-backup',
    version: 1,
    exported_at: Date.now(),
    folders: boot.folders,
    notes,
    files,
    drawings,
  };
  zip['kb-backup.json'] = strToU8(JSON.stringify(manifest));
  // Named by the title in the note list, which is encrypted separately and usually still opens.
  const titles = new Map(boot.notes.map((n) => [n.id, n.title]));
  const unreadable = unreadableIds.map((id) => titles.get(id) || 'Untitled');
  onProgress('Compressing…', 0.92);
  const data = zipSync(zip);
  if (sealing) {
    onProgress('Encrypting…', 0.97);
    const blob = await sealBackup(data, sealing.key, sealing.keyring, sealing.gen);
    onProgress('Done', 1);
    return { blob, filename: `lumen-${todayIso()}.lumenbackup`, missing, unreadable };
  }
  onProgress('Done', 1);
  return { blob: new Blob([data as BlobPart], { type: 'application/zip' }), filename: `lumen-${todayIso()}.zip`, missing, unreadable };
}

/** The library key and the encryption settings to put in an encrypted backup. */
async function sealingKey(): Promise<{ key: CryptoKey; keyring: KeyringData; gen: number }> {
  const [key] = deviceKeys();
  if (!key) throw new Error('Unlock Lumen on this device to make an encrypted backup.');
  const keyring = await currentKeyring();
  if (!keyring) throw new Error('Lumen can’t find your encryption settings right now. Check your connection and try again.');
  return { key, keyring: keyring.data, gen: keyring.data.gen ?? 0 };
}

/**
 * The .zip inside a backup file: as it is, or decrypted. An encrypted one opens with this device's key
 * if it's the one the backup was made with; otherwise `askSecret` is asked for the passphrase or
 * recovery key from then (with a reason when the last answer didn't open it), until it opens or the
 * person gives up (null).
 */
async function backupZip(bytes: Uint8Array, askSecret: (retry: boolean) => Promise<string | null>): Promise<Uint8Array | null> {
  const sealed = readSealedBackup(bytes);
  if (!sealed) return bytes;
  const opened = await openSealedBackup(sealed, deviceKeys());
  if (opened) return opened;
  for (let attempt = 0; ; attempt++) {
    const secret = await askSecret(attempt > 0);
    if (secret === null) return null;
    // As typed first: a passphrase is used exactly as it was set (spaces at its ends included). Trimmed
    // after that, for a recovery key pasted with a stray space.
    const keys =
      (await keysFromSecret(sealed.header.keyring, secret)) ??
      (secret.trim() !== secret ? await keysFromSecret(sealed.header.keyring, secret.trim()) : null);
    if (!keys) continue;
    const zip = await openSealedBackup(sealed, keys);
    if (zip) return zip;
    // The secret opened the encryption settings in the file, so it's the right one: asking again
    // would only make the person doubt it. The backup's own key was changed.
    throw new Error(DAMAGED_KEY);
  }
}

/**
 * What a backup may unpack to, here in the browser: more than any backup Lumen makes (which is built in
 * a browser's memory too), less than a tab can hold. A .zip that says it unpacks to more (a "zip bomb",
 * kilobytes that inflate to gigabytes) is refused before anything is unpacked, rather than crashing the
 * tab. Each file's size is the one the .zip states, and nothing unpacks past it.
 */
export const RESTORE_MAX_BYTES = 2 * 1024 ** 3;
export const RESTORE_MAX_ENTRY_BYTES = 512 * 1024 ** 2;

function unzipBackup(zip: Uint8Array): ReturnType<typeof unzipSync> {
  let total = 0;
  return unzipSync(zip, {
    filter: (file) => {
      total += file.originalSize;
      if (file.originalSize > RESTORE_MAX_ENTRY_BYTES || total > RESTORE_MAX_BYTES) {
        throw new Error('This backup unpacks to more than Lumen can restore in a browser (over 2 GB, or a file over 512 MB). Nothing was restored.');
      }
      return true;
    },
  });
}

export interface RestoreResult {
  notes: number;
  files: number;
  drawings: number;
  /** Drawings changed since the backup was made: left as they are (drawings keep no history to fall back on). */
  keptDrawings: number;
  /** What couldn't be put back (by title or file name), each with the reason. */
  failed: string[];
}

/** What a restore did, in words for the person: an error when something couldn't be put back. */
export function restoreSummary(r: RestoreResult): { message: string; kind: 'success' | 'error' } {
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  const parts = [`Restored ${plural(r.notes, 'note', 'notes')}, ${plural(r.files, 'file', 'files')} and ${plural(r.drawings, 'drawing', 'drawings')}.`];
  if (r.keptDrawings) {
    parts.push(
      r.keptDrawings === 1
        ? 'A drawing changed since the backup was made was kept as it is.'
        : `${r.keptDrawings} drawings changed since the backup was made were kept as they are.`,
    );
  }
  if (r.failed.length) {
    const shown = r.failed.slice(0, 5).join(', ');
    parts.push(`Couldn’t restore ${shown}${r.failed.length > 5 ? ` and ${r.failed.length - 5} more` : ''}.`);
  }
  return { message: parts.join(' '), kind: r.failed.length ? 'error' : 'success' };
}

/**
 * Stops a restore: nothing more would get through (offline, signed out, today's Cloudflare allowance
 * used up, the key replaced elsewhere). Anything else is about one item, which is listed and skipped.
 */
function stopsRestore(err: unknown): boolean {
  if (err instanceof NetworkError) return true;
  return err instanceof ApiError && (err.status === 401 || ['quota_exceeded', 'key_changed', 'encryption_required'].includes(err.code));
}

export async function restoreBackup(
  file: File,
  onProgress: Progress,
  askSecret: (retry: boolean) => Promise<string | null> = async () => null,
): Promise<RestoreResult | null> {
  onProgress('Opening backup…', 0);
  const zip = await backupZip(new Uint8Array(await file.arrayBuffer()), askSecret);
  if (!zip) return null;
  const entries = unzipBackup(zip);
  const raw = entries['kb-backup.json'];
  if (!raw) throw new Error('This zip isn’t a Lumen backup (kb-backup.json is missing).');
  const manifest = JSON.parse(strFromU8(raw)) as Manifest;
  if (manifest.format !== 'kb-backup') throw new Error('Unrecognised backup format.');

  // Parents before children.
  const depth = (f: Folder, seen = 0): number => {
    const parent = manifest.folders.find((p) => p.id === f.parent_id);
    return parent && seen < 50 ? 1 + depth(parent, seen + 1) : 0;
  };
  const folders = [...manifest.folders].sort((a, b) => depth(a) - depth(b));

  const steps = folders.length + manifest.notes.length + manifest.files.length + manifest.drawings.length;
  let done = 0;
  const tick = (label: string) => onProgress(`${label} ${++done} of ${steps}`, done / Math.max(1, steps));
  const result: RestoreResult = { notes: 0, files: 0, drawings: 0, keptDrawings: 0, failed: [] };

  /**
   * Each item on its own: one that fails is listed and the rest carry on, unless nothing more would get
   * through (stopsRestore), when what's done so far is said and the restore stops. Restoring the same
   * backup again then finishes it: notes are replaced as before (unchanged ones add no history), files
   * already there are skipped, and drawings restored are by then newer than the backup's.
   */
  const stopped = async (err: unknown) => {
    await loadAll(true).catch(() => undefined);
    const soFar = `${result.notes} notes, ${result.files} files and ${result.drawings} drawings`;
    return new Error(`The restore stopped after ${soFar}: ${errorMessage(err)} Restore the same backup again to finish it.`);
  };
  const each = async <T>(items: T[], label: string, name: (item: T) => string, put: (item: T) => Promise<void>) => {
    for (const item of items) {
      try {
        await put(item);
      } catch (err) {
        if (stopsRestore(err)) throw await stopped(err);
        result.failed.push(`${name(item)} (${errorMessage(err)})`);
      }
      tick(label);
    }
  };
  /** A list of what's there, or null when it can't be had (each item is then checked as it's sent). */
  const listed = async <T>(list: () => Promise<T[]>): Promise<T[] | null> => {
    try {
      return await list();
    } catch (err) {
      if (stopsRestore(err)) throw await stopped(err);
      return null;
    }
  };

  await each(folders, 'Restoring folders…', (f) => `Folder “${f.name}”`, async (f) => {
    await api.createFolder({ id: f.id, name: f.name, parent_id: f.parent_id, sort: f.sort });
  });

  // Notes before files and drawings: they matter most, and the files can use up the day's storage writes.
  await each(manifest.notes, 'Restoring notes…', (n) => `“${n.title || 'Untitled'}”`, async (n) => {
    await api.createNote({
      restore: true,
      id: n.id,
      title: n.title,
      content: n.content,
      folder_id: n.folder_id,
      tags: n.tags,
      pinned: n.pinned,
      created_at: n.created_at,
      updated_at: n.updated_at,
      deleted_at: n.deleted_at,
    });
    result.notes++;
  });

  // What's already there: files kept aren't uploaded again (the server would keep its own copy anyway,
  // but the bytes needn't travel), and drawings are compared with the backup's revision. Without the
  // lists, each file is sent (the server skips an id it has) and each drawing saved only as a new one.
  const haveFiles = await listed(async () => (await api.listFiles()).files);
  const haveDrawings = await listed(async () => (await api.listDrawings()).drawings);
  const hasFile = new Set((haveFiles ?? []).map((f) => f.id));
  const drawingNow = new Map((haveDrawings ?? []).map((d) => [d.id, d.rev]));

  // Found by id: how a name was made safe for the .zip changed over time (names in other scripts).
  const fileKeys = Object.keys(entries).filter((k) => k.startsWith('files/'));
  await each(manifest.files, 'Restoring files…', (f) => f.name, async (f) => {
    if (hasFile.has(f.id)) return;
    const exact = `files/${f.id}-${uploadSafeName(f.name)}`;
    const key = exact in entries ? exact : fileKeys.find((k) => k.startsWith(`files/${f.id}-`));
    const bytes = key ? entries[key] : undefined;
    if (!bytes) return;
    await api.uploadFile(new Blob([bytes as BlobPart], { type: f.mime }), f.name, { noteId: f.note_id, id: f.id });
    result.files++;
  });

  await each(manifest.drawings, 'Restoring drawings…', (d) => `Drawing ${d.id}`, async (d) => {
    const now = drawingNow.get(d.id);
    if (now !== undefined) {
      // As it was when backed up there's nothing to put back. Changed since, it stays: a drawing keeps
      // no history, so replacing it would lose the newer one for good.
      if (now !== d.rev) result.keptDrawings++;
      return;
    }
    const scene = entries[`drawings/${d.id}.excalidraw`];
    const svg = entries[`drawings/${d.id}.svg`];
    if (!scene || !svg) return;
    try {
      // Only as a new drawing (baseRev null): one saved meanwhile under this id is kept, not replaced.
      await api.saveDrawing(d.id, { scene: strFromU8(scene), svg: strFromU8(svg), noteId: d.note_id, text: '', createdAt: d.created_at, baseRev: null });
      result.drawings++;
    } catch (err) {
      if (!(err instanceof ApiError && err.code === 'drawing_conflict')) throw err;
      result.keptDrawings++;
    }
  });

  await loadAll(true);
  return result;
}

/**
 * A front-matter value as text: double-quoted ones as JSON strings (as frontMatter writes them, so
 * quotes and backslashes in a title come back as they were), single-quoted ones with YAML's '' for a
 * quote, anything else as written.
 */
function scalar(raw: string): string {
  const v = raw.trim();
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(v);
      if (typeof parsed === 'string') return parsed;
    } catch {
      /* not JSON: the text between the quotes */
    }
    return v.slice(1, -1);
  }
  if (v.length >= 2 && v.startsWith("'") && v.endsWith("'")) return v.slice(1, -1).replace(/''/g, "'");
  return v;
}

function parseFrontMatter(text: string): { title?: string; tags?: string[]; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!m) return { body: text };
  const out: { title?: string; tags?: string[]; body: string } = { body: text.slice(m[0].length) };
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^(\w+):\s*(.*)$/.exec(line);
    if (!kv) continue;
    const [, key, value] = kv;
    if (key === 'title') out.title = scalar(value);
    if (key === 'tags') {
      // A JSON list as frontMatter writes it, else a YAML-style [a, 'b', "c"].
      let list: unknown = null;
      try {
        list = JSON.parse(value.trim());
      } catch {
        list = null;
      }
      const items = Array.isArray(list)
        ? list.filter((t): t is string => typeof t === 'string')
        : value.trim().replace(/^\[|\]$/g, '').split(',').map(scalar);
      out.tags = items.map((t) => t.trim().replace(/^#+/, '')).filter(Boolean);
    }
  }
  return out;
}

/** Import plain .md / .txt files as new notes in the current folder. */
export async function importMarkdownFiles(files: File[], onProgress: Progress): Promise<number> {
  const filter = useApp.getState().filter;
  const folderId = filter.kind === 'folder' ? filter.id : null;
  let count = 0;
  for (const file of files) {
    // Windows line breaks (\r\n) as the editor keeps them (\n), so lists and tables read the same.
    const text = (await file.text()).replace(/\r\n?/g, '\n');
    const fm = parseFrontMatter(text);
    let body = fm.body;
    let title = fm.title;
    if (!title) {
      const h1 = /^#\s+(.+)\n?/.exec(body.trimStart());
      if (h1) {
        title = h1[1].trim();
        body = body.trimStart().slice(h1[0].length).replace(/^\n+/, '');
      } else {
        title = file.name.replace(/\.(md|markdown|txt)$/i, '');
      }
    }
    await api.createNote({ title, content: body, folder_id: folderId, tags: fm.tags ?? [] });
    count++;
    onProgress(`Imported ${count} of ${files.length}`, count / files.length);
  }
  await loadAll(true);
  return count;
}
