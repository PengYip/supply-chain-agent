// Backend dispatcher. Returns a fully-initialized DbContext for the configured
// backend:
//   - sqlite  (default): createDb + migrate + enableVec (sqlite-vec best-effort)
//   - postgres: a node-postgres Pool (lazy-connecting); schema is migrated out-of-
//               band via drizzle-kit (see docs/postgres-migration-runbook.md).
//
// agent.ts getHarnessDbContext delegates here, so flipping the runtime to
// Postgres is `DB_BACKEND=postgres` + `DATABASE_URL=...` (no code change). The
// repository / vecStore layers are async on BOTH backends, so call sites do not
// branch per backend -- they just `await` once.

import {
  createDb,
  migrate,
  migratePostgres,
  type DbContext,
  type PostgresDbContext,
} from './client.js';
import { enableVec } from './vecStore.js';
import { createPostgresContext, DEFAULT_POSTGRES_URL } from './postgres-client.js';

/** Which persistence backend the harness should use. Default: SQLite (current). */
export type DbBackend = 'sqlite' | 'postgres';

/**
 * Resolved backend. Reads DB_BACKEND from env; anything other than the exact
 * string 'postgres' falls back to 'sqlite' so a misconfiguration cannot
 * accidentally select the un-provisioned backend.
 */
export const DB_BACKEND: DbBackend =
  process.env.DB_BACKEND === 'postgres' ? 'postgres' : 'sqlite';

export interface GetDbContextOptions {
  /** SQLite file path (sqlite backend only). Defaults to the harness 'pipeline.db'. */
  sqlitePath?: string;
  /** Postgres connection string (postgres backend only). Defaults to DATABASE_URL / dev. */
  databaseUrl?: string;
}

/**
 * Cached Postgres context created during startup migration. Kept so the runtime
 * getDbContext() reuses the SAME pool the startup migration ran against (no
 * second pool, no second migration). Null on sqlite or when migrateOnStartup()
 * has not run / was skipped.
 */
let startupPostgresCtx: PostgresDbContext | null = null;

/**
 * Phase 2 startup migration entry point. Runs the Postgres `user_id` column +
 * index migration (idempotent, best-effort) BEFORE the server accepts traffic.
 * Call once at boot (index.ts) and `await` it before `serve()`.
 *
 * - postgres: creates the long-lived Pool (cached as startupPostgresCtx so the
 *   runtime reuses it), then awaits migratePostgres(pool).
 * - sqlite: no-op. SQLite schema is migrated synchronously inside getDbContext()
 *   (migrate()), and the SQLite ALTER for user_id is already idempotent there.
 *
 * Never throws: migratePostgres catches + logs internally. The server always
 * boots even if Postgres is unreachable (queries then fail at runtime with a
 * clear connection error rather than crashing startup).
 */
export async function migrateOnStartup(): Promise<void> {
  if (DB_BACKEND !== 'postgres') return;
  if (startupPostgresCtx) {
    // Already initialized (e.g. called twice); just re-run the idempotent migration.
    await migratePostgres(startupPostgresCtx.pool);
    return;
  }
  startupPostgresCtx = createPostgresContext();
  await migratePostgres(startupPostgresCtx.pool);
}

/**
 * Build a DbContext for the configured backend.
 *
 * SQLite: createDb + migrate + enableVec. Runtime-identical to the pre-async path
 * (the async repo fns just wrap these sync calls in Promises).
 *
 * Postgres: a Pool from DATABASE_URL (or the dev default). Connections open lazily
 * on the first query. The schema (tables + HNSW + GIN) MUST be migrated already
 * via `drizzle-kit migrate` + the raw HNSW/GIN SQL (runbook step 3); this fn only
 * owns the connection, not the DDL. The Phase 2 `user_id` columns are ensured by
 * migrateOnStartup() (awaited at boot) -- if that has run, the cached pool is
 * reused; otherwise a fresh pool is created and migration is fired best-effort.
 */
export function getDbContext(opts: GetDbContextOptions = {}): DbContext {
  if (DB_BACKEND === 'postgres') {
    // Reuse the startup-migrated pool when available (production path).
    if (startupPostgresCtx && !opts.databaseUrl) {
      return startupPostgresCtx;
    }
    const ctx = createPostgresContext(opts.databaseUrl);
    // Fallback for callers that bypass startup (e.g. a direct test invocation
    // with a custom databaseUrl): fire the idempotent migration best-effort.
    // The pool is lazy, so this races the first query only when startup was
    // skipped -- production always goes through migrateOnStartup() first.
    void migratePostgres(ctx.pool);
    return ctx;
  }
  const ctx = createDb(opts.sqlitePath ?? 'pipeline.db');
  migrate(ctx.sqlite);
  // L4 vector recall (Task 6 v2): load sqlite-vec + create the vec0 table.
  // Graceful: if the extension cannot load (air-gapped / missing platform binary),
  // recall_documents vector/hybrid strategies fall back to fts.
  const cap = enableVec(ctx.sqlite);
  if (!cap.ok) {
    console.warn(
      '[dbBackend] sqlite-vec not available (' + (cap.version ?? 'no version') +
        '); vector/hybrid recall will fall back to fts',
    );
  }
  return ctx;
}

/** Re-exported so callers needing the dev URL default can reference it. */
export { DEFAULT_POSTGRES_URL };
