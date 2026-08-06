import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { documents, extractions, bindings } from './schema.js';

export type DbContext = { db: ReturnType<typeof drizzle>; sqlite: Database.Database };

export function createDb(path = ':memory:'): DbContext {
  const sqlite = new Database(path);
  sqlite.pragma('journal_mode = WAL');
  const db = drizzle(sqlite, { schema: { documents, extractions, bindings } });
  return { db, sqlite };
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
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_bindings_contract ON bindings(contract_no);
    CREATE INDEX IF NOT EXISTS idx_extractions_doc ON extractions(document_id);
  `);
}
