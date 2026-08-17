import { eq, and, or, isNull, desc } from 'drizzle-orm';
import { documents, extractions, bindings, classifications } from './schema.js';
import type { DbContext } from './client.js';
import type { BlockModel, DocType, Modality, SourceSpan } from '../types.js';
import type { SpanMatchStrength } from '../spanValidator.js';
import { normalizeContractNo } from '../contractLedger.js';
import type { ContractLedgerEntry } from '../contractLedger.js';
// Postgres impls. Static import: pg is a declared dep on both backends now; the
// functions are only CALLED on the postgres branch (lazy Pool connect), so the
// import cost is one module load. Type-only for the input/output types below.
import {
  saveDocumentPg,
  loadDocumentPg,
  saveExtractionPg,
  saveBindingPg,
  listBindingsForContractPg,
  saveChunksPg,
  searchChunksPg,
  getChunkMetaByRowidsPg,
  setDocumentMinioKeyPg,
  findDocIdsByMinioKeysPg,
  listFileFoldersPg,
  createFileFolderPg,
  deleteFileFolderPg,
  // pg parity for the previously-stubbed fns.
  countDocumentsPg,
  countExtractionsNeedingReviewPg,
  loadExtractionPg,
  saveClassificationPg,
  loadClassificationPg,
  saveDocumentTagsPg,
  listDocumentTagsPg,
  deleteDocumentPg,
  // post-ingest review (Task 3): pg twins for review snapshot + status + extraction update.
  getReviewSnapshotPg,
  setReviewStatusPg,
  updateExtractionFieldsPg,
  // persisted vectorization outcome (Bug fix): pg twin for setDocumentVectorization.
  setDocumentVectorizationPg,
  // Lane A (2a): pg twin for setExtractionStatus (auto-extraction lifecycle).
  setExtractionStatusPg,
  getExtractionStatusPg,
  // post-ingest review (Task 7): pg twin for latest-extraction-by-doc lookup.
  loadLatestExtractionByDocIdPg,
  // Model B (decouple upload from parse): pg twins for stub + parse lifecycle.
  createDocumentStubPg,
  updateDocumentMetaPg,
  setDocumentParseStatusPg,
  getDocumentParseStatusPg,
  getDocumentSourceUriPg,
  // contract ledger (ingest extraction write-back): pg twins.
  upsertContractLedgerEntryPg,
  findContractLedgerByNoPg,
} from './postgres-repositories.js';

// Phase 2 business-data isolation: a normalized userId is '' / undefined when the
// caller is unscoped (legacy path, most tests). When a non-empty userId IS in
// scope, repository fns filter every read by it so one tenant cannot see
// another's documents / extractions / bindings / chunks. Writes stamp the row.
export function effectiveUserId(userId?: string): string {
  return userId && userId.length > 0 ? userId : '';
}

/**
 * Count document rows visible to the caller (caller's own rows + legacy
 * user_id='' / NULL rows).
 */
export async function countDocuments(ctx: DbContext, userId?: string): Promise<number> {
  if (ctx.backend === 'postgres') return countDocumentsPg(ctx, userId);
  const uid = effectiveUserId(userId);
  const row = ctx.sqlite
    .prepare(
      "SELECT COUNT(*) AS n FROM documents WHERE user_id = ? OR user_id = '' OR user_id IS NULL",
    )
    .get(uid) as { n: number } | undefined;
  return row?.n ?? 0;
}

/**
 * Count extraction rows flagged needs_review visible to the caller. needs_review
 * is stored INTEGER 0/1 on SQLite (drizzle boolean mode); on pg it is boolean.
 */
export async function countExtractionsNeedingReview(ctx: DbContext, userId?: string): Promise<number> {
  if (ctx.backend === 'postgres') return countExtractionsNeedingReviewPg(ctx, userId);
  const uid = effectiveUserId(userId);
  const row = ctx.sqlite
    .prepare(
      "SELECT COUNT(*) AS n FROM extractions WHERE needs_review = 1 AND (user_id = ? OR user_id = '' OR user_id IS NULL)",
    )
    .get(uid) as { n: number } | undefined;
  return row?.n ?? 0;
}

export interface ExtractionInput {
  documentId: string;
  docType: DocType;
  fields: Record<string, { value: string | number; sourceSpans: SourceSpan[] }>;
  fieldMeta: Record<string, { strength: SpanMatchStrength; confidence: number }>;
  overallConfidence: number;
  needsReview: boolean;
  /** Optional proposed graph relationships extracted alongside fields (Task 3). */
  proposedRelationships?: ProposedRelationship[];
}

export interface BindingInput {
  documentId: string;
  contractNo: string;
  relation: string;
  sourceRefs: SourceSpan[];
  confidence: number;
  createdBy: string;
}

export interface BindingRow {
  id: string;
  documentId: string;
  contractNo: string;
  relation: string;
  sourceRefs: SourceSpan[];
  confidence: number;
  createdBy: string;
}

// ---- Post-ingest review (Task 3) -------------------------------------------
//
// After ingest the user reviews the assembled snapshot (docType + tags +
// extraction fields + proposed relationships) and either confirms it or
// corrects the extracted fields. review_status tracks that lifecycle; the
// snapshot is the single 5-dimension read the review UI/tools consume.

export type ReviewStatus = 'pending' | 'confirmed' | 'corrected';

/**
 * Model B parse lifecycle for a document stub. Upload creates the row as
 * 'uploaded' (storage-only, no parse); POST /api/documents/:docId/process drives
 * it through 'parsing' -> 'parsed' on success, or 'needs_ocr' (0 blocks / OCR
 * error) / 'failed' (unexpected error) on failure. Process-layer failures are
 * STATES, not thrown exceptions, so upload is never coupled to parsing.
 */
export type ParseStatus = 'uploaded' | 'parsing' | 'parsed' | 'needs_ocr' | 'failed';

/**
 * Lane A (2a): auto-extraction lifecycle status stamped on documents.
 * NULL on legacy rows is read as 'pending' (opt-in; no backfill). 'running' is
 * set just before the model call; the terminal states are written by
 * runAutoExtraction via setExtractionStatus.
 */
export type ExtractionStatus = 'pending' | 'running' | 'ok' | 'skipped' | 'failed';

export interface ProposedRelationship {
  kind: 'Party' | 'Commodity' | 'Contract';
  role?: string; // Party only: 买方|卖方
  name: string;
  sourceSpan?: unknown;
  confidence: number;
}

/**
 * 确定性边提议（design 2026-08-17 §3.2）。恒为 Document -> 实体；dstKind/dstName
 * 定位目标节点（写入时按 kind+归一化名 MERGE）。'executes' 是文件间"该单据是
 * 合同执行的结果"边（doc -> Contract 枢纽）。
 */
export interface ProposedEdge {
  type: 'party' | 'commodity' | 'references' | 'executes';
  dstKind: 'Party' | 'Commodity' | 'Contract';
  dstName: string;
  /** party 边专用：买方|卖方|发货人|收货人|承运人 */
  role?: string;
  confidence: number;
}

/**
 * Persisted vectorization outcome for a document. Defined here (NOT imported
 * from documentEntry.ts) to avoid a circular dependency: documentEntry imports
 * from repositories, so the type must live on this side. The 'unknown' status
 * is the fallback when vectorization_meta has never been written (legacy rows,
 * saveDocument-direct tests) — mirrors the present_document_review pre-fix
 * default so the UI shows 'unknown' rather than crashing.
 */
export type DocumentVectorization = {
  status: 'ok' | 'skipped' | 'failed' | 'unknown';
  mode: string;
  chunkCount: number;
  reason?: string;
};

