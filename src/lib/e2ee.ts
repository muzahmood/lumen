/**
 * End-to-end encryption of notes: what's encrypted, under which "context", and the jobs the server
 * can no longer do because it can't read notes (search, backlinks, which files are in use).
 *
 * Every ciphertext is bound to its note (or folder) and field through AES-GCM's additional data, so
 * the server can't swap a title between notes or pass one note's body off as another's. Snapshots in
 * a note's history are byte copies of the note's own ciphertext, so they share its contexts.
 */
import { cleanTags, cleanTitle, makeExcerpt, makeInfo, makeLinks } from '../../shared/noteText';
import { api, ApiError, currentCodec, libraryEncrypted, onAttachmentsEncrypted, type Codec, type NewNote, type NotePatch } from './api';
import { decryptBytes, decryptText, encryptBytes, encryptText, fromBase64Url, toBase64Url } from './crypto';
import { forgetLibrary, libraryDocs, onLibrarySynced, syncLibrary } from './library';
import { loadAll, useApp } from './store';
import type { ParsedQuery } from './searchQuery';
import type { Backlink, Folder, Note, NoteInfo, NoteLinks, NoteMeta, Sealed, SearchHit, Version, VersionInfo } from './types';
import { newId } from './utils';

const ctx = {
  content: (id: string) => `lumen/1/note/${id}/content`,
  title: (id: string) => `lumen/1/note/${id}/title`,
  tags: (id: string) => `lumen/1/note/${id}/tags`,
  preview: (id: string) => `lumen/1/note/${id}/preview`,
  folder: (id: string) => `lumen/1/folder/${id}/name`,
  /** An upload's own key, name and type, wrapped by the master key; and its bytes, under its own key. */
  fileMeta: (id: string) => `lumen/1/file/${id}/meta`,
  fileBody: (id: string) => `lumen/1/file/${id}/body`,
  /** A drawing revision's own key, wrapped by the master key; and its parts, under that key. */
  drawingKey: (id: string) => `lumen/1/drawing/${id}/key`,
  drawingPart: (id: string, part: 'scene' | 'svg') => `lumen/1/drawing/${id}/${part}`,
  /** The settings that follow the person to every device (settingsSync.ts). */
  settings: 'lumen/1/settings',
};

/**
 * Uploads and drawings are encrypted under keys of their own (AES-256-GCM, random per file and per
 * drawing revision), each stored wrapped by the master key. Replacing the master key then re-wraps
 * these small keys instead of downloading and uploading every file again.
 */
async function newDataKey(): Promise<{ key: CryptoKey; raw: string }> {
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
  return { key, raw: toBase64Url(new Uint8Array(await crypto.subtle.exportKey('raw', key))) };
}

function importDataKey(raw: string): Promise<CryptoKey> {
  const bytes = fromBase64Url(raw);
  if (bytes.length !== 32) throw new Error('Bad key');
  return crypto.subtle.importKey('raw', bytes as BufferSource, { name: 'AES-GCM' }, false, ['decrypt']);
}

const UNREADABLE_FILE = 'This file can’t be decrypted. It was encrypted with a different key, or changed outside Lumen.';

/** The server stores at most this much ciphertext for a note (D1 rows are capped at 2 MB). */
const MAX_CIPHER = 1_800_000;
const TOO_LARGE = 'This note is too large to encrypt (the limit is about 1.3 MB of text). Split it into smaller notes.';
const UNREADABLE_TITLE = 'Can’t decrypt this note';

/*
 * Once this device knows the whole library is encrypted (libraryEncrypted in api.ts), anything the
 * server sends unencrypted is treated like text that fails to decrypt: listed, so it can be deleted,
 * but with nothing of it shown and nothing of it opened, restored or encrypted as the person's own.
 */
const REFUSED_TITLE = 'Unencrypted note';
const REFUSED_NOTE =
  'This note isn’t encrypted, so Lumen won’t open it. Once your notes are encrypted Lumen never saves one unencrypted, so this one was put on the server some other way. You can move it to the trash from the note list.';
const REFUSED_VERSION =
  'This version isn’t encrypted, so Lumen won’t open it. Once your notes are encrypted Lumen never saves one unencrypted, so this one was put on the server some other way.';

/** Ciphertext length for a text of `bytes` UTF-8 bytes: "e1:" + base64url(12-byte IV + text + 16-byte tag). */
export function cipherLength(bytes: number): number {
  return 3 + Math.ceil(((28 + bytes) * 4) / 3);
}

const utf8 = new TextEncoder();

/**
 * The preview stored with an encrypted note: what the server would have worked out from plaintext,
 * plus the notes it links to (`l`), so backlinks come from the note list instead of every note's text.
 * `v` is how it was worked out: previews made by an earlier version are made again in the background
 * (upgradePreviews). 2: tasks counted as the Tasks view counts them, links inside code left out. 3: inline
 * formulas in the excerpt as readable text. 4: code spans end with their paragraph (links after a lone
 * backtick were missed). 5: tasks in Windows line endings and code blocks inside quotes, pictures
 * counted (has:image), excerpts without table pipes, single-star emphasis or escapes. 6: an empty
 * tick box isn't a task.
 */
const PREVIEW_VERSION = 6;

function previewOf(content: string): string {
  return JSON.stringify({ v: PREVIEW_VERSION, e: makeExcerpt(content), i: JSON.parse(makeInfo(content)) as NoteInfo, l: makeLinks(content) });
}

const NO_LINKS: NoteLinks = Object.freeze({ n: [], w: [] }) as NoteLinks;

