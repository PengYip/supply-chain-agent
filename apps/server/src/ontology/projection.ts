// apps/server/src/ontology/projection.ts
// 台账只读投影(roadmap 2026-09-07 Item 3)。铁律：本模块只含 SELECT，绝不写
// contract_ledger/documents/trade_facts 任何源表(验收 3，代码审查确认无写路径)。
// 映射 v1(理由见计划「摸底结论」)：
//   TradeContract                 <- contract_ledger
//   Goods{Receipt,Delivery}Event  <- documents(doc_type 收货单/发货单) ∪ trade_facts
//   其余 5 事件实体                <- trade_facts(列表口径=最新口径 asOfBusinessTime(now))
//   TradeGoods/Counterparty/OrgUnit <- 无源，空态(「待本体基座灌数」)
import type { DbContext, PostgresDbContext } from '../pipeline/db/client.js';
import { effectiveUserId } from '../pipeline/db/repositories.js';
import { asOfBusinessTime, numberPlaceholders } from './asof.js';
import type { OntologyEntityName } from './index.js';
import { listTradeFactsAsOf, type TradeFactRow } from './repo.js';

export type ProjectionSource = 'contract_ledger' | 'documents' | 'trade_facts';

export interface ProjectedEntity {
  id: string;
  entityType: OntologyEntityName;
  /** 展示名(第一列，非注册表驱动)：合同号/单据类型/业务键(invoiceNo 等) */
  label: string;
  /** 注册表词汇内的字段(尽力映射；源缺失的字段不出现，前端渲染空) */
  fields: Record<string, unknown>;
  /** 溯源展示(documents 行携带 sourceUri/reviewStatus；其余源省略) */
  meta?: Record<string, string | null>;
  source: ProjectionSource;
  validAt: string | null;
  ingestedAt: string | null;
}

export interface EntityListResult {
  items: ProjectedEntity[];
  total: number;
  page: number;
  pageSize: number;
}

/** 单源扫描上限(内存过滤/合并/分页的前提，超出取最新 created_at)。 */
const SOURCE_ROW_CAP = 500;

/** 旧表 user_id 历史可空，防御性三路(对齐 repositories.searchContractLedger)。 */
const USER_SCOPE_LEGACY = "(user_id = ? OR user_id = '' OR user_id IS NULL)";

const parseJsonObj = (raw: unknown): Record<string, unknown> => {
  if (typeof raw === 'string') {
    try { return JSON.parse(raw) as Record<string, unknown>; } catch { return {}; }
  }
  return (raw ?? {}) as Record<string, unknown>;
};

/** SQLite datetime('now') 产出 'YYYY-MM-DD HH:MM:SS'；归一为字典序=时间序形态。 */
function normalizeLegacyDt(v: unknown): string | null {
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString();
  const s = String(v);
  return s.includes(' ') ? `${s.replace(' ', 'T')}Z` : s;
}

// ---------------------------------------------------------------------------
// TradeContract <- contract_ledger
// ---------------------------------------------------------------------------

function mapContractRow(r: Record<string, unknown>): ProjectedEntity {
  const extracted = parseJsonObj(r['fields']);
  const currencyProbe = extracted['币种'] ?? extracted['currency'];
  const contractNo = String(r['contract_no'] ?? '');
  return {
    id: String(r['id']),
    entityType: 'TradeContract',
    label: contractNo || String(r['id']),
    fields: {
      contractNo,
      ...(r['title'] != null && r['title'] !== '' ? { title: String(r['title']) } : {}),
      ...(r['contract_type'] != null ? { contractType: String(r['contract_type']) } : {}),
      ...(typeof currencyProbe === 'string' && currencyProbe !== '' ? { currency: currencyProbe } : {}),
    },
    source: 'contract_ledger',
    validAt: null,
    ingestedAt: normalizeLegacyDt(r['created_at']),
  };
}

async function listContracts(ctx: DbContext, uid: string): Promise<ProjectedEntity[]> {
  const sql = `SELECT id, contract_no, title, contract_type, fields, created_at
                 FROM contract_ledger WHERE ${USER_SCOPE_LEGACY}
                ORDER BY created_at DESC, id LIMIT ${SOURCE_ROW_CAP}`;
  if (ctx.backend === 'postgres') {
    const res = await (ctx as PostgresDbContext).pool.query(numberPlaceholders(sql), [uid]);
    return (res.rows as Array<Record<string, unknown>>).map(mapContractRow);
  }
  const rows = ctx.sqlite.prepare(sql).all(uid) as Array<Record<string, unknown>>;
  return rows.map(mapContractRow);
}

// ---------------------------------------------------------------------------
// 收发依据 <- documents。doc_type 白名单与 pipeline bindingProposal.GOODS_FIELD_DOCS
// (收货单/发货单)对齐；本地声明避免 ontology -> pipeline 的反向依赖。
// ---------------------------------------------------------------------------
const DOC_TYPE_BY_EVENT: Record<'GoodsReceiptEvent' | 'GoodsDeliveryEvent', string> = {
  GoodsReceiptEvent: '收货单',
  GoodsDeliveryEvent: '发货单',
};

