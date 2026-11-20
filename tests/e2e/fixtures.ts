/**
 * The `test` every journey uses: the base URL of the server global-setup.ts started, and a guard that
 * fails the test on any console error or uncaught page error that the test didn't say to expect
 * (`guard.allow(/…/)`), in its own browser context and in any extra "device" made with `device()`.
 */
import { expect, test as base, type BrowserContext, type BrowserContextOptions, type Page } from '@playwright/test';

export { expect };

export interface Guard {
  /** Console errors matching any of these are expected in this test (a deliberate offline spell, a 409). */
  allow(...patterns: RegExp[]): void;
  /** Starts watching another context's pages (done for you by `device()`). */
  watch(context: BrowserContext, label: string): void;
  /** Problems seen so far that weren't allowed. */
  problems(): string[];
}

export interface Device {
  context: BrowserContext;
  page: Page;
}

interface Fixtures {
  guard: Guard;
  /** A second (third…) device: a browser context of its own, so its own storage and keys. */
  device: (options?: BrowserContextOptions & { label?: string }) => Promise<Device>;
}

/** Noise from the browser itself, allowed in every test (none needed so far: the app runs clean). */
const ALWAYS_ALLOWED: RegExp[] = [];

export const test = base.extend<Fixtures>({
  baseURL: async ({}, use) => {
    const port = process.env.LUMEN_E2E_PORT;
    if (!port) throw new Error('LUMEN_E2E_PORT is not set: run the suite through `npm run test:e2e` (global setup starts the server).');
    await use(`http://localhost:${port}`);
  },

  guard: [
    async ({ context }, use, testInfo) => {
      const seen: string[] = [];
      const allowed: RegExp[] = [...ALWAYS_ALLOWED];
      const watched = new WeakSet<BrowserContext>();
      const attach = (page: Page, label: string) => {
        page.on('console', (msg) => {
          if (msg.type() !== 'error') return;
          const where = msg.location()?.url ? ` (${msg.location().url})` : '';
          seen.push(`[${label}] console.error: ${msg.text()}${where}`);
        });
        page.on('pageerror', (err) => seen.push(`[${label}] pageerror: ${err.name}: ${err.message}`));
      };
      const guard: Guard = {
        allow: (...patterns) => allowed.push(...patterns),
        watch: (ctx, label) => {
          if (watched.has(ctx)) return;
          watched.add(ctx);
          ctx.pages().forEach((p) => attach(p, label));
          ctx.on('page', (p) => attach(p, label));
        },
        problems: () => seen.filter((line) => !allowed.some((re) => re.test(line))),
      };
      guard.watch(context, 'device 1');
      await use(guard);
      const problems = guard.problems();
      if (seen.length) await testInfo.attach('console-errors.txt', { body: seen.join('\n'), contentType: 'text/plain' });
      expect(problems, 'unexpected console errors or page errors').toEqual([]);
    },
    { auto: true },
  ],

  device: async ({ browser, baseURL, guard }, use, testInfo) => {
    const made: BrowserContext[] = [];
    let n = 1;
    await use(async ({ label, ...options } = {}) => {
      n++;
      const { viewport, locale, serviceWorkers } = testInfo.project.use;
      const context = await browser.newContext({ viewport, locale, serviceWorkers, baseURL, ...options });
      guard.watch(context, label ?? `device ${n}`);
      made.push(context);
      const page = await context.newPage();
      return { context, page };
    });
    // (Playwright traces these contexts too, with the test's own trace setting.)
    for (const context of made) await context.close();
  },
});
