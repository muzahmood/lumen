/**
 * The local Lumen server the end-to-end tests run against: the built app and API from `wrangler dev`
 * with a database of its own, so every run starts from an empty library.
 *
 * Windows gotcha this file exists for: ending `wrangler dev` (or the shell around it) leaves its child
 * processes (wrangler's node processes and workerd) running and still serving the old code on the port.
 * So the server is started here directly (node + wrangler's own entry point, no npx or shell), and torn
 * down by killing its whole process tree, then checking every process of that tree is gone and the port
 * is free. Only processes that descend from the one started here are ever killed.
 */
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
/** Ports the suite may use (8787 and 5173 belong to `npm run dev`). */
export const PORTS = [8796, 8797, 8798, 8799];
/** Every run's database and state live under here, one folder per run. */
export const RUNS_DIR = path.join(os.tmpdir(), 'lumen-e2e');
const isWindows = process.platform === 'win32';

export interface RunState {
  port: number;
  /** The wrangler process this run started (the root of the server's process tree). */
  pid: number;
  /** The Playwright runner that started it: while that's running, the server is in use. */
  runner: number;
  dir: string;
  persistTo: string;
  log: string;
  startedAt: number;
}

export const statePath = (dir: string) => path.join(dir, 'state.json');

/** True if nothing listens on the port, on either loopback address (Chrome tries ::1 first for localhost). */
export async function portFree(port: number): Promise<boolean> {
  const tryListen = (host: string) =>
    new Promise<boolean>((resolve) => {
      const srv = net.createServer();
      srv.once('error', (err: NodeJS.ErrnoException) => resolve(err.code === 'EADDRNOTAVAIL' || err.code === 'EAFNOSUPPORT'));
      srv.listen({ port, host, exclusive: true }, () => srv.close(() => resolve(true)));
    });
  const connects = (host: string) =>
    new Promise<boolean>((resolve) => {
      const sock = net.connect({ port, host });
      sock.setTimeout(500);
      sock.once('connect', () => {
        sock.destroy();
        resolve(true);
      });
      sock.once('timeout', () => {
        sock.destroy();
        resolve(false);
      });
      sock.once('error', () => resolve(false));
    });
  for (const host of ['127.0.0.1', '::1']) {
    if (await connects(host)) return false;
    if (!(await tryListen(host))) return false;
  }
  return true;
}

export async function pickPort(): Promise<number> {
  const wanted = Number(process.env.LUMEN_E2E_PORT || 0);
  const candidates = wanted ? [wanted] : PORTS;
  for (const port of candidates) if (await portFree(port)) return port;
  throw new Error(`No free port for the e2e server among ${candidates.join(', ')}.`);
}

/** Process ids of `pid` and everything descended from it (Windows: from Win32_Process). */
export function processTree(pid: number): number[] {
  if (!isWindows) {
    try {
      const out = execFileSync('ps', ['-A', '-o', 'pid=,ppid='], { encoding: 'utf8' });
      const kids = new Map<number, number[]>();
      for (const line of out.trim().split('\n')) {
        const [p, pp] = line.trim().split(/\s+/).map(Number);
        kids.set(pp, [...(kids.get(pp) ?? []), p]);
      }
      const all: number[] = [];
      const walk = (p: number) => {
        all.push(p);
        for (const k of kids.get(p) ?? []) walk(k);
      };
      walk(pid);
      return all;
    } catch {
      return [pid];
    }
  }
  try {
    const out = execFileSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', 'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId)" }'],
      { encoding: 'utf8', windowsHide: true },
    );
    const kids = new Map<number, number[]>();
    for (const line of out.trim().split(/\r?\n/)) {
      const [p, pp] = line.trim().split(/\s+/).map(Number);
      if (!p) continue;
      kids.set(pp, [...(kids.get(pp) ?? []), p]);
    }
    const all: number[] = [];
    const seen = new Set<number>();
    const walk = (p: number) => {
      if (seen.has(p)) return;
      seen.add(p);
      all.push(p);
      for (const k of kids.get(p) ?? []) walk(k);
    };
    walk(pid);
    return all;
  } catch {
    return [pid];
  }
}