function linksOf(value: unknown): NoteLinks | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const { n, w } = value as { n?: unknown; w?: unknown };
  if (!Array.isArray(n) || !Array.isArray(w)) return undefined;
  return { n: n.filter((x): x is string => typeof x === 'string'), w: w.filter((x): x is string => typeof x === 'string') };
}

/** Encrypts a note's preview with the unlocked key (set while a codec is in use). */
let sealPreview: ((id: string, content: string) => Promise<string>) | null = null;

/** The keys in use while unlocked: the current one, and earlier ones (newest first) after a replacement. */
let currentKeys: { key: CryptoKey; older: CryptoKey[] } | null = null;

/** Decrypts with the current key, or else an earlier one: text not yet re-encrypted after a key replacement. */
async function decryptAny(keys: { key: CryptoKey; older: CryptoKey[] }, cipher: string, context: string): Promise<string> {
  try {
    return await decryptText(keys.key, cipher, context);
  } catch (err) {
    for (const k of keys.older) {
      try {
        return await decryptText(k, cipher, context);
      } catch {
        /* not this one */
      }
    }
    throw err;
  }
}

export function createCodec(key: CryptoKey, older: CryptoKey[] = []): Codec {
  const keys = { key, older };
  // Small fields (titles, tags, previews, folder names) are decrypted on every refresh of the note
  // list, so each one's plaintext is remembered. Keyed by context as well as ciphertext, so a
  // ciphertext copied onto another note or field still has to pass decryption there (and fails).
  const memo = new Map<string, string>();
  const memoKey = (cipher: string, context: string) => `${context}|${cipher}`;

  async function sealSmall(text: string, context: string): Promise<string> {
    const cipher = await encryptText(key, text, context);
    memo.set(memoKey(cipher, context), text);
    return cipher;
  }

  async function openSmall(cipher: string | undefined, context: string): Promise<string | null> {
    if (!cipher) return null;
    const known = memo.get(memoKey(cipher, context));
    if (known !== undefined) return known;
    try {
      const text = await decryptAny(keys, cipher, context);
      // Three fields a note: room for about 20,000 notes. Past that the oldest quarter goes, rather
      // than everything, so a large library isn't decrypted from scratch on every refresh.
      if (memo.size > 60_000) {
        let drop = 15_000;
        for (const k of memo.keys()) {
          memo.delete(k);
          if (--drop === 0) break;
        }
      }
      memo.set(memoKey(cipher, context), text);
      return text;
    } catch {
      return null;
    }
  }

  async function sealBody(id: string, content: string): Promise<string> {
    const cipher = await encryptText(key, content, ctx.content(id));
    if (cipher.length > MAX_CIPHER) throw new ApiError(413, 'too_large', TOO_LARGE);
    return cipher;
  }

  function parse<T>(text: string | null, fallback: T): T {
    if (text === null) return fallback;
    try {
      return JSON.parse(text) as T;
    } catch {
      return fallback;
    }
  }

  async function openMeta(meta: NoteMeta): Promise<NoteMeta> {
    if (!meta.enc) {
      if (!libraryEncrypted()) return meta;
      const { sealed: _s, ...rest } = meta;
      return { ...rest, title: REFUSED_TITLE, tags: [], excerpt: '', info: {}, links: NO_LINKS };
    }
    const s: Sealed = meta.sealed ?? {};
    const [title, tags, preview] = await Promise.all([
      openSmall(s.t, ctx.title(meta.id)),
      openSmall(s.g, ctx.tags(meta.id)),
      openSmall(s.p, ctx.preview(meta.id)),
    ]);
    const p = parse<{ v?: unknown; e?: unknown; i?: unknown; l?: unknown } | null>(preview, null);
    const tagList = parse<unknown>(tags, []);
    const { sealed: _s, ...rest } = meta;
    // A preview that can't be read counts as linking nowhere: such a note can't be read for links
    // either, and it mustn't send every backlinks lookup down the slow path. One that reads but
    // predates links leaves `links` unset, for the one-time upgrade.
    const links = p ? linksOf(p.l) : NO_LINKS;
    return {
      ...rest,
      title: title ?? UNREADABLE_TITLE,
      tags: Array.isArray(tagList) ? tagList.filter((t): t is string => typeof t === 'string') : [],
      excerpt: typeof p?.e === 'string' ? p.e : '',
      info: p?.i && typeof p.i === 'object' ? (p.i as NoteInfo) : {},
      ...(links ? { links } : {}),
      // An unreadable preview has nothing to remake it from, so it doesn't count as out of date.
      pv: p ? (typeof p.v === 'number' ? p.v : 1) : PREVIEW_VERSION,
      // Shown as no tags, but an edit mustn't save that over tags that are there.
      ...(s.g && tags === null ? { tagsUnreadable: true } : {}),
    };
  }

  async function openNote(note: Note): Promise<Note> {
    if (!note.enc) {
      if (libraryEncrypted()) throw new ApiError(422, 'unencrypted', REFUSED_NOTE);
      return note;
    }
    const [meta, content] = await Promise.all([
      openMeta(note),
      decryptAny(keys, note.content, ctx.content(note.id)).catch(() => {
        throw new ApiError(
          422,
          'undecryptable',
          'This note can’t be decrypted. It was encrypted with a different key, or changed outside Lumen.',
        );
      }),
    ]);
    return { ...meta, content };
  }

  const codec: Codec = {
    openMeta,
    openNote,

    async openFolder(folder: Folder): Promise<Folder> {
      const { sealed: _s, ...rest } = folder;
      if (!folder.enc) return libraryEncrypted() ? { ...rest, name: 'Unencrypted folder' } : folder;
      const name = await openSmall(folder.sealed, ctx.folder(folder.id));
      return { ...rest, name: name ?? 'Locked folder' };
    },

    async openVersionInfo(noteId: string, info: VersionInfo): Promise<VersionInfo> {
      const { sealed: _s, ...rest } = info;
      if (!info.enc) return libraryEncrypted() ? { ...rest, title: 'Unencrypted version' } : info;
      const title = await openSmall(info.sealed?.t, ctx.title(noteId));
      // `size` is the ciphertext's length; show roughly the text's.
      return { ...rest, title: title ?? '', size: Math.max(0, Math.round(((info.size - 3) * 3) / 4) - 28) };
    },

    async openVersion(version: Version, noteId: string): Promise<Version> {
      if (!version.enc) {
        if (libraryEncrypted()) throw new ApiError(422, 'unencrypted', REFUSED_VERSION);
        return version;
      }
      // Decrypted as a version of the note it was asked for, never of whichever note the server
      // names: another note's text would fail here rather than be restored into this one.
      const [title, content] = await Promise.all([
        openSmall(version.sealed?.t, ctx.title(noteId)),
        decryptAny(keys, version.content, ctx.content(noteId)).catch(() => {
          throw new ApiError(422, 'undecryptable', 'This version can’t be decrypted.');
        }),
      ]);
      const { sealed: _s, ...rest } = version;
      return { ...rest, note_id: noteId, title: title ?? '', content, ...(title === null ? { titleUnreadable: true } : {}) };
    },

    async sealNew(data: NewNote): Promise<Record<string, unknown>> {
      // Ciphertext is bound to the note's id, so the id is chosen here rather than by the server.
      const id = data.id ?? newId();
      const content = data.content ?? '';
      const [body, t, g, p] = await Promise.all([
        sealBody(id, content),
        sealSmall(cleanTitle(data.title), ctx.title(id)),
        sealSmall(JSON.stringify(cleanTags(data.tags ?? [])), ctx.tags(id)),
        sealSmall(previewOf(content), ctx.preview(id)),
      ]);
      return {
        id,
        folder_id: data.folder_id ?? null,
        pinned: data.pinned ?? false,
        restore: data.restore,
        created_at: data.created_at,
        updated_at: data.updated_at,
        deleted_at: data.deleted_at,
        enc: true,
        content: body,
        sealed: { t, g, p },
      };
    },

    async sealPatch(id: string, patch: NotePatch): Promise<Record<string, unknown>> {
      const { title, content, tags, ...rest } = patch;
      if (title === undefined && content === undefined && tags === undefined) return rest;
      const sealed: Sealed = {};
      const out: Record<string, unknown> = { ...rest, enc: true, sealed };
      await Promise.all([
        title !== undefined && sealSmall(cleanTitle(title), ctx.title(id)).then((c) => (sealed.t = c)),
        tags !== undefined && sealSmall(JSON.stringify(cleanTags(tags)), ctx.tags(id)).then((c) => (sealed.g = c)),
        content !== undefined && sealBody(id, content).then((c) => (out.content = c)),
        content !== undefined && sealSmall(previewOf(content), ctx.preview(id)).then((c) => (sealed.p = c)),
      ]);
      return out;
    },

    sealSettings: (json: string) => sealSmall(json, ctx.settings),
    openSettings: (cipher: string) => openSmall(cipher, ctx.settings),

    async sealFolder(id: string, data: Partial<Folder>): Promise<Record<string, unknown>> {
      const { name, enc: _e, sealed: _s, ...rest } = data;
      const creating = !id;
      const folderId = id || newId();
      if (name === undefined) return creating ? { ...rest, id: folderId } : rest;
      const clean = cleanTitle(name);
      if (!clean) throw new ApiError(400, 'bad_name', 'Folder name is required.');
      return { ...rest, id: folderId, enc: true, sealed: await sealSmall(clean, ctx.folder(folderId)) };
    },

    search: (query, limit, signal, keep) => searchNotes(query, limit, signal, keep),
    backlinks: (id) => findBacklinks(id),
    referencedFiles: () => referencedFiles(),

    async sealFile(id, bytes, meta) {
      const dk = await newDataKey();
      const [body, sealed] = await Promise.all([
        encryptBytes(dk.key, bytes, ctx.fileBody(id)),
        sealSmall(JSON.stringify({ k: dk.raw, n: meta.name, t: meta.mime }), ctx.fileMeta(id)),
      ]);
      return { body, sealed };
    },

    async openFileMeta(id, sealed) {
      const meta = await openFileKey(id, sealed);
      return meta ? { name: meta.name, mime: meta.mime } : null;
    },

    async openFile(id, sealed, body) {
      const meta = await openFileKey(id, sealed);
      if (!meta) throw new ApiError(422, 'undecryptable', UNREADABLE_FILE);
      try {
        const bytes = await decryptBytes(await importDataKey(meta.k), body, ctx.fileBody(id));
        return { bytes, name: meta.name, mime: meta.mime };
      } catch {
        throw new ApiError(422, 'undecryptable', UNREADABLE_FILE);
      }
    },

    async sealDrawing(id, parts) {
      const dk = await newDataKey();
      const [scene, svg, sealed] = await Promise.all([
        encryptBytes(dk.key, utf8.encode(parts.scene), ctx.drawingPart(id, 'scene')),
        encryptBytes(dk.key, utf8.encode(parts.svg), ctx.drawingPart(id, 'svg')),
        encryptText(key, JSON.stringify({ k: dk.raw }), ctx.drawingKey(id)),
      ]);
      return { scene, svg, sealed };
    },

    async openDrawing(id, part, sealed, body) {
      try {
        const { k } = JSON.parse(await decryptAny(keys, sealed, ctx.drawingKey(id))) as { k: string };
        return new TextDecoder().decode(await decryptBytes(await importDataKey(k), body, ctx.drawingPart(id, part)));
      } catch {
        throw new ApiError(422, 'undecryptable', 'This drawing can’t be decrypted. It was encrypted with a different key, or changed outside Lumen.');
      }
    },
  };

  /** An upload's own key, name and type (memoised like the other small fields), or null. */
  async function openFileKey(id: string, sealed: string): Promise<{ k: string; name: string; mime: string } | null> {
    const text = await openSmall(sealed, ctx.fileMeta(id));
    const v = parse<{ k?: unknown; n?: unknown; t?: unknown } | null>(text, null);
    if (!v || typeof v.k !== 'string') return null;
    return {
      k: v.k,
      name: typeof v.n === 'string' && v.n ? v.n : 'file',
      mime: typeof v.t === 'string' && /^[\w.+-]+\/[\w.+-]+$/.test(v.t) ? v.t : 'application/octet-stream',
    };
  }
  currentKeys = keys;
  sealPreview = (id, content) => sealSmall(previewOf(content), ctx.preview(id));
  return codec;
}

