// DISK-GATED PREP (Postgres + pgvector migration). ADDITIVE ONLY: this file is
// NOT imported by the runtime, which stays on SQLite (db/client.ts). It declares
// the TARGET Postgres schema (Drizzle pg-core) so `npx drizzle-kit generate`
// can produce a migration once disk is cleared and Postgres is provisioned. See
// docs/postgres-migration-runbook.md.
//
// The first four tables (documents / extractions / bindings / doc_chunk) MIRROR
// the SQLite schema in db/schema.ts + the raw DDL in db/client.ts, column-for-
// column. doc_chunk here additionally carries the §7 vector + FTS columns. The
// §7 inter-document relation / contract-ledger tables (document_relation /
// doc_contract) that previously lived here were REMOVED in Phase 4 — they were
// dead code (no repo fn wrote them) and are superseded by the Neo4j graph
// layer (graph/repo.ts + graph/tools.ts).
//
// DEPENDENCY NOTE: drizzle-orm/pg-core ships with drizzle-orm (no new install).
// The pgvector `vector` type is declared via a customType below instead of
// pulling in `drizzle-orm/vector`, so this file adds ZERO new npm deps. The
// HNSW index and the GENERATED tsvector + GIN index cannot be expressed in
// Drizzle's column DSL, so they are emitted as raw SQL in the migration (the
// runbook documents this; a hand-edited SQL file is layered on top of
// `drizzle-kit generate` output).

