import { sqliteTable, text, real, integer, index, uniqueIndex } from 'drizzle-orm/sqlite-core';
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
    /** 确认动作审计列(spec 2026-09-04 §7.5): 'manual' | 'auto-release' | null。 */
    reviewAction: text('review_action'),
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
    /** 绑定目标类型标记('Contract' | 'Project'): 立项书 binds->Project 泛化。 */
    targetKind: text('target_kind').notNull().default('Contract'),
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

/**
 * 自主体名单(Task A): 与 env.SELF_PARTY_NAMES 并集的 DB 侧名单。name 为原始名
 * (raw, PK); 应用层按 normalizeCompanyName 归一化去重。租户全局 —— 与 env 变
 * 量同域, 物化不按 user 分区, 故无 user_id 列; created_by 仅审计。
 */
export const selfParties = sqliteTable('self_parties', {
  name: text('name').primaryKey(),
  createdBy: text('created_by').notNull(),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
});

/**
 * 执行流水(execution_flows): 合同绑定确认后物化的六向流水明细
 * ('资金流' | '货物流' | '发票流' x 'in' | 'out')。flow_type 词汇由消费层定义,
 * 存储层只存字符串。唯一键 (binding_id, user_id): 同一绑定重复物化走 upsert
 * 就地更新, 不产生重复行(与 contract_ledger 同款幂等语义)。user_id 可空,
 * 存储层写侧统一经 effectiveUserId 归一化为 ''。
 */
export const executionFlows = sqliteTable(
  'execution_flows',
  {
    id: text('id').primaryKey(),
    bindingId: text('binding_id').notNull(),
    documentId: text('document_id').notNull(),
    contractNo: text('contract_no').notNull(),
    flowType: text('flow_type').notNull(),
    direction: text('direction').notNull(),
    amount: real('amount'),
    quantityTon: real('quantity_ton'),
    /** 数量单位('吨'等), 与 quantity_ton 同源; 裸 '数量' 字段不带单位语义时为 NULL。 */
    unit: text('unit'),
    docType: text('doc_type').notNull(),
    voucherDate: text('voucher_date'),
    /** 溯源: 物化时读到的抽取行 id, 修正重建后指向新行(防漂移审计线索)。 */
    extractionId: text('extraction_id'),
    confidence: real('confidence').notNull().default(0),
    createdBy: text('created_by').notNull(),
    userId: text('user_id'),
    createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
  },
  (t) => ({
    bindingIdx: uniqueIndex('idx_execution_flows_binding').on(t.bindingId, t.userId),
    contractIdx: index('idx_execution_flows_contract').on(t.contractNo, t.userId),
  }),
);

/**
 * 结算台账(settlement_records, spec 2026-08-27 §15): LLM 依据合同条款+数量/质量
 * 凭证计算结算, L2 人工确认后落账的金额锚点。adjustments/basis_* 为 JSON 文本
 * (奖罚明细/流水与抽取行溯源), 与本文件 JSON-in-TEXT 惯例一致。
 */
export const settlementRecords = sqliteTable(
  'settlement_records',
  {
    id: text('id').primaryKey(),
    contractNo: text('contract_no').notNull(),
    contractLedgerId: text('contract_ledger_id'),
    settledQuantity: real('settled_quantity').notNull(),
    quantityUnit: text('quantity_unit'),
    basePrice: real('base_price'),
    currency: text('currency'),
    totalAmount: real('total_amount').notNull(),
    adjustments: text('adjustments').notNull().default('[]'), // JSON [{label, amount}]
    basisFlowIds: text('basis_flow_ids').notNull().default('[]'), // JSON string[]
    basisExtractionIds: text('basis_extraction_ids').notNull().default('[]'), // JSON string[]
    notes: text('notes'),
    status: text('status').notNull().default('confirmed'),
    confirmedBy: text('confirmed_by'),
    createdBy: text('created_by').notNull(),
    userId: text('user_id'),
    createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
  },
  (t) => ({
    contractIdx: index('idx_settlement_records_contract').on(t.contractNo, t.userId),
  }),
);

/**
 * Graph links(spec 2026-08-25 方案A §3.3/§6): correlates(背靠背购销对应)与
 * relates(项目级关联)的提案-确认 SSOT。图上的边只是确认后的投影。triple 唯一
 * (kind+src_key+dst_key+user_id)支撑幂等 upsert; props 为 JSON 自由属性。
 */