/** Default vectorization snapshot when no outcome has been persisted yet. */
export const UNKNOWN_VECTORIZATION: DocumentVectorization = {
  status: 'unknown',
  mode: 'unknown',
  chunkCount: 0,
};

export interface ReviewSnapshot {
  docId: string;
  docType: string;
  classificationConfidence: number;
  tags: string[];
  /** Lane B: distinct per-chunk semantic tags, order of first appearance across
   *  chunk_index (deduped, capped at CHUNK_TAGS_CAP). Surfaces 分段标签 on the card. */
  chunkTags: string[];
  /** Lane B detail view: each tag with the chunks it classified (分段标签详情).
   *  Tags in first-appearance order (CHUNK_TAGS_CAP), chunks per tag by
   *  chunk_index, chunk text capped at CHUNK_TAG_TEXT_CAP. Empty array when the
   *  doc has no chunk tags. */
  chunkTagDetails: ChunkTagDetail[];
  reviewStatus: ReviewStatus;
  fields: Array<{ name: string; value: string | number; confidence: number; needsReview: boolean }>;
  overallConfidence: number;
  proposedRelationships: ProposedRelationship[];
  /** Persisted L4 vector-embedding outcome (Bug fix: was a lost in-memory Map). */
  vectorization: DocumentVectorization;
}

