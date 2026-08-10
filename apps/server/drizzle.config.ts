// ===========================================================================
// DISK-GATED PREP (Postgres + pgvector migration). Drizzle-Kit config for the
// POSTGRES path ONLY. Lives at server/ root (outside tsconfig's src/ scope) so
// it does NOT participate in `tsc --noEmit` or the runtime build -- it is read
// solely by drizzle-kit when you run `npx drizzle-kit generate` / `migrate`.
// ===========================================================================
//
// The SQLite runtime uses raw idempotent DDL in src/pipeline/db/client.ts (no
// drizzle-kit). The Postgres path uses drizzle-kit against postgres-schema.ts.
// Both are intentional and documented in docs/postgres-migration-runbook.md.

import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: './src/pipeline/db/postgres-schema.ts',
  out: './drizzle/postgres',
  dialect: 'postgresql',
  // Credential defaults match docker-compose.yml; override with DATABASE_URL.
  dbCredentials: {
    url:
      process.env.DATABASE_URL ??
      'postgresql://sca:sca_dev_password@localhost:5432/sca',
  },
  // customTypes (vector / tsvector) emit raw SQL; the HNSW + GIN indexes and the
  // GENERATED tsvector column are layered on via a hand-edited SQL migration in
  // ./drizzle/postgres after `generate` (see the runbook).
});
