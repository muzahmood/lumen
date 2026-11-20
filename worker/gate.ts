/**
 * The front door. Every request (the app shell, its scripts and styles, and the
 * API) passes through here, so nothing is served unless Cloudflare Access has
 * signed the visitor in. See README → "Protect it with Cloudflare Access".
 *
 * Until this Lumen knows which Access application to trust (setup.ts), it serves
 * only the setup page, which walks its owner through turning Access on and then
 * claiming it with the setup password (POST /__setup).
 */
import type { Context } from 'hono';
import type { AppEnv, Env, User } from './env';
import { isPlainEmail, readAccessToken, unverifiedSetupHint, verifyAccessJwt, type SetupHint } from './auth';
import {
  accessConfig,
  MAX_SETUP_FAILURES,
  MIN_SETUP_PASSWORD,
  recordSetupFailure,
  saveClaim,
  setupFailures,
  setupPasswordMatches,
  setupPasswordState,
  type AccessConfig,
} from './setup';

type Ctx = Context<AppEnv>;

export type GateResult =
  | { ok: true; user: User }
  | { ok: false; status: 401 | 403 | 503; code: string; title: string; message: string; hint?: SetupHint };

function isLocalHost(url: string) {
  const host = new URL(url).hostname;
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
}

export async function authenticate(c: Ctx): Promise<GateResult> {
  const env = c.env;

  // Local development only: LOCAL_DEV is passed on the `wrangler dev` command line (npm run dev / start),
  // which `wrangler deploy` never sees, and the hostname check means even a stray deployed LOCAL_DEV
  // can't open a public address.
  if (env.LOCAL_DEV === 'true' && isLocalHost(c.req.url)) {
    return { ok: true, user: { email: null, verified: false, via: 'local' } };
  }

  const token = readAccessToken(c.req.raw);
  let config: AccessConfig | null;
  try {
    config = await accessConfig(env);
  } catch (err) {
    console.error('Access settings could not be read:', err);
    return {
      ok: false,
      status: 503,
      code: 'unavailable',
      title: 'Lumen can’t read its settings just now',
      message: 'Its database didn’t answer. Reload in a moment.',
    };
  }

  if (!config) {
    return {
      ok: false,
      status: 503,
      code: 'access_not_configured',
      title: 'Lumen isn’t connected to Cloudflare Access yet',
      message: 'Nothing is served until this Lumen is connected to Cloudflare Access. Open it in a browser to finish setting it up.',
      hint: unverifiedSetupHint(token),
    };
  }

  if (!token) {
    return {
      ok: false,
      status: 403,
      code: 'access_required',
      title: 'This address isn’t protected by Cloudflare Access',
      message: 'Lumen only opens through Cloudflare Access. Turn on Access for this hostname (or for the whole Worker), then reload.',
    };
  }

  let email: string | null;
  try {
    const payload = await verifyAccessJwt(token, config.team, config.audiences);
    email = payload.email ?? payload.common_name ?? null;
  } catch (err) {
    console.warn('Access token rejected:', (err as Error).message);
    return {
      ok: false,
      status: 401,
      code: 'unauthorized',
      title: 'Your sign-in couldn’t be verified',
      message: 'Your Cloudflare Access session is invalid or has expired. Reload the page to sign in again.',
    };
  }

  const allowed = config.allowed;
  if (allowed.length && (!email || !allowed.includes(email.toLowerCase()))) {
    return {
      ok: false,
      status: 403,
      code: 'not_allowed',
      title: 'This account can’t open these notes',
      message: 'You’re signed in to Cloudflare Access, but not with an account on this knowledgebase’s allow list.',
    };
  }

  return { ok: true, user: { email, verified: true, via: 'access' } };
}

/* ----------------------------------------------------------- headers --- */

/**
 * The app's Content Security Policy. Scripts only from this origin (WebAssembly is
 * used for image and font processing); inline styles are needed by the editor,
 * diagrams and math. Images may come from https: so pictures linked in notes work.
 */
const APP_CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "media-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self' data: blob:",
  "worker-src 'self' blob: data:",
  "manifest-src 'self'",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

/** For the gate's own pages: nothing but their inline styles, and the setup form posting to this Lumen. */
const PAGE_CSP = "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

