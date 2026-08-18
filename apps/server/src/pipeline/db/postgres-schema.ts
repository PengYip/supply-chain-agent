// DISK-GATED PREP (Postgres + pgvector migration). ADDITIVE ONLY: this file is
// NOT imported by the runtime, which stays on SQLite (db/client.ts). It declares
// the TARGET Postgres schema (Drizzle pg-core) so `npx drizzle-kit generate`
// can produce a migration once disk is cleared and Postgres is provisioned. See
// docs/postgres-migration-runbook.md.
//
// The first four tables (documents / extractions / bindings / doc_chunk) MIRROR
// the SQLite schema in db/schema.ts + the raw DDL in db/client.ts, column-for-
// column. doc_chunk here additionally carries the §7 vector + FTS columns. The
// §7 inter-document relation / contract-ledger tables (document_relation /
// doc_contract) that previously lived here were REMOVED in Phase 4 — they were
// dead code (no repo fn wrote them) and are superseded by the Neo4j graph
// layer (graph/repo.ts + graph/tools.ts).
//
// DEPENDENCY NOTE: drizzle-orm/pg-core ships with drizzle-orm (no new install).
// The pgvector `vector` type is declared via a customType below instead of
// pulling in `drizzle-orm/vector`, so this file adds ZERO new npm deps. The
// HNSW index and the GENERATED tsvector + GIN index cannot be expressed in
// Drizzle's column DSL, so they are emitted as raw SQL in the migration (the
// runbook documents this; a hand-edited SQL file is layered on top of
// `drizzle-kit generate` output).

