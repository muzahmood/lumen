import type { NoteLinks } from '../../shared/noteText';

export type { NoteLinks };

export interface Folder {
  id: string;
  parent_id: string | null;
  name: string;
  sort: number;
  created_at: number;
  updated_at: number;
  /** End-to-end encrypted: the name arrives as `sealed` (ciphertext) and the app decrypts it. */
  enc?: boolean;
  sealed?: string;
}

/** An encrypted note's other fields as ciphertext: t (title), g (tags), p (preview: excerpt and info). */
export interface Sealed {
  t?: string;
  g?: string;
  p?: string;
}

/** Compact summary computed by the server for list views. */
export interface NoteInfo {
  /** First image or drawing URL. */
  th?: string;
  /** Tasks: [done, total]. */
  t?: [number, number];
  /** Number of Mermaid diagrams. */
  d?: number;
  /** Number of drawings. */
  dr?: number;
  /** Number of pictures (uploaded or from other websites; not drawings, video or audio). */
  im?: number;
  /** Word count. */
  w?: number;
}

export interface NoteMeta {
  id: string;
  folder_id: string | null;
  title: string;
  excerpt: string;
  info: NoteInfo;
  tags: string[];
  pinned: boolean;
  version: number;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
  /** End-to-end encrypted. The app decrypts the fields above from `sealed` as it receives them. */
  enc?: boolean;
  sealed?: Sealed;
  /**
   * Encrypted notes only: the notes this one links to, from its encrypted preview, for backlinks.
   * Absent for a preview saved before links were kept there (see upgradePreviews in e2ee.ts).
   */
  links?: NoteLinks;
  /** Encrypted notes only: which version of Lumen's preview rules made the preview (see e2ee.ts). */
  pv?: number;
  /** Encrypted, and the tags couldn't be decrypted: `tags` is an empty stand-in, never to be saved. */
  tagsUnreadable?: boolean;
}

export interface Note extends NoteMeta {
  content: string;
}

export interface Me {
  email: string | null;
  verified: boolean;
  via: 'access' | 'local';
  accessConfigured: boolean;
  storage: 'kv' | 'r2' | null;
  maxUploadBytes: number;
}

export interface Bootstrap {
  /** The service worker's copy from when the list was last fetched, not the server's list now (offline). */
  offline?: boolean;
  me: Me;
  folders: Folder[];
  notes: NoteMeta[];
  /** Whether end-to-end encryption is on, and how much is still stored unencrypted. */
  encryption?: {
    on: boolean;
    pending: { notes: number; versions: number; folders: number } | null;
    /** Uploads and drawings still stored unencrypted (saved before they were encrypted too). */
    attachments?: { files: number; drawings: number };
    /** The key generation, and what is still encrypted with an earlier key (after a replacement). */
    gen?: number;
    rekey?: { notes: number; versions: number; folders: number; files?: number; drawings?: number };
  };
  /** When a backup of the whole library was last downloaded, from any device (null: never). */
  lastBackup?: number | null;
  /** The settings that follow the person to every device (see settingsSync.ts); null: none saved yet. */
  settings?: StoredSettings | null;
  serverTime: number;
}

/** Synced settings as stored: JSON, or encrypted (in key generation `kgen`); `at` is the server's time of the save. */
export interface StoredSettings {
  at: number;
  enc: boolean;
  data: string;
  kgen: number;
}

/** The master key, wrapped (encrypted) by the passphrase and by the recovery key. */
export interface KeyringData {
  v: 1;
  kdf: { name: 'PBKDF2'; hash: 'SHA-256'; iterations: number; salt: string };
  pass: { iv: string; key: string };
  recovery: { iv: string; key: string };
  /** A known text encrypted with the master key, so a device can tell its stored key is still the right one. */
  check?: string;
  /** Key generation: 0 until the encryption key is first replaced, then one more each time. */
  gen?: number;
  /** Earlier master keys, newest first, each wrapped by the current one: they still open text written before a replacement. */
  prev?: Array<{ iv: string; key: string }>;
}

export interface Keyring {
  id: number;
  created_at: number;
  data: KeyringData;
}

export interface SearchHit {
  id: string;
  title: string;
  folder_id: string | null;
  updated_at: number;
  tags: string[];
  snippet: string;
}

export interface FileInfo {
  id: string;
  note_id: string | null;
  name: string;
  mime: string;
  size: number;
  storage: 'kv' | 'r2';
  created_at: number;
  url: string;
  /** End-to-end encrypted: the name and type arrive in `sealed` (with the file's own key) and the app fills them in. */
  enc?: boolean;
  sealed?: string;
}

export interface DrawingInfo {
  id: string;
  note_id: string | null;
  rev: string;
  storage: 'kv' | 'r2';
  size: number;
  created_at: number;
  updated_at: number;
  /** End-to-end encrypted: its parts are ciphertext under this revision's own key. */
  enc?: boolean;
}

export interface VersionInfo {
  id: number;
  title: string;
  size: number;
  created_at: number;
  enc?: boolean;
  sealed?: Sealed;
}

export interface Version {
  id: number;
  note_id: string;
  title: string;
  content: string;
  created_at: number;
  enc?: boolean;
  sealed?: Sealed;
  /** Encrypted, and the title couldn't be decrypted: `title` is a blank stand-in, never to be saved. */
  titleUnreadable?: boolean;
}

export interface Backlink {
  id: string;
  title: string;
  excerpt: string;
  updated_at: number;
}

export type ListFilter =
  | { kind: 'all' }
  | { kind: 'pinned' }
  | { kind: 'folder'; id: string }
  | { kind: 'tag'; tag: string }
  /** A saved search (settings.savedSearches), by its id. */
  | { kind: 'search'; id: string }
  | { kind: 'trash' };

export type SortKey = 'updated' | 'created' | 'title';
export type ViewMode = 'edit' | 'split' | 'read';