function mapDocRow(
  entityType: 'GoodsReceiptEvent' | 'GoodsDeliveryEvent',
  r: Record<string, unknown>,
): ProjectedEntity {
  const docType = String(r['doc_type'] ?? '');
  const id = String(r['id']);
  // documents 表无金额/数量列：事件自有字段源缺失 -> 不出现，列表列渲染空。
  return {
    id,
    entityType,
    label: `${docType} ${id.slice(0, 8)}`,
    fields: {},
    meta: {
      sourceUri: r['source_uri'] == null ? null : String(r['source_uri']),
      reviewStatus: r['review_status'] == null ? null : String(r['review_status']),
    },
    source: 'documents',
    validAt: null,
    ingestedAt: normalizeLegacyDt(r['created_at']),
  };
}

async function listReceiptDeliveryDocs(
  ctx: DbContext, type: 'GoodsReceiptEvent' | 'GoodsDeliveryEvent', uid: string,
): Promise<ProjectedEntity[]> {
  const sql = `SELECT id, doc_type, source_uri, review_status, created_at
                 FROM documents WHERE doc_type = ? AND ${USER_SCOPE_LEGACY}
                ORDER BY created_at DESC, id LIMIT ${SOURCE_ROW_CAP}`;
  if (ctx.backend === 'postgres') {
    const res = await (ctx as PostgresDbContext).pool.query(
      numberPlaceholders(sql), [DOC_TYPE_BY_EVENT[type], uid]);
    return (res.rows as Array<Record<string, unknown>>).map((r) => mapDocRow(type, r));
  }
  const rows = ctx.sqlite.prepare(sql)
    .all(DOC_TYPE_BY_EVENT[type], uid) as Array<Record<string, unknown>>;
  return rows.map((r) => mapDocRow(type, r));
}

// ---------------------------------------------------------------------------
// 事件 <- trade_facts(列表口径 = 最新口径：asOfBusinessTime(now))
// ---------------------------------------------------------------------------

const EVENT_TYPES: readonly OntologyEntityName[] = [
  'GoodsReceiptEvent', 'GoodsDeliveryEvent', 'SettlementEvent', 'InvoiceEvent',
  'PaymentEvent', 'CollectionEvent', 'ServiceCostEvent',
];

const BUSINESS_KEY_FIELDS = ['invoiceNo', 'contractNo', 'name', 'costType'] as const;

function businessKeyOf(p: Record<string, unknown>): string | null {
  for (const k of BUSINESS_KEY_FIELDS) {
    const v = p[k];
    if (typeof v === 'string' && v !== '') return v;
  }
  return null;
}

function factToEntity(row: TradeFactRow): ProjectedEntity {
  return {
    id: row.id,
    entityType: row.entityType as OntologyEntityName,
    label: businessKeyOf(row.payload) ?? row.id,
    fields: row.payload,
    source: 'trade_facts',
    validAt: row.validAt,
    ingestedAt: row.ingestedAt,
  };
}

async function listFacts(ctx: DbContext, type: OntologyEntityName, uid: string): Promise<ProjectedEntity[]> {
  const rows = await listTradeFactsAsOf(
    ctx, asOfBusinessTime(new Date().toISOString()), { entityType: type }, uid);
  return rows.map(factToEntity);
}

// ---------------------------------------------------------------------------
// 统一入口：源收集 -> q 过滤 -> 排序 -> 内存分页
// ---------------------------------------------------------------------------

async function collectEntities(ctx: DbContext, type: OntologyEntityName, uid: string): Promise<ProjectedEntity[]> {
  if (type === 'TradeContract') return listContracts(ctx, uid);
  if (type === 'GoodsReceiptEvent' || type === 'GoodsDeliveryEvent') {
    const [docs, facts] = await Promise.all([
      listReceiptDeliveryDocs(ctx, type, uid),
      listFacts(ctx, type, uid),
    ]);
    return [...docs, ...facts];
  }
  if ((EVENT_TYPES as readonly string[]).includes(type)) return listFacts(ctx, type, uid);
  return []; // TradeGoods/Counterparty/OrgUnit：无源空态(待本体基座灌数)
}

export async function listProjectedEntities(
  ctx: DbContext,
  type: OntologyEntityName,
  opts: { page?: number; pageSize?: number; q?: string } = {},
  userId?: string,
): Promise<EntityListResult> {
  const page = Math.max(1, opts.page ?? 1);
  const pageSize = Math.min(100, Math.max(1, opts.pageSize ?? 20));
  const uid = effectiveUserId(userId);
  const rows = await collectEntities(ctx, type, uid);
  const q = opts.q?.trim().toLowerCase() ?? '';
  const filtered = q
    ? rows.filter((e) => e.label.toLowerCase().includes(q)
      || JSON.stringify(e.fields).toLowerCase().includes(q))
    : rows;
  filtered.sort((a, b) => (b.ingestedAt ?? '').localeCompare(a.ingestedAt ?? '') || b.id.localeCompare(a.id));
  const start = (page - 1) * pageSize;
  return { items: filtered.slice(start, start + pageSize), total: filtered.length, page, pageSize };
}