const rid = (p: string) => `${p}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

// All repository fns are ASYNC on BOTH backends. The SQLite branch just wraps its
// existing sync better-sqlite3 call in `async` (returns a Promise) -- runtime
// behavior is byte-identical to the pre-async version. The Postgres branch
// delegates to the pg impl in postgres-repositories.ts. Callers `await` once;
// no per-call-site branching.

export async function saveDocument(ctx: DbContext, model: BlockModel, userId?: string): Promise<string> {
  if (ctx.backend === 'postgres') return saveDocumentPg(ctx, model, userId);
  ctx.db.insert(documents).values({
    id: model.docId,
    docType: model.docType,
    modality: model.modality,
    sourceUri: model.sourceUri,
    blockModel: JSON.stringify(model),
    userId: effectiveUserId(userId),
  }).run();
  return model.docId;
}

export async function loadDocument(ctx: DbContext, docId: string, userId?: string): Promise<BlockModel | null> {
  if (ctx.backend === 'postgres') return loadDocumentPg(ctx, docId, userId);
  const uid = effectiveUserId(userId);
  // Legacy rows (pre-Phase 2) have user_id = '' (or NULL) and must stay
  // accessible to any authenticated caller -- a strict `user_id = uid` filter
  // would hide them. Same convention as findDocIdsByMinioKeys.
  const filter = uid
    ? and(
        eq(documents.id, docId),
        or(eq(documents.userId, uid), eq(documents.userId, ''), isNull(documents.userId)),
      )
    : eq(documents.id, docId);
  const row = ctx.db.select().from(documents).where(filter).all()[0];
  return row ? (JSON.parse(row.blockModel) as BlockModel) : null;
}

export interface ExtractionRow {
  id: string;
  documentId: string;
  docType: DocType;
  fields: Record<string, { value: string | number; sourceSpans: SourceSpan[] }>;
  fieldMeta: Record<string, { strength: SpanMatchStrength; confidence: number }>;
  overallConfidence: number;
  needsReview: boolean;
}

/**
 * Load a single extraction row by id. Used by the inspect_extraction L1 tool
 * for on-demand field-evidence drill-down. Same userId-legacy filter as
 * loadDocument (rows with user_id = '' / NULL stay readable by any caller).
 */
export async function loadExtraction(
  ctx: DbContext,
  extractionId: string,
  userId?: string,
): Promise<ExtractionRow | null> {
  if (ctx.backend === 'postgres') return loadExtractionPg(ctx, extractionId, userId);
  const uid = effectiveUserId(userId);
  const filter = uid
    ? and(
        eq(extractions.id, extractionId),
        or(eq(extractions.userId, uid), eq(extractions.userId, ''), isNull(extractions.userId)),
      )
    : eq(extractions.id, extractionId);
  const row = ctx.db.select().from(extractions).where(filter).all()[0];
  if (!row) return null;
  return {
    id: row.id,
    documentId: row.documentId,
    docType: row.docType as DocType,
    fields: JSON.parse(row.fields as string),
    fieldMeta: JSON.parse(row.fieldMeta as string),
    overallConfidence: row.overallConfidence,
    needsReview: !!row.needsReview,
  };
}

/**
 * Load the latest extraction row for a document (most recent by created_at).
 * Used by the update_document_fields L2 correction tool (Task 7) to merge
 * user corrections onto the current full-fields + fieldMeta state. Same
 * userId-legacy filter as loadExtraction (rows with user_id = '' / NULL stay
 * readable by any caller). Mirrors loadExtraction but keyed on document_id
 * with ORDER BY created_at DESC LIMIT 1.
 */
export async function loadLatestExtractionByDocId(
  ctx: DbContext,
  docId: string,
  userId?: string,
): Promise<ExtractionRow | null> {
  if (ctx.backend === 'postgres') return loadLatestExtractionByDocIdPg(ctx, docId, userId);
  const uid = effectiveUserId(userId);
  const filter = uid
    ? and(
        eq(extractions.documentId, docId),
        or(eq(extractions.userId, uid), eq(extractions.userId, ''), isNull(extractions.userId)),
      )
    : eq(extractions.documentId, docId);
  const row = ctx.db
    .select()
    .from(extractions)
    .where(filter)
    .orderBy(desc(extractions.createdAt))
    .limit(1)
    .all()[0];
  if (!row) return null;
  return {
    id: row.id,
    documentId: row.documentId,
    docType: row.docType as DocType,
    fields: JSON.parse(row.fields as string),
    fieldMeta: JSON.parse(row.fieldMeta as string),
    overallConfidence: row.overallConfidence,
    needsReview: !!row.needsReview,
  };
}

export interface ClassificationInput {
  documentId: string;
  docType: DocType;
  confidence: number;
  source: 'classified' | 'hint' | 'fallback';
  hint?: DocType;
}

export interface ClassificationRow {
  id: string;
  documentId: string;
  docType: DocType;
  confidence: number;
  source: string;
  hint: DocType | null;
}

/** Persist one classification result for a document (one row per ingest). */
export async function saveClassification(
  ctx: DbContext,
  input: ClassificationInput,
  userId?: string,
): Promise<string> {
  if (ctx.backend === 'postgres') return saveClassificationPg(ctx, input, userId);
  const id = rid('CL');
  ctx.db.insert(classifications).values({
    id,
    documentId: input.documentId,
    docType: input.docType,
    confidence: input.confidence,
    source: input.source,
    hint: input.hint ?? null,
    userId: effectiveUserId(userId),
  }).run();
  return id;
}

/**
 * Load the classification row for a document (most recent if multiple). Same
 * userId-legacy filter as loadExtraction (rows with user_id = '' / NULL stay
 * readable by any caller).
 */
export async function loadClassification(
  ctx: DbContext,
  documentId: string,
  userId?: string,
): Promise<ClassificationRow | null> {
  if (ctx.backend === 'postgres') return loadClassificationPg(ctx, documentId, userId);
  const uid = effectiveUserId(userId);
  const filter = uid
    ? and(
        eq(classifications.documentId, documentId),
        or(eq(classifications.userId, uid), eq(classifications.userId, ''), isNull(classifications.userId)),
      )
    : eq(classifications.documentId, documentId);
  const row = ctx.db
    .select()
    .from(classifications)
    .where(filter)
    .orderBy(classifications.createdAt)
    .all()
    .pop();
  if (!row) return null;
  return {
    id: row.id,
    documentId: row.documentId,
    docType: row.docType as DocType,
    confidence: row.confidence,
    source: row.source,
    hint: (row.hint as DocType | null) ?? null,
  };
}

export type DocumentTagSource = 'auto' | 'explicit';

export interface DocumentTagRow {
  tag: string;
  source: DocumentTagSource;
}

/**
 * Persist tag rows for a document with the given source. Idempotent per
 * (document, tag, source, user): a UNIQUE collision is skipped so re-ingesting
 * or re-calling tag_document with the same tag does not duplicate rows.
 */
export async function saveDocumentTags(
  ctx: DbContext,
  documentId: string,
  tags: string[],
  source: DocumentTagSource,
  userId?: string,
): Promise<void> {
  if (ctx.backend === 'postgres') return saveDocumentTagsPg(ctx, documentId, tags, source, userId);
  const uid = effectiveUserId(userId);
  // Resilience (Bug fix): dedup the input WITHIN this call so duplicate tags in
  // one array don't trip the UNIQUE index, AND use INSERT OR IGNORE so a UNIQUE
  // collision (race, or a tag that already exists for this source) is a no-op
  // rather than throwing. The app-layer have.has pre-read stays as an
  // optimization (skip the INSERT round-trip for known-existing tags).
  const uniqueTags = [...new Set(tags)];
  // De-dup against existing rows with the same (document, tag, source, user).
  // 3-way OR matches listDocumentTags/loadExtraction/loadClassification (no
  // behavioral impact today since the column is NOT NULL DEFAULT '', but
  // consistent with siblings).
  const existing = ctx.sqlite
    .prepare(
      `SELECT tag FROM document_tags
       WHERE document_id = ? AND source = ? AND (user_id = ? OR user_id = '' OR user_id IS NULL)`,
    )
    .all(documentId, source, uid) as Array<{ tag: string }>;
  const have = new Set(existing.map((r) => r.tag));
  const tx = ctx.sqlite.transaction((rows: string[]) => {
    for (const tag of rows) {
      if (have.has(tag)) continue;
      const id = rid('TG');
      ctx.sqlite
        .prepare(
          `INSERT OR IGNORE INTO document_tags (id, document_id, tag, source, user_id) VALUES (?, ?, ?, ?, ?)`,
        )
        .run(id, documentId, tag, source, uid);
    }
  });
  tx(uniqueTags);
}

/**
 * List all tags for a document (both sources), tag ascending. Same userId-legacy
 * filter as loadExtraction.
 */
export async function listDocumentTags(
  ctx: DbContext,
  documentId: string,
  userId?: string,
): Promise<DocumentTagRow[]> {
  if (ctx.backend === 'postgres') return listDocumentTagsPg(ctx, documentId, userId);
  const uid = effectiveUserId(userId);
  const rows = uid
    ? ctx.sqlite
        .prepare(
          `SELECT tag, source FROM document_tags
           WHERE document_id = ? AND (user_id = ? OR user_id = '' OR user_id IS NULL)
           ORDER BY tag ASC`,
        )
        .all(documentId, uid) as Array<{ tag: string; source: string }>
    : ctx.sqlite
        .prepare(`SELECT tag, source FROM document_tags WHERE document_id = ? ORDER BY tag ASC`)
        .all(documentId) as Array<{ tag: string; source: string }>;
  return rows.map((r) => ({ tag: r.tag, source: r.source as DocumentTagSource }));
}

export async function saveExtraction(ctx: DbContext, input: ExtractionInput, userId?: string): Promise<string> {
  if (ctx.backend === 'postgres') return saveExtractionPg(ctx, input, userId);
  const id = rid('EX');
  ctx.db.insert(extractions).values({
    id,
    documentId: input.documentId,
    docType: input.docType,
    fields: JSON.stringify(input.fields),
    fieldMeta: JSON.stringify(input.fieldMeta),
    overallConfidence: input.overallConfidence,
    needsReview: input.needsReview,
    proposedRelationships: input.proposedRelationships ? JSON.stringify(input.proposedRelationships) : null,
    userId: effectiveUserId(userId),
  }).run();
  return id;
}

export async function saveBinding(ctx: DbContext, input: BindingInput, userId?: string): Promise<string> {
  if (ctx.backend === 'postgres') return saveBindingPg(ctx, input, userId);
  const id = rid('BD');
  ctx.db.insert(bindings).values({
    id,
    documentId: input.documentId,
    contractNo: input.contractNo,
    relation: input.relation,
    sourceRefs: JSON.stringify(input.sourceRefs),
    confidence: input.confidence,
    createdBy: input.createdBy,
    userId: effectiveUserId(userId),
  }).run();
  return id;
}

export async function listBindingsForContract(
  ctx: DbContext,
  contractNo: string,
): Promise<BindingRow[]> {
  if (ctx.backend === 'postgres') return listBindingsForContractPg(ctx, contractNo);
  return ctx.db.select().from(bindings).where(eq(bindings.contractNo, contractNo)).all().map((r) => ({
    id: r.id,
    documentId: r.documentId,
    contractNo: r.contractNo,
    relation: r.relation,
    sourceRefs: JSON.parse(r.sourceRefs) as SourceSpan[],
    confidence: r.confidence,
    createdBy: r.createdBy,
  }));
}

// ---- L4 document recall (FTS5 BM25 over chunked doc text) ------------------
//
// doc_chunk holds the canonical chunk rows (FK -> documents.id); doc_chunk_fts
// is an external-content FTS5 index over doc_chunk.chunk_text. saveChunks writes
// both (manual sync -- the single ingest write path). searchChunks runs the
// BM25 MATCH. Both use raw better-sqlite3 (Drizzle has no FTS5 abstraction).

export interface ChunkInput {
  text: string;
  index: number;
}

/**
 * Persist chunk rows for a document and sync the FTS5 index. Returns the
 * inserted doc_chunk rowids (one per chunk, in input order) so callers can key
 * vector embeddings (Task 6 v2) onto the same chunk rows.
 */
export async function saveChunks(
  ctx: DbContext,
  documentId: string,
  chunks: ChunkInput[],
  chunkTags?: (string[] | null)[],
): Promise<number[]> {
  if (ctx.backend === 'postgres') return saveChunksPg(ctx, documentId, chunks, chunkTags);
  // Lane B: when chunkTags is supplied (aligned by index), persist JSON into the
  // tags column. Omitted -> 3-column insert (unchanged behavior; tags=NULL).
  const writeTags = Array.isArray(chunkTags) && chunkTags.length > 0;
  // The two inserts bind different arg counts, so type the prepared statement
  // permissively (run returns lastInsertRowid either way) to avoid a union of
  // differently-parameterized Statement generics.
  type AnyStmt = { run: (...params: unknown[]) => { lastInsertRowid: number | bigint } };
  const insertChunk = ctx.sqlite.prepare(
    writeTags
      ? 'INSERT INTO doc_chunk (document_id, chunk_text, chunk_index, tags) VALUES (?, ?, ?, ?)'
      : 'INSERT INTO doc_chunk (document_id, chunk_text, chunk_index) VALUES (?, ?, ?)',
  ) as unknown as AnyStmt;
  const insertFts = ctx.sqlite.prepare(
    'INSERT INTO doc_chunk_fts (rowid, chunk_text) VALUES (?, ?)',
  );
  const rowids: number[] = [];
  const tx = ctx.sqlite.transaction((rows: ChunkInput[]) => {
    for (let i = 0; i < rows.length; i++) {
      const c = rows[i]!;
      let info: { lastInsertRowid: number | bigint };
      if (writeTags) {
        const t = chunkTags![i] ?? null;
        info = insertChunk.run(documentId, c.text, c.index, t === null ? null : JSON.stringify(t));
      } else {
        info = insertChunk.run(documentId, c.text, c.index);
      }
      const rowid = Number(info.lastInsertRowid);
      rowids.push(rowid);
      // External-content FTS5: index entry keyed by the doc_chunk rowid.
      insertFts.run(rowid, c.text);
    }
  });
  tx(chunks);
  return rowids;
}

export interface ChunkMatch {
  /** doc_chunk.id -- used for RRF de-dup against vector KNN hits. */
  chunkRowId: number;
  documentId: string;
  chunkIndex: number | null;
  snippet: string;
  /** SQLite FTS5 bm25: more negative = better match. Postgres: -ts_rank (same). */
  bm25Score: number;
}

/**
 * Turn a free-text query into a safe FTS5 MATCH expression. Each whitespace-
 * separated term is double-quoted as a phrase (internal quotes doubled), joined
 * with implicit AND. Returns '' for an all-empty query so the caller returns no
 * matches rather than throwing. CJK works at the character-token level because
 * unicode61 emits one token per CJK char, so a contiguous CJK phrase matches as
 * a consecutive char sequence.
 */
export function sanitizeFtsQuery(query: string): string {
  return query
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
    .map((t) => `"${t.replace(/"/g, '""')}"`)
    .join(' ');
}

