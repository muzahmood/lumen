/**
 * The service worker (public/sw.js) opening the app: run as written, in a sandbox standing in for the
 * browser's worker scope, with in-memory caches and a network the tests answer (or don't) themselves.
 * Covers a slow connection (the saved page after 3 s), offline, server errors, navigation preload,
 * and that the notes it keeps for offline reading still work.
 */
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';

const SOURCE = readFileSync(new URL('../../public/sw.js', import.meta.url), 'utf8');
const ORIGIN = 'https://lumen.test';
const SHELL = 'kb-v2-shell';
const STATIC = 'kb-v2-static';

class FakeCache {
  readonly entries = new Map<string, Response>();
  private keyOf(req: string | { url: string }) {
    const url = new URL(typeof req === 'string' ? req : req.url, ORIGIN);
    return url.pathname + url.search;
  }
  async match(req: string | { url: string }) {
    return this.entries.get(this.keyOf(req))?.clone();
  }
  async put(req: string | { url: string }, res: Response) {
    this.entries.set(this.keyOf(req), res);
  }
  async delete(req: string | { url: string }) {
    return this.entries.delete(this.keyOf(req));
  }
  async keys() {
    return [...this.entries.keys()].map((k) => new Request(ORIGIN + k));
  }
}

class FakeCaches {
  readonly stores = new Map<string, FakeCache>();
  async open(name: string) {
    if (!this.stores.has(name)) this.stores.set(name, new FakeCache());
    return this.stores.get(name)!;
  }
  async keys() {
    return [...this.stores.keys()];
  }
  async delete(name: string) {
    return this.stores.delete(name);
  }
}

/** What a same-origin answer looks like to a service worker (type "basic"). */
function page(body: string, status = 200, type = 'text/html; charset=utf-8') {
  const res = new Response(body, { status, headers: { 'content-type': type } });
  Object.defineProperty(res, 'type', { value: 'basic' });
  return res;
}

