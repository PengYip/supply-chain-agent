// Postgres repository implementations. Mirror the SQLite repo fns
// (db/repositories.ts) one-for-one against the pg schema (postgres-schema.ts)
// using raw parameterized SQL over the node-postgres Pool. Each fn is async and
// takes a PostgresDbContext (narrowed by the dispatcher in repositories.ts).
//
// JSON columns (block_model / fields / field_meta / source_refs) are JSONB: we
// JSON.stringify on write (pg accepts text -> jsonb cast) and node-postgres
// auto-parses jsonb back to a JS object on read. numeric(p,s) columns (confidence)
// come back as STRINGS (node-postgres preserves precision), so we parseFloat on
// read. The FTS path replaces SQLite FTS5 bm25() with Postgres ts_rank over a
// GENERATED tsvector column + GIN index (searchChunksPg).
//
// bm25 convention: SQLite bm25() is "more negative = better" and the recall tool
// unifies on `-bm25` (higher=better). To stay byte-compatible with that contract
// we return bm25Score = -ts_rank (ts_rank is positive higher=better), so the same
// "more negative = better" + ORDER BY ascending holds on both backends.

import type { PostgresDbContext } from './client.js';
import type { BlockModel, DocType, SourceSpan } from '../types.js';
import type { SpanMatchStrength } from '../spanValidator.js';
import type {
  ExtractionInput,
  BindingInput,
  BindingRow,
  ChunkInput,
  ChunkMatch,
  ChunkMeta,
} from './repositories.js';

// Phase 2 business-data isolation: same convention as repositories.ts -- a
// normalized '' means "unscoped" (legacy/tests) and the filter is skipped.
function effectiveUserId(userId?: string): string {
  return userId && userId.length > 0 ? userId : '';
}

const rid = (p: string) =>
  `${p}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

export async function saveDocumentPg(
  ctx: PostgresDbContext,
  model: BlockModel,
  userId?: string,
): Promise<string> {
  await ctx.pool.query(
    `INSERT INTO documents (id, doc_type, modality, source_uri, block_model, user_id)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      model.docId,
      model.docType,
      model.modality,
      model.sourceUri,
      JSON.stringify(model),
      effectiveUserId(userId),
    ],
  );
  return model.docId;
}

export async function loadDocumentPg(
  ctx: PostgresDbContext,
  docId: string,
  userId?: string,
): Promise<BlockModel | null> {
  const uid = effectiveUserId(userId);
  const res = uid
    ? await ctx.pool.query(
        'SELECT block_model FROM documents WHERE id = $1 AND user_id = $2',
        [docId, uid],
      )
    : await ctx.pool.query(
        'SELECT block_model FROM documents WHERE id = $1',
        [docId],
      );
  if (res.rowCount === 0 || !res.rows[0]) return null;
  // jsonb auto-parsed to object by node-postgres.
  return res.rows[0].block_model as BlockModel;
}

export async function saveExtractionPg(
  ctx: PostgresDbContext,
  input: ExtractionInput,
  userId?: string,
): Promise<string> {
  const id = rid('EX');
  await ctx.pool.query(
    `INSERT INTO extractions
       (id, document_id, doc_type, fields, field_meta, overall_confidence, needs_review, user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      id,
      input.documentId,
      input.docType,
      JSON.stringify(input.fields),
      JSON.stringify(input.fieldMeta),
      input.overallConfidence,
      input.needsReview,
      effectiveUserId(userId),
    ],
  );
  return id;
}

export async function saveBindingPg(
  ctx: PostgresDbContext,
  input: BindingInput,
  userId?: string,
): Promise<string> {
  const id = rid('BD');
  await ctx.pool.query(
    `INSERT INTO bindings
       (id, document_id, contract_no, relation, source_refs, confidence, created_by, user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      id,
      input.documentId,
      input.contractNo,
      input.relation,
      JSON.stringify(input.sourceRefs),
      input.confidence,
      input.createdBy,
      effectiveUserId(userId),
    ],
  );
  return id;
}

