// apps/server/src/ontology/projection.ts
// 台账只读投影(roadmap 2026-09-07 Item 3)。铁律：本模块只含 SELECT，绝不写
// contract_ledger/documents/trade_facts 任何源表(验收 3，代码审查确认无写路径)。
// 映射 v1(理由见计划「摸底结论」；2026-09-08 起静态主数据可经表单直写 trade_facts)：
//   TradeContract                 <- contract_ledger
//   Goods{Receipt,Delivery}Event  <- documents(doc_type 收货单/发货单) ∪ trade_facts
//   其余 5 事件 + TradeGoods/Counterparty/OrgUnit <- trade_facts
//     (静态 3 类主数据源=POST /api/ontology/master-data 手工登记, 列表口径=最新口径)
import type { DbContext, PostgresDbContext } from '../pipeline/db/client.js';
import { effectiveUserId } from '../pipeline/db/repositories.js';
import { asOfBusinessTime, numberPlaceholders, asOfSystemTime, normalizeIsoUtc, type AsOfPredicate } from './asof.js';
import type { OntologyEntityName } from './index.js';
import {
  listTradeFactsAsOf, getTradeFactById, listTradeFactHistory, listOntologyEdgesAsOf,
  type TradeFactRow,
} from './repo.js';

export type ProjectionSource = 'contract_ledger' | 'documents' | 'trade_facts';