/**
 * BM25 keyword recall over doc chunks. Returns matches ordered best-first
 * (bm25 ascending). Returns [] for an empty/sanitized-out query or a malformed
 * MATCH (no hallucination -- callers must treat [] as "no recall", never invent).
 */
export async function searchChunks(
  ctx: DbContext,
  query: string,
  limit: number,
  userId?: string,
): Promise<ChunkMatch[]> {
  if (ctx.backend === 'postgres') return searchChunksPg(ctx, query, limit, userId);
  const ftsQuery = sanitizeFtsQuery(query);
  if (!ftsQuery) return [];
  const safeLimit = limit > 0 ? Math.floor(limit) : 5;
  const uid = effectiveUserId(userId);
  // Column-scoped MATCH (f.chunk_text) + alias JOIN: a bare `doc_chunk_fts MATCH`
  // collides with the external content table name in the same FROM. snippet() and
  // bm25() read content via content_rowid -> doc_chunk.id.
  //
  // Phase 2: when userId is in scope, JOIN to documents and filter on user_id so
  // recall only returns the caller's chunks. When uid is '' (legacy/tests), the
  // extra JOIN+WHERE is skipped so behavior is byte-identical to the pre-isolation
  // path (no perf hit, no rows hidden from unscoped callers).
  const stmt = ctx.sqlite.prepare(
    `SELECT
       dc.id           AS chunkRowId,
       dc.document_id  AS documentId,
       dc.chunk_index  AS chunkIndex,
       snippet(doc_chunk_fts, 0, '<<', '>>', '...', 16) AS snippet,
       bm25(doc_chunk_fts) AS bm25Score
     FROM doc_chunk AS dc
     JOIN doc_chunk_fts AS f ON f.rowid = dc.id
      ${uid ? 'JOIN documents AS d ON d.id = dc.document_id' : ''}
      WHERE f.chunk_text MATCH ?
      ${uid ? "AND (d.user_id = ? OR d.user_id = '' OR d.user_id IS NULL)" : ''}
      ORDER BY bm25Score
      LIMIT ?`,
  );
  const params: Array<string | number> = uid ? [ftsQuery, uid, safeLimit] : [ftsQuery, safeLimit];
  try {
    const rows = stmt.all(...params) as Array<{
      chunkRowId: number | bigint;
      documentId: string;
      chunkIndex: number | null;
      snippet: string;
      bm25Score: number;
    }>;
    return rows.map((r) => ({
      chunkRowId: Number(r.chunkRowId),
      documentId: r.documentId,
      chunkIndex: r.chunkIndex,
      snippet: r.snippet,
      bm25Score: r.bm25Score,
    }));
  } catch {
    // Malformed MATCH (e.g. operator-only query the sanitizer lets through) ->
    // surface as no matches, never as a thrown error into the agent loop.
    return [];
  }
}

export interface ChunkMeta {
  documentId: string;
  chunkIndex: number | null;
  text: string;
  /** Lane B: per-chunk semantic tags (null when untagged). */
  tags: string[] | null;
}

/**
 * Fetch chunk metadata (document_id, chunk_index, full chunk_text) for a set of
 * doc_chunk rowids. Used to attach document_id + a snippet to vector KNN hits
 * (which only return rowid + distance). Returns a rowid -> meta map.
 */
export async function getChunkMetaByRowids(
  ctx: DbContext,
  rowids: number[],
  userId?: string,
): Promise<Map<number, ChunkMeta>> {
  if (ctx.backend === 'postgres') return getChunkMetaByRowidsPg(ctx, rowids, userId);
  const out = new Map<number, ChunkMeta>();
  if (rowids.length === 0) return out;
  const uid = effectiveUserId(userId);
  const placeholders = rowids.map(() => '?').join(',');
  // Phase 2: when userId is in scope, JOIN documents and filter on user_id so a
  // caller cannot pull chunk text for a document they do not own. Unscoped path
  // (uid === '') keeps the pre-isolation query shape.
  const sql = uid
    ? `SELECT dc.id, dc.document_id, dc.chunk_index, dc.chunk_text, dc.tags
       FROM doc_chunk AS dc
       JOIN documents AS d ON d.id = dc.document_id
       WHERE dc.id IN (${placeholders}) AND (d.user_id = ? OR d.user_id = '' OR d.user_id IS NULL)`
    : `SELECT id, document_id, chunk_index, chunk_text, tags
       FROM doc_chunk
       WHERE id IN (${placeholders})`;
  const params: Array<string | number> = uid ? [...rowids, uid] : rowids;
  const rows = ctx.sqlite.prepare(sql).all(...params) as Array<{
    id: number | bigint;
    document_id: string;
    chunk_index: number | null;
    chunk_text: string;
    tags: string | null;
  }>;
  for (const r of rows) {
    // null-safe parse: legacy rows / NULL -> null; corrupt JSON -> null (treat as
    // untagged rather than throwing — tags are a retrieval hint, not a correctness boundary).
    let tags: string[] | null = null;
    if (r.tags) {
      try {
        const parsed = JSON.parse(r.tags);
        tags = Array.isArray(parsed) ? parsed : null;
      } catch {
        tags = null;
      }
    }
    out.set(Number(r.id), {
      documentId: r.document_id,
      chunkIndex: r.chunk_index,
      text: r.chunk_text,
      tags,
    });
  }
  return out;
}

/**
 * Hard-delete a document and EVERY dependent row across the storage stack.
 * SQLite FKs are OFF by default, so children MUST be deleted before the parent
 * (order is load-bearing). FTS5 external-content table doc_chunk_fts has no
 * triggers and sqlite-vec doc_chunk_vec must be deleted by id -- both explicit.
 * doc_chunk_vec is optional (only exists when sqlite-vec loads); its delete is
 * guarded on table existence so the cascade works on DBs without the extension.
 * Returns { deleted: true } if the documents row existed (and was removed),
 * { deleted: false } if not found / not visible to this user.
 *
 * Security: chunkIds are integers read from our own DB (not user input), so
 * interpolating them into `IN (...)` is safe. docId/uid stay parameterized.
 */
