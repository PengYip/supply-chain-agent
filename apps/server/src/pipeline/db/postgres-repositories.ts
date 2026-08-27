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
import { normalizeContractNo } from '../contractLedger.js';
import type { ContractLedgerEntry } from '../contractLedger.js';
import { rankContractSearch, type ContractSearchItem } from '../contractSearch.js';
import { deriveProposedEdges, deriveProposedRelationships } from '../extraction.js';
import { normalizeCompanyName } from '../../domain/flowDirection.js';
import { deriveContractType } from '../../domain/contractType.js';
import type { ContractType } from '../../domain/tradeSemantics.js';
import { parseGraphStatus, effectiveSelfPartyNamesForDerivation, normalizeProjectCode, ledgerRowFieldsToProjection } from './repositories.js';
import type {
  ExtractionInput,
  BindingInput,
  BindingRow,
  BindingStatus,
  ConfirmationSource,
  BindingProposedBy,
  BindingEvidence,
  BindingGraphStatus,
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
  DocumentGraphStatus,
  ChunkTagDetail,
  ExtractionStatus,
  ParseStatus,
  DocumentStubInput,
  ExecutionFlowInput,
  ExecutionFlowRow,
  ExecutionFlowSummary,
  SelfPartyRow,
  DocumentSourceRow,
  ProjectRow,
  MembershipStatus,
  MembershipProposedBy,
  ProjectMembershipRow,
  ProjectMembershipInput,
  GraphLinkInput,
  GraphLinkRow,
  GraphLinkStatus,
  QuotaInput,
  QuotaRow,
  QuotaStatus,
  TemplateTypeRow,
  TemplateAnchorWeights,
  TemplateEdgeRuleRow,
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
       (id, document_id, contract_no, relation, source_refs, confidence, created_by, user_id,
        status, confirmation_source, proposed_by, evidence, target_kind)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
    [
      id,
      input.documentId,
      input.contractNo,
      input.relation,
      JSON.stringify(input.sourceRefs),
      input.confidence,
      input.createdBy,
      effectiveUserId(userId),
      input.status ?? 'confirmed',
      input.confirmationSource ?? null,
      input.proposedBy ?? null,
      input.evidence ? JSON.stringify(input.evidence) : null,
      input.targetKind ?? 'Contract',
    ],
  );
  return id;
}

export async function listBindingsForContractPg(
  ctx: PostgresDbContext,
  contractNo: string,
): Promise<BindingRow[]> {
  const res = await ctx.pool.query(
    `SELECT id, document_id, contract_no, relation, source_refs, confidence, created_by,
            status, confirmation_source, proposed_by, evidence, graph_status, target_kind
     FROM bindings WHERE contract_no = $1`,
    [contractNo],
  );
  return res.rows.map(bindingRowFromPg);
}

// ---- Phase B: bindings 状态机 (pg twins) -------------------------------------

export async function findBindingByDocAndContractPg(
  ctx: PostgresDbContext,
  documentId: string,
  contractNo: string,
  userId?: string,
): Promise<BindingRow | null> {
  const uid = effectiveUserId(userId);
  const res = uid
    ? await ctx.pool.query(
        `SELECT id, document_id, contract_no, relation, source_refs, confidence, created_by,
                status, confirmation_source, proposed_by, evidence, graph_status, target_kind
         FROM bindings
         WHERE document_id = $1 AND contract_no = $2
           AND (user_id = $3 OR user_id = '' OR user_id IS NULL)
         ORDER BY created_at DESC LIMIT 1`,
        [documentId, contractNo, uid],
      )
    : await ctx.pool.query(
        `SELECT id, document_id, contract_no, relation, source_refs, confidence, created_by,
                status, confirmation_source, proposed_by, evidence, graph_status, target_kind
         FROM bindings
         WHERE document_id = $1 AND contract_no = $2
         ORDER BY created_at DESC LIMIT 1`,
        [documentId, contractNo],
      );
  if (!res.rows[0]) return null;
  return bindingRowFromPg(res.rows[0]);
}

export async function listBindingProposalsPg(
  ctx: PostgresDbContext,
  userId?: string,
  status: BindingStatus = 'proposed',
): Promise<Array<BindingRow & { docType: string; fileName: string }>> {
  const uid = effectiveUserId(userId);
  const res = uid
    ? await ctx.pool.query(
        `SELECT b.id, b.document_id, b.contract_no, b.relation, b.source_refs, b.confidence,
                b.created_by, b.status, b.confirmation_source, b.proposed_by, b.evidence, b.graph_status, b.target_kind,
                d.doc_type AS "docType", d.source_uri AS "sourceUri"
         FROM bindings AS b
         JOIN documents AS d ON d.id = b.document_id
         WHERE b.status = $1 AND (b.user_id = $2 OR b.user_id = '' OR b.user_id IS NULL)
         ORDER BY b.created_at DESC`,
        [status, uid],
      )
    : await ctx.pool.query(
        `SELECT b.id, b.document_id, b.contract_no, b.relation, b.source_refs, b.confidence,
                b.created_by, b.status, b.confirmation_source, b.proposed_by, b.evidence, b.graph_status, b.target_kind,
                d.doc_type AS "docType", d.source_uri AS "sourceUri"
         FROM bindings AS b
         JOIN documents AS d ON d.id = b.document_id
         WHERE b.status = $1
         ORDER BY b.created_at DESC`,
        [status],
      );
  return res.rows.map((r) => ({
    ...bindingRowFromPg(r),
    docType: r.docType,
    fileName: String(r.sourceUri).split('/').pop() ?? String(r.sourceUri),
  }));
}

export async function updateBindingStatusPg(
  ctx: PostgresDbContext,
  bindingId: string,
  status: BindingStatus,
  confirmationSource: ConfirmationSource,
  userId?: string,
): Promise<boolean> {
  const uid = effectiveUserId(userId);
  const res = uid
    ? await ctx.pool.query(
        `UPDATE bindings SET status = $1, confirmation_source = $2
         WHERE id = $3 AND (user_id = $4 OR user_id = '' OR user_id IS NULL)`,
        [status, confirmationSource, bindingId, uid],
      )
    : await ctx.pool.query(
        `UPDATE bindings SET status = $1, confirmation_source = $2 WHERE id = $3`,
        [status, confirmationSource, bindingId],
      );
  return (res.rowCount ?? 0) > 0;
}

// ---- 绑定工作台: graph_status + 工作台查询 (pg twins) -----------------------

/** bindings pg 行 -> BindingRow(所有 PG 读取函数共用, 含 graphStatus)。 */
function bindingRowFromPg(r: Record<string, unknown>): BindingRow {
  return {
    id: String(r.id),
    documentId: String(r.document_id),
    contractNo: String(r.contract_no),
    relation: String(r.relation),
    sourceRefs: r.source_refs as SourceSpan[],
    confidence: Number(r.confidence),
    createdBy: String(r.created_by),
    status: (r.status ?? 'confirmed') as BindingStatus,
    confirmationSource: (r.confirmation_source ?? null) as ConfirmationSource | null,
    proposedBy: (r.proposed_by ?? null) as BindingProposedBy | null,
    evidence: r.evidence as BindingEvidence | null,
    graphStatus: parseGraphStatus((r.graph_status ?? null) as string | null),
    targetKind: (r.target_kind ?? 'Contract') as 'Contract' | 'Project',
  };
}

export async function findBindingByIdPg(
  ctx: PostgresDbContext, bindingId: string, userId?: string,
): Promise<BindingRow | null> {
  const uid = effectiveUserId(userId);
  const rows = await ctx.pool.query(
    'SELECT * FROM bindings WHERE id = $1 AND ($2 = \'\' OR user_id = $2 OR user_id = \'\' OR user_id IS NULL)',
    [bindingId, uid],
  );
  return rows.rows[0] ? bindingRowFromPg(rows.rows[0]) : null;
}

export async function listBindingsForUserPg(ctx: PostgresDbContext, userId?: string): Promise<BindingRow[]> {
  const uid = effectiveUserId(userId);
  const rows = await ctx.pool.query(
    'SELECT * FROM bindings WHERE ($1 = \'\' OR user_id = $1 OR user_id = \'\' OR user_id IS NULL) ORDER BY created_at DESC',
    [uid],
  );
  return rows.rows.map(bindingRowFromPg);
}

export async function setBindingGraphStatusPg(
  ctx: PostgresDbContext, bindingId: string, graphStatus: BindingGraphStatus, userId?: string,
): Promise<boolean> {
  const uid = effectiveUserId(userId);
  const res = await ctx.pool.query(
    'UPDATE bindings SET graph_status = $3 WHERE id = $1 AND ($2 = \'\' OR user_id = $2 OR user_id = \'\' OR user_id IS NULL)',
    [bindingId, uid, JSON.stringify(graphStatus)],
  );
  return (res.rowCount ?? 0) > 0;
}