import {
  pgTable,
  text,
  timestamp,
  numeric,
  integer,
  boolean,
  jsonb,
  serial,
  index,
  uniqueIndex,
  customType,
  doublePrecision,
  primaryKey,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

// ---- pgvector + tsvector column types (no new deps) ------------------------

/**
 * pgvector column. Mirrors `drizzle-orm/vector`'s `vector()` but avoids adding
 * the optional dep. Emits raw `vector(dim)` DDL. `data` is a string (pgvector's
 * text-like literal form, e.g. '[0.1,0.2,...]'); binding/decoding is handled at
 * the repository layer when the postgres backend lands.
 */
export const vector = customType<{
  data: string;
  config: { dim: number };
}>({
  dataType(config) {
    const dim = config?.dim ?? 1024;
    return `vector(${dim})`;
  },
});

/** Postgres tsvector column for full-text search (GIN-indexed; see runbook). */
export const tsvector = customType<{ data: string }>({
  dataType() {
    return 'tsvector';
  },
});

/**
 * Default timestamp column: timestamptz, defaults to now(), non-null.
 *
 * The explicit column name `created_at` (snake_case) is required: without it
 * Drizzle emits the JS property name `createdAt` as the column name, which
 * diverged from the raw SQL in postgres-repositories.ts and the SQLite schema
 * (both `created_at`) and broke `ORDER BY created_at` on Postgres. The JS
 * property stays `createdAt`; only the physical column name is pinned.
 */
const nowTs = () => timestamp('created_at', { withTimezone: true }).defaultNow().notNull();

// ---- Mirror of the SQLite pipeline schema (db/schema.ts) -------------------

/** documents: one ingested source file's BlockModel. Mirrors SQLite documents. */
export const documents = pgTable(
  'documents',
  {
    id: text('id').primaryKey(),
    docType: text('doc_type').notNull(),
    modality: text('modality').notNull(),
    sourceUri: text('source_uri').notNull(),
    // SQLite stores this as TEXT(JSON); Postgres uses JSONB for structured query.
    blockModel: jsonb('block_model').notNull(),
    /** MinIO object key for uploads (null for tool-ingested / legacy docs). */
    minioKey: text('minio_key'),
    // Phase 2 business-data isolation: owning user ('' = legacy / unscoped).
    userId: text('user_id').notNull().default(''),
    createdAt: nowTs(),
    reviewStatus: text('review_status').notNull().default('pending'),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
    reviewedBy: text('reviewed_by'),
    // Lane A (2a): auto-extraction lifecycle status. NULL = 'pending' (opt-in).
    extractionStatus: text('extraction_status'),
    // Model B parse lifecycle: 'uploaded' stub -> 'parsing' -> 'parsed' |
    // 'needs_ocr' | 'failed'. Decouples upload (storage-only) from parsing.
    parseStatus: text('parse_status').notNull().default('uploaded'),
  },
  (t) => ({
    userIdx: index('idx_documents_user').on(t.userId),
  }),
);

/** extractions: grounded field extractions off a document. Mirrors SQLite extractions. */
export const extractions = pgTable(
  'extractions',
  {
    id: text('id').primaryKey(),
    documentId: text('document_id')
      .notNull()
      .references(() => documents.id),
    docType: text('doc_type').notNull(),
    fields: jsonb('fields').notNull(),
    fieldMeta: jsonb('field_meta').notNull(),
    // SQLite REAL -> Postgres numeric (avoids float64 precision drift on confidence).
    overallConfidence: numeric('overall_confidence', { precision: 5, scale: 4 }).notNull(),
    needsReview: boolean('needs_review').notNull().default(false),
    proposedRelationships: jsonb('proposed_relationships'),
    userId: text('user_id').notNull().default(''),
    createdAt: nowTs(),
  },
  (t) => ({
    docIdx: index('idx_extractions_doc').on(t.documentId),
    userIdx: index('idx_extractions_user').on(t.userId),
  }),
);

/** bindings: document -> contract bindings. Mirrors SQLite bindings. */
export const bindings = pgTable(
  'bindings',
  {
    id: text('id').primaryKey(),
    documentId: text('document_id')
      .notNull()
      .references(() => documents.id),
    contractNo: text('contract_no').notNull(),
    relation: text('relation').notNull(),
    sourceRefs: jsonb('source_refs').notNull(),
    confidence: numeric('confidence', { precision: 5, scale: 4 }).notNull(),
    createdBy: text('created_by').notNull(),
    userId: text('user_id').notNull().default(''),
    createdAt: nowTs(),
    // Phase B bindings state machine (mirror of the SQLite schema.ts columns).
    status: text('status').notNull().default('confirmed'),
    confirmationSource: text('confirmation_source'),
    proposedBy: text('proposed_by'),
    evidence: jsonb('evidence'),
    // 工作台确认后图谱同步结果: text 存 JSON 字符串, 与 SQLite 一致。
    graphStatus: text('graph_status'),
    // 绑定目标类型标记('Contract' | 'Project'): 立项书 binds->Project 泛化。
    targetKind: text('target_kind').notNull().default('Contract'),
  },
  (t) => ({
    contractIdx: index('idx_bindings_contract').on(t.contractNo),
    userIdx: index('idx_bindings_user').on(t.userId),
  }),
);

// ---- doc_chunk: §7 chunk index with pgvector + FTS -------------------------

/**
 * doc_chunk: chunked document text for L4 recall. Mirrors the SQLite doc_chunk
 * (id / document_id / chunk_text / chunk_index / created_at) and adds the §7
 * recall columns: a 1024-dim pgvector embedding (bge-m3 dim, matches sqlite-vec)
 * and a tsvector for Postgres full-text search (replaces SQLite FTS5).
 *
 * HNSW index (added as raw SQL in the migration, Drizzle can't express pgvector
 * index ops): CREATE INDEX ... ON doc_chunk USING hnsw (embedding vector_cosine_ops);
 * FTS index: CREATE INDEX ... ON doc_chunk USING gin (fts_vector); and a
 * GENERATED column fts_vector tsvector GENERATED ALWAYS AS
 * (to_tsvector('simple', chunk_text)) STORED.
 */
export const docChunk = pgTable(
  'doc_chunk',
  {
    id: serial('id').primaryKey(),
    documentId: text('document_id')
      .notNull()
      .references(() => documents.id),
    chunkText: text('chunk_text').notNull(),
    chunkIndex: integer('chunk_index'),
    // 1024-dim to match bge-m3 / the sqlite-vec table (Task 6 v2).
    embedding: vector('embedding', { dim: 1024 }),
    // Populated via a GENERATED column + GIN index; declared here so the Drizzle
    // table object is column-complete for typed repository work. The expression
    // applies CJK unigram preprocessing (space after every char not in
    // [0-9A-Za-z ]) so to_tsvector('simple', ...) lexes Chinese runs as separate
    // unigrams instead of one opaque lexeme -- must stay in sync with
    // toPgFtsQuery() in postgres-repositories.ts and the migratePostgres() DDL
    // in client.ts (the startup migration is the DDL truth for live DBs; this
    // declaration only drives fresh drizzle-kit migrations).
    ftsVector: tsvector('fts_vector').generatedAlwaysAs(
      sql`to_tsvector('simple', regexp_replace(chunk_text, '([^0-9A-Za-z ])', '\\1 ', 'g'))`,
    ),
    // Lane B: per-chunk semantic tags (JSON string[] | NULL).
    tags: jsonb('tags'),
    createdAt: nowTs(),
  },
  (t) => ({
    docIdx: index('idx_doc_chunk_doc').on(t.documentId),
  }),
);

// ---- File manager (Phase 3+) ------------------------------------------------
//
// Virtual folders owned per-user. Mirrors the SQLite file_folders table. Files
// themselves live in MinIO (keyed users/<userId>/...); this table only records
// the user's folder entries so the file manager can render an empty folder even
// before any file is moved into it.

/** file_folders: virtual folder tree for the file manager. Mirrors SQLite file_folders. */
export const fileFolders = pgTable(
  'file_folders',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').notNull(),
    path: text('path').notNull(),
    // 拖拽排序的持久化顺序；NULL = 从未手动排序，排在已排序行之后。
    sortOrder: integer('sort_order'),
    createdAt: nowTs(),
  },
  (t) => ({
    userIdx: index('idx_file_folders_user').on(t.userId),
  }),
);

