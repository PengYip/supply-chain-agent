import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { documents, extractions, bindings } from './schema.js';
// Type-only import: erased at emit, so SQLite-only hosts do not need pg installed
// to RUN; only the Postgres path (postgres-client.ts) does a real `import { Pool }`.
import type { Pool } from 'pg';

// ---- Backend-neutral DbContext ------------------------------------------------
//
// The repo/vecStore layer is async on BOTH backends (better-sqlite3 is sync but
// every repo fn returns a Promise; node-postgres is async-only). DbContext is a
// discriminated union on `backend`: narrow with `ctx.backend === 'sqlite'` to
// reach `.sqlite`/`.db`, or `=== 'postgres'` to reach `.pool`. createDb returns
// the concrete SqliteDbContext so the many SQLite callers (tests/eval/agent) keep
// direct `.sqlite` access without narrowing.

export interface SqliteDbContext {
  backend: 'sqlite';
  db: ReturnType<typeof drizzle>;
  sqlite: Database.Database;
}

export interface PostgresDbContext {
  backend: 'postgres';
  /** node-postgres connection pool. Lazy: connections open on first query. */
  pool: Pool;
}

export type DbContext = SqliteDbContext | PostgresDbContext;

export function createDb(path = ':memory:'): SqliteDbContext {
  const sqlite = new Database(path);
  sqlite.pragma('journal_mode = WAL');
  const db = drizzle(sqlite, { schema: { documents, extractions, bindings } });
  return { backend: 'sqlite', db, sqlite };
}

/** Idempotent raw-DDL migrate (MVP). For prod, generate via `drizzle-kit generate`. */
export function migrate(sqlite: Database.Database): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS documents (
      id TEXT PRIMARY KEY,
      doc_type TEXT NOT NULL,
      modality TEXT NOT NULL,
      source_uri TEXT NOT NULL,
      block_model TEXT NOT NULL,
      user_id TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS extractions (
      id TEXT PRIMARY KEY,
      document_id TEXT NOT NULL REFERENCES documents(id),
      doc_type TEXT NOT NULL,
      fields TEXT NOT NULL,
      field_meta TEXT NOT NULL,
      overall_confidence REAL NOT NULL,
      needs_review INTEGER NOT NULL DEFAULT 0,
      user_id TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS bindings (
      id TEXT PRIMARY KEY,
      document_id TEXT NOT NULL REFERENCES documents(id),
      contract_no TEXT NOT NULL,
      relation TEXT NOT NULL,
      source_refs TEXT NOT NULL,
      confidence REAL NOT NULL,
      created_by TEXT NOT NULL,
      user_id TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_bindings_contract ON bindings(contract_no);
    CREATE INDEX IF NOT EXISTS idx_extractions_doc ON extractions(document_id);
    CREATE INDEX IF NOT EXISTS idx_documents_user ON documents(user_id);
    CREATE INDEX IF NOT EXISTS idx_extractions_user ON extractions(user_id);
    CREATE INDEX IF NOT EXISTS idx_bindings_user ON bindings(user_id);

    -- L4 document recall index (Task 6 v1, SQLite/FTS5 path). Keyword BM25 recall
    -- over chunked document text. Postgres+pgvector and sqlite-vec/semantic paths
    -- are DEFERRED; this table + FTS5 is the zero-dep keyword layer.
    CREATE TABLE IF NOT EXISTS doc_chunk (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      document_id TEXT NOT NULL REFERENCES documents(id),
      chunk_text TEXT NOT NULL,
      chunk_index INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_doc_chunk_doc ON doc_chunk(document_id);

    -- External-content FTS5 index: chunk_text lives once in doc_chunk, the FTS
    -- table holds only the BM25 index (content_rowid maps FTS rowid -> doc_chunk.id).
    -- Populated manually in saveChunks (single ingest write path), not via triggers.
    CREATE VIRTUAL TABLE IF NOT EXISTS doc_chunk_fts USING fts5(
      chunk_text,
      content='doc_chunk',
      content_rowid='id'
    );
  `);

  // Phase 2 business-data isolation: add user_id to pre-existing dev databases.
  // CREATE TABLE IF NOT EXISTS does not add columns to an already-existing table,
  // so ALTER is needed for databases created before the user_id columns landed.
  // Guarded per-table (duplicate column -> SQLITE_ERROR) so re-running is safe.
  for (const tbl of ['documents', 'extractions', 'bindings']) {
    const cols = sqlite.prepare(`PRAGMA table_info(${tbl})`).all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === 'user_id')) {
      try {
        sqlite.exec(`ALTER TABLE ${tbl} ADD COLUMN user_id TEXT NOT NULL DEFAULT ''`);
      } catch {
        // Column may have been added concurrently; safe to ignore.
      }
    }
  }
}

/**
 * Phase 2 startup migration for Postgres: add `user_id` columns + indexes to the
 * documents/extractions/bindings tables when they were created by an older schema
 * (drizzle-kit created them WITHOUT user_id before Phase 2). Idempotent via
 * ADD COLUMN IF NOT EXISTS / CREATE INDEX IF NOT EXISTS -- safe to run on every
 * startup.
 *
 * Best-effort: wraps everything in try/catch and logs a warning on failure rather
 * than throwing, so the server still boots (a subsequent query needing user_id
 * then surfaces a clear column-missing error at runtime instead of crashing
 * startup). Statements run individually (not one multi-statement query) so this
 * is robust behind pgBouncer transaction mode and reports per-statement errors.
 *
 * Mirror of the SQLite ALTER loop in migrate(); the IF NOT EXISTS guard makes the
 * per-DBMS duplication unnecessary on the Postgres side.
 */
export async function migratePostgres(pool: Pool): Promise<void> {
  const statements = [
    `ALTER TABLE documents ADD COLUMN IF NOT EXISTS user_id TEXT NOT NULL DEFAULT ''`,
    `ALTER TABLE extractions ADD COLUMN IF NOT EXISTS user_id TEXT NOT NULL DEFAULT ''`,
    `ALTER TABLE bindings ADD COLUMN IF NOT EXISTS user_id TEXT NOT NULL DEFAULT ''`,
    `CREATE INDEX IF NOT EXISTS documents_user_id_idx ON documents(user_id)`,
    `CREATE INDEX IF NOT EXISTS extractions_user_id_idx ON extractions(user_id)`,
    `CREATE INDEX IF NOT EXISTS bindings_user_id_idx ON bindings(user_id)`,
  ];
  try {
    for (const sql of statements) {
      await pool.query(sql);
    }
  } catch (e) {
    console.warn(
      '[migratePostgres] user_id column/index migration failed (continuing; ' +
        'tables may pre-date Phase 2 or Postgres is unreachable):',
      e instanceof Error ? e.message : e,
    );
  }
}