export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** The command line of a running process, or null (used to check an old run's process is still ours). */
function commandLine(pid: number): string | null {
  try {
    if (isWindows) {
      return execFileSync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`],
        { encoding: 'utf8', windowsHide: true },
      ).trim();
    }
    return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ');
  } catch {
    return null;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Kills `pid` and its whole tree, then waits until every one of them is gone. */
export async function killTree(pid: number): Promise<void> {
  const tree = processTree(pid).filter(alive);
  if (!tree.length) return;
  if (isWindows) {
    try {
      execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    } catch {
      /* already gone, or some children left: handled below */
    }
  } else {
    try {
      process.kill(-pid, 'SIGTERM');
    } catch {
      /* not a group leader, or gone */
    }
  }
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const left = tree.filter(alive);
    if (!left.length) return;
    // Anything the tree kill missed (re-parented children, say) is killed one by one: all of these
    // descended from the server this suite started.
    for (const p of left) {
      try {
        if (isWindows) execFileSync('taskkill', ['/PID', String(p), '/F'], { stdio: 'ignore', windowsHide: true });
        else process.kill(p, 'SIGKILL');
      } catch {
        /* gone meanwhile */
      }
    }
    await sleep(250);
  }
  const left = tree.filter(alive);
  if (left.length) throw new Error(`e2e server processes still running after kill: ${left.join(', ')}`);
}

export async function waitPortFree(port: number, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await portFree(port)) return;
    await sleep(250);
  }
  throw new Error(`Port ${port} is still in use after stopping the e2e server.`);
}

/**
 * Stops servers left by earlier runs that never got to tear down (a killed terminal, say): only once
 * the Playwright runner that started one has gone (so a run going on in another terminal is left
 * alone), and only if the process recorded then is still running with that run's own folder and port
 * on its command line.
 */
export async function cleanStaleRuns(): Promise<void> {
  if (!fs.existsSync(RUNS_DIR)) return;
  for (const name of fs.readdirSync(RUNS_DIR)) {
    const dir = path.join(RUNS_DIR, name);
    let state: RunState | null = null;
    try {
      state = JSON.parse(fs.readFileSync(statePath(dir), 'utf8')) as RunState;
    } catch {
      state = null;
    }
    if (state && state.runner !== undefined && alive(state.runner) && state.runner !== process.pid) continue; // still in use
    if (state && alive(state.pid)) {
      const cmd = commandLine(state.pid);
      if (!cmd || !cmd.includes(path.basename(state.dir)) || !cmd.includes(String(state.port))) continue; // not ours any more
      await killTree(state.pid).catch(() => undefined);
    }
    // Old runs' folders go once nothing of theirs is running (one without a state file yet may be a
    // run that's starting, so only once it's a few minutes old).
    const age = Date.now() - fs.statSync(dir).mtimeMs;
    if (state ? !alive(state.pid) : age > 10 * 60_000) {
      try {
        fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
      } catch {
        /* still held open by something: tried again next run */
      }
    }
  }
}

/**
 * Builds the app into dist/ with Vite itself (what `npm run build` does after its typecheck): the tests
 * need the built app, and type errors are `npm run typecheck`'s to report.
 */
export function build(): void {
  const vite = path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
  execFileSync(process.execPath, [vite, 'build', '--logLevel', 'warn'], { cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'], windowsHide: true });
}

/** Starts `wrangler dev` on `port` with an empty database in `dir`, and waits until /api/me answers. */
export async function startServer(port: number, dir: string): Promise<RunState> {
  const persistTo = path.join(dir, 'db');
  const log = path.join(dir, 'wrangler.log');
  fs.mkdirSync(persistTo, { recursive: true });
  const out = fs.openSync(log, 'a');
  const wrangler = path.join(ROOT, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
  const child = spawn(
    process.execPath,
    [
      wrangler,
      'dev',
      '--local',
      '--ip',
      '127.0.0.1',
      '--port',
      String(port),
      '--var',
      'LOCAL_DEV:true',
      '--local-upstream',
      `localhost:${port}`,
      '--persist-to',
      persistTo,
      '--show-interactive-dev-session=false',
      '--log-level',
      'warn',
    ],
    {
      cwd: ROOT,
      stdio: ['ignore', out, out],
      // Its own process group elsewhere, so the whole group can be signalled; Windows uses taskkill /T.
      detached: !isWindows,
      windowsHide: true,
      env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: '1', NO_COLOR: '1', FORCE_COLOR: '0' },
    },
  );
  fs.closeSync(out);
  if (!child.pid) throw new Error('Could not start wrangler dev.');
  const state: RunState = { port, pid: child.pid, runner: process.pid, dir, persistTo, log, startedAt: Date.now() };
  fs.writeFileSync(statePath(dir), JSON.stringify(state, null, 2));

  let exited: number | null = null;
  child.once('exit', (code) => (exited = code ?? -1));
  child.unref();

  const url = `http://localhost:${port}/api/me`;
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (exited !== null) break;
    try {
      const res = await fetch(url, { headers: { 'x-kb-client': '1' } });
      if (res.ok && (res.headers.get('content-type') ?? '').includes('application/json')) return state;
    } catch {
      /* not up yet */
    }
    await sleep(300);
  }
  await killTree(child.pid).catch(() => undefined);
  const tail = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').slice(-30).join('\n') : '';
  throw new Error(`wrangler dev didn't answer ${url}${exited !== null ? ` (exited with ${exited})` : ''}.\n${tail}`);
}

export async function stopServer(state: RunState): Promise<void> {
  await killTree(state.pid);
  await waitPortFree(state.port);
}
