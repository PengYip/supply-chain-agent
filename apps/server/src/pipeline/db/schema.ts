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
    reviewStatus: text('review_status').notNull().default('pending'),
    reviewedAt: text('reviewed_at'),
    reviewedBy: text('reviewed_by'),
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
    proposedRelationships: text('proposed_relationships'), // JSON(ProposedRelationship[])
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
    // Phase B bindings state machine: 存量行全部走过 L2 人工审批 -> 默认
    // 'confirmed' 语义正确。'proposed' = 系统推断待人工确认; 'rejected' = 已拒绝。
    status: text('status').notNull().default('confirmed'),
    /** 'auto_rule' = 合同号精确命中自动确认; 'human' = 人工确认; null = 历史行。 */
    confirmationSource: text('confirmation_source'),
    /** 'system' = 凭证入库自动生成; 'agent' = 工具显式调用。 */
    proposedBy: text('proposed_by'),
    /** JSON(BindingEvidence): 评分证据, 供评审卡展示。 */
    evidence: text('evidence'),
    /** JSON(BindingGraphStatus): 工作台确认后图谱同步结果。 */
    graphStatus: text('graph_status'),
  },
  (t) => ({ userIdx: index('idx_bindings_user').on(t.userId) }),
);

/**
 * Phase 2 classification: one row per document ingest. The classified docType is
 * ALSO written to documents.doc_type (so loadDocument reflects it); this row
 * carries the confidence + source + the caller's hint for audit. source:
 * 'classified' = LLM decided; 'hint' = no model; 'fallback' = LLM errored.
 */
export const classifications = sqliteTable(
  'classifications',
  {
    id: text('id').primaryKey(),
    documentId: text('document_id').notNull().references(() => documents.id),
    docType: text('doc_type').notNull(),
    confidence: real('confidence').notNull(),
    source: text('source').notNull(),
    hint: text('hint'),
    userId: text('user_id').notNull().default(''),
    createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
  },
  (t) => ({ docIdx: index('idx_classifications_doc').on(t.documentId) }),
);

/**
 * Phase 2 tags. Two sources (design §8): 'auto' = derived inside ingest_document
 * (byproduct); 'explicit' = added via the tag_document L2 tool by user/agent.
 * Graph edges are NOT tags (they live in the graph layer, Step 4).
 */
export const documentTags = sqliteTable(
  'document_tags',
  {
    id: text('id').primaryKey(),
    documentId: text('document_id').notNull().references(() => documents.id),
    tag: text('tag').notNull(),
    source: text('source').notNull(), // 'auto' | 'explicit'
    userId: text('user_id').notNull().default(''),
    createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
  },
  (t) => ({
    docIdx: index('idx_document_tags_doc').on(t.documentId),
    userIdx: index('idx_document_tags_user').on(t.userId),
  }),
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