export async function listContractLedgerEntriesPg(
  ctx: PostgresDbContext,
  userId?: string,
): Promise<ContractLedgerEntry[]> {
  const uid = effectiveUserId(userId);
  const res = uid
    ? await ctx.pool.query(
        `SELECT contract_no, display_contract_no, doc_type, document_id, title, fields, field_meta,
                overall_confidence, needs_review, user_id, contract_type
         FROM contract_ledger
         WHERE user_id = $1 OR user_id = '' OR user_id IS NULL
         ORDER BY updated_at DESC`,
        [uid],
      )
    : await ctx.pool.query(
        `SELECT contract_no, display_contract_no, doc_type, document_id, title, fields, field_meta,
                overall_confidence, needs_review, user_id, contract_type
         FROM contract_ledger
         ORDER BY updated_at DESC`,
      );
  return res.rows.map((r) => ({
    contractNo: r.contract_no,
    displayContractNo: r.display_contract_no,
    docType: r.doc_type,
    documentId: r.document_id,
    title: r.title,
    contractType: (r.contract_type as ContractType | null) ?? null,
    fields: r.fields as ContractLedgerEntry['fields'],
    fieldMeta: r.field_meta as ContractLedgerEntry['fieldMeta'],
    overallConfidence: Number(r.overall_confidence),
    needsReview: !!r.needs_review,
    userId: r.user_id,
  }));
}