import {
  pgTable,
  text,
  timestamp,
  numeric,
  integer,
  boolean,
  jsonb,
  serial,
  index,
  customType,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

// ---- pgvector + tsvector column types (no new deps) ------------------------

/**
 * pgvector column. Mirrors `drizzle-orm/vector`'s `vector()` but avoids adding
 * the optional dep. Emits raw `vector(dim)` DDL. `data` is a string (pgvector's
 * text-like literal form, e.g. '[0.1,0.2,...]'); binding/decoding is handled at
 * the repository layer when the postgres backend lands.
 */
export const vector = customType<{
  data: string;
  config: { dim: number };
}>({
  dataType(config) {
    const dim = config?.dim ?? 1024;
    return `vector(${dim})`;
  },
});

/** Postgres tsvector column for full-text search (GIN-indexed; see runbook). */
export const tsvector = customType<{ data: string }>({
  dataType() {
    return 'tsvector';
  },
});

/**
 * Default timestamp column: timestamptz, defaults to now(), non-null.
 *
 * The explicit column name `created_at` (snake_case) is required: without it
 * Drizzle emits the JS property name `createdAt` as the column name, which
 * diverged from the raw SQL in postgres-repositories.ts and the SQLite schema
 * (both `created_at`) and broke `ORDER BY created_at` on Postgres. The JS
 * property stays `createdAt`; only the physical column name is pinned.
 */
const nowTs = () => timestamp('created_at', { withTimezone: true }).defaultNow().notNull();

// ---- Mirror of the SQLite pipeline schema (db/schema.ts) -------------------

/** documents: one ingested source file's BlockModel. Mirrors SQLite documents. */
export const documents = pgTable(
  'documents',
  {
    id: text('id').primaryKey(),
    docType: text('doc_type').notNull(),
    modality: text('modality').notNull(),
    sourceUri: text('source_uri').notNull(),
    // SQLite stores this as TEXT(JSON); Postgres uses JSONB for structured query.
    blockModel: jsonb('block_model').notNull(),
    /** MinIO object key for uploads (null for tool-ingested / legacy docs). */
    minioKey: text('minio_key'),
    // Phase 2 business-data isolation: owning user ('' = legacy / unscoped).
    userId: text('user_id').notNull().default(''),
    createdAt: nowTs(),
    reviewStatus: text('review_status').notNull().default('pending'),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
    reviewedBy: text('reviewed_by'),
    // Lane A (2a): auto-extraction lifecycle status. NULL = 'pending' (opt-in).
    extractionStatus: text('extraction_status'),
    // Model B parse lifecycle: 'uploaded' stub -> 'parsing' -> 'parsed' |
    // 'needs_ocr' | 'failed'. Decouples upload (storage-only) from parsing.
    parseStatus: text('parse_status').notNull().default('uploaded'),
  },
  (t) => ({
    userIdx: index('idx_documents_user').on(t.userId),
  }),
);

/** extractions: grounded field extractions off a document. Mirrors SQLite extractions. */
export const extractions = pgTable(
  'extractions',
  {
    id: text('id').primaryKey(),
    documentId: text('document_id')
      .notNull()
      .references(() => documents.id),
    docType: text('doc_type').notNull(),
    fields: jsonb('fields').notNull(),
    fieldMeta: jsonb('field_meta').notNull(),
    // SQLite REAL -> Postgres numeric (avoids float64 precision drift on confidence).
    overallConfidence: numeric('overall_confidence', { precision: 5, scale: 4 }).notNull(),
    needsReview: boolean('needs_review').notNull().default(false),
    proposedRelationships: jsonb('proposed_relationships'),
    userId: text('user_id').notNull().default(''),
    createdAt: nowTs(),
  },
  (t) => ({
    docIdx: index('idx_extractions_doc').on(t.documentId),
    userIdx: index('idx_extractions_user').on(t.userId),
  }),
);

/** bindings: document -> contract bindings. Mirrors SQLite bindings. */
export const bindings = pgTable(
  'bindings',
  {
    id: text('id').primaryKey(),
    documentId: text('document_id')
      .notNull()
      .references(() => documents.id),
    contractNo: text('contract_no').notNull(),
    relation: text('relation').notNull(),
    sourceRefs: jsonb('source_refs').notNull(),
    confidence: numeric('confidence', { precision: 5, scale: 4 }).notNull(),
    createdBy: text('created_by').notNull(),
    userId: text('user_id').notNull().default(''),
    createdAt: nowTs(),
    // Phase B bindings state machine (mirror of the SQLite schema.ts columns).
    status: text('status').notNull().default('confirmed'),
    confirmationSource: text('confirmation_source'),
    proposedBy: text('proposed_by'),
    evidence: jsonb('evidence'),
    // 工作台确认后图谱同步结果: text 存 JSON 字符串, 与 SQLite 一致。
    graphStatus: text('graph_status'),
  },
  (t) => ({
    contractIdx: index('idx_bindings_contract').on(t.contractNo),
    userIdx: index('idx_bindings_user').on(t.userId),
  }),
);

// ---- doc_chunk: §7 chunk index with pgvector + FTS -------------------------

/**
 * doc_chunk: chunked document text for L4 recall. Mirrors the SQLite doc_chunk
 * (id / document_id / chunk_text / chunk_index / created_at) and adds the §7
 * recall columns: a 1024-dim pgvector embedding (bge-m3 dim, matches sqlite-vec)
 * and a tsvector for Postgres full-text search (replaces SQLite FTS5).
 *
 * HNSW index (added as raw SQL in the migration, Drizzle can't express pgvector
 * index ops): CREATE INDEX ... ON doc_chunk USING hnsw (embedding vector_cosine_ops);
 * FTS index: CREATE INDEX ... ON doc_chunk USING gin (fts_vector); and a
 * GENERATED column fts_vector tsvector GENERATED ALWAYS AS
 * (to_tsvector('simple', chunk_text)) STORED.
 */
export const docChunk = pgTable(
  'doc_chunk',
  {
    id: serial('id').primaryKey(),
    documentId: text('document_id')
      .notNull()
      .references(() => documents.id),
    chunkText: text('chunk_text').notNull(),
    chunkIndex: integer('chunk_index'),
    // 1024-dim to match bge-m3 / the sqlite-vec table (Task 6 v2).
    embedding: vector('embedding', { dim: 1024 }),
    // Populated via a GENERATED column + GIN index; declared here so the Drizzle
    // table object is column-complete for typed repository work. The expression
    // applies CJK unigram preprocessing (space after every char not in
    // [0-9A-Za-z ]) so to_tsvector('simple', ...) lexes Chinese runs as separate
    // unigrams instead of one opaque lexeme -- must stay in sync with
    // toPgFtsQuery() in postgres-repositories.ts and the migratePostgres() DDL
    // in client.ts (the startup migration is the DDL truth for live DBs; this
    // declaration only drives fresh drizzle-kit migrations).
    ftsVector: tsvector('fts_vector').generatedAlwaysAs(
      sql`to_tsvector('simple', regexp_replace(chunk_text, '([^0-9A-Za-z ])', '\\1 ', 'g'))`,
    ),
    // Lane B: per-chunk semantic tags (JSON string[] | NULL).
    tags: jsonb('tags'),
    createdAt: nowTs(),
  },
  (t) => ({
    docIdx: index('idx_doc_chunk_doc').on(t.documentId),
  }),
);

// ---- File manager (Phase 3+) ------------------------------------------------
//
// Virtual folders owned per-user. Mirrors the SQLite file_folders table. Files
// themselves live in MinIO (keyed users/<userId>/...); this table only records
// the user's folder entries so the file manager can render an empty folder even
// before any file is moved into it.

/** file_folders: virtual folder tree for the file manager. Mirrors SQLite file_folders. */
export const fileFolders = pgTable(
  'file_folders',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').notNull(),
    path: text('path').notNull(),
    createdAt: nowTs(),
  },
  (t) => ({
    userIdx: index('idx_file_folders_user').on(t.userId),
  }),
);