const COMMON_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  'Strict-Transport-Security': 'max-age=31536000',
};

/** Adds the security headers to a response (copying it first if its headers are immutable). */
export function secureResponse(res: Response): Response {
  let out = res;
  try {
    res.headers.set('X-Content-Type-Options', 'nosniff');
  } catch {
    out = new Response(res.body, res);
  }
  for (const [k, v] of Object.entries(COMMON_HEADERS)) out.headers.set(k, v);
  const type = out.headers.get('content-type') ?? '';
  // File responses set their own (sandboxing) policy; HTML gets the app policy.
  if (!out.headers.has('Content-Security-Policy') && type.includes('text/html')) {
    out.headers.set('Content-Security-Policy', APP_CSP);
  }
  return out;
}

/** Static files: hashed build output is immutable; everything else is revalidated. Never cached by shared caches. */
export async function serveAsset(c: Ctx): Promise<Response> {
  if (!c.env.ASSETS) return c.text('Not found', 404);
  const res = await c.env.ASSETS.fetch(c.req.raw);
  const path = new URL(c.req.url).pathname;
  const type = res.headers.get('content-type') ?? '';
  // A missing build file (usually an old script name asked for by a tab opened before the last
  // deploy) must fail as a 404, not come back as the HTML app shell, which the browser would try
  // to run as JavaScript. The app sees the failed load and reloads onto the new version.
  if ((path.startsWith('/assets/') || path.startsWith('/excalidraw-assets/')) && type.includes('text/html')) {
    return new Response('Not found', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } });
  }
  const out = new Response(res.body, res);
  if (path.startsWith('/assets/')) {
    out.headers.set('Cache-Control', 'private, max-age=31536000, immutable');
  } else if (path.startsWith('/excalidraw-assets/')) {
    out.headers.set('Cache-Control', 'private, max-age=604800');
  } else {
    out.headers.set('Cache-Control', 'private, no-cache');
  }
  return out;
}

/* -------------------------------------------------------- refusals --- */

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);

/**
 * The Worker's name, read from its workers.dev address (<name>.<subdomain>.workers.dev), so the setup
 * steps can name it in the dashboard path. Each copy can be called something else; null when unknown.
 */
export function workerNameFromUrl(url: string): string | null {
  const labels = new URL(url).hostname.split('.');
  if (labels.length !== 4 || labels[2] !== 'workers' || labels[3] !== 'dev') return null;
  return /^[a-z0-9-]{1,63}$/.test(labels[0]) ? labels[0] : null;
}

/** Where the owner claims a new Lumen (a form on the setup page posts here). */
export const SETUP_PATH = '/__setup';

const DASH_WORKERS = 'https://dash.cloudflare.com/?to=/:account/workers-and-pages';
const DASH_ZERO_TRUST = 'https://dash.cloudflare.com/?to=/:account/one/access/apps';
const link = (href: string, text: string) => `<a href="${href}" target="_blank" rel="noopener noreferrer">${text}</a>`;

/** What the setup page has to say after a try at claiming (a wrong password, say). */
interface SetupNotice {
  error?: string;
}

/**
 * The setup page: the steps from a fresh deploy to a Lumen that opens, marking the one the visitor is
 * on. A visitor who isn't signed in through Access is on step 2; one who is, on step 3, where the setup
 * password claims it (or, without one, the values to set by hand).
 */