export async function deleteDocument(ctx: DbContext, docId: string, userId?: string): Promise<{ deleted: boolean }> {
  if (ctx.backend === 'postgres') return deleteDocumentPg(ctx, docId, userId);
  const uid = effectiveUserId(userId);
  const sqlite = ctx.sqlite;
  // Verify ownership/visibility first (3-way OR legacy filter, same as loadDocument).
  const owned = sqlite
    .prepare("SELECT 1 FROM documents WHERE id = ? AND (user_id = ? OR user_id = '' OR user_id IS NULL) LIMIT 1")
    .get(docId, uid);
  if (!owned) return { deleted: false };

  const chunkIds = sqlite
    .prepare('SELECT id FROM doc_chunk WHERE document_id = ?')
    .all(docId) as { id: number }[];

  // doc_chunk_vec is optional (only present when sqlite-vec loads); check before
  // deleting so the cascade works on DBs where the vec extension is absent.
  const hasVecTable = !!sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='doc_chunk_vec'")
    .get();

  const tx = sqlite.transaction(() => {
    // 1-2. FTS + vec by chunk id (chunkIds are our own integers — safe to interpolate).
    if (chunkIds.length) {
      const idList = chunkIds.map((c) => c.id).join(',');
      sqlite.exec(`DELETE FROM doc_chunk_fts WHERE rowid IN (${idList})`);
      if (hasVecTable) {
        sqlite.exec(`DELETE FROM doc_chunk_vec WHERE id IN (${idList})`);
      }
    }
    // 3. chunks.
    sqlite.prepare('DELETE FROM doc_chunk WHERE document_id = ?').run(docId);
    // 4-7. stage tables.
    sqlite.prepare('DELETE FROM extractions WHERE document_id = ?').run(docId);
    sqlite.prepare('DELETE FROM classifications WHERE document_id = ?').run(docId);
    sqlite.prepare('DELETE FROM bindings WHERE document_id = ?').run(docId);
    sqlite.prepare('DELETE FROM document_tags WHERE document_id = ?').run(docId);
    // 8. parent last (after all referencers gone).
    sqlite.prepare('DELETE FROM documents WHERE id = ?').run(docId);
  });
  tx();
  return { deleted: true };
}

// ---- File manager: document minio_key link-back + virtual folders ----------
//
// These back the /api/files endpoints: uploads stamp minio_key onto the document
// row so the file list can attach a docId to each MinIO object; the list does a
// batch lookup (with a source_uri LIKE fallback for legacy rows); folders are a
// per-user virtual tree (file_folders table). All dispatched by backend like the
// core repo fns above. userId IS required on the folder fns (folders are always
// per-user); minio_key lookups filter by userId when in scope (defense in depth
// on top of the MinIO key-prefix scoping the route already does).

export interface FileFolderRow {
  id: string;
  path: string;
}

