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
import type { BlockModel, DocType, Modality, SourceSpan } from '../types.js';
import type { SpanMatchStrength } from '../spanValidator.js';
import type {
  ExtractionInput,
  BindingInput,
  BindingRow,
  ChunkInput,
  ChunkMatch,
  ChunkMeta,
  ExtractionRow,
  ClassificationInput,
  ClassificationRow,
  DocumentTagSource,
  DocumentTagRow,
  ReviewStatus,
  ProposedRelationship,
  ReviewSnapshot,
  DocumentVectorization,
  ChunkTagDetail,
  ExtractionStatus,
  ParseStatus,
  DocumentStubInput,
} from './repositories.js';

// Phase 2 business-data isolation: same convention as repositories.ts -- a
// normalized '' means "unscoped" (legacy/tests) and the filter is skipped.
function effectiveUserId(userId?: string): string {
  return userId && userId.length > 0 ? userId : '';
}

const rid = (p: string) =>
  `${p}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

/** Doc-id generator mirroring newDocId (documentEntry.ts) for stub rows. */
const newDocRowId = () => `DOC-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

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
  // Legacy rows (pre-Phase 2) have user_id = '' (or NULL) and must stay
  // accessible to any authenticated caller -- a strict `user_id = $uid` filter
  // would hide them. Same convention as findDocIdsByMinioKeysPg.
  const res = uid
    ? await ctx.pool.query(
        "SELECT block_model FROM documents WHERE id = $1 AND (user_id = $2 OR user_id = '' OR user_id IS NULL)",
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
       (id, document_id, doc_type, fields, field_meta, overall_confidence, needs_review, proposed_relationships, user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      id,
      input.documentId,
      input.docType,
      JSON.stringify(input.fields),
      JSON.stringify(input.fieldMeta),
      input.overallConfidence,
      input.needsReview,
      input.proposedRelationships ? JSON.stringify(input.proposedRelationships) : null,
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
  chunkTags?: (string[] | null)[],
): Promise<number[]> {
  const rowids: number[] = [];
  // Single multi-row INSERT returning ids in the same order as the VALUES list.
  // Build a parameterized VALUES list ($n triples) so it is one round-trip.
  if (chunks.length === 0) return rowids;
  // Lane B: when chunkTags is supplied (aligned by index), write a 4th JSONB
  // column. Omitted -> 3-column insert (unchanged behavior; tags=NULL).
  const writeTags = Array.isArray(chunkTags) && chunkTags.length > 0;
  const values: unknown[] = [];
  const placeholders: string[] = [];
  let p = 1;
  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i]!;
    if (writeTags) {
      placeholders.push(`($${p}, $${p + 1}, $${p + 2}, $${p + 3}::jsonb)`);
      const t = chunkTags![i] ?? null;
      values.push(documentId, c.text, c.index, t === null ? null : JSON.stringify(t));
      p += 4;
    } else {
      placeholders.push(`($${p}, $${p + 1}, $${p + 2})`);
      values.push(documentId, c.text, c.index);
      p += 3;
    }
  }
  const cols = writeTags
    ? 'document_id, chunk_text, chunk_index, tags'
    : 'document_id, chunk_text, chunk_index';
  const res = await ctx.pool.query(
    `INSERT INTO doc_chunk (${cols})
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
  // Legacy rows (user_id = '' / NULL) are accessible to any caller. Matching
  // the findDocIdsByMinioKeysPg convention so recall never hides pre-isolation docs.
  const userFilter = uid
    ? "AND (d.user_id = $3 OR d.user_id = '' OR d.user_id IS NULL)"
    : '';
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
        `SELECT c.id, c.document_id, c.chunk_index, c.chunk_text, c.tags
         FROM doc_chunk AS c
         JOIN documents AS d ON d.id = c.document_id
         WHERE c.id = ANY($1) AND (d.user_id = $2 OR d.user_id = '' OR d.user_id IS NULL)`,
        [rowids, uid],
      )
    : await ctx.pool.query(
        `SELECT id, document_id, chunk_index, chunk_text, tags
         FROM doc_chunk
         WHERE id = ANY($1)`,
        [rowids],
      );
  for (const r of res.rows) {
    // jsonb auto-parses to a JS value on read; coerce non-arrays to null so the
    // ChunkMeta.tags contract (string[] | null) always holds.
    const rawTags = (r as { tags?: unknown }).tags;
    const tags: string[] | null = Array.isArray(rawTags) ? rawTags : null;
    out.set(Number(r.id), {
      documentId: r.document_id,
      chunkIndex: r.chunk_index,
      text: r.chunk_text,
      tags,
    });
  }
  return out;
}

// ---- Counts / extraction load / classification / tags / cascade delete -------
//
// pg parity for the previously-stubbed fns in repositories.ts. Each mirrors its
// SQLite twin 1:1; raw parameterized SQL over the Pool. jsonb auto-parses on
// read; numeric(p,s) comes back as STRING so Number() on read; pg needs_review
// is boolean so filter with `= true` (not `= 1`).

export async function countDocumentsPg(ctx: PostgresDbContext, userId?: string): Promise<number> {
  const uid = effectiveUserId(userId);
  const res = await ctx.pool.query(
    "SELECT COUNT(*)::int AS n FROM documents WHERE user_id = $1 OR user_id = '' OR user_id IS NULL",
    [uid],
  );
  return Number(res.rows[0]?.n ?? 0);
}

export async function countExtractionsNeedingReviewPg(ctx: PostgresDbContext, userId?: string): Promise<number> {
  const uid = effectiveUserId(userId);
  const res = await ctx.pool.query(
    "SELECT COUNT(*)::int AS n FROM extractions WHERE needs_review = true AND (user_id = $1 OR user_id = '' OR user_id IS NULL)",
    [uid],
  );
  return Number(res.rows[0]?.n ?? 0);
}

export async function loadExtractionPg(
  ctx: PostgresDbContext,
  extractionId: string,
  userId?: string,
): Promise<ExtractionRow | null> {
  const uid = effectiveUserId(userId);
  const res = uid
    ? await ctx.pool.query(
        "SELECT id, document_id, doc_type, fields, field_meta, overall_confidence, needs_review FROM extractions WHERE id = $1 AND (user_id = $2 OR user_id = '' OR user_id IS NULL)",
        [extractionId, uid],
      )
    : await ctx.pool.query(
        'SELECT id, document_id, doc_type, fields, field_meta, overall_confidence, needs_review FROM extractions WHERE id = $1',
        [extractionId],
      );
  if (!res.rows[0]) return null;
  const r = res.rows[0];
  return {
    id: r.id,
    documentId: r.document_id,
    docType: r.doc_type as DocType,
    fields: r.fields,
    fieldMeta: r.field_meta,
    overallConfidence: Number(r.overall_confidence),
    needsReview: !!r.needs_review,
  };
}

// Latest extraction row for a document (Task 7 update_document_fields merge
// base). Mirrors loadExtractionPg but keyed on document_id with ORDER BY
// created_at DESC LIMIT 1. fields/field_meta are jsonb -> node-postgres already
// returns them parsed, so NO JSON.parse here (SQLite branch does JSON.parse).
export async function loadLatestExtractionByDocIdPg(
  ctx: PostgresDbContext,
  docId: string,
  userId?: string,
): Promise<ExtractionRow | null> {
  const uid = effectiveUserId(userId);
  const res = uid
    ? await ctx.pool.query(
        `SELECT id, document_id, doc_type, fields, field_meta, overall_confidence, needs_review
         FROM extractions
         WHERE document_id = $1 AND (user_id = $2 OR user_id = '' OR user_id IS NULL)
         ORDER BY created_at DESC LIMIT 1`,
        [docId, uid],
      )
    : await ctx.pool.query(
        `SELECT id, document_id, doc_type, fields, field_meta, overall_confidence, needs_review
         FROM extractions
         WHERE document_id = $1 ORDER BY created_at DESC LIMIT 1`,
        [docId],
      );
  if (!res.rows[0]) return null;
  const r = res.rows[0];
  return {
    id: r.id,
    documentId: r.document_id,
    docType: r.doc_type as DocType,
    fields: r.fields,
    fieldMeta: r.field_meta,
    overallConfidence: Number(r.overall_confidence),
    needsReview: !!r.needs_review,
  };
}

export async function saveClassificationPg(
  ctx: PostgresDbContext,
  input: ClassificationInput,
  userId?: string,
): Promise<string> {
  const id = rid('CL');
  await ctx.pool.query(
    `INSERT INTO classifications (id, document_id, doc_type, confidence, source, hint, user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [id, input.documentId, input.docType, input.confidence, input.source, input.hint ?? null, effectiveUserId(userId)],
  );
  return id;
}

