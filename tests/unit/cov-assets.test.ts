// @vitest-environment jsdom
/**
 * Showing encrypted images, media and drawings in rendered notes (src/lib/assets.ts), beyond
 * e2ee-attachments.test.ts: each is fetched and decrypted only as it comes near the screen, video and
 * audio only once clicked, failures say why on the element itself, drawings saved again show their
 * new picture, and decrypted copies kept in memory stay within their limit.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { newMasterKey } from '../../src/lib/crypto';
import { polyfillMatchMedia, settle, standInServer } from './cov-helpers';

polyfillMatchMedia();

let assets: typeof import('../../src/lib/assets');
let apiMod: typeof import('../../src/lib/api');
let store: typeof import('../../src/lib/store');
let fileBlob: ReturnType<typeof vi.spyOn>;
let drawingPart: ReturnType<typeof vi.spyOn>;
let observers: Array<{ cb: IntersectionObserverCallback; watched: Set<Element> }>;
let revoked: string[];
let urlSeq = 0;
const MB = 1024 * 1024;

/** Brings elements on screen for the IntersectionObserver the module made. */
function scrollIntoView(...els: Element[]) {
  const io = observers[0];
  io.cb(
    els.map((target) => ({ target, isIntersecting: true }) as IntersectionObserverEntry),
    {} as IntersectionObserver,
  );
}

function rendered(html: string) {
  const root = document.createElement('div');
  root.innerHTML = html;
  document.body.appendChild(root);
  return root;
}

beforeEach(async () => {
  standInServer();
  observers = [];
  revoked = [];
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      watched = new Set<Element>();
      constructor(public cb: IntersectionObserverCallback) {
        observers.push(this);
      }
      observe(el: Element) {
        this.watched.add(el);
      }
      unobserve(el: Element) {
        this.watched.delete(el);
      }
      disconnect() {}
    },
  );
  URL.createObjectURL = vi.fn(() => `blob:http://localhost/${++urlSeq}`);
  URL.revokeObjectURL = vi.fn((u: string) => void revoked.push(u));
  await loadModules();
  document.body.innerHTML = '';
});

/** The app's modules afresh, unlocked, with downloads answered here (decrypting is tested elsewhere). */
async function loadModules() {
  vi.resetModules();
  apiMod = await import('../../src/lib/api');
  store = await import('../../src/lib/store');
  assets = await import('../../src/lib/assets');
  const e2ee = await import('../../src/lib/e2ee');
  apiMod.setCodec(e2ee.createCodec(await newMasterKey()));
  fileBlob = vi.spyOn(apiMod.api, 'fileBlob').mockImplementation(async (id: string) => ({ blob: new Blob([`bytes of ${id}`], { type: 'image/png' }), name: `${id}.png`, mime: 'image/png' }));
  drawingPart = vi.spyOn(apiMod.api, 'drawingPart').mockImplementation(async (id: string) => `<svg>${id}</svg>`);
}