const folderRid = () =>
  `FL-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

/** Set the MinIO object key on a document row (post-ingest link-back). */
export async function setDocumentMinioKey(
  ctx: DbContext,
  docId: string,
  minioKey: string,
): Promise<void> {
  if (ctx.backend === 'postgres') return setDocumentMinioKeyPg(ctx, docId, minioKey);
  ctx.sqlite
    .prepare('UPDATE documents SET minio_key = ? WHERE id = ?')
    .run(minioKey, docId);
}

/**
 * Batch-lookup document ids by MinIO object key. Phase 1 is an exact match on
 * documents.minio_key; phase 2 falls back to a source_uri LIKE match for keys
 * not resolved (legacy rows without minio_key -- source_uri ends with the slash-
 * flattened key). Returns a Map<minioKey, docId>. Empty in / out for convenience.
 */
export async function findDocIdsByMinioKeys(
  ctx: DbContext,
  minioKeys: string[],
  userId?: string,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (minioKeys.length === 0) return out;
  if (ctx.backend === 'postgres') return findDocIdsByMinioKeysPg(ctx, minioKeys, userId);
  const uid = effectiveUserId(userId);
  // Phase 1: exact minio_key match (batch via IN). Legacy rows (user_id = '' /
  // NULL) stay accessible to any caller (same convention as the source_uri
  // fallback below).
  const placeholders = minioKeys.map(() => '?').join(',');
  const sql1 = uid
    ? `SELECT id, minio_key FROM documents WHERE minio_key IN (${placeholders}) AND (user_id = ? OR user_id = '' OR user_id IS NULL)`
    : `SELECT id, minio_key FROM documents WHERE minio_key IN (${placeholders})`;
  const params1: string[] = uid ? [...minioKeys, uid] : minioKeys;
  const rows1 = ctx.sqlite.prepare(sql1).all(...params1) as Array<{
    id: string;
    minio_key: string;
  }>;
  for (const r of rows1) out.set(r.minio_key, r.id);
  // Phase 2: source_uri LIKE fallback for unresolved keys (legacy rows, or rows
  // whose minio_key was never stamped because the file was moved between folders).
  // Match by the unique <uuid>-<filename> tail (the last path segment) instead of
  // the full flattened key, so the lookup survives folder moves -- the full flat
  // key changes when a file is moved, but the last segment is invariant and UUIDs
  // are unique per upload.
  const missing = minioKeys.filter((k) => !out.has(k));
  for (const key of missing) {
    const lastSeg = key.split('/').pop() ?? key;
    const flat = `%${lastSeg}`;
    const sql2 = uid
      ? 'SELECT id FROM documents WHERE source_uri LIKE ? AND (user_id = ? OR user_id = \'\' OR user_id IS NULL) LIMIT 1'
      : 'SELECT id FROM documents WHERE source_uri LIKE ? LIMIT 1';
    const params2: string[] = uid ? [flat, uid] : [flat];
    const row = ctx.sqlite.prepare(sql2).get(...params2) as { id: string } | undefined;
    if (row) out.set(key, row.id);
  }
  return out;
}

/** List the user's virtual folders (path ascending). */
export async function listFileFolders(
  ctx: DbContext,
  userId: string,
): Promise<FileFolderRow[]> {
  if (ctx.backend === 'postgres') return listFileFoldersPg(ctx, userId);
  const rows = ctx.sqlite
    .prepare('SELECT id, path FROM file_folders WHERE user_id = ? ORDER BY path ASC')
    .all(userId) as Array<{ id: string; path: string }>;
  return rows.map((r) => ({ id: r.id, path: r.path }));
}

/** Insert a virtual folder row. Returns the generated id. */
export async function createFileFolder(
  ctx: DbContext,
  userId: string,
  folderPath: string,
): Promise<string> {
  const id = folderRid();
  if (ctx.backend === 'postgres') return createFileFolderPg(ctx, userId, folderPath, id);
  ctx.sqlite
    .prepare('INSERT INTO file_folders (id, user_id, path) VALUES (?, ?, ?)')
    .run(id, userId, folderPath);
  return id;
}

/** Delete a virtual folder row. Returns true iff a row was removed. */
export async function deleteFileFolder(
  ctx: DbContext,
  userId: string,
  folderPath: string,
): Promise<boolean> {
  if (ctx.backend === 'postgres') return deleteFileFolderPg(ctx, userId, folderPath);
  const info = ctx.sqlite
    .prepare('DELETE FROM file_folders WHERE user_id = ? AND path = ?')
    .run(userId, folderPath);
  return info.changes > 0;
}

// ---- Post-ingest review (Task 3) -------------------------------------------
//
// getReviewSnapshot assembles the 5-dimension read the review UI consumes
// (docType + classification confidence + tags + extraction fields with
// per-field confidence + proposed relationships). setReviewStatus stamps the
// pending -> confirmed/corrected lifecycle. updateExtractionFields overwrites
// the extracted fields after a user correction. All three dispatch to a pg
// twin; the SQLite branches use raw better-sqlite3 (UPDATEs mirror
// setDocumentMinioKey; READs are simple parameterized SELECTs).

/** Max distinct chunk tags surfaced on the review snapshot (分段标签). */
export const CHUNK_TAGS_CAP = 16;

/** Max characters of chunk text carried per entry in chunkTagDetails. */
export const CHUNK_TAG_TEXT_CAP = 800;

/** One chunk classified under a tag (分段标签详情 leaf). */
export interface ChunkTagChunkDetail {
  chunkIndex: number;
  text: string;
}

/** One tag entry with the chunks it classified, first-appearance tag order. */
export interface ChunkTagDetail {
  tag: string;
  chunks: ChunkTagChunkDetail[];
}

/**
 * Lane B detail builder: group per-chunk tag arrays into tag -> chunk entries.
 * Same ordering/dedupe/cap rules as collectChunkTags (first appearance across
 * chunk_index, CHUNK_TAGS_CAP distinct tags); each tag's chunks stay in
 * chunk_index order with text capped at CHUNK_TAG_TEXT_CAP. Pure so the
 * SQLite + Postgres branches share one rule set (each feeds its own row shape).
 */
export function collectChunkTagDetails(
  rows: Array<{ chunk_index: number | null; chunk_text: string | null; tags: string | null }>,
): ChunkTagDetail[] {
  const byTag = new Map<string, ChunkTagDetail>();
  const ordered: ChunkTagDetail[] = [];
  for (const r of rows) {
    if (!r.tags) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(r.tags);
    } catch {
      continue; // corrupt -> treat as untagged (retrieval hint, not a boundary)
    }
    if (!Array.isArray(parsed)) continue;
    for (const t of parsed) {
      if (typeof t !== 'string') continue;
      let entry = byTag.get(t);
      if (!entry) {
        if (ordered.length >= CHUNK_TAGS_CAP) continue;
        entry = { tag: t, chunks: [] };
        byTag.set(t, entry);
        ordered.push(entry);
      }
      const raw = r.chunk_text ?? '';
      entry.chunks.push({
        chunkIndex: r.chunk_index ?? entry.chunks.length,
        text: raw.length > CHUNK_TAG_TEXT_CAP ? `${raw.slice(0, CHUNK_TAG_TEXT_CAP)}...` : raw,
      });
    }
  }
  return ordered;
}

/**
 * Lane B: flatten a doc_chunk tags column (JSON string[] per chunk) into a
 * DISTINCT, first-appearance-ordered list, skipping null/empty/corrupt entries,
 * capped at CHUNK_TAGS_CAP. Pure so the SQLite + Postgres branches share the
 * same ordering/cap rule (each branch feeds it its own row shape).
 */
export function collectChunkTags(rows: Array<{ tags: string | null }>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    if (!r.tags) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(r.tags);
    } catch {
      continue; // corrupt -> treat as untagged (retrieval hint, not a boundary)
    }
    if (!Array.isArray(parsed)) continue;
    for (const t of parsed) {
      if (typeof t === 'string' && !seen.has(t)) {
        seen.add(t);
        out.push(t);
        if (out.length >= CHUNK_TAGS_CAP) break;
      }
    }
    if (out.length >= CHUNK_TAGS_CAP) break;
  }
  return out;
}

/**
 * Assemble the post-ingest review snapshot for a document. Returns null if the
 * document does not exist. fields come from the latest extraction row; each
 * field's needsReview is true when its confidence is below 0.7. proposed
 * relationships default to [] when absent.
 */
export async function getReviewSnapshot(
  ctx: DbContext,
  docId: string,
  userId?: string,
): Promise<ReviewSnapshot | null> {
  if (ctx.backend === 'postgres') return getReviewSnapshotPg(ctx, docId, userId);
  const sqlite = ctx.sqlite;
  const doc = sqlite
    .prepare('SELECT doc_type, review_status, vectorization_meta FROM documents WHERE id = ?')
    .get(docId) as { doc_type: string; review_status: string | null; vectorization_meta: string | null } | undefined;
  if (!doc) return null;

  // Parse the persisted vectorization outcome. Null/invalid (legacy rows, or a
  // saveDocument-direct test that never ran ingest) -> the 'unknown' fallback so
  // present_document_review reports 未知 rather than crashing.
  let vectorization: DocumentVectorization = UNKNOWN_VECTORIZATION;
  if (doc.vectorization_meta) {
    try {
      vectorization = JSON.parse(doc.vectorization_meta) as DocumentVectorization;
    } catch {
      vectorization = UNKNOWN_VECTORIZATION;
    }
  }

  const ex = sqlite
    .prepare(
      `SELECT fields, field_meta, overall_confidence, proposed_relationships
       FROM extractions WHERE document_id = ? ORDER BY rowid DESC LIMIT 1`,
    )
    .get(docId) as
    | {
        fields: string;
        field_meta: string;
        overall_confidence: number;
        proposed_relationships: string | null;
      }
    | undefined;

  const cls = sqlite
    .prepare(
      'SELECT confidence FROM classifications WHERE document_id = ? ORDER BY rowid DESC LIMIT 1',
    )
    .get(docId) as { confidence: number } | undefined;

  // Tags in insertion order (rowid) so the snapshot reflects the order the
  // ingest pipeline emitted them (listDocumentTags sorts alphabetically; the
  // review snapshot preserves ingest order for display).
  const tagRows = sqlite
    .prepare('SELECT tag FROM document_tags WHERE document_id = ? ORDER BY rowid')
    .all(docId) as Array<{ tag: string }>;

  // Lane B: per-chunk semantic tags + the chunk text for the detail view.
  // Scoped by userId like getChunkMetaByRowids (JOIN documents + legacy-row
  // allow-list) so a caller cannot read chunk tags for a document they do not own.
  const uid = effectiveUserId(userId);
  const chunkTagRows = (uid
    ? sqlite
        .prepare(
          `SELECT dc.chunk_index, dc.chunk_text, dc.tags FROM doc_chunk AS dc
           JOIN documents AS d ON d.id = dc.document_id
           WHERE dc.document_id = ? AND (d.user_id = ? OR d.user_id = '' OR d.user_id IS NULL)
           ORDER BY dc.chunk_index`,
        )
        .all(docId, uid)
    : sqlite
        .prepare(
          'SELECT chunk_index, chunk_text, tags FROM doc_chunk WHERE document_id = ? ORDER BY chunk_index',
        )
        .all(docId)) as Array<{
    chunk_index: number | null;
    chunk_text: string | null;
    tags: string | null;
  }>;

  const fields: ReviewSnapshot['fields'] = [];
  if (ex) {
    const parsedFields = JSON.parse(ex.fields) as Record<
      string,
      { value: string | number; sourceSpans: SourceSpan[] }
    >;
    const parsedMeta = JSON.parse(ex.field_meta) as Record<
      string,
      { strength: SpanMatchStrength; confidence: number }
    >;
    for (const [name, f] of Object.entries(parsedFields)) {
      const confidence = parsedMeta[name]?.confidence ?? 0;
      fields.push({ name, value: f.value, confidence, needsReview: confidence < 0.7 });
    }
  }

  const proposedRelationships: ProposedRelationship[] = ex?.proposed_relationships
    ? (JSON.parse(ex.proposed_relationships) as ProposedRelationship[])
    : [];

  return {
    docId,
    docType: doc.doc_type,
    classificationConfidence: cls ? cls.confidence : 0,
    tags: tagRows.map((r) => r.tag),
    chunkTags: collectChunkTags(chunkTagRows),
    chunkTagDetails: collectChunkTagDetails(chunkTagRows),
    reviewStatus: (doc.review_status ?? 'pending') as ReviewStatus,
    fields,
    overallConfidence: ex ? ex.overall_confidence : 0,
    proposedRelationships,
    vectorization,
  };
}

/**
 * Transition a document's review_status (pending -> confirmed/corrected) and
 * stamp reviewed_at/reviewed_by. Mirrors setDocumentMinioKey's raw UPDATE shape.
 */
export async function setReviewStatus(
  ctx: DbContext,
  docId: string,
  status: ReviewStatus,
  userId?: string,
): Promise<void> {
  if (ctx.backend === 'postgres') return setReviewStatusPg(ctx, docId, status, userId);
  ctx.sqlite
    .prepare(
      "UPDATE documents SET review_status = ?, reviewed_at = datetime('now'), reviewed_by = ? WHERE id = ?",
    )
    .run(status, effectiveUserId(userId), docId);
}

/**
 * Persist the L4 vector-embedding outcome onto the document row (Bug fix: was
 * previously only held in an in-memory Map, so it was lost on restart and never
 * written by the /api/files upload path). Mirrors setReviewStatus's raw UPDATE
 * shape. userId is accepted for signature parity; the doc-level scope already
 * authorizes the caller (the same user who just ingested it).
 */
export async function setDocumentVectorization(
  ctx: DbContext,
  docId: string,
  vectorization: DocumentVectorization,
  userId?: string,
): Promise<void> {
  if (ctx.backend === 'postgres') return setDocumentVectorizationPg(ctx, docId, vectorization, userId);
  void userId;
  ctx.sqlite
    .prepare('UPDATE documents SET vectorization_meta = ? WHERE id = ?')
    .run(JSON.stringify(vectorization), docId);
}

/**
 * Lane A (2a): stamp the auto-extraction lifecycle status onto a document row.
 * Mirrors setDocumentVectorization's raw UPDATE shape (pending -> running ->
 * ok/skipped/failed). userId is accepted for signature parity; the doc-level
 * scope already authorizes the caller.
 */
export async function setExtractionStatus(
  ctx: DbContext,
  docId: string,
  status: ExtractionStatus,
  userId?: string,
): Promise<void> {
  if (ctx.backend === 'postgres') return setExtractionStatusPg(ctx, docId, status, userId);
  void userId;
  ctx.sqlite
    .prepare('UPDATE documents SET extraction_status = ? WHERE id = ?')
    .run(status, docId);
}

/** Read the extraction_status for a document, or null if the row does not exist. */
export async function getExtractionStatus(
  ctx: DbContext,
  docId: string,
  userId?: string,
): Promise<ExtractionStatus | null> {
  if (ctx.backend === 'postgres') return getExtractionStatusPg(ctx, docId, userId);
  void userId;
  const row = ctx.sqlite
    .prepare('SELECT extraction_status FROM documents WHERE id = ?')
    .get(docId) as { extraction_status: string } | undefined;
  return row ? (row.extraction_status as ExtractionStatus) : null;
}

// ---- Model B: decouple upload from parse -----------------------------------
//
// Upload (POST /api/files) now creates a lightweight documents "stub" row with
// parse_status='uploaded' and returns immediately; parsing runs on demand via
// processDocument (POST /api/documents/:docId/process). OCR/parse failure
// becomes a STATE ('needs_ocr' / 'failed'), NOT a thrown exception. These fns
// dispatch to pg twins like the rest of the repo layer.

/** Doc-id generator mirroring newDocId (documentEntry.ts) for stub rows. */
const newDocRowId = () => `DOC-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