/** PG 版合同台账搜索: ILIKE 粗筛(fields 为 jsonb, 用 ->'键'->>'value') + JS 精排。 */
export async function searchContractLedgerPg(
  ctx: PostgresDbContext,
  q: string,
  userId?: string,
  limit = 10,
): Promise<ContractSearchItem[]> {
  const raw = q.trim();
  if (!raw) return [];
  const uid = effectiveUserId(userId);
  const esc = (s: string) => s.replace(/[\\%_]/g, (m) => `\\${m}`);
  const like = `%${esc(raw)}%`;
  const nq = esc(normalizeContractNo(raw));
  const ors: string[] = [
    'contract_no ILIKE $1', 'display_contract_no ILIKE $1', 'title ILIKE $1',
    `fields->'买方'->>'value' ILIKE $1`, `fields->'甲方'->>'value' ILIKE $1`,
    `fields->'卖方'->>'value' ILIKE $1`, `fields->'乙方'->>'value' ILIKE $1`,
  ];
  const params: unknown[] = [like];
  if (nq) {
    params.push(`${nq}%`);
    ors.push(`contract_no ILIKE $${params.length}`);
    // 中段片段查询(JS 精排 0.9 分路径)也需 SQL 粗筛放行, 否则永远到不了精排。
    params.push(`%${nq}%`);
    ors.push(`contract_no ILIKE $${params.length}`);
  }
  const where = uid
    ? `(user_id = $${params.length + 1} OR user_id = '' OR user_id IS NULL) AND (${ors.join(' OR ')})`
    : `(${ors.join(' OR ')})`;
  if (uid) params.push(uid);
  const res = await ctx.pool.query(
    `SELECT contract_no, display_contract_no, doc_type, document_id, title, fields, field_meta,
            overall_confidence, needs_review, user_id, contract_type
     FROM contract_ledger WHERE ${where}
     ORDER BY updated_at DESC LIMIT 200`,
    params,
  );
  const entries: ContractLedgerEntry[] = res.rows.map((r) => ({
    contractNo: r.contract_no,
    displayContractNo: r.display_contract_no,
    docType: r.doc_type,
    documentId: r.document_id,
    title: r.title,
    contractType: (r.contract_type as ContractLedgerEntry['contractType']) ?? null,
    fields: r.fields as ContractLedgerEntry['fields'],
    fieldMeta: r.field_meta as ContractLedgerEntry['fieldMeta'],
    overallConfidence: Number(r.overall_confidence),
    needsReview: !!r.needs_review,
    userId: r.user_id,
  }));
  return rankContractSearch(raw, entries, limit);
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
 * Preprocess a user search query for CJK unigram FTS: insert a space after every
 * char that is not [0-9A-Za-z ], so a contiguous Chinese run becomes
 * space-separated unigrams ('违约责任' -> '违 约 责 任 '). Without this,
 * to_tsvector('simple', ...) treats the whole run as ONE lexeme and multi-char
 * Chinese queries never match. MUST stay in sync with the fts_vector GENERATED
 * expression in migratePostgres() (client.ts) -- the column and the query must
 * apply the identical transformation or searches silently miss.
 */
export function toPgFtsQuery(q: string): string {
  return q.replace(/([^0-9A-Za-z ])/g, '$1 ');
}

/**
 * Derive search terms from a RAW user query for snippet windowing: unique CJK
 * chars (each char is its own unigram term, matching the fts_vector column) +
 * lowercased ASCII tokens. Splitting on /[^0-9A-Za-z\u4e00-\u9fff]+/ keeps CJK
 * runs intact per char and ASCII words whole.
 */
function snippetTerms(query: string): string[] {
  const terms = new Set<string>();
  for (const token of query.split(/[^0-9A-Za-z\u4e00-\u9fff]+/)) {
    if (token.length === 0) continue;
    if (/[\u4e00-\u9fff]/.test(token)) {
      for (const ch of token) terms.add(ch);
    } else {
      terms.add(token.toLowerCase());
    }
  }
  return [...terms];
}

/**
 * TS-side snippet windowing for Postgres FTS results. ts_headline is NOT usable
 * here: its default parser lexes a contiguous CJK run as ONE lexeme, while the
 * query is unigram-preprocessed ('违 约 责 任 '), so headline finds zero term
 * matches and returns a leading ~15-word fragment with no highlights (wrong
 * region of the chunk). Unigram-spacing the text inside ts_headline would inject
 * spaces between every CJK char into the snippet, making it unquotable.
 *
 * Instead: find the EARLIEST index in `text` where any term from the RAW query
 * occurs (ASCII case-insensitive), and return an 800-char window starting 50
 * chars before it. No <b> markers, no injected spaces -- the snippet is a plain
 * quotable substring. Falls back to the text head when no term is found.
 */
export function windowSnippet(text: string, query: string, max = 800): string {
  const terms = snippetTerms(query);
  let firstIdx = -1;
  for (const term of terms) {
    const idx = text.toLowerCase().indexOf(term);
    if (idx >= 0 && (firstIdx < 0 || idx < firstIdx)) firstIdx = idx;
  }
  const start = firstIdx < 0 ? 0 : Math.max(0, firstIdx - 50);
  const end = Math.min(text.length, start + max);
  const window = text.slice(start, end);
  const prefix = start > 0 ? '...' : '';
  const suffix = end < text.length ? '...' : '';
  return prefix + window + suffix;
}

/**
 * FTS keyword recall over doc_chunk via the GENERATED fts_vector column +
 * plainto_tsquery (safe against arbitrary input -- no operator injection). Ranks
 * with ts_rank (higher=better); we negate to keep the SQLite bm25 convention
 * (more negative=better, ascending ORDER = best first). Returns [] for an
 * empty/all-stopword query.
 *
 * The query is preprocessed with toPgFtsQuery (CJK unigram) before being fed to
 * plainto_tsquery -- the SAME transformation the fts_vector GENERATED column
 * applies on write, so Chinese multi-char queries match their unigrams.
 *
 * Snippets are produced TS-side via windowSnippet (NOT ts_headline): the default
 * headline parser lexes a contiguous CJK run as ONE lexeme while the query is
 * unigram-preprocessed, so headline finds zero term matches and returns a
 * leading fragment with no highlights. windowSnippet windows around the earliest
 * raw-query term occurrence instead -- see its doc comment.
 */
export async function searchChunksPg(
  ctx: PostgresDbContext,
  query: string,
  limit: number,
  userId?: string,
): Promise<ChunkMatch[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];
  const ftsQuery = toPgFtsQuery(trimmed);
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
  const params = uid ? [ftsQuery, safeLimit, uid] : [ftsQuery, safeLimit];
  let res;
  try {
    res = await ctx.pool.query(
      `SELECT
         c.id            AS "chunkRowId",
         c.document_id   AS "documentId",
         c.chunk_index   AS "chunkIndex",
         c.chunk_text    AS "rawText",
         ts_rank(c.fts_vector, plainto_tsquery('simple', $1)) AS rank
       FROM doc_chunk AS c
       ${join}
       WHERE c.fts_vector @@ plainto_tsquery('simple', $1)
       ${userFilter}
       ORDER BY rank DESC
       LIMIT $2`,
      params,
    );
  } catch (e) {
    // Missing fts_vector/GIN (un-migrated) -> surface as no matches, never throw.
    console.warn('[searchChunksPg] FTS query failed:', e instanceof Error ? e.message : e);
    return [];
  }
  return res.rows.map((r) => ({
    chunkRowId: Number(r.chunkRowId),
    documentId: r.documentId,
    chunkIndex: r.chunkIndex,
    // TS-side windowing around the earliest raw-query term (see windowSnippet).
    snippet: windowSnippet(r.rawText, trimmed),
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

/** pg twin of listUserDocuments (see repositories.ts). */
export async function listUserDocumentsPg(
  ctx: PostgresDbContext,
  userId: string,
): Promise<Array<{ id: string; docType: string; sourceUri: string | null; minioKey: string | null; createdAt: string }>> {
  const uid = effectiveUserId(userId);
  const res = await ctx.pool.query(
    "SELECT id, doc_type, source_uri, minio_key, created_at FROM documents WHERE (user_id = $1 OR user_id = '' OR user_id IS NULL) ORDER BY created_at DESC",
    [uid],
  );
  return res.rows.map((r) => ({
    id: r.id,
    docType: r.doc_type,
    sourceUri: r.source_uri,
    minioKey: r.minio_key ?? null,
    createdAt: r.created_at,
  }));
}

/** 业务顺序门禁(2026-08-25) PG 变体: 目标合同是否已挂合同类型文件。 */
export async function hasContractDocBindingPg(
  ctx: PostgresDbContext,
  contractNo: string,
  userId?: string,
): Promise<boolean> {
  const uid = effectiveUserId(userId);
  if (!uid) return false;
  const res = await ctx.pool.query(
    `SELECT 1 AS ok
       FROM bindings b
       JOIN documents d ON d.id = b.document_id
      WHERE b.contract_no = $1 AND b.status != 'rejected' AND d.doc_type = '合同'
        AND (d.user_id = $2 OR d.user_id = '' OR d.user_id IS NULL)
      LIMIT 1`,
    [contractNo, uid],
  );
  return (res.rowCount ?? 0) > 0;
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
    // 执行流水随绑定与抽取一起清理(无 FK, 显式删; 防孤儿行)。
    await client.query('DELETE FROM execution_flows WHERE document_id = $1', [docId]);
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
  // One autocommit UPDATE per row -- there is NO wrapping transaction, so a
  // failure mid-loop leaves earlier rows updated and later ones untouched.
  // Promise.all would race on the same pool; sequential awaits are safe and
  // ingest has few chunks.
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

/** Read (id, chunk_text) rows for one document in chunk order — 纠错回溯
 *  reconcileVectorizationAfterDocTypeChange 的补嵌入输入。 */
export async function listChunksByDocumentPg(
  ctx: PostgresDbContext,
  documentId: string,
): Promise<Array<{ id: number; text: string }>> {
  const res = await ctx.pool.query(
    'SELECT id, chunk_text FROM doc_chunk WHERE document_id = $1 ORDER BY chunk_index, id',
    [documentId],
  );
  return res.rows.map((r: Record<string, unknown>) => ({
    id: Number(r.id),
    text: String(r.chunk_text ?? ''),
  }));
}

/**
 * Cosine KNN over doc_chunk.embedding via `<=>`. Returns up to `k` nearest chunk
 * rowids, nearest first. Skips rows with NULL embedding (not yet embedded).
 */export async function vectorKnnPg(
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
    'SELECT id, path FROM file_folders WHERE user_id = $1 ORDER BY sort_order ASC NULLS LAST, path ASC',
    [userId],
  );
  return res.rows.map((r) => ({ id: r.id, path: r.path }));
}

/** pg twin of setFolderSortOrders -- see repositories.ts for the contract. */
export async function setFolderSortOrdersPg(
  ctx: PostgresDbContext,
  userId: string,
  paths: string[],
): Promise<number> {
  let changed = 0;
  for (let i = 0; i < paths.length; i += 1) {
    const res = await ctx.pool.query(
      'UPDATE file_folders SET sort_order = $1 WHERE user_id = $2 AND path = $3',
      [i, userId, paths[i]],
    );
    changed += res.rowCount ?? 0;
  }
  return changed;
}

/** pg twin of listFileRanks. */
export async function listFileRanksPg(
  ctx: PostgresDbContext,
  userId: string,
): Promise<Map<string, number>> {
  const res = await ctx.pool.query(
    'SELECT obj_key, sort_order FROM file_sort_orders WHERE user_id = $1',
    [userId],
  );
  return new Map(res.rows.map((r) => [r.obj_key as string, r.sort_order as number]));
}

/** pg twin of upsertFileRanks. */
export async function upsertFileRanksPg(
  ctx: PostgresDbContext,
  userId: string,
  ranks: Array<{ key: string; order: number }>,
): Promise<void> {
  for (const r of ranks) {
    await ctx.pool.query(
      `INSERT INTO file_sort_orders (user_id, obj_key, sort_order) VALUES ($1, $2, $3)
       ON CONFLICT (user_id, obj_key) DO UPDATE SET sort_order = EXCLUDED.sort_order`,
      [userId, r.key, r.order],
    );
  }
}

/** pg twin of deleteFileRank. */
export async function deleteFileRankPg(
  ctx: PostgresDbContext,
  userId: string,
  key: string,
): Promise<void> {
  await ctx.pool.query(
    'DELETE FROM file_sort_orders WHERE user_id = $1 AND obj_key = $2',
    [userId, key],
  );
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

/** pg twin of listFileFoldersUnder -- see repositories.ts for the SQL rationale. */
export async function listFileFoldersUnderPg(
  ctx: PostgresDbContext,
  userId: string,
  from: string,
): Promise<Array<{ id: string; path: string }>> {
  const res = await ctx.pool.query(
    `SELECT id, path FROM file_folders
     WHERE user_id = $1 AND (path = $2 OR substr(path, 1, LENGTH($2) + 1) = $2 || '/')`,
    [userId, from],
  );
  return res.rows.map((r) => ({ id: r.id, path: r.path }));
}

/** pg twin of renameFileFoldersPrefix. Returns the number of rows rewritten. */
export async function renameFileFoldersPrefixPg(
  ctx: PostgresDbContext,
  userId: string,
  from: string,
  to: string,
): Promise<number> {
  const res = await ctx.pool.query(
    `UPDATE file_folders SET path = $1 || substr(path, LENGTH($2) + 1)
     WHERE user_id = $3 AND (path = $2 OR substr(path, 1, LENGTH($2) + 1) = $2 || '/')`,
    [to, from, userId],
  );
  return res.rowCount ?? 0;
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
    'SELECT doc_type, review_status, vectorization_meta, graph_status FROM documents WHERE id = $1',
    [docId],
  );
  if (!docRes.rows[0]) return null;
  const doc = docRes.rows[0] as {
    doc_type: string;
    review_status: string | null;
    vectorization_meta: DocumentVectorization | null;
    graph_status: DocumentGraphStatus | null;
  };

  // jsonb auto-parses to an object on read; a NULL/legacy row falls back to the
  // 'unknown' snapshot so present_document_review reports 未知 (mirrors SQLite).
  const vectorization: DocumentVectorization = doc.vectorization_meta ?? {
    status: 'unknown',
    mode: 'unknown',
    chunkCount: 0,
  };
  const graphStatus: DocumentGraphStatus | null = doc.graph_status ?? null;

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

  // 合同类型派生: 与 SQLite 分支同规则(共用 effectiveSelfPartyNamesForDerivation,
  // 按后端分发读 self_parties); 无识别结果时挂 null。
  const contractDerivation = deriveContractType({
    docType: doc.doc_type,
    fields,
    selfPartyNames: await effectiveSelfPartyNamesForDerivation(ctx),
  });
  const contractType = contractDerivation.contractType ? contractDerivation : null;

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
    // Followup P0 (2026-08-17): derived from the current fields (mirrors the
    // SQLite branch) so corrections never drift from the graph writer.
    proposedRelationships: deriveProposedRelationships(fields),
    vectorization,
    proposedEdges: deriveProposedEdges(doc.doc_type, fields),
    contractType,
    graphStatus,
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
 * 持久化确认时图写入结果（pg twin of setDocumentGraphStatus）。graph_status
 * 为 jsonb；node-postgres 写入时以 JSON 字符串 cast。
 */
export async function setDocumentGraphStatusPg(
  ctx: PostgresDbContext,
  docId: string,
  status: DocumentGraphStatus,
  userId?: string,
): Promise<void> {
  void userId;
  await ctx.pool.query(
    'UPDATE documents SET graph_status = $1::jsonb WHERE id = $2',
    [JSON.stringify(status), docId],
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

/**
 * 修正文档的 docType(pg twin of updateDocumentType)。UPDATE documents 仅改
 * doc_type 单列; uid 在 scope 时按 3-way OR 过滤所有权。返回是否有行被更新。
 * 级联到 extractions.doc_type(执行流水物化/候选扫描以 extraction docType 为
 * 事实来源, 见 repositories.ts 的函数头注释)。级联二(Bug fix): contract_ledger
 * 行 doc_type 同步跟随, 且新类型=合同 且行内 contract_type 为 NULL 且可重派生时,
 * 以 deriveContractType + effectiveSelfPartyNamesForDerivation 重派生(与 SQLite
 * 分支同规则); 级联失败只记日志, 不翻转已成功的 documents/extractions 更新。
 */
export async function updateDocumentTypePg(
  ctx: PostgresDbContext,
  docId: string,
  docType: DocType,
  userId?: string,
): Promise<boolean> {
  const uid = effectiveUserId(userId);
  const res = uid
    ? await ctx.pool.query(
        `UPDATE documents SET doc_type = $1
         WHERE id = $2 AND (user_id = $3 OR user_id = '' OR user_id IS NULL)`,
        [docType, docId, uid],
      )
    : await ctx.pool.query('UPDATE documents SET doc_type = $1 WHERE id = $2', [docType, docId]);
  if ((res.rowCount ?? 0) === 0) return false;
  await ctx.pool.query('UPDATE extractions SET doc_type = $1 WHERE document_id = $2', [docType, docId]);
  // 级联二(Bug fix): contract_ledger 行(与 repositories.ts 同规则)。
  try {
    const sel = await ctx.pool.query(
      'SELECT id, contract_type, fields FROM contract_ledger WHERE document_id = $1',
      [docId],
    );
    if (sel.rows.length > 0) {
      await ctx.pool.query(
        'UPDATE contract_ledger SET doc_type = $1, updated_at = NOW() WHERE document_id = $2',
        [docType, docId],
      );
      if (docType === '合同') {
        let selfNames: string[] = [];
        try { selfNames = await effectiveSelfPartyNamesForDerivation(ctx); } catch { selfNames = []; }
        for (const row of sel.rows as Array<{ id: string; contract_type: string | null; fields: unknown }>) {
          if (row.contract_type !== null && row.contract_type !== '') continue;
          const derivation = deriveContractType({
            docType,
            fields: ledgerRowFieldsToProjection(row.fields),
            selfPartyNames: selfNames,
          });
          if (derivation.contractType === null) continue;
          await ctx.pool.query('UPDATE contract_ledger SET contract_type = $1 WHERE id = $2', [
            derivation.contractType,
            row.id,
          ]);
        }
      }
    }
  } catch (e) {
    console.error('[updateDocumentTypePg] contract_ledger 级联失败:', (e as Error).message);
  }
  return true;
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

/** Read source_uri + doc_type in one call (graph sync backfill), or null (pg). */
export async function getDocumentMetaPg(
  ctx: PostgresDbContext,
  docId: string,
  userId?: string,
): Promise<{ sourceUri: string | null; docType: string | null } | null> {
  void userId; // signature parity; doc-level scope already authorizes the caller
  const res = await ctx.pool.query(
    'SELECT source_uri, doc_type FROM documents WHERE id = $1',
    [docId],
  );
  if (!res.rows[0]) return null;
  const r = res.rows[0] as { source_uri: string | null; doc_type: string | null };
  return { sourceUri: r.source_uri, docType: r.doc_type };
}

// ---- Contract ledger (ingest extraction write-back, pg twins) --------------
//
// Mirror of upsertContractLedgerEntry / findContractLedgerByNoPg in
// repositories.ts. fields / field_meta are jsonb -> node-postgres auto-parses
// them to objects on read (no JSON.parse, contrast the SQLite TEXT branch);
// overall_confidence is numeric(5,4) -> Number() on read; needs_review is
// boolean. entry.contractNo / entry.userId are already normalized by the
// builder (contractLedger.ts), so no re-normalization on this side.

/**
 * Insert-or-update a contract ledger row (pg). Keyed on (contract_no, user_id);
 * the UNIQUE index backs ON CONFLICT, so a re-extraction of the same contract
 * for the same user updates the row in place. entry.userId is authoritative
 * (already normalized); the userId param is signature parity only.
 */
export async function upsertContractLedgerEntryPg(
  ctx: PostgresDbContext,
  entry: ContractLedgerEntry,
  userId?: string,
): Promise<void> {
  void userId; // entry.userId is authoritative (already normalized by the builder)
  const id = rid('CLD');
  await ctx.pool.query(
    `INSERT INTO contract_ledger
       (id, contract_no, display_contract_no, doc_type, document_id, title, fields, field_meta,
        overall_confidence, needs_review, user_id, contract_type)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     ON CONFLICT (contract_no, user_id) DO UPDATE SET
       display_contract_no = EXCLUDED.display_contract_no,
       doc_type = EXCLUDED.doc_type,
       document_id = EXCLUDED.document_id,
       title = EXCLUDED.title,
       fields = EXCLUDED.fields,
       field_meta = EXCLUDED.field_meta,
       overall_confidence = EXCLUDED.overall_confidence,
       needs_review = EXCLUDED.needs_review,
       contract_type = EXCLUDED.contract_type,
       updated_at = NOW()`,
    [
      id,
      entry.contractNo,
      entry.displayContractNo,
      entry.docType,
      entry.documentId,
      entry.title,
      JSON.stringify(entry.fields),
      JSON.stringify(entry.fieldMeta),
      entry.overallConfidence,
      entry.needsReview,
      entry.userId,
      entry.contractType,
    ],
  );
}

/**
 * Look up a contract ledger row by contract number (pg). The query key is
 * normalized the same way writes are (full-width/whitespace/case-insensitive).
 * userId filtering follows the legacy convention (3-way OR when uid is in
 * scope; unscoped callers skip the filter).
 */
export async function findContractLedgerByNoPg(
  ctx: PostgresDbContext,
  contractNo: string,
  userId?: string,
): Promise<ContractLedgerEntry | null> {
  const normalized = normalizeContractNo(contractNo);
  if (!normalized) return null; // no usable key -> no match
  const uid = effectiveUserId(userId);
  const res = uid
    ? await ctx.pool.query(
        `SELECT contract_no, display_contract_no, doc_type, document_id, title, fields, field_meta,
                overall_confidence, needs_review, user_id, contract_type
         FROM contract_ledger
         WHERE contract_no = $1 AND (user_id = $2 OR user_id = '' OR user_id IS NULL)`,
        [normalized, uid],
      )
    : await ctx.pool.query(
        `SELECT contract_no, display_contract_no, doc_type, document_id, title, fields, field_meta,
                overall_confidence, needs_review, user_id, contract_type
         FROM contract_ledger
         WHERE contract_no = $1`,
        [normalized],
      );
  if (!res.rows[0]) return null;
  const r = res.rows[0] as {
    contract_no: string;
    display_contract_no: string;
    doc_type: string;
    document_id: string;
    title: string;
    fields: ContractLedgerEntry['fields'];
    field_meta: ContractLedgerEntry['fieldMeta'];
    overall_confidence: string | number;
    needs_review: boolean;
    user_id: string;
    contract_type: string | null;
  };
  return {
    contractNo: r.contract_no,
    displayContractNo: r.display_contract_no,
    docType: r.doc_type,
    documentId: r.document_id,
    title: r.title,
    contractType: (r.contract_type as ContractType | null) ?? null,
    // jsonb auto-parsed to objects by node-postgres on read.
    fields: r.fields,
    fieldMeta: r.field_meta,
    overallConfidence: Number(r.overall_confidence),
    needsReview: !!r.needs_review,
    userId: r.user_id,
  };
}

// ---- Execution flows (六向执行流水, pg twins) --------------------------------
//
// Mirror of upsertExecutionFlow / retractExecutionFlowForBinding /
// listExecutionFlows / summarizeExecutionFlows in repositories.ts. amount /
// quantity_ton 是 double precision -> node-postgres 返回 number; confidence 是
// numeric(5,4) -> Number() 转换; created_at 是 timestamptz -> Date, 统一转 ISO
// 字符串。userId 归一化与 3-way OR 过滤与 SQLite 分支一致。

/** Postgres execution_flows 行 -> ExecutionFlowRow(所有 PG 读取函数共用)。 */
function executionFlowRowFromPg(r: Record<string, unknown>): ExecutionFlowRow {
  return {
    id: String(r.id),
    bindingId: String(r.binding_id),
    documentId: String(r.document_id),
    contractNo: String(r.contract_no),
    flowType: String(r.flow_type),
    direction: String(r.direction) as ExecutionFlowRow['direction'],
    amount: r.amount === null || r.amount === undefined ? null : Number(r.amount),
    quantityTon: r.quantity_ton === null || r.quantity_ton === undefined ? null : Number(r.quantity_ton),
    unit: r.unit === null || r.unit === undefined ? null : String(r.unit),
    docType: String(r.doc_type),
    voucherDate: r.voucher_date === null || r.voucher_date === undefined ? null : String(r.voucher_date),
    extractionId: r.extraction_id === null || r.extraction_id === undefined ? null : String(r.extraction_id),
    confidence: Number(r.confidence),
    createdBy: String(r.created_by),
    userId: r.user_id === null || r.user_id === undefined ? null : String(r.user_id),
    createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
  };
}

/**
 * 物化/更新一条执行流水(pg)。唯一键 (binding_id, user_id); UNIQUE 索引支撑
 * ON CONFLICT, 冲突时更新业务列, created_at 保持首次写入值。返回 flow id。
 */
export async function upsertExecutionFlowPg(
  ctx: PostgresDbContext,
  input: ExecutionFlowInput,
  userId?: string,
): Promise<string> {
  const id = rid('EF');
  await ctx.pool.query(
    `INSERT INTO execution_flows
       (id, binding_id, document_id, contract_no, flow_type, direction, amount, quantity_ton, unit,
        doc_type, voucher_date, extraction_id, confidence, created_by, user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
     ON CONFLICT (binding_id, user_id) DO UPDATE SET
       document_id = EXCLUDED.document_id,
       contract_no = EXCLUDED.contract_no,
       flow_type = EXCLUDED.flow_type,
       direction = EXCLUDED.direction,
       amount = EXCLUDED.amount,
       quantity_ton = EXCLUDED.quantity_ton,
       unit = EXCLUDED.unit,
       doc_type = EXCLUDED.doc_type,
       voucher_date = EXCLUDED.voucher_date,
       extraction_id = EXCLUDED.extraction_id,
       confidence = EXCLUDED.confidence,
       created_by = EXCLUDED.created_by`,
    [
      id,
      input.bindingId,
      input.documentId,
      input.contractNo,
      input.flowType,
      input.direction,
      input.amount,
      input.quantityTon,
      input.unit ?? null,
      input.docType,
      input.voucherDate,
      input.extractionId ?? null,
      input.confidence,
      input.createdBy,
      effectiveUserId(userId),
    ],
  );
  return id;
}

/** unbind 后撤回物化行(pg)。幂等: 删了行返回 true, 行不存在返回 false。 */
export async function retractExecutionFlowForBindingPg(
  ctx: PostgresDbContext,
  bindingId: string,
  userId?: string,
): Promise<boolean> {
  const uid = effectiveUserId(userId);
  const res = uid
    ? await ctx.pool.query(
        `DELETE FROM execution_flows
         WHERE binding_id = $1 AND (user_id = $2 OR user_id = '' OR user_id IS NULL)`,
        [bindingId, uid],
      )
    : await ctx.pool.query('DELETE FROM execution_flows WHERE binding_id = $1', [bindingId]);
  return (res.rowCount ?? 0) > 0;
}

/** 撤回一份文档名下的全部流水行(pg)。修正触发全量重建的前半段, 幂等。 */
export async function retractExecutionFlowsForDocumentPg(
  ctx: PostgresDbContext,
  documentId: string,
  userId?: string,
): Promise<number> {
  const uid = effectiveUserId(userId);
  const res = uid
    ? await ctx.pool.query(
        `DELETE FROM execution_flows
         WHERE document_id = $1 AND (user_id = $2 OR user_id = '' OR user_id IS NULL)`,
        [documentId, uid],
      )
    : await ctx.pool.query('DELETE FROM execution_flows WHERE document_id = $1', [documentId]);
  return res.rowCount ?? 0;
}

/** 列出一份文档的全部 confirmed 绑定(pg, 重建流水的原料)。 */
export async function listConfirmedBindingsForDocumentPg(
  ctx: PostgresDbContext,
  documentId: string,
  userId?: string,
): Promise<BindingRow[]> {
  const uid = effectiveUserId(userId);
  const res = uid
    ? await ctx.pool.query(
        `SELECT id, document_id, contract_no, relation, source_refs, confidence, created_by,
                status, confirmation_source, proposed_by, evidence, graph_status
         FROM bindings
         WHERE document_id = $1 AND status = 'confirmed'
           AND (user_id = $2 OR user_id = '' OR user_id IS NULL)
         ORDER BY created_at DESC`,
        [documentId, uid],
      )
    : await ctx.pool.query(
        `SELECT id, document_id, contract_no, relation, source_refs, confidence, created_by,
                status, confirmation_source, proposed_by, evidence, graph_status
         FROM bindings
         WHERE document_id = $1 AND status = 'confirmed'
         ORDER BY created_at DESC`,
        [documentId],
      );
  return res.rows.map(bindingRowFromPg);
}

/** 明细行(pg), 按 created_at 升序。 */
export async function listExecutionFlowsPg(
  ctx: PostgresDbContext,
  contractNo: string,
  userId?: string,
): Promise<ExecutionFlowRow[]> {
  const uid = effectiveUserId(userId);
  const res = uid
    ? await ctx.pool.query(
        `SELECT id, binding_id, document_id, contract_no, flow_type, direction, amount, quantity_ton, unit,
                doc_type, voucher_date, extraction_id, confidence, created_by, user_id, created_at
         FROM execution_flows
         WHERE contract_no = $1 AND (user_id = $2 OR user_id = '' OR user_id IS NULL)
         ORDER BY created_at ASC`,
        [contractNo, uid],
      )
    : await ctx.pool.query(
        `SELECT id, binding_id, document_id, contract_no, flow_type, direction, amount, quantity_ton, unit,
                doc_type, voucher_date, extraction_id, confidence, created_by, user_id, created_at
         FROM execution_flows
         WHERE contract_no = $1
         ORDER BY created_at ASC`,
        [contractNo],
      );
  return res.rows.map(executionFlowRowFromPg);
}

/** 六向汇总(pg): GROUP BY flow_type, direction(flow_type, direction 升序输出)。 */
export async function summarizeExecutionFlowsPg(
  ctx: PostgresDbContext,
  contractNo: string,
  userId?: string,
): Promise<ExecutionFlowSummary[]> {
  const uid = effectiveUserId(userId);
  const res = uid
    ? await ctx.pool.query(
        `SELECT flow_type, direction, COUNT(*)::int AS entry_count, SUM(amount) AS total_amount,
                SUM(quantity_ton) AS total_quantity_ton, MAX(voucher_date) AS last_voucher_date
         FROM execution_flows
         WHERE contract_no = $1 AND (user_id = $2 OR user_id = '' OR user_id IS NULL)
         GROUP BY flow_type, direction
         ORDER BY flow_type, direction`,
        [contractNo, uid],
      )
    : await ctx.pool.query(
        `SELECT flow_type, direction, COUNT(*)::int AS entry_count, SUM(amount) AS total_amount,
                SUM(quantity_ton) AS total_quantity_ton, MAX(voucher_date) AS last_voucher_date
         FROM execution_flows
         WHERE contract_no = $1
         GROUP BY flow_type, direction
         ORDER BY flow_type, direction`,
        [contractNo],
      );
  return res.rows.map((r) => ({
    contractNo,
    flowType: String(r.flow_type),
    direction: String(r.direction) as ExecutionFlowSummary['direction'],
    entryCount: Number(r.entry_count),
    totalAmount: r.total_amount === null || r.total_amount === undefined ? null : Number(r.total_amount),
    totalQuantityTon:
      r.total_quantity_ton === null || r.total_quantity_ton === undefined ? null : Number(r.total_quantity_ton),
    lastVoucherDate: r.last_voucher_date === null || r.last_voucher_date === undefined ? null : String(r.last_voucher_date),
  }));
}

// ---- 自主体名单(Task A): pg twins -------------------------------------------
//
// self_parties 为租户全局名单(无 user_id), 与 env.SELF_PARTY_NAMES 并集。

/** pg twin of listSelfParties。 */
/** pg twin of getDocumentSourcesByIds。 */
export async function getDocumentSourcesByIdsPg(
  ctx: PostgresDbContext,
  ids: string[],
): Promise<DocumentSourceRow[]> {
  if (ids.length === 0) return [];
  const res = await ctx.pool.query(
    'SELECT id, source_uri, minio_key FROM documents WHERE id = ANY($1::text[])',
    [ids],
  );
  return res.rows.map((r) => ({
    id: String(r.id),
    sourceUri: r.source_uri === null || r.source_uri === undefined ? '' : String(r.source_uri),
    minioKey: r.minio_key ?? null,
  }));
}

export async function listSelfPartiesPg(ctx: PostgresDbContext): Promise<SelfPartyRow[]> {
  const res = await ctx.pool.query(
    'SELECT name, created_by, created_at FROM self_parties ORDER BY name ASC',
  );
  return res.rows.map((r) => ({
    name: String(r.name),
    createdBy: String(r.created_by),
    createdAt: r.created_at === null || r.created_at === undefined ? null : String(r.created_at),
  }));
}

/** pg twin of addSelfParty。归一化去重先读后插 + ON CONFLICT (name) DO NOTHING 兜底。 */
export async function addSelfPartyPg(ctx: PostgresDbContext, name: string, createdBy: string): Promise<boolean> {
  const trimmed = name.trim();
  const norm = normalizeCompanyName(trimmed);
  if (norm.length === 0) return false;
  const existing = await ctx.pool.query('SELECT name FROM self_parties');
  if (existing.rows.some((r) => normalizeCompanyName(String(r.name)) === norm)) return false;
  const res = await ctx.pool.query(
    'INSERT INTO self_parties (name, created_by) VALUES ($1, $2) ON CONFLICT (name) DO NOTHING',
    [trimmed, createdBy],
  );
  return (res.rowCount ?? 0) > 0;
}

/** pg twin of removeSelfParty(原始名精确删除)。 */
export async function removeSelfPartyPg(ctx: PostgresDbContext, name: string): Promise<boolean> {
  const res = await ctx.pool.query('DELETE FROM self_parties WHERE name = $1', [name]);
  return (res.rowCount ?? 0) > 0;
}

/** pg twin of listDocumentIdsWithConfirmedBindings。 */
export async function listDocumentIdsWithConfirmedBindingsPg(
  ctx: PostgresDbContext,
  userId?: string,
): Promise<string[]> {
  const uid = effectiveUserId(userId);
  const res = uid
    ? await ctx.pool.query(
        "SELECT DISTINCT document_id FROM bindings WHERE status = 'confirmed' AND (user_id = $1 OR user_id = '' OR user_id IS NULL)",
        [uid],
      )
    : await ctx.pool.query(
        "SELECT DISTINCT document_id FROM bindings WHERE status = 'confirmed'",
      );
  return res.rows.map((r) => String(r.document_id));
}

/** pg twin of hasExecutionFlowsForDocument。 */
export async function hasExecutionFlowsForDocumentPg(
  ctx: PostgresDbContext,
  documentId: string,
  userId?: string,
): Promise<boolean> {
  const uid = effectiveUserId(userId);
  const res = uid
    ? await ctx.pool.query(
        "SELECT 1 FROM execution_flows WHERE document_id = $1 AND (user_id = $2 OR user_id = '' OR user_id IS NULL) LIMIT 1",
        [documentId, uid],
      )
    : await ctx.pool.query('SELECT 1 FROM execution_flows WHERE document_id = $1 LIMIT 1', [documentId]);
  return (res.rowCount ?? 0) > 0;
}

// ---- 项目维度 pg twins(spec 2026-08-20 §4.1) ----------------------------------
//
// Mirror of the project/membership fns in repositories.ts. graph_status 为 jsonb:
// 写侧 JSON.stringify(隐式 cast), 读侧 node-postgres 自动解析为对象。

const PROJECT_COLS_PG = 'code, name, status, user_id, created_at, updated_at';
const MEMBERSHIP_COLS_PG =
  'id, contract_no, project_code, role, status, proposed_by, confirmation_source, confidence, created_by, user_id, created_at, graph_status';

function projectRowFromPg(r: Record<string, unknown>): ProjectRow {
  return {
    code: String(r.code),
    name: String(r.name),
    status: String(r.status),
    userId: r.user_id === null || r.user_id === undefined ? null : String(r.user_id),
    createdAt: r.created_at ? String(r.created_at) : '',
    updatedAt: r.updated_at ? String(r.updated_at) : '',
  };
}

function membershipRowFromPg(r: Record<string, unknown>): ProjectMembershipRow {
  return {
    id: String(r.id),
    contractNo: String(r.contract_no),
    projectCode: String(r.project_code),
    role: r.role === null || r.role === undefined ? null : String(r.role),
    status: String(r.status) as MembershipStatus,
    proposedBy: String(r.proposed_by) as MembershipProposedBy,
    confirmationSource:
      r.confirmation_source === null || r.confirmation_source === undefined ? null : String(r.confirmation_source),
    confidence: Number(r.confidence),
    createdBy: String(r.created_by),
    userId: r.user_id === null || r.user_id === undefined ? null : String(r.user_id),
    createdAt: r.created_at ? String(r.created_at) : '',
    graphStatus: (r.graph_status as BindingGraphStatus | null) ?? null,
  };
}

export async function createProjectPg(
  ctx: PostgresDbContext,
  input: { code: string; name: string; userId?: string | null },
): Promise<ProjectRow | null> {
  const code = normalizeProjectCode(input.code);
  const uid = effectiveUserId(input.userId ?? undefined);
  const name = input.name.trim();
  if (!code || !name) return null;
  const exists = await ctx.pool.query('SELECT 1 FROM projects WHERE code = $1 AND user_id = $2', [code, uid]);
  if ((exists.rowCount ?? 0) > 0) return null;
  await ctx.pool.query(
    'INSERT INTO projects (id, code, name, status, user_id) VALUES ($1, $2, $3, $4, $5)',
    [rid('PRJ'), code, name, 'active', uid],
  );
  const row = await ctx.pool.query(
    `SELECT ${PROJECT_COLS_PG} FROM projects WHERE code = $1 AND user_id = $2`,
    [code, uid],
  );
  return row.rows[0] ? projectRowFromPg(row.rows[0]) : null;
}

export async function findProjectByCodePg(
  ctx: PostgresDbContext, code: string, userId?: string,
): Promise<ProjectRow | null> {
  const normalized = normalizeProjectCode(code);
  if (!normalized) return null;
  const uid = effectiveUserId(userId);
  const res = uid
    ? await ctx.pool.query(
        `SELECT ${PROJECT_COLS_PG} FROM projects WHERE code = $1 AND (user_id = $2 OR user_id = '' OR user_id IS NULL)`,
        [normalized, uid],
      )
    : await ctx.pool.query(`SELECT ${PROJECT_COLS_PG} FROM projects WHERE code = $1`, [normalized]);
  return res.rows[0] ? projectRowFromPg(res.rows[0]) : null;
}

export async function listProjectsPg(ctx: PostgresDbContext, userId?: string): Promise<ProjectRow[]> {
  const uid = effectiveUserId(userId);
  const res = uid
    ? await ctx.pool.query(
        `SELECT ${PROJECT_COLS_PG} FROM projects WHERE user_id = $1 OR user_id = '' OR user_id IS NULL ORDER BY code ASC`,
        [uid],
      )
    : await ctx.pool.query(`SELECT ${PROJECT_COLS_PG} FROM projects ORDER BY code ASC`);
  return res.rows.map(projectRowFromPg);
}

export async function upsertProjectMembershipPg(
  ctx: PostgresDbContext,
  input: ProjectMembershipInput,
  userId?: string,
): Promise<string> {
  const uid = effectiveUserId(userId);
  const contractNo = normalizeContractNo(input.contractNo);
  const projectCode = normalizeProjectCode(input.projectCode);
  const res = await ctx.pool.query(
    `INSERT INTO project_memberships
       (id, contract_no, project_code, role, status, proposed_by, confirmation_source, confidence, created_by, user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (contract_no, project_code, user_id) DO UPDATE SET
       role = EXCLUDED.role,
       status = EXCLUDED.status,
       proposed_by = EXCLUDED.proposed_by,
       confirmation_source = EXCLUDED.confirmation_source,
       confidence = EXCLUDED.confidence,
       created_by = EXCLUDED.created_by
     RETURNING id`,
    [
      rid('PM'),
      contractNo,
      projectCode,
      input.role ?? null,
      input.status ?? 'proposed',
      input.proposedBy ?? 'system',
      input.confirmationSource ?? null,
      input.confidence ?? 0,
      input.createdBy,
      uid,
    ],
  );
  return String(res.rows[0]!.id);
}

export async function findMembershipByIdPg(
  ctx: PostgresDbContext, id: string, userId?: string,
): Promise<ProjectMembershipRow | null> {
  const uid = effectiveUserId(userId);
  const res = uid
    ? await ctx.pool.query(
        `SELECT ${MEMBERSHIP_COLS_PG} FROM project_memberships
         WHERE id = $1 AND (user_id = $2 OR user_id = '' OR user_id IS NULL)`,
        [id, uid],
      )
    : await ctx.pool.query(`SELECT ${MEMBERSHIP_COLS_PG} FROM project_memberships WHERE id = $1`, [id]);
  return res.rows[0] ? membershipRowFromPg(res.rows[0]) : null;
}

export async function listMembershipsByProjectPg(
  ctx: PostgresDbContext,
  projectCode: string,
  userId?: string,
  status?: MembershipStatus,
): Promise<ProjectMembershipRow[]> {
  const normalized = normalizeProjectCode(projectCode);
  const uid = effectiveUserId(userId);
  const clauses = ['project_code = $1'];
  const params: unknown[] = [normalized];
  if (status) {
    params.push(status);
    clauses.push(`status = $${params.length}`);
  }
  if (uid) {
    params.push(uid);
    clauses.push(`(user_id = $${params.length} OR user_id = '' OR user_id IS NULL)`);
  }
  const res = await ctx.pool.query(
    `SELECT ${MEMBERSHIP_COLS_PG} FROM project_memberships WHERE ${clauses.join(' AND ')} ORDER BY created_at ASC`,
    params,
  );
  return res.rows.map(membershipRowFromPg);
}

export async function listMembershipsByContractPg(
  ctx: PostgresDbContext, contractNo: string, userId?: string,
): Promise<ProjectMembershipRow[]> {
  const normalized = normalizeContractNo(contractNo);
  if (!normalized) return [];
  const uid = effectiveUserId(userId);
  const res = uid
    ? await ctx.pool.query(
        `SELECT ${MEMBERSHIP_COLS_PG} FROM project_memberships
         WHERE contract_no = $1 AND (user_id = $2 OR user_id = '' OR user_id IS NULL)
         ORDER BY created_at ASC`,
        [normalized, uid],
      )
    : await ctx.pool.query(
        `SELECT ${MEMBERSHIP_COLS_PG} FROM project_memberships WHERE contract_no = $1 ORDER BY created_at ASC`,
        [normalized],
      );
  return res.rows.map(membershipRowFromPg);
}

export async function updateMembershipStatusPg(
  ctx: PostgresDbContext,
  id: string,
  status: MembershipStatus,
  confirmationSource: 'auto_rule' | 'human' | null,
  userId?: string,
): Promise<ProjectMembershipRow | null> {
  const uid = effectiveUserId(userId);
  const res = uid
    ? await ctx.pool.query(
        "UPDATE project_memberships SET status = $1, confirmation_source = $2 WHERE id = $3 AND (user_id = $4 OR user_id = '' OR user_id IS NULL)",
        [status, confirmationSource, id, uid],
      )
    : await ctx.pool.query(
        'UPDATE project_memberships SET status = $1, confirmation_source = $2 WHERE id = $3',
        [status, confirmationSource, id],
      );
  if ((res.rowCount ?? 0) === 0) return null;
  return findMembershipByIdPg(ctx, id, userId);
}

export async function setMembershipGraphStatusPg(
  ctx: PostgresDbContext, id: string, gs: BindingGraphStatus, userId?: string,
): Promise<void> {
  const uid = effectiveUserId(userId);
  if (uid) {
    await ctx.pool.query(
      "UPDATE project_memberships SET graph_status = $1 WHERE id = $2 AND (user_id = $3 OR user_id = '' OR user_id IS NULL)",
      [JSON.stringify(gs), id, uid],
    );
  } else {
    await ctx.pool.query('UPDATE project_memberships SET graph_status = $1 WHERE id = $2', [JSON.stringify(gs), id]);
  }
}

// ---- Graph links(spec 2026-08-25 方案A §3.3/§6): pg twins -------------------
// props/graph_status 为 TEXT(JSON 字符串, 与本文件 JSON-in-TEXT 惯例一致);
// confidence numeric(5,4) 读回为字符串 -> parseFloat。

interface GraphLinkPgRaw {
  id: string; kind: string; src_kind: string; src_key: string; src_label: string;
  dst_kind: string; dst_key: string; dst_label: string;
  props: string; confidence: string | number; status: string; confirmation_source: string | null;
  created_by: string; user_id: string | null; created_at: string | Date; graph_status: string | null;
}

const GRAPH_LINK_COLS_PG = `id, kind, src_kind, src_key, src_label, dst_kind, dst_key, dst_label,
  props, confidence, status, confirmation_source, created_by, user_id, created_at, graph_status`;

function graphLinkFromPg(r: GraphLinkPgRaw): GraphLinkRow {
  let props: Record<string, unknown> = {};
  try { props = JSON.parse(String(r.props ?? '{}')) as Record<string, unknown>; } catch { /* 损坏行按空 props */ }
  return {
    id: r.id, kind: r.kind,
    srcKind: r.src_kind, srcKey: r.src_key, srcLabel: r.src_label,
    dstKind: r.dst_kind, dstKey: r.dst_key, dstLabel: r.dst_label,
    props,
    confidence: typeof r.confidence === 'number' ? r.confidence : parseFloat(r.confidence ?? '0'),
    status: (r.status ?? 'proposed') as GraphLinkStatus,
    confirmationSource: r.confirmation_source ?? null,
    createdBy: r.created_by,
    userId: r.user_id ?? '',
    createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
    graphStatus: parseGraphStatus(r.graph_status),
  };
}

export async function saveGraphLinkPg(
  ctx: PostgresDbContext, input: GraphLinkInput, userId?: string,
): Promise<string> {
  const uid = effectiveUserId(userId);
  const res = await ctx.pool.query<{ id: string }>(
    `INSERT INTO graph_links
       (id, kind, src_kind, src_key, src_label, dst_kind, dst_key, dst_label,
        props, confidence, status, confirmation_source, created_by, user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
     ON CONFLICT(kind, src_key, dst_key, user_id) DO UPDATE SET
       src_label = EXCLUDED.src_label,
       dst_label = EXCLUDED.dst_label,
       props = EXCLUDED.props,
       confidence = EXCLUDED.confidence,
       status = EXCLUDED.status,
       confirmation_source = EXCLUDED.confirmation_source,
       created_by = EXCLUDED.created_by
     RETURNING id`,
    [
      rid('GL'), input.kind, input.srcKind, input.srcKey, input.srcLabel ?? '',
      input.dstKind, input.dstKey, input.dstLabel ?? '',
      JSON.stringify(input.props ?? {}), input.confidence ?? 0,
      input.status ?? 'proposed', input.confirmationSource ?? null,
      input.createdBy, uid,
    ],
  );
  const id = res.rows[0]?.id;
  if (!id) throw new Error('saveGraphLinkPg: upsert returned no id');
  return id;
}

export async function findGraphLinkByIdPg(
  ctx: PostgresDbContext, id: string, userId?: string,
): Promise<GraphLinkRow | null> {
  const uid = effectiveUserId(userId);
  const res = uid
    ? await ctx.pool.query(
        `SELECT ${GRAPH_LINK_COLS_PG} FROM graph_links WHERE id = $1 AND (user_id = $2 OR user_id = '' OR user_id IS NULL)`,
        [id, uid],
      )
    : await ctx.pool.query(`SELECT ${GRAPH_LINK_COLS_PG} FROM graph_links WHERE id = $1`, [id]);
  return res.rows[0] ? graphLinkFromPg(res.rows[0] as unknown as GraphLinkPgRaw) : null;
}

export async function findGraphLinkByTriplePg(
  ctx: PostgresDbContext, q: { kind: string; srcKey: string; dstKey: string }, userId?: string,
): Promise<GraphLinkRow | null> {
  const uid = effectiveUserId(userId);
  const res = uid
    ? await ctx.pool.query(
        `SELECT ${GRAPH_LINK_COLS_PG} FROM graph_links WHERE kind = $1 AND src_key = $2 AND dst_key = $3 AND (user_id = $4 OR user_id = '' OR user_id IS NULL)`,
        [q.kind, q.srcKey, q.dstKey, uid],
      )
    : await ctx.pool.query(
        `SELECT ${GRAPH_LINK_COLS_PG} FROM graph_links WHERE kind = $1 AND src_key = $2 AND dst_key = $3`,
        [q.kind, q.srcKey, q.dstKey],
      );
  return res.rows[0] ? graphLinkFromPg(res.rows[0] as unknown as GraphLinkPgRaw) : null;
}

export async function listGraphLinkProposalsPg(ctx: PostgresDbContext, userId?: string): Promise<GraphLinkRow[]> {
  const uid = effectiveUserId(userId);
  const res = uid
    ? await ctx.pool.query(
        `SELECT ${GRAPH_LINK_COLS_PG} FROM graph_links WHERE status = 'proposed' AND (user_id = $1 OR user_id = '' OR user_id IS NULL) ORDER BY created_at DESC`,
        [uid],
      )
    : await ctx.pool.query(
        `SELECT ${GRAPH_LINK_COLS_PG} FROM graph_links WHERE status = 'proposed' ORDER BY created_at DESC`,
      );
  return res.rows.map((r) => graphLinkFromPg(r as unknown as GraphLinkPgRaw));
}

export async function listGraphLinksPg(ctx: PostgresDbContext, userId?: string): Promise<GraphLinkRow[]> {
  const uid = effectiveUserId(userId);
  const res = uid
    ? await ctx.pool.query(
        `SELECT ${GRAPH_LINK_COLS_PG} FROM graph_links WHERE (user_id = $1 OR user_id = '' OR user_id IS NULL) ORDER BY created_at DESC`,
        [uid],
      )
    : await ctx.pool.query(`SELECT ${GRAPH_LINK_COLS_PG} FROM graph_links ORDER BY created_at DESC`);
  return res.rows.map((r) => graphLinkFromPg(r as unknown as GraphLinkPgRaw));
}

export async function updateGraphLinkStatusPg(
  ctx: PostgresDbContext, id: string, status: Exclude<GraphLinkStatus, 'proposed'>,
  confirmationSource: 'human' | 'agent', userId?: string,
): Promise<boolean> {
  const uid = effectiveUserId(userId);
  const res = uid
    ? await ctx.pool.query(
        "UPDATE graph_links SET status = $1, confirmation_source = $2 WHERE id = $3 AND (user_id = $4 OR user_id = '' OR user_id IS NULL)",
        [status, confirmationSource, id, uid],
      )
    : await ctx.pool.query('UPDATE graph_links SET status = $1, confirmation_source = $2 WHERE id = $3', [status, confirmationSource, id]);
  return (res.rowCount ?? 0) > 0;
}

export async function updateGraphLinkPropsPg(
  ctx: PostgresDbContext, id: string, patch: Record<string, unknown>, userId?: string,
): Promise<boolean> {
  const current = await findGraphLinkByIdPg(ctx, id, userId);
  if (!current) return false;
  const merged = { ...current.props, ...patch };
  const uid = effectiveUserId(userId);
  const res = uid
    ? await ctx.pool.query(
        "UPDATE graph_links SET props = $1 WHERE id = $2 AND (user_id = $3 OR user_id = '' OR user_id IS NULL)",
        [JSON.stringify(merged), id, uid],
      )
    : await ctx.pool.query('UPDATE graph_links SET props = $1 WHERE id = $2', [JSON.stringify(merged), id]);
  return (res.rowCount ?? 0) > 0;
}

export async function setGraphLinkGraphStatusPg(
  ctx: PostgresDbContext, id: string, gs: BindingGraphStatus | null, userId?: string,
): Promise<void> {
  const raw = gs ? JSON.stringify(gs) : null;
  const uid = effectiveUserId(userId);
  if (uid) {
    await ctx.pool.query(
      "UPDATE graph_links SET graph_status = $1 WHERE id = $2 AND (user_id = $3 OR user_id = '' OR user_id IS NULL)",
      [raw, id, uid],
    );
  } else {
    await ctx.pool.query('UPDATE graph_links SET graph_status = $1 WHERE id = $2', [raw, id]);
  }
}

// ---- Quotas(spec 2026-08-25 方案A §3.1): pg twins ----------------------------
// limit/used 为 double precision(读回即 number), 其余同 SQLite 列对列。

interface QuotaPgRaw {
  id: string; scope: string; owner_key: string; owner_label: string;
  limit_amount: number | string; currency: string | null; period: string | null;
  used_amount: number | string; computed_at: string | null; status: string;
  created_by: string; user_id: string | null; created_at: string | Date;
}

const QUOTA_COLS_PG = `id, scope, owner_key, owner_label, limit_amount, currency, period,
  used_amount, computed_at, status, created_by, user_id, created_at`;

function quotaFromPg(r: QuotaPgRaw): QuotaRow {
  const num = (v: number | string) => (typeof v === 'number' ? v : parseFloat(v ?? '0'));
  return {
    id: r.id,
    scope: r.scope === 'project' ? 'project' : 'counterparty',
    ownerKey: r.owner_key,
    ownerLabel: r.owner_label ?? '',
    limitAmount: num(r.limit_amount),
    currency: r.currency ?? null,
    period: r.period ?? null,
    usedAmount: num(r.used_amount ?? 0),
    computedAt: r.computed_at ?? null,
    status: (r.status ?? 'active') as QuotaStatus,
    createdBy: r.created_by,
    userId: r.user_id ?? '',
    createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
  };
}

export async function saveQuotaPg(
  ctx: PostgresDbContext, input: QuotaInput, userId?: string,
): Promise<string> {
  const uid = effectiveUserId(userId);
  const id = rid('Q');
  await ctx.pool.query(
    `INSERT INTO quotas
       (id, scope, owner_key, owner_label, limit_amount, currency, period, status, created_by, user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'active', $8, $9)`,
    [
      id, input.scope, input.ownerKey, input.ownerLabel ?? '',
      input.limitAmount, input.currency ?? null, input.period ?? null,
      input.createdBy, uid,
    ],
  );
  return id;
}

export async function findQuotaByIdPg(
  ctx: PostgresDbContext, id: string, userId?: string,
): Promise<QuotaRow | null> {
  const uid = effectiveUserId(userId);
  const res = uid
    ? await ctx.pool.query(
        `SELECT ${QUOTA_COLS_PG} FROM quotas WHERE id = $1 AND (user_id = $2 OR user_id = '' OR user_id IS NULL)`,
        [id, uid],
      )
    : await ctx.pool.query(`SELECT ${QUOTA_COLS_PG} FROM quotas WHERE id = $1`, [id]);
  return res.rows[0] ? quotaFromPg(res.rows[0] as unknown as QuotaPgRaw) : null;
}

export async function listQuotasPg(
  ctx: PostgresDbContext, opts?: { scope?: 'counterparty' | 'project'; userId?: string; includeInactive?: boolean },
): Promise<QuotaRow[]> {
  const uid = effectiveUserId(opts?.userId);
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (uid) {
    params.push(uid);
    clauses.push(`(user_id = $${params.length} OR user_id = '' OR user_id IS NULL)`);
  }
  if (opts?.scope) {
    params.push(opts.scope);
    clauses.push(`scope = $${params.length}`);
  }
  if (!opts?.includeInactive) clauses.push(`status = 'active'`);
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const res = await ctx.pool.query(
    `SELECT ${QUOTA_COLS_PG} FROM quotas ${where} ORDER BY created_at DESC`,
    params,
  );
  return res.rows.map((r) => quotaFromPg(r as unknown as QuotaPgRaw));
}

export async function updateQuotaPg(
  ctx: PostgresDbContext, id: string,
  patch: { limitAmount?: number; currency?: string | null; period?: string | null; status?: QuotaStatus },
  userId?: string,
): Promise<boolean> {
  const current = await findQuotaByIdPg(ctx, id, userId);
  if (!current) return false;
  const limitAmount = patch.limitAmount ?? current.limitAmount;
  const currency = patch.currency !== undefined ? patch.currency : current.currency;
  const period = patch.period !== undefined ? patch.period : current.period;
  const status = patch.status ?? current.status;
  const uid = effectiveUserId(userId);
  const res = uid
    ? await ctx.pool.query(
        "UPDATE quotas SET limit_amount = $1, currency = $2, period = $3, status = $4 WHERE id = $5 AND (user_id = $6 OR user_id = '' OR user_id IS NULL)",
        [limitAmount, currency, period, status, id, uid],
      )
    : await ctx.pool.query(
        'UPDATE quotas SET limit_amount = $1, currency = $2, period = $3, status = $4 WHERE id = $5',
        [limitAmount, currency, period, status, id],
      );
  return (res.rowCount ?? 0) > 0;
}

export async function updateQuotaUsedPg(
  ctx: PostgresDbContext, id: string, used: number, computedAt: string, userId?: string,
): Promise<boolean> {
  const uid = effectiveUserId(userId);
  const res = uid
    ? await ctx.pool.query(
        "UPDATE quotas SET used_amount = $1, computed_at = $2 WHERE id = $3 AND (user_id = $4 OR user_id = '' OR user_id IS NULL)",
        [used, computedAt, id, uid],
      )
    : await ctx.pool.query(
        'UPDATE quotas SET used_amount = $1, computed_at = $2 WHERE id = $3',
        [used, computedAt, id],
      );
  return (res.rowCount ?? 0) > 0;
}

// ---- 模板层仓储 Pg 版(列名与 SQLite 对齐) -----------------------------------
export async function listTemplateTypesPg(ctx: PostgresDbContext): Promise<TemplateTypeRow[]> {
  const { rows } = await ctx.pool.query(`SELECT id, kind, name, parent_id, props, is_active FROM template_types ORDER BY kind, name`);
  return rows.map((r: Record<string, unknown>) => {
    let props: Record<string, unknown> = {};
    try { props = typeof r.props === 'string' ? JSON.parse(r.props) as Record<string, unknown> : (r.props ?? {}) as Record<string, unknown>; } catch { /* 损坏按空 */ }
    return {
      id: String(r.id), kind: (r.kind === 'contract_type' ? 'contract_type' : 'doc_type'),
      name: String(r.name), parentId: r.parent_id ? String(r.parent_id) : null,
      props, isActive: Number(r.is_active) === 1,
    };
  });
}

export async function findTemplateTypeByNamePg(ctx: PostgresDbContext, kind: string, name: string): Promise<TemplateTypeRow | null> {
  const { rows } = await ctx.pool.query(
    'SELECT id, kind, name, parent_id, props, is_active FROM template_types WHERE kind = $1 AND name = $2', [kind, name]);
  if (rows.length === 0) return null;
  const r = rows[0] as Record<string, unknown>;
  let props: Record<string, unknown> = {};
  try { props = typeof r.props === 'string' ? JSON.parse(r.props) as Record<string, unknown> : (r.props ?? {}) as Record<string, unknown>; } catch { /* 损坏按空 */ }
  return {
    id: String(r.id), kind: (r.kind === 'contract_type' ? 'contract_type' : 'doc_type'),
    name: String(r.name), parentId: r.parent_id ? String(r.parent_id) : null,
    props, isActive: Number(r.is_active) === 1,
  };
}

export async function listActiveEdgeRulesPg(ctx: PostgresDbContext): Promise<TemplateEdgeRuleRow[]> {
  const { rows } = await ctx.pool.query(
    'SELECT id, source_type_id, target_type_id, edge_type, allowed_vocab, anchor_weights, is_active, template_version FROM template_edge_rules WHERE is_active = 1');
  return rows.map((r: Record<string, unknown>) => {
    let allowedVocab: string[] = [];
    try { allowedVocab = typeof r.allowed_vocab === 'string' ? JSON.parse(r.allowed_vocab) as string[] : (r.allowed_vocab ?? []) as string[]; } catch { /* 损坏按空 */ }
    let anchorWeights: TemplateAnchorWeights | null = null;
    if (r.anchor_weights) {
      try { anchorWeights = typeof r.anchor_weights === 'string' ? JSON.parse(r.anchor_weights) as TemplateAnchorWeights : r.anchor_weights as TemplateAnchorWeights; } catch { /* 忽略 */ }
    }
    return {
      id: String(r.id), sourceTypeId: String(r.source_type_id),
      targetTypeId: String(r.target_type_id ?? ''), edgeType: String(r.edge_type),
      allowedVocab, anchorWeights, isActive: Number(r.is_active) === 1, templateVersion: Number(r.template_version ?? 1),
    };
  });
}

export async function ensureTemplateTypePg(
  ctx: PostgresDbContext, input: { id: string; kind: string; name: string; parentId?: string | null; props?: Record<string, unknown> },
): Promise<void> {
  await ctx.pool.query(
    `INSERT INTO template_types (id, kind, name, parent_id, props) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (id) DO UPDATE SET parent_id = excluded.parent_id, props = excluded.props
     -- P4 managed-wins(种子冲突策略): managed_at 非空=已管理行, boot seed 跳过覆写。
     WHERE template_types.managed_at IS NULL`,
    [input.id, input.kind, input.name, input.parentId ?? null, JSON.stringify(input.props ?? {})]);
}

export async function ensureEdgeRulePg(
  ctx: PostgresDbContext, input: { id: string; sourceTypeId: string; targetTypeId?: string; edgeType: string; allowedVocab: string[]; isActive?: boolean; anchorWeights?: TemplateAnchorWeights | null },
): Promise<void> {
  await ctx.pool.query(
    `INSERT INTO template_edge_rules (id, source_type_id, target_type_id, edge_type, allowed_vocab, is_active, anchor_weights)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (id) DO UPDATE SET
       target_type_id = excluded.target_type_id,
       allowed_vocab = excluded.allowed_vocab,
       is_active = excluded.is_active,
       -- anchor_weights 覆写防护(小修 3): 与 SQLite 分支同规则, 传入 NULL 保留既有值。
       anchor_weights = COALESCE(excluded.anchor_weights, template_edge_rules.anchor_weights)
     -- P4 managed-wins(种子冲突策略): 已管理行整行冻结(anchor_weights 一并不触碰)。
     WHERE template_edge_rules.managed_at IS NULL`,
    [input.id, input.sourceTypeId, input.targetTypeId ?? '', input.edgeType,
     JSON.stringify(input.allowedVocab), input.isActive === false ? 0 : 1,
     input.anchorWeights ? JSON.stringify(input.anchorWeights) : null]);
}

/**
 * 模板版本审计 Pg twin(SQLite 版见 repositories.ts bumpTemplateVersion)。
 * INSERT..SELECT..RETURNING 单语句取 MAX+1 并落审计行, 天然规避读写窗口竞态。
 */
export async function bumpTemplateVersionPg(
  ctx: PostgresDbContext, input: { changedBy: string; changeSummary: string },
): Promise<number> {
  const { rows } = await ctx.pool.query(
    `INSERT INTO template_versions (version, changed_by, change_summary)
     SELECT COALESCE(MAX(version), 0) + 1, $1, $2 FROM template_versions
     RETURNING version`,
    [input.changedBy, input.changeSummary]);
  return Number((rows[0] as Record<string, unknown>).version);
}

/** 存量数据幂等迁移 Pg 版: 提单/装箱单 -> 货转单(参数化 UPDATE, 重复执行无副作用)。 */
export async function migrateDocTypeAliasesPg(ctx: PostgresDbContext): Promise<number> {
  const aliasMap: Array<[string, string]> = [['提单', '货转单'], ['装箱单', '货转单']];
  let total = 0;
  for (const [from, to] of aliasMap) {
    for (const tbl of ['documents', 'extractions', 'classifications']) {
      const res = await ctx.pool.query(`UPDATE ${tbl} SET doc_type = $1 WHERE doc_type = $2`, [to, from]);
      total += res.rowCount ?? 0;
    }
  }
  return total;
}