/*
 * Every note's text, decrypted, for search and backlinks: the on-device copy in library.ts, which a
 * new key (another unlock) starts again from.
 */

const foldMemo = new Map<string, string>();

/** Lowercase and strip accents one UTF-16 unit at a time, so positions in the result match the original. */
export function fold(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 128) {
      out += code >= 65 && code <= 90 ? String.fromCharCode(code + 32) : text[i];
      continue;
    }
    const ch = text[i];
    let f = foldMemo.get(ch);
    if (f === undefined) {
      const base = code >= 0xd800 && code <= 0xdfff ? ch : ch.normalize('NFD')[0].toLowerCase();
      f = base.length === 1 ? base : ch;
      foldMemo.set(ch, f);
    }
    out += f;
  }
  return out;
}

const WORD = /[\p{L}\p{N}_]/u;

/** Positions where `term` starts a word in `hay` (both folded), up to `cap`. */
function wordStarts(hay: string, term: string, cap: number, from = 0, to = hay.length): number[] {
  const out: number[] = [];
  let i = hay.indexOf(term, from);
  while (i !== -1 && i < to && out.length < cap) {
    if (i === 0 || !WORD.test(hay[i - 1])) out.push(i);
    i = hay.indexOf(term, i + 1);
  }
  return out;
}

