// @vitest-environment jsdom
/**
 * Thumbnails of uploads and drawings (src/components/AssetImg.tsx): shown straight from their address
 * in a library that isn't encrypted, and decrypted first in one that is, so they appear a moment later,
 * or stay a blank placeholder if they can't be decrypted. A placeholder never shows an old picture.
 */
import { mount, settle, unmountAll } from './ui-note-helpers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const assets = vi.hoisted(() => ({
  encrypted: false,
  cache: new Map<string, string>(),
  pending: new Map<string, { resolve: (url: string) => void; reject: (err: unknown) => void }>(),
}));
vi.mock('../../src/lib/assets', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/lib/assets')>()),
  decryptingAssets: () => assets.encrypted,
  cachedAssetUrl: (src: string) => assets.cache.get(src) ?? null,
  resolveAsset: (src: string) => new Promise<string>((resolve, reject) => assets.pending.set(src, { resolve, reject })),
}));

import { act } from 'react';
import { AssetImg } from '../../src/components/AssetImg';

beforeEach(() => {
  assets.encrypted = false;
  assets.cache.clear();
  assets.pending.clear();
});
afterEach(unmountAll);

const img = (root: HTMLElement) => root.querySelector('img')!;

describe('a thumbnail', () => {
  it('shows an upload straight from its address when the library isn’t encrypted', async () => {
    const { container } = await mount(<AssetImg src="/api/files/abcdef12" alt="Receipt" className="thumb" />);
    expect(img(container).getAttribute('src')).toBe('/api/files/abcdef12');
    expect(img(container).getAttribute('alt')).toBe('Receipt');
    expect(img(container).className).toBe('thumb');
    expect(assets.pending.size).toBe(0);
  });

  it('shows a picture from another website as it is, even in an encrypted library', async () => {
    assets.encrypted = true;
    const { container } = await mount(<AssetImg src="https://example.com/cat.png" alt="" />);
    expect(img(container).getAttribute('src')).toBe('https://example.com/cat.png');
  });

  it('in an encrypted library, waits blank (with its description) until the file is decrypted, then shows it', async () => {
    assets.encrypted = true;
    const { container } = await mount(<AssetImg src="/api/files/abcdef12" alt="Receipt" />);
    expect(img(container).hasAttribute('src')).toBe(false);
    expect(img(container).hasAttribute('data-pending')).toBe(true);
    expect(img(container).getAttribute('alt')).toBe('Receipt');
    await act(async () => assets.pending.get('/api/files/abcdef12')!.resolve('blob:http://localhost/decrypted'));
    expect(img(container).getAttribute('src')).toBe('blob:http://localhost/decrypted');
    expect(img(container).hasAttribute('data-pending')).toBe(false);
  });

  it('has an empty description while waiting when it was given none, so it isn’t read out as a file name', async () => {
    assets.encrypted = true;
    const { container } = await mount(<AssetImg src="/api/drawings/abcdef12.svg" />);
    expect(img(container).getAttribute('alt')).toBe('');
  });

  it('shows a file already decrypted this session at once', async () => {
    assets.encrypted = true;
    assets.cache.set('/api/files/abcdef12', 'blob:http://localhost/kept');
    const { container } = await mount(<AssetImg src="/api/files/abcdef12" alt="" />);
    expect(img(container).getAttribute('src')).toBe('blob:http://localhost/kept');
    expect(assets.pending.size).toBe(0);
  });

  it('stays a placeholder when the file can’t be decrypted', async () => {
    assets.encrypted = true;
    const { container } = await mount(<AssetImg src="/api/files/abcdef12" alt="" />);
    await act(async () => assets.pending.get('/api/files/abcdef12')!.reject(new Error('offline')));
    await settle();
    expect(img(container).hasAttribute('src')).toBe(false);
    expect(img(container).hasAttribute('data-pending')).toBe(true);
  });

  it('shows the picture now asked for, never one that finished decrypting for the address before', async () => {
    assets.encrypted = true;
    const { container, rerender } = await mount(<AssetImg src="/api/files/first111" alt="" />);
    await rerender(<AssetImg src="/api/files/second22" alt="" />);
    expect(img(container).hasAttribute('src')).toBe(false);
    await act(async () => assets.pending.get('/api/files/first111')!.resolve('blob:http://localhost/first'));
    expect(img(container).hasAttribute('src')).toBe(false);
    await act(async () => assets.pending.get('/api/files/second22')!.resolve('blob:http://localhost/second'));
    expect(img(container).getAttribute('src')).toBe('blob:http://localhost/second');
  });

  it('goes blank, not on showing the last picture, when its address changes to one not decrypted yet', async () => {
    assets.encrypted = true;
    assets.cache.set('/api/files/first111', 'blob:http://localhost/first');
    const { container, rerender } = await mount(<AssetImg src="/api/files/first111" alt="" />);
    expect(img(container).getAttribute('src')).toBe('blob:http://localhost/first');
    await rerender(<AssetImg src="/api/files/second22" alt="" />);
    expect(img(container).hasAttribute('src')).toBe(false);
  });
});
