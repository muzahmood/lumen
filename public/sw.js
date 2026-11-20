/*
 * Offline support.
 * - The app shell (HTML) is network-first, falling back to the last copy when offline, when the
 *   network takes over 3 s, or on a server error (see openApp). Only real app pages are kept:
 *   never API responses or files opened in a tab.
 * - Built assets (/assets/*, hashed names), drawing fonts and uploaded files are cache-first.
 *   Opened files are kept up to a limit (see FILES_MAX_BYTES), dropping those opened longest ago.
 * - Notes and the note list are network-first, so previously opened notes
 *   can still be read without a connection. Copies of notes deleted for good are dropped.
 * Writes are never cached; the app keeps unsent edits in localStorage.
 * "Sign out" in Settings → Security deletes every cache this file creates.
 */
const VERSION = 'kb-v2';
const SHELL = `${VERSION}-shell`;
const STATIC = `${VERSION}-static`;
const DATA = `${VERSION}-data`;
const FILES = `${VERSION}-files`;

// Every file under /assets/ and /excalidraw-assets/ in this version of the app, written in by the
// build (see swAssetList in vite.config.ts). It also makes this file change with every deploy, so the
// browser installs the new worker, which can then drop the previous versions' files. Stays null in
// development.
const BUILD_ASSETS = null;

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      // Shares waiting to be saved outlive an update (see SHARE below); sign-out still clears them.
      await Promise.all(keys.filter((k) => !k.startsWith(VERSION) && k !== SHARE).map((k) => caches.delete(k)));
      await pruneStatic();
      // The browser asks for the app page while this worker starts up, rather than after (see openApp).
      try {
        await self.registration.navigationPreload?.enable();
      } catch {
        /* not supported here: openApp fetches the page itself */
      }
      await self.clients.claim();
    })(),
  );
});

