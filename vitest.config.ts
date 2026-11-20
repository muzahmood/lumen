import { generateKeyPairSync } from 'node:crypto';
import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

/**
 * Two test projects:
 * - `worker`: the real Worker (worker/index.ts) inside workerd, with local D1 and KV (fresh per test
 *   file). Cloudflare Access is played by a key pair made here: its public half is served as the
 *   team's certificates, its private half is handed to the tests so they can sign real tokens.
 * - `unit`: the app's code in Node, or in jsdom for the DOM (`// @vitest-environment jsdom`; not
 *   happy-dom, where DOMPurify gives wrong results), against a stand-in server; fake-indexeddb for IndexedDB.
 * Nothing touches the Cloudflare account: remote bindings are off and outbound fetches are stubbed.
 */
const TEAM = 'https://lumen-test.cloudflareaccess.com';
const AUD = 'a'.repeat(64);
const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const publicJwk = { ...publicKey.export({ format: 'jwk' }), kid: 'test-key', alg: 'RS256', use: 'sig' };
const privateJwk = privateKey.export({ format: 'jwk' });

export default defineConfig({
  test: {
    // Workers Builds (which sets WORKERS_CI) runs the suite before each deploy on 2 vCPUs, but Node
    // there can count the host's cores and start a test worker for each, all sharing those two.
    maxWorkers: process.env.WORKERS_CI ? 2 : undefined,
    projects: [
      {
        plugins: [
          cloudflareTest({
            remoteBindings: false,
            wrangler: { configPath: './wrangler.jsonc' },
            miniflare: {
              // Test values replace the deployed Access settings, so no real account or address is involved.
              bindings: {
                LOCAL_DEV: 'true',
                ACCESS_TEAM_DOMAIN: TEAM,
                ACCESS_AUD: AUD,
                ACCESS_ALLOWED_EMAILS: 'owner@example.com',
                TEST_PRIVATE_JWK: JSON.stringify(privateJwk),
              },
              outboundService(request: Request) {
                const url = new URL(request.url);
                if (url.origin === TEAM && url.pathname === '/cdn-cgi/access/certs') {
                  return new Response(JSON.stringify({ keys: [publicJwk] }), { headers: { 'Content-Type': 'application/json' } });
                }
                return new Response(`Unexpected outbound request in tests: ${request.method} ${request.url}`, { status: 599 });
              },
            },
          }),
        ],
        // Generous, as this gates deploys: encryption-heavy tests take a few seconds on a busy or slow
        // build machine, and a test that waits on real async work can come up short once under load.
        // A real failure fails twice in a row; Vitest reports any test that only passed on its retry.
        test: { name: 'worker', include: ['tests/worker/**/*.test.ts'], testTimeout: 30_000, hookTimeout: 30_000, retry: 1 },
      },
      {
        test: { name: 'unit', include: ['tests/unit/**/*.test.{ts,tsx}'], environment: 'node', testTimeout: 30_000, hookTimeout: 30_000, retry: 1 },
      },
    ],
  },
});
