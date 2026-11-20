// @vitest-environment jsdom
/**
 * Uploading from a note (src/lib/upload.ts): large photos are shrunk before upload, everything else
 * goes as it is (GIFs keep their animation, SVGs their vectors, PNGs their transparency when WebP
 * isn't available); the Markdown each kind of file gets; and the file picker. jsdom has no image
 * decoding or canvas, so those are stood in for.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { json, polyfillMatchMedia, standInServer, type StandIn } from './cov-helpers';

polyfillMatchMedia();

let upload: typeof import('../../src/lib/upload');
let server: StandIn;
let bitmap: { width: number; height: number; close: ReturnType<typeof vi.fn> };
let drawn: Array<{ w: number; h: number }>;
/** What the canvas can encode: type → resulting size in bytes (null: can't). */
let encodes: Record<string, number | null>;

const fileOf = (size: number, type: string, name = 'photo.jpg') => new File([new Uint8Array(size)], name, { type, lastModified: 1234 });

beforeEach(async () => {
  server = standInServer();
  bitmap = { width: 4000, height: 3000, close: vi.fn() };
  drawn = [];
  encodes = { 'image/webp': 300_000, 'image/jpeg': 350_000 };
  vi.stubGlobal('createImageBitmap', vi.fn(async () => bitmap));
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (this: HTMLCanvasElement) {
    return { drawImage: (_b: unknown, _x: number, _y: number, w: number, h: number) => drawn.push({ w, h }) } as never;
  });
  vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((cb: BlobCallback, type?: string) => {
    const size = encodes[type ?? ''];
    // Safari answers a WebP request with a PNG.
    cb(size === null || size === undefined ? new Blob([new Uint8Array(10)], { type: 'image/png' }) : new Blob([new Uint8Array(size)], { type }));
  });
  vi.resetModules();
  upload = await import('../../src/lib/upload');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('shrinking photos before upload', () => {
  it('scales a large photo to 2560 pixels on its long side, as WebP, keeping its name', async () => {
    const out = await upload.prepareImage(fileOf(5_000_000, 'image/jpeg', 'IMG_0001.JPG'));
    expect(drawn).toEqual([{ w: 2560, h: 1920 }]);
    expect(out).toMatchObject({ name: 'IMG_0001.webp', type: 'image/webp', size: 300_000, lastModified: 1234 });
    expect(bitmap.close).toHaveBeenCalled();
  });

  it('leaves small images, GIFs, SVGs and icons alone without decoding them', async () => {
    for (const f of [fileOf(100_000, 'image/jpeg'), fileOf(5_000_000, 'image/gif', 'a.gif'), fileOf(5_000_000, 'image/svg+xml', 'a.svg'), fileOf(900_000, 'image/x-icon', 'f.ico'), fileOf(5_000_000, 'application/pdf', 'a.pdf')]) {
      expect(await upload.prepareImage(f)).toBe(f);
    }
    expect(createImageBitmap).not.toHaveBeenCalled();
  });

  it('leaves a mid-sized image that’s already small enough on screen', async () => {
    bitmap.width = 2000;
    bitmap.height = 1500;
    const f = fileOf(1_000_000, 'image/jpeg');
    expect(await upload.prepareImage(f)).toBe(f);
    expect(drawn).toEqual([]);
    expect(bitmap.close).toHaveBeenCalled();
  });

  it('keeps the original when the browser can’t decode it (HEIC, say)', async () => {
    vi.stubGlobal('createImageBitmap', vi.fn(async () => Promise.reject(new DOMException('decode failed', 'InvalidStateError'))));
    const f = fileOf(3_000_000, 'image/heic', 'IMG.HEIC');
    expect(await upload.prepareImage(f)).toBe(f);
  });

  it('without WebP, a photo goes as JPEG, but a PNG stays a PNG so it keeps its transparency', async () => {
    encodes['image/webp'] = null;
    const photo = await upload.prepareImage(fileOf(5_000_000, 'image/jpeg', 'a.jpeg'));
    expect(photo).toMatchObject({ name: 'a.jpg', type: 'image/jpeg' });
    const png = fileOf(5_000_000, 'image/png', 'logo.png');
    expect(await upload.prepareImage(png)).toBe(png);
  });

  it('keeps the original when shrinking wouldn’t make it smaller, or there’s no canvas', async () => {
    encodes['image/webp'] = 6_000_000;
    const f = fileOf(5_000_000, 'image/jpeg');
    expect(await upload.prepareImage(f)).toBe(f);
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    expect(await upload.prepareImage(f)).toBe(f);
  });

  it('names a nameless file “image”', async () => {
    const out = await upload.prepareImage(fileOf(5_000_000, 'image/jpeg', '.jpg'));
    expect(out.name).toBe('image.webp');
  });
});

describe('the Markdown for an upload', () => {
  it('shows images, video and audio, and links anything else', () => {
    expect(upload.markdownFor({ mime: 'image/png', name: 'my_holiday-photo.png', url: '/api/files/f1/my_holiday-photo.png' })).toBe('![my holiday photo](/api/files/f1/my_holiday-photo.png)');
    expect(upload.markdownFor({ mime: 'video/mp4', name: 'clip.mp4', url: '/api/files/f2/clip.mp4' })).toBe('![clip](/api/files/f2/clip.mp4)');
    expect(upload.markdownFor({ mime: 'audio/mpeg', name: 'memo.mp3', url: '/api/files/f3' })).toBe('![memo](/api/files/f3)');
    expect(upload.markdownFor({ mime: 'application/pdf', name: 'Invoice 7.pdf', url: '/api/files/f4/Invoice%207.pdf' })).toBe('[📎 Invoice 7.pdf](/api/files/f4/Invoice%207.pdf)');
    // A name that's all separators keeps its own name as the label.
    expect(upload.markdownFor({ mime: 'image/png', name: '__.png', url: '/u' })).toBe('![__.png](/u)');
  });

  it('uploads with a safe name (a pasted image has none) for the note it goes in', async () => {
    server.on('POST', '/api/files', (req) => json(201, { id: 'file01', name: decodeURIComponent(req.headers['x-file-name']), mime: 'image/png', url: '/api/files/file01/x' }));
    const res = await upload.uploadForNote(new File([new Uint8Array(10)], '', { type: 'image/png' }), 'note01', false);
    const [sent] = server.requests('POST', '/api/files');
    expect(sent.headers['x-note-id']).toBe('note01');
    expect(decodeURIComponent(sent.headers['x-file-name'])).toBe('pasted-image.png');
    expect(res.markdown).toBe('![pasted image](/api/files/file01/x)');
    expect(createImageBitmap).not.toHaveBeenCalled();
  });
});

describe('the file picker', () => {
  it('resolves with the chosen files, or none when cancelled, and leaves nothing behind', async () => {
    const click = vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(function (this: HTMLInputElement) {
      queueMicrotask(() => this.dispatchEvent(new Event('cancel')));
    });
    const none = await upload.pickFiles('image/*', false, 'environment');
    expect(none).toEqual([]);
    const input = click.mock.contexts[0] as HTMLInputElement;
    expect(input).toMatchObject({ type: 'file', accept: 'image/*', multiple: false });
    expect(input.getAttribute('capture')).toBe('environment');
    expect(document.querySelectorAll('input[type=file]')).toHaveLength(0);

    const chosen = [new File(['a'], 'a.txt')];
    click.mockImplementation(function (this: HTMLInputElement) {
      Object.defineProperty(this, 'files', { value: chosen });
      queueMicrotask(() => {
        this.dispatchEvent(new Event('change'));
        this.dispatchEvent(new Event('cancel')); // a late second event changes nothing
      });
    });
    expect(await upload.pickFiles('.md')).toEqual(chosen);
    expect(document.querySelectorAll('input[type=file]')).toHaveLength(0);
  });
});
