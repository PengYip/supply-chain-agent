import { sqliteTable, text, real, integer, index } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

// Phase 2 business-data isolation: every documents/extractions/bindings row is
// owned by a user (user_id). Queries filter by user_id when a userId is in scope
// so one tenant can never read another's data. The column is NOT NULL with a
// default of '' so legacy rows (and tests that don't pass a userId) keep working
// -- the repository layer skips the filter when userId is undefined/empty.
//
// Phase 3+: documents.minio_key links an ingested document back to the MinIO
// object it came from (uploads), enabling the file manager to attach a docId to
// each listed object. Nullable: tool-ingested docs (ingest_document) and legacy
// rows have no MinIO key. file_folders stores the user's virtual folder tree.

export const documents = sqliteTable(
  'documents',
  {
    id: text('id').primaryKey(),
    docType: text('doc_type').notNull(),
    modality: text('modality').notNull(),
    sourceUri: text('source_uri').notNull(),
    blockModel: text('block_model').notNull(), // JSON(BlockModel)
    /** MinIO object key for uploads (null for tool-ingested / legacy docs). */
    minioKey: text('minio_key'),
    userId: text('user_id').notNull().default(''),
    createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
  },
  (t) => ({ userIdx: index('idx_documents_user').on(t.userId) }),
);

export const extractions = sqliteTable(
  'extractions',
  {
    id: text('id').primaryKey(),
    documentId: text('document_id').notNull().references(() => documents.id),
    docType: text('doc_type').notNull(),
    fields: text('fields').notNull(),          // JSON
    fieldMeta: text('field_meta').notNull(),    // JSON
    overallConfidence: real('overall_confidence').notNull(),
    needsReview: integer('needs_review', { mode: 'boolean' }).notNull().default(false),
    userId: text('user_id').notNull().default(''),
    createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
  },
  (t) => ({ userIdx: index('idx_extractions_user').on(t.userId) }),
);

export const bindings = sqliteTable(
  'bindings',
  {
    id: text('id').primaryKey(),
    documentId: text('document_id').notNull().references(() => documents.id),
    contractNo: text('contract_no').notNull(),
    relation: text('relation').notNull(),
    sourceRefs: text('source_refs').notNull(),  // JSON
    confidence: real('confidence').notNull(),
    createdBy: text('created_by').notNull(),
    userId: text('user_id').notNull().default(''),
    createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
  },
  (t) => ({ userIdx: index('idx_bindings_user').on(t.userId) }),
);

/** Virtual folders for the file manager (Phase 3+). One row per (user, path). */
export const fileFolders = sqliteTable(
  'file_folders',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').notNull(),
    path: text('path').notNull(),
    createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
  },
  (t) => ({ userIdx: index('idx_file_folders_user').on(t.userId) }),
);
