import type { Env as WorkerEnv } from '../../worker/env';

declare global {
  namespace Cloudflare {
    interface Env extends WorkerEnv {
      /** The private half of the test Access signing key (vitest.config.ts). */
      TEST_PRIVATE_JWK: string;
    }
    interface GlobalProps {
      mainModule: typeof import('../../worker/index');
    }
  }
}

export {};
