import { eq, and } from 'drizzle-orm';
import { documents, extractions, bindings } from './schema.js';
import type { DbContext } from './client.js';
import type { BlockModel, DocType, SourceSpan } from '../types.js';
import type { SpanMatchStrength } from '../spanValidator.js';
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
} from './postgres-repositories.js';

// Phase 2 business-data isolation: a normalized userId is '' / undefined when the
// caller is unscoped (legacy path, most tests). When a non-empty userId IS in
// scope, repository fns filter every read by it so one tenant cannot see
// another's documents / extractions / bindings / chunks. Writes stamp the row.
export function effectiveUserId(userId?: string): string {
  return userId && userId.length > 0 ? userId : '';
}

export interface ExtractionInput {
  documentId: string;
  docType: DocType;
  fields: Record<string, { value: string | number; sourceSpans: SourceSpan[] }>;
  fieldMeta: Record<string, { strength: SpanMatchStrength; confidence: number }>;
  overallConfidence: number;
  needsReview: boolean;
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
  const filter = uid ? and(eq(documents.id, docId), eq(documents.userId, uid)) : eq(documents.id, docId);
  const row = ctx.db.select().from(documents).where(filter).all()[0];
  return row ? (JSON.parse(row.blockModel) as BlockModel) : null;
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
): Promise<number[]> {
  if (ctx.backend === 'postgres') return saveChunksPg(ctx, documentId, chunks);
  const insertChunk = ctx.sqlite.prepare(
    'INSERT INTO doc_chunk (document_id, chunk_text, chunk_index) VALUES (?, ?, ?)',
  );
  const insertFts = ctx.sqlite.prepare(
    'INSERT INTO doc_chunk_fts (rowid, chunk_text) VALUES (?, ?)',
  );
  const rowids: number[] = [];
  const tx = ctx.sqlite.transaction((rows: ChunkInput[]) => {
    for (const c of rows) {
      const info = insertChunk.run(documentId, c.text, c.index);
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
     ${uid ? 'AND d.user_id = ?' : ''}
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
    ? `SELECT dc.id, dc.document_id, dc.chunk_index, dc.chunk_text
       FROM doc_chunk AS dc
       JOIN documents AS d ON d.id = dc.document_id
       WHERE dc.id IN (${placeholders}) AND d.user_id = ?`
    : `SELECT id, document_id, chunk_index, chunk_text
       FROM doc_chunk
       WHERE id IN (${placeholders})`;
  const params: Array<string | number> = uid ? [...rowids, uid] : rowids;
  const rows = ctx.sqlite.prepare(sql).all(...params) as Array<{
    id: number | bigint;
    document_id: string;
    chunk_index: number | null;
    chunk_text: string;
  }>;
  for (const r of rows) {
    out.set(Number(r.id), {
      documentId: r.document_id,
      chunkIndex: r.chunk_index,
      text: r.chunk_text,
    });
  }
  return out;
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
  // Phase 1: exact minio_key match (batch via IN).
  const placeholders = minioKeys.map(() => '?').join(',');
  const sql1 = uid
    ? `SELECT id, minio_key FROM documents WHERE minio_key IN (${placeholders}) AND user_id = ?`
    : `SELECT id, minio_key FROM documents WHERE minio_key IN (${placeholders})`;
  const params1: string[] = uid ? [...minioKeys, uid] : minioKeys;
  const rows1 = ctx.sqlite.prepare(sql1).all(...params1) as Array<{
    id: string;
    minio_key: string;
  }>;
  for (const r of rows1) out.set(r.minio_key, r.id);
  // Phase 2: source_uri LIKE fallback for unresolved keys (legacy rows).
  const missing = minioKeys.filter((k) => !out.has(k));
  for (const key of missing) {
    const flat = `%${key.replace(/\//g, '_')}`;
    const sql2 = uid
      ? 'SELECT id FROM documents WHERE source_uri LIKE ? AND user_id = ? LIMIT 1'
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
