/**
 * The front door. Every request (the app shell, its scripts and styles, and the
 * API) passes through here, so nothing is served unless Cloudflare Access has
 * signed the visitor in. See README → "Protect it with Cloudflare Access".
 */
import type { Context } from 'hono';
import type { AppEnv, Env, User } from './env';
import { normalizeTeamDomain, parseList, readAccessToken, unverifiedSetupHint, verifyAccessJwt, type SetupHint } from './auth';

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

  const team = normalizeTeamDomain(env.ACCESS_TEAM_DOMAIN);
  const audiences = parseList(env.ACCESS_AUD);
  const token = readAccessToken(c.req.raw);

  if (!team || !audiences.length) {
    return {
      ok: false,
      status: 503,
      code: 'access_not_configured',
      title: 'Lumen isn’t connected to Cloudflare Access yet',
      message:
        'Nothing is served until ACCESS_TEAM_DOMAIN and ACCESS_AUD are set. Turn on Cloudflare Access for this Worker, then add both values to its variables.',
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
    const payload = await verifyAccessJwt(token, team, audiences);
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

  const allowed = parseList(env.ACCESS_ALLOWED_EMAILS).map((e) => e.toLowerCase());
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

/** For the gate's own error pages: nothing but their inline styles. */
const PAGE_CSP = "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

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

function setupSteps(hint: SetupHint, url: string) {
  const name = workerNameFromUrl(url);
  const worker = name ? `<b>Workers &amp; Pages → ${escapeHtml(name)}</b>` : '<b>Workers &amp; Pages</b> → your Lumen Worker';
  if (!hint.team || !hint.aud.length) {
    return `<ol>
      <li>In the Cloudflare dashboard, open ${worker} → <b>Settings → Domains &amp; Routes</b> and turn on <b>Cloudflare Access</b> for this address. Under <b>Manage Cloudflare Access</b>, make sure its policy lets in only you.</li>
      <li>Reload this page and sign in. It will then show the values to set.</li>
    </ol>`;
  }
  const rows: Array<[string, string]> = [
    ['ACCESS_TEAM_DOMAIN', hint.team],
    ['ACCESS_AUD', hint.aud.join(',')],
  ];
  if (hint.email) rows.push(['ACCESS_ALLOWED_EMAILS', hint.email]);
  const table = rows.map(([k, v]) => `<tr><th>${k}</th><td><code>${escapeHtml(v)}</code></td></tr>`).join('');
  return `<p>Access is in front of this address. In ${worker} → <b>Settings → Variables and Secrets</b>, add each of these as a variable (type <b>Text</b>) and deploy, then reload this page:</p>
    <table>${table}</table>
    ${hint.email ? '<p>The last one is optional but recommended: it lets in only this account, even if the Access policy allows more. List several separated by commas.</p>' : ''}
    <p>From the command line instead? <code>npm run setup</code> saves them for you, or run <code>npx wrangler secret put</code> with each name.</p>`;
}

/** The Lumen mark (same drawing as public/icon.svg), inlined so the page needs nothing else. */
const MARK = `<svg class="mark" viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="8" fill="#22346E"/><path d="M16 9.6C13 7.7 9.6 7.3 6.4 7.9v14.6c3.2-.6 6.6-.2 9.6 1.8Z" fill="#F4F0E8"/><path d="M16 9.6c3-1.9 6.4-2.3 9.6-1.7v14.6c-3.2-.6-6.6-.2-9.6 1.8Z" fill="#DCD3C2"/><path d="M16 9.6v14.7" stroke="#22346E" stroke-width=".7" stroke-opacity=".35"/><path d="M19.6 8.7l2.8-.55V26.4l-1.4-1.5-1.4 1.5Z" fill="#B3261E"/></svg>`;

/** Answers a refused request: JSON for the API, a small self-contained page for everything else. */
export function refuse(c: Ctx, result: Extract<GateResult, { ok: false }>): Response {
  const path = new URL(c.req.url).pathname;
  const headers = { 'Cache-Control': 'no-store' };
  if (path.startsWith('/api/')) {
    return c.json({ error: result.code, message: result.message }, result.status, headers);
  }
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow"><title>Lumen</title>
<style>
  :root { color-scheme: light dark; --bg: #f1f4f8; --card: #fff; --text: #142030; --muted: #46566a; --line: #dde4ec; }
  @media (prefers-color-scheme: dark) { :root { --bg: #0b1119; --card: #18222f; --text: #e3e9f0; --muted: #a2b0c0; --line: #22303f; } }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 16px; box-sizing: border-box;
         background: var(--bg); color: var(--text); font: 15px/1.6 system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { box-sizing: border-box; max-width: 34rem; width: 100%; padding: 28px; border-radius: 16px; background: var(--card); box-shadow: 0 0 0 1px var(--line); }
  h1 { margin: 0 0 8px; font-size: 20px; line-height: 1.3; }
  p, li { color: var(--muted); }
  code, pre { font: 13px/1.5 ui-monospace, SFMono-Regular, Consolas, monospace; }
  pre { overflow-x: auto; padding: 12px 14px; border-radius: 10px; background: var(--bg); color: var(--text); }
  b { color: var(--text); }
  table { width: 100%; border-collapse: collapse; margin: 4px 0 8px; }
  th, td { padding: 8px 10px; text-align: left; vertical-align: top; border-top: 1px solid var(--line); }
  th { font: 600 12px/1.6 ui-monospace, SFMono-Regular, Consolas, monospace; color: var(--text); white-space: nowrap; }
  td code { word-break: break-all; user-select: all; color: var(--text); }
  .mark { display: block; width: 36px; height: 36px; margin-bottom: 16px; }
</style></head>
<body><main>
  ${MARK}
  <h1>${escapeHtml(result.title)}</h1>
  <p>${escapeHtml(result.message)}</p>
  ${result.code === 'access_not_configured' && result.hint ? setupSteps(result.hint, c.req.url) : ''}
</main></body></html>`;
  return new Response(html, {
    status: result.status,
    headers: { ...headers, 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': PAGE_CSP },
  });
}

export type { Env };