// SQLite loadClassification does `.orderBy(createdAt).all().pop()` = most recent;
// pg equivalent is ORDER BY created_at DESC LIMIT 1.
export async function loadClassificationPg(
  ctx: PostgresDbContext,
  documentId: string,
  userId?: string,
): Promise<ClassificationRow | null> {
  const uid = effectiveUserId(userId);
  const res = uid
    ? await ctx.pool.query(
        `SELECT id, document_id, doc_type, confidence, source, hint FROM classifications
         WHERE document_id = $1 AND (user_id = $2 OR user_id = '' OR user_id IS NULL)
         ORDER BY created_at DESC LIMIT 1`,
        [documentId, uid],
      )
    : await ctx.pool.query(
        `SELECT id, document_id, doc_type, confidence, source, hint FROM classifications
         WHERE document_id = $1 ORDER BY created_at DESC LIMIT 1`,
        [documentId],
      );
  if (!res.rows[0]) return null;
  const r = res.rows[0];
  return {
    id: r.id,
    documentId: r.document_id,
    docType: r.doc_type as DocType,
    confidence: Number(r.confidence),
    source: r.source,
    hint: (r.hint as DocType | null) ?? null,
  };
}

export async function saveDocumentTagsPg(
  ctx: PostgresDbContext,
  documentId: string,
  tags: string[],
  source: DocumentTagSource,
  userId?: string,
): Promise<void> {
  const uid = effectiveUserId(userId);
  // Resilience (Bug fix): dedup the input WITHIN this call so duplicate tags in
  // one array don't trip the UNIQUE index, AND use ON CONFLICT DO NOTHING so a
  // UNIQUE collision (race, or an already-existing tag) is a no-op rather than
  // throwing. The app-layer have.has pre-read stays as an optimization.
  const uniqueTags = [...new Set(tags)];
  const existing = await ctx.pool.query(
    `SELECT tag FROM document_tags
     WHERE document_id = $1 AND source = $2 AND (user_id = $3 OR user_id = '' OR user_id IS NULL)`,
    [documentId, source, uid],
  );
  const have = new Set(existing.rows.map((r: { tag: string }) => r.tag));
  for (const tag of uniqueTags) {
    if (have.has(tag)) continue;
    const id = rid('TG');
    await ctx.pool.query(
      `INSERT INTO document_tags (id, document_id, tag, source, user_id)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT DO NOTHING`,
      [id, documentId, tag, source, uid],
    );
  }
}