/** Positions where `phrase` stands as whole words in `hay`: "next quarter" but not "next quarterly". */
function wholeWords(hay: string, phrase: string, cap: number): number[] {
  const out: number[] = [];
  for (const i of wordStarts(hay, phrase, Infinity)) {
    const after = hay[i + phrase.length];
    if (after === undefined || !WORD.test(after)) out.push(i);
    if (out.length >= cap) break;
  }
  return out;
}

/** The words of a query, as the server's search reads them: each a prefix to match. */
function queryTerms(q: string): string[] {
  return q
    .replace(/[\u0000-\u001f]/g, ' ')
    .split(/\s+/)
    .map((t) => fold(t.replace(/^#/, '').replace(/"/g, '').trim()))
    .filter((t) => t.length > 0)
    .slice(0, 12);
}

/** A short passage around the first match, with matches marked \u0001…\u0002 like the server's snippets. */
function snippetOf(text: string, folded: string, terms: string[]): string {
  let pos = -1;
  for (const t of terms) {
    const [p] = wordStarts(folded, t, 1);
    if (p !== undefined && (pos === -1 || p < pos)) pos = p;
  }
  if (pos === -1) return makeExcerpt(text).slice(0, 160);
  let start = Math.max(0, pos - 50);
  if (start > 0) {
    const space = text.indexOf(' ', start);
    if (space !== -1 && space < pos) start = space + 1;
  }
  let end = Math.min(text.length, pos + 150);
  if (end < text.length) {
    const space = text.lastIndexOf(' ', end);
    if (space > pos) end = space;
  }
  const ranges: Array<[number, number]> = [];
  for (const t of terms) for (const p of wordStarts(folded, t, 20, start, end)) ranges.push([p, Math.min(p + t.length, end)]);
  ranges.sort((a, b) => a[0] - b[0]);
  let out = '';
  let at = start;
  for (const [a, b] of ranges) {
    if (a < at) continue;
    out += `${text.slice(at, a)}\u0001${text.slice(a, b)}\u0002`;
    at = b;
  }
  out += text.slice(at, end);
  // Line breaks kept (as the server's snippets keep them), so snippetToHtml can tell a list marker or
  // task box at a line's start from text; it makes the snippet one line.
  return `${start > 0 ? '…' : ''}${out.replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim()}${end < text.length ? '…' : ''}`;
}

/**
 * Searches the text on this device (see searchQuery.ts for what a query can ask): every word as the
 * start of a word, every phrase as written (across line breaks too), none of `without`, and only notes
 * `keep` passes (the query's filters). A query of filters alone lists their notes, newest first.
 */
async function searchNotes(query: ParsedQuery, limit: number, signal?: AbortSignal, keep: (m: NoteMeta) => boolean = () => true): Promise<SearchHit[]> {
  const terms = queryTerms(query.words.join(' '));
  const phrases = query.phrases.map((p) => fold(p.replace(/\s+/g, ' ').trim())).filter(Boolean);
  const without = query.without.map((w) => fold(w.replace(/\s+/g, ' ').trim())).filter(Boolean);
  const needsText = terms.length + phrases.length + without.length > 0;
  if (needsText) await syncLibrary();
  if (signal?.aborted) throw new DOMException('Search cancelled', 'AbortError');
  const docs = libraryDocs();
  const hits: Array<{ meta: NoteMeta; score: number; text: string; folded: string }> = [];
  for (const meta of Object.values(useApp.getState().notes)) {
    if (meta.deleted_at || !keep(meta)) continue;
    if (!needsText) {
      hits.push({ meta, score: 0, text: meta.excerpt, folded: '' });
      continue;
    }
    const doc = docs.get(meta.id);
    const text = doc?.content ?? meta.excerpt;
    const folded = doc ? (doc.folded ??= fold(doc.content)) : fold(text);
    const title = fold(meta.title);
    const tags = fold(meta.tags.join(' '));
    // Phrases and what to leave out are matched with runs of spaces and line breaks as one space, and
    // never across the title, tags and text (a \u0000 between them, which no query contains).
    const flat = phrases.length || without.length ? `${title}\u0000${tags}\u0000${folded}`.replace(/\s+/g, ' ') : '';
    if (without.some((w) => wordStarts(flat, w, 1).length)) continue;
    let score = 0;
    let all = true;
    for (const t of terms) {
      // Weighted like the server's ranking: title, then tags, then the body.
      const s = wordStarts(title, t, 5).length * 8 + wordStarts(tags, t, 5).length * 4 + wordStarts(folded, t, 10).length;
      if (!s) {
        all = false;
        break;
      }
      score += s;
    }
    for (const p of phrases) {
      if (!all) break;
      const s = wholeWords(flat, p, 10).length;
      if (!s) all = false;
      score += s * 2;
    }
    if (all) hits.push({ meta, score, text, folded });
  }
  hits.sort((a, b) => b.score - a.score || b.meta.updated_at - a.meta.updated_at);
  if (!needsText) {
    return hits.slice(0, limit).map(({ meta }) => ({ id: meta.id, title: meta.title, folder_id: meta.folder_id, updated_at: meta.updated_at, tags: meta.tags, snippet: meta.excerpt }));
  }
  terms.push(...phrases);
  return hits.slice(0, limit).map(({ meta, text, folded }) => ({
    id: meta.id,
    title: meta.title,
    folder_id: meta.folder_id,
    updated_at: meta.updated_at,
    tags: meta.tags,
    snippet: snippetOf(text, folded, terms),
  }));
}

/**
 * Notes linking to `id`, from the links each encrypted note keeps in its preview: no note has to be
 * downloaded. Only notes whose preview predates that (or plaintext notes partway through encrypting
 * the library) are read in full, and that reading is used to upgrade their previews, once.
 */
async function findBacklinks(id: string): Promise<Backlink[]> {
  let metas = useApp.getState().notes;
  const others = () => Object.values(metas).filter((m) => !m.deleted_at && m.id !== id);
  if (others().some((m) => !m.links)) {
    await syncLibrary();
    void upgradePreviews();
    metas = useApp.getState().notes;
  }
  const docs = libraryDocs();
  const title = metas[id]?.title.trim() ?? '';
  const key = title.toLowerCase();
  const escaped = title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const wiki = title ? new RegExp(`\\[\\[\\s*${escaped}\\s*(\\||#|\\]\\])`, 'i') : null;
  const out: Backlink[] = [];
  for (const m of others()) {
    let linked: boolean;
    if (m.links) {
      linked = m.links.n.includes(id) || (!!key && m.links.w.includes(key));
    } else {
      const content = docs.get(m.id)?.content;
      linked = !!content && (content.includes(`/note/${id}`) || !!wiki?.test(content));
    }
    if (!linked) continue;
    out.push({ id: m.id, title: m.title, excerpt: m.excerpt, updated_at: m.updated_at });
    if (out.length >= 50) break;
  }
  return out;
}

let upgrading: Promise<void> | null = null;

/** An encrypted note whose preview was made by an earlier version (or predates links): remade from its text. */
const staleNote = (m: NoteMeta) => m.enc && !m.deleted_at && (!m.links || (m.pv ?? 1) < PREVIEW_VERSION);

/**
 * Remakes encrypted previews made by an earlier version of Lumen: each such note's preview is encrypted
 * again from its text (from the copy on this device) and stored, only while the note is still at the
 * version that text came from. Nothing else about the note changes (not its text, version or dates).
 * Notes edited meanwhile get the new preview with their next save anyway.
 */
function upgradePreviews(): Promise<void> {
  upgrading ??= (async () => {
    const seal = sealPreview;
    if (!seal) return;
    const pending: Array<{ id: string; version: number; p: string; meta: Pick<NoteMeta, 'excerpt' | 'info' | 'links' | 'pv'> }> = [];
    const docs = libraryDocs();
    for (const m of Object.values(useApp.getState().notes)) {
      const doc = docs.get(m.id);
      if (!staleNote(m) || !doc || doc.version !== m.version) continue;
      pending.push({
        id: m.id,
        version: m.version,
        p: await seal(m.id, doc.content),
        meta: { excerpt: makeExcerpt(doc.content), info: JSON.parse(makeInfo(doc.content)) as NoteInfo, links: makeLinks(doc.content), pv: PREVIEW_VERSION },
      });
    }
    for (let i = 0; i < pending.length; i += 50) {
      const batch = pending.slice(i, i + 50);
      const { updated } = await api.sealPreviews(batch.map(({ id, version, p }) => ({ id, version, p })));
      const done = new Set(updated);
      useApp.setState((s) => {
        const notes = { ...s.notes };
        for (const item of batch) if (done.has(item.id) && notes[item.id]) notes[item.id] = { ...notes[item.id], ...item.meta };
        return { notes };
      });
    }
  })()
    .catch(() => undefined)
    .finally(() => (upgrading = null));
  return upgrading;
}

// Once the copy on this device is up to date, out-of-date previews are remade from it.
/** Remakes out-of-date previews from the copy on this device, if any are out of date. */
export function refreshStalePreviews(): Promise<void> {
  return Object.values(useApp.getState().notes).some(staleNote) ? upgradePreviews() : Promise.resolve();
}

onLibrarySynced(() => void refreshStalePreviews());

/** Ids of the uploads and drawings any note links to, trashed notes and unsent edits included. */
async function referencedFiles(): Promise<string[]> {
  // Against the current note list: a file missed here would be offered for deletion.
  await loadAll(true);
  forgetLibrary();
  await syncLibrary();
  const docs = libraryDocs();
  const metas = Object.values(useApp.getState().notes);
  // A note that can't be decrypted (or fetched) may still link to files: without its text, they'd look unused.
  const unread = metas.filter((m) => docs.get(m.id)?.version !== m.version).length;
  if (unread) {
    throw new Error(
      `${unread === 1 ? 'A note' : `${unread} notes`} couldn’t be read, so Lumen can’t tell which files ${
        unread === 1 ? 'it uses' : 'they use'
      }. Nothing was removed.`,
    );
  }
  const texts = [...docs.values()].map((d) => d.content);
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k?.startsWith('kb.draft.')) texts.push(localStorage.getItem(k) ?? '');
    }
  } catch {
    /* ignore */
  }
  const ids = new Set<string>();
  const re = /\/api\/(?:files|drawings)\/([A-Za-z0-9_-]{6,64})/g;
  for (const t of texts) for (const m of t.matchAll(re)) ids.add(m[1]);
  return [...ids];
}

