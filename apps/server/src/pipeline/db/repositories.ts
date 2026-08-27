import { eq, and, or, isNull, desc } from 'drizzle-orm';
import { documents, extractions, bindings, classifications } from './schema.js';
import type { DbContext } from './client.js';
import type { BlockModel, DocType, Modality, SourceSpan } from '../types.js';
import type { SpanMatchStrength } from '../spanValidator.js';
import { normalizeContractNo } from '../contractLedger.js';
import type { ContractLedgerEntry } from '../contractLedger.js';
import { rankContractSearch, type ContractSearchItem } from '../contractSearch.js';
import { deriveProposedEdges, deriveProposedRelationships } from '../extraction.js';
import { normalizeCompanyName, parseSelfPartyNames } from '../../domain/flowDirection.js';
import { deriveContractType, type ContractTypeDerivation } from '../../domain/contractType.js';
import type { ContractType } from '../../domain/tradeSemantics.js';
import { env } from '../../env.js';
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
  listChunksByDocumentPg,
  searchChunksPg,
  getChunkMetaByRowidsPg,
  setDocumentMinioKeyPg,
  findDocIdsByMinioKeysPg,
  listFileFoldersPg,
  createFileFolderPg,
  deleteFileFolderPg,
  listFileFoldersUnderPg,
  renameFileFoldersPrefixPg,
  setFolderSortOrdersPg,
  listFileRanksPg,
  upsertFileRanksPg,
  deleteFileRankPg,
  // pg parity for the previously-stubbed fns.
  countDocumentsPg,
  countExtractionsNeedingReviewPg,
  listUserDocumentsPg,
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
  // Graph-relations design (2026-08-17 §4): pg twin for setDocumentGraphStatus.
  setDocumentGraphStatusPg,
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
  getDocumentMetaPg,
  // docType 修正端点: pg twin for updateDocumentType.
  updateDocumentTypePg,
  // contract ledger (ingest extraction write-back): pg twins.
  upsertContractLedgerEntryPg,
  findContractLedgerByNoPg,
  listContractLedgerEntriesPg,
  searchContractLedgerPg,
  // Phase B bindings state machine: pg twins.
  findBindingByDocAndContractPg,
  listBindingProposalsPg,
  updateBindingStatusPg,
  // 绑定工作台: pg twins for graph_status + 工作台查询。
  findBindingByIdPg,
  listBindingsForUserPg,
  setBindingGraphStatusPg,
  // 执行流水(六向): pg twins for upsert/retract/list/summarize。
  upsertExecutionFlowPg,
  retractExecutionFlowForBindingPg,
  retractExecutionFlowsForDocumentPg,
  listConfirmedBindingsForDocumentPg,
  listExecutionFlowsPg,
  summarizeExecutionFlowsPg,
  // 自主体名单(Task A): pg twins for self_parties CRUD + backfill helpers.
  listSelfPartiesPg,
  addSelfPartyPg,
  removeSelfPartyPg,
  listDocumentIdsWithConfirmedBindingsPg,
  hasExecutionFlowsForDocumentPg,
  getDocumentSourcesByIdsPg,
  // 项目维度(spec 2026-08-20): pg twins for projects / project_memberships.
  createProjectPg,
  findProjectByCodePg,
  listProjectsPg,
  upsertProjectMembershipPg,
  findMembershipByIdPg,
  listMembershipsByProjectPg,
  listMembershipsByContractPg,
  updateMembershipStatusPg,
  setMembershipGraphStatusPg,
  // Graph links(spec 2026-08-25 方案A): pg twins for correlates/relates 提案-确认。
  saveGraphLinkPg,
  findGraphLinkByIdPg,
  findGraphLinkByTriplePg,
  listGraphLinkProposalsPg,
  listGraphLinksPg,
  updateGraphLinkStatusPg,
  updateGraphLinkPropsPg,
  setGraphLinkGraphStatusPg,
  // Quotas(spec 2026-08-25 方案A §3.1): pg twins for 两层额度。
  saveQuotaPg,
  findQuotaByIdPg,
  listQuotasPg,
  updateQuotaPg,
  updateQuotaUsedPg,
  // 模板层(spec 2026-08-26 §3): pg twins for 模板三表。
  listTemplateTypesPg,
  listActiveEdgeRulesPg,
  deleteChunksForDocumentPg,
  ensureTemplateTypePg,
  ensureEdgeRulePg,
  bumpTemplateVersionPg,
  listAllEdgeRulesPg,
  listTemplateTypesManagedPg,
  insertTemplateEdgeRulePg,
  migrateDocTypeAliasesPg,
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

/** Doc row shape for doc list surfaces: id + created_at (graph route) + docType/sourceUri/minioKey (bindings workbench overview). */
export interface UserDocumentRow {
  id: string;
  docType: string;
  sourceUri: string | null;
  minioKey: string | null;
  createdAt: string;
}

/**
 * List the caller's document rows (own rows + legacy user_id='' / NULL, same
 * visibility convention as countDocuments). Returns id + created_at + doc_type +
 * source_uri — the graph route uses id/createdAt only; the bindings workbench
 * overview uses docType/sourceUri too.
 */
