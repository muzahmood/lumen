/**
 * Stops the server global-setup.ts started: its whole process tree (wrangler's node processes and
 * workerd), checks they're all gone and the port is free, then deletes the run's database folder.
 */
import fs from 'node:fs';
import { stopServer, type RunState } from './server';

export default async function globalTeardown() {
  const file = process.env.LUMEN_E2E_STATE;
  if (!file || !fs.existsSync(file)) return;
  const state = JSON.parse(fs.readFileSync(file, 'utf8')) as RunState;
  await stopServer(state);
  if (process.env.LUMEN_E2E_KEEP !== '1') {
    try {
      fs.rmSync(state.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      /* a file still held open by the OS: cleanStaleRuns() removes it next time */
    }
  }
}