export async function listBindingsForContractPg(
  ctx: PostgresDbContext,
  contractNo: string,
): Promise<BindingRow[]> {
  const res = await ctx.pool.query(
    `SELECT id, document_id, contract_no, relation, source_refs, confidence, created_by
     FROM bindings WHERE contract_no = $1`,
    [contractNo],
  );
  return res.rows.map((r) => ({
    id: r.id,
    documentId: r.document_id,
    contractNo: r.contract_no,
    relation: r.relation,
    sourceRefs: r.source_refs as SourceSpan[],
    confidence: Number(r.confidence),
    createdBy: r.created_by,
  }));
}

/**
 * Persist chunk rows. Returns the generated doc_chunk serial ids in input order.
 * The fts_vector GENERATED column auto-populates from chunk_text on INSERT, so no
 * manual FTS sync is needed (contrast SQLite's external-content FTS5 in saveChunks).
 */
export async function saveChunksPg(
  ctx: PostgresDbContext,
  documentId: string,
  chunks: ChunkInput[],
): Promise<number[]> {
  const rowids: number[] = [];
  // Single multi-row INSERT returning ids in the same order as the VALUES list.
  // Build a parameterized VALUES list ($n triples) so it is one round-trip.
  if (chunks.length === 0) return rowids;
  const values: unknown[] = [];
  const placeholders: string[] = [];
  let p = 1;
  for (const c of chunks) {
    placeholders.push(`($${p}, $${p + 1}, $${p + 2})`);
    values.push(documentId, c.text, c.index);
    p += 3;
  }
  const res = await ctx.pool.query(
    `INSERT INTO doc_chunk (document_id, chunk_text, chunk_index)
     VALUES ${placeholders.join(', ')}
     RETURNING id`,
    values,
  );
  for (const row of res.rows) {
    rowids.push(Number(row.id));
  }
  return rowids;
}

/**
 * FTS keyword recall over doc_chunk via the GENERATED fts_vector column +
 * plainto_tsquery (safe against arbitrary input -- no operator injection). Ranks
 * with ts_rank (higher=better); we negate to keep the SQLite bm25 convention
 * (more negative=better, ascending ORDER = best first). ts_headline produces a
 * highlighted snippet. Returns [] for an empty/all-stopword query.
 */
export async function searchChunksPg(
  ctx: PostgresDbContext,
  query: string,
  limit: number,
  userId?: string,
): Promise<ChunkMatch[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];
  const safeLimit = limit > 0 ? Math.floor(limit) : 5;
  const uid = effectiveUserId(userId);
  // Phase 2: when userId is in scope, JOIN documents and filter on user_id so
  // recall only returns the caller's chunks. Unscoped path (uid === '') keeps
  // the pre-isolation query shape.
  const join = uid ? 'JOIN documents AS d ON d.id = c.document_id' : '';
  const userFilter = uid ? 'AND d.user_id = $3' : '';
  const params = uid ? [trimmed, safeLimit, uid] : [trimmed, safeLimit];
  let res;
  try {
    res = await ctx.pool.query(
      `SELECT
         c.id            AS "chunkRowId",
         c.document_id   AS "documentId",
         c.chunk_index   AS "chunkIndex",
         ts_headline('simple', c.chunk_text, plainto_tsquery('simple', $1)) AS snippet,
         ts_rank(c.fts_vector, plainto_tsquery('simple', $1)) AS rank
       FROM doc_chunk AS c
       ${join}
       WHERE c.fts_vector @@ plainto_tsquery('simple', $1)
       ${userFilter}
       ORDER BY rank DESC
       LIMIT $2`,
      params,
    );
  } catch {
    // Missing fts_vector/GIN (un-migrated) -> surface as no matches, never throw.
    return [];
  }
  return res.rows.map((r) => ({
    chunkRowId: Number(r.chunkRowId),
    documentId: r.documentId,
    chunkIndex: r.chunkIndex,
    snippet: r.snippet,
    // Negate so the SQLite "more negative = better" contract holds.
    bm25Score: -Number(r.rank),
  }));
}