/**
 * file_sort_orders: manual drag-order ranks for file objects, keyed by MinIO
 * object key per user. Mirrors SQLite file_sort_orders. Ranks are lost on
 * move/rename (the key changes) and orphaned rows are harmless read noise.
 */
export const fileSortOrders = pgTable('file_sort_orders', {
  userId: text('user_id').notNull(),
  objKey: text('obj_key').notNull(),
  sortOrder: integer('sort_order').notNull().default(0),
}, (t) => ({
  pk: primaryKey({ columns: [t.userId, t.objKey] }),
}));

/**
 * self_parties: 自主体名单 DB 侧(与 env.SELF_PARTY_NAMES 并集)。Mirrors SQLite
 * self_parties; name 为原始名(PK), created_by 审计, created_at timestamptz。
 * 租户全局(无 user_id), 归一化去重由应用层 addSelfParty 判定。
 */
export const selfParties = pgTable('self_parties', {
  name: text('name').primaryKey(),
  createdBy: text('created_by').notNull(),
  createdAt: nowTs(),
});

/**
 * execution_flows: 六向执行流水('资金流' | '货物流' | '发票流' x 'in' | 'out')。
 * Mirrors SQLite execution_flows. amount/quantity_ton 用 double precision(对应
 * SQLite REAL); confidence 沿用 numeric(5,4) pg 惯例(与 bindings/extractions 一致);
 * created_at timestamptz。UNIQUE(binding_id, user_id) 支撑 ON CONFLICT upsert。
 */
export const executionFlows = pgTable(
  'execution_flows',
  {
    id: text('id').primaryKey(),
    bindingId: text('binding_id').notNull(),
    documentId: text('document_id').notNull(),
    contractNo: text('contract_no').notNull(),
    flowType: text('flow_type').notNull(),
    direction: text('direction').notNull(),
    amount: doublePrecision('amount'),
    quantityTon: doublePrecision('quantity_ton'),
    unit: text('unit'),
    quantityValue: doublePrecision('quantity_value'),
    quantityDimension: text('quantity_dimension'),
    quantityCanonical: doublePrecision('quantity_canonical'),
    docType: text('doc_type').notNull(),
    voucherDate: text('voucher_date'),
    extractionId: text('extraction_id'),
    confidence: numeric('confidence', { precision: 5, scale: 4 }).notNull().default(sql`0`),
    createdBy: text('created_by').notNull(),
    userId: text('user_id'),
    createdAt: nowTs(),
  },
  (t) => ({
    bindingIdx: uniqueIndex('idx_execution_flows_binding').on(t.bindingId, t.userId),
    contractIdx: index('idx_execution_flows_contract').on(t.contractNo, t.userId),
  }),
);

