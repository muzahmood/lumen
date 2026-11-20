/**
 * The assisted setup (worker/setup.ts and the setup page in worker/gate.ts): a Lumen deployed from the
 * public repository has no Access variables, shows only the setup page, and is claimed there by the
 * first person who signs in through Access and types the setup password. These run the real Worker
 * with the Access variables taken away, as on a fresh deploy.
 */
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import worker from '../../worker/index';
import { ensureSchema } from '../../worker/schema';
import { forgetAccessConfig, MAX_SETUP_FAILURES } from '../../worker/setup';
import { accessToken, AUD, OWNER, PUBLIC, read, TEAM } from './helpers';

const PASSWORD = 'correct horse battery staple';
const OTHER = 'someone-else@example.com';
/** As deployed from the public repository: no Access variables, and the setup password chosen then. */
const FRESH: Partial<Cloudflare.Env> = { ACCESS_TEAM_DOMAIN: '', ACCESS_AUD: '', ACCESS_ALLOWED_EMAILS: '', SETUP_PASSWORD: PASSWORD };

async function visit(path: string, init: RequestInit = {}, overrides: Partial<Cloudflare.Env> = FRESH) {
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(`${PUBLIC}${path}`, init), { ...env, ...overrides }, ctx);
  await waitOnExecutionContext(ctx);
  return read(res);
}

const signedIn = async (claims: Record<string, unknown> = {}) => ({ 'cf-access-jwt-assertion': await accessToken(claims) });

/** Posts the setup page's form. */
async function claim(password: string, headers: Record<string, string> = {}, overrides: Partial<Cloudflare.Env> = FRESH) {
  return visit(
    '/__setup',
    {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: PUBLIC, ...headers },
      body: new URLSearchParams({ password }).toString(),
      redirect: 'manual',
    },
    overrides,
  );
}

async function stored() {
  const row = await env.DB.prepare(`SELECT value FROM kb_meta WHERE key = 'access_config'`).first<{ value: string }>();
  return row ? JSON.parse(row.value) : null;
}

beforeEach(async () => {
  await ensureSchema(env.DB);
  await env.DB.prepare(`DELETE FROM kb_meta WHERE key IN ('access_config', 'setup_failures')`).run();
  forgetAccessConfig();
});

describe('the setup page', () => {
  it('walks a new Lumen through turning on Access, Zero Trust included, before asking for anything', async () => {
    const page = await visit('/');
    expect(page.status).toBe(503);
    expect(page.headers.get('cache-control')).toBe('no-store');
    expect(page.body).toContain('Finish setting up your Lumen');
    expect(page.body).toContain('isn’t connected to Cloudflare Access');
    expect(page.body).toContain('Protect this Worker behind Access');
    expect(page.body).toContain('Zero Trust');
    // Access takes a moment to apply; a reload too soon still shows this step.
    expect(page.body).toContain('Access can take a minute to switch on');
    expect(page.body).not.toContain('<form');
    // The API stays closed and says so in JSON.
    const api = await visit('/api/bootstrap');
    expect(api.status).toBe(503);
    expect(api.body.error).toBe('access_not_configured');
  });

  it('asks whoever is signed in through Access for the setup password', async () => {
    const page = await visit('/', { headers: await signedIn() });
    expect(page.status).toBe(503);
    expect(page.body).toContain(`<form method="post" action="/__setup">`);
    expect(page.body).toContain('type="password"');
    expect(page.body).toContain(OWNER);
    // The page may post its form, and nothing else.
    expect(page.headers.get('content-security-policy')).toContain("form-action 'self'");
    expect(page.headers.get('content-security-policy')).toContain("default-src 'none'");
  });

  it('without a usable setup password, says how to add one, or which values to set by hand', async () => {
    for (const [SETUP_PASSWORD, says] of [
      ['', 'Add a setup password'],
      ['short-one', 'shorter than 12 characters'],
    ] as const) {
      const page = await visit('/', { headers: await signedIn() }, { ...FRESH, SETUP_PASSWORD });
      expect(page.body).not.toContain('<form');
      expect(page.body).toContain(says);
      expect(page.body).toContain(TEAM);
      expect(page.body).toContain(AUD);
    }
  });
});