/* --------------------------------------------- encrypting the library --- */

/** Notes too large to encrypt (they'd stop the library being converted), by title. */
export async function notesTooLarge(): Promise<string[]> {
  const out: string[] = [];
  let after = 0;
  for (;;) {
    const page = await api.exportNotes(after, { sealed: true });
    for (const n of page.notes) {
      if (!n.enc && cipherLength(utf8.encode(n.content).length) > MAX_CIPHER) out.push(n.title || 'Untitled');
    }
    if (page.next === null) return out;
    after = page.next;
  }
}

export type Progress = (done: number, total: number) => void;

/** Requests stay well under the Worker's body limit, and D1's per-batch work stays small. */
const BATCH_BYTES = 3_000_000;
const BATCH_ITEMS = 25;

/**
 * Encrypts everything still stored in plaintext: folder names, notes and their history. Safe to run
 * again after an interruption, or on two devices at once: each step only changes rows that are still
 * plaintext, and a note edited meanwhile is skipped and picked up on the next pass. Finishes by
 * emptying the server's search index, which held every word.
 */
export async function encryptLibrary(key: CryptoKey, onProgress: Progress): Promise<void> {
  // Once the library was seen fully encrypted, plaintext on the server didn't come from Lumen: encrypting
  // it would take it in as the person's own.
  if (libraryEncrypted()) throw new Error('Your notes are already encrypted.');
  for (let pass = 0; pass < 4; pass++) {
    const boot = await api.bootstrap();
    const pending = boot.encryption?.pending;
    if (!boot.encryption?.on || !pending) throw new Error('Encryption isn’t on.');
    const total = pending.notes + pending.versions + pending.folders;
    if (total === 0) {
      await api.finishEncryption();
      await dropCachedResponses();
      onProgress(1, 1);
      return;
    }
    let done = 0;
    const tick = (n: number) => onProgress((done += n), total);
    tick(0);

    const plainFolders = boot.folders.filter((f) => !f.enc);
    for (let i = 0; i < plainFolders.length; i += BATCH_ITEMS) {
      const batch = plainFolders.slice(i, i + BATCH_ITEMS);
      const sealed = await Promise.all(
        batch.map(async (f) => ({ id: f.id, sealed: await encryptText(key, cleanTitle(f.name) || 'Folder', ctx.folder(f.id)) })),
      );
      await api.sealFolders(sealed);
      tick(batch.length);
    }

    let after = 0;
    for (;;) {
      const page = await api.exportNotes(after, { sealed: true });
      let batch: Array<{ id: string; version: number; content: string; sealed: Sealed }> = [];
      let bytes = 0;
      const send = async () => {
        if (!batch.length) return;
        await api.sealNotes(batch);
        tick(batch.length);
        batch = [];
        bytes = 0;
      };
      for (const n of page.notes) {
        if (n.enc) continue;
        const [content, t, g, p] = await Promise.all([
          encryptText(key, n.content, ctx.content(n.id)),
          encryptText(key, n.title, ctx.title(n.id)),
          encryptText(key, JSON.stringify(n.tags), ctx.tags(n.id)),
          encryptText(key, previewOf(n.content), ctx.preview(n.id)),
        ]);
        if (content.length > MAX_CIPHER) throw new Error(`“${n.title || 'Untitled'}” is too large to encrypt. Split it into smaller notes.`);
        if (bytes + content.length > BATCH_BYTES || batch.length >= BATCH_ITEMS) await send();
        batch.push({ id: n.id, version: n.version, content, sealed: { t, g, p } });
        bytes += content.length;
      }
      await send();
      if (page.next === null) break;
      after = page.next;
    }

    let vAfter = 0;
    for (;;) {
      const page = await api.plainVersions(vAfter);
      let batch: Array<{ id: number; content: string; sealed: Sealed } | { id: number; drop: true }> = [];
      let bytes = 0;
      const send = async () => {
        if (!batch.length) return;
        await api.sealVersions(batch);
        tick(batch.length);
        batch = [];
        bytes = 0;
      };
      for (const v of page.versions) {
        const content = await encryptText(key, v.content, ctx.content(v.note_id));
        const item: { id: number; content: string; sealed: Sealed } | { id: number; drop: true } =
          content.length > MAX_CIPHER
            ? { id: v.id, drop: true as const }
            : { id: v.id, content, sealed: { t: await encryptText(key, v.title, ctx.title(v.note_id)) } };
        const size = 'drop' in item ? 0 : item.content.length;
        if (bytes + size > BATCH_BYTES || batch.length >= BATCH_ITEMS) await send();
        batch.push(item);
        bytes += size;
      }
      await send();
      if (page.next === null) break;
      vAfter = page.next;
    }
  }
  throw new Error('Some notes kept changing while they were being encrypted. Try again in a moment.');
}

