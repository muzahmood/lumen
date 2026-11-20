/**
 * Builds the app once, then starts `wrangler dev` on a free port (8796–8799) with an empty database in
 * a folder of its own under the OS temp folder. The tests find the server through LUMEN_E2E_PORT and
 * LUMEN_E2E_STATE (workers inherit this process's environment). global-teardown.ts stops it.
 *
 * LUMEN_E2E_SKIP_BUILD=1 skips the build (dist/ must be current); LUMEN_E2E_PORT picks the port.
 */
import fs from 'node:fs';
import path from 'node:path';
import { build, cleanStaleRuns, pickPort, RUNS_DIR, startServer, statePath } from './server';

export default async function globalSetup() {
  await cleanStaleRuns();
  if (process.env.LUMEN_E2E_SKIP_BUILD !== '1') build();
  const port = await pickPort();
  const dir = path.join(RUNS_DIR, `run-${Date.now().toString(36)}-${process.pid}`);
  fs.mkdirSync(dir, { recursive: true });
  const state = await startServer(port, dir);
  process.env.LUMEN_E2E_PORT = String(state.port);
  process.env.LUMEN_E2E_STATE = statePath(dir);
  process.env.LUMEN_E2E_DIR = dir;
}