export async function listDocumentTagsPg(
  ctx: PostgresDbContext,
  documentId: string,
  userId?: string,
): Promise<DocumentTagRow[]> {
  const uid = effectiveUserId(userId);
  const res = uid
    ? await ctx.pool.query(
        `SELECT tag, source FROM document_tags
         WHERE document_id = $1 AND (user_id = $2 OR user_id = '' OR user_id IS NULL)
         ORDER BY tag ASC`,
        [documentId, uid],
      )
    : await ctx.pool.query(
        'SELECT tag, source FROM document_tags WHERE document_id = $1 ORDER BY tag ASC',
        [documentId],
      );
  return res.rows.map((r: { tag: string; source: string }) => ({
    tag: r.tag,
    source: r.source as DocumentTagSource,
  }));
}

/**
 * Hard-delete a document and every dependent row. pg doc_chunk holds BOTH the
 * FTS tsvector (GENERATED) AND the pgvector embedding as columns, so there are
 * NO separate fts/vec tables to clean (contrast SQLite's doc_chunk_fts/vec).
 * pg FKs are ON DELETE no action (migration default), so manual cascade like the
 * SQLite twin; wrapped in a transaction for atomicity.
 */
export async function deleteDocumentPg(
  ctx: PostgresDbContext,
  docId: string,
  userId?: string,
): Promise<{ deleted: boolean }> {
  const uid = effectiveUserId(userId);
  const owned = await ctx.pool.query(
    "SELECT 1 FROM documents WHERE id = $1 AND (user_id = $2 OR user_id = '' OR user_id IS NULL) LIMIT 1",
    [docId, uid],
  );
  if ((owned.rowCount ?? 0) === 0) return { deleted: false };
  const client = await ctx.pool.connect();
  try {
    await client.query('BEGIN');
    // doc_chunk holds both the FTS tsvector (generated) and the pgvector embedding.
    await client.query('DELETE FROM doc_chunk WHERE document_id = $1', [docId]);
    await client.query('DELETE FROM extractions WHERE document_id = $1', [docId]);
    await client.query('DELETE FROM classifications WHERE document_id = $1', [docId]);
    await client.query('DELETE FROM bindings WHERE document_id = $1', [docId]);
    await client.query('DELETE FROM document_tags WHERE document_id = $1', [docId]);
    await client.query('DELETE FROM documents WHERE id = $1', [docId]);
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
  return { deleted: true };
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
  // Phase 1: exact minio_key match. Legacy rows (user_id = '' / NULL) stay
  // accessible to any caller (same convention as the source_uri fallback below).
  const res = uid
    ? await ctx.pool.query(
        "SELECT id, minio_key FROM documents WHERE minio_key = ANY($1) AND (user_id = $2 OR user_id = '' OR user_id IS NULL)",
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

// ---- Post-ingest review (Task 3) -------------------------------------------
//
// pg twins for getReviewSnapshot / setReviewStatus / updateExtractionFields.
// Same assembly logic as the SQLite branch; jsonb columns (fields /
// field_meta / proposed_relationships) auto-parse to JS objects on read so no
// JSON.parse is needed (contrast the SQLite TEXT branch). numeric(p,s)
// confidence columns come back as strings, so Number() on read.

/** Max distinct chunk tags surfaced on the review snapshot (mirror of
 *  repositories.CHUNK_TAGS_CAP — kept local to avoid a circular runtime import). */
const CHUNK_TAGS_CAP = 16;

/** repositories.CHUNK_TAG_TEXT_CAP twin (local — circular-import avoidance). */
const CHUNK_TAG_TEXT_CAP = 800;

/**
 * Lane B (pg twin of repositories.collectChunkTags): flatten a doc_chunk tags
 * jsonb column into a DISTINCT, first-appearance-ordered list, skipping
 * null/non-array entries, capped at CHUNK_TAGS_CAP.
 */
function collectChunkTagsPg(rows: Array<{ tags: unknown }>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    if (!Array.isArray(r.tags)) continue;
    for (const t of r.tags) {
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
 * Lane B detail view (pg twin of repositories.collectChunkTagDetails): group
 * per-chunk jsonb tag arrays into tag -> chunk entries. Same first-appearance
 * order + CHUNK_TAGS_CAP + CHUNK_TAG_TEXT_CAP rules; pg column names are
 * snake_case (chunk_index / chunk_text / tags).
 */
function collectChunkTagDetailsPg(
  rows: Array<{ chunk_index: number | null; chunk_text: string | null; tags: unknown }>,
): ChunkTagDetail[] {
  const byTag = new Map<string, ChunkTagDetail>();
  const ordered: ChunkTagDetail[] = [];
  for (const r of rows) {
    if (!Array.isArray(r.tags)) continue;
    for (const t of r.tags) {
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
 * Assemble the post-ingest review snapshot for a document (pg). Returns null
 * if the document does not exist. fields come from the latest extraction row;
 * each field's needsReview is true when its confidence is below 0.7.
 */
export async function getReviewSnapshotPg(
  ctx: PostgresDbContext,
  docId: string,
  userId?: string,
): Promise<ReviewSnapshot | null> {
  const docRes = await ctx.pool.query(
    'SELECT doc_type, review_status, vectorization_meta FROM documents WHERE id = $1',
    [docId],
  );
  if (!docRes.rows[0]) return null;
  const doc = docRes.rows[0] as {
    doc_type: string;
    review_status: string | null;
    vectorization_meta: DocumentVectorization | null;
  };

  // jsonb auto-parses to an object on read; a NULL/legacy row falls back to the
  // 'unknown' snapshot so present_document_review reports 未知 (mirrors SQLite).
  const vectorization: DocumentVectorization = doc.vectorization_meta ?? {
    status: 'unknown',
    mode: 'unknown',
    chunkCount: 0,
  };

  const exRes = await ctx.pool.query(
    `SELECT fields, field_meta, overall_confidence, proposed_relationships
     FROM extractions WHERE document_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [docId],
  );
  const ex = exRes.rows[0] as
    | {
        fields: Record<string, { value: string | number; sourceSpans: unknown[] }>;
        field_meta: Record<string, { strength: unknown; confidence: number }>;
        overall_confidence: string | number;
        proposed_relationships: ProposedRelationship[] | null;
      }
    | undefined;

  const clsRes = await ctx.pool.query(
    'SELECT confidence FROM classifications WHERE document_id = $1 ORDER BY created_at DESC LIMIT 1',
    [docId],
  );
  const cls = clsRes.rows[0] as { confidence: string | number } | undefined;

  // Tags in insertion order (created_at, id) to mirror the SQLite rowid order
  // on the review snapshot (ingest-emission order, not alphabetical).
  const tagRes = await ctx.pool.query(
    'SELECT tag FROM document_tags WHERE document_id = $1 ORDER BY created_at, id',
    [docId],
  );

  // Lane B: per-chunk semantic tags + chunk text for the detail view. jsonb
  // auto-parses to arrays on read; scoped by userId like getChunkMetaByRowidsPg.
  const uid = effectiveUserId(userId);
  const chunkTagRes = uid
    ? await ctx.pool.query(
        `SELECT c.chunk_index, c.chunk_text, c.tags FROM doc_chunk AS c
         JOIN documents AS d ON d.id = c.document_id
         WHERE c.document_id = $1 AND (d.user_id = $2 OR d.user_id = '' OR d.user_id IS NULL)
         ORDER BY c.chunk_index`,
        [docId, uid],
      )
    : await ctx.pool.query(
        'SELECT chunk_index, chunk_text, tags FROM doc_chunk WHERE document_id = $1 ORDER BY chunk_index',
        [docId],
      );

  const fields: ReviewSnapshot['fields'] = [];
  if (ex) {
    for (const [name, f] of Object.entries(ex.fields)) {
      const confidence = ex.field_meta[name]?.confidence ?? 0;
      fields.push({
        name,
        value: f.value,
        confidence: Number(confidence),
        needsReview: Number(confidence) < 0.7,
      });
    }
  }

  return {
    docId,
    docType: doc.doc_type,
    classificationConfidence: cls ? Number(cls.confidence) : 0,
    tags: (tagRes.rows as Array<{ tag: string }>).map((r) => r.tag),
    chunkTags: collectChunkTagsPg(chunkTagRes.rows as Array<{ tags: unknown }>),
    chunkTagDetails: collectChunkTagDetailsPg(
      chunkTagRes.rows as Array<{ chunk_index: number | null; chunk_text: string | null; tags: unknown }>,
    ),
    reviewStatus: (doc.review_status ?? 'pending') as ReviewStatus,
    fields,
    overallConfidence: ex ? Number(ex.overall_confidence) : 0,
    proposedRelationships: ex?.proposed_relationships ?? [],
    vectorization,
  };
}

/**
 * Transition a document's review_status and stamp reviewed_at/reviewed_by (pg).
 */
export async function setReviewStatusPg(
  ctx: PostgresDbContext,
  docId: string,
  status: ReviewStatus,
  userId?: string,
): Promise<void> {
  await ctx.pool.query(
    'UPDATE documents SET review_status = $1, reviewed_at = NOW(), reviewed_by = $2 WHERE id = $3',
    [status, effectiveUserId(userId), docId],
  );
}

/**
 * Persist the L4 vector-embedding outcome onto the document row (pg twin of
 * setDocumentVectorization). vectorization_meta is jsonb; node-postgres casts
 * the JSON string to jsonb on write.
 */
export async function setDocumentVectorizationPg(
  ctx: PostgresDbContext,
  docId: string,
  vectorization: DocumentVectorization,
  userId?: string,
): Promise<void> {
  void userId; // signature parity; doc-level scope already authorizes the caller
  await ctx.pool.query(
    'UPDATE documents SET vectorization_meta = $1::jsonb WHERE id = $2',
    [JSON.stringify(vectorization), docId],
  );
}

/**
 * Lane A (2a): stamp the auto-extraction lifecycle status onto a document row
 * (pg twin of setExtractionStatus). userId accepted for signature parity only.
 */
export async function setExtractionStatusPg(
  ctx: PostgresDbContext,
  docId: string,
  status: ExtractionStatus,
  userId?: string,
): Promise<void> {
  void userId; // signature parity; doc-level scope already authorizes the caller
  await ctx.pool.query(
    'UPDATE documents SET extraction_status = $1 WHERE id = $2',
    [status, docId],
  );
}

/** Read the extraction_status for a document, or null if the row does not exist (pg). */
export async function getExtractionStatusPg(
  ctx: PostgresDbContext,
  docId: string,
  userId?: string,
): Promise<ExtractionStatus | null> {
  void userId; // signature parity; doc-level scope already authorizes the caller
  const res = await ctx.pool.query(
    'SELECT extraction_status FROM documents WHERE id = $1',
    [docId],
  );
  if (!res.rows[0]) return null;
  return res.rows[0].extraction_status as ExtractionStatus;
}

/**
 * Overwrite the extracted fields + field_meta for a document after a user
 * correction (pg). Updates all extraction rows for the doc. userId is accepted
 * for signature parity but not used in the WHERE.
 */
export async function updateExtractionFieldsPg(
  ctx: PostgresDbContext,
  docId: string,
  fields: Record<string, { value: string | number; sourceSpans: unknown[] }>,
  fieldMeta: Record<string, { strength: unknown; confidence: number }>,
  userId?: string,
): Promise<void> {
  void userId; // signature parity; doc-level scope already authorizes the caller
  await ctx.pool.query(
    'UPDATE extractions SET fields = $1, field_meta = $2 WHERE document_id = $3',
    [JSON.stringify(fields), JSON.stringify(fieldMeta), docId],
  );
}

// ---- Model B: decouple upload from parse (pg twins) ------------------------
//
// Mirror of the SQLite helpers in repositories.ts. createDocumentStub inserts a
// parse_status='uploaded' row at upload time; the lifecycle fns drive it through
// parsing. Raw parameterized SQL over the Pool, same conventions as the rest of
// this file (jsonb columns cast on write; block_model placeholder is valid JSON).

/** Insert a lightweight documents stub at upload time (parse_status='uploaded'). */
export async function createDocumentStubPg(
  ctx: PostgresDbContext,
  input: DocumentStubInput,
): Promise<{ docId: string }> {
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
  await ctx.pool.query(
    `INSERT INTO documents (id, doc_type, modality, source_uri, block_model, minio_key, user_id, parse_status)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, 'uploaded')`,
    [
      docId,
      docType,
      modality,
      input.sourceUri,
      blockModel,
      input.minioKey ?? null,
      effectiveUserId(input.userId),
    ],
  );
  return { docId };
}

/**
 * UPDATE doc_type / modality / block_model on an existing documents row (pg
 * twin). blockModel is written to the jsonb block_model column when provided so
 * downstream tools can read the parsed BlockModel after processDocument.
 */
export async function updateDocumentMetaPg(
  ctx: PostgresDbContext,
  docId: string,
  input: { docType?: DocType; modality?: Modality; blockModel?: BlockModel },
  userId?: string,
): Promise<void> {
  void userId; // signature parity; doc-level scope already authorizes the caller
  const sets: string[] = [];
  const params: Array<string | null> = [];
  let pi = 1;
  if (input.docType !== undefined) {
    sets.push(`doc_type = $${pi++}`);
    params.push(input.docType);
  }
  if (input.modality !== undefined) {
    sets.push(`modality = $${pi++}`);
    params.push(input.modality);
  }
  if (input.blockModel !== undefined) {
    sets.push(`block_model = $${pi++}::jsonb`);
    params.push(JSON.stringify(input.blockModel));
  }
  if (sets.length === 0) return;
  params.push(docId);
  await ctx.pool.query(
    `UPDATE documents SET ${sets.join(', ')} WHERE id = $${pi}`,
    params,
  );
}

/** Set the parse_status lifecycle on a document (pg twin). */
export async function setDocumentParseStatusPg(
  ctx: PostgresDbContext,
  docId: string,
  status: ParseStatus,
  userId?: string,
): Promise<void> {
  void userId; // signature parity; doc-level scope already authorizes the caller
  await ctx.pool.query(
    'UPDATE documents SET parse_status = $1 WHERE id = $2',
    [status, docId],
  );
}

/** Read the parse_status for a document, or null if the row does not exist (pg). */
export async function getDocumentParseStatusPg(
  ctx: PostgresDbContext,
  docId: string,
  userId?: string,
): Promise<ParseStatus | null> {
  void userId; // signature parity; doc-level scope already authorizes the caller
  const res = await ctx.pool.query(
    'SELECT parse_status FROM documents WHERE id = $1',
    [docId],
  );
  if (!res.rows[0]) return null;
  return res.rows[0].parse_status as ParseStatus;
}

/** Read the source_uri for a document, or null if the row does not exist (pg). */
export async function getDocumentSourceUriPg(
  ctx: PostgresDbContext,
  docId: string,
  userId?: string,
): Promise<string | null> {
  void userId; // signature parity; doc-level scope already authorizes the caller
  const res = await ctx.pool.query(
    'SELECT source_uri FROM documents WHERE id = $1',
    [docId],
  );
  if (!res.rows[0]) return null;
  return res.rows[0].source_uri as string;
}
