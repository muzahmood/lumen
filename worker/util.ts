const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';

export function newId(length = 14): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  let out = '';
  for (const b of bytes) out += ALPHABET[b % 62];
  return out;
}

export const ID_RE = /^[A-Za-z0-9_-]{6,64}$/;

export function isId(value: unknown): value is string {
  return typeof value === 'string' && ID_RE.test(value);
}

export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message?: string,
  ) {
    super(message ?? code);
  }
}

export function assert(condition: unknown, status: number, code: string, message?: string): asserts condition {
  if (!condition) throw new HttpError(status, code, message);
}

/** D1 rows are limited to ~2 MB; keep note bodies well below that. */
export const MAX_CONTENT_BYTES = 1_800_000;

/** Whether `s` takes at most `limit` bytes as UTF-8. */
export function fitsBytes(s: string, limit: number): boolean {
  // Fast paths: every UTF-16 unit is 1 to 3 bytes of UTF-8.
  if (s.length * 3 <= limit) return true;
  if (s.length > limit) return false;
  return new TextEncoder().encode(s).length <= limit;
}

export { cleanTags, cleanTitle, makeExcerpt, makeInfo } from '../shared/noteText';

export function safeFileName(name: string): string {
  const cleaned = name
    .normalize('NFKD')
    .replace(/[^\w.\- ]+/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .slice(0, 120);
  return cleaned || 'file';
}

export interface NoteRow {
  seq: number;
  id: string;
  folder_id: string | null;
  title: string;
  content: string;
  excerpt: string;
  info: string;
  tags: string;
  pinned: number;
  version: number;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
  /** 1 when end-to-end encrypted: the text lives only in `content` (ciphertext) and `sealed`. */
  enc: number;
  /** JSON object of ciphertexts: t (title), g (tags), p (preview: excerpt and info). */
  sealed: string;
  /** The key generation its ciphertext was written under (see the keyring). */
  kgen?: number;
  /** JSON array of the ids of the last saves that changed its text (see migration 6). */
  saves?: string;
}

export type NoteMeta = Omit<NoteRow, 'seq' | 'content' | 'tags' | 'pinned' | 'info' | 'enc' | 'sealed' | 'saves'> & {
  tags: string[];
  pinned: boolean;
  info: Record<string, unknown>;
  enc: boolean;
  sealed: Sealed;
};

function parseJson<T>(value: string | undefined, fallback: T): T {
  try {
    return value ? (JSON.parse(value) as T) : fallback;
  } catch {
    return fallback;
  }
}

export function toMeta(row: Omit<NoteRow, 'seq' | 'content'> & { content?: string }): NoteMeta {
  return {
    id: row.id,
    folder_id: row.folder_id,
    title: row.title,
    excerpt: row.excerpt,
    info: parseJson<Record<string, unknown>>(row.info, {}),
    tags: parseJson<string[]>(row.tags, []),
    pinned: !!row.pinned,
    version: row.version,
    created_at: row.created_at,
    updated_at: row.updated_at,
    deleted_at: row.deleted_at,
    enc: !!row.enc,
    sealed: parseJson<Sealed>(row.sealed, {}),
  };
}

export const META_COLUMNS =
  'id, folder_id, title, excerpt, info, tags, pinned, version, created_at, updated_at, deleted_at, enc, sealed';

/* ------------------------------------------------- end-to-end encryption --- */

/**
 * Ciphertext as the app writes it: "e1:" and base64url (a 12-byte IV, then AES-GCM output). The
 * Worker never decrypts anything; it only checks the shape, so plaintext can't be stored by mistake
 * in a place meant for ciphertext.
 */
const CIPHER_RE = /^e1:[A-Za-z0-9_-]{38,}$/;

export function isCipher(value: unknown, maxLength = 2_500_000): value is string {
  return typeof value === 'string' && value.length <= maxLength && CIPHER_RE.test(value);
}

/** The encrypted fields of a note: title, tags, and preview (excerpt and list summary). */
export interface Sealed {
  t?: string;
  g?: string;
  p?: string;
}

/** The sealed fields present in a request, each checked to be ciphertext; null if any isn't. */
export function cleanSealed(value: unknown, allowed: Array<keyof Sealed> = ['t', 'g', 'p']): Sealed | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const out: Sealed = {};
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    if (!allowed.includes(key as keyof Sealed) || !isCipher(v, 200_000)) return null;
    out[key as keyof Sealed] = v;
  }
  return out;
}

/** A stored `sealed` column (JSON of ciphertexts), tolerant of anything malformed. */
export function parseSealed(value: string | null | undefined): Sealed {
  try {
    const parsed = value ? (JSON.parse(value) as unknown) : {};
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Sealed) : {};
  } catch {
    return {};
  }
}

/**
 * True once the library has a keyring, or holds anything encrypted: from then on, note text and folder
 * names are only stored encrypted. Encrypted rows count too, so removing the keyring row can't turn
 * encryption off and let new notes be stored readable.
 */
export async function encryptionOn(db: D1Database): Promise<boolean> {
  const row = await db
    .prepare(
      'SELECT EXISTS (SELECT 1 FROM keyring) OR EXISTS (SELECT 1 FROM notes WHERE enc = 1) OR EXISTS (SELECT 1 FROM folders WHERE enc = 1) AS on_',
    )
    .first<{ on_: number }>();
  return !!row?.on_;
}

/**
 * Turn free text into a safe FTS5 query: every word becomes a quoted prefix term, "words in quotes"
 * a phrase, and a word or phrase after "-" something to leave out (once there's something to find).
 */
export function ftsQuery(input: string): string | null {
  const find: string[] = [];
  const leave: string[] = [];
  const token = /(-?)(?:"([^"]*)"?|(\S+))/g;
  const text = input.replace(/[\u0000-\u001f]/g, ' ');
  let m: RegExpExecArray | null;
  while ((m = token.exec(text)) && find.length + leave.length < 12) {
    const not = m[1] === '-';
    let term: string;
    if (m[2] !== undefined) {
      const phrase = m[2].replace(/\s+/g, ' ').trim();
      if (!phrase) continue;
      term = `"${phrase}"`;
    } else {
      const word = m[3].replace(/^#/, '').replace(/"/g, '').trim();
      // Punctuation on its own ("-", "*") finds nothing.
      if (!/[\p{L}\p{N}]/u.test(word)) continue;
      term = `"${word}"*`;
    }
    (not ? leave : find).push(term);
  }
  if (!find.length) return null;
  return [find.join(' '), ...leave.map((t) => `NOT ${t}`)].join(' ');
}

/**
 * The one range of bytes a Range header asks for ("bytes=0-1023", "bytes=500-", "bytes=-500"), within
 * `size`. Null to send the whole file: no header, or one asking for several ranges or not understood
 * (RFC 9110 says to ignore those). 'unsatisfiable' when it starts past the end.
 */
export function byteRange(header: string | undefined, size: number): { start: number; end: number } | 'unsatisfiable' | null {
  const m = header ? /^bytes=(\d*)-(\d*)$/.exec(header.trim()) : null;
  if (!m || (!m[1] && !m[2]) || size <= 0) return null;
  if (!m[1]) {
    const last = Number(m[2]);
    return last === 0 ? 'unsatisfiable' : { start: Math.max(0, size - last), end: size - 1 };
  }
  const start = Number(m[1]);
  if (m[2] && Number(m[2]) < start) return null;
  if (start >= size) return 'unsatisfiable';
  return { start, end: m[2] ? Math.min(Number(m[2]), size - 1) : size - 1 };
}
