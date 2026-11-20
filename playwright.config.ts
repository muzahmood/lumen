import { defineConfig } from '@playwright/test';

/**
 * Browser end-to-end tests: `npm run test:e2e` (not part of `npm test`, which runs only Vitest).
 *
 * global-setup.ts builds the app and starts `wrangler dev` on a free port in 8796–8799 with an empty
 * database of its own (under the OS temp folder); global-teardown.ts stops it and checks nothing of it
 * is left running. Tests run in the installed Google Chrome (no Playwright browsers are downloaded).
 *
 * The journeys share that one library and run in file order, one at a time: 01 sees the brand-new
 * library (welcome note), 02 turns on end-to-end encryption, and from then on the library is encrypted,
 * as the owner keeps it; 12 (replacing the key) goes last. A file run on its own turns encryption on
 * first if it needs it (openEncrypted in app.ts). Each run starts from an empty database, so a run
 * never depends on an earlier one.
 */
const port = process.env.LUMEN_E2E_PORT ?? '8796';

export default defineConfig({
  testDir: 'tests/e2e',
  testMatch: '**/*.spec.ts',
  outputDir: 'test-results/e2e',
  globalSetup: './tests/e2e/global-setup.ts',
  globalTeardown: './tests/e2e/global-teardown.ts',
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  forbidOnly: !!process.env.CI,
  timeout: 90_000,
  expect: { timeout: 10_000 },
  reporter: [['list'], ['html', { outputFolder: 'playwright-report', open: 'never' }]],
  use: {
    channel: 'chrome',
    // Overridden per test from LUMEN_E2E_PORT (set by global setup) in fixtures.ts.
    baseURL: `http://localhost:${port}`,
    viewport: { width: 1440, height: 900 },
    locale: 'en-US',
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
    serviceWorkers: 'allow',
  },
  projects: [{ name: 'chrome', use: { channel: 'chrome' } }],
});
