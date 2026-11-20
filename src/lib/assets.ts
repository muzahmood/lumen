/**
 * Showing uploads and drawings in an encrypted library. The server has only ciphertext, so nothing
 * points the browser at /api/files/… or /api/drawings/….svg directly: each is fetched (by id alone,
 * so no request carries a file's name), decrypted here, and shown from a blob: address kept in
 * memory. In a library that isn't encrypted, addresses are used as they are.
 *
 * - Rendered notes mark these images and media `data-kb-asset` (markdown.ts) and hydrateAssets fills
 *   them in as they come near the screen; video and audio wait for a click, so scrolling past a
 *   recording doesn't download all of it.
 * - Thumbnails use <AssetImg>; the editor's image previews use setAssetSrc.
 * - Links to files open through openAsset: images, PDFs, media and plain text in a new tab, anything
 *   else as a download (a decrypted HTML or SVG file must never open as a page of this site).
 */
import { api, ApiError, currentCodec, NetworkError } from './api';
import { toast, useApp } from './store';

const FILE = /^\/api\/files\/([A-Za-z0-9_-]{6,64})(?=[/?#]|$)/;
const DRAWING = /^\/api\/drawings\/([A-Za-z0-9_-]{6,64})\.svg(?=[?#]|$)/;

export type AssetRef = { kind: 'file'; id: string } | { kind: 'drawing'; id: string; v: string };

/** The upload or drawing an address in a note refers to, if it's one. */
export function assetRef(src: string): AssetRef | null {
  let path = src;
  try {
    const url = new URL(src, location.href);
    if (url.origin !== location.origin) return null;
    path = url.pathname + url.search;
  } catch {
    return null;
  }
  const f = FILE.exec(path);
  if (f) return { kind: 'file', id: f[1] };
  const d = DRAWING.exec(path);
  if (d) return { kind: 'drawing', id: d[1], v: /[?&]v=([\w-]+)/.exec(path)?.[1] ?? '' };
  return null;
}

/** Whether uploads and drawings are decrypted on this device rather than loaded straight from the server. */
export function decryptingAssets(): boolean {
  return currentCodec() !== null;
}

/* -------------------------------------------------------- the cache --- */

interface Entry {
  url: string;
  bytes: number;
  name: string;
  mime: string;
  used: number;
}

/** Decrypted copies in memory, up to this much; the least recently used go first. */
const MAX_BYTES = 160 * 1024 * 1024;
const entries = new Map<string, Entry>();
const loading = new Map<string, Promise<Entry>>();
let total = 0;

const keyOf = (ref: AssetRef) => (ref.kind === 'file' ? `f:${ref.id}` : `d:${ref.id}:${ref.v}`);

function remember(key: string, blob: Blob, name: string, mime: string): Entry {
  const entry: Entry = { url: URL.createObjectURL(blob), bytes: blob.size, name, mime, used: Date.now() };
  entries.set(key, entry);
  total += entry.bytes;
  if (total > MAX_BYTES) {
    for (const [k, e] of [...entries].sort((a, b) => a[1].used - b[1].used)) {
      if (total <= MAX_BYTES * 0.8 || k === key) break;
      URL.revokeObjectURL(e.url);
      entries.delete(k);
      total -= e.bytes;
    }
  }
  return entry;
}

function forget(prefix: string) {
  for (const [k, e] of entries) {
    if (!k.startsWith(prefix)) continue;
    URL.revokeObjectURL(e.url);
    entries.delete(k);
    total -= e.bytes;
  }
}

// A drawing saved again shows its new picture: earlier copies of it go.
useApp.subscribe((s, prev) => {
  if (s.drawingRevs === prev.drawingRevs) return;
  for (const id of Object.keys(s.drawingRevs)) if (s.drawingRevs[id] !== prev.drawingRevs[id]) forget(`d:${id}:`);
});

async function load(ref: AssetRef): Promise<Entry> {
  const key = keyOf(ref);
  const hit = entries.get(key);
  if (hit) {
    hit.used = Date.now();
    return hit;
  }
  let pending = loading.get(key);
  if (!pending) {
    pending = (async () => {
      if (ref.kind === 'file') {
        const { blob, name, mime } = await api.fileBlob(ref.id);
        return remember(key, blob, name, mime);
      }
      const svg = await api.drawingPart(ref.id, 'svg');
      return remember(key, new Blob([svg], { type: 'image/svg+xml' }), `${ref.id}.svg`, 'image/svg+xml');
    })().finally(() => loading.delete(key));
    loading.set(key, pending);
  }
  return pending;
}

/** The decrypted copy's address, if it's already in memory. */
export function cachedAssetUrl(src: string): string | null {
  const ref = assetRef(src);
  const hit = ref ? entries.get(keyOf(ref)) : undefined;
  if (!hit) return null;
  hit.used = Date.now();
  return hit.url;
}

/** The decrypted copy's address (a blob: URL), fetching and decrypting it if needed. */
export async function resolveAsset(src: string): Promise<string> {
  const ref = assetRef(src);
  if (!ref) return src;
  return (await load(ref)).url;
}

/** Why an attachment couldn't be shown, in words. */
export function assetError(err: unknown): string {
  if (err instanceof NetworkError) return 'Not available offline';
  if (err instanceof ApiError && err.status === 404) return 'File not found';
  if (err instanceof ApiError && err.code === 'unencrypted') return 'Unencrypted file (not shown)';
  if (err instanceof ApiError && err.status === 423) return 'Unlock Lumen to see this';
  return 'Can’t decrypt this file';
}

/* -------------------------------------------------- rendered notes --- */

const observed = new WeakSet<Element>();
const armed = new WeakSet<Element>();

function setSrc(el: Element, url: string) {
  if (el.getAttribute('src') !== url) el.setAttribute('src', url);
  el.classList.remove('kb-asset-pending', 'kb-asset-failed');
}

function fill(el: Element): Promise<void> {
  const src = el.getAttribute('data-kb-asset');
  if (!src) return Promise.resolve();
  return resolveAsset(src).then(
    (url) => {
      if (el.getAttribute('data-kb-asset') === src) setSrc(el, url);
    },
    (err) => {
      if (el.getAttribute('data-kb-asset') !== src) return;
      el.classList.remove('kb-asset-pending');
      el.classList.add('kb-asset-failed');
      const message = assetError(err);
      el.setAttribute('title', message);
      if (el instanceof HTMLImageElement) el.alt = message;
    },
  );
}

let io: IntersectionObserver | null = null;
function observer(): IntersectionObserver | null {
  if (io || typeof IntersectionObserver === 'undefined') return io;
  io = new IntersectionObserver(
    (seen) => {
      for (const e of seen) {
        if (!e.isIntersecting) continue;
        io!.unobserve(e.target);
        observed.delete(e.target);
        void fill(e.target);
      }
    },
    { rootMargin: '800px 0px' },
  );
  return io;
}

/** A play button for video before anything is downloaded. */
const POSTER =
  'data:image/svg+xml,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 90"><rect width="160" height="90" fill="#142030"/><circle cx="80" cy="45" r="17" fill="#fff" fill-opacity=".92"/><path d="M75 37v16l13-8z" fill="#142030"/></svg>',
  );

/** Video and audio load on the first click (or key press) on them, then play. */
function armMedia(el: HTMLMediaElement) {
  if (armed.has(el)) return;
  armed.add(el);
  if (el instanceof HTMLVideoElement && !el.getAttribute('poster')) el.setAttribute('poster', POSTER);
  el.title = 'Click to load and play';
  const start = () => {
    el.removeEventListener('click', start);
    el.removeEventListener('keydown', onKey);
    el.removeAttribute('title');
    void fill(el).then(() => el.play().catch(() => undefined));
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') start();
  };
  el.addEventListener('click', start);
  el.addEventListener('keydown', onKey);
  if (!el.hasAttribute('tabindex')) el.tabIndex = 0;
}

/** Fills in the encrypted images and media under `root` (rendered with data-kb-asset). */
export function hydrateAssets(root: ParentNode) {
  root.querySelectorAll<HTMLElement>('[data-kb-asset]').forEach((el) => {
    const src = el.getAttribute('data-kb-asset')!;
    const cached = cachedAssetUrl(src);
    if (cached) {
      setSrc(el, cached);
      return;
    }
    if (el.getAttribute('src')?.startsWith('blob:')) return;
    if (el instanceof HTMLMediaElement) {
      armMedia(el);
      return;
    }
    const obs = observer();
    if (!obs) {
      void fill(el);
      return;
    }
    if (!observed.has(el)) {
      observed.add(el);
      obs.observe(el);
    }
  });
}

/** The same, all at once, waiting until each is in (for printing). */
export async function hydrateAssetsNow(root: ParentNode): Promise<void> {
  await Promise.all(Array.from(root.querySelectorAll('[data-kb-asset]'), (el) => fill(el)));
}

/**
 * Sets an <img>'s picture from a note's address: straight, or (encrypted) the decrypted copy, which
 * may arrive a moment later. `onError` is told when it can't be shown.
 */
export function setAssetSrc(img: HTMLImageElement, src: string, onError: (message: string) => void) {
  if (!decryptingAssets() || !assetRef(src)) {
    img.src = src;
    return;
  }
  const cached = cachedAssetUrl(src);
  if (cached) {
    img.src = cached;
    return;
  }
  resolveAsset(src).then(
    (url) => (img.src = url),
    (err) => onError(assetError(err)),
  );
}

/* ------------------------------------------------------------ links --- */

/** Types a decrypted file may be opened as in a tab of this site: nothing that runs script. */
export const SAFE_TO_OPEN = /^(image\/(png|jpeg|gif|webp|avif|bmp|x-icon|vnd\.microsoft\.icon)|video\/[\w.+-]+|audio\/[\w.+-]+|application\/pdf|text\/plain)$/;
const SAFE_EXTENSION = /\.(png|jpe?g|gif|webp|avif|bmp|ico|pdf|mp4|webm|mov|m4v|ogv|mp3|m4a|wav|ogg|oga|flac|aac|txt)$/i;

function download(url: string, name: string) {
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/**
 * Opens a link to an upload (from a click): decrypted, in a new tab if it's a kind that can't run
 * anything, otherwise saved as a download.
 */
export function openAsset(href: string) {
  const ref = assetRef(href);
  if (!ref || ref.kind !== 'file') return;
  let path = href;
  try {
    path = decodeURIComponent(new URL(href, location.href).pathname);
  } catch {
    /* keep it */
  }
  // The tab opens now, while the click still counts as one; it's pointed at the file once decrypted.
  const tab = SAFE_EXTENSION.test(path) ? window.open('about:blank', '_blank') : null;
  if (tab) tab.opener = null;
  load(ref).then(
    (entry) => {
      if (SAFE_TO_OPEN.test(entry.mime) && tab) {
        tab.location.href = entry.url;
        return;
      }
      tab?.close();
      download(entry.url, entry.name);
    },
    (err) => {
      tab?.close();
      toast(assetError(err), { kind: 'error' });
    },
  );
}