export const graphLinks = sqliteTable(
  'graph_links',
  {
    id: text('id').primaryKey(),
    /** 'correlates' | 'relates'(受控词表 domain/tradeSemantics.GRAPH_TRADE_EDGES)。 */
    kind: text('kind').notNull(),
    srcKind: text('src_kind').notNull(),
    srcKey: text('src_key').notNull(),
    srcLabel: text('src_label').notNull().default(''),
    dstKind: text('dst_kind').notNull(),
    dstKey: text('dst_key').notNull(),
    dstLabel: text('dst_label').notNull().default(''),
    props: text('props').notNull().default('{}'), // JSON
    confidence: real('confidence').notNull().default(0),
    status: text('status').notNull().default('proposed'),
    confirmationSource: text('confirmation_source'),
    createdBy: text('created_by').notNull(),
    userId: text('user_id').notNull().default(''),
    createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
    graphStatus: text('graph_status'), // JSON(BindingGraphStatus)
  },
  (t) => ({
    tripleIdx: uniqueIndex('idx_graph_links_triple').on(t.kind, t.srcKey, t.dstKey, t.userId),
    userIdx: index('idx_graph_links_user').on(t.userId),
    srcIdx: index('idx_graph_links_src').on(t.srcKind, t.srcKey),
  }),
);

/**
 * Quotas(spec 2026-08-25 方案A §3.1 Quota): 两层额度 SSOT——scope=counterparty
 * (对手方授信)或 project(项目限额)。used_amount/computed_at 为对账桥物化结果。
 */
export const quotas = sqliteTable(
  'quotas',
  {
    id: text('id').primaryKey(),
    /** 'counterparty' | 'project'(受控词表 domain/tradeSemantics.QUOTA_SCOPES)。 */
    scope: text('scope').notNull(),
    ownerKey: text('owner_key').notNull(),
    ownerLabel: text('owner_label').notNull().default(''),
    limitAmount: real('limit_amount').notNull(),
    currency: text('currency'),
    period: text('period'),
    usedAmount: real('used_amount').notNull().default(0),
    computedAt: text('computed_at'),
    status: text('status').notNull().default('active'),
    createdBy: text('created_by').notNull(),
    userId: text('user_id').notNull().default(''),
    createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
  },
  (t) => ({
    ownerIdx: index('idx_quotas_owner').on(t.scope, t.ownerKey, t.userId),
    userIdx: index('idx_quotas_user').on(t.userId),
  }),
);

/** 模板类型注册表(spec 2026-08-26 §3.1): 全局本体, 无 user_id。 */
export const templateTypes = sqliteTable('template_types', {
  id: text('id').primaryKey(),
  kind: text('kind').notNull(),
  name: text('name').notNull(),
  parentId: text('parent_id'),
  props: text('props').notNull().default('{}'),
  isActive: integer('is_active').notNull().default(1),
  // P4 managed-wins: NULL=纯种子行(boot seed 可覆写); 非空=DB 状态优先。
  managedAt: text('managed_at'),
  managedBy: text('managed_by'),
  createdAt: text('created_at').notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
  updatedAt: text('updated_at').notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
}, (t) => [
  uniqueIndex('template_types_kind_name_uq').on(t.kind, t.name),
  index('template_types_parent').on(t.parentId),
]);

/** 模板边规则(spec 2026-08-26 §3.2): target_type_id='' 通配任意合同类型。 */
export const templateEdgeRules = sqliteTable('template_edge_rules', {
  id: text('id').primaryKey(),
  sourceTypeId: text('source_type_id').notNull(),
  targetTypeId: text('target_type_id').notNull().default(''),
  edgeType: text('edge_type').notNull(),
  allowedVocab: text('allowed_vocab').notNull().default('[]'),
  anchorWeights: text('anchor_weights'),
  isActive: integer('is_active').notNull().default(1),
  templateVersion: integer('template_version').notNull().default(1),
  // P4 managed-wins: 同 template_types, NULL=纯种子行。
  managedAt: text('managed_at'),
  managedBy: text('managed_by'),
  createdAt: text('created_at').notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
}, (t) => [
  index('template_edge_rules_src').on(t.sourceTypeId, t.edgeType),
]);

/** 模板版本审计(spec 2026-08-26 §3.3)。 */
export const templateVersions = sqliteTable('template_versions', {
  version: integer('version').primaryKey(),
  changedBy: text('changed_by').notNull(),
  changeSummary: text('change_summary').notNull(),
  changedAt: text('changed_at').notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
});