afterEach(() => {
  apiMod.setCodec(null);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('images in a rendered note', () => {
  it('are decrypted only as they come near the screen, once each', async () => {
    const root = rendered('<img data-kb-asset="/api/files/fileAAA1/a.png" class="kb-asset-pending"><img data-kb-asset="/api/files/fileBBB2">');
    assets.hydrateAssets(root);
    assets.hydrateAssets(root); // a second pass (a re-render) doesn't watch them twice
    expect(fileBlob).not.toHaveBeenCalled();
    expect(observers[0].watched.size).toBe(2);
    const [a] = root.querySelectorAll('img');
    scrollIntoView(a);
    await settle();
    expect(fileBlob).toHaveBeenCalledTimes(1);
    expect(a.getAttribute('src')).toMatch(/^blob:/);
    expect(a.classList.contains('kb-asset-pending')).toBe(false);
    expect(observers[0].watched.size).toBe(1);
    // Drawn again later (another note, or the same one re-rendered): straight from memory.
    const again = rendered('<img data-kb-asset="/api/files/fileAAA1/a.png">');
    assets.hydrateAssets(again);
    expect(again.querySelector('img')!.getAttribute('src')).toBe(a.getAttribute('src'));
    expect(fileBlob).toHaveBeenCalledTimes(1);
  });

  it('are all filled at once where there’s no IntersectionObserver', async () => {
    vi.stubGlobal('IntersectionObserver', undefined);
    await loadModules();
    const root = rendered('<img data-kb-asset="/api/files/fileAAA1"><img data-kb-asset="/api/files/fileBBB2">');
    assets.hydrateAssets(root);
    await settle();
    expect([...root.querySelectorAll('img')].every((i) => i.getAttribute('src')?.startsWith('blob:'))).toBe(true);
  });

  it('that fail say why on the image itself', async () => {
    fileBlob.mockImplementation(async (id: string) => {
      if (id === 'offline1') throw new apiMod.NetworkError('offline');
      if (id === 'missing1') throw new apiMod.ApiError(404, 'not_found', 'File not found.');
      if (id === 'plain111') throw new apiMod.ApiError(422, 'unencrypted', 'no');
      if (id === 'locked11') throw new apiMod.ApiError(423, 'locked', 'no');
      throw new apiMod.ApiError(422, 'undecryptable', 'no');
    });
    const root = rendered(['offline1', 'missing1', 'plain111', 'locked11', 'broken11'].map((id) => `<img data-kb-asset="/api/files/${id}" class="kb-asset-pending">`).join(''));
    const imgs = [...root.querySelectorAll('img')];
    await assets.hydrateAssetsNow(root);
    expect(imgs.map((i) => i.alt)).toEqual(['Not available offline', 'File not found', 'Unencrypted file (not shown)', 'Unlock Lumen to see this', 'Can’t decrypt this file']);
    expect(imgs.every((i) => i.classList.contains('kb-asset-failed') && !i.classList.contains('kb-asset-pending'))).toBe(true);
    expect(imgs[0].title).toBe('Not available offline');
  });

  it('whose address changed while decrypting keep the new one', async () => {
    let finish!: () => void;
    fileBlob.mockImplementationOnce(async (id: string) => {
      await new Promise<void>((r) => (finish = r));
      return { blob: new Blob([id]), name: id, mime: 'image/png' };
    });
    const root = rendered('<img data-kb-asset="/api/files/oldfile1">');
    const img = root.querySelector('img')!;
    const filling = assets.hydrateAssetsNow(root);
    await settle();
    img.setAttribute('data-kb-asset', '/api/files/newfile1');
    finish();
    await filling;
    expect(img.getAttribute('src')).toBeNull();
  });

  it('already showing a decrypted copy are left as they are', async () => {
    const root = rendered('<img data-kb-asset="/api/files/fileAAA1" src="blob:http://localhost/kept">');
    assets.hydrateAssets(root);
    expect(observers[0]?.watched.size ?? 0).toBe(0);
    expect(root.querySelector('img')!.getAttribute('src')).toBe('blob:http://localhost/kept');
  });
});

describe('video and audio', () => {
  it('download nothing until clicked (or Enter or Space), then load and play', async () => {
    const play = vi.fn(async () => undefined);
    HTMLMediaElement.prototype.play = play;
    const root = rendered('<video data-kb-asset="/api/files/video001"></video><audio data-kb-asset="/api/files/audio001"></audio>');
    assets.hydrateAssets(root);
    assets.hydrateAssets(root);
    const [video, audio] = [root.querySelector('video')!, root.querySelector('audio')!];
    expect(video.getAttribute('poster')).toMatch(/^data:image\/svg\+xml,/);
    expect(video.title).toBe('Click to load and play');
    expect(video.tabIndex).toBe(0);
    expect(fileBlob).not.toHaveBeenCalled();

    video.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }));
    expect(fileBlob).not.toHaveBeenCalled();
    video.dispatchEvent(new MouseEvent('click'));
    await settle();
    expect(fileBlob).toHaveBeenCalledWith('video001');
    expect(video.getAttribute('src')).toMatch(/^blob:/);
    expect(video.hasAttribute('title')).toBe(false);
    expect(play).toHaveBeenCalledTimes(1);
    // A second click is the player's own business.
    video.dispatchEvent(new MouseEvent('click'));
    await settle();
    expect(fileBlob).toHaveBeenCalledTimes(1);

    audio.dispatchEvent(new KeyboardEvent('keydown', { key: ' ' }));
    await settle();
    expect(fileBlob).toHaveBeenCalledWith('audio001');
    expect(play).toHaveBeenCalledTimes(2);
  });
});