/**
 * graph_links(spec 2026-08-25 方案A §3.3/§6): correlates(背靠背购销对应)与
 * relates(项目级关联)的提案-确认 SSOT。Mirrors SQLite graph_links 列对列;
 * props/graph_status 为 TEXT(JSON 字符串), 与本文件 JSON-in-TEXT 惯例一致。
 */
export const graphLinks = pgTable(
  'graph_links',
  {
    id: text('id').primaryKey(),
    kind: text('kind').notNull(),
    srcKind: text('src_kind').notNull(),
    srcKey: text('src_key').notNull(),
    srcLabel: text('src_label').notNull().default(''),
    dstKind: text('dst_kind').notNull(),
    dstKey: text('dst_key').notNull(),
    dstLabel: text('dst_label').notNull().default(''),
    props: text('props').notNull().default('{}'),
    confidence: numeric('confidence', { precision: 5, scale: 4 }).notNull().default(sql`0`),
    status: text('status').notNull().default('proposed'),
    confirmationSource: text('confirmation_source'),
    createdBy: text('created_by').notNull(),
    userId: text('user_id').notNull().default(''),
    createdAt: nowTs(),
    graphStatus: text('graph_status'),
  },
  (t) => ({
    tripleIdx: uniqueIndex('idx_graph_links_triple').on(t.kind, t.srcKey, t.dstKey, t.userId),
    userIdx: index('idx_graph_links_user').on(t.userId),
    srcIdx: index('idx_graph_links_src').on(t.srcKind, t.srcKey),
  }),
);

/**
 * quotas(spec 2026-08-25 方案A §3.1 Quota): 两层额度 SSOT。Mirrors SQLite
 * quotas 列对列; limit/used 用 double precision(与 execution_flows.amount 惯例
 * 一致, 避免 numeric 读回字符串)。
 */
export const quotas = pgTable(
  'quotas',
  {
    id: text('id').primaryKey(),
    scope: text('scope').notNull(),
    ownerKey: text('owner_key').notNull(),
    ownerLabel: text('owner_label').notNull().default(''),
    limitAmount: doublePrecision('limit_amount').notNull(),
    currency: text('currency'),
    period: text('period'),
    usedAmount: doublePrecision('used_amount').notNull().default(0),
    computedAt: text('computed_at'),
    status: text('status').notNull().default('active'),
    createdBy: text('created_by').notNull(),
    userId: text('user_id').notNull().default(''),
    createdAt: nowTs(),
  },
  (t) => ({
    ownerIdx: index('idx_quotas_owner').on(t.scope, t.ownerKey, t.userId),
    userIdx: index('idx_quotas_user').on(t.userId),
  }),
);

/**
 * 模板三表(spec 2026-08-26 §3): 模板层 SSOT, 全局本体无 user_id。Mirrors SQLite
 * schema.ts 列对列; TEXT(JSON) 与 SQLite 对齐(本文件 JSON-in-TEXT 惯例)。
 * target_type_id='' 通配任意合同类型。
 */
export const templateTypes = pgTable(
  'template_types',
  {
    id: text('id').primaryKey(),
    kind: text('kind').notNull(),
    name: text('name').notNull(),
    parentId: text('parent_id'),
    props: text('props').notNull().default('{}'),
    isActive: integer('is_active').notNull().default(1),
    // P4 managed-wins: NULL=纯种子行(boot seed 可覆写); 非空=DB 状态优先。
    managedAt: timestamp('managed_at', { withTimezone: true }),
    managedBy: text('managed_by'),
    createdAt: text('created_at').notNull().default(sql`now()`),
    updatedAt: text('updated_at').notNull().default(sql`now()`),
  },
  (t) => [
    uniqueIndex('template_types_kind_name_uq').on(t.kind, t.name),
    index('template_types_parent').on(t.parentId),
  ],
);

