// DISK-GATED PREP (Postgres + pgvector migration). ADDITIVE ONLY: this file is
// NOT imported by the runtime, which stays on SQLite (db/client.ts). It declares
// the TARGET Postgres schema (Drizzle pg-core) so `npx drizzle-kit generate`
// can produce a migration once disk is cleared and Postgres is provisioned. See
// docs/postgres-migration-runbook.md.
//
// The first four tables (documents / extractions / bindings / doc_chunk) MIRROR
// the SQLite schema in db/schema.ts + the raw DDL in db/client.ts, column-for-
// column. doc_chunk here additionally carries the §7 vector + FTS columns. The
// doc_contract + document_relation tables implement the §7 design DDL (数字零幻觉
// source traceability + inter-document relations) that has no SQLite equivalent.
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
  uniqueIndex,
  check,
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

/** Default timestamp column: timestamptz, defaults to now(), non-null. */
const nowTs = () => timestamp({ withTimezone: true }).defaultNow().notNull();

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
    // Phase 2 business-data isolation: owning user ('' = legacy / unscoped).
    userId: text('user_id').notNull().default(''),
    createdAt: nowTs(),
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
    // Populated via a GENERATED column (raw SQL) + GIN index; declared here so
    // the Drizzle table object is column-complete for typed repository work.
    ftsVector: tsvector('fts_vector'),
    createdAt: nowTs(),
  },
  (t) => ({
    docIdx: index('idx_doc_chunk_doc').on(t.documentId),
  }),
);

// ---- §7 design tables: contract ledger + inter-document relations ----------

/**
 * doc_contract: the trusted contract ledger. The 数字零幻觉 (zero-hallucination)
 * source triple (source_file / source_page / voucher_no) traces every monetary
 * figure back to a verifiable source location, and file_hash enables idempotent
 * re-ingest dedup (same file -> same hash -> skip or upsert, never duplicate).
 */
export const docContract = pgTable(
  'doc_contract',
  {
    contractNo: text('contract_no').primaryKey(),
    amount: numeric('amount', { precision: 18, scale: 2 }),
    currency: text('currency').default('CNY'),
    signDate: timestamp('sign_date', { withTimezone: true }),
    // 数字零幻觉 source traceability triple:
    sourceFile: text('source_file'),
    sourcePage: integer('source_page'),
    voucherNo: text('voucher_no'),
    // Idempotent dedup: hash of the source bytes (re-ingest detection).
    fileHash: text('file_hash'),
    createdAt: nowTs(),
  },
  (t) => ({
    fileHashUnique: uniqueIndex('idx_doc_contract_file_hash').on(t.fileHash),
  }),
);

/** Allowed inter-document relation types (CHECK-validated enum). */
export const DOCUMENT_RELATION_TYPES = [
  '补充协议',
  '验收单',
  '付款单',
  '发票',
  '关联交易',
] as const;
export type DocumentRelationType = (typeof DOCUMENT_RELATION_TYPES)[number];

/**
 * document_relation: typed edges between documents (e.g. an invoice supplemental
 * to a contract). relation_type is CHECK-constrained to the §7 enum; source_clause
 * + confidence preserve the grounding provenance of the link itself.
 */
export const documentRelation = pgTable(
  'document_relation',
  {
    id: serial('id').primaryKey(),
    sourceDoc: text('source_doc')
      .notNull()
      .references(() => documents.id),
    targetDoc: text('target_doc')
      .notNull()
      .references(() => documents.id),
    relationType: text('relation_type').notNull(),
    sourceClause: text('source_clause'),
    confidence: numeric('confidence', { precision: 5, scale: 4 }),
    createdAt: nowTs(),
  },
  (t) => ({
    relationTypeCheck: check(
      'document_relation_type_check',
      sql`${t.relationType} IN ('补充协议', '验收单', '付款单', '发票', '关联交易')`,
    ),
    sourceIdx: index('idx_document_relation_source').on(t.sourceDoc),
    targetIdx: index('idx_document_relation_target').on(t.targetDoc),
  }),
);
