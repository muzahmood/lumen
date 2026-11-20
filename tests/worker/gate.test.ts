/**
 * The front door (worker/gate.ts, worker/auth.ts): nothing is served unless Cloudflare Access signed
 * the visitor in, plus the cross-site write guard and the security headers on every response.
 */
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import worker from '../../worker/index';
import { accessToken, AUD, call, fetchPath, get, LOCAL, OWNER, post, PUBLIC, read, TEAM } from './helpers';

const withToken = (token: string) => ({ origin: PUBLIC, headers: { 'cf-access-jwt-assertion': token } });

/** Calls the Worker directly with changed settings (the test config can't vary per test). */
async function withEnv(overrides: Partial<Cloudflare.Env>, url: string, init: RequestInit = {}) {
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(url, init), { ...env, ...overrides }, ctx);
  await waitOnExecutionContext(ctx);
  return read(res);
}

describe('Cloudflare Access check', () => {
  it('lets localhost through only in local development', async () => {
    expect((await get('/me')).body).toMatchObject({ via: 'local', verified: false });
    const off = await withEnv({ LOCAL_DEV: undefined }, `${LOCAL}/api/me`);
    expect(off.status).toBe(403);
    expect(off.body.error).toBe('access_required');
  });

  it('never applies LOCAL_DEV to a public hostname', async () => {
    const res = await get('/me', { origin: PUBLIC });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('access_required');
  });

  it('serves nothing until Access is configured, not even the app shell', async () => {
    for (const overrides of [{ ACCESS_AUD: '' }, { ACCESS_TEAM_DOMAIN: 'https://evil.example.com' }]) {
      const api = await withEnv(overrides, `${PUBLIC}/api/bootstrap`);
      expect(api.status).toBe(503);
      expect(api.body.error).toBe('access_not_configured');
      const page = await withEnv(overrides, `${PUBLIC}/`);
      expect(page.status).toBe(503);
      expect(page.headers.get('content-type')).toContain('text/html');
      expect(page.body).toContain('isn’t connected to Cloudflare Access');
    }
  });

  it('shows setup values from an unverified token without echoing anything unsafe', async () => {
    const token = await accessToken({ iss: 'https://<script>alert(1)</script>.cloudflareaccess.com', aud: ['<img src=x>', 'b'.repeat(64)] });
    const page = await withEnv({ ACCESS_AUD: '' }, `${PUBLIC}/`, { headers: { 'cf-access-jwt-assertion': token } });
    expect(page.body).not.toContain('<script>alert');
    expect(page.body).not.toContain('<img src=x>');
    const good = await accessToken();
    const ok = await withEnv({ ACCESS_AUD: '' }, `${PUBLIC}/`, { headers: { 'cf-access-jwt-assertion': good } });
    expect(ok.body).toContain(TEAM);
    expect(ok.body).toContain(AUD);
    // The signed-in account is suggested for the allow list.
    expect(ok.body).toContain('ACCESS_ALLOWED_EMAILS');
    expect(ok.body).toContain(OWNER);
    const sneaky = await accessToken({ email: '"><img src=x>@example.com' });
    const page2 = await withEnv({ ACCESS_AUD: '' }, `${PUBLIC}/`, { headers: { 'cf-access-jwt-assertion': sneaky } });
    expect(page2.body).not.toContain('<img src=x>');
    expect(page2.body).not.toContain('ACCESS_ALLOWED_EMAILS');
  });

  it('names the Worker in the setup steps when it is on its workers.dev address', async () => {
    const page = await withEnv({ ACCESS_AUD: '' }, 'https://my-notes.someone.workers.dev/');
    expect(page.status).toBe(503);
    expect(page.body).toContain('Workers &amp; Pages</a> → <b>my-notes</b>');
    const elsewhere = await withEnv({ ACCESS_AUD: '' }, `${PUBLIC}/`);
    expect(elsewhere.body).toContain('your Lumen Worker');
    // A preview or nested address (or anything unexpected) isn't taken for a Worker name.
    for (const host of ['a.b.someone.workers.dev', 'someone.workers.dev', 'my-notes.someone.workers.dev.evil.test']) {
      expect((await withEnv({ ACCESS_AUD: '' }, `https://${host}/`)).body).toContain('your Lumen Worker');
    }
  });

  it('accepts a valid token from the header or the CF_Authorization cookie', async () => {
    const token = await accessToken();
    const viaHeader = await get('/me', withToken(token));
    expect(viaHeader.status).toBe(200);
    expect(viaHeader.body).toMatchObject({ email: OWNER, verified: true, via: 'access' });
    const viaCookie = await get('/me', { origin: PUBLIC, headers: { cookie: `other=1; CF_Authorization=${token}` } });
    expect(viaCookie.status).toBe(200);
  });

  it('matches the allow list without regard to case', async () => {
    const res = await get('/me', withToken(await accessToken({ email: OWNER.toUpperCase() })));
    expect(res.status).toBe(200);
  });

  const rejected: Array<[string, () => Promise<string>, number, string]> = [
    ['another audience', () => accessToken({ aud: ['c'.repeat(64)] }), 401, 'unauthorized'],
    ['another team', () => accessToken({ iss: 'https://other.cloudflareaccess.com' }), 401, 'unauthorized'],
    ['an expired token', () => accessToken({ exp: Math.floor(Date.now() / 1000) - 120 }), 401, 'unauthorized'],
    ['a token not valid yet', () => accessToken({ nbf: Math.floor(Date.now() / 1000) + 600 }), 401, 'unauthorized'],
    ['a token without exp', () => accessToken({ exp: undefined }), 401, 'unauthorized'],
    ['an unknown key id', () => accessToken({}, { kid: 'nope' }), 401, 'unauthorized'],
    ['alg none', () => accessToken({}, { alg: 'none' }), 401, 'unauthorized'],
    ['HS256', () => accessToken({}, { alg: 'HS256' }), 401, 'unauthorized'],
    ['a garbled token', async () => 'not.a.token', 401, 'unauthorized'],
    ['an account off the allow list', () => accessToken({ email: 'someone@example.com' }), 403, 'not_allowed'],
    ['a token without an email', () => accessToken({ email: undefined }), 403, 'not_allowed'],
  ];
  for (const [name, make, status, code] of rejected) {
    it(`refuses ${name}`, async () => {
      const res = await get('/bootstrap', withToken(await make()));
      expect(res.status).toBe(status);
      expect(res.body.error).toBe(code);
    });
  }

  it('refuses a token whose payload was changed after signing', async () => {
    const [head, , sig] = (await accessToken()).split('.');
    const forged = btoa(JSON.stringify({ aud: [AUD], iss: TEAM, email: OWNER, exp: 9999999999 })).replace(/=+$/, '');
    const res = await get('/bootstrap', withToken(`${head}.${forged}.${sig}`));
    expect(res.status).toBe(401);
  });

  it('refuses the app shell and its files to visitors without a token', async () => {
    for (const path of ['/', '/note/abc123', '/assets/index.js', '/sw.js', '/manifest.webmanifest']) {
      const res = await fetchPath(path, {}, PUBLIC);
      expect(res.status, path).toBe(403);
      expect(res.headers.get('content-type')).toContain('text/html');
      expect(res.headers.get('cache-control')).toBe('no-store');
      await res.body?.cancel();
    }
  });
});