describe('drawings', () => {
  it('show their new picture once saved again, dropping the old copy', async () => {
    const root = rendered('<img data-kb-asset="/api/drawings/drawAAA1.svg?v=1">');
    await assets.hydrateAssetsNow(root);
    const first = root.querySelector('img')!.getAttribute('src')!;
    expect(drawingPart).toHaveBeenCalledWith('drawAAA1', 'svg');
    expect(assets.cachedAssetUrl('/api/drawings/drawAAA1.svg?v=1')).toBe(first);
    store.bumpDrawing('drawAAA1');
    expect(revoked).toContain(first);
    expect(assets.cachedAssetUrl('/api/drawings/drawAAA1.svg?v=1')).toBeNull();
  });

  it('are told apart from uploads, other sites and other paths by their address', () => {
    expect(assets.assetRef('/api/drawings/drawAAA1.svg?v=abc')).toEqual({ kind: 'drawing', id: 'drawAAA1', v: 'abc' });
    expect(assets.assetRef('/api/drawings/drawAAA1.svg')).toEqual({ kind: 'drawing', id: 'drawAAA1', v: '' });
    expect(assets.assetRef('/api/files/fileAAA1/name.png#x')).toEqual({ kind: 'file', id: 'fileAAA1' });
    expect(assets.assetRef('https://elsewhere.example/api/files/fileAAA1')).toBeNull();
    expect(assets.assetRef('/api/drawings/drawAAA1/scene')).toBeNull();
    expect(assets.assetRef('/api/files/ab')).toBeNull();
    expect(assets.assetRef('http://[::1')).toBeNull();
  });
});

describe('decrypted copies in memory', () => {
  it('stay within 160 MB, the ones used longest ago going first', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: 1_700_000_000_000 });
    fileBlob.mockImplementation(async (id: string) => ({ blob: { size: 60 * MB } as Blob, name: id, mime: 'image/png' }));
    const url1 = await assets.resolveAsset('/api/files/big00001');
    vi.advanceTimersByTime(1000);
    const url2 = await assets.resolveAsset('/api/files/big00002');
    vi.advanceTimersByTime(1000);
    // The first is used again, so the second is now the one used longest ago.
    expect(assets.cachedAssetUrl('/api/files/big00001')).toBe(url1);
    vi.advanceTimersByTime(1000);
    await assets.resolveAsset('/api/files/big00003');
    expect(revoked).toEqual([url2]);
    expect(assets.cachedAssetUrl('/api/files/big00002')).toBeNull();
    expect(assets.cachedAssetUrl('/api/files/big00001')).toBe(url1);
  });

  it('one file bigger than the whole limit is still shown', async () => {
    fileBlob.mockImplementation(async (id: string) => ({ blob: { size: 200 * MB } as Blob, name: id, mime: 'video/mp4' }));
    const url = await assets.resolveAsset('/api/files/huge0001');
    expect(assets.cachedAssetUrl('/api/files/huge0001')).toBe(url);
  });

  it('two requests for the same file at once share one download', async () => {
    const [a, b] = await Promise.all([assets.resolveAsset('/api/files/same0001'), assets.resolveAsset('/api/files/same0001')]);
    expect(a).toBe(b);
    expect(fileBlob).toHaveBeenCalledTimes(1);
  });
});

describe('an image in the editor', () => {
  it('shows an address as it is when nothing needs decrypting', () => {
    apiMod.setCodec(null);
    const img = document.createElement('img');
    assets.setAssetSrc(img, '/api/files/fileAAA1/a.png', () => undefined);
    expect(img.getAttribute('src')).toBe('/api/files/fileAAA1/a.png');
  });

  it('shows the decrypted copy, at once when it’s in memory, and says why when it can’t', async () => {
    const img = document.createElement('img');
    assets.setAssetSrc(img, '/api/files/fileAAA1', () => undefined);
    await settle();
    const url = img.getAttribute('src');
    expect(url).toMatch(/^blob:/);
    const again = document.createElement('img');
    assets.setAssetSrc(again, '/api/files/fileAAA1', () => undefined);
    expect(again.getAttribute('src')).toBe(url);

    fileBlob.mockRejectedValueOnce(new apiMod.NetworkError('offline'));
    const errors: string[] = [];
    assets.setAssetSrc(document.createElement('img'), '/api/files/fileOFF1', (m) => errors.push(m));
    await settle();
    expect(errors).toEqual(['Not available offline']);
  });
});

describe('opening a link to an upload', () => {
  it('says why when it can’t be opened, closing the tab it had opened', async () => {
    const tab = { opener: {}, close: vi.fn(), location: { href: '' } };
    vi.spyOn(window, 'open').mockReturnValue(tab as never);
    fileBlob.mockRejectedValueOnce(new apiMod.ApiError(404, 'not_found', 'File not found.'));
    assets.openAsset('/api/files/fileGONE/report.pdf');
    await settle();
    expect(tab.opener).toBeNull();
    expect(tab.close).toHaveBeenCalled();
    expect(store.useApp.getState().toasts.map((t) => t.message)).toContain('File not found');
  });

  it('ignores anything that isn’t an upload', () => {
    const open = vi.spyOn(window, 'open');
    assets.openAsset('/api/drawings/drawAAA1.svg');
    assets.openAsset('https://example.com/file.pdf');
    expect(open).not.toHaveBeenCalled();
    expect(fileBlob).not.toHaveBeenCalled();
  });
});