export const templateEdgeRules = pgTable(
  'template_edge_rules',
  {
    id: text('id').primaryKey(),
    sourceTypeId: text('source_type_id').notNull(),
    targetTypeId: text('target_type_id').notNull().default(''),
    edgeType: text('edge_type').notNull(),
    allowedVocab: text('allowed_vocab').notNull().default('[]'),
    anchorWeights: text('anchor_weights'),
    isActive: integer('is_active').notNull().default(1),
    templateVersion: integer('template_version').notNull().default(1),
    // P4 managed-wins: 同 template_types, NULL=纯种子行。
    managedAt: timestamp('managed_at', { withTimezone: true }),
    managedBy: text('managed_by'),
    createdAt: text('created_at').notNull().default(sql`now()`),
  },
  (t) => [
    index('template_edge_rules_src').on(t.sourceTypeId, t.edgeType),
  ],
);

export const templateVersions = pgTable('template_versions', {
  version: integer('version').primaryKey(),
  changedBy: text('changed_by').notNull(),
  changeSummary: text('change_summary').notNull(),
  changedAt: text('changed_at').notNull().default(sql`now()`),
});

// ---- Harness session store (sessions/messages/approvals/events/favorites) ---
//
// MIRRORS the runtime idempotent DDL in src/harness/sessionStorePostgres.ts
// (ensureSessionTables) and the SQLite DDL in src/harness/sessionStoreSqlite.ts,
// column-for-column. That runtime DDL is the truth for live DBs (it runs on
// first use); these Drizzle declarations exist so `npx drizzle-kit generate`
// users get the same five tables. Any column change must touch BOTH files.
//
// Deliberate parity choices (vs. typical pg conventions) -- see
// sessionStorePostgres.ts for the rationale:
//   - timestamps are TEXT ISO-8601 strings, not timestamptz;
//   - JSON payloads are TEXT strings, not jsonb;
//   - seq is INTEGER (small per-session counters, no bigint needed).
// No table here collides with Better Auth's `session` table (auth-schema.ts) --
// that one is singular, these are plural/prefixed.

/** sessions: one chat conversation (harness agent session). */
export const agentSessions = pgTable('sessions', {
  id: text('id').primaryKey(),
  role: text('role').notNull(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  metadataJson: text('metadata_json'),
  userId: text('user_id'),
  status: text('status').notNull().default('idle'),
  runId: text('run_id'),
  currentRunStartedAt: text('current_run_started_at'),
});

/** session_messages: persisted UIMessage history (JSON in TEXT). */
export const sessionMessages = pgTable(
  'session_messages',
  {
    sessionId: text('session_id')
      .notNull()
      .references(() => agentSessions.id),
    seq: integer('seq').notNull(),
    modelMessageJson: text('model_message_json').notNull(),
  },
  (t) => [primaryKey({ columns: [t.sessionId, t.seq] })],
);

/** pending_approvals: L2/L3 approval tickets awaiting external callback. */
export const pendingApprovals = pgTable('pending_approvals', {
  id: text('id').primaryKey(),
  sessionId: text('session_id')
    .notNull()
    .references(() => agentSessions.id),
  level: text('level').notNull(),
  toolName: text('tool_name').notNull(),
  toolCallId: text('tool_call_id'),
  inputJson: text('input_json').notNull(),
  ticketId: text('ticket_id'),
  approvalId: text('approval_id'),
  status: text('status').notNull(),
  createdAt: text('created_at').notNull(),
});

/**
 * session_events: SSE reconnect replay buffer. Deliberately NO FK on
 * session_id (parity with both runtime DDLs): the buffer accepts writes for
 * sessions without a backing row (tests, degraded modes).
 */
export const sessionEvents = pgTable(
  'session_events',
  {
    sessionId: text('session_id').notNull(),
    seq: integer('seq').notNull(),
    type: text('type').notNull(),
    payloadJson: text('payload_json').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.sessionId, t.seq] })],
);

/** session_favorites: per-user session favorites with feedback note. */
export const sessionFavorites = pgTable(
  'session_favorites',
  {
    sessionId: text('session_id')
      .notNull()
      .references(() => agentSessions.id),
    userId: text('user_id').notNull(),
    userEmail: text('user_email'),
    note: text('note'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.sessionId, t.userId] })],
);