function setupSteps(c: Ctx, hint: SetupHint, notice: SetupNotice = {}) {
  const name = workerNameFromUrl(c.req.url);
  const worker = `${link(DASH_WORKERS, 'Workers &amp; Pages')} → ${name ? `<b>${escapeHtml(name)}</b>` : 'your Lumen Worker'}`;
  const signedIn = !!(hint.team && hint.aud.length);
  const step = (state: 'done' | 'now' | 'later', title: string, body = '') =>
    `<li class="${state}"><span class="dot" aria-hidden="true">${state === 'done' ? '✓' : ''}</span><div><b>${title}</b>${
      state === 'done' ? '<span class="sr"> (done)</span>' : ''
    }${body}</div></li>`;

  const accessBody = `
    <p>In the Cloudflare dashboard, open ${worker} → <b>Access</b>. Choose <b>Protect this Worker behind Access</b>, then <b>All traffic</b>, pick a policy that lets in only you (<b>Cloudflare account</b> does, if you’re its only member) and <b>Apply</b>. Then reload this page and sign in.</p>
    <p class="note">Access can take a minute to switch on: if reloading shows this page again instead of a sign-in, wait a moment and reload once more.</p>
    <p class="note">First time using Access? Cloudflare first asks you to set up ${link(DASH_ZERO_TRUST, 'Zero Trust')}: a team name and the <b>Free</b> plan (up to 50 people). It may ask for a payment card; the Free plan isn’t charged.</p>`;
  const signedInBody = hint.email ? `<p>Signed in as <b>${escapeHtml(hint.email)}</b>.</p>` : '';

  let claimBody = '';
  if (signedIn) {
    const rows: Array<[string, string]> = [
      ['ACCESS_TEAM_DOMAIN', hint.team!],
      ['ACCESS_AUD', hint.aud.join(',')],
    ];
    if (hint.email) rows.push(['ACCESS_ALLOWED_EMAILS', hint.email]);
    const byHand = `<table>${rows.map(([k, v]) => `<tr><th>${k}</th><td><code>${escapeHtml(v)}</code></td></tr>`).join('')}</table>
      ${hint.email ? '<p>The last one is optional but recommended: it lets in only this account, even if the Access policy allows more. List several separated by commas.</p>' : ''}`;
    const password = setupPasswordState(c.env);
    if (password === 'ok') {
      claimBody = `
        <p>Type the setup password you chose when deploying.${hint.email ? ` From then on only <b>${escapeHtml(hint.email)}</b> can open this Lumen.` : ''}</p>
        ${notice.error ? `<p class="error" role="alert">${escapeHtml(notice.error)}</p>` : ''}
        <form method="post" action="${SETUP_PATH}">
          <label for="setup-password">Setup password</label>
          <div class="row"><input id="setup-password" name="password" type="password" required minlength="${MIN_SETUP_PASSWORD}" autocomplete="off" autofocus><button type="submit">Finish setup</button></div>
        </form>
        <details><summary>No setup password?</summary>
          <p>Add one as a secret named <code>SETUP_PASSWORD</code> (${MIN_SETUP_PASSWORD} or more characters) in ${worker} → <b>Settings → Variables and Secrets</b>, then reload. Or add these as variables (type <b>Text</b>) instead, and reload:</p>${byHand}
        </details>`;
    } else {
      claimBody = `
        <p>${
          password === 'short'
            ? `The setup password is shorter than ${MIN_SETUP_PASSWORD} characters, which is too easy to guess here. Replace <code>SETUP_PASSWORD</code>`
            : `Add a setup password: a secret named <code>SETUP_PASSWORD</code>, ${MIN_SETUP_PASSWORD} or more characters,`
        } in ${worker} → <b>Settings → Variables and Secrets</b>, then reload and type it here.</p>
        <p>Or add these as variables (type <b>Text</b>) there instead, and reload:</p>${byHand}
        <p class="note">From the command line, <code>npm run setup</code> does this for you.</p>`;
    }
  }

  return `<ol class="steps">
    ${step('done', 'Deploy it', '<p>Done: this page is your Lumen, waiting to be locked.</p>')}
    ${step(signedIn ? 'done' : 'now', 'Put Cloudflare Access in front of it', signedIn ? signedInBody : accessBody)}
    ${step(signedIn ? 'now' : 'later', 'Confirm it’s yours', claimBody)}
  </ol>`;
}

/** The Lumen mark (same drawing as public/icon.svg), inlined so the page needs nothing else. */
const MARK = `<svg class="mark" viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="8" fill="#22346E"/><path d="M16 9.6C13 7.7 9.6 7.3 6.4 7.9v14.6c3.2-.6 6.6-.2 9.6 1.8Z" fill="#F4F0E8"/><path d="M16 9.6c3-1.9 6.4-2.3 9.6-1.7v14.6c-3.2-.6-6.6-.2-9.6 1.8Z" fill="#DCD3C2"/><path d="M16 9.6v14.7" stroke="#22346E" stroke-width=".7" stroke-opacity=".35"/><path d="M19.6 8.7l2.8-.55V26.4l-1.4-1.5-1.4 1.5Z" fill="#B3261E"/></svg>`;

