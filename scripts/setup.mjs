#!/usr/bin/env node
// Guided first deploy of your own copy of Lumen to your Cloudflare account: `npm run setup`.
//
// 1. Signs in to Cloudflare (wrangler login) if you aren't already.
// 2. Asks what to call the Worker (its address becomes https://<name>.<your-subdomain>.workers.dev).
// 3. Builds and deploys. The first deploy creates the database and file store; later deploys reuse them.
// 4. Walks you through turning on Cloudflare Access, then saves its two values (and, optionally, the
//    accounts allowed in) to the Worker as secrets, so nothing personal is written into this folder.
//
// Safe to run again: it redeploys the same Worker and replaces the Access values you enter.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG = path.join(ROOT, 'wrangler.jsonc');
const WRANGLER = path.join(ROOT, 'node_modules', 'wrangler', 'bin', 'wrangler.js');

const bold = (s) => (process.stdout.isTTY ? `\x1b[1m${s}\x1b[0m` : s);
const dim = (s) => (process.stdout.isTTY ? `\x1b[2m${s}\x1b[0m` : s);
const say = (s = '') => console.log(s);
const step = (n, s) => say(`\n${bold(`${n}. ${s}`)}`);

function fail(message) {
  console.error(`\n${message}`);
  process.exit(1);
}

/** One question at a time, so wrangler (which may ask its own) has the terminal in between. */
async function ask(question, fallback = '') {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(fallback ? `${question} ${dim(`(${fallback})`)} ` : `${question} `)).trim();
    return answer || fallback;
  } finally {
    rl.close();
  }
}

async function confirm(question, yes = true) {
  const answer = (await ask(`${question} ${dim(yes ? '[Y/n]' : '[y/N]')}`)).toLowerCase();
  return answer ? answer.startsWith('y') : yes;
}

/** Runs wrangler from this project's node_modules (no npx or shell, so it behaves the same everywhere). */
function wrangler(args, options = {}) {
  return spawnSync(process.execPath, [WRANGLER, ...args], { cwd: ROOT, stdio: 'inherit', ...options });
}

/* --------------------------------------------------------------- checks --- */

const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 12)) fail(`Lumen needs Node.js 22.12 or newer (this is ${process.versions.node}).`);
if (!fs.existsSync(WRANGLER)) fail('Run `npm install` first, then `npm run setup` again.');
if (!process.stdin.isTTY) fail('Run `npm run setup` in a terminal: it asks a few questions as it goes.');

say(bold('\nLumen setup'));
say('This deploys your own copy of Lumen to your Cloudflare account (the free plan is enough).');

/* ---------------------------------------------------------------- 1. sign in --- */

step(1, 'Cloudflare account');
const who = wrangler(['whoami'], { stdio: ['inherit', 'pipe', 'pipe'], encoding: 'utf8' });
if (who.status !== 0 || /not authenticated/i.test(`${who.stdout}${who.stderr}`)) {
  say('Signing in to Cloudflare in your browser...');
  if (wrangler(['login']).status !== 0) fail('Sign-in didn’t finish. Run `npm run setup` again to retry.');
} else {
  const line = `${who.stdout}`.split('\n').find((l) => /logged in/i.test(l));
  say(line ? line.trim() : 'Signed in.');
}

/* ------------------------------------------------------------------ 2. name --- */

step(2, 'Name');
const original = fs.readFileSync(CONFIG, 'utf8');
const NAME_LINE = /^(\s*"name"\s*:\s*)"([^"]*)"/m;
const current = NAME_LINE.exec(original)?.[2] ?? 'lumen';
say(`Your Lumen will be at https://<name>.<your-subdomain>.workers.dev. ${dim('Lowercase letters, numbers and dashes.')}`);
let name;
for (;;) {
  name = (await ask('Worker name:', current)).toLowerCase();
  if (/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(name)) break;
  say('Use 1 to 63 lowercase letters, numbers or dashes, not starting or ending with a dash.');
}
let config = original;
if (name !== current) {
  config = original.replace(NAME_LINE, `$1"${name}"`);
  fs.writeFileSync(CONFIG, config);
  say(`Saved the name in wrangler.jsonc ${dim('(later deploys use it too)')}.`);
}

/* ---------------------------------------------------------------- 3. deploy --- */

step(3, 'Build and deploy');
say(`Creates (on the first deploy) the database ${bold(`${name}-db`)} and the file store ${bold(`${name}-files-kv`)}, then deploys.`);
if (!(await confirm('Deploy now?'))) fail('Nothing was deployed. Run `npm run setup` again when you’re ready.');