/** A network answer the test gives (or never gives) when it likes. */
function pending() {
  let resolve!: (res: Response) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<Response>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

type Listener = (event: Record<string, unknown>) => void;

function startWorker({ preloadSupported = true, buildAssets = null as string[] | null } = {}) {
  const listeners: Record<string, Listener> = {};
  const enable = vi.fn(async () => undefined);
  const caches = new FakeCaches();
  const fetch = vi.fn<(req: { url: string }) => Promise<Response>>(() => Promise.reject(new TypeError('Failed to fetch')));
  const self = {
    addEventListener: (type: string, fn: Listener) => void (listeners[type] = fn),
    skipWaiting: () => undefined,
    clients: { claim: async () => undefined },
    registration: { navigationPreload: preloadSupported ? { enable } : undefined },
    location: { origin: ORIGIN },
  };
  // The build writes this version's file list in (swAssetList in vite.config.ts); null in development.
  const source = buildAssets ? SOURCE.replace('const BUILD_ASSETS = null;', `const BUILD_ASSETS = ${JSON.stringify(buildAssets)};`) : SOURCE;
  if (buildAssets && source === SOURCE) throw new Error('BUILD_ASSETS placeholder not found in sw.js');
  vm.runInContext(
    source,
    vm.createContext({
      self,
      caches,
      fetch: (req: { url: string }) => fetch(req),
      Response,
      Headers,
      Request,
      URL,
      setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
      clearTimeout: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
      console,
    }),
  );

  /** A request from the browser; `preload` is the navigation preload answer, if the browser made one. */
  function request(path: string, opts: { mode?: string; preload?: Promise<Response | undefined>; headers?: Record<string, string> } = {}) {
    let response: Promise<Response> | null = null;
    const waits: Promise<unknown>[] = [];
    listeners.fetch({
      request: { url: ORIGIN + path, method: 'GET', mode: opts.mode ?? 'navigate', headers: new Headers(opts.headers) },
      preloadResponse: opts.preload ?? Promise.resolve(undefined),
      respondWith: (p: Promise<Response>) => void (response = Promise.resolve(p)),
      waitUntil: (p: Promise<unknown>) => void waits.push(p),
    });
    let answered = false;
    response?.then(
      () => (answered = true),
      () => (answered = true),
    );
    return { response, answered: () => answered, done: () => Promise.allSettled(waits) };
  }

  const savedPage = async () => (await (await caches.open(SHELL)).match('/index.html'))?.text();
  const savePage = async (html: string) => (await caches.open(SHELL)).put('/index.html', page(html));
  return { listeners, enable, caches, fetch, request, savedPage, savePage };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('opening the app', () => {
  it('opens the network’s page when it answers, and saves it for offline use', async () => {
    const sw = startWorker();
    sw.fetch.mockResolvedValue(page('<html>v2</html>'));
    const open = sw.request('/note/abc');
    expect(await (await open.response!).text()).toBe('<html>v2</html>');
    await open.done();
    expect(await sw.savedPage()).toBe('<html>v2</html>');
  });

  it('uses the page the browser asked for while the worker started (navigation preload), without asking again', async () => {
    const sw = startWorker();
    const open = sw.request('/', { preload: Promise.resolve(page('<html>preloaded</html>')) });
    expect(await (await open.response!).text()).toBe('<html>preloaded</html>');
    expect(sw.fetch).not.toHaveBeenCalled();
    await open.done();
    expect(await sw.savedPage()).toBe('<html>preloaded</html>');
  });

  it('opens the saved page when the network takes over 3 s, and saves the network’s when it comes', async () => {
    vi.useFakeTimers();
    const sw = startWorker();
    await sw.savePage('<html>saved</html>');
    const net = pending();
    sw.fetch.mockReturnValue(net.promise);
    const open = sw.request('/note/abc');

    await vi.advanceTimersByTimeAsync(2900);
    expect(open.answered()).toBe(false);
    await vi.advanceTimersByTimeAsync(200);
    expect(await (await open.response!).text()).toBe('<html>saved</html>');

    net.resolve(page('<html>v3</html>'));
    await open.done();
    expect(await sw.savedPage()).toBe('<html>v3</html>');
  });

  it('waits for the network however long it takes when nothing is saved yet', async () => {
    vi.useFakeTimers();
    const sw = startWorker();
    const net = pending();
    sw.fetch.mockReturnValue(net.promise);
    const open = sw.request('/');
    await vi.advanceTimersByTimeAsync(30_000);
    expect(open.answered()).toBe(false);
    net.resolve(page('<html>first</html>'));
    expect(await (await open.response!).text()).toBe('<html>first</html>');
  });

  it('opens the saved page at once offline (the preload fails too), and fails with nothing saved', async () => {
    const sw = startWorker();
    await sw.savePage('<html>saved</html>');
    const offline = Promise.reject(new TypeError('Failed to fetch'));
    offline.catch(() => undefined);
    const open = sw.request('/', { preload: offline });
    expect(await (await open.response!).text()).toBe('<html>saved</html>');
    expect(sw.fetch).toHaveBeenCalledTimes(1); // tried once more itself

    const empty = startWorker();
    await expect(empty.request('/').response).rejects.toThrow('Failed to fetch');
  });

  it('opens the saved page when the server fails, and keeps it', async () => {
    const sw = startWorker();
    await sw.savePage('<html>saved</html>');
    sw.fetch.mockResolvedValue(page('<html>Bad gateway</html>', 502));
    const open = sw.request('/');
    expect(await (await open.response!).text()).toBe('<html>saved</html>');
    await open.done();
    expect(await sw.savedPage()).toBe('<html>saved</html>');
  });

  it('passes a refusal through (Cloudflare Access asking to sign in), without saving it', async () => {
    const sw = startWorker();
    await sw.savePage('<html>saved</html>');
    sw.fetch.mockResolvedValue(page('<html>Sign in</html>', 403));
    const open = sw.request('/');
    const res = await open.response!;
    expect(res.status).toBe(403);
    await open.done();
    expect(await sw.savedPage()).toBe('<html>saved</html>');
  });

  it('doesn’t save an answer that isn’t a page as the app', async () => {
    const sw = startWorker();
    await sw.savePage('<html>saved</html>');
    sw.fetch.mockResolvedValue(page('{"error":"x"}', 200, 'application/json'));
    const open = sw.request('/');
    await open.response;
    await open.done();
    expect(await sw.savedPage()).toBe('<html>saved</html>');
  });
});

describe('navigation preload', () => {
  it('is turned on when the worker takes over', async () => {
    const sw = startWorker();
    const waits: Promise<unknown>[] = [];
    sw.listeners.activate({ waitUntil: (p: Promise<unknown>) => void waits.push(p) });
    await Promise.all(waits);
    expect(sw.enable).toHaveBeenCalledTimes(1);
  });

  it('isn’t needed: without it the worker still takes over, and fetches the page itself', async () => {
    const sw = startWorker({ preloadSupported: false });
    const waits: Promise<unknown>[] = [];
    sw.listeners.activate({ waitUntil: (p: Promise<unknown>) => void waits.push(p) });
    await expect(Promise.all(waits)).resolves.toBeDefined();
    sw.fetch.mockResolvedValue(page('<html>v2</html>'));
    expect(await (await sw.request('/').response!).text()).toBe('<html>v2</html>');
  });

  it('serves a file or API address opened in a tab, without a second request or saving it as the app', async () => {
    const sw = startWorker();
    const open = sw.request('/api/files/abc123', { preload: Promise.resolve(page('file bytes', 200, 'image/png')) });
    expect(await (await open.response!).text()).toBe('file bytes');
    expect(sw.fetch).not.toHaveBeenCalled();
    expect(await sw.savedPage()).toBeUndefined();

    sw.fetch.mockResolvedValue(page('fresh read', 200, 'application/json'));
    expect(await (await sw.request('/note/x?fresh=1').response!).text()).toBe('fresh read');
  });
});

describe('files kept for offline use', () => {
  it('answers a video player’s request for part of a saved file with just that part (Safari plays nothing otherwise)', async () => {
    const sw = startWorker();
    const bytes = new Uint8Array(50).map((_, i) => i);
    const res = new Response(bytes, { status: 200, headers: { 'content-type': 'video/mp4', etag: '"f1"' } });
    Object.defineProperty(res, 'type', { value: 'basic' });
    sw.fetch.mockResolvedValue(res);
    const first = sw.request('/api/files/f1/clip.mp4', { mode: 'no-cors' });
    expect((await (await first.response!).arrayBuffer()).byteLength).toBe(50);
    await first.done();
    sw.fetch.mockRejectedValue(new TypeError('Failed to fetch'));

    const part = async (range: string) => sw.request('/api/files/f1/clip.mp4', { mode: 'no-cors', headers: { range } }).response!;
    for (const [range, start, end] of [
      ['bytes=10-19', 10, 19],
      ['bytes=45-', 45, 49],
      ['bytes=-5', 45, 49],
      ['bytes=40-999', 40, 49],
    ] as const) {
      const r = await part(range);
      expect(r.status, range).toBe(206);
      expect(r.headers.get('content-range'), range).toBe(`bytes ${start}-${end}/50`);
      expect(r.headers.get('content-length'), range).toBe(String(end - start + 1));
      expect(r.headers.get('content-type')).toBe('video/mp4');
      expect(r.headers.get('x-kb-size')).toBeNull();
      expect([...new Uint8Array(await r.arrayBuffer())], range).toEqual([...bytes.slice(start, end + 1)]);
    }
    for (const range of ['bytes=50-', 'bytes=-0']) {
      const r = await part(range);
      expect(r.status, range).toBe(416);
      expect(r.headers.get('content-range')).toBe('bytes */50');
    }
    for (const range of ['bytes=0-1,4-5', 'bytes=9-3', 'pages=1']) {
      const r = await part(range);
      expect(r.status, range).toBe(200);
      expect((await r.arrayBuffer()).byteLength, range).toBe(50);
    }
    // Only the first, whole fetch went to the network.
    expect(sw.fetch).toHaveBeenCalledTimes(1);
  });
});

describe('notes kept for offline reading (unchanged)', () => {
  it('reads a note opened before from the saved copy offline, marked as such', async () => {
    const sw = startWorker();
    sw.fetch.mockResolvedValue(page('{"id":"n1"}', 200, 'application/json'));
    const first = sw.request('/api/notes/n1', { mode: 'cors' });
    expect(await (await first.response!).text()).toBe('{"id":"n1"}');
    await new Promise((r) => setTimeout(r, 0));

    sw.fetch.mockRejectedValue(new TypeError('Failed to fetch'));
    const res = await sw.request('/api/notes/n1', { mode: 'cors' }).response!;
    expect(await res.text()).toBe('{"id":"n1"}');
    expect(res.headers.get('x-kb-offline')).toBe('1');
  });
});

describe('notes just saved', () => {
  const DATA = 'kb-v2-data';
  const meta = (id: string, version: number, extra: Record<string, unknown> = {}) => ({ id, title: `T${version}`, version, ...extra });

  /** The app telling the worker about a save; resolves once the worker is done with it. */
  async function saved(sw: ReturnType<typeof startWorker>, msg: Record<string, unknown>) {
    const waits: Promise<unknown>[] = [];
    sw.listeners.message({ data: { type: 'note-saved', ...msg }, waitUntil: (p: Promise<unknown>) => void waits.push(p) });
    await Promise.all(waits);
  }
  const kept = async (sw: ReturnType<typeof startWorker>, path: string) => {
    const res = await (await sw.caches.open(DATA)).match(path);
    return res ? res.json() : undefined;
  };
  const keep = async (sw: ReturnType<typeof startWorker>, path: string, body: unknown) =>
    (await sw.caches.open(DATA)).put(path, page(JSON.stringify(body), 200, 'application/json'));

  it('brings the offline copy of the note and of the note list up to date at once, new notes included', async () => {
    vi.useFakeTimers();
    const sw = startWorker();
    await keep(sw, '/api/notes/n1', { ...meta('n1', 3), content: 'old text' });
    await keep(sw, '/api/bootstrap', { notes: [meta('n1', 3), meta('n2', 1)], folders: [] });
    const done = Promise.all([
      saved(sw, { meta: meta('n1', 4), content: 'new text', base: 3 }),
      saved(sw, { meta: meta('n9', 1), content: 'made offline-ready' }),
    ]);
    await vi.advanceTimersByTimeAsync(2000);
    await done;
    expect(await kept(sw, '/api/notes/n1')).toEqual({ ...meta('n1', 4), content: 'new text' });
    expect(await kept(sw, '/api/notes/n9')).toEqual({ ...meta('n9', 1), content: 'made offline-ready' });
    expect((await kept(sw, '/api/bootstrap')).notes).toEqual([meta('n1', 4), meta('n2', 1), meta('n9', 1)]);
  });

  it('keeps the text for a save that didn’t change it, and never goes back to an older version', async () => {
    vi.useFakeTimers();
    const sw = startWorker();
    await keep(sw, '/api/notes/n1', { ...meta('n1', 5), content: 'the text' });
    await keep(sw, '/api/bootstrap', { notes: [meta('n1', 5)], folders: [] });
    // Tags or a pin: the same version; a title on top of the text kept here: the next one.
    let done = saved(sw, { meta: meta('n1', 5, { tags: ['work'] }) });
    await vi.advanceTimersByTimeAsync(2000);
    await done;
    expect(await kept(sw, '/api/notes/n1')).toEqual({ ...meta('n1', 5, { tags: ['work'] }), content: 'the text' });
    done = saved(sw, { meta: meta('n1', 6, { title: 'Renamed' }), base: 5 });
    await vi.advanceTimersByTimeAsync(2000);
    await done;
    expect(await kept(sw, '/api/notes/n1')).toMatchObject({ version: 6, title: 'Renamed', content: 'the text' });
    // A slower save answered last: nothing goes back.
    done = saved(sw, { meta: meta('n1', 4), content: 'older' });
    await vi.advanceTimersByTimeAsync(2000);
    await done;
    expect(await kept(sw, '/api/notes/n1')).toMatchObject({ version: 6, content: 'the text' });
    expect((await kept(sw, '/api/bootstrap')).notes[0]).toMatchObject({ version: 6 });
  });

  it('drops a kept text it can’t bring up to date (saved elsewhere since), so it’s read afresh, not shown stale', async () => {
    vi.useFakeTimers();
    const sw = startWorker();
    await keep(sw, '/api/notes/n1', { ...meta('n1', 2), content: 'two versions ago' });
    const done = saved(sw, { meta: meta('n1', 5, { title: 'Renamed' }), base: 4 });
    await vi.advanceTimersByTimeAsync(2000);
    await done;
    expect(await kept(sw, '/api/notes/n1')).toBeUndefined();
  });

  it('ignores anything that isn’t a save it understands', async () => {
    const sw = startWorker();
    for (const data of [null, 'note-saved', { type: 'other' }, { type: 'note-saved', meta: { id: 7 } }, { type: 'note-saved', meta: { id: 'n1' } }]) {
      expect(() => sw.listeners.message({ data, waitUntil: () => undefined })).not.toThrow();
    }
    expect((await sw.caches.open(DATA)).entries.size).toBe(0);
  });
});

describe('files from earlier versions', () => {
  const OLD = ['/assets/index-OLD11111.js', '/excalidraw-assets/fonts/Excalifont/Excalifont-Regular-0ld0ld0ld0ld.woff2'];
  const NEW = ['/assets/index-NEW22222.js', '/excalidraw-assets/fonts/Excalifont/Excalifont-Regular-4e44e44e44e4.woff2'];
  const app = (script: string) => `<html><script type="module" src="${script}"></script></html>`;

  async function activate(sw: ReturnType<typeof startWorker>) {
    const waits: Promise<unknown>[] = [];
    sw.listeners.activate({ waitUntil: (p: Promise<unknown>) => void waits.push(p) });
    await Promise.all(waits);
  }
  async function cached(sw: ReturnType<typeof startWorker>) {
    return [...(await sw.caches.open(STATIC)).entries.keys()].sort();
  }

  it('go once the saved app page is this version’s, Excalidraw’s fonts included', async () => {
    const sw = startWorker({ buildAssets: NEW });
    const files = await sw.caches.open(STATIC);
    for (const path of [...OLD, ...NEW]) await files.put(path, page('bytes', 200, 'application/octet-stream'));
    await sw.savePage(app(NEW[0]));
    await activate(sw);
    expect(await cached(sw)).toEqual([...NEW].sort());
  });

  it('stay while the saved app page is still an older version’s (it needs them offline)', async () => {
    const sw = startWorker({ buildAssets: NEW });
    const files = await sw.caches.open(STATIC);
    for (const path of [...OLD, ...NEW]) await files.put(path, page('bytes', 200, 'application/octet-stream'));
    await sw.savePage(app(OLD[0]));
    await activate(sw);
    expect(await cached(sw)).toEqual([...OLD, ...NEW].sort());

    // Opening the app brings this version's page, and with it the clean-up.
    sw.fetch.mockResolvedValue(page(app(NEW[0])));
    const open = sw.request('/');
    await open.response;
    await open.done();
    expect(await cached(sw)).toEqual([...NEW].sort());
  });
});