/** Input for createDocumentStub: the minimal fields known at upload time. */
export interface DocumentStubInput {
  sourceUri: string;
  minioKey?: string;
  userId?: string;
  filename?: string;
  docType?: DocType;
}

/**
 * Insert a lightweight documents "stub" row at upload time (parse_status=
 * 'uploaded'). Upload is storage-only: it does NOT parse. The row satisfies all
 * NOT NULL columns of `documents` (doc_type/modality/block_model have no DB
 * default, so the stub fills placeholders that processDocument later overwrites
 * via updateDocumentMeta). block_model is a valid empty BlockModel JSON so a
 * pre-parse loadDocument does not crash. Returns the generated docId.
 */
export async function createDocumentStub(
  ctx: DbContext,
  input: DocumentStubInput,
): Promise<{ docId: string }> {
  if (ctx.backend === 'postgres') return createDocumentStubPg(ctx, input);
  const docId = newDocRowId();
  const docType: DocType = input.docType ?? '其他';
  const modality: Modality = 'digital';
  const blockModel = JSON.stringify({
    docId,
    docType,
    modality,
    blocks: [],
    sourceUri: input.sourceUri,
    createdAt: new Date().toISOString(),
  });
  ctx.sqlite
    .prepare(
      `INSERT INTO documents (id, doc_type, modality, source_uri, block_model, minio_key, user_id, parse_status)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'uploaded')`,
    )
    .run(
      docId,
      docType,
      modality,
      input.sourceUri,
      blockModel,
      input.minioKey ?? null,
      effectiveUserId(input.userId),
    );
  return { docId };
}

/**
 * UPDATE the doc_type / modality / block_model on an existing documents row.
 * Used by processDocument to fill in the parsed values on a stub (only the
 * provided fields are written). blockModel is accepted (deviation from the
 * literal spec which listed only docType/modality): persisting the parsed
 * BlockModel is REQUIRED for downstream tools (extract_fields / inspect_extraction
 * / recall all read block_model), otherwise the Model B refactor would leave
 * uploaded docs unparseable by the agent. userId is accepted for parity (void,
 * like setReviewStatus).
 */
export async function updateDocumentMeta(
  ctx: DbContext,
  docId: string,
  input: { docType?: DocType; modality?: Modality; blockModel?: BlockModel },
  userId?: string,
): Promise<void> {
  if (ctx.backend === 'postgres') return updateDocumentMetaPg(ctx, docId, input, userId);
  void userId;
  const sets: string[] = [];
  const params: Array<string | null> = [];
  if (input.docType !== undefined) {
    sets.push('doc_type = ?');
    params.push(input.docType);
  }
  if (input.modality !== undefined) {
    sets.push('modality = ?');
    params.push(input.modality);
  }
  if (input.blockModel !== undefined) {
    sets.push('block_model = ?');
    params.push(JSON.stringify(input.blockModel));
  }
  if (sets.length === 0) return;
  params.push(docId);
  ctx.sqlite.prepare(`UPDATE documents SET ${sets.join(', ')} WHERE id = ?`).run(...params);
}

/**
 * Set the parse_status lifecycle on a document. Mirrors setReviewStatus's raw
 * UPDATE shape. userId is accepted for signature parity (void).
 */
export async function setDocumentParseStatus(
  ctx: DbContext,
  docId: string,
  status: ParseStatus,
  userId?: string,
): Promise<void> {
  if (ctx.backend === 'postgres') return setDocumentParseStatusPg(ctx, docId, status, userId);
  void userId;
  ctx.sqlite.prepare('UPDATE documents SET parse_status = ? WHERE id = ?').run(status, docId);
}

/** Read the parse_status for a document, or null if the row does not exist. */
export async function getDocumentParseStatus(
  ctx: DbContext,
  docId: string,
  userId?: string,
): Promise<ParseStatus | null> {
  if (ctx.backend === 'postgres') return getDocumentParseStatusPg(ctx, docId, userId);
  void userId;
  const row = ctx.sqlite
    .prepare('SELECT parse_status FROM documents WHERE id = ?')
    .get(docId) as { parse_status: string } | undefined;
  return row ? (row.parse_status as ParseStatus) : null;
}

/**
 * Read the source_uri for a document (processDocument resolves the stub's source
 * path through this), or null if the row does not exist.
 */
