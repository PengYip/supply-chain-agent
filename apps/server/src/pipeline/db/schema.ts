import { sqliteTable, text, real, integer } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

export const documents = sqliteTable('documents', {
  id: text('id').primaryKey(),
  docType: text('doc_type').notNull(),
  modality: text('modality').notNull(),
  sourceUri: text('source_uri').notNull(),
  blockModel: text('block_model').notNull(), // JSON(BlockModel)
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
});

export const extractions = sqliteTable('extractions', {
  id: text('id').primaryKey(),
  documentId: text('document_id').notNull().references(() => documents.id),
  docType: text('doc_type').notNull(),
  fields: text('fields').notNull(),          // JSON
  fieldMeta: text('field_meta').notNull(),    // JSON
  overallConfidence: real('overall_confidence').notNull(),
  needsReview: integer('needs_review', { mode: 'boolean' }).notNull().default(false),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
});

export const bindings = sqliteTable('bindings', {
  id: text('id').primaryKey(),
  documentId: text('document_id').notNull().references(() => documents.id),
  contractNo: text('contract_no').notNull(),
  relation: text('relation').notNull(),
  sourceRefs: text('source_refs').notNull(),  // JSON
  confidence: real('confidence').notNull(),
  createdBy: text('created_by').notNull(),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
});