/**
 * Fetch chunk metadata for a set of doc_chunk ids. Uses ANY(int[]) so it is one
 * round-trip regardless of input size. Returns an id -> ChunkMeta map.
 */
export async function getChunkMetaByRowidsPg(
  ctx: PostgresDbContext,
  rowids: number[],
  userId?: string,
): Promise<Map<number, ChunkMeta>> {
  const out = new Map<number, ChunkMeta>();
  if (rowids.length === 0) return out;
  const uid = effectiveUserId(userId);
  const res = uid
    ? await ctx.pool.query(
        `SELECT c.id, c.document_id, c.chunk_index, c.chunk_text
         FROM doc_chunk AS c
         JOIN documents AS d ON d.id = c.document_id
         WHERE c.id = ANY($1) AND d.user_id = $2`,
        [rowids, uid],
      )
    : await ctx.pool.query(
        `SELECT id, document_id, chunk_index, chunk_text
         FROM doc_chunk
         WHERE id = ANY($1)`,
        [rowids],
      );
  for (const r of res.rows) {
    out.set(Number(r.id), {
      documentId: r.document_id,
      chunkIndex: r.chunk_index,
      text: r.chunk_text,
    });
  }
  return out;
}

// ---- Postgres vector store (pgvector) ---------------------------------------
//
// vec0 -> vector(1024) column (doc_chunk.embedding). Cosine KNN via the `<=>`
// operator (pgvector). saveChunkVectorsPg UPDATEs the embedding column for the
// given chunk rowids; vectorKnnPg runs the ANN search (HNSW index when present).

export interface VectorRow {
  chunkRowId: number;
  vec: number[];
}

export interface VecKnnHit {
  chunkRowId: number;
  distance: number;
}

/** pgvector text literal for a number vector: '[0.1,0.2,...]'. */
function vecLiteral(vec: number[]): string {
  return `[${vec.join(',')}]`;
}

/**
 * Upsert chunk embeddings into doc_chunk.embedding. Re-embedding the same chunk
 * id just overwrites (UPDATE), matching the sqlite-vec delete-then-insert upsert.
 * Returns the number of rows written.
 */
export async function saveChunkVectorsPg(
  ctx: PostgresDbContext,
  rows: VectorRow[],
): Promise<number> {
  if (rows.length === 0) return 0;
  // One UPDATE per row inside an implicit transaction (Promise.all would race on
  // the same pool; sequential awaits are safe and ingest has few chunks).
  let written = 0;
  for (const r of rows) {
    const res = await ctx.pool.query(
      `UPDATE doc_chunk SET embedding = $1::vector WHERE id = $2`,
      [vecLiteral(r.vec), r.chunkRowId],
    );
    written += res.rowCount ?? 0;
  }
  return written;
}

/**
 * Cosine KNN over doc_chunk.embedding via `<=>`. Returns up to `k` nearest chunk
 * rowids, nearest first. Skips rows with NULL embedding (not yet embedded).
 */
export async function vectorKnnPg(
  ctx: PostgresDbContext,
  queryVec: number[],
  k: number,
): Promise<VecKnnHit[]> {
  const safeK = k > 0 ? Math.floor(k) : 5;
  let res;
  try {
    res = await ctx.pool.query(
      `SELECT id AS "chunkRowId", embedding <=> $1::vector AS distance
       FROM doc_chunk
       WHERE embedding IS NOT NULL
       ORDER BY embedding <=> $1::vector
       LIMIT $2`,
      [vecLiteral(queryVec), safeK],
    );
  } catch {
    return [];
  }
  return res.rows.map((r) => ({
    chunkRowId: Number(r.chunkRowId),
    distance: Number(r.distance),
  }));
}

