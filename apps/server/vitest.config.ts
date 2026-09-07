import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    globals: false,
    // Files run in parallel forks; each file's process-global state is isolated
    // by (a) vitest isolate (fresh module registry per file) and (b) per-file
    // hermetic data roots injected in test/setup-env.ts (SCA_DATA_DIR /
    // SCA_PIPELINE_DB / INGEST_ROOT). Nothing shares agent.db or pipeline.db
    // anymore, so the old fileParallelism:false (2026-08-18 SQLITE_BUSY
    // incidents) is gone. maxWorkers capped: the self-hosted runner shares the
    // box with the pm2 prod server + docker containers.
    maxWorkers: 4,
    // Runs before test modules import env.ts, pinning a hermetic parse-backend
    // env (see test/setup-env.ts for why this must stay first).
    setupFiles: ['test/setup-env.ts'],
  },
});