describe('claiming a new Lumen', () => {
  it('with the right password, records Access for the account that signed in, and opens the app for it alone', async () => {
    const res = await claim(PASSWORD, await signedIn());
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/');
    expect(await stored()).toMatchObject({ team: TEAM, aud: [AUD], emails: [OWNER] });

    const me = await visit('/api/me', { headers: await signedIn() });
    expect(me.status).toBe(200);
    expect(me.body).toMatchObject({ email: OWNER, verified: true, via: 'access' });
    const other = await visit('/api/me', { headers: await signedIn({ email: OTHER }) });
    expect(other.status).toBe(403);
    expect(other.body.error).toBe('not_allowed');
    // Signed out (no token): the address isn't open to anyone.
    expect((await visit('/api/me')).status).toBe(403);
  });

  it('refuses a wrong password, and stops listening after too many', async () => {
    const wrong = await claim('not the password at all', await signedIn());
    expect(wrong.status).toBe(403);
    expect(wrong.body).toContain('That isn’t the setup password.');
    for (let i = 1; i < MAX_SETUP_FAILURES; i++) await claim(`wrong guess number ${i}`, await signedIn());
    const locked = await claim(PASSWORD, await signedIn());
    expect(locked.status).toBe(429);
    expect(locked.body).toContain('Too many wrong setup passwords');
    expect(await stored()).toBeNull();
    expect((await visit('/api/me', { headers: await signedIn() })).status).toBe(503);
  });

  it('takes no sign-in it can’t verify: forged, from a team whose keys don’t match, or without an email', async () => {
    const real = await accessToken();
    const [head, , sig] = real.split('.');
    const forgedBody = btoa(JSON.stringify({ aud: [AUD], iss: TEAM, email: 'attacker@example.com', exp: Math.floor(Date.now() / 1000) + 600 }))
      .replace(/=+$/, '')
      .replace(/\+/g, '-')
      .replace(/\//g, '_');
    const forged = await claim(PASSWORD, { 'cf-access-jwt-assertion': `${head}.${forgedBody}.${sig}` });
    expect(forged.status).toBe(401);
    // Another team's token: its keys are fetched from that team, and these aren't them.
    const otherTeam = await claim(PASSWORD, await signedIn({ iss: 'https://another-team.cloudflareaccess.com' }));
    expect(otherTeam.status).toBe(401);
    const noEmail = await claim(PASSWORD, await signedIn({ email: undefined, common_name: 'a-service-token' }));
    expect(noEmail.status).toBe(403);
    expect(noEmail.body).toContain('Sign in with an email address');
    expect(await stored()).toBeNull();
  });

  it('needs the sign-in at all, and a post from its own page', async () => {
    const notSignedIn = await claim(PASSWORD);
    expect(notSignedIn.status).toBe(403);
    expect(notSignedIn.body).toContain('Protect this Worker behind Access');
    const crossSite = await claim(PASSWORD, { ...(await signedIn()), origin: 'https://evil.example' });
    expect(crossSite.status).toBe(403);
    const crossSiteFetch = await claim(PASSWORD, { ...(await signedIn()), origin: 'null', 'sec-fetch-site': 'cross-site' });
    expect(crossSiteFetch.status).toBe(403);
    expect(await stored()).toBeNull();
  });

  it('takes its own form as a browser sends it: Origin "null" (the page sends no referrer), same-origin fetch', async () => {
    const res = await claim(PASSWORD, { ...(await signedIn()), origin: 'null', 'sec-fetch-site': 'same-origin' });
    expect(res.status).toBe(303);
    expect(await stored()).toMatchObject({ emails: [OWNER] });
  });

  it('counts only the first claim: after it, the form is gone and another account changes nothing', async () => {
    expect((await claim(PASSWORD, await signedIn())).status).toBe(303);
    const page = await visit('/', { headers: await signedIn({ email: OTHER }) });
    expect(page.body).not.toContain('<form');
    const second = await claim(PASSWORD, await signedIn({ email: OTHER }));
    expect(second.status).toBe(303);
    expect(await stored()).toMatchObject({ emails: [OWNER] });
    expect((await visit('/api/me', { headers: await signedIn({ email: OTHER }) })).status).toBe(403);
  });

  it('lets the variables have the last word: they replace a claimed setup, and the allow list alone overrides its account', async () => {
    await claim(PASSWORD, await signedIn());
    const vars = { ...FRESH, ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD, ACCESS_ALLOWED_EMAILS: OTHER };
    expect((await visit('/api/me', { headers: await signedIn() }, vars)).status).toBe(403);
    expect((await visit('/api/me', { headers: await signedIn({ email: OTHER }) }, vars)).status).toBe(200);
    const listOnly = { ...FRESH, ACCESS_ALLOWED_EMAILS: `${OTHER}, ${OWNER}` };
    expect((await visit('/api/me', { headers: await signedIn({ email: OTHER }) }, listOnly)).status).toBe(200);
  });
});