/* ---------------------------------------- encrypting files and drawings --- */

const isMissing = (err: unknown) => err instanceof ApiError && err.status === 404;

/**
 * Encrypts every upload and drawing saved before they were encrypted: each is downloaded, encrypted
 * here under a key of its own and put back, the plaintext deleted. Safe to stop and run again, or on
 * two devices at once (the server only takes the first encrypted copy of each). A file or drawing
 * whose stored bytes were already gone can't be encrypted: it's removed from the list (it couldn't
 * be opened anyway), and counted in `missing`.
 */
export async function encryptAttachments(onProgress: Progress): Promise<{ missing: number }> {
  const codec = currentCodec();
  if (!codec) throw new Error('Locked');
  let missing = 0;
  for (let pass = 0; pass < 4; pass++) {
    const boot = await api.bootstrapSealed();
    const left = boot.encryption?.attachments;
    if (!boot.encryption?.on || !left) throw new Error('Encryption isn’t on.');
    const total = left.files + left.drawings;
    if (total === 0) {
      onProgress(1, 1);
      return { missing };
    }
    let done = 0;
    const tick = (n: number) => onProgress((done += n), total);
    tick(0);

    const { files } = await api.listFiles();
    for (const f of files.filter((x) => !x.enc)) {
      let bytes: Uint8Array;
      try {
        bytes = new Uint8Array(await (await api.fetchRaw(`/api/files/${f.id}?fresh=${Date.now()}`)).arrayBuffer());
      } catch (err) {
        if (!isMissing(err)) throw err;
        // Gone, or encrypted by another device doing this at the same moment (its plaintext copy is
        // deleted as it's sealed): only a file still unencrypted, with its bytes missing, is removed.
        const now = (await api.listFiles()).files.find((x) => x.id === f.id);
        if (now && !now.enc && (await api.deleteFile(f.id).then(() => true, () => false))) missing++;
        tick(1);
        continue;
      }
      const { body, sealed } = await codec.sealFile(f.id, bytes, { name: f.name, mime: f.mime });
      await api.sealExistingFile(f.id, body, sealed);
      tick(1);
    }

    const { drawings } = await api.listDrawings();
    for (const d of drawings.filter((x) => !x.enc)) {
      let scene: string;
      let svg: string;
      try {
        [scene, svg] = await Promise.all([api.drawingPart(d.id, 'scene', { fresh: true }), api.drawingPart(d.id, 'svg', { fresh: true })]);
      } catch (err) {
        if (!isMissing(err)) throw err;
        // Only a drawing still unencrypted at the revision read is removed: another device may have
        // just saved it encrypted (dropping the revision this one was reading).
        const now = (await api.listDrawings()).drawings.find((x) => x.id === d.id);
        if (now && !now.enc && now.rev === d.rev && (await api.deleteDrawing(d.id).then(() => true, () => false))) missing++;
        tick(1);
        continue;
      }
      try {
        // On top of the revision just read: one saved meanwhile is picked up on the next pass.
        await api.saveDrawing(d.id, { scene, svg, noteId: d.note_id, text: '', createdAt: d.created_at, baseRev: d.rev });
      } catch (err) {
        if (!(err instanceof ApiError && err.code === 'drawing_conflict')) throw err;
      }
      tick(1);
    }
  }
  throw new Error('Some files or drawings kept changing while they were being encrypted. Try again in a moment.');
}

