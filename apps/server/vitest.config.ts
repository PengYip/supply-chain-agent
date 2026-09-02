import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    globals: false,
    // Runs before test modules import env.ts, pinning a hermetic parse-backend
    // env (see test/setup-env.ts for why this must stay first).
    setupFiles: ['test/setup-env.ts'],
  },
});
