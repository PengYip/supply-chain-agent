import { eq } from 'drizzle-orm';
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
} from './postgres-repositories.js';

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

export async function saveDocument(ctx: DbContext, model: BlockModel): Promise<string> {
  if (ctx.backend === 'postgres') return saveDocumentPg(ctx, model);
  ctx.db.insert(documents).values({
    id: model.docId,
    docType: model.docType,
    modality: model.modality,
    sourceUri: model.sourceUri,
    blockModel: JSON.stringify(model),
  }).run();
  return model.docId;
}

export async function loadDocument(ctx: DbContext, docId: string): Promise<BlockModel | null> {
  if (ctx.backend === 'postgres') return loadDocumentPg(ctx, docId);
  const row = ctx.db.select().from(documents).where(eq(documents.id, docId)).all()[0];
  return row ? (JSON.parse(row.blockModel) as BlockModel) : null;
}

export async function saveExtraction(ctx: DbContext, input: ExtractionInput): Promise<string> {
  if (ctx.backend === 'postgres') return saveExtractionPg(ctx, input);
  const id = rid('EX');
  ctx.db.insert(extractions).values({
    id,
    documentId: input.documentId,
    docType: input.docType,
    fields: JSON.stringify(input.fields),
    fieldMeta: JSON.stringify(input.fieldMeta),
    overallConfidence: input.overallConfidence,
    needsReview: input.needsReview,
  }).run();
  return id;
}

export async function saveBinding(ctx: DbContext, input: BindingInput): Promise<string> {
  if (ctx.backend === 'postgres') return saveBindingPg(ctx, input);
  const id = rid('BD');
  ctx.db.insert(bindings).values({
    id,
    documentId: input.documentId,
    contractNo: input.contractNo,
    relation: input.relation,
    sourceRefs: JSON.stringify(input.sourceRefs),
    confidence: input.confidence,
    createdBy: input.createdBy,
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
): Promise<ChunkMatch[]> {
  if (ctx.backend === 'postgres') return searchChunksPg(ctx, query, limit);
  const ftsQuery = sanitizeFtsQuery(query);
  if (!ftsQuery) return [];
  const safeLimit = limit > 0 ? Math.floor(limit) : 5;
  // Column-scoped MATCH (f.chunk_text) + alias JOIN: a bare `doc_chunk_fts MATCH`
  // collides with the external content table name in the same FROM. snippet() and
  // bm25() read content via content_rowid -> doc_chunk.id.
  const stmt = ctx.sqlite.prepare(
    `SELECT
       dc.id           AS chunkRowId,
       dc.document_id  AS documentId,
       dc.chunk_index  AS chunkIndex,
       snippet(doc_chunk_fts, 0, '<<', '>>', '...', 16) AS snippet,
       bm25(doc_chunk_fts) AS bm25Score
     FROM doc_chunk AS dc
     JOIN doc_chunk_fts AS f ON f.rowid = dc.id
     WHERE f.chunk_text MATCH ?
     ORDER BY bm25Score
     LIMIT ?`,
  );
  try {
    const rows = stmt.all(ftsQuery, safeLimit) as Array<{
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
): Promise<Map<number, ChunkMeta>> {
  if (ctx.backend === 'postgres') return getChunkMetaByRowidsPg(ctx, rowids);
  const out = new Map<number, ChunkMeta>();
  if (rowids.length === 0) return out;
  const placeholders = rowids.map(() => '?').join(',');
  const rows = ctx.sqlite
    .prepare(
      `SELECT id, document_id, chunk_index, chunk_text
       FROM doc_chunk
       WHERE id IN (${placeholders})`,
    )
    .all(...rowids) as Array<{
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
