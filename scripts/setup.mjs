#!/usr/bin/env node
// Guided first deploy of your own copy of Lumen to your Cloudflare account: `npm run setup`.
//
// 1. Signs in to Cloudflare (wrangler login) if you aren't already.
// 2. Asks what to call the Worker (its address becomes https://<name>.<your-subdomain>.workers.dev).
// 3. Builds and deploys, with a setup password it makes up for you. The first deploy creates the
//    database and file store; later deploys reuse them.
// 4. Shows you the setup password and what's left, and opens the Cloudflare dashboard: you turn on
//    Cloudflare Access, open your Lumen, sign in and type the password. Lumen then records its own
//    Access settings, so nothing personal is written into this folder.
//
// Safe to run again: it redeploys the same Worker (with a new setup password, needed only until
// your Lumen is set up).
import { spawn, spawnSync } from 'node:child_process';
import { randomInt } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG = path.join(ROOT, 'wrangler.jsonc');
const WRANGLER = path.join(ROOT, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
const DASH_WORKERS = 'https://dash.cloudflare.com/?to=/:account/workers-and-pages';

const tty = process.stdout.isTTY;
const bold = (s) => (tty ? `\x1b[1m${s}\x1b[0m` : s);
const dim = (s) => (tty ? `\x1b[2m${s}\x1b[0m` : s);
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

/** Opens a web page in the default browser, if there is one (quietly does nothing otherwise). */
function openInBrowser(url) {
  const [cmd, args] =
    process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  try {
    spawn(cmd, args, { stdio: 'ignore', detached: true, windowsVerbatimArguments: process.platform === 'win32' }).on('error', () => {}).unref();
  } catch {
    /* no browser here: the link is printed anyway */
  }
}

/** Four random words from the EFF's diceware list (about 52 bits; the setup page allows 10 tries an hour). */
async function makeSetupPassword() {
  const { dictionary } = await import('@zxcvbn-ts/language-common');
  const words = dictionary['diceware-common'];
  return Array.from({ length: 4 }, () => words[randomInt(words.length)]).join('-');
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

const setupPassword = await makeSetupPassword();
// Handed to wrangler in a file of its own (deleted straight after), never on the command line.
const secretsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-setup-'));
const secretsFile = path.join(secretsDir, 'secrets.json');
let deployed;
try {
  fs.writeFileSync(secretsFile, JSON.stringify({ SETUP_PASSWORD: setupPassword }), { mode: 0o600 });
  deployed = wrangler(['deploy', '--secrets-file', secretsFile]);
} finally {
  fs.rmSync(secretsDir, { recursive: true, force: true });
}
// Wrangler writes the new resources' IDs into wrangler.jsonc. They aren't needed (later deploys find the
// resources through the deployed Worker), and leaving the file as it was keeps `git pull` conflict-free.
if (fs.readFileSync(CONFIG, 'utf8') !== config) fs.writeFileSync(CONFIG, config);
if (deployed.status !== 0) fail('The deploy failed (see above). Fix what it says, then run `npm run setup` again.');

/* ---------------------------------------------------------------- 4. finish --- */

step(4, 'Finish in your browser');
say(`Your setup password: ${bold(setupPassword)}`);
say(dim('You type it once, on your Lumen’s first page. Keep it until then (it isn’t needed after).'));
say('');
say(`  a. In the Cloudflare dashboard, open ${bold(`Workers & Pages → ${name} → Access`)}, choose`);
say(`     ${bold('Protect this Worker behind Access')} → ${bold('All traffic')}, pick a policy that lets in only you`);
say(`     (${bold('Cloudflare account')} does, if you’re its only member) and ${bold('Apply')}.`);
say(dim('     First time using Access? Cloudflare asks you to set up Zero Trust first: a team name and the'));
say(dim('     Free plan (up to 50 people). It may ask for a payment card; the Free plan isn’t charged.'));
say(`  b. Open your Lumen (the ${bold('workers.dev')} address printed above), sign in, and type the setup password.`);
say('');
if (await confirm('Open the Cloudflare dashboard now?')) openInBrowser(DASH_WORKERS);
else say(`It’s at ${DASH_WORKERS}`);

say(`\n${bold('That’s it from here.')} Your Lumen sets itself up once you type the password.`);
say(dim('Later updates: `git pull`, then `npm run deploy`. README → "Deploy your own" covers your own domain,'));
say(dim('more storage with R2, and deploying on every push to GitHub.'));