/** The /assets/ files the saved copy of the app page loads directly (its scripts, preloads and styles). */
async function shellAssets() {
  const shell = await (await caches.open(SHELL)).match('/index.html');
  if (!shell) return null;
  const html = await shell.text();
  return [...html.matchAll(/(?:src|href)="(\/assets\/[^"?#]+)"/g)].map((m) => m[1]);
}

/**
 * Hashed build files from earlier deploys are never asked for again; without this they pile up on
 * the device. Only runs once the saved app page is this version's: while it's still an older one
 * (this worker can arrive without a page load), offline launches need that version's files.
 */
async function pruneStatic() {
  if (!Array.isArray(BUILD_ASSETS)) return;
  const keep = new Set(BUILD_ASSETS);
  const shell = await shellAssets();
  if (!shell || !shell.length || !shell.every((path) => keep.has(path))) return;
  const cache = await caches.open(STATIC);
  const requests = await cache.keys();
  await Promise.all(
    requests.map((req) => {
      const path = new URL(req.url).pathname;
      return (path.startsWith('/assets/') || path.startsWith('/excalidraw-assets/')) && !keep.has(path) ? cache.delete(req) : undefined;
    }),
  );
}

const cacheable = (res) => res && res.ok && res.type === 'basic' && !res.redirected;
const isHtml = (res) => (res.headers.get('content-type') || '').includes('text/html');

async function networkFirst(request, cacheName, { onFresh } = {}) {
  const cache = await caches.open(cacheName);
  try {
    const res = await fetch(request);
    if (cacheable(res)) {
      cache.put(request, res.clone());
      if (onFresh) onFresh(res.clone());
    }
    return res;
  } catch (err) {
    const hit = await cache.match(request);
    if (!hit) throw err;
    // Tell the app this came from the offline copy, not the server.
    const headers = new Headers(hit.headers);
    headers.set('x-kb-offline', '1');
    return new Response(hit.body, { status: hit.status, statusText: hit.statusText, headers });
  }
}

/**
 * How long opening the app waits for the network before using the saved copy of the app page. A
 * connection that's there but barely works (a train, one bar of signal) would otherwise leave the app
 * blank for as long as the browser keeps trying, often a minute or more. The network's page, when it
 * does come, is still saved for next time.
 */
const SHELL_TIMEOUT_MS = 3000;

/** A navigation's page: the request the browser started while this worker woke up (navigation preload), else a fetch now. */
const preloadedOrFetch = (event) =>
  Promise.resolve(event.preloadResponse).then(
    (res) => res || fetch(event.request),
    () => fetch(event.request),
  );

/**
 * Opening the app: the network's page (saved for offline use), or the saved one when there's no
 * network, when the network takes longer than SHELL_TIMEOUT_MS, or when the server fails (5xx). With
 * nothing saved yet, it waits for the network however long that takes.
 */
function openApp(event) {
  const fresh = preloadedOrFetch(event).then(async (res) => {
    // Saved before answering (the page is small), so the prune afterwards sees the new copy.
    if (cacheable(res) && isHtml(res)) await (await caches.open(SHELL)).put('/index.html', res.clone());
    return res;
  });
  // A fresh copy of this version's app page means the older versions' files can go now.
  event.waitUntil(fresh.then(pruneStatic).catch(() => undefined));
  const saved = () => caches.open(SHELL).then((cache) => cache.match('/index.html'));
  return new Promise((resolve, reject) => {
    let answered = false;
    const answer = (res) => {
      if (answered) return;
      answered = true;
      clearTimeout(timer);
      resolve(res);
    };
    const timer = setTimeout(() => {
      saved().then((copy) => copy && answer(copy), () => undefined);
    }, SHELL_TIMEOUT_MS);
    fresh.then(
      async (res) => {
        if (res.status >= 500) {
          const copy = await saved().catch(() => undefined);
          if (copy) return answer(copy);
        }
        answer(res);
      },
      async (err) => {
        const copy = await saved().catch(() => undefined);
        if (copy) return answer(copy);
        if (!answered) {
          answered = true;
          clearTimeout(timer);
          reject(err);
        }
      },
    );
  });
}

async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(request);
  if (hit) return hit;
  const res = await fetch(request);
  // An HTML answer here is the app's "not found" page or a sign-in page, never the file asked for.
  if (cacheable(res) && !isHtml(res)) cache.put(request, res.clone());
  return res;
}

/*
 * Opened files (images, video, attachments) are kept for offline use, but not without limit: a
 * browser short of space may clear the whole site, unsent drafts included. Past these, the files
 * opened longest ago go first. Each kept copy records its size; an index entry in the same cache
 * records when each was last opened.
 */
const FILES_MAX_BYTES = 200 * 1024 * 1024;
const FILES_MAX_COUNT = 400;
const FILES_INDEX = '/__kb/files-index';

let filesIndex = null;
let indexWrite = null;
let trimming = Promise.resolve();

async function readIndex(cache) {
  if (!filesIndex) {
    try {
      const hit = await cache.match(FILES_INDEX);
      filesIndex = hit ? await hit.json() : {};
    } catch {
      filesIndex = {};
    }
  }
  return filesIndex;
}

function saveIndexSoon(cache) {
  clearTimeout(indexWrite);
  indexWrite = setTimeout(() => {
    cache.put(FILES_INDEX, new Response(JSON.stringify(filesIndex || {}), { headers: { 'Content-Type': 'application/json' } })).catch(() => {});
  }, 2000);
}

async function trimFiles(cache) {
  const index = await readIndex(cache);
  const entries = [];
  const keys = await cache.keys();
  for (let i = 0; i < keys.length; i++) {
    const req = keys[i];
    if (new URL(req.url).pathname === FILES_INDEX) continue;
    const res = await cache.match(req);
    const size = Number(res && (res.headers.get('x-kb-size') || res.headers.get('content-length'))) || 0;
    // Copies kept before the index existed count as the oldest, in the order they were kept.
    entries.push({ req, size, at: index[req.url] || i });
  }
  let bytes = entries.reduce((sum, e) => sum + e.size, 0);
  let count = entries.length;
  if (bytes <= FILES_MAX_BYTES && count <= FILES_MAX_COUNT) return;
  entries.sort((a, b) => a.at - b.at);
  for (const e of entries) {
    if (bytes <= FILES_MAX_BYTES && count <= FILES_MAX_COUNT) break;
    await cache.delete(e.req);
    delete index[e.req.url];
    bytes -= e.size;
    count--;
  }
  saveIndexSoon(cache);
}

async function cacheFile(event) {
  const { request } = event;
  const cache = await caches.open(FILES);
  const hit = await cache.match(request);
  const index = await readIndex(cache);
  index[request.url] = Date.now();
  if (hit) {
    saveIndexSoon(cache);
    const range = request.headers.get('range');
    return range ? partOf(hit, range) : hit;
  }
  const res = await fetch(request);
  // Whole files only (not the ranges a video player asks for), and never an HTML page in a file's place.
  if (res.status === 200 && cacheable(res) && !isHtml(res)) {
    const copy = res.clone();
    event.waitUntil(
      (async () => {
        const blob = await copy.blob();
        const headers = new Headers(copy.headers);
        headers.set('x-kb-size', String(blob.size));
        await cache.put(request, new Response(blob, { status: 200, statusText: copy.statusText, headers }));
        saveIndexSoon(cache);
        trimming = trimming.then(() => trimFiles(cache)).catch(() => {});
        await trimming;
      })().catch(() => {}),
    );
  }
  return res;
}

/**
 * The part of a saved file a video or audio player asks for ("bytes=0-1023", "bytes=500-",
 * "bytes=-500"): Safari on iPhones and iPads won't play from a whole file sent in reply. A header
 * asking for several parts, or not understood, gets the whole file (as RFC 9110 allows).
 */
async function partOf(res, header) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (!m[1] && !m[2])) return res;
  const blob = await res.blob();
  const size = blob.size;
  let start;
  let end;
  if (!m[1]) {
    start = Math.max(0, size - Number(m[2]));
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
    if (m[2] && Number(m[2]) < start) return new Response(blob, { status: 200, headers: res.headers });
  }
  const headers = new Headers(res.headers);
  headers.delete('x-kb-size');
  headers.set('Accept-Ranges', 'bytes');
  if (size === 0 || start >= size || (!m[1] && Number(m[2]) === 0)) {
    headers.set('Content-Range', `bytes */${size}`);
    headers.delete('Content-Length');
    return new Response(null, { status: 416, headers });
  }
  headers.set('Content-Range', `bytes ${start}-${end}/${size}`);
  headers.set('Content-Length', String(end - start + 1));
  return new Response(blob.slice(start, end + 1), { status: 206, statusText: 'Partial Content', headers });
}

