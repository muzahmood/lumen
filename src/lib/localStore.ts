/**
 * The copy of every note kept in this browser (IndexedDB "lumen-notes"), exactly as the server sends
 * it. Only kept for an encrypted library, so what's stored is ciphertext: the same as the server
 * holds, and useless without the key, which lives elsewhere (see vault.ts) and leaves when the device
 * locks. Signing out of the device deletes it.
 *
 * Every call tolerates a browser without IndexedDB (some private windows): it then keeps nothing.
 */
import type { Note } from './types';

/** A note as the server sends it: for an encrypted note, `content` and `sealed` are ciphertext. */
export type RawNote = Note & { kgen?: number };

const DB_NAME = 'lumen-notes';
const NOTES = 'notes';
const META = 'meta';

let opening: Promise<IDBDatabase | null> | null = null;

function open(): Promise<IDBDatabase | null> {
  opening ??= new Promise<IDBDatabase | null>((resolve) => {
    let req: IDBOpenDBRequest;
    try {
      req = indexedDB.open(DB_NAME, 1);
    } catch {
      resolve(null);
      return;
    }
    req.onupgradeneeded = () => {
      req.result.createObjectStore(NOTES, { keyPath: 'id' });
      req.result.createObjectStore(META);
    };
    req.onsuccess = () => {
      const db = req.result;
      // Another tab deleting the database (signing out) needs this connection closed.
      db.onversionchange = () => {
        db.close();
        opening = null;
      };
      resolve(db);
    };
    req.onerror = () => resolve(null);
    req.onblocked = () => resolve(null);
  });
  return opening;
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function readAll(): Promise<RawNote[]> {
  const db = await open();
  if (!db) return [];
  try {
    return await request(db.transaction(NOTES, 'readonly').objectStore(NOTES).getAll() as IDBRequest<RawNote[]>);
  } catch {
    return [];
  }
}

export async function readOne(id: string): Promise<RawNote | null> {
  const db = await open();
  if (!db) return null;
  try {
    return ((await request(db.transaction(NOTES, 'readonly').objectStore(NOTES).get(id))) as RawNote | undefined) ?? null;
  } catch {
    return null;
  }
}

/** Keeps notes as stored, each only over an older copy (or none): never a newer one with an older one. */
export async function putMany(rows: RawNote[]): Promise<void> {
  if (!rows.length) return;
  const db = await open();
  if (!db) return;
  try {
    const tx = db.transaction(NOTES, 'readwrite');
    const store = tx.objectStore(NOTES);
    for (const row of rows) {
      const kept = store.get(row.id);
      kept.onsuccess = () => {
        const old = kept.result as RawNote | undefined;
        if (!old || !(old.version > row.version)) store.put(row);
      };
    }
    await done(tx);
  } catch {
    /* full or unavailable: the copy is a convenience, the server has everything */
  }
}

export async function removeMany(ids: string[]): Promise<void> {
  if (!ids.length) return;
  const db = await open();
  if (!db) return;
  try {
    const tx = db.transaction(NOTES, 'readwrite');
    const store = tx.objectStore(NOTES);
    for (const id of ids) store.delete(id);
    await done(tx);
  } catch {
    /* ignore */
  }
}

export async function clearAll(): Promise<void> {
  const db = await open();
  if (!db) return;
  try {
    const tx = db.transaction([NOTES, META], 'readwrite');
    tx.objectStore(NOTES).clear();
    tx.objectStore(META).clear();
    await done(tx);
  } catch {
    /* ignore */
  }
}

export async function getMeta<T>(key: string): Promise<T | undefined> {
  const db = await open();
  if (!db) return undefined;
  try {
    return (await request(db.transaction(META, 'readonly').objectStore(META).get(key))) as T | undefined;
  } catch {
    return undefined;
  }
}

export async function setMeta(key: string, value: unknown): Promise<void> {
  const db = await open();
  if (!db) return;
  try {
    const tx = db.transaction(META, 'readwrite');
    tx.objectStore(META).put(value, key);
    await done(tx);
  } catch {
    /* ignore */
  }
}

/** Deletes the whole database (signing out of the device). */
export async function deleteLocalNotes(): Promise<void> {
  const db = await opening?.catch(() => null);
  db?.close();
  opening = null;
  await new Promise<void>((resolve) => {
    try {
      const req = indexedDB.deleteDatabase(DB_NAME);
      req.onsuccess = req.onerror = req.onblocked = () => resolve();
    } catch {
      resolve();
    }
  });
}