if (spawnSync('npm run build', { cwd: ROOT, stdio: 'inherit', shell: true }).status !== 0) fail('The build failed (see above).');
const deployed = wrangler(['deploy']);
// Wrangler writes the new resources' IDs into wrangler.jsonc. They aren't needed (later deploys find the
// resources through the deployed Worker), and leaving the file as it was keeps `git pull` conflict-free.
if (fs.readFileSync(CONFIG, 'utf8') !== config) fs.writeFileSync(CONFIG, config);
if (deployed.status !== 0) fail('The deploy failed (see above). Fix what it says, then run `npm run setup` again.');

/* ---------------------------------------------------------------- 4. access --- */

step(4, 'Cloudflare Access');
say('Lumen serves nothing (not even its own page) until Cloudflare Access is in front of it. To turn it on:');
say(`  a. In the Cloudflare dashboard, open ${bold(`Workers & Pages → ${name} → Settings → Domains & Routes`)}.`);
say(`  b. Next to the ${bold('workers.dev')} address, turn on ${bold('Cloudflare Access')}. Under ${bold('Manage Cloudflare Access')},`);
say('     make sure its policy lets in only your email address.');
say(`  c. Open your Lumen address (the ${bold('workers.dev')} link printed above) and sign in.`);
say('     The page then shows your team domain and AUD tag.');
say(dim('\nPress Enter on an empty answer to skip this; you can add the values in the dashboard later'));
say(dim('(Settings → Variables and Secrets), as the page in step c explains.'));

const normalizeTeam = (value) => {
  let v = value.trim().toLowerCase().replace(/\/+$/, '');
  if (/^[a-z0-9-]+$/.test(v)) v = `${v}.cloudflareaccess.com`;
  if (!/^https?:\/\//.test(v)) v = `https://${v}`;
  return /^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/.test(v) ? v : null;
};

let team = null;
while (!team) {
  const answer = await ask('\nACCESS_TEAM_DOMAIN (like https://<team>.cloudflareaccess.com):');
  if (!answer) break;
  team = normalizeTeam(answer);
  if (!team) say('That isn’t a team domain. It looks like https://<team>.cloudflareaccess.com.');
}

let aud = null;
while (team && !aud) {
  const answer = await ask('ACCESS_AUD (the 64-character Audience tag):');
  if (!answer) break;
  const tags = answer.split(/[\s,]+/).filter(Boolean);
  if (tags.length && tags.every((t) => /^[a-f0-9]{32,128}$/.test(t))) aud = tags.join(',');
  else say('That isn’t an AUD tag: it’s a long string of 0–9 and a–f. List several separated by commas.');
}

if (!team || !aud) {
  say(`\n${bold('Deployed.')} Access isn’t set up yet, so your Lumen address shows a setup page until it is.`);
  say('It lists exactly which values to add. Or run `npm run setup` again.');
  process.exit(0);
}

let emails = '';
for (;;) {
  emails = await ask('ACCESS_ALLOWED_EMAILS (recommended: only these accounts get in; comma-separated, Enter to skip):');
  const list = emails.split(/[\s,]+/).filter(Boolean);
  if (list.every((e) => /^[^\s@<>"',;]+@[^\s@<>"',;]+\.[a-z]{2,}$/i.test(e))) {
    emails = list.join(',');
    break;
  }
  say('One of those isn’t an email address.');
}

const secrets = { ACCESS_TEAM_DOMAIN: team, ACCESS_AUD: aud, ...(emails ? { ACCESS_ALLOWED_EMAILS: emails } : {}) };
say(`\nSaving ${Object.keys(secrets).join(', ')} to the Worker as secrets...`);
const saved = wrangler(['secret', 'bulk', '--name', name], { input: JSON.stringify(secrets), stdio: ['pipe', 'inherit', 'inherit'] });
if (saved.status !== 0) {
  fail('Those values couldn’t be saved (see above). Add them in the dashboard instead: Workers & Pages → ' +
    `${name} → Settings → Variables and Secrets.`);
}

say(`\n${bold('Done.')} Reload your Lumen address: after the Access sign-in, your notes open.`);
say(dim('Later updates: `git pull`, then `npm run deploy`. See README → "Deploy your own" for a custom domain,'));
say(dim('R2 storage and automatic deploys from GitHub.'));