export async function getDocumentSourceUri(
  ctx: DbContext,
  docId: string,
  userId?: string,
): Promise<string | null> {
  if (ctx.backend === 'postgres') return getDocumentSourceUriPg(ctx, docId, userId);
  void userId;
  const row = ctx.sqlite
    .prepare('SELECT source_uri FROM documents WHERE id = ?')
    .get(docId) as { source_uri: string } | undefined;
  return row ? row.source_uri : null;
}

/**
 * Overwrite the extracted fields + field_meta for a document after a user
 * correction. Updates all extraction rows for the doc (simplest; consistent
 * with the doc-level review scope). userId is accepted for signature parity
 * but not used in the WHERE (the doc-level scope already authorizes the caller).
 */
export async function updateExtractionFields(
  ctx: DbContext,
  docId: string,
  fields: Record<string, { value: string | number; sourceSpans: SourceSpan[] }>,
  fieldMeta: Record<string, { strength: SpanMatchStrength; confidence: number }>,
  userId?: string,
): Promise<void> {
  if (ctx.backend === 'postgres') return updateExtractionFieldsPg(ctx, docId, fields, fieldMeta, userId);
  void userId; // signature parity; doc-level scope already authorizes the caller
  ctx.sqlite
    .prepare('UPDATE extractions SET fields = ?, field_meta = ? WHERE document_id = ?')
    .run(JSON.stringify(fields), JSON.stringify(fieldMeta), docId);
}

/**
 * Apply a set of human corrections to a document's latest extraction (Feature:
 * in-card correction, shared by the update_document_fields L2 tool AND the
 * POST /api/documents/:docId/review HITL route so the merge+write logic lives
 * in ONE place). Loads the latest extraction, merges corrections preserving
 * un-corrected fieldMeta entries, and for corrected fields sets confidence
 * 1.0 (human-confirmed), strength 'none', and empties sourceSpans (the value
 * no longer derives from a source span). Writes back via updateExtractionFields,
 * flips reviewStatus to 'corrected', and returns the refreshed snapshot.
 *
 * Returns null when no extraction exists for the doc (also covers a missing
 * doc — there are no extractions for a nonexistent document_id). The route
 * treats null as 404. Backend-neutral: every step dispatches internally, so no
 * pg twin is needed.
 */
export async function applyDocumentCorrections(
  ctx: DbContext,
  docId: string,
  corrections: Array<{ name: string; value: string | number }>,
  userId?: string,
): Promise<ReviewSnapshot | null> {
  const latest = await loadLatestExtractionByDocId(ctx, docId, userId);
  if (!latest) return null;
  // Merge: preserve un-corrected fieldMeta; corrected -> value overridden,
  // confidence 1.0 (human-confirmed), strength 'none', sourceSpans cleared
  // (the corrected value no longer traces to a source span).
  const corrByName = new Map(corrections.map((c) => [c.name, c.value]));
  const fields: Record<string, { value: string | number; sourceSpans: SourceSpan[] }> = { ...latest.fields };
  const fieldMeta: Record<string, { strength: SpanMatchStrength; confidence: number }> = { ...latest.fieldMeta };
  for (const [name, value] of corrByName) {
    fields[name] = { value, sourceSpans: [] };
    fieldMeta[name] = { strength: 'none', confidence: 1.0 };
  }
  await updateExtractionFields(ctx, docId, fields, fieldMeta, userId);
  await setReviewStatus(ctx, docId, 'corrected', userId);
  return await getReviewSnapshot(ctx, docId, userId);
}

// ---- Contract ledger (ingest extraction write-back) ------------------------
//
// 合同台账 persistence: extraction results carrying a contract number are
// upserted here keyed on the NORMALIZED (contract_no, user_id) so lookups by
// contract number hit regardless of OCR full-width/whitespace/case noise. The
// builder (contractLedger.ts) guarantees entry.contractNo / entry.userId are
// already normalized, so no re-normalization happens on this side.

/**
 * Insert-or-update a contract ledger row. Keyed on (contract_no, user_id): a
 * second write for the same normalized key updates the row in place (UNIQUE
 * index backs the ON CONFLICT). entry.userId is authoritative (already
 * normalized by buildLedgerEntryFromExtraction) -- the userId param is kept
 * for signature parity only.
 */
export async function upsertContractLedgerEntry(
  ctx: DbContext,
  entry: ContractLedgerEntry,
  userId?: string,
): Promise<void> {
  if (ctx.backend === 'postgres') return upsertContractLedgerEntryPg(ctx, entry, userId);
  void userId; // entry.userId is authoritative (already normalized by the builder)
  const id = rid('CLD');
  ctx.sqlite
    .prepare(
      `INSERT INTO contract_ledger
         (id, contract_no, display_contract_no, doc_type, document_id, title, fields, field_meta,
          overall_confidence, needs_review, user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(contract_no, user_id) DO UPDATE SET
         display_contract_no = excluded.display_contract_no,
         doc_type = excluded.doc_type,
         document_id = excluded.document_id,
         title = excluded.title,
         fields = excluded.fields,
         field_meta = excluded.field_meta,
         overall_confidence = excluded.overall_confidence,
         needs_review = excluded.needs_review,
         updated_at = datetime('now')`,
    )
    .run(
      id,
      entry.contractNo,
      entry.displayContractNo,
      entry.docType,
      entry.documentId,
      entry.title,
      JSON.stringify(entry.fields),
      JSON.stringify(entry.fieldMeta),
      entry.overallConfidence,
      entry.needsReview ? 1 : 0,
      entry.userId,
    );
}

/**
 * Look up a contract ledger row by contract number. The query key is normalized
 * the same way writes are (full-width/whitespace/case-insensitive). userId
 * filtering follows the legacy convention: when a non-empty uid is in scope,
 * rows with user_id = '' / NULL stay readable by any caller (same 3-way OR as
 * loadDocument / loadExtraction); unscoped callers skip the filter entirely.
 * fields/field_meta are TEXT(JSON) on SQLite -> JSON.parse back to objects.
 */
export async function findContractLedgerByNo(
  ctx: DbContext,
  contractNo: string,
  userId?: string,
): Promise<ContractLedgerEntry | null> {
  if (ctx.backend === 'postgres') return findContractLedgerByNoPg(ctx, contractNo, userId);
  const normalized = normalizeContractNo(contractNo);
  if (!normalized) return null; // no usable key -> no match
  const uid = effectiveUserId(userId);
  const row = (uid
    ? ctx.sqlite
        .prepare(
          `SELECT contract_no, display_contract_no, doc_type, document_id, title, fields, field_meta,
                  overall_confidence, needs_review, user_id
           FROM contract_ledger
           WHERE contract_no = ? AND (user_id = ? OR user_id = '' OR user_id IS NULL)`,
        )
        .get(normalized, uid)
    : ctx.sqlite
        .prepare(
          `SELECT contract_no, display_contract_no, doc_type, document_id, title, fields, field_meta,
                  overall_confidence, needs_review, user_id
           FROM contract_ledger
           WHERE contract_no = ?`,
        )
        .get(normalized)) as
    | {
        contract_no: string;
        display_contract_no: string;
        doc_type: string;
        document_id: string;
        title: string;
        fields: string;
        field_meta: string;
        overall_confidence: number;
        needs_review: number;
        user_id: string;
      }
    | undefined;
  if (!row) return null;
  return {
    contractNo: row.contract_no,
    displayContractNo: row.display_contract_no,
    docType: row.doc_type,
    documentId: row.document_id,
    title: row.title,
    fields: JSON.parse(row.fields) as ContractLedgerEntry['fields'],
    fieldMeta: JSON.parse(row.field_meta) as ContractLedgerEntry['fieldMeta'],
    overallConfidence: row.overall_confidence,
    needsReview: !!row.needs_review,
    userId: row.user_id,
  };
}