describe('cross-site write guard', () => {
  it('refuses writes without the client header, even when signed in', async () => {
    for (const method of ['POST', 'PATCH', 'PUT', 'DELETE']) {
      const res = await call(method, '/notes', { title: 'x' }, { noClientHeader: true });
      expect(res.status, method).toBe(403);
    }
    const signedIn = await call('POST', '/notes', { title: 'x' }, { ...withToken(await accessToken()), noClientHeader: true });
    expect(signedIn.status).toBe(403);
  });

  it('never grants a CORS preflight', async () => {
    const res = await fetchPath('/api/notes', {
      method: 'OPTIONS',
      headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST', 'access-control-request-headers': 'x-kb-client' },
    });
    expect(res.status).toBe(403);
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
    expect(res.headers.get('access-control-allow-headers')).toBeNull();
    await res.body?.cancel();
  });
});

describe('response headers', () => {
  const common = {
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'no-referrer',
    'cross-origin-opener-policy': 'same-origin',
    'cross-origin-resource-policy': 'same-origin',
  };

  it('puts the security headers on API replies, and keeps note data out of caches', async () => {
    const res = await get('/bootstrap');
    expect(Object.fromEntries(Object.keys(common).map((k) => [k, res.headers.get(k)]))).toEqual(common);
    expect(res.headers.get('strict-transport-security')).toMatch(/max-age=\d+/);
    expect(res.headers.get('cache-control')).toBe('private, no-store');
  });

  it('puts them on errors and refusals too', async () => {
    for (const res of [await get('/notes/missing-note-id'), await get('/nope'), await get('/me', { origin: PUBLIC })]) {
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
      expect(res.headers.get('x-frame-options')).toBe('DENY');
    }
    const page = await fetchPath('/', {}, PUBLIC);
    expect(page.headers.get('content-security-policy')).toContain("default-src 'none'");
    await page.body?.cancel();
  });

  it('answers unknown API paths with JSON, never the app shell', async () => {
    const res = await get('/does/not/exist');
    expect(res.status).toBe(404);
    // Not 'not_found': the app reads that as a note deleted on another device.
    expect(res.body.error).toBe('no_route');
  });

  it('sends something shared before the app is set up on a device back to the app, unread', async () => {
    const form = new FormData();
    form.set('text', 'A thought');
    const res = await fetchPath('/share', { method: 'POST', body: form, redirect: 'manual' });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/?share=unavailable');
    // Still behind the gate, like everything else.
    const outside = await fetchPath('/share', { method: 'POST', body: form, redirect: 'manual' }, PUBLIC);
    expect(outside.status).not.toBe(303);
  });

  it('clears the browser cache for the site on sign-out', async () => {
    const res = await post('/signout');
    expect(res.status).toBe(200);
    expect(res.headers.get('clear-site-data')).toBe('"cache"');
  });

  it('does not leak server error details', async () => {
    const res = await post('/notes', '{not json', { headers: { 'content-type': 'application/json' } });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'bad_json', message: expect.any(String) });
  });
});