/**
 * A fresh note list (from the network) lists every note that still exists, trashed ones included.
 * Offline copies of any other note were deleted for good, here or on another device: they go.
 */
async function dropDeletedNotes(res) {
  const data = await res.json();
  if (!data || !Array.isArray(data.notes)) return;
  const ids = new Set(data.notes.map((n) => n.id));
  const cache = await caches.open(DATA);
  for (const req of await cache.keys()) {
    const m = /^\/api\/notes\/([^/]+)$/.exec(new URL(req.url).pathname);
    if (m && !ids.has(decodeURIComponent(m[1]))) await cache.delete(req);
  }
}

const ROOT_FILES = new Set(['/theme-init.js', '/manifest.webmanifest', '/icon.svg', '/icon-192.png', '/icon-512.png']);

/*
 * Sharing into Lumen from another app (the manifest's share_target): the shared text, link and files
 * are kept here, on the device, and the app is opened to ask whether to make a note of them
 * (src/lib/launch.ts; any website can send a form here too, so nothing is saved without asking). They
 * never go to the server as they are: the app encrypts them like anything else it saves. Not named by
 * version, so an update doesn't lose a share still waiting.
 */
const SHARE = 'kb-share';

async function receiveShare(request) {
  const home = (query) => Response.redirect(new URL(`/?share=${query}`, self.location.origin).href, 303);
  try {
    const form = await request.formData();
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    const files = form.getAll('files').filter((f) => f && typeof f === 'object' && f.size > 0);
    const meta = {
      title: String(form.get('title') || ''),
      text: String(form.get('text') || ''),
      url: String(form.get('url') || ''),
      files: files.map((f, i) => ({ name: f.name || `shared-${i + 1}`, type: f.type || 'application/octet-stream' })),
    };
    const cache = await caches.open(SHARE);
    await Promise.all(files.map((f, i) => cache.put(`/__kb/share/${id}/${i}`, new Response(f, { headers: { 'Content-Type': meta.files[i].type } }))));
    await cache.put(`/__kb/share/${id}/meta`, new Response(JSON.stringify(meta), { headers: { 'Content-Type': 'application/json' } }));
    return home(id);
  } catch {
    return home('failed');
  }
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method === 'POST' && new URL(request.url).pathname === '/share' && new URL(request.url).origin === self.location.origin) {
    event.respondWith(receiveShare(request));
    return;
  }
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  const path = url.pathname;

  if (request.mode === 'navigate') {
    // Opening a file or API address in a tab (or a one-off ?fresh read) goes straight to the network,
    // with the request the browser already started; left alone, it would ask a second time.
    if (path.startsWith('/api/') || path.startsWith('/cdn-cgi/') || url.searchParams.has('fresh')) {
      event.respondWith(preloadedOrFetch(event));
      return;
    }
    event.respondWith(openApp(event));
    return;
  }
  // A one-off read straight from the server (?fresh=…): past any copy kept here, and not kept itself.
  if (url.searchParams.has('fresh')) return;
  if (path.startsWith('/assets/') || path.startsWith('/excalidraw-assets/')) {
    event.respondWith(cacheFirst(request, STATIC));
    return;
  }
  if (ROOT_FILES.has(path)) {
    event.respondWith(networkFirst(request, STATIC));
    return;
  }
  if (path.startsWith('/api/files/')) {
    event.respondWith(cacheFile(event));
    return;
  }
  if (path === '/api/bootstrap') {
    event.respondWith(
      networkFirst(request, DATA, { onFresh: (copy) => event.waitUntil(dropDeletedNotes(copy).catch(() => {})) }),
    );
    return;
  }
  if (/^\/api\/notes\/[^/]+$/.test(path) || /^\/api\/drawings\/[^/]+(\.svg|\/scene)$/.test(path)) {
    event.respondWith(networkFirst(request, DATA));
  }
});

