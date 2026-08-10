// Postgres DbContext factory. Builds a node-postgres Pool from DATABASE_URL.
//
// The Pool is constructed SYNCHRONOUSLY and connects LAZILY (the first query
// opens a client), so createPostgresContext() returns immediately and fits the
// sync getDbContext() signature. The schema (tables + HNSW + GIN) is created
// out-of-band via `drizzle-kit migrate` + the raw HNSW/GIN SQL (see the
// runbook); this module only owns the connection, not the DDL.
//
// pgvector is assumed present (extension CREATEd during provisioning). If a
// query hits a missing `vector` operator, the failure surfaces as a normal
// Postgres error from the repo layer rather than a silent no-op.

import { Pool } from 'pg';
import type { PostgresDbContext } from './client.js';

/** Default dev connection string (matches docker-compose.pgvector.yml). */
export const DEFAULT_POSTGRES_URL =
  'postgresql://sca:sca_dev_password@localhost:5433/sca';

/**
 * Build a Postgres DbContext. Synchronous + lazy-connecting. Caller is
 * responsible for ensuring the schema is migrated (drizzle-kit) before issuing
 * repo queries. The Pool is reused as the single long-lived connection pool.
 */
export function createPostgresContext(
  databaseUrl?: string,
): PostgresDbContext {
  const url = databaseUrl ?? process.env.DATABASE_URL ?? DEFAULT_POSTGRES_URL;
  const pool = new Pool({
    connectionString: url,
    // Single-process harness; a small pool is plenty. Pool grows on demand.
    max: 10,
  });
  return { backend: 'postgres', pool };
}