// ---- File manager: document minio_key link-back + virtual folders ----------
//
// Mirror of the SQLite helpers in repositories.ts. Raw parameterized SQL over
// the Pool. minio_key is nullable; lookups fall back to a source_uri LIKE match
// for rows written before the column existed (legacy uploads).

/** Set the MinIO object key on a document row (post-ingest link-back). */
export async function setDocumentMinioKeyPg(
  ctx: PostgresDbContext,
  docId: string,
  minioKey: string,
): Promise<void> {
  await ctx.pool.query(
    'UPDATE documents SET minio_key = $1 WHERE id = $2',
    [minioKey, docId],
  );
}

/**
 * Batch-lookup document ids by MinIO object key. Phase 1 is an exact match on
 * documents.minio_key; phase 2 falls back to a source_uri LIKE match for keys
 * not resolved (legacy rows without minio_key -- source_uri ends with the slash-
 * flattened key). Returns a Map<minioKey, docId>.
 */
export async function findDocIdsByMinioKeysPg(
  ctx: PostgresDbContext,
  minioKeys: string[],
  userId?: string,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (minioKeys.length === 0) return out;
  const uid = effectiveUserId(userId);
  // Phase 1: exact minio_key match.
  const res = uid
    ? await ctx.pool.query(
        'SELECT id, minio_key FROM documents WHERE minio_key = ANY($1) AND user_id = $2',
        [minioKeys, uid],
      )
    : await ctx.pool.query(
        'SELECT id, minio_key FROM documents WHERE minio_key = ANY($1)',
        [minioKeys],
      );
  for (const r of res.rows) {
    out.set(r.minio_key, r.id);
  }
  // Phase 2: source_uri LIKE fallback for unresolved keys. Match by the unique
  // <uuid>-<filename> tail (last path segment) so the lookup survives folder
  // moves -- the full flat key changes on move, but the last segment is invariant.
  const missing = minioKeys.filter((k) => !out.has(k));
  for (const key of missing) {
    const lastSeg = key.split('/').pop() ?? key;
    const flat = `%${lastSeg}`;
    const r = uid
      ? await ctx.pool.query(
          'SELECT id FROM documents WHERE source_uri LIKE $1 AND (user_id = $2 OR user_id = \'\' OR user_id IS NULL) LIMIT 1',
          [flat, uid],
        )
      : await ctx.pool.query(
          'SELECT id FROM documents WHERE source_uri LIKE $1 LIMIT 1',
          [flat],
        );
    if (r.rows[0]) out.set(key, r.rows[0].id);
  }
  return out;
}

/** List the user's virtual folders (path ascending). */
export async function listFileFoldersPg(
  ctx: PostgresDbContext,
  userId: string,
): Promise<Array<{ id: string; path: string }>> {
  const res = await ctx.pool.query(
    'SELECT id, path FROM file_folders WHERE user_id = $1 ORDER BY path ASC',
    [userId],
  );
  return res.rows.map((r) => ({ id: r.id, path: r.path }));
}

/** Insert a virtual folder row. Returns the generated id. */
export async function createFileFolderPg(
  ctx: PostgresDbContext,
  userId: string,
  folderPath: string,
  id: string,
): Promise<string> {
  await ctx.pool.query(
    'INSERT INTO file_folders (id, user_id, path) VALUES ($1, $2, $3)',
    [id, userId, folderPath],
  );
  return id;
}

/** Delete a virtual folder row. Returns true iff a row was removed. */
export async function deleteFileFolderPg(
  ctx: PostgresDbContext,
  userId: string,
  folderPath: string,
): Promise<boolean> {
  const res = await ctx.pool.query(
    'DELETE FROM file_folders WHERE user_id = $1 AND path = $2',
    [userId, folderPath],
  );
  return (res.rowCount ?? 0) > 0;
}