const PAGE_STYLE = `
  :root { color-scheme: light dark; --bg: #f1f4f8; --card: #fff; --text: #142030; --muted: #46566a; --line: #dde4ec; --accent: #1e4e80; --on-accent: #fff; --error: #b3261e; }
  @media (prefers-color-scheme: dark) { :root { --bg: #0b1119; --card: #18222f; --text: #e3e9f0; --muted: #a2b0c0; --line: #22303f; --accent: #7eb0e6; --on-accent: #0b1119; --error: #f2a39d; } }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 16px; box-sizing: border-box;
         background: var(--bg); color: var(--text); font: 15px/1.6 system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { box-sizing: border-box; max-width: 36rem; width: 100%; padding: 28px; border-radius: 16px; background: var(--card); box-shadow: 0 0 0 1px var(--line); }
  h1 { margin: 0 0 8px; font-size: 20px; line-height: 1.3; }
  p, li { color: var(--muted); }
  a { color: var(--accent); }
  code, pre { font: 13px/1.5 ui-monospace, SFMono-Regular, Consolas, monospace; }
  b { color: var(--text); }
  table { width: 100%; border-collapse: collapse; margin: 4px 0 8px; }
  th, td { padding: 8px 10px; text-align: left; vertical-align: top; border-top: 1px solid var(--line); }
  th { font: 600 12px/1.6 ui-monospace, SFMono-Regular, Consolas, monospace; color: var(--text); white-space: nowrap; }
  td code { word-break: break-all; user-select: all; color: var(--text); }
  .mark { display: block; width: 36px; height: 36px; margin-bottom: 16px; }
  .steps { list-style: none; margin: 20px 0 0; padding: 0; }
  .steps > li { display: grid; grid-template-columns: 28px 1fr; gap: 12px; padding: 14px 0; border-top: 1px solid var(--line); }
  .steps > li > div > b { display: block; }
  .steps p { margin: 6px 0 0; }
  .steps > li.later { opacity: .55; }
  .dot { box-sizing: border-box; width: 24px; height: 24px; border-radius: 50%; border: 2px solid var(--line); display: grid; place-items: center; font-size: 13px; font-weight: 700; margin-top: 1px; }
  .done .dot { border-color: var(--accent); background: var(--accent); color: var(--on-accent); }
  .now .dot { border-color: var(--accent); }
  .note { font-size: 13.5px; }
  .error { color: var(--error); font-weight: 600; }
  form { margin-top: 10px; }
  label { display: block; font-size: 13px; font-weight: 600; color: var(--text); margin-bottom: 4px; }
  .row { display: flex; gap: 8px; flex-wrap: wrap; }
  input { flex: 1 1 12rem; min-width: 0; font: inherit; padding: 8px 10px; border-radius: 8px; border: 1px solid var(--line); background: var(--bg); color: var(--text); }
  button { font: inherit; font-weight: 600; padding: 8px 16px; border-radius: 8px; border: 0; background: var(--accent); color: var(--on-accent); cursor: pointer; }
  input:focus-visible, button:focus-visible, a:focus-visible, summary:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  details { margin-top: 12px; font-size: 13.5px; }
  summary { cursor: pointer; color: var(--muted); }
  .sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
`;