/**
 * Copies of files and drawings kept for offline use (by the service worker, and in the browser's HTTP
 * cache) may be from before they were encrypted: once this device learns everything is encrypted,
 * they go, and come back encrypted as they're opened.
 */
async function dropPlainFileCopies() {
  try {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k.endsWith('-files') || k.endsWith('-data')).map((k) => caches.delete(k)));
  } catch {
    /* no Cache Storage */
  }
  await api.clearHttpCache().catch(() => undefined);
}

onAttachmentsEncrypted(() => void dropPlainFileCopies());

/* --------------------------------------------- after a key replacement --- */

/**
 * Encrypts again, with the current key, everything still encrypted with an earlier one: folder names,
 * notes (body, title, tags, preview) and history snapshots. Like the first-time pass it's safe to stop
 * and run again, or to run on two devices: each write only changes what's still on an earlier key,
 * and a note edited meanwhile is skipped and comes up again. A field no key opens (damaged, or from an
 * encryption setup that was reset) keeps its ciphertext exactly as it is, and the item counts as done:
 * otherwise the library could never finish. Returns how many items had such a field.
 */
export async function rekeyLibrary(onProgress: Progress): Promise<{ unreadable: number }> {
  const keys = currentKeys;
  if (!keys) throw new Error('Locked');
  const unreadable = new Set<string>();
  // One item's fields: re-encrypted, or left as they are when no key opens them.
  const item = (name: string) => {
    let bad = false;
    return {
      again: async (cipher: string | undefined, context: string, fallback: () => string): Promise<string> => {
        if (!cipher) return encryptText(keys.key, fallback(), context);
        try {
          return await encryptText(keys.key, await decryptAny(keys, cipher, context), context);
        } catch {
          bad = true;
          return cipher;
        }
      },
      open: async (cipher: string, context: string): Promise<string | null> => {
        try {
          return await decryptAny(keys, cipher, context);
        } catch {
          bad = true;
          return null;
        }
      },
      done: () => {
        if (bad) unreadable.add(name);
      },
    };
  };

  for (let pass = 0; pass < 4; pass++) {
    const boot = await api.bootstrapSealed();
    const left = boot.encryption?.rekey;
    if (!left) throw new Error('Encryption isn’t on.');
    const total = left.notes + left.versions + left.folders + (left.files ?? 0) + (left.drawings ?? 0);
    if (total === 0) {
      onProgress(1, 1);
      return { unreadable: unreadable.size };
    }
    let done = 0;
    const tick = (n: number) => onProgress((done += n), total);
    tick(0);

    const gen = boot.encryption?.gen ?? 0;
    const folders: Array<{ id: string; sealed: string }> = [];
    for (const f of boot.folders as Array<Folder & { kgen?: number }>) {
      if (!f.enc || !f.sealed || (f.kgen ?? 0) >= gen) continue;
      const one = item(`f:${f.id}`);
      folders.push({ id: f.id, sealed: await one.again(f.sealed, ctx.folder(f.id), () => '') });
      one.done();
    }
    for (let i = 0; i < folders.length; i += BATCH_ITEMS) {
      const batch = folders.slice(i, i + BATCH_ITEMS);
      await api.saveRekeyedFolders(batch);
      tick(batch.length);
    }

    let after = 0;
    for (;;) {
      const page = await api.rekeyNotes(after);
      const batch: Array<{ id: string; version: number; updated_at?: number; content: string; sealed: Sealed }> = [];
      for (const n of page.notes) {
        const one = item(`n:${n.id}`);
        // The body first: a missing preview is made from it.
        const text = await one.open(n.content, ctx.content(n.id));
        const content = text === null ? n.content : await encryptText(keys.key, text, ctx.content(n.id));
        const [t, g, p] = await Promise.all([
          one.again(n.sealed.t, ctx.title(n.id), () => ''),
          one.again(n.sealed.g, ctx.tags(n.id), () => '[]'),
          one.again(n.sealed.p, ctx.preview(n.id), () => previewOf(text ?? '')),
        ]);
        one.done();
        // With the updated_at read: a title or tag changed meanwhile (here or elsewhere) isn't written
        // back over with the old one; the note comes up again on the next pass.
        batch.push({ id: n.id, version: n.version, updated_at: n.updated_at, content, sealed: { t, g, p } });
      }
      for (let i = 0; i < batch.length; i += BATCH_ITEMS) {
        const part = batch.slice(i, i + BATCH_ITEMS);
        await api.saveRekeyedNotes(part);
        tick(part.length);
      }
      if (page.next === null) break;
      after = page.next;
    }

    let vAfter = 0;
    for (;;) {
      const page = await api.rekeyVersions(vAfter);
      const batch: Array<{ id: number; content: string; sealed: Sealed }> = [];
      for (const v of page.versions) {
        const one = item(`v:${v.id}`);
        const [content, t] = await Promise.all([
          one.again(v.content, ctx.content(v.note_id), () => ''),
          one.again(v.sealed.t, ctx.title(v.note_id), () => ''),
        ]);
        one.done();
        batch.push({ id: v.id, content, sealed: { t } });
      }
      for (let i = 0; i < batch.length; i += BATCH_ITEMS) {
        const part = batch.slice(i, i + BATCH_ITEMS);
        await api.saveRekeyedVersions(part);
        tick(part.length);
      }
      if (page.next === null) break;
      vAfter = page.next;
    }

    // Uploads and drawings: only their own keys are wrapped by the master key, so only those change.
    for (const kind of ['files', 'drawings'] as const) {
      let aAfter = '';
      for (;;) {
        const page = await api.rekeyAttachments(kind, aAfter);
        const batch: Array<{ id: string; sealed: string }> = [];
        for (const a of page.items) {
          const one = item(`${kind}:${a.id}`);
          const context = kind === 'files' ? ctx.fileMeta(a.id) : ctx.drawingKey(a.id);
          batch.push({ id: a.id, sealed: await one.again(a.sealed, context, () => '') });
          one.done();
        }
        for (let i = 0; i < batch.length; i += 100) {
          const part = batch.slice(i, i + 100);
          await api.saveRekeyedAttachments(kind, part);
          tick(part.length);
        }
        if (page.next === null) break;
        aAfter = page.next;
      }
    }
  }
  // Only notes edited while each pass ran are left (they come up again at their new version).
  throw new Error('Some notes kept changing while they were being encrypted again. Try again in a moment.');
}

/**
 * The service worker keeps copies of the note list and opened notes for offline reading. Copies
 * from before encryption hold plaintext, so they go; they're refilled (encrypted) as notes open.
 */
export async function dropCachedResponses(): Promise<void> {
  try {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k.endsWith('-data')).map((k) => caches.delete(k)));
  } catch {
    /* no Cache Storage: nothing kept */
  }
}