export interface ProjectedEntity {
  id: string;
  entityType: OntologyEntityName;
  /** 展示名(第一列，非注册表驱动)：合同号/单据类型/业务键(invoiceNo 等) */
  label: string;
  /** 注册表词汇内的字段(尽力映射；源缺失的字段不出现，前端渲染空)。
   *  Counterparty 归一组附加 formerNames=[曾用名...](spec 主体身份 §5, 非注册表词汇)。 */
  fields: Record<string, unknown>;
  /** 溯源展示(documents 行携带 sourceUri/reviewStatus；其余源省略) */
  meta?: Record<string, string | null>;
  source: ProjectionSource;
  validAt: string | null;
  /** 失效时点(null=现行事实)；timeline 失效行标注"曾用名"用(2026-09-09)。 */
  invalidAt: string | null;
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
    invalidAt: null,
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

/** 总览工作台（Item 7）合同总数/字段读取入口：同一 USER_SCOPE 与 SOURCE_ROW_CAP 口径。 */
export async function listContractEntities(ctx: DbContext, uid: string): Promise<ProjectedEntity[]> {
  return listContracts(ctx, uid);
}

export interface ContractLedgerRef {
  id: string;
  contractNo: string;
  /** 台账原始抽取字段（中文键开放词汇，如「数量」）——注册表投影之外的聚合口径用。 */
  extracted: Record<string, unknown>;
}

/** 总览工作台（Item 7）超量收货/执行率聚合用：读原始台账行（只读，同 USER_SCOPE/CAP）。 */
export async function listContractLedgerRefs(ctx: DbContext, uid: string): Promise<ContractLedgerRef[]> {
  const sql = `SELECT id, contract_no, fields
                 FROM contract_ledger WHERE ${USER_SCOPE_LEGACY}
                ORDER BY created_at DESC, id LIMIT ${SOURCE_ROW_CAP}`;
  const map = (r: Record<string, unknown>): ContractLedgerRef => ({
    id: String(r['id']),
    contractNo: String(r['contract_no'] ?? ''),
    extracted: parseJsonObj(r['fields']),
  });
  if (ctx.backend === 'postgres') {
    const res = await (ctx as PostgresDbContext).pool.query(numberPlaceholders(sql), [uid]);
    return (res.rows as Array<Record<string, unknown>>).map(map);
  }
  const rows = ctx.sqlite.prepare(sql).all(uid) as Array<Record<string, unknown>>;
  return rows.map(map);
}

// ---------------------------------------------------------------------------
// 收发依据 <- documents。doc_type 白名单与 pipeline bindingProposal.GOODS_FIELD_DOCS
// (收货单/发货单)对齐；本地声明避免 ontology -> pipeline 的反向依赖。
// ---------------------------------------------------------------------------
/** Item 4 起邻接穿透复用：收发事件 -> documents.doc_type 白名单。 */
export const DOC_TYPE_BY_EVENT: Record<'GoodsReceiptEvent' | 'GoodsDeliveryEvent', string> = {
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
    invalidAt: null,
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

const BUSINESS_KEY_FIELDS = ['invoiceNo', 'contractNo', 'name', 'costType'] as const;

function businessKeyOf(p: Record<string, unknown>): string | null {
  for (const k of BUSINESS_KEY_FIELDS) {
    const v = p[k];
    if (typeof v === 'string' && v !== '') return v;
  }
  return null;
}

/** Item 4 起邻接穿透复用：trade_facts 行 -> 展示实体。 */
export function factToEntity(row: TradeFactRow): ProjectedEntity {
  return {
    id: row.id,
    entityType: row.entityType as OntologyEntityName,
    label: businessKeyOf(row.payload) ?? row.id,
    fields: row.payload,
    source: 'trade_facts',
    // P3 凭证据源: 来源单据 id 走 meta(非注册表实体字段, 详情抽屉单列展示)。
    ...(row.documentId ? { meta: { documentId: row.documentId } } : {}),
    validAt: row.validAt,
    invalidAt: row.invalidAt,
    ingestedAt: row.ingestedAt,
  };
}

async function listFacts(ctx: DbContext, type: OntologyEntityName, uid: string): Promise<ProjectedEntity[]> {
  const rows = await listTradeFactsAsOf(
    ctx, asOfBusinessTime(new Date().toISOString()), { entityType: type }, uid);
  return rows.map(factToEntity);
}

// ---------------------------------------------------------------------------
// Counterparty 台账归一(spec 主体身份 §5)：按 payload.uscc 分组——主体同一性=uscc,
// 名字只是随时间变化的属性值。每组一行: label=现行名, fields.formerNames=[曾用名...],
// 排序按现行事实 ingestedAt。uscc 缺失的存量行保持独立行(读路径容忍, 提示补录)。
// ---------------------------------------------------------------------------

const nowIso = () => new Date().toISOString();

/** 业务现行判定(与 asOfBusinessTime(now) 同语义的内存版): 当时为真=已生效且未失效。 */
function isBusinessValidNow(row: TradeFactRow, at: string): boolean {
  return row.validAt <= at && (row.invalidAt == null || row.invalidAt > at);
}

async function listCounterpartyGroups(ctx: DbContext, uid: string): Promise<ProjectedEntity[]> {
  const now = nowIso();
  // 含失效全集(系统时间 now = 全部已入库行), 内存按 uscc 归一; 行数口径沿 SOURCE_ROW_CAP 上限。
  const rows = await listTradeFactsAsOf(ctx, asOfSystemTime(now), { entityType: 'Counterparty' }, uid);
  const groups = new Map<string, TradeFactRow[]>();
  for (const row of rows) {
    const uscc = typeof row.payload['uscc'] === 'string' && row.payload['uscc'] !== ''
      ? row.payload['uscc']
      : `id:${row.id}`; // 无 uscc 存量行: 独立主体(独立分组键, 不与任何行合并)
    const group = groups.get(uscc) ?? [];
    group.push(row);
    groups.set(uscc, group);
  }
  const out: ProjectedEntity[] = [];
  for (const [uscc, group] of groups) {
    // 现行事实 = 业务现行(理论上一组最多一条; 数据异常时取 ingestedAt 最新兜底)。
    const validRows = group.filter((r) => isBusinessValidNow(r, now));
    const current = [...validRows].sort((a, b) =>
      b.ingestedAt.localeCompare(a.ingestedAt) || b.id.localeCompare(a.id))[0];
    if (!current) continue; // 全组已失效且无换代(理论边界): 列表不显示
    // 曾用名 = 组内已失效历史的 name(valid_at 升序); 未来才生效的行不算曾用名。
    const formerNames = group
      .filter((r) => r.id !== current.id && r.invalidAt != null && r.validAt <= now)
      .sort((a, b) => a.validAt.localeCompare(b.validAt) || a.id.localeCompare(b.id))
      .map((r) => r.payload['name'])
      .filter((v): v is string => typeof v === 'string' && v !== '');
    const base = factToEntity(current);
    out.push({
      ...base,
      ...(uscc.startsWith('id:') ? {} : { meta: { ...base.meta, uscc } }),
      fields: { ...current.payload, ...(formerNames.length > 0 ? { formerNames } : {}) },
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// 统一入口：源收集 -> q 过滤 -> 排序 -> 内存分页
// ---------------------------------------------------------------------------

async function collectEntities(ctx: DbContext, type: OntologyEntityName, uid: string): Promise<ProjectedEntity[]> {
  if (type === 'TradeContract') return listContracts(ctx, uid);
  if (type === 'Counterparty') return listCounterpartyGroups(ctx, uid); // 主体归一(spec §5)
  if (type === 'GoodsReceiptEvent' || type === 'GoodsDeliveryEvent') {
    const [docs, facts] = await Promise.all([
      listReceiptDeliveryDocs(ctx, type, uid),
      listFacts(ctx, type, uid),
    ]);
    return [...docs, ...facts];
  }
  // 其余事件 + 手工登记静态主数据（TradeGoods/OrgUnit，POST
  // /api/ontology/master-data -> insertTradeFact）都以 trade_facts 为源。
  return listFacts(ctx, type, uid);
}

export async function listProjectedEntities(
  ctx: DbContext,
  type: OntologyEntityName,
  opts: { page?: number; pageSize?: number; q?: string; validFrom?: string; validTo?: string; amountMin?: number; amountMax?: number } = {},
  userId?: string,
): Promise<EntityListResult> {
  const page = Math.max(1, opts.page ?? 1);
  const pageSize = Math.min(100, Math.max(1, opts.pageSize ?? 20));
  const uid = effectiveUserId(userId);
  const rows = await collectEntities(ctx, type, uid);
  const q = opts.q?.trim().toLowerCase() ?? '';
  const filtered = q
    ? rows.filter((e) => e.label.toLowerCase().includes(q)
      || e.id.toLowerCase().includes(q)
      || JSON.stringify(e.fields).toLowerCase().includes(q))
    : rows;
  // 基础过滤(2026-09-08)：业务时间范围(取日期部分, 含端点) + 金额范围。
  // 事件实体必有 validAt/amount；静态实体(如合同)投影无业务时间 -> 时间过滤激活时被排除。
  const { validFrom, validTo, amountMin, amountMax } = opts;
  const hasTime = validFrom !== undefined || validTo !== undefined;
  const hasAmount = amountMin !== undefined || amountMax !== undefined;
  const scopeFiltered = hasTime || hasAmount
    ? filtered.filter((e) => {
        if (hasTime) {
          if (!e.validAt) return false;
          const d = e.validAt.slice(0, 10);
          if (validFrom !== undefined && d < validFrom) return false;
          if (validTo !== undefined && d > validTo) return false;
        }
        if (hasAmount) {
          const amt = e.fields['amount'];
          if (typeof amt !== 'number') return false;
          if (amountMin !== undefined && amt < amountMin) return false;
          if (amountMax !== undefined && amt > amountMax) return false;
        }
        return true;
      })
    : filtered;
  scopeFiltered.sort((a, b) => (b.ingestedAt ?? '').localeCompare(a.ingestedAt ?? '') || b.id.localeCompare(a.id));
  const start = (page - 1) * pageSize;
  return { items: scopeFiltered.slice(start, start + pageSize), total: scopeFiltered.length, page, pageSize };
}

// ---------------------------------------------------------------------------
// 详情 + as-of 时间线(仅事件实体/trade_facts 源具备双时间轴)
// ---------------------------------------------------------------------------

export type AsOfMode = 'business' | 'system';

export interface EntityDetail {
  /** 本行本身(不做 as-of 过滤；as-of 只影响 timeline/netAmount) */
  entity: ProjectedEntity;
  /** 本行 + REVERSE_ORIGIN 边双向传递闭包，as-of 过滤，validAt 升序 */
  timeline: ProjectedEntity[];
  /** 时间线金额合计(无金额实体为 null)——红冲负数自动轧差(docx 6.2) */
  netAmount: number | null;
  /** 本行作为端点的本体关系边(最新业务口径, 双向, 上限 50)——P4 关系入口补全的
   *  可见性配套: 建好的核销/分摊/红冲边在台账详情即可核对, 不必开穿透图。 */
  relations: EntityRelationRef[];
  asOf: { mode: AsOfMode; at: string };
}

/** 台账详情关系条目(方向相对本行)。 */
export interface EntityRelationRef {
  edgeId: string;
  relation: string;
  direction: 'out' | 'in';
  counterpart: { type: string; id: string; label: string; resolved: boolean };
  params: Record<string, unknown>;
  validAt: string | null;
}

const RELATION_CAP = 50;

/** 红冲溯源闭包(docx 5.4)：root + REVERSE_ORIGIN 边双向可达 facts，全部经同一 as-of 谓词过滤。 */
async function reverseOriginCluster(
  ctx: DbContext, rootId: string, pred: AsOfPredicate, uid: string,
): Promise<TradeFactRow[]> {
  const edges = await listOntologyEdgesAsOf(ctx, pred, { relation: 'REVERSE_ORIGIN' }, uid);
  const seen = new Set<string>([rootId]);
  let frontier = [rootId];
  while (frontier.length > 0) {
    const next: string[] = [];
    for (const e of edges) {
      if (frontier.includes(e.fromId) && !seen.has(e.toId)) { seen.add(e.toId); next.push(e.toId); }
      if (frontier.includes(e.toId) && !seen.has(e.fromId)) { seen.add(e.fromId); next.push(e.fromId); }
    }
    frontier = next;
  }
  const facts = await listTradeFactsAsOf(ctx, pred, {}, uid);
  return facts.filter((f) => seen.has(f.id));
}

/** Item 4 起邻接穿透复用：合同锚点单行解析(台账口径, 用户隔离)。 */
export async function findContractRowById(
  ctx: DbContext, id: string, uid: string,
): Promise<ProjectedEntity | null> {
  const sql = `SELECT id, contract_no, title, contract_type, fields, created_at
                 FROM contract_ledger WHERE id = ? AND ${USER_SCOPE_LEGACY}`;
  if (ctx.backend === 'postgres') {
    const res = await (ctx as PostgresDbContext).pool.query(numberPlaceholders(sql), [id, uid]);
    const row = (res.rows as Array<Record<string, unknown>>)[0];
    return row ? mapContractRow(row) : null;
  }
  const row = ctx.sqlite.prepare(sql).get(id, uid) as Record<string, unknown> | undefined;
  return row ? mapContractRow(row) : null;
}

/** Item 4 起邻接穿透复用：收发依据单据行解析(D8: 强制 doc_type 匹配)。 */
export async function findDocRowById(
  ctx: DbContext, id: string, type: 'GoodsReceiptEvent' | 'GoodsDeliveryEvent', uid: string,
): Promise<ProjectedEntity | null> {
  const sql = `SELECT id, doc_type, source_uri, review_status, created_at
                 FROM documents WHERE id = ? AND doc_type = ? AND ${USER_SCOPE_LEGACY}`;
  if (ctx.backend === 'postgres') {
    const res = await (ctx as PostgresDbContext).pool.query(
      numberPlaceholders(sql), [id, DOC_TYPE_BY_EVENT[type], uid]);
    const row = (res.rows as Array<Record<string, unknown>>)[0];
    return row ? mapDocRow(type, row) : null;
  }
  const row = ctx.sqlite.prepare(sql)
    .get(id, DOC_TYPE_BY_EVENT[type], uid) as Record<string, unknown> | undefined;
  return row ? mapDocRow(type, row) : null;
}

export async function getProjectedEntityDetail(
  ctx: DbContext,
  type: OntologyEntityName,
  id: string,
  opts: { mode?: AsOfMode; at?: string } = {},
  userId?: string,
): Promise<EntityDetail | null> {
  const uid = effectiveUserId(userId);
  const mode: AsOfMode = opts.mode ?? 'business';
  const at = normalizeIsoUtc(opts.at ?? new Date()); // 非法输入 throw -> 路由转 400
  const pred = mode === 'system' ? asOfSystemTime(at) : asOfBusinessTime(at);
  const asOf = { mode, at };

  if (type === 'TradeContract') {
    const entity = await findContractRowById(ctx, id, uid);
    if (!entity) return null;
    const relations = await listEntityRelations(ctx, type, id, uid);
    return { entity, timeline: [], netAmount: null, relations, asOf };
  }

  // Counterparty 主体归一详情(spec 主体身份 §5)：entity=现行事实;
  // timeline=组内名称史(含失效行, valid_at 升序, 失效行 invalidAt 可辨);
  // relations=组内全部事实端点的边 union(cap 50)——更名前建的核销/分摊边不丢;
  // netAmount=null(主体无金额口径)。
  if (type === 'Counterparty') {
    const requested = await getTradeFactById(ctx, id, uid);
    if (!requested) return null;
    const uscc = typeof requested.payload['uscc'] === 'string' && requested.payload['uscc'] !== ''
      ? requested.payload['uscc']
      : null;
    const group = uscc
      ? await listTradeFactHistory(ctx, { entityType: 'Counterparty', uscc }, uid)
      : [requested];
    const now = nowIso();
    const current = group.filter((r) => isBusinessValidNow(r, now))
      .sort((a, b) => b.ingestedAt.localeCompare(a.ingestedAt) || b.id.localeCompare(a.id))[0]
      ?? requested; // 全组失效(历史 id 深链): 就地展示该行
    const timeline = [...group]
      .sort((a, b) => a.validAt.localeCompare(b.validAt) || a.id.localeCompare(b.id))
      .map(factToEntity);
    const relations = await listEntityRelationsForFacts(
      ctx, 'Counterparty', group.map((r) => r.id), uid);
    return { entity: factToEntity(current), timeline, netAmount: null, relations, asOf };
  }

  // 事件实体：trade_facts 优先；收发两类再探 documents(收发依据单据行)
  const fact = await getTradeFactById(ctx, id, uid);
  if (fact) {
    const cluster = await reverseOriginCluster(ctx, id, pred, uid);
    const timeline = [...cluster]
      .sort((a, b) => a.validAt.localeCompare(b.validAt) || a.ingestedAt.localeCompare(b.ingestedAt))
      .map(factToEntity);
    const amounts = cluster
      .map((f) => f.payload['amount'])
      .filter((v): v is number => typeof v === 'number');
    const relations = await listEntityRelations(ctx, type, id, uid);
    return {
      entity: factToEntity(fact),
      timeline,
      netAmount: amounts.length > 0 ? amounts.reduce((a, b) => a + b, 0) : null,
      relations,
      asOf,
    };
  }
  if (type === 'GoodsReceiptEvent' || type === 'GoodsDeliveryEvent') {
    const entity = await findDocRowById(ctx, id, type, uid);
    if (!entity) return null;
    const relations = await listEntityRelations(ctx, type, id, uid);
    return { entity, timeline: [], netAmount: null, relations, asOf };
  }
  return null;
}

/** 本行作为端点的本体关系边(最新业务口径) + 对端展示名解析。 */
export async function listEntityRelations(
  ctx: DbContext, entityType: string, id: string, uid: string,
): Promise<EntityRelationRef[]> {
  return listEntityRelationsForFacts(ctx, entityType, [id], uid);
}

/** 组内多事实端点的边 union(cap 50, 边 id 去重)——Counterparty 归一组用：
 *  更名前以旧事实 id 建的边与现行事实的边合并呈现(spec 主体身份 §5)。 */
export async function listEntityRelationsForFacts(
  ctx: DbContext, entityType: string, factIds: string[], uid: string,
): Promise<EntityRelationRef[]> {
  const ids = new Set(factIds);
  const edges = await listOntologyEdgesAsOf(
    ctx, asOfBusinessTime(new Date().toISOString()), {}, uid);
  const touching = edges.filter((e) =>
    (e.fromType === entityType && ids.has(e.fromId)) || (e.toType === entityType && ids.has(e.toId)));
  const out: EntityRelationRef[] = [];
  const seen = new Set<string>();
  for (const e of touching.slice(0, RELATION_CAP)) {
    if (seen.has(e.id)) continue;
    seen.add(e.id);
    const isOut = e.fromType === entityType && ids.has(e.fromId);
    const cType = isOut ? e.toType : e.fromType;
    const cId = isOut ? e.toId : e.fromId;
    out.push({
      edgeId: e.id,
      relation: e.relation,
      direction: isOut ? 'out' : 'in',
      counterpart: await resolveCounterpartLabel(ctx, cType, cId, uid),
      params: e.params,
      validAt: e.validAt,
    });
  }
  return out;
}

/** 对端展示名：事实行走业务键、合同走台账合同号、收发单据源走单据类型。 */
async function resolveCounterpartLabel(
  ctx: DbContext, type: string, id: string, uid: string,
): Promise<EntityRelationRef['counterpart']> {
  if (type === 'TradeContract') {
    const row = await findContractRowById(ctx, id, uid);
    if (row) return { type, id, label: row.label, resolved: true };
  } else {
    const fact = await getTradeFactById(ctx, id, uid);
    if (fact && fact.entityType === type) {
      return { type, id, label: factToEntity(fact).label, resolved: true };
    }
    if (type === 'GoodsReceiptEvent' || type === 'GoodsDeliveryEvent') {
      const doc = await findDocRowById(ctx, id, type, uid);
      if (doc) return { type, id, label: doc.label, resolved: true };
    }
  }
  return { type, id, label: id, resolved: false };
}
