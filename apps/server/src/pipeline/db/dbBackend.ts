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

import { createDb, migrate, type DbContext } from './client.js';
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
 * Build a DbContext for the configured backend.
 *
 * SQLite: createDb + migrate + enableVec. Runtime-identical to the pre-async path
 * (the async repo fns just wrap these sync calls in Promises).
 *
 * Postgres: a Pool from DATABASE_URL (or the dev default). Connections open lazily
 * on the first query. The schema (tables + HNSW + GIN) MUST be migrated already
 * via `drizzle-kit migrate` + the raw HNSW/GIN SQL (runbook step 3); this fn only
 * owns the connection, not the DDL.
 */
export function getDbContext(opts: GetDbContextOptions = {}): DbContext {
  if (DB_BACKEND === 'postgres') {
    return createPostgresContext(opts.databaseUrl);
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
