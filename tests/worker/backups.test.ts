/**
 * Automatic backups (/api/backups, worker/index.ts): kept in an R2 bucket of their own, off without
 * one. With encryption on, only an encrypted backup is kept; the newest eight are kept; one made
 * automatically on two devices at once is kept once; and each is sent back whole to restore.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { bytes, withEnv } from './api-helpers';
import { asBucket, callWith, MemoryR2 } from './cov-helpers';
import { get, LOCAL, resetLibrary, turnOnEncryption } from './helpers';

let r2: MemoryR2;
const bucket = () => ({ BACKUP_BUCKET: asBucket(r2) });
const SEALED = (rest = 'ciphertext follows') => bytes(`LUMENBK1${rest}`);
const send = (body: Uint8Array, headers: Record<string, string> = {}) =>
  callWith(bucket(), 'POST', '/backups', body, { 'content-type': 'application/octet-stream', ...headers });
const stored = () => [...r2.objects.keys()].filter((k) => k.startsWith('backups/'));

beforeEach(async () => {
  await resetLibrary();
  r2 = new MemoryR2();
});

describe('without a bucket for them', () => {
  it('says they’re off, and keeps nothing', async () => {
    expect((await get('/backups')).body).toEqual({ available: false, keep: 8, backups: [] });
    const res = await callWith({}, 'POST', '/backups', bytes('PK zip'), { 'content-type': 'application/octet-stream' });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('backups_off');
  });
});

describe('with one', () => {
  it('keeps a backup, lists it, sends it back whole, and deletes it', async () => {
    const up = await send(bytes('PK readable zip bytes'));
    expect(up.status).toBe(201);
    expect(up.body.name).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.zip$/);
    // It counts as a backup for the reminder on Home, on every device.
    expect((await get('/bootstrap')).body.lastBackup).toBe(up.body.at);

    const list = await withEnv(bucket(), `${LOCAL}/api/backups`);
    expect(list.body).toMatchObject({ available: true, keep: 8, backups: [{ name: up.body.name, size: 21, encrypted: false }] });

    const back = await withEnv(bucket(), `${LOCAL}/api/backups/${up.body.name}`);
    expect(back.status).toBe(200);
    expect(back.body).toBe('PK readable zip bytes');
    expect(back.headers.get('cache-control')).toBe('private, no-store');
    expect(back.headers.get('content-disposition')).toMatch(/^attachment;/);

    expect((await callWith(bucket(), 'DELETE', `/backups/${up.body.name}`)).status).toBe(200);
    expect(stored()).toEqual([]);
    expect((await withEnv(bucket(), `${LOCAL}/api/backups/${up.body.name}`)).status).toBe(404);
  });

  it('with encryption on, keeps only an encrypted backup, checked as it arrives', async () => {
    await turnOnEncryption();
    const readable = await send(bytes('PK readable zip bytes'));
    expect(readable.status).toBe(409);
    expect(readable.body.error).toBe('encryption_required');
    const fake = await send(bytes('PK not really sealed'), { 'x-kb-backup': 'sealed' });
    expect(fake.status).toBe(400);
    expect(fake.body.error).toBe('not_sealed');
    expect(stored()).toEqual([]);
    const sealed = await send(SEALED(), { 'x-kb-backup': 'sealed' });
    expect(sealed.status).toBe(201);
    expect(sealed.body.name).toMatch(/\.lumenbackup$/);
    expect(r2.text(`backups/${sealed.body.name}`)).toBe('LUMENBK1ciphertext follows');
  });

  it('keeps the newest eight', async () => {
    for (let i = 0; i < 9; i++) {
      const name = `2026-10-${String(i + 1).padStart(2, '0')}T03-17-00-000Z.zip`;
      await r2.put(`backups/${name}`, `old ${i}`, { customMetadata: { made_at: String(Date.UTC(2026, 9, i + 1)) } });
    }
    const up = await send(bytes('PK newest'));
    expect(up.status).toBe(201);
    const names = stored().map((k) => k.slice('backups/'.length)).sort();
    expect(names).toHaveLength(8);
    expect(names).toContain(up.body.name);
    expect(names).not.toContain('2026-10-01T03-17-00-000Z.zip');
    expect(names).not.toContain('2026-10-02T03-17-00-000Z.zip');
  });

  it('keeps one made automatically on two devices at once only once, but always one asked for', async () => {
    expect((await send(bytes('PK first'), { 'x-kb-auto': '1' })).status).toBe(201);
    const second = await send(bytes('PK second'), { 'x-kb-auto': '1' });
    expect(second.status).toBe(409);
    expect(second.body.error).toBe('recent');
    expect((await send(bytes('PK asked for'))).status).toBe(201);
    expect(stored()).toHaveLength(2);
  });

  it('only by its own kind of name', async () => {
    for (const name of ['..%2Fnotes', 'x.zip', '2026-11-20T03-17-00Z.exe']) {
      expect((await withEnv(bucket(), `${LOCAL}/api/backups/${name}`)).status, name).toBe(404);
    }
    expect((await send(new Uint8Array(0))).status).toBe(400);
  });
});