export async function listUserDocuments(
  ctx: DbContext,
  userId: string,
): Promise<UserDocumentRow[]> {
  if (ctx.backend === 'postgres') return listUserDocumentsPg(ctx, userId);
  const uid = effectiveUserId(userId);
  const rows = ctx.sqlite
    .prepare(
      "SELECT id, doc_type, source_uri, minio_key, created_at FROM documents WHERE (user_id = ? OR user_id = '' OR user_id IS NULL) ORDER BY created_at DESC",
    )
    .all(uid) as Array<{ id: string; doc_type: string; source_uri: string | null; minio_key: string | null; created_at: string }>;
  return rows.map((r) => ({
    id: r.id,
    docType: r.doc_type,
    sourceUri: r.source_uri,
    minioKey: r.minio_key ?? null,
    createdAt: r.created_at,
  }));
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

/** Phase B binding state machine. 存量行默认 'confirmed'(走过 L2 审批)。 */
export type BindingStatus = 'confirmed' | 'proposed' | 'rejected';
/** 确认来源: 'auto_rule' = 合同号精确命中自动确认; 'human' = 人工确认。 */
export type ConfirmationSource = 'auto_rule' | 'human';
/** 提议来源: 'system' = 凭证入库自动生成; 'agent' = 工具显式调用。 */
export type BindingProposedBy = 'system' | 'agent';

/** 评分证据(JSON 落库, 供评审卡展示)。 */
export interface BindingEvidence {
  partyScore: number;
  timeScore: number;
  amountScore: number;
  qtyScore: number;
  details: string[];
}

/** 工作台图同步结果(落 bindings.graph_status, JSON)。 */
export interface BindingGraphStatus {
  status: 'ok' | 'skipped' | 'failed';
  reason?: string;
  syncedAt?: string;
}

export interface BindingInput {
  documentId: string;
  contractNo: string;
  relation: string;
  sourceRefs: SourceSpan[];
  confidence: number;
  createdBy: string;
  /** Phase B: 默认 'confirmed'(旧调用方不变)。 */
  status?: BindingStatus;
  confirmationSource?: ConfirmationSource | null;
  proposedBy?: BindingProposedBy;
  evidence?: BindingEvidence | null;
  /** 绑定目标类型标记('Contract' | 'Project'), 缺省 'Contract'。 */
  targetKind?: 'Contract' | 'Project';
}

export interface BindingRow {
  id: string;
  documentId: string;
  contractNo: string;
  relation: string;
  sourceRefs: SourceSpan[];
  confidence: number;
  createdBy: string;
  /** Phase B columns (旧行为兼容: 未落新列时为默认值)。 */
  status: BindingStatus;
  confirmationSource: ConfirmationSource | null;
  proposedBy: BindingProposedBy | null;
  evidence: BindingEvidence | null;
  /** 工作台确认后图谱同步结果(JSON 落 bindings.graph_status)。 */
  graphStatus: BindingGraphStatus | null;
  /** 绑定目标类型标记('Contract' | 'Project')。 */
  targetKind: 'Contract' | 'Project';
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
  kind: 'Party' | 'Commodity' | 'Contract' | 'Project';
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
  dstKind: 'Party' | 'Commodity' | 'Contract' | 'Project';
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

/**
 * 确认时 Neo4j 写入结果（design 2026-08-17 §4）。'skipped' = 图未配置
 * （NEO4J_PASSWORD 未设）；'partial' = 部分实体/边失败（见 failures[]）；
 * 'failed' = 写入整体失败（图不可达等）。
 */
export type DocumentGraphStatus = {
  status: 'ok' | 'partial' | 'failed' | 'skipped';
  nodeCount: number;
  edgeCount: number;
  /** 确认时实际写入 Neo4j 的实体清单（归一化名）；skipped/failed 或旧数据无此字段。 */
  entities?: Array<{ kind: string; name: string; role?: string }>;
  reason?: string;
  failures?: string[];
  writtenAt: string;
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
  /** 确定性 Document->实体边提议（design 2026-08-17 §3.2），快照读取时同规则派生。 */
  proposedEdges: ProposedEdge[];
  /** 合同类型派生结果（spec 2026-08-20 §3.2），与台账/图提交同规则；非合同为 null。 */
  contractType: ContractTypeDerivation | null;
  /** 确认时 Neo4j 写入结果；未确认或从未写入时为 null。 */
  graphStatus: DocumentGraphStatus | null;
}

const rid = (p: string) => `${p}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

/** 快照侧派生用有效主体名单: env ∪ self_parties。与 executionFlow
 * 的 getEffectiveSelfPartyNames 同语义, 本地实现以免环(executionFlow 依赖本文件)。
 * 导出供 postgres-repositories 的 pg 快照分支复用。 */
export async function effectiveSelfPartyNamesForDerivation(ctx: DbContext): Promise<string[]> {
  const rows = await listSelfParties(ctx);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const n of [...parseSelfPartyNames(env.SELF_PARTY_NAMES), ...rows.map((r) => r.name)]) {
    const key = normalizeCompanyName(n);
    if (key && !seen.has(key)) { seen.add(key); out.push(n); }
  }
  return out;
}

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
    // Phase B columns: 默认值保持旧调用兼容(status 缺省 'confirmed')。
    status: input.status ?? 'confirmed',
    confirmationSource: input.confirmationSource ?? null,
    proposedBy: input.proposedBy ?? null,
    evidence: input.evidence ? JSON.stringify(input.evidence) : null,
    targetKind: input.targetKind ?? 'Contract',
  }).run();
  return id;
}

export async function listBindingsForContract(
  ctx: DbContext,
  contractNo: string,
): Promise<BindingRow[]> {
  if (ctx.backend === 'postgres') return listBindingsForContractPg(ctx, contractNo);
  return ctx.db.select().from(bindings).where(eq(bindings.contractNo, contractNo)).all().map(rowToBinding);
}

// ---- Phase B: bindings 状态机 -------------------------------------------------

/**
 * 按 (document_id, contract_no, user_id) 查单条 binding(proposal 确认/upsert 用)。
 * 返回最近一条(created_at DESC); 无则 null。
 */
export async function findBindingByDocAndContract(
  ctx: DbContext,
  documentId: string,
  contractNo: string,
  userId?: string,
): Promise<BindingRow | null> {
  if (ctx.backend === 'postgres') return findBindingByDocAndContractPg(ctx, documentId, contractNo, userId);
  const uid = effectiveUserId(userId);
  const filter = uid
    ? and(
        eq(bindings.documentId, documentId),
        eq(bindings.contractNo, contractNo),
        or(eq(bindings.userId, uid), eq(bindings.userId, ''), isNull(bindings.userId)),
      )
    : and(eq(bindings.documentId, documentId), eq(bindings.contractNo, contractNo));
  const row = ctx.db
    .select()
    .from(bindings)
    .where(filter)
    .orderBy(desc(bindings.createdAt))
    .all()[0];
  if (!row) return null;
  return rowToBinding(row);
}

/**
 * 列出绑定建议(join documents 取 doc_type/source_uri)。status 缺省 'proposed'。
 * 按 user 过滤(legacy 行 3-way OR), 按 created_at DESC。
 */
export async function listBindingProposals(
  ctx: DbContext,
  userId?: string,
  status: BindingStatus = 'proposed',
): Promise<
  Array<BindingRow & { docType: string; fileName: string }>
> {
  if (ctx.backend === 'postgres') return listBindingProposalsPg(ctx, userId, status);
  const uid = effectiveUserId(userId);
  const rows = uid
    ? (ctx.db
        .select({
          b: bindings,
          docType: documents.docType,
          sourceUri: documents.sourceUri,
        })
        .from(bindings)
        .innerJoin(documents, eq(bindings.documentId, documents.id))
        .where(
          and(
            eq(bindings.status, status),
            or(eq(bindings.userId, uid), eq(bindings.userId, ''), isNull(bindings.userId)),
          ),
        )
        .orderBy(desc(bindings.createdAt))
        .all() as unknown as Array<{ b: (typeof bindings)['$inferSelect']; docType: string; sourceUri: string }>)
    : (ctx.db
        .select({
          b: bindings,
          docType: documents.docType,
          sourceUri: documents.sourceUri,
        })
        .from(bindings)
        .innerJoin(documents, eq(bindings.documentId, documents.id))
        .where(eq(bindings.status, status))
        .orderBy(desc(bindings.createdAt))
        .all() as unknown as Array<{ b: (typeof bindings)['$inferSelect']; docType: string; sourceUri: string }>);
  return rows.map((r) => ({
    ...rowToBinding(r.b),
    docType: r.docType,
    fileName: r.sourceUri.split('/').pop() ?? r.sourceUri,
  }));
}

/** 确认/拒绝一条 binding(状态机流转)。 */
export async function updateBindingStatus(
  ctx: DbContext,
  bindingId: string,
  status: BindingStatus,
  confirmationSource: ConfirmationSource,
  userId?: string,
): Promise<boolean> {
  if (ctx.backend === 'postgres') return updateBindingStatusPg(ctx, bindingId, status, confirmationSource, userId);
  const uid = effectiveUserId(userId);
  const filter = uid
    ? and(eq(bindings.id, bindingId), or(eq(bindings.userId, uid), eq(bindings.userId, ''), isNull(bindings.userId)))
    : eq(bindings.id, bindingId);
  const res = ctx.db
    .update(bindings)
    .set({ status, confirmationSource })
    .where(filter)
    .run();
  return res.changes > 0;
}

// ---- 绑定工作台: graph_status + 工作台查询 ---------------------------------

export function parseGraphStatus(raw: string | null): BindingGraphStatus | null {
  if (!raw) return null;
  try { return JSON.parse(raw) as BindingGraphStatus; } catch { return null; }
}

export async function findBindingById(
  ctx: DbContext, bindingId: string, userId?: string,
): Promise<BindingRow | null> {
  if (ctx.backend === 'postgres') return findBindingByIdPg(ctx, bindingId, userId);
  const uid = effectiveUserId(userId);
  const filter = uid
    ? and(eq(bindings.id, bindingId), or(eq(bindings.userId, uid), eq(bindings.userId, ''), isNull(bindings.userId)))
    : eq(bindings.id, bindingId);
  const row = ctx.db.select().from(bindings).where(filter).all()[0];
  return row ? rowToBinding(row) : null;
}

/** 全状态绑定列表(工作台 overview 用), created_at DESC。 */
export async function listBindingsForUser(ctx: DbContext, userId?: string): Promise<BindingRow[]> {
  if (ctx.backend === 'postgres') return listBindingsForUserPg(ctx, userId);
  const uid = effectiveUserId(userId);
  const filter = uid ? or(eq(bindings.userId, uid), eq(bindings.userId, ''), isNull(bindings.userId)) : undefined;
  const rows = ctx.db.select().from(bindings).where(filter).orderBy(desc(bindings.createdAt)).all();
  return rows.map(rowToBinding);
}

export async function setBindingGraphStatus(
  ctx: DbContext, bindingId: string, graphStatus: BindingGraphStatus, userId?: string,
): Promise<boolean> {
  if (ctx.backend === 'postgres') return setBindingGraphStatusPg(ctx, bindingId, graphStatus, userId);
  const uid = effectiveUserId(userId);
  const filter = uid
    ? and(eq(bindings.id, bindingId), or(eq(bindings.userId, uid), eq(bindings.userId, ''), isNull(bindings.userId)))
    : eq(bindings.id, bindingId);
  const res = ctx.db.update(bindings)
    .set({ graphStatus: JSON.stringify(graphStatus) })
    .where(filter).run();
  return res.changes > 0;
}

/** bindings drizzle 行 -> BindingRow(所有读取函数共用, 含 graphStatus)。 */
function rowToBinding(r: (typeof bindings)['$inferSelect']): BindingRow {
  return {
    id: r.id, documentId: r.documentId, contractNo: r.contractNo, relation: r.relation,
    sourceRefs: JSON.parse(r.sourceRefs) as SourceSpan[],
    confidence: r.confidence, createdBy: r.createdBy,
    status: (r.status ?? 'confirmed') as BindingStatus,
    confirmationSource: (r.confirmationSource ?? null) as ConfirmationSource | null,
    proposedBy: (r.proposedBy ?? null) as BindingProposedBy | null,
    evidence: r.evidence ? (JSON.parse(r.evidence) as BindingEvidence) : null,
    graphStatus: parseGraphStatus(r.graphStatus ?? null),
    targetKind: (r.targetKind ?? 'Contract') as 'Contract' | 'Project',
  };
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

/** Read (id, chunk_text) rows for one document in chunk order — 纠错回溯
 *  reconcileVectorizationAfterDocTypeChange 的补嵌入输入。 */
export async function listChunksByDocument(
  ctx: DbContext,
  documentId: string,
): Promise<Array<{ id: number; text: string }>> {
  if (ctx.backend === 'postgres') return listChunksByDocumentPg(ctx, documentId);
  const rows = ctx.sqlite.prepare(
    'SELECT id, chunk_text FROM doc_chunk WHERE document_id = ? ORDER BY chunk_index, id',
  ).all(documentId) as Array<Record<string, unknown>>;
  return rows.map((r) => ({ id: Number(r.id), text: String(r.chunk_text ?? '') }));
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
    // 执行流水随绑定与抽取一起清理(无 FK, 显式删; 防孤儿行)。
    sqlite.prepare('DELETE FROM execution_flows WHERE document_id = ?').run(docId);
    sqlite.prepare('DELETE FROM document_tags WHERE document_id = ?').run(docId);
    // 8. parent last (after all referencers gone).
    sqlite.prepare('DELETE FROM documents WHERE id = ?').run(docId);
  });
  tx();
  return { deleted: true };
}

/**
 * 6b(重新处理=覆盖重算): 清空一个文档的 chunk 行 + 外部内容 FTS5 索引
 * (+ sqlite-vec 表存在时连带 vec 行), 不动 documents 行本身。processDocument
 * 重跑解析路径在 saveChunks 前调用, 使旧解析的块不残留(首次解析时为无害 no-op);
 * append 语义的散点调用方(:366 单块补写)不受影响 —— 清理只在重跑站点显式发生。
 */
export async function deleteChunksForDocument(ctx: DbContext, docId: string): Promise<void> {
  if (ctx.backend === 'postgres') return deleteChunksForDocumentPg(ctx, docId);
  const sqlite = ctx.sqlite;
  const chunkIds = sqlite
    .prepare('SELECT id FROM doc_chunk WHERE document_id = ?')
    .all(docId) as { id: number }[];
  const hasVecTable = !!sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='doc_chunk_vec'")
    .get();
  const tx = sqlite.transaction(() => {
    if (chunkIds.length) {
      // chunk ids are our own integers — safe to interpolate (同 deleteDocument)。
      const idList = chunkIds.map((c) => c.id).join(',');
      sqlite.exec(`DELETE FROM doc_chunk_fts WHERE rowid IN (${idList})`);
      if (hasVecTable) {
        sqlite.exec(`DELETE FROM doc_chunk_vec WHERE id IN (${idList})`);
      }
    }
    sqlite.prepare('DELETE FROM doc_chunk WHERE document_id = ?').run(docId);
  });
  tx();
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
    .prepare(
      'SELECT id, path FROM file_folders WHERE user_id = ? ' +
        "ORDER BY (sort_order IS NULL) ASC, sort_order ASC, path ASC",
    )
    .all(userId) as Array<{ id: string; path: string }>;
  return rows.map((r) => ({ id: r.id, path: r.path }));
}

/**
 * Persist drag-to-sort ranks. `paths` is the FULL ordered list of sibling
 * folder paths (parent-scoped); index becomes the sort_order. Folders not in
 * the list keep their existing rank (0 = default bucket).
 */
export async function setFolderSortOrders(
  ctx: DbContext,
  userId: string,
  paths: string[],
): Promise<number> {
  if (ctx.backend === 'postgres') return setFolderSortOrdersPg(ctx, userId, paths);
  const stmt = ctx.sqlite.prepare(
    'UPDATE file_folders SET sort_order = ? WHERE user_id = ? AND path = ?',
  );
  let changed = 0;
  for (let i = 0; i < paths.length; i += 1) {
    const res = stmt.run(i, userId, paths[i]!);
    changed += res.changes;
  }
  return changed;
}

/** Manual display rank per MinIO object key (drag-to-sort). Missing keys = no
 *  custom order. Small per-user table -- load all and filter in memory. */
export async function listFileRanks(ctx: DbContext, userId: string): Promise<Map<string, number>> {
  if (ctx.backend === 'postgres') return listFileRanksPg(ctx, userId);
  const rows = ctx.sqlite
    .prepare('SELECT obj_key, sort_order FROM file_sort_orders WHERE user_id = ?')
    .all(userId) as Array<{ obj_key: string; sort_order: number }>;
  return new Map(rows.map((r) => [r.obj_key, r.sort_order]));
}

/** Upsert drag-order ranks (order = array index from the client). */
export async function upsertFileRanks(
  ctx: DbContext,
  userId: string,
  ranks: Array<{ key: string; order: number }>,
): Promise<void> {
  if (ctx.backend === 'postgres') return upsertFileRanksPg(ctx, userId, ranks);
  const stmt = ctx.sqlite.prepare(
    `INSERT INTO file_sort_orders (user_id, obj_key, sort_order) VALUES (?, ?, ?)
     ON CONFLICT(user_id, obj_key) DO UPDATE SET sort_order = excluded.sort_order`,
  );
  for (const r of ranks) stmt.run(userId, r.key, r.order);
}

/** Remove a stale rank row (file deleted or moved to a new key). Best-effort. */
export async function deleteFileRank(ctx: DbContext, userId: string, key: string): Promise<void> {
  if (ctx.backend === 'postgres') return deleteFileRankPg(ctx, userId, key);
  ctx.sqlite
    .prepare('DELETE FROM file_sort_orders WHERE user_id = ? AND obj_key = ?')
    .run(userId, key);
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

/**
 * Virtual-folder subtree reads/writes backing PATCH /api/files/folder-path.
 * The prefix math lives in SQL (`substr(path, LENGTH(from)+1)`) so one UPDATE
 * rewrites the folder and every descendant in a single statement -- no LIKE,
 * which would need %/_ escaping. substr() is 1-indexed in both SQLite and PG.
 */

/** List folder rows equal to or under `from` (inclusive) for this user. */
export async function listFileFoldersUnder(
  ctx: DbContext,
  userId: string,
  from: string,
): Promise<FileFolderRow[]> {
  if (ctx.backend === 'postgres') return listFileFoldersUnderPg(ctx, userId, from);
  const rows = ctx.sqlite
    .prepare(
      `SELECT id, path FROM file_folders
       WHERE user_id = ? AND (path = ? OR substr(path, 1, LENGTH(?) + 1) = ? || '/')`,
    )
    .all(userId, from, from, from) as Array<{ id: string; path: string }>;
  return rows.map((r) => ({ id: r.id, path: r.path }));
}

/** Rename `from` -> `to`, cascading to the whole subtree. Returns rows rewritten. */
export async function renameFileFoldersPrefix(
  ctx: DbContext,
  userId: string,
  from: string,
  to: string,
): Promise<number> {
  if (ctx.backend === 'postgres') return renameFileFoldersPrefixPg(ctx, userId, from, to);
  const info = ctx.sqlite
    .prepare(
      `UPDATE file_folders SET path = ? || substr(path, LENGTH(?) + 1)
       WHERE user_id = ? AND (path = ? OR substr(path, 1, LENGTH(?) + 1) = ? || '/')`,
    )
    .run(to, from, userId, from, from, from);
  return info.changes;
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
    .prepare('SELECT doc_type, review_status, vectorization_meta, graph_status FROM documents WHERE id = ?')
    .get(docId) as { doc_type: string; review_status: string | null; vectorization_meta: string | null; graph_status: string | null } | undefined;
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

  let graphStatus: DocumentGraphStatus | null = null;
  if (doc.graph_status) {
    try {
      graphStatus = JSON.parse(doc.graph_status) as DocumentGraphStatus;
    } catch {
      graphStatus = null;
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

  // Followup P0 (2026-08-17): proposedRelationships is DERIVED from the current
  // fields (same rule as the graph writer + proposedEdges), NOT the persisted
  // proposed_relationships column — the column goes stale after a correction
  // (updateExtractionFields only rewrites fields/field_meta). Zero drift between
  // the review card and what commitDocumentGraph writes to Neo4j.
  const proposedRelationships: ProposedRelationship[] = deriveProposedRelationships(fields);

  // 合同类型派生(spec 2026-08-20 §3.2): 与台账写回/图提交同一纯函数, 快照侧
  // 就地计算; 无识别结果时挂 null(非合同/全无信号 -> 复核卡不渲染该区)。
  // 人工在复核卡改「合同类型」字段 -> applyDocumentCorrections 以
  // confidence 1.0 落 fields -> 派生 source 自动变 'field', 无需额外代码。
  const contractDerivation = deriveContractType({
    docType: doc.doc_type,
    fields,
    selfPartyNames: await effectiveSelfPartyNamesForDerivation(ctx),
  });
  const contractType = contractDerivation.contractType ? contractDerivation : null;

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
    proposedEdges: deriveProposedEdges(doc.doc_type, fields),
    contractType,
    graphStatus,
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
 * 持久化确认时图写入结果到 documents 行。镜像 setDocumentVectorization 的裸
 * UPDATE 形态。userId 仅为签名对称（void）。
 */
export async function setDocumentGraphStatus(
  ctx: DbContext,
  docId: string,
  status: DocumentGraphStatus,
  userId?: string,
): Promise<void> {
  if (ctx.backend === 'postgres') return setDocumentGraphStatusPg(ctx, docId, status, userId);
  void userId;
  ctx.sqlite
    .prepare('UPDATE documents SET graph_status = ? WHERE id = ?')
    .run(JSON.stringify(status), docId);
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
 * 修正文档的 docType(PATCH /api/documents/:docId/type)。UPDATE documents 仅
 * 改 doc_type 单列(区别于 updateDocumentMeta 的多列); 所有权作用域与
 * updateBindingStatus 一致: uid 在 scope 时按 3-way OR(user_id 归属 + legacy
 * ''/NULL)过滤, 他人私有行不可改。返回是否有行被更新(false -> 路由 404)。
 *
 * 级联: 执行流水物化(executionFlow.materializeExecutionFlow)与候选扫描
 * (bindingCandidates)都以 extractions.doc_type 为 docType 事实来源, 因此
 * documents.doc_type 修正后必须同步到该文档的 extraction 行, 否则改类型后
 * 重建的执行流水仍按旧类型物化/落空。
 *
 * 级联二(Bug fix): 该 document_id 对应的 contract_ledger 行 doc_type 同步为
 * 新类型(否则用户验收场景「补充合同 -> 合同」后台账仍显示旧类型)。且当新类型
 * 为 合同 且 台账行 contract_type 为 NULL 且标题/字段可重派生时, 用与录入写回
 * 同一规则(deriveContractType + effectiveSelfPartyNamesForDerivation)重派生
 * contract_type; 已有值的行不动(人工修正不被覆盖), 重派生失败静默跳过(doc_type
 * 主级联不受影响)。离开 合同 粗类时不清洗 contract_type —— 类型再改回 合同 时
 * 派生信息仍有价值。
 */
export async function updateDocumentType(
  ctx: DbContext,
  docId: string,
  docType: DocType,
  userId?: string,
): Promise<boolean> {
  if (ctx.backend === 'postgres') return updateDocumentTypePg(ctx, docId, docType, userId);
  const uid = effectiveUserId(userId);
  const res = uid
    ? ctx.sqlite
        .prepare(
          `UPDATE documents SET doc_type = ?
           WHERE id = ? AND (user_id = ? OR user_id = '' OR user_id IS NULL)`,
        )
        .run(docType, docId, uid)
    : ctx.sqlite.prepare('UPDATE documents SET doc_type = ? WHERE id = ?').run(docType, docId);
  if (res.changes === 0) return false;
  // 级联到 extraction 行(见函数头注释)。所有权已由 documents 侧判定通过。
  ctx.sqlite.prepare('UPDATE extractions SET doc_type = ? WHERE document_id = ?').run(docType, docId);
  // 级联到 contract_ledger 行(Bug fix): doc_type 必须跟随; 条件性重派生
  // contract_type。故障隔离: 台账级联失败不翻转已成功的 documents/extractions 更新。
  try {
    const rows = ctx.sqlite
      .prepare('SELECT id, contract_type, fields FROM contract_ledger WHERE document_id = ?')
      .all(docId) as Array<{ id: string; contract_type: string | null; fields: string }>;
    if (rows.length > 0) {
      ctx.sqlite
        .prepare(`UPDATE contract_ledger SET doc_type = ?, updated_at = datetime('now') WHERE document_id = ?`)
        .run(docType, docId);
      if (docType === '合同') {
        let selfNames: string[] = [];
        try { selfNames = await effectiveSelfPartyNamesForDerivation(ctx); } catch { selfNames = []; }
        for (const row of rows) {
          if (row.contract_type !== null && row.contract_type !== '') continue;
          const derivation = deriveContractType({
            docType,
            fields: ledgerRowFieldsToProjection(row.fields),
            selfPartyNames: selfNames,
          });
          if (derivation.contractType === null) continue;
          ctx.sqlite.prepare('UPDATE contract_ledger SET contract_type = ? WHERE id = ?').run(
            derivation.contractType,
            row.id,
          );
        }
      }
    }
  } catch (e) {
    console.error('[updateDocumentType] contract_ledger 级联失败:', (e as Error).message);
  }
  return true;
}

/**
 * contract_ledger 行 fields -> 最小字段投影({name, value})。SQLite 存 JSON 文本,
 * pg jsonb 经 node-pg 反序列化为对象 -- 两种形状都接受(含 {value, sourceSpans}
 * 包装); 损坏输入返回 [](派生自然为 null), 绝不抛出。pg twin 复用。
 */
export function ledgerRowFieldsToProjection(
  fields: unknown,
): Array<{ name: string; value: string | number }> {
  let parsed: Record<string, unknown> | null;
  if (typeof fields === 'string') {
    try {
      parsed = JSON.parse(fields) as Record<string, unknown>;
    } catch {
      return []; // 损坏的 fields JSON -> 无字段可派生。
    }
  } else {
    parsed = (fields && typeof fields === 'object' ? fields : null) as Record<string, unknown> | null;
  }
  const out: Array<{ name: string; value: string | number }> = [];
  if (!parsed) return out;
  for (const [name, f] of Object.entries(parsed)) {
    const v = (f as { value?: unknown })?.value;
    if (typeof v === 'string' || typeof v === 'number') out.push({ name, value: v });
  }
  return out;
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

export interface DocumentMeta {
  sourceUri: string | null;
  docType: string | null;
}

/**
 * Read source_uri + doc_type in one call for graph sync（绑定同步要把两者回填进
 * Document 图节点，缺失会导致前端显示 docId 而非文件名）。Row 不存在返回 null。
 */
export async function getDocumentMeta(
  ctx: DbContext,
  docId: string,
  userId?: string,
): Promise<DocumentMeta | null> {
  if (ctx.backend === 'postgres') return getDocumentMetaPg(ctx, docId, userId);
  void userId;
  const row = ctx.sqlite
    .prepare('SELECT source_uri, doc_type FROM documents WHERE id = ?')
    .get(docId) as { source_uri: string | null; doc_type: string | null } | undefined;
  return row ? { sourceUri: row.source_uri, docType: row.doc_type } : null;
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
          overall_confidence, needs_review, user_id, contract_type)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(contract_no, user_id) DO UPDATE SET
         display_contract_no = excluded.display_contract_no,
         doc_type = excluded.doc_type,
         document_id = excluded.document_id,
         title = excluded.title,
         fields = excluded.fields,
         field_meta = excluded.field_meta,
         overall_confidence = excluded.overall_confidence,
         needs_review = excluded.needs_review,
         contract_type = excluded.contract_type,
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
      entry.contractType,
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
                  overall_confidence, needs_review, user_id, contract_type
           FROM contract_ledger
           WHERE contract_no = ? AND (user_id = ? OR user_id = '' OR user_id IS NULL)`,
        )
        .get(normalized, uid)
    : ctx.sqlite
        .prepare(
          `SELECT contract_no, display_contract_no, doc_type, document_id, title, fields, field_meta,
                  overall_confidence, needs_review, user_id, contract_type
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
        contract_type: string | null;
      }
    | undefined;
  if (!row) return null;
  return {
    contractNo: row.contract_no,
    displayContractNo: row.display_contract_no,
    docType: row.doc_type,
    documentId: row.document_id,
    title: row.title,
    contractType: (row.contract_type as ContractType | null) ?? null,
    fields: JSON.parse(row.fields) as ContractLedgerEntry['fields'],
    fieldMeta: JSON.parse(row.field_meta) as ContractLedgerEntry['fieldMeta'],
    overallConfidence: row.overall_confidence,
    needsReview: !!row.needs_review,
    userId: row.user_id,
  };
}

/**
 * 列出合同台账全部条目(Phase B 绑定建议匹配用)。按 user 过滤(legacy 行 3-way OR),
 * 按 updated_at DESC。字段形状与 findContractLedgerByNo 一致。
 */
export async function listContractLedgerEntries(
  ctx: DbContext,
  userId?: string,
): Promise<ContractLedgerEntry[]> {
  if (ctx.backend === 'postgres') return listContractLedgerEntriesPg(ctx, userId);
  const uid = effectiveUserId(userId);
  const rows = uid
    ? (ctx.sqlite
        .prepare(
          `SELECT contract_no, display_contract_no, doc_type, document_id, title, fields, field_meta,
                  overall_confidence, needs_review, user_id, contract_type
           FROM contract_ledger
           WHERE user_id = ? OR user_id = '' OR user_id IS NULL
           ORDER BY updated_at DESC`,
        )
        .all(uid) as unknown as Array<{
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
        contract_type: string | null;
      }>)
    : (ctx.sqlite
        .prepare(
          `SELECT contract_no, display_contract_no, doc_type, document_id, title, fields, field_meta,
                  overall_confidence, needs_review, user_id, contract_type
           FROM contract_ledger
           ORDER BY updated_at DESC`,
        )
        .all() as unknown as Array<{
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
        contract_type: string | null;
      }>);
  return rows.map((row) => ({
    contractNo: row.contract_no,
    displayContractNo: row.display_contract_no,
    docType: row.doc_type,
    documentId: row.document_id,
    title: row.title,
    contractType: (row.contract_type as ContractType | null) ?? null,
    fields: JSON.parse(row.fields) as ContractLedgerEntry['fields'],
    fieldMeta: JSON.parse(row.field_meta) as ContractLedgerEntry['fieldMeta'],
    overallConfidence: row.overall_confidence,
    needsReview: !!row.needs_review,
    userId: row.user_id,
  }));
}

/** LIKE 模式转义: %/_/\ 在 LIKE 中是通配符, 输入原样匹配时须转义。 */
function likePattern(s: string): string {
  return `%${s.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
}

const LEDGER_PARTY_KEYS = ['买方', '甲方', '卖方', '乙方'] as const;
const LEDGER_COLS = `contract_no, display_contract_no, doc_type, document_id, title, fields, field_meta,
                   overall_confidence, needs_review, user_id, contract_type`;
type LedgerRow = {
  contract_no: string; display_contract_no: string; doc_type: string; document_id: string;
  title: string; fields: string; field_meta: string; overall_confidence: number;
  needs_review: number; user_id: string; contract_type: string | null;
};

/**
 * 合同台账搜索(spec 2026-08-26 §4.1): SQL LIKE 粗筛(LIMIT 200) + rankContractSearch
 * JS 精排截断 limit。粗筛覆盖 编号(归一化前缀+原文包含)/标题/fields 四个主体键。
 * user 过滤沿用 legacy 3-way OR。PG 走 searchContractLedgerPg。
 */
export async function searchContractLedger(
  ctx: DbContext,
  q: string,
  userId?: string,
  limit = 10,
): Promise<ContractSearchItem[]> {
  if (ctx.backend === 'postgres') return searchContractLedgerPg(ctx, q, userId, limit);
  const raw = q.trim();
  if (!raw) return [];
  const uid = effectiveUserId(userId);
  const like = likePattern(raw);
  const nq = normalizeContractNo(raw);
  const ors: string[] = [
    'contract_no LIKE ? ESCAPE \'\\\'',
    'display_contract_no LIKE ? ESCAPE \'\\\'',
    'title LIKE ? ESCAPE \'\\\'',
  ];
  const params: unknown[] = [like, like, like];
  for (const key of LEDGER_PARTY_KEYS) {
    ors.push(`json_extract(fields, '$.${key}.value') LIKE ? ESCAPE '\\'`);
    params.push(like);
  }
  if (nq) {
    const escNq = nq.replace(/[\\%_]/g, (m) => `\\${m}`);
    ors.push(`contract_no LIKE ? ESCAPE '\\'`);
    params.push(`${escNq}%`);
    // 中段片段查询(JS 精排 0.9 分路径)也需 SQL 粗筛放行, 否则永远到不了精排。
    ors.push(`contract_no LIKE ? ESCAPE '\\'`);
    params.push(`%${escNq}%`);
  }
  const userWhere = uid ? '(user_id = ? OR user_id = \'\' OR user_id IS NULL) AND ' : '';
  const userParams = uid ? [uid] : [];
  const rows = ctx.sqlite
    .prepare(
      `SELECT ${LEDGER_COLS} FROM contract_ledger
       WHERE ${userWhere}(${ors.join(' OR ')})
       ORDER BY updated_at DESC
       LIMIT 200`,
    )
    .all(...userParams, ...params) as unknown as LedgerRow[];
  const entries: ContractLedgerEntry[] = rows.map((row) => ({
    contractNo: row.contract_no,
    displayContractNo: row.display_contract_no,
    docType: row.doc_type,
    documentId: row.document_id,
    title: row.title,
    contractType: (row.contract_type as ContractLedgerEntry['contractType']) ?? null,
    fields: JSON.parse(row.fields) as ContractLedgerEntry['fields'],
    fieldMeta: JSON.parse(row.field_meta) as ContractLedgerEntry['fieldMeta'],
    overallConfidence: row.overall_confidence,
    needsReview: !!row.needs_review,
    userId: row.user_id,
  }));
  return rankContractSearch(raw, entries, limit);
}

// ---- Execution flows (六向执行流水) ------------------------------------------
//
// 合同绑定确认后物化的流水明细: '资金流' | '货物流' | '发票流' x 'in' | 'out'。
// flow_type 词汇由消费层定义, 存储层只存字符串。唯一键 (binding_id, user_id):
// 同一绑定重复物化走 ON CONFLICT upsert 就地更新(与 contract_ledger 同款幂等)。
// user_id 归一化(effectiveUserId)与读取 3-way OR 过滤照抄 listBindingsForUser /
// contract_ledger 的既有做法: uid 空时跳过过滤, uid 非空时 legacy 行(''/NULL)
// 对任何调用者可见。

export type ExecutionFlowDirection = 'in' | 'out';

export interface ExecutionFlowInput {
  bindingId: string;
  documentId: string;
  contractNo: string;
  /** '资金流' | '货物流' | '发票流' — 词汇由消费层定义, 存储层只存字符串。 */
  flowType: string;
  direction: ExecutionFlowDirection;
  amount: number | null;
  quantityTon: number | null;
  /** 数量单位('吨'等), 与 quantityTon 同源; 裸 '数量' 字段不带单位语义时为 null。 */
  unit?: string | null;
  docType: string;
  voucherDate: string | null;
  /** 溯源: 物化时读到的抽取行 id(修正重建后指向新行, 防漂移审计线索)。 */
  extractionId?: string | null;
  confidence: number;
  createdBy: string;
}

export interface ExecutionFlowRow extends ExecutionFlowInput {
  id: string;
  userId: string | null;
  createdAt: string;
}

export interface ExecutionFlowSummary {
  contractNo: string;
  flowType: string;
  direction: ExecutionFlowDirection;
  entryCount: number;
  totalAmount: number | null;
  totalQuantityTon: number | null;
  lastVoucherDate: string | null;
}

/**
 * 物化/更新一条执行流水。唯一键 (binding_id, user_id): 冲突时更新业务列
 * (document_id / contract_no / flow_type / direction / amount / quantity_ton /
 * unit / doc_type / voucher_date / confidence / created_by), created_at 保持首次写入值。
 * 返回 flow id。
 */
export async function upsertExecutionFlow(
  ctx: DbContext,
  input: ExecutionFlowInput,
  userId?: string,
): Promise<string> {
  if (ctx.backend === 'postgres') return upsertExecutionFlowPg(ctx, input, userId);
  const id = rid('EF');
  ctx.sqlite
    .prepare(
      `INSERT INTO execution_flows
         (id, binding_id, document_id, contract_no, flow_type, direction, amount, quantity_ton, unit,
          doc_type, voucher_date, extraction_id, confidence, created_by, user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(binding_id, user_id) DO UPDATE SET
         document_id = excluded.document_id,
         contract_no = excluded.contract_no,
         flow_type = excluded.flow_type,
         direction = excluded.direction,
         amount = excluded.amount,
         quantity_ton = excluded.quantity_ton,
         unit = excluded.unit,
         doc_type = excluded.doc_type,
         voucher_date = excluded.voucher_date,
         extraction_id = excluded.extraction_id,
         confidence = excluded.confidence,
         created_by = excluded.created_by`,
    )
    .run(
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
    );
  return id;
}

/**
 * unbind 后撤回物化行(DELETE)。幂等: 行不存在(或已被撤回)时返回 false, 删了行
 * 返回 true。按 binding_id(+ 用户 3-way 过滤)删除该绑定名下全部流水行。
 */
export async function retractExecutionFlowForBinding(
  ctx: DbContext,
  bindingId: string,
  userId?: string,
): Promise<boolean> {
  if (ctx.backend === 'postgres') return retractExecutionFlowForBindingPg(ctx, bindingId, userId);
  const uid = effectiveUserId(userId);
  const info = uid
    ? ctx.sqlite
        .prepare(
          `DELETE FROM execution_flows
           WHERE binding_id = ? AND (user_id = ? OR user_id = '' OR user_id IS NULL)`,
        )
        .run(bindingId, uid)
    : ctx.sqlite.prepare('DELETE FROM execution_flows WHERE binding_id = ?').run(bindingId);
  return info.changes > 0;
}

/**
 * 撤回一份文档名下的全部流水行(DELETE)。复核修正触发全量重建的前半段:
 * 先清空该文档旧流水, 再按最新抽取逐绑定重物化(见 executionFlow.ts 的
 * refreshExecutionFlowsForDocument), 保证流水与抽取不漂移。幂等。
 */
export async function retractExecutionFlowsForDocument(
  ctx: DbContext,
  documentId: string,
  userId?: string,
): Promise<number> {
  if (ctx.backend === 'postgres') return retractExecutionFlowsForDocumentPg(ctx, documentId, userId);
  const uid = effectiveUserId(userId);
  const info = uid
    ? ctx.sqlite
        .prepare(
          `DELETE FROM execution_flows
           WHERE document_id = ? AND (user_id = ? OR user_id = '' OR user_id IS NULL)`,
        )
        .run(documentId, uid)
    : ctx.sqlite.prepare('DELETE FROM execution_flows WHERE document_id = ?').run(documentId);
  return info.changes;
}

/**
 * 列出一份文档的全部 confirmed 绑定(重建流水的原料)。按 user 过滤
 * (legacy 行 3-way OR), 按 created_at DESC。
 */
export async function listConfirmedBindingsForDocument(
  ctx: DbContext,
  documentId: string,
  userId?: string,
): Promise<BindingRow[]> {
  if (ctx.backend === 'postgres') return listConfirmedBindingsForDocumentPg(ctx, documentId, userId);
  const uid = effectiveUserId(userId);
  const filter = uid
    ? and(
        eq(bindings.documentId, documentId),
        eq(bindings.status, 'confirmed'),
        or(eq(bindings.userId, uid), eq(bindings.userId, ''), isNull(bindings.userId)),
      )
    : and(eq(bindings.documentId, documentId), eq(bindings.status, 'confirmed'));
  const rows = ctx.db
    .select()
    .from(bindings)
    .where(filter)
    .orderBy(desc(bindings.createdAt))
    .all();
  return rows.map(rowToBinding);
}

/** SQLite execution_flows 行 -> ExecutionFlowRow(所有 SQLite 读取函数共用)。 */
function executionFlowRowFromSqlite(r: {
  id: string;
  binding_id: string;
  document_id: string;
  contract_no: string;
  flow_type: string;
  direction: string;
  amount: number | null;
  quantity_ton: number | null;
  unit: string | null;
  doc_type: string;
  voucher_date: string | null;
  extraction_id: string | null;
  confidence: number;
  created_by: string;
  user_id: string | null;
  created_at: string;
}): ExecutionFlowRow {
  return {
    id: r.id,
    bindingId: r.binding_id,
    documentId: r.document_id,
    contractNo: r.contract_no,
    flowType: r.flow_type,
    direction: r.direction as ExecutionFlowDirection,
    amount: r.amount ?? null,
    quantityTon: r.quantity_ton ?? null,
    unit: r.unit ?? null,
    docType: r.doc_type,
    voucherDate: r.voucher_date ?? null,
    extractionId: r.extraction_id ?? null,
    confidence: r.confidence,
    createdBy: r.created_by,
    userId: r.user_id ?? null,
    createdAt: r.created_at,
  };
}

/** 明细行, 按 created_at 升序。 */
export async function listExecutionFlows(
  ctx: DbContext,
  contractNo: string,
  userId?: string,
): Promise<ExecutionFlowRow[]> {
  if (ctx.backend === 'postgres') return listExecutionFlowsPg(ctx, contractNo, userId);
  const uid = effectiveUserId(userId);
  const rows = (uid
    ? ctx.sqlite
        .prepare(
          `SELECT id, binding_id, document_id, contract_no, flow_type, direction, amount, quantity_ton, unit,
                  doc_type, voucher_date, extraction_id, confidence, created_by, user_id, created_at
           FROM execution_flows
           WHERE contract_no = ? AND (user_id = ? OR user_id = '' OR user_id IS NULL)
           ORDER BY created_at ASC`,
        )
        .all(contractNo, uid)
    : ctx.sqlite
        .prepare(
          `SELECT id, binding_id, document_id, contract_no, flow_type, direction, amount, quantity_ton, unit,
                  doc_type, voucher_date, extraction_id, confidence, created_by, user_id, created_at
           FROM execution_flows
           WHERE contract_no = ?
           ORDER BY created_at ASC`,
        )
        .all(contractNo)) as Array<{
    id: string;
    binding_id: string;
    document_id: string;
    contract_no: string;
    flow_type: string;
    direction: string;
    amount: number | null;
    quantity_ton: number | null;
    unit: string | null;
    doc_type: string;
    voucher_date: string | null;
    extraction_id: string | null;
    confidence: number;
    created_by: string;
    user_id: string | null;
    created_at: string;
  }>;
  return rows.map(executionFlowRowFromSqlite);
}

/** 六向汇总: GROUP BY flow_type, direction(flow_type, direction 升序输出)。 */
export async function summarizeExecutionFlows(
  ctx: DbContext,
  contractNo: string,
  userId?: string,
): Promise<ExecutionFlowSummary[]> {
  if (ctx.backend === 'postgres') return summarizeExecutionFlowsPg(ctx, contractNo, userId);
  const uid = effectiveUserId(userId);
  const rows = (uid
    ? ctx.sqlite
        .prepare(
          `SELECT flow_type, direction, COUNT(*) AS entry_count, SUM(amount) AS total_amount,
                  SUM(quantity_ton) AS total_quantity_ton, MAX(voucher_date) AS last_voucher_date
           FROM execution_flows
           WHERE contract_no = ? AND (user_id = ? OR user_id = '' OR user_id IS NULL)
           GROUP BY flow_type, direction
           ORDER BY flow_type, direction`,
        )
        .all(contractNo, uid)
    : ctx.sqlite
        .prepare(
          `SELECT flow_type, direction, COUNT(*) AS entry_count, SUM(amount) AS total_amount,
                  SUM(quantity_ton) AS total_quantity_ton, MAX(voucher_date) AS last_voucher_date
           FROM execution_flows
           WHERE contract_no = ?
           GROUP BY flow_type, direction
           ORDER BY flow_type, direction`,
        )
        .all(contractNo)) as Array<{
    flow_type: string;
    direction: string;
    entry_count: number;
    total_amount: number | null;
    total_quantity_ton: number | null;
    last_voucher_date: string | null;
  }>;
  return rows.map((r) => ({
    contractNo,
    flowType: r.flow_type,
    direction: r.direction as ExecutionFlowDirection,
    entryCount: Number(r.entry_count),
    // SUM 对全 NULL 组返回 NULL(金额为 null 的行不计入 SUM)。
    totalAmount: r.total_amount === null || r.total_amount === undefined ? null : Number(r.total_amount),
    totalQuantityTon:
      r.total_quantity_ton === null || r.total_quantity_ton === undefined ? null : Number(r.total_quantity_ton),
    lastVoucherDate: r.last_voucher_date ?? null,
  }));
}

// ---- 自主体名单(Task A) -------------------------------------------------------
//
// 六向执行流水的方向判定以"本公司是谁"为基准(env.SELF_PARTY_NAMES)。名单新增
// DB 侧管理(self_parties)与 env 并集, 解决 env 未配置时流水静默跳过的 incident。
// 名单租户全局(无 user_id), 与 env 变量同域; created_by 仅审计。

export interface DocumentSourceRow {
  id: string;
  sourceUri: string;
  minioKey: string | null;
}

/** 批量取文档的来源路径与 MinIO key(flows 溯源列展示文件名/点击预览用)。 */
export async function getDocumentSourcesByIds(ctx: DbContext, ids: string[]): Promise<DocumentSourceRow[]> {
  if (ids.length === 0) return [];
  if (ctx.backend === 'postgres') return getDocumentSourcesByIdsPg(ctx, ids);
  const placeholders = ids.map(() => '?').join(', ');
  const rows = ctx.sqlite
    .prepare(`SELECT id, source_uri, minio_key FROM documents WHERE id IN (${placeholders})`)
    .all(...ids) as Array<{ id: string; source_uri: string | null; minio_key: string | null }>;
  return rows.map((r) => ({
    id: r.id,
    sourceUri: r.source_uri ?? '',
    minioKey: r.minio_key ?? null,
  }));
}

export interface SelfPartyRow {
  name: string;
  createdBy: string;
  createdAt: string | null;
}

/** 全量列出 DB 侧自主体名单(租户全局, 无 user 过滤), 按 name 升序。 */
export async function listSelfParties(ctx: DbContext): Promise<SelfPartyRow[]> {
  if (ctx.backend === 'postgres') return listSelfPartiesPg(ctx);
  const rows = ctx.sqlite
    .prepare('SELECT name, created_by, created_at FROM self_parties ORDER BY name ASC')
    .all() as Array<{ name: string; created_by: string; created_at: string }>;
  return rows.map((r) => ({
    name: r.name,
    createdBy: r.created_by,
    createdAt: r.created_at,
  }));
}

/**
 * 新增自主体(原始名 raw, PK)。去重语义使用 domain normalizeCompanyName:
 * 归一化形式已存在(含精确同名) -> 返回 false; 归一化后为空串 -> false。
 * 调用方(路由)先做 400 校验, 此处为存储层兜底。
 */
export async function addSelfParty(ctx: DbContext, name: string, createdBy: string): Promise<boolean> {
  if (ctx.backend === 'postgres') return addSelfPartyPg(ctx, name, createdBy);
  const trimmed = name.trim();
  const norm = normalizeCompanyName(trimmed);
  if (norm.length === 0) return false;
  const existing = ctx.sqlite.prepare('SELECT name FROM self_parties').all() as Array<{ name: string }>;
  if (existing.some((r) => normalizeCompanyName(r.name) === norm)) return false;
  const res = ctx.sqlite
    .prepare('INSERT OR IGNORE INTO self_parties (name, created_by) VALUES (?, ?)')
    .run(trimmed, createdBy);
  return res.changes > 0;
}

/** 按原始名精确删除(路由已 URL-decode)。返回是否有行被删除。 */
export async function removeSelfParty(ctx: DbContext, name: string): Promise<boolean> {
  if (ctx.backend === 'postgres') return removeSelfPartyPg(ctx, name);
  const res = ctx.sqlite.prepare('DELETE FROM self_parties WHERE name = ?').run(name);
  return res.changes > 0;
}

/**
 * 列出持有 confirmed 绑定(且对调用者可见)的文档 id 去重集合。回填(backfill)
 * 原料: 新增名单后对候选文档重建执行流水。user 过滤与 listBindingsForUser 同款
 * 3-way OR(legacy ''/NULL 行对任何调用者可见)。
 */
export async function listDocumentIdsWithConfirmedBindings(
  ctx: DbContext,
  userId?: string,
): Promise<string[]> {
  if (ctx.backend === 'postgres') return listDocumentIdsWithConfirmedBindingsPg(ctx, userId);
  const uid = effectiveUserId(userId);
  const rows = (uid
    ? ctx.sqlite
        .prepare(
          "SELECT DISTINCT document_id AS d FROM bindings WHERE status = 'confirmed' AND (user_id = ? OR user_id = '' OR user_id IS NULL)",
        )
        .all(uid)
    : ctx.sqlite
        .prepare("SELECT DISTINCT document_id AS d FROM bindings WHERE status = 'confirmed'")
        .all()) as Array<{ d: string }>;
  return rows.map((r) => r.d);
}

/** 文档是否已有执行流水行(回填跳过已物化的文档)。 */
export async function hasExecutionFlowsForDocument(
  ctx: DbContext,
  documentId: string,
  userId?: string,
): Promise<boolean> {
  if (ctx.backend === 'postgres') return hasExecutionFlowsForDocumentPg(ctx, documentId, userId);
  const uid = effectiveUserId(userId);
  const row = uid
    ? ctx.sqlite
        .prepare(
          "SELECT 1 FROM execution_flows WHERE document_id = ? AND (user_id = ? OR user_id = '' OR user_id IS NULL) LIMIT 1",
        )
        .get(documentId, uid)
    : ctx.sqlite.prepare('SELECT 1 FROM execution_flows WHERE document_id = ? LIMIT 1').get(documentId);
  return !!row;
}

// ---- 项目维度(spec 2026-08-20 §4.1) -------------------------------------------
//
// projects / project_memberships 是关系库 SSOT(Neo4j 图只是投影)。contractNo 存
// normalizeContractNo 后的值(与 contract_ledger 同键, 报表连接键); projectCode 存
// normalizeProjectCode 归一大写。用户作用域与 3-way OR 过滤照 contract_ledger 写法;
// 写侧 user_id 统一经 effectiveUserId 归一('' = 未登录态), 保证唯一索引生效。

export interface ProjectRow {
  code: string;            // 归一大写
  name: string;
  status: string;          // 'active' | 'archived'
  userId: string | null;
  createdAt: string;
  updatedAt: string;
}

export type MembershipStatus = 'proposed' | 'confirmed' | 'rejected';
export type MembershipProposedBy = 'system' | 'agent' | 'human';

export interface ProjectMembershipRow {
  id: string;
  contractNo: string;      // normalizeContractNo 后(报表连接键, spec §4.1)
  projectCode: string;     // 归一大写
  role: string | null;     // 合同类型
  status: MembershipStatus;
  proposedBy: MembershipProposedBy;
  confirmationSource: string | null;
  confidence: number;
  createdBy: string;
  userId: string | null;
  createdAt: string;
  graphStatus: BindingGraphStatus | null;
}

export interface ProjectMembershipInput {
  contractNo: string;
  projectCode: string;
  role?: string | null;
  status?: MembershipStatus;                       // 默认 'proposed'
  proposedBy?: MembershipProposedBy;               // 默认 'system'
  confirmationSource?: 'auto_rule' | 'human' | null;
  confidence?: number;                             // 默认 0
  createdBy: string;
}

/** 项目编号归一: trim + 大写(与合同号归一分开, 项目编号是人工编码)。 */
export function normalizeProjectCode(raw: string): string {
  return raw.trim().toUpperCase();
}

function projectRowFrom(r: {
  code: string; name: string; status: string; user_id: string | null;
  created_at: string | null; updated_at: string | null;
}): ProjectRow {
  return {
    code: r.code,
    name: r.name,
    status: r.status,
    userId: r.user_id ?? null,
    createdAt: r.created_at ?? '',
    updatedAt: r.updated_at ?? '',
  };
}

const MEMBERSHIP_COLS = 'id, contract_no, project_code, role, status, proposed_by, confirmation_source, confidence, created_by, user_id, created_at, graph_status';

function membershipRowFrom(r: {
  id: string; contract_no: string; project_code: string; role: string | null;
  status: string; proposed_by: string; confirmation_source: string | null;
  confidence: number | string; created_by: string; user_id: string | null;
  created_at: string | null; graph_status: string | null;
}): ProjectMembershipRow {
  return {
    id: r.id,
    contractNo: r.contract_no,
    projectCode: r.project_code,
    role: r.role ?? null,
    status: r.status as MembershipStatus,
    proposedBy: r.proposed_by as MembershipProposedBy,
    confirmationSource: r.confirmation_source ?? null,
    confidence: Number(r.confidence),
    createdBy: r.created_by,
    userId: r.user_id ?? null,
    createdAt: r.created_at ?? '',
    graphStatus: r.graph_status ? (JSON.parse(r.graph_status) as BindingGraphStatus) : null,
  };
}

/** 新建项目。code 先 normalizeProjectCode; 已存在(同 code+user)返回 null(幂等)。 */
export async function createProject(
  ctx: DbContext,
  input: { code: string; name: string; userId?: string | null },
): Promise<ProjectRow | null> {
  if (ctx.backend === 'postgres') return createProjectPg(ctx, input);
  const code = normalizeProjectCode(input.code);
  const uid = effectiveUserId(input.userId ?? undefined);
  const name = input.name.trim();
  if (!code || !name) return null;
  const exists = ctx.sqlite
    .prepare('SELECT 1 FROM projects WHERE code = ? AND user_id = ?')
    .get(code, uid);
  if (exists) return null;
  ctx.sqlite
    .prepare('INSERT INTO projects (id, code, name, status, user_id) VALUES (?, ?, ?, ?, ?)')
    .run(rid('PRJ'), code, name, 'active', uid);
  const row = ctx.sqlite
    .prepare('SELECT code, name, status, user_id, created_at, updated_at FROM projects WHERE code = ? AND user_id = ?')
    .get(code, uid) as Parameters<typeof projectRowFrom>[0];
  return projectRowFrom(row);
}

/** 按 code 查项目(归一大写; 3-way OR 可见过滤)。 */
export async function findProjectByCode(
  ctx: DbContext, code: string, userId?: string,
): Promise<ProjectRow | null> {
  if (ctx.backend === 'postgres') return findProjectByCodePg(ctx, code, userId);
  const normalized = normalizeProjectCode(code);
  if (!normalized) return null;
  const uid = effectiveUserId(userId);
  const row = (uid
    ? ctx.sqlite
        .prepare(
          "SELECT code, name, status, user_id, created_at, updated_at FROM projects WHERE code = ? AND (user_id = ? OR user_id = '' OR user_id IS NULL)",
        )
        .get(normalized, uid)
    : ctx.sqlite
        .prepare('SELECT code, name, status, user_id, created_at, updated_at FROM projects WHERE code = ?')
        .get(normalized)) as Parameters<typeof projectRowFrom>[0] | undefined;
  return row ? projectRowFrom(row) : null;
}

/** 全量项目列表(3-way OR 可见过滤), 按 code 升序。 */
export async function listProjects(ctx: DbContext, userId?: string): Promise<ProjectRow[]> {
  if (ctx.backend === 'postgres') return listProjectsPg(ctx, userId);
  const uid = effectiveUserId(userId);
  const rows = (uid
    ? ctx.sqlite
        .prepare(
          "SELECT code, name, status, user_id, created_at, updated_at FROM projects WHERE user_id = ? OR user_id = '' OR user_id IS NULL ORDER BY code ASC",
        )
        .all(uid)
    : ctx.sqlite
        .prepare('SELECT code, name, status, user_id, created_at, updated_at FROM projects ORDER BY code ASC')
        .all()) as Array<Parameters<typeof projectRowFrom>[0]>;
  return rows.map(projectRowFrom);
}

/**
 * 归属 upsert: 唯一键 (contract_no, project_code, user_id) 冲突时 UPDATE
 * role/status/proposed_by/confirmation_source/confidence/created_by, 返回 id。
 * contractNo/projectCode 均先归一。
 */
export async function upsertProjectMembership(
  ctx: DbContext,
  input: ProjectMembershipInput,
  userId?: string,
): Promise<string> {
  if (ctx.backend === 'postgres') return upsertProjectMembershipPg(ctx, input, userId);
  const uid = effectiveUserId(userId);
  const contractNo = normalizeContractNo(input.contractNo);
  const projectCode = normalizeProjectCode(input.projectCode);
  const row = ctx.sqlite
    .prepare(
      `INSERT INTO project_memberships
         (id, contract_no, project_code, role, status, proposed_by, confirmation_source, confidence, created_by, user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(contract_no, project_code, user_id) DO UPDATE SET
         role = excluded.role,
         status = excluded.status,
         proposed_by = excluded.proposed_by,
         confirmation_source = excluded.confirmation_source,
         confidence = excluded.confidence,
         created_by = excluded.created_by
       RETURNING id`,
    )
    .get(
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
    ) as { id: string };
  return row.id;
}

/** 按 id 查归属(3-way OR 可见过滤)。 */
export async function findMembershipById(
  ctx: DbContext, id: string, userId?: string,
): Promise<ProjectMembershipRow | null> {
  if (ctx.backend === 'postgres') return findMembershipByIdPg(ctx, id, userId);
  const uid = effectiveUserId(userId);
  const row = (uid
    ? ctx.sqlite
        .prepare(
          `SELECT ${MEMBERSHIP_COLS} FROM project_memberships
           WHERE id = ? AND (user_id = ? OR user_id = '' OR user_id IS NULL)`,
        )
        .get(id, uid)
    : ctx.sqlite
        .prepare(`SELECT ${MEMBERSHIP_COLS} FROM project_memberships WHERE id = ?`)
        .get(id)) as Parameters<typeof membershipRowFrom>[0] | undefined;
  return row ? membershipRowFrom(row) : null;
}

/** 项目下的归属列表(归一大写; status 可选过滤), created_at 升序。 */
export async function listMembershipsByProject(
  ctx: DbContext,
  projectCode: string,
  userId?: string,
  status?: MembershipStatus,
): Promise<ProjectMembershipRow[]> {
  if (ctx.backend === 'postgres') return listMembershipsByProjectPg(ctx, projectCode, userId, status);
  const normalized = normalizeProjectCode(projectCode);
  const uid = effectiveUserId(userId);
  const statusClause = status ? ' AND status = @status' : '';
  const userClause = uid ? " AND (user_id = @uid OR user_id = '' OR user_id IS NULL)" : '';
  const rows = ctx.sqlite
    .prepare(
      `SELECT ${MEMBERSHIP_COLS} FROM project_memberships
       WHERE project_code = @code${statusClause}${userClause}
       ORDER BY created_at ASC`,
    )
    .all({ code: normalized, ...(status ? { status } : {}), ...(uid ? { uid } : {}) }) as Array<
    Parameters<typeof membershipRowFrom>[0]
  >;
  return rows.map(membershipRowFrom);
}

/** 合同的归属列表(contractNo 归一; 3-way OR 可见过滤)。 */
export async function listMembershipsByContract(
  ctx: DbContext, contractNo: string, userId?: string,
): Promise<ProjectMembershipRow[]> {
  if (ctx.backend === 'postgres') return listMembershipsByContractPg(ctx, contractNo, userId);
  const normalized = normalizeContractNo(contractNo);
  if (!normalized) return [];
  const uid = effectiveUserId(userId);
  const rows = (uid
    ? ctx.sqlite
        .prepare(
          `SELECT ${MEMBERSHIP_COLS} FROM project_memberships
           WHERE contract_no = ? AND (user_id = ? OR user_id = '' OR user_id IS NULL)
           ORDER BY created_at ASC`,
        )
        .all(normalized, uid)
    : ctx.sqlite
        .prepare(
          `SELECT ${MEMBERSHIP_COLS} FROM project_memberships WHERE contract_no = ? ORDER BY created_at ASC`,
        )
        .all(normalized)) as Array<Parameters<typeof membershipRowFrom>[0]>;
  return rows.map(membershipRowFrom);
}

/** 状态迁移(proposed->confirmed/rejected 等)。未知 id 返回 null。 */
export async function updateMembershipStatus(
  ctx: DbContext,
  id: string,
  status: MembershipStatus,
  confirmationSource: 'auto_rule' | 'human' | null,
  userId?: string,
): Promise<ProjectMembershipRow | null> {
  if (ctx.backend === 'postgres') return updateMembershipStatusPg(ctx, id, status, confirmationSource, userId);
  const uid = effectiveUserId(userId);
  const res = (uid
    ? ctx.sqlite
        .prepare(
          "UPDATE project_memberships SET status = ?, confirmation_source = ? WHERE id = ? AND (user_id = ? OR user_id = '' OR user_id IS NULL)",
        )
        .run(status, confirmationSource, id, uid)
    : ctx.sqlite
        .prepare('UPDATE project_memberships SET status = ?, confirmation_source = ? WHERE id = ?')
        .run(status, confirmationSource, id)) as { changes: number };
  if (res.changes === 0) return null;
  return findMembershipById(ctx, id, userId);
}

/** 归属图同步结果落库(JSON)。 */
export async function setMembershipGraphStatus(
  ctx: DbContext, id: string, gs: BindingGraphStatus, userId?: string,
): Promise<void> {
  if (ctx.backend === 'postgres') return setMembershipGraphStatusPg(ctx, id, gs, userId);
  const uid = effectiveUserId(userId);
  if (uid) {
    ctx.sqlite
      .prepare(
        "UPDATE project_memberships SET graph_status = ? WHERE id = ? AND (user_id = ? OR user_id = '' OR user_id IS NULL)",
      )
      .run(JSON.stringify(gs), id, uid);
  } else {
    ctx.sqlite.prepare('UPDATE project_memberships SET graph_status = ? WHERE id = ?').run(JSON.stringify(gs), id);
  }
}

// ---- Graph links(spec 2026-08-25 方案A §3.3/§6): correlates/relates 提案-确认 SSOT
//
// 图上的 correlates/relates 边只是本表确认后的投影(与 bindings -> binds 边同
// 模式)。triple 唯一(kind+src_key+dst_key+user_id)支撑幂等 upsert; props 为
// JSON 自由属性(白名单裁剪在路由层, 存储层不解释)。

export type GraphLinkStatus = 'proposed' | 'confirmed' | 'rejected';

export interface GraphLinkInput {
  /** 'correlates' | 'relates'(受控词表 tradeSemantics.GRAPH_TRADE_EDGES)。 */
  kind: string;
  srcKind: string;
  srcKey: string;
  srcLabel?: string;
  dstKind: string;
  dstKey: string;
  dstLabel?: string;
  props?: Record<string, unknown>;
  confidence?: number;
  /** 缺省 proposed; 人工作台直建传 confirmed。 */
  status?: 'proposed' | 'confirmed';
  confirmationSource?: string | null;
  createdBy: string;
}

export interface GraphLinkRow {
  id: string;
  kind: string;
  srcKind: string;
  srcKey: string;
  srcLabel: string;
  dstKind: string;
  dstKey: string;
  dstLabel: string;
  props: Record<string, unknown>;
  confidence: number;
  status: GraphLinkStatus;
  confirmationSource: string | null;
  createdBy: string;
  userId: string;
  createdAt: string;
  graphStatus: BindingGraphStatus | null;
}

interface GraphLinkSqliteRow {
  id: string; kind: string; src_kind: string; src_key: string; src_label: string;
  dst_kind: string; dst_key: string; dst_label: string;
  props: string; confidence: number; status: string; confirmation_source: string | null;
  created_by: string; user_id: string; created_at: string; graph_status: string | null;
}

const GRAPH_LINK_COLS = `id, kind, src_kind, src_key, src_label, dst_kind, dst_key, dst_label,
  props, confidence, status, confirmation_source, created_by, user_id, created_at, graph_status`;

function graphLinkFromSqlite(r: GraphLinkSqliteRow): GraphLinkRow {
  let props: Record<string, unknown> = {};
  try { props = JSON.parse(r.props) as Record<string, unknown>; } catch { /* 损坏行按空 props */ }
  return {
    id: r.id, kind: r.kind,
    srcKind: r.src_kind, srcKey: r.src_key, srcLabel: r.src_label,
    dstKind: r.dst_kind, dstKey: r.dst_key, dstLabel: r.dst_label,
    props,
    confidence: r.confidence,
    status: (r.status ?? 'proposed') as GraphLinkStatus,
    confirmationSource: r.confirmation_source ?? null,
    createdBy: r.created_by,
    userId: r.user_id ?? '',
    createdAt: r.created_at,
    graphStatus: parseGraphStatus(r.graph_status),
  };
}

/**
 * 幂等 upsert: 同 triple 复活更新(label/props/confidence/status/confirmation_source/
 * created_by), 返回行 id。人工作台重发与 Agent 重提都收敛到同一行。
 */
export async function saveGraphLink(
  ctx: DbContext, input: GraphLinkInput, userId?: string,
): Promise<string> {
  if (ctx.backend === 'postgres') return saveGraphLinkPg(ctx, input, userId);
  const uid = effectiveUserId(userId);
  const row = ctx.sqlite
    .prepare(
      `INSERT INTO graph_links
         (id, kind, src_kind, src_key, src_label, dst_kind, dst_key, dst_label,
          props, confidence, status, confirmation_source, created_by, user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(kind, src_key, dst_key, user_id) DO UPDATE SET
         src_label = excluded.src_label,
         dst_label = excluded.dst_label,
         props = excluded.props,
         confidence = excluded.confidence,
         status = excluded.status,
         confirmation_source = excluded.confirmation_source,
         created_by = excluded.created_by
       RETURNING id`,
    )
    .get(
      rid('GL'), input.kind, input.srcKind, input.srcKey, input.srcLabel ?? '',
      input.dstKind, input.dstKey, input.dstLabel ?? '',
      JSON.stringify(input.props ?? {}), input.confidence ?? 0,
      input.status ?? 'proposed', input.confirmationSource ?? null,
      input.createdBy, uid,
    ) as { id: string } | undefined;
  if (!row) throw new Error('saveGraphLink: upsert returned no id');
  return row.id;
}

export async function findGraphLinkById(
  ctx: DbContext, id: string, userId?: string,
): Promise<GraphLinkRow | null> {
  if (ctx.backend === 'postgres') return findGraphLinkByIdPg(ctx, id, userId);
  const uid = effectiveUserId(userId);
  const row = (uid
    ? ctx.sqlite
        .prepare(`SELECT ${GRAPH_LINK_COLS} FROM graph_links WHERE id = ? AND (user_id = ? OR user_id = '' OR user_id IS NULL)`)
        .get(id, uid)
    : ctx.sqlite.prepare(`SELECT ${GRAPH_LINK_COLS} FROM graph_links WHERE id = ?`).get(id)) as GraphLinkSqliteRow | undefined;
  return row ? graphLinkFromSqlite(row) : null;
}

export async function findGraphLinkByTriple(
  ctx: DbContext, q: { kind: string; srcKey: string; dstKey: string }, userId?: string,
): Promise<GraphLinkRow | null> {
  if (ctx.backend === 'postgres') return findGraphLinkByTriplePg(ctx, q, userId);
  const uid = effectiveUserId(userId);
  const row = (uid
    ? ctx.sqlite
        .prepare(`SELECT ${GRAPH_LINK_COLS} FROM graph_links WHERE kind = ? AND src_key = ? AND dst_key = ? AND (user_id = ? OR user_id = '' OR user_id IS NULL)`)
        .get(q.kind, q.srcKey, q.dstKey, uid)
    : ctx.sqlite
        .prepare(`SELECT ${GRAPH_LINK_COLS} FROM graph_links WHERE kind = ? AND src_key = ? AND dst_key = ?`)
        .get(q.kind, q.srcKey, q.dstKey)) as GraphLinkSqliteRow | undefined;
  return row ? graphLinkFromSqlite(row) : null;
}

/** 待确认提案(status=proposed), createdAt DESC。 */
export async function listGraphLinkProposals(ctx: DbContext, userId?: string): Promise<GraphLinkRow[]> {
  if (ctx.backend === 'postgres') return listGraphLinkProposalsPg(ctx, userId);
  const uid = effectiveUserId(userId);
  const rows = (uid
    ? ctx.sqlite
        .prepare(`SELECT ${GRAPH_LINK_COLS} FROM graph_links WHERE status = 'proposed' AND (user_id = ? OR user_id = '' OR user_id IS NULL) ORDER BY created_at DESC`)
        .all(uid)
    : ctx.sqlite
        .prepare(`SELECT ${GRAPH_LINK_COLS} FROM graph_links WHERE status = 'proposed' ORDER BY created_at DESC`)
        .all()) as GraphLinkSqliteRow[];
  return rows.map(graphLinkFromSqlite);
}

/** 全状态列表(rejected 含内, 调用方自行过滤), createdAt DESC。 */
export async function listGraphLinks(ctx: DbContext, userId?: string): Promise<GraphLinkRow[]> {
  if (ctx.backend === 'postgres') return listGraphLinksPg(ctx, userId);
  const uid = effectiveUserId(userId);
  const rows = (uid
    ? ctx.sqlite
        .prepare(`SELECT ${GRAPH_LINK_COLS} FROM graph_links WHERE (user_id = ? OR user_id = '' OR user_id IS NULL) ORDER BY created_at DESC`)
        .all(uid)
    : ctx.sqlite.prepare(`SELECT ${GRAPH_LINK_COLS} FROM graph_links ORDER BY created_at DESC`).all()) as GraphLinkSqliteRow[];
  return rows.map(graphLinkFromSqlite);
}

/** 状态机推进(proposed->confirmed|rejected / rejected->confirmed 复活路径)。 */
export async function updateGraphLinkStatus(
  ctx: DbContext, id: string, status: Exclude<GraphLinkStatus, 'proposed'>,
  confirmationSource: 'human' | 'agent', userId?: string,
): Promise<boolean> {
  if (ctx.backend === 'postgres') return updateGraphLinkStatusPg(ctx, id, status, confirmationSource, userId);
  const uid = effectiveUserId(userId);
  const res = (uid
    ? ctx.sqlite
        .prepare("UPDATE graph_links SET status = ?, confirmation_source = ? WHERE id = ? AND (user_id = ? OR user_id = '' OR user_id IS NULL)")
        .run(status, confirmationSource, id, uid)
    : ctx.sqlite
        .prepare('UPDATE graph_links SET status = ?, confirmation_source = ? WHERE id = ?')
        .run(status, confirmationSource, id)) as { changes: number };
  return res.changes > 0;
}

/** props JSON 浅合并(patch 键覆盖同名既有键)。 */
export async function updateGraphLinkProps(
  ctx: DbContext, id: string, patch: Record<string, unknown>, userId?: string,
): Promise<boolean> {
  if (ctx.backend === 'postgres') return updateGraphLinkPropsPg(ctx, id, patch, userId);
  const current = await findGraphLinkById(ctx, id, userId);
  if (!current) return false;
  const merged = { ...current.props, ...patch };
  const uid = effectiveUserId(userId);
  const res = (uid
    ? ctx.sqlite
        .prepare("UPDATE graph_links SET props = ? WHERE id = ? AND (user_id = ? OR user_id = '' OR user_id IS NULL)")
        .run(JSON.stringify(merged), id, uid)
    : ctx.sqlite.prepare('UPDATE graph_links SET props = ? WHERE id = ?').run(JSON.stringify(merged), id)) as { changes: number };
  return res.changes > 0;
}

/** 边同步结果落库(gs=null 清空)。 */
export async function setGraphLinkGraphStatus(
  ctx: DbContext, id: string, gs: BindingGraphStatus | null, userId?: string,
): Promise<void> {
  if (ctx.backend === 'postgres') return setGraphLinkGraphStatusPg(ctx, id, gs, userId);
  const raw = gs ? JSON.stringify(gs) : null;
  const uid = effectiveUserId(userId);
  if (uid) {
    ctx.sqlite
      .prepare("UPDATE graph_links SET graph_status = ? WHERE id = ? AND (user_id = ? OR user_id = '' OR user_id IS NULL)")
      .run(raw, id, uid);
  } else {
    ctx.sqlite.prepare('UPDATE graph_links SET graph_status = ? WHERE id = ?').run(raw, id);
  }
}

// ---- Quotas(spec 2026-08-25 方案A §3.1): 两层额度 SSOT ----------------------
//
// scope=counterparty(对手方授信, owner_key=归一化企业名)或 project(项目限额,
// owner_key=项目码)。used_amount/computed_at 为对账桥物化结果, 只经
// updateQuotaUsed 写入; 图上 granted 边与 Quota 节点只是本表的投影。
// 同一 owner 允许多条额度(不同 period/currency), 故不做 owner 唯一约束。

export type QuotaStatus = 'active' | 'inactive';

export interface QuotaInput {
  /** 'counterparty' | 'project'(受控词表 tradeSemantics.QUOTA_SCOPES, 路由层校验)。 */
  scope: 'counterparty' | 'project';
  ownerKey: string;
  ownerLabel?: string;
  limitAmount: number;
  currency?: string | null;
  period?: string | null;
  createdBy: string;
}

export interface QuotaRow {
  id: string;
  scope: 'counterparty' | 'project';
  ownerKey: string;
  ownerLabel: string;
  limitAmount: number;
  currency: string | null;
  period: string | null;
  usedAmount: number;
  computedAt: string | null;
  status: QuotaStatus;
  createdBy: string;
  userId: string;
  createdAt: string;
}

interface QuotaSqliteRow {
  id: string; scope: string; owner_key: string; owner_label: string;
  limit_amount: number; currency: string | null; period: string | null;
  used_amount: number; computed_at: string | null; status: string;
  created_by: string; user_id: string; created_at: string;
}

const QUOTA_COLS = `id, scope, owner_key, owner_label, limit_amount, currency, period,
  used_amount, computed_at, status, created_by, user_id, created_at`;

function quotaFromSqlite(r: QuotaSqliteRow): QuotaRow {
  return {
    id: r.id,
    scope: r.scope === 'project' ? 'project' : 'counterparty',
    ownerKey: r.owner_key,
    ownerLabel: r.owner_label ?? '',
    limitAmount: r.limit_amount,
    currency: r.currency ?? null,
    period: r.period ?? null,
    usedAmount: r.used_amount ?? 0,
    computedAt: r.computed_at ?? null,
    status: (r.status ?? 'active') as QuotaStatus,
    createdBy: r.created_by,
    userId: r.user_id ?? '',
    createdAt: r.created_at,
  };
}

/** 创建额度(默认 active, used=0)。返回行 id。 */
export async function saveQuota(
  ctx: DbContext, input: QuotaInput, userId?: string,
): Promise<string> {
  if (ctx.backend === 'postgres') return saveQuotaPg(ctx, input, userId);
  const uid = effectiveUserId(userId);
  const id = rid('Q');
  ctx.sqlite
    .prepare(
      `INSERT INTO quotas
         (id, scope, owner_key, owner_label, limit_amount, currency, period, status, created_by, user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
    )
    .run(
      id, input.scope, input.ownerKey, input.ownerLabel ?? '',
      input.limitAmount, input.currency ?? null, input.period ?? null,
      input.createdBy, uid,
    );
  return id;
}

export async function findQuotaById(
  ctx: DbContext, id: string, userId?: string,
): Promise<QuotaRow | null> {
  if (ctx.backend === 'postgres') return findQuotaByIdPg(ctx, id, userId);
  const uid = effectiveUserId(userId);
  const row = (uid
    ? ctx.sqlite
        .prepare(`SELECT ${QUOTA_COLS} FROM quotas WHERE id = ? AND (user_id = ? OR user_id = '' OR user_id IS NULL)`)
        .get(id, uid)
    : ctx.sqlite.prepare(`SELECT ${QUOTA_COLS} FROM quotas WHERE id = ?`).get(id)) as QuotaSqliteRow | undefined;
  return row ? quotaFromSqlite(row) : null;
}

/** 额度列表。默认仅 active; includeInactive=true 时全量。createdAt DESC。 */
export async function listQuotas(
  ctx: DbContext, opts?: { scope?: 'counterparty' | 'project'; userId?: string; includeInactive?: boolean },
): Promise<QuotaRow[]> {
  if (ctx.backend === 'postgres') return listQuotasPg(ctx, opts);
  const uid = effectiveUserId(opts?.userId);
  const scope = opts?.scope;
  const statusFilter = opts?.includeInactive ? '' : "status = 'active'";
  const scopeFilter = scope ? 'scope = ?' : '';
  const userFilter = uid ? "(user_id = ? OR user_id = '' OR user_id IS NULL)" : '';
  const where = [userFilter, scopeFilter, statusFilter].filter(Boolean).join(' AND ').replace(/^/, 'WHERE ');
  const params: unknown[] = [];
  if (uid) params.push(uid);
  if (scope) params.push(scope);
  const rows = ctx.sqlite
    .prepare(`SELECT ${QUOTA_COLS} FROM quotas ${where} ORDER BY created_at DESC`)
    .all(...params) as QuotaSqliteRow[];
  return rows.map(quotaFromSqlite);
}

/** 字段级 patch(limitAmount/currency/period/status); 未命中返回 false。 */
export async function updateQuota(
  ctx: DbContext, id: string,
  patch: { limitAmount?: number; currency?: string | null; period?: string | null; status?: QuotaStatus },
  userId?: string,
): Promise<boolean> {
  if (ctx.backend === 'postgres') return updateQuotaPg(ctx, id, patch, userId);
  const current = await findQuotaById(ctx, id, userId);
  if (!current) return false;
  const limitAmount = patch.limitAmount ?? current.limitAmount;
  const currency = patch.currency !== undefined ? patch.currency : current.currency;
  const period = patch.period !== undefined ? patch.period : current.period;
  const status = patch.status ?? current.status;
  const uid = effectiveUserId(userId);
  const res = (uid
    ? ctx.sqlite
        .prepare("UPDATE quotas SET limit_amount = ?, currency = ?, period = ?, status = ? WHERE id = ? AND (user_id = ? OR user_id = '' OR user_id IS NULL)")
        .run(limitAmount, currency, period, status, id, uid)
    : ctx.sqlite
        .prepare('UPDATE quotas SET limit_amount = ?, currency = ?, period = ?, status = ? WHERE id = ?')
        .run(limitAmount, currency, period, status, id)) as { changes: number };
  return res.changes > 0;
}

/** 对账桥物化结果回写(used + computedAt); 未命中返回 false。 */
export async function updateQuotaUsed(
  ctx: DbContext, id: string, used: number, computedAt: string, userId?: string,
): Promise<boolean> {
  if (ctx.backend === 'postgres') return updateQuotaUsedPg(ctx, id, used, computedAt, userId);
  const uid = effectiveUserId(userId);
  const res = (uid
    ? ctx.sqlite
        .prepare("UPDATE quotas SET used_amount = ?, computed_at = ? WHERE id = ? AND (user_id = ? OR user_id = '' OR user_id IS NULL)")
        .run(used, computedAt, id, uid)
    : ctx.sqlite
        .prepare('UPDATE quotas SET used_amount = ?, computed_at = ? WHERE id = ?')
        .run(used, computedAt, id)) as { changes: number };
  return res.changes > 0;
}

// ---- 模板层仓储(spec 2026-08-26 §3) ----------------------------------------
// 全局本体无 user_id, 与 graph_links 的按 user 隔离刻意不同。

export interface TemplateTypeRow {
  id: string; kind: 'doc_type' | 'contract_type'; name: string;
  parentId: string | null; props: Record<string, unknown>; isActive: boolean;
}
export interface TemplateAnchorWeights { party: number; time: number; amount: number; qty: number }
export interface TemplateEdgeRuleRow {
  id: string; sourceTypeId: string; targetTypeId: string; edgeType: string;
  allowedVocab: string[]; anchorWeights: TemplateAnchorWeights | null;
  isActive: boolean; templateVersion: number;
}

const TEMPLATE_TYPE_COLS = 'id, kind, name, parent_id, props, is_active';
const TEMPLATE_RULE_COLS = 'id, source_type_id, target_type_id, edge_type, allowed_vocab, anchor_weights, is_active, template_version';

function templateTypeFromRow(r: Record<string, unknown>): TemplateTypeRow {
  let props: Record<string, unknown> = {};
  try { props = JSON.parse(String(r.props ?? '{}')) as Record<string, unknown>; } catch { /* 损坏按空 */ }
  return {
    id: String(r.id), kind: (r.kind === 'contract_type' ? 'contract_type' : 'doc_type'),
    name: String(r.name), parentId: r.parent_id ? String(r.parent_id) : null,
    props, isActive: Number(r.is_active) === 1,
  };
}

function templateRuleFromRow(r: Record<string, unknown>): TemplateEdgeRuleRow {
  let allowedVocab: string[] = [];
  try { allowedVocab = JSON.parse(String(r.allowed_vocab ?? '[]')) as string[]; } catch { /* 损坏按空 */ }
  let anchorWeights: TemplateAnchorWeights | null = null;
  if (r.anchor_weights) {
    try { anchorWeights = JSON.parse(String(r.anchor_weights)) as TemplateAnchorWeights; } catch { /* 忽略 */ }
  }
  return {
    id: String(r.id), sourceTypeId: String(r.source_type_id),
    targetTypeId: String(r.target_type_id ?? ''), edgeType: String(r.edge_type),
    allowedVocab, anchorWeights, isActive: Number(r.is_active) === 1,
    templateVersion: Number(r.template_version ?? 1),
  };
}

export async function listTemplateTypes(ctx: DbContext): Promise<TemplateTypeRow[]> {
  if (ctx.backend === 'postgres') return listTemplateTypesPg(ctx);
  const rows = ctx.sqlite.prepare(`SELECT ${TEMPLATE_TYPE_COLS} FROM template_types ORDER BY kind, name`).all() as Record<string, unknown>[];
  return rows.map(templateTypeFromRow);
}

export async function listActiveEdgeRules(ctx: DbContext): Promise<TemplateEdgeRuleRow[]> {
  if (ctx.backend === 'postgres') return listActiveEdgeRulesPg(ctx);
  const rows = ctx.sqlite.prepare(
    `SELECT ${TEMPLATE_RULE_COLS} FROM template_edge_rules WHERE is_active = 1`,
  ).all() as Record<string, unknown>[];
  return rows.map(templateRuleFromRow);
}

export async function ensureTemplateType(
  ctx: DbContext, input: { id: string; kind: string; name: string; parentId?: string | null; props?: Record<string, unknown> },
): Promise<void> {
  if (ctx.backend === 'postgres') return ensureTemplateTypePg(ctx, input);
  ctx.sqlite.prepare(
    `INSERT INTO template_types (id, kind, name, parent_id, props) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET parent_id = excluded.parent_id, props = excluded.props
     -- P4 managed-wins(种子冲突策略): managed_at 非空=已管理行, boot seed 跳过覆写。
     WHERE template_types.managed_at IS NULL`,
  ).run(input.id, input.kind, input.name, input.parentId ?? null, JSON.stringify(input.props ?? {}));
}

export async function ensureEdgeRule(
  ctx: DbContext, input: { id: string; sourceTypeId: string; targetTypeId?: string; edgeType: string; allowedVocab: string[]; isActive?: boolean; anchorWeights?: TemplateAnchorWeights | null },
): Promise<void> {
  if (ctx.backend === 'postgres') return ensureEdgeRulePg(ctx, input);
  ctx.sqlite.prepare(
    `INSERT INTO template_edge_rules (id, source_type_id, target_type_id, edge_type, allowed_vocab, is_active, anchor_weights)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       target_type_id = excluded.target_type_id,
       allowed_vocab = excluded.allowed_vocab,
       is_active = excluded.is_active,
       -- anchor_weights 覆写防护(小修 3): seed/幂等重跑不带权重(传入 NULL)时保留
       -- 既有值(manage_template 设的权重不被 boot 重跑抹掉); 显式传值照常覆写。
       anchor_weights = COALESCE(excluded.anchor_weights, template_edge_rules.anchor_weights)
     -- P4 managed-wins(种子冲突策略): 已管理行整行冻结(anchor_weights 一并不触碰,
     -- 权重的显式写入走 manage 入口)。
     WHERE template_edge_rules.managed_at IS NULL`,
  ).run(input.id, input.sourceTypeId, input.targetTypeId ?? '', input.edgeType,
    JSON.stringify(input.allowedVocab), input.isActive === false ? 0 : 1,
    input.anchorWeights ? JSON.stringify(input.anchorWeights) : null);
}

/**
 * 模板版本审计(spec §3.3/§5): 每次管理性变更递增一个版本号。
 * 单列自增无并发竞争面(管理操作低频且前台单实例 Hono), 不做事务锁。
 */
export async function bumpTemplateVersion(
  ctx: DbContext, input: { changedBy: string; changeSummary: string },
): Promise<number> {
  if (ctx.backend === 'postgres') return bumpTemplateVersionPg(ctx, input);
  const cur = ctx.sqlite.prepare('SELECT MAX(version) AS v FROM template_versions').get() as { v: number | null };
  const next = (cur.v ?? 0) + 1;
  ctx.sqlite.prepare(
    'INSERT INTO template_versions (version, changed_by, change_summary) VALUES (?, ?, ?)',
  ).run(next, input.changedBy, input.changeSummary);
  return next;
}

// ---- 模板管理 REST 读/存储面(Task 3 /api/templates) --------------------------

/** 全量边规则行(GET /api/templates/rules): 含登记不启用(is_active=0)行, 幂等种子与管理视图共用读面。 */
export async function listAllEdgeRules(ctx: DbContext): Promise<TemplateEdgeRuleRow[]> {
  if (ctx.backend === 'postgres') return listAllEdgeRulesPg(ctx);
  const rows = ctx.sqlite.prepare(
    `SELECT ${TEMPLATE_RULE_COLS} FROM template_edge_rules ORDER BY id`,
  ).all() as Record<string, unknown>[];
  return rows.map(templateRuleFromRow);
}

/** 类型行 + 管理戳(managed_at/managed_by), GET /api/templates/types 的"含 managed 元数据"读面。 */
export interface TemplateTypeManageMeta { managedAt: string | null; managedBy: string | null }

export async function listTemplateTypesManaged(
  ctx: DbContext,
): Promise<Array<TemplateTypeRow & TemplateTypeManageMeta>> {
  if (ctx.backend === 'postgres') return listTemplateTypesManagedPg(ctx);
  const rows = ctx.sqlite.prepare(
    `SELECT ${TEMPLATE_TYPE_COLS}, managed_at, managed_by FROM template_types ORDER BY kind, name`,
  ).all() as Record<string, unknown>[];
  return rows.map((r) => ({
    ...templateTypeFromRow(r),
    managedAt: r.managed_at == null ? null : String(r.managed_at),
    managedBy: r.managed_by == null ? null : String(r.managed_by),
  }));
}

/**
 * 新建边规则(POST /api/templates/rules 存储面, Task 3): 登记先行(spec §3.2),
 * 允许悬空 source/target 引用; 创建即打管理戳(managed-wins => boot seed 不再覆写)。
 * 版本审计由调用方经 bumpTemplateVersion 记账(changeSummary `rule.create <id>`)。
 */
export async function insertTemplateEdgeRule(
  ctx: DbContext, input: { id: string; sourceTypeId: string; targetTypeId?: string; edgeType: string; allowedVocab: string[]; isActive?: boolean; managedBy: string },
): Promise<void> {
  if (ctx.backend === 'postgres') return insertTemplateEdgeRulePg(ctx, input);
  ctx.sqlite.prepare(
    `INSERT INTO template_edge_rules
       (id, source_type_id, target_type_id, edge_type, allowed_vocab, is_active, anchor_weights, managed_at, managed_by)
     VALUES (?, ?, ?, ?, ?, ?, NULL, datetime('now'), ?)`,
  ).run(input.id, input.sourceTypeId, input.targetTypeId ?? '', input.edgeType,
    JSON.stringify(input.allowedVocab), input.isActive === false ? 0 : 1, input.managedBy);
}

/** 存量数据幂等迁移(spec §3.1): 提单/装箱单并入货转单(别名)。重复执行无副作用。 */
export async function migrateDocTypeAliases(ctx: DbContext): Promise<number> {
  if (ctx.backend === 'postgres') return migrateDocTypeAliasesPg(ctx);
  const aliasMap: Array<[string, string]> = [['提单', '货转单'], ['装箱单', '货转单']];
  let total = 0;
  for (const [from, to] of aliasMap) {
    for (const tbl of ['documents', 'extractions', 'classifications']) {
      const res = ctx.sqlite.prepare(`UPDATE ${tbl} SET doc_type = ? WHERE doc_type = ?`).run(to, from);
      total += res.changes;
    }
  }
  return total;
}
