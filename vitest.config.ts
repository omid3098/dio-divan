import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // `@/` is the web app's source folder, as in the web build
  resolve: { alias: { '@': resolve(import.meta.dirname, 'web', 'src') } },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // A test that runs rounds, servers or child processes takes 3 to 5 seconds on a busy machine, and a shared CI runner is
    // slower than a development PC: the default 5 seconds failed one test on each system. A test that needs longer says so itself.
    testTimeout: 20_000,
    setupFiles: ['tests/setup.ts'],
    // the fake harness reports a real call's tokens (about 15k of overhead each); the tests run at a small fraction of that, so a
    // session can have many rounds under the cap. The tests of the realism itself set it back to 1.
    env: { DIVAN_FAKE_USAGE: '0.05' },
  },
});
