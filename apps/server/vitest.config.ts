import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    globals: false,
    // Harness tests share the file-backed agent.db and process-global
    // RunManager state. Parallel files can reconcile another file's test-only
    // busy row as an orphan, so keep files serialized (tests within a file
    // already run sequentially).
    fileParallelism: false,
    // Runs before test modules import env.ts, pinning a hermetic parse-backend
    // env (see test/setup-env.ts for why this must stay first).
    setupFiles: ['test/setup-env.ts'],
  },
});