/*
 * A note the app has just saved, as the server now has it (its entry in the note list, and its text
 * when the save changed that): the offline copies are brought up to date at once, not when the note is
 * next read. Otherwise a phone that locks right after saving reopens offline on the text and the note
 * list from before, without notes made since, and edits made there meet its own save as a conflict.
 * Never made older than what's kept: a slower save that's answered last changes nothing.
 */
const noteUrl = (id) => new URL(`/api/notes/${encodeURIComponent(id)}`, self.location.origin).href;
const LIST_URL = new URL('/api/bootstrap', self.location.origin).href;
const asJson = (body, headers) => new Response(JSON.stringify(body), { headers: headers ?? { 'Content-Type': 'application/json; charset=utf-8' } });

async function saveNoteCopy(meta, content, base) {
  const cache = await caches.open(DATA);
  const url = noteUrl(meta.id);
  const kept = await cache.match(url);
  const old = kept ? await kept.json().catch(() => null) : null;
  if (old && typeof old.version === 'number' && old.version > meta.version) return;
  if (typeof content === 'string') await cache.put(url, asJson({ ...meta, content }));
  // A save that didn't change the text (tags, a pin, a move; or the title, on top of the text kept here).
  else if (old && typeof old.content === 'string' && (old.version === meta.version || old.version === base)) {
    await cache.put(url, asJson({ ...old, ...meta, content: old.content }));
  }
  // Its text here is from before a save this worker never saw: read afresh next time rather than shown.
  else if (old) await cache.delete(url);
}

/** Saves waiting to go into the kept note list (one rewrite of the list for a burst of them). */
const listUpdates = new Map();
let listWrite = null;

async function saveListCopy() {
  listWrite = null;
  const updates = [...listUpdates.values()];
  listUpdates.clear();
  const cache = await caches.open(DATA);
  const kept = await cache.match(LIST_URL);
  if (!kept) return;
  const list = await kept.json().catch(() => null);
  if (!list || !Array.isArray(list.notes)) return;
  const at = new Map(list.notes.map((n, i) => [n && n.id, i]));
  for (const meta of updates) {
    const i = at.get(meta.id);
    if (i === undefined) list.notes.push(meta);
    else if (!(list.notes[i].version > meta.version)) list.notes[i] = meta;
  }
  await cache.put(LIST_URL, asJson(list, new Headers(kept.headers)));
}

/** One note copy written at a time, in the order the saves were answered. */
let noteWrites = Promise.resolve();

self.addEventListener('message', (event) => {
  const msg = event.data;
  if (!msg || msg.type !== 'note-saved' || !msg.meta || typeof msg.meta.id !== 'string' || typeof msg.meta.version !== 'number') return;
  const { meta, content, base } = msg;
  noteWrites = noteWrites.then(() => saveNoteCopy(meta, content, base)).catch(() => undefined);
  const waiting = listUpdates.get(meta.id);
  if (!waiting || waiting.version <= meta.version) listUpdates.set(meta.id, meta);
  // Saves come every pause in typing, and the list can be large: written once, a moment after the first.
  listWrite ??= new Promise((resolve) => setTimeout(resolve, 1500)).then(saveListCopy).catch(() => undefined);
  if (event.waitUntil) event.waitUntil(Promise.all([noteWrites, listWrite]));
});