/** A small self-contained page (nothing loaded from anywhere, no script). */
function page(status: number, title: string, body: string): Response {
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow"><title>Lumen</title>
<style>${PAGE_STYLE}</style></head>
<body><main>
  ${MARK}
  <h1>${escapeHtml(title)}</h1>
  ${body}
</main></body></html>`;
  return new Response(html, {
    status,
    headers: { 'Cache-Control': 'no-store', 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': PAGE_CSP },
  });
}

function setupPage(c: Ctx, status: number, hint: SetupHint, notice?: SetupNotice): Response {
  return page(
    status,
    'Finish setting up your Lumen',
    `<p>Lumen isn’t connected to Cloudflare Access yet, so it shows only this page: not your notes, not even the app. Three steps:</p>${setupSteps(c, hint, notice)}`,
  );
}

/** Answers a refused request: JSON for the API, a small self-contained page for everything else. */
export function refuse(c: Ctx, result: Extract<GateResult, { ok: false }>): Response {
  const path = new URL(c.req.url).pathname;
  if (path.startsWith('/api/')) {
    return c.json({ error: result.code, message: result.message }, result.status, { 'Cache-Control': 'no-store' });
  }
  if (result.code === 'access_not_configured' && result.hint) return setupPage(c, result.status, result.hint);
  return page(result.status, result.title, `<p>${escapeHtml(result.message)}</p>`);
}

/* ------------------------------------------------------------- setup --- */

/** A setup form is a password; anything much bigger isn't one. */
const MAX_SETUP_BODY = 4096;

/**
 * Claims a new Lumen (the setup page's form). Needs, in this order: no Access settings yet, a sign-in
 * Access has signed (checked against the keys of the team that signed it), a setup password set on
 * the Worker, fewer than MAX_SETUP_FAILURES wrong ones this hour, and the right one. Then the team, the
 * Access application and the signed-in email are recorded (see setup.ts) and the visitor goes to the
 * app, which the gate now opens for them. Anything else comes back to the setup page saying why.
 */
export async function claimSetup(c: Ctx): Promise<Response> {
  const env = c.env;
  const url = new URL(c.req.url);
  // The password is what really guards this, but nothing else should be posting here. Browsers say where
  // a request came from in Sec-Fetch-Site; Origin is "null" on this page's own form, because the page's
  // Referrer-Policy is no-referrer, so only a real other origin there counts against it.
  const site = c.req.header('sec-fetch-site');
  const origin = c.req.header('origin');
  if ((site && site !== 'same-origin' && site !== 'none') || (origin && origin !== 'null' && origin !== url.origin)) {
    return page(403, 'That didn’t come from this Lumen', '<p>Open this Lumen’s own address and try again.</p>');
  }
  if (Number(c.req.header('content-length') ?? 0) > MAX_SETUP_BODY) return page(413, 'That’s too much', '<p>Go back and try again.</p>');

  let config: AccessConfig | null;
  try {
    config = await accessConfig(env);
  } catch (err) {
    console.error('Access settings could not be read:', err);
    return page(503, 'Lumen can’t read its settings just now', '<p>Its database didn’t answer. Go back and try again in a moment.</p>');
  }
  // Set up already (here, or with variables): the app is that way, and the gate decides who gets in.
  if (config) return new Response(null, { status: 303, headers: { Location: '/', 'Cache-Control': 'no-store' } });

  const token = readAccessToken(c.req.raw);
  const hint = unverifiedSetupHint(token);
  if (!token || !hint.team || !hint.aud.length || setupPasswordState(env) !== 'ok') return setupPage(c, 403, hint);

  if ((await setupFailures(env.DB)) >= MAX_SETUP_FAILURES) {
    return setupPage(c, 429, hint, { error: 'Too many wrong setup passwords. Try again in an hour.' });
  }

  let email: string | null = null;
  try {
    const payload = await verifyAccessJwt(token, hint.team, hint.aud);
    email = typeof payload.email === 'string' && isPlainEmail(payload.email) ? payload.email : null;
  } catch (err) {
    console.warn('Setup sign-in rejected:', (err as Error).message);
    return setupPage(c, 401, hint, { error: 'Your sign-in couldn’t be verified. Reload the page to sign in again.' });
  }
  if (!email) return setupPage(c, 403, hint, { error: 'Sign in with an email address to finish setup.' });

  let password = '';
  try {
    const form = await c.req.parseBody();
    password = typeof form.password === 'string' ? form.password : '';
  } catch {
    password = '';
  }
  if (!(await setupPasswordMatches(password, env.SETUP_PASSWORD!))) {
    await recordSetupFailure(env.DB);
    return setupPage(c, 403, hint, { error: 'That isn’t the setup password.' });
  }

  // Only the first claim counts (another one may have landed meanwhile); either way the app is next.
  if (await saveClaim(env.DB, { team: hint.team, aud: hint.aud, email })) console.log('Lumen was set up from its setup page.');
  return new Response(null, { status: 303, headers: { Location: '/', 'Cache-Control': 'no-store' } });
}

export type { Env };
