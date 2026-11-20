// @vitest-environment jsdom
/**
 * The copy of every note kept in this browser (src/lib/localStore.ts) promises that every call
 * tolerates a browser without IndexedDB, or one that refuses it: the copy is a convenience and the
 * server has everything, so nothing here may throw into the app.
 */
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { plainRow } from './cov-helpers';

let local: typeof import('../../src/lib/localStore');

const note = (id: string, version = 1) => ({ ...plainRow(id, { version, content: `text of ${id}` }), enc: true, kgen: 0 }) as never;

async function fresh() {
  vi.resetModules();
  local = await import('../../src/lib/localStore');
}

beforeEach(async () => {
  vi.stubGlobal('indexedDB', new IDBFactory());
  await fresh();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('reading and writing the copy', () => {
  it('reads one note back by id, or nothing for one it doesn’t have', async () => {
    await local.putMany([note('a1'), note('b2', 3)]);
    expect(await local.readOne('b2')).toMatchObject({ id: 'b2', version: 3, content: 'text of b2' });
    expect(await local.readOne('zz9')).toBeNull();
    await local.removeMany(['b2']);
    expect(await local.readOne('b2')).toBeNull();
    expect((await local.readAll()).map((n) => n.id)).toEqual(['a1']);
  });

  it('does nothing for empty lists, without even opening the database', async () => {
    const open = vi.spyOn(indexedDB, 'open');
    await local.putMany([]);
    await local.removeMany([]);
    expect(open).not.toHaveBeenCalled();
  });

  it('keeps small values beside the notes, and clearing empties both', async () => {
    await local.setMeta('gen', 2);
    await local.putMany([note('a1')]);
    expect(await local.getMeta('gen')).toBe(2);
    await local.clearAll();
    expect(await local.getMeta('gen')).toBeUndefined();
    expect(await local.readAll()).toEqual([]);
  });

  it('lets another tab delete the database (signing out), then starts a new one when needed', async () => {
    await local.putMany([note('a1')]);
    // Another tab of the same browser signs out: its delete needs this tab's connection closed.
    await new Promise<void>((resolve, reject) => {
      const req = indexedDB.deleteDatabase('lumen-notes');
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error('blocked by this tab’s open connection'));
    });
    expect(await local.readAll()).toEqual([]);
    await local.putMany([note('c3')]);
    expect((await local.readAll()).map((n) => n.id)).toEqual(['c3']);
  });

  it('deleting the copy here closes this tab’s connection and removes the database', async () => {
    await local.putMany([note('a1')]);
    await local.deleteLocalNotes();
    expect((await indexedDB.databases()).map((d) => d.name)).not.toContain('lumen-notes');
    expect(await local.readAll()).toEqual([]);
  });
});

describe('a browser without a usable IndexedDB', () => {
  async function expectNothingThrows() {
    expect(await local.readAll()).toEqual([]);
    expect(await local.readOne('a1')).toBeNull();
    await expect(local.putMany([note('a1')])).resolves.toBeUndefined();
    await expect(local.removeMany(['a1'])).resolves.toBeUndefined();
    await expect(local.clearAll()).resolves.toBeUndefined();
    await expect(local.setMeta('gen', 1)).resolves.toBeUndefined();
    expect(await local.getMeta('gen')).toBeUndefined();
    await expect(local.deleteLocalNotes()).resolves.toBeUndefined();
  }

  it('without IndexedDB at all, keeps nothing and throws nothing', async () => {
    vi.stubGlobal('indexedDB', undefined);
    await fresh();
    await expectNothingThrows();
  });

  it('when opening is refused, keeps nothing and throws nothing', async () => {
    vi.stubGlobal('indexedDB', {
      open() {
        const req: Record<string, unknown> = {};
        setTimeout(() => (req.onerror as () => void)?.(), 0);
        return req;
      },
      deleteDatabase() {
        throw new DOMException('The operation is insecure.', 'SecurityError');
      },
    });
    await fresh();
    await expectNothingThrows();
  });

  it('when opening is blocked by another tab’s old connection, keeps nothing and throws nothing', async () => {
    vi.stubGlobal('indexedDB', {
      open() {
        const req: Record<string, unknown> = {};
        setTimeout(() => (req.onblocked as () => void)?.(), 0);
        return req;
      },
      deleteDatabase() {
        const req: Record<string, unknown> = {};
        setTimeout(() => (req.onblocked as () => void)?.(), 0);
        return req;
      },
    });
    await fresh();
    await expectNothingThrows();
  });

  it('when a transaction fails (storage full, say), reads come back empty and writes are dropped quietly', async () => {
    await local.putMany([note('a1')]);
    const db = await new Promise<IDBDatabase>((resolve) => {
      const req = indexedDB.open('lumen-notes', 1);
      req.onsuccess = () => resolve(req.result);
    });
    db.close();
    vi.spyOn(IDBDatabase.prototype, 'transaction').mockImplementation(() => {
      throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
    });
    await expectNothingThrows();
  });
});
