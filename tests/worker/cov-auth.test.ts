/**
 * The Access check's edges (worker/auth.ts, worker/gate.ts) beyond gate.test.ts: how the settings
 * are read, tokens in every shape Access sends them, the certificate fetch failing, and how often an
 * unknown signing key makes the Worker fetch the team's keys again.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { withEnv } from './api-helpers';
import { accessToken, AUD, get, OWNER, PUBLIC, TEAM } from './helpers';
import { normalizeTeamDomain, parseList, readAccessToken, unverifiedSetupHint, verifyAccessJwt } from '../../worker/auth';

const withToken = (token: string) => ({ origin: PUBLIC, headers: { 'cf-access-jwt-assertion': token } });

afterEach(() => {
  vi.restoreAllMocks();
});

describe('reading the Access settings', () => {
  it('takes the team domain with or without https://, in any case, with a trailing slash', () => {
    expect(normalizeTeamDomain('Lumen-Test.cloudflareaccess.com/')).toBe(TEAM);
    expect(normalizeTeamDomain(`  ${TEAM.toUpperCase()}///  `)).toBe(TEAM);
  });

  it('refuses anything that isn’t a Cloudflare Access team domain', () => {
    for (const bad of ['', '   ', '///', 'http://lumen-test.cloudflareaccess.com', 'https://lumen-test.cloudflareaccess.com.evil.com', 'https://a.b.cloudflareaccess.com', null, undefined]) {
      expect(normalizeTeamDomain(bad), String(bad)).toBeNull();
    }
  });

  it('splits lists on commas and spaces, dropping blanks', () => {
    expect(parseList(' a@x.com, b@y.com  c@z.com,,')).toEqual(['a@x.com', 'b@y.com', 'c@z.com']);
    expect(parseList(undefined)).toEqual([]);
  });

  it('opens with a team domain written the short way', async () => {
    const res = await withEnv({ ACCESS_TEAM_DOMAIN: 'lumen-test.cloudflareaccess.com' }, `${PUBLIC}/api/me`, withToken(await accessToken()));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ email: OWNER, via: 'access' });
  });

  it('accepts a token for any of several Access applications', async () => {
    const res = await withEnv({ ACCESS_AUD: `${'c'.repeat(64)}, ${AUD}` }, `${PUBLIC}/api/me`, withToken(await accessToken()));
    expect(res.status).toBe(200);
  });

  it('lets in any verified account, service tokens included, when there’s no allow list', async () => {
    const res = await withEnv(
      { ACCESS_ALLOWED_EMAILS: '' },
      `${PUBLIC}/api/me`,
      withToken(await accessToken({ email: undefined, common_name: 'backup-robot.access' })),
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ email: 'backup-robot.access', verified: true });
  });
});

describe('tokens', () => {
  it('accepts an audience given as one string rather than a list', async () => {
    expect((await get('/me', withToken(await accessToken({ aud: AUD })))).status).toBe(200);
  });

  it('refuses a token with the wrong number of parts, or a header that isn’t JSON', async () => {
    for (const token of ['only.two', 'a.b.c.d', `${btoa('{not json')}.e30.sig`]) {
      const res = await get('/bootstrap', withToken(token));
      expect(res.status, token).toBe(401);
      expect(res.body.error).toBe('unauthorized');
    }
  });

  it('refuses a token without a key id, or without an issuer', async () => {
    for (const token of [await accessToken({}, { kid: undefined }), await accessToken({ iss: undefined })]) {
      expect((await get('/bootstrap', withToken(token))).status).toBe(401);
    }
  });

  it('takes the header Access adds over the cookie', async () => {
    const res = await get('/me', { origin: PUBLIC, headers: { 'cf-access-jwt-assertion': 'garbage', cookie: `CF_Authorization=${await accessToken()}` } });
    expect(res.status).toBe(401);
  });

  it('treats a cookie that isn’t valid percent-encoding as no token at all', async () => {
    const req = new Request(`${PUBLIC}/api/me`, { headers: { cookie: 'CF_Authorization=%E0%A4%A' } });
    expect(readAccessToken(req)).toBeNull();
    const res = await get('/me', { origin: PUBLIC, headers: { cookie: 'CF_Authorization=%E0%A4%A' } });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('access_required');
  });

  it('reads setup hints from an audience string, and nothing from garbage', () => {
    const payload = btoa(JSON.stringify({ iss: TEAM, aud: AUD })).replace(/=+$/, '');
    expect(unverifiedSetupHint(`x.${payload}.y`)).toEqual({ team: TEAM, aud: [AUD], email: null });
    expect(unverifiedSetupHint('x.%%%.y')).toEqual({ team: null, aud: [], email: null });
    expect(unverifiedSetupHint('no-dots')).toEqual({ team: null, aud: [], email: null });
    expect(unverifiedSetupHint(null)).toEqual({ team: null, aud: [], email: null });
  });
});

describe('the team’s signing keys', () => {
  it('turns away sign-ins, as unverified rather than as a server error, when the keys can’t be fetched', async () => {
    const team = 'https://keys-down.cloudflareaccess.com';
    const token = await accessToken({ iss: team });
    const res = await withEnv({ ACCESS_TEAM_DOMAIN: team }, `${PUBLIC}/api/me`, withToken(token));
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('unauthorized');
    await expect(verifyAccessJwt(token, team, [AUD])).rejects.toThrow('Could not fetch Access certificates (599)');
  });

  it('refuses to verify without a valid team or an audience', async () => {
    const token = await accessToken();
    await expect(verifyAccessJwt(token, 'https://evil.example.com', [AUD])).rejects.toThrow('Invalid team domain');
    await expect(verifyAccessJwt(token, TEAM, [])).rejects.toThrow('No audience configured');
  });

  it('goes on with the keys it has when a due refresh fails, trying again only every 30 seconds, for up to a day', async () => {
    const realNow = Date.now();
    const realFetch = globalThis.fetch;
    await verifyAccessJwt(await accessToken(), TEAM, [AUD]); // the keys, fetched and held
    let certTries = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.endsWith('/cdn-cgi/access/certs')) {
        certTries++;
        return Promise.reject(new TypeError('Network connection lost.'));
      }
      return realFetch(input, init);
    });
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const clock = vi.spyOn(Date, 'now');
    // Two hours on (the keys are due a refresh), Access's key endpoint unreachable: still signed in.
    clock.mockReturnValue(realNow + 2 * 3_600_000);
    await expect(verifyAccessJwt(await accessToken(), TEAM, [AUD])).resolves.toMatchObject({ email: OWNER });
    await expect(verifyAccessJwt(await accessToken(), TEAM, [AUD])).resolves.toMatchObject({ email: OWNER });
    expect(certTries).toBe(1);
    clock.mockReturnValue(realNow + 2 * 3_600_000 + 31_000);
    await verifyAccessJwt(await accessToken(), TEAM, [AUD]);
    expect(certTries).toBe(2);
    // Over a day without a refresh: the keys aren't trusted any more.
    clock.mockReturnValue(realNow + 25 * 3_600_000);
    await expect(verifyAccessJwt(await accessToken(), TEAM, [AUD])).rejects.toThrow('Network connection lost.');
    // Back up: fetched again, and in use.
    clock.mockRestore();
    vi.mocked(globalThis.fetch).mockRestore();
    await expect(verifyAccessJwt(await accessToken(), TEAM, [AUD])).resolves.toMatchObject({ email: OWNER });
  });

  it('fetches the keys once, and again for an unknown key at most once a minute', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const certFetches = () => fetchSpy.mock.calls.filter(([url]) => String(url instanceof Request ? url.url : url).endsWith('/cdn-cgi/access/certs')).length;
    await verifyAccessJwt(await accessToken(), TEAM, [AUD]);
    const afterFirst = certFetches();
    await verifyAccessJwt(await accessToken(), TEAM, [AUD]);
    expect(certFetches()).toBe(afterFirst); // cached
    // An unknown key id may mean Access rotated its keys: fetched again, but only once in a minute.
    await expect(verifyAccessJwt(await accessToken({}, { kid: 'rotated-1' }), TEAM, [AUD])).rejects.toThrow('Unknown signing key');
    const afterRefresh = certFetches();
    expect(afterRefresh).toBe(afterFirst + 1);
    await expect(verifyAccessJwt(await accessToken({}, { kid: 'rotated-2' }), TEAM, [AUD])).rejects.toThrow('Unknown signing key');
    await expect(verifyAccessJwt(await accessToken({}, { kid: 'rotated-3' }), TEAM, [AUD])).rejects.toThrow('Unknown signing key');
    expect(certFetches()).toBe(afterRefresh);
    // The known key still works throughout.
    await expect(verifyAccessJwt(await accessToken(), TEAM, [AUD])).resolves.toMatchObject({ email: OWNER });
  });
});
