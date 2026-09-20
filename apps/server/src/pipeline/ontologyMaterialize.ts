// business-loop Wave 2: execution_flows/settlement_records -> 本体事实+归属边。
// 铁律: 本体写入只经 repo 写入边界; safe 包装永不抛(钩子 fire-and-forget);
// 跳过计数不造假数据(W2-C: payType/invoiceNo 解析不到就跳)。
import type { DbContext, PostgresDbContext } from './db/client.js';
import {
  insertTradeFact, insertOntologyEdge, listTradeFactsAsOf, listOntologyEdgesAsOf,
  invalidateTradeFact, invalidateOntologyEdgesFromFact,
  type TradeFactRow,
} from '../ontology/repo.js';
import { syncOntologyGraphSafe } from '../ontology/graphSync.js';
import { isRelationPairAllowed, type OntologyEntityName } from '../ontology/index.js';
import { asOfBusinessTime, numberPlaceholders, normalizeIsoUtc } from '../ontology/asof.js';
import { effectiveUserId, loadLatestExtractionByDocId } from './db/repositories.js';

export interface MaterializeResult {
  attempted: number;
  created: number;
  edges: number;
  skippedPayment: number;
  skippedInvoice: number;
  skippedNoMap: number;
  skippedNoContract: number;
  failures: string[];
}

const FLOW_ENTITY: Record<string, Partial<Record<'in' | 'out', OntologyEntityName>>> = {
  货物流: { in: 'GoodsReceiptEvent', out: 'GoodsDeliveryEvent' },
  发票流: { in: 'InvoiceEvent', out: 'InvoiceEvent' },
  资金流: { out: 'PaymentEvent', in: 'CollectionEvent' },
};
const PAY_TYPE_KEYWORDS: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['预付', ['预付']], ['尾款', ['尾款']], ['进度款', ['进度款', '进度']], ['质保金', ['质保金', '质保']],
];

const USER_SCOPE = "(user_id = ? OR user_id = '' OR user_id IS NULL)";

interface FlowRow {
  id: string;
  document_id: string;
  contract_no: string;
  flow_type: string;
  direction: 'in' | 'out';
  amount: number | null;
  quantity_ton: number | null;
  unit: string | null;
  voucher_date: string | null;
  user_id: string | null;
  /** R13: 已认领兄弟流判别(非空=已被某趟实体化认领)。 */
  ontology_fact_id: string | null;
}

function fieldStr(fields: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const k of keys) {
    const v = fields[k];
    if (typeof v === 'string' && v.trim() !== '') return v.trim();
  }
  return null;
}

function payTypeFromFields(fields: Record<string, unknown>): string | null {
  const haystack = Object.values(fields).filter((v): v is string => typeof v === 'string');
  for (const [payType, keywords] of PAY_TYPE_KEYWORDS) {
    if (keywords.some((kw) => haystack.some((v) => v.includes(kw)))) return payType;
  }
  return null;
}

/**
 * 本地日期归一(R15): voucher_date 等业务日期可来自中文抽取文本, 兼容
 * ISO / 常见中文格式(YYYY年M月D日 / YYYY/M/D / YYYY.M.D / YYYY-M-D) -> UTC ISO。
 * 不放 normalizeIsoUtc(共享工具, 放宽影响全局); 不合规输入照旧走原归一抛错。
 */
function normalizeLocalDate(input: string): string {
  const trimmed = input.trim();
  const m = trimmed.match(/^(\d{4})[年./-](\d{1,2})[月./-](\d{1,2})日?$/);
  if (m) {
    const y = m[1]!;
    const mo = m[2]!.padStart(2, '0');
    const d = m[3]!.padStart(2, '0');
    return `${y}-${mo}-${d}T00:00:00.000Z`;
  }
  return normalizeIsoUtc(trimmed);
}

/** R13: 取该文档全量流(含已认领兄弟行)——维度模式判别与 pending 过滤都在内存做。 */
async function listAllFlows(ctx: DbContext, docId: string, uid: string): Promise<FlowRow[]> {
  const sql = `SELECT * FROM execution_flows WHERE document_id = ? AND ${USER_SCOPE}`;
  if (ctx.backend === 'postgres') {
    const res = await (ctx as PostgresDbContext).pool.query(numberPlaceholders(sql), [docId, uid]);
    return res.rows as FlowRow[];
  }
  return ctx.sqlite.prepare(sql).all(docId, uid) as FlowRow[];
}

async function findContractIdByNo(ctx: DbContext, contractNo: string, uid: string): Promise<string | null> {
  const sql = `SELECT id FROM contract_ledger WHERE contract_no = ? AND ${USER_SCOPE} LIMIT 1`;
  if (ctx.backend === 'postgres') {
    const res = await (ctx as PostgresDbContext).pool.query(numberPlaceholders(sql), [contractNo, uid]);
    return (res.rows[0]?.id as string | undefined) ?? null;
  }
  const row = ctx.sqlite.prepare(sql).get(contractNo, uid) as { id: string } | undefined;
  return row?.id ?? null;
}

async function writebackFlowId(ctx: DbContext, flowId: string, factId: string): Promise<void> {
  const sql = 'UPDATE execution_flows SET ontology_fact_id = ? WHERE id = ?';
  if (ctx.backend === 'postgres') {
    await (ctx as PostgresDbContext).pool.query(numberPlaceholders(sql), [factId, flowId]);
    return;
  }
  ctx.sqlite.prepare(sql).run(factId, flowId);
}

/**
 * 条件认领(R11): 只在 ontology_fact_id IS NULL 时回写——并发 materializer 已认领
 * 的 flow 不被覆盖, 返回 false 由调用方补偿刚插入的事实(失效防双)。
 */
async function claimFlowWriteback(ctx: DbContext, flowId: string, factId: string): Promise<boolean> {
  const sql = 'UPDATE execution_flows SET ontology_fact_id = ? WHERE id = ? AND ontology_fact_id IS NULL';
  if (ctx.backend === 'postgres') {
    const res = await (ctx as PostgresDbContext).pool.query(numberPlaceholders(sql), [factId, flowId]);
    return (res.rowCount ?? 0) > 0;
  }
  return ctx.sqlite.prepare(sql).run(factId, flowId).changes > 0;
}

/**
 * R11/R12: 同 documentId+entityType 的现行事实配对。
 * - 排除本趟已认领(claimed)的 fact id——多绑定下逐流独立配对, 不收敛不误失效;
 * - 边目标优先: 候选事实的现行 ALLOCATE_TO 边目标合同 == 该 flow 合同者, 视为本流
 *   上一代事实(确定性配对, 避免流-事实错挂; 差异时调用方走换代替换);
 * - 无边目标匹配: 退等价候选(复用路径), 无等价则任意候选(单流差异兜底)。
 */
async function findCurrentFactForFlow(
  ctx: DbContext, docId: string, entity: OntologyEntityName,
  payload: Record<string, unknown>, userId: string | undefined,
  claimed: ReadonlySet<string>, contractNo: string, uid: string,
): Promise<TradeFactRow | null> {
  const now = new Date().toISOString();
  const rows = await listTradeFactsAsOf(
    ctx, asOfBusinessTime(now), { entityType: entity }, userId,
  );
  const candidates = rows.filter((f) => f.documentId === docId && !claimed.has(f.id));
  if (candidates.length === 0) return null;
  if (contractNo) {
    const contractId = await findContractIdByNo(ctx, contractNo, uid);
    if (contractId) {
      const edges = await listOntologyEdgesAsOf(
        ctx, asOfBusinessTime(now), { relation: 'ALLOCATE_TO' }, userId,
      );
      const matched = candidates.find((f) =>
        edges.some((e) => e.fromId === f.id && e.toId === contractId));
      if (matched) return matched;
    }
  }
  const equivalent = candidates.filter((f) => payloadEquivalent(payload, f.payload));
  return equivalent[0] ?? candidates[0] ?? null;
}

/** R11 实质等价: 金额/数量/币种/合同号全同即视为等价(其余字段差异容忍)。 */
function payloadEquivalent(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const same = (x: unknown, y: unknown): boolean =>
    (x == null ? null : x) === (y == null ? null : y);
  return same(a['amount'], b['amount'])
    && same(a['quantity'], b['quantity'])
    && same(a['currency'], b['currency'])
    && same(a['contractNo'], b['contractNo']);
}

/** 待实体化流 -> 本体事实(payload 按注册表实体 schema strict 语义构建; 跳过规则先行)。 */
export async function materializeDocumentOntology(
  ctx: DbContext, docId: string, userId?: string,
): Promise<MaterializeResult> {
  const res: MaterializeResult = {
    attempted: 0, created: 0, edges: 0,
    skippedPayment: 0, skippedInvoice: 0, skippedNoMap: 0, skippedNoContract: 0,
    failures: [],
  };
  const uid = effectiveUserId(userId);
  // R13: 全量流(含已认领兄弟行)——配对/增量模式判别 + pending 过滤都在内存做。
  const allFlows = await listAllFlows(ctx, docId, uid);
  const flows = allFlows.filter((f) => f.ontology_fact_id == null);
  res.attempted = flows.length;
  // R12: 本趟已认领集合(复用与新建都入)——多绑定逐流独立配对, 不收敛不误失效。
  const claimedFactIds = new Set<string>();
  // R13: 维度模式——某维度存在已认领兄弟流(ontology_fact_id 非空) => 增量模式
  // (顺序绑定新增流, plain insert 不配对不换代); 全 pending => 配对模式(全量重建签名)。
  const incrementalDims = new Set<string>();
  for (const f of allFlows) {
    if (f.ontology_fact_id == null) continue;
    const ent = FLOW_ENTITY[f.flow_type]?.[f.direction];
    if (!ent) continue;
    incrementalDims.add(`${docId}:${ent}`);
  }
  // R12: 本趟处理过的 (docId:entity) 维度, 供孤儿清扫; R13 收窄为配对模式且有完成。
  const processedDims = new Set<string>();
  const completedDims = new Set<string>();
  // 补充字段读取: 同文档最新 extraction(中文键 fields); 无 extraction 时 fields 为空。
  const extraction = await loadLatestExtractionByDocId(ctx, docId, userId);
  const fields = (extraction?.fields ?? {}) as Record<string, unknown>;

  for (const flow of flows) {
    const entity = FLOW_ENTITY[flow.flow_type]?.[flow.direction];
    if (!entity) { res.skippedNoMap += 1; continue; }
    const dimKey = `${docId}:${entity}`;
    const incremental = incrementalDims.has(dimKey);
    processedDims.add(dimKey);
    try {
      let payload: Record<string, unknown>;
      if (entity === 'InvoiceEvent') {
        const invoiceNo = fieldStr(fields, ['发票号码', '号码']);
        if (!invoiceNo) { res.skippedInvoice += 1; continue; }
        if (flow.amount == null) { res.failures.push(`${flow.id}: 发票流缺 amount`); continue; }
        payload = {
          eventBizType: '正向', amount: flow.amount, currency: 'CNY', invoiceNo,
          invoiceType: flow.direction === 'in' ? '进项' : '销项',
          ...(flow.contract_no ? { contractNo: flow.contract_no } : {}),
        };
      } else if (entity === 'PaymentEvent') {
        const payType = payTypeFromFields(fields);
        if (!payType) { res.skippedPayment += 1; continue; }
        payload = {
          eventBizType: '正向', amount: flow.amount, currency: 'CNY', payType,
          ...(flow.contract_no ? { contractNo: flow.contract_no } : {}),
        };
      } else if (entity === 'CollectionEvent') {
        payload = {
          eventBizType: '正向', amount: flow.amount, currency: 'CNY', collectionType: '回款',
          ...(flow.contract_no ? { contractNo: flow.contract_no } : {}),
        };
      } else {
        // GoodsReceiptEvent / GoodsDeliveryEvent
        const warehouse = fieldStr(fields, ['仓库', '入库仓库']);
        payload = {
          eventBizType: '正向',
          ...(flow.quantity_ton != null ? { quantity: flow.quantity_ton } : {}),
          ...(flow.unit ? { unit: flow.unit } : {}),
          ...(warehouse ? { warehouse } : {}),
          ...(flow.amount != null ? { amount: flow.amount, currency: 'CNY' } : {}),
        };
      }
      const validAt = flow.voucher_date ? normalizeLocalDate(flow.voucher_date) : new Date();
      // R13 增量模式(顺序绑定新增流): plain insert——不调配对、不查候选、不换代,
      // 兄弟事实与边不动(首流事实是另一绑定的合法事实, 不得复用吞/差异误失效)。
      let current: TradeFactRow | null = null;
      if (!incremental) {
        // 配对模式(R12): 现行事实配对(排除本趟已认领; 边目标优先)。
        current = await findCurrentFactForFlow(
          ctx, docId, entity, payload, userId, claimedFactIds, flow.contract_no, uid,
        );
      }
      if (current) {
        if (payloadEquivalent(payload, current.payload)) {
          // 实质等价 -> 复用: 只回写 flow 认领, 不插新事实不插新边(计数不进 created)。
          await writebackFlowId(ctx, flow.id, current.id);
          claimedFactIds.add(current.id);
          completedDims.add(dimKey);
          continue;
        }
        // 有差异 -> 换代替换: 旧事实+其发出的现行边整体失效, 审计链保留旧行。
        await invalidateTradeFact(ctx, current.id, validAt, userId);
        await invalidateOntologyEdgesFromFact(ctx, entity, current.id, validAt, userId);
      }
      const factId = await insertTradeFact(ctx, {
        entityType: entity, payload, validAt, createdBy: 'materializer', documentId: docId,
      }, userId);
      res.created += 1;
      claimedFactIds.add(factId);
      const contractId = await findContractIdByNo(ctx, flow.contract_no, uid);
      // 合同归属两路（wave4 plan 口径）：款/票/结算走 payload.contractNo（上已落），
      // 收/发货/服务费走 ALLOCATE_TO 边——注册表连接对白名单是 SSOT，不合法对不建边。
      const canAllocate = isRelationPairAllowed('ALLOCATE_TO', entity, 'TradeContract');
      if (!contractId) {
        res.skippedNoContract += 1;
      } else if (canAllocate && (flow.amount != null || flow.quantity_ton != null)) {
        // R8: ALLOCATE_TO 至少 amount 或 quantity 其一(写入方保证); 两者皆缺的异常流跳过归属边。
        const params = flow.amount != null
          ? { amount: flow.amount, method: '金额' as const }
          : { quantity: flow.quantity_ton, method: '数量' as const };
        await insertOntologyEdge(ctx, {
          relation: 'ALLOCATE_TO', fromType: entity, fromId: factId,
          toType: 'TradeContract', toId: contractId, params, validAt, createdBy: 'materializer',
        }, userId);
        res.edges += 1;
      }
      // 条件认领: 并发已被认领(changes=0)则失效刚插的事实+边, 防双份。
      const claimed = await claimFlowWriteback(ctx, flow.id, factId);
      if (!claimed) {
        await invalidateTradeFact(ctx, factId, validAt, userId);
        await invalidateOntologyEdgesFromFact(ctx, entity, factId, validAt, userId);
        res.created -= 1;
        res.edges = Math.max(0, res.edges - 1);
        claimedFactIds.delete(factId); // 已失效, 移出认领集(孤儿清扫不再命中)
      } else {
        completedDims.add(dimKey);
      }
    } catch (e) {
      res.failures.push(`${flow.id}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // R12/R13 孤儿清扫: 仅"配对模式且本趟 ≥1 条流成功完成(复用或新建)"的维度执行——
  // 增量模式维度绝不清扫(顺序绑定的兄弟事实/边不动); 配对维度全流失败也不清扫
  // (消除误差放大)。覆盖"绑定被移除后 refresh"场景: 只剩部分流, 残留事实随绑定消亡。
  const sweepAt = new Date();
  for (const key of processedDims) {
    if (incrementalDims.has(key)) continue;
    if (!completedDims.has(key)) continue;
    const sep = key.indexOf(':');
    const dimDoc = key.slice(0, sep);
    const dimEntity = key.slice(sep + 1) as OntologyEntityName;
    const rows = await listTradeFactsAsOf(
      ctx, asOfBusinessTime(sweepAt.toISOString()), { entityType: dimEntity }, userId,
    );
    for (const f of rows) {
      if (f.documentId === dimDoc && !claimedFactIds.has(f.id)) {
        await invalidateTradeFact(ctx, f.id, sweepAt, userId);
        await invalidateOntologyEdgesFromFact(ctx, dimEntity, f.id, sweepAt, userId);
      }
    }
  }
  return res;
}

/** settlement_records 行输入(Snake 列名按 DDL; ontology_fact_id 幂等经 DB 读判)。 */
export interface SettlementRecordInput {
  id: string;
  contract_no: string;
  contract_ledger_id?: string | null;
  settled_quantity?: number | null;
  quantity_unit?: string | null;
  currency?: string | null;
  total_amount: number;
  user_id?: string | null;
}

async function settlementWriteback(ctx: DbContext, id: string, uid: string): Promise<string | null> {
  const sql = `SELECT ontology_fact_id AS f FROM settlement_records WHERE id = ? AND ${USER_SCOPE}`;
  if (ctx.backend === 'postgres') {
    const res = await (ctx as PostgresDbContext).pool.query(numberPlaceholders(sql), [id, uid]);
    return (res.rows[0]?.f as string | null | undefined) ?? null;
  }
  const row = ctx.sqlite.prepare(sql).get(id, uid) as { f: string | null } | undefined;
  return row?.f ?? null;
}

async function writebackSettlementId(ctx: DbContext, id: string, factId: string): Promise<void> {
  const sql = 'UPDATE settlement_records SET ontology_fact_id = ? WHERE id = ?';
  if (ctx.backend === 'postgres') {
    await (ctx as PostgresDbContext).pool.query(numberPlaceholders(sql), [factId, id]);
    return;
  }
  ctx.sqlite.prepare(sql).run(factId, id);
}

/** 校验 contract_ledger_id 解析到真实台账行(返回行主键; 解析失败返回 null)。 */
async function resolveLedgerRowId(ctx: DbContext, ledgerId: string, uid: string): Promise<string | null> {
  const sql = `SELECT id FROM contract_ledger WHERE id = ? AND ${USER_SCOPE} LIMIT 1`;
  if (ctx.backend === 'postgres') {
    const res = await (ctx as PostgresDbContext).pool.query(numberPlaceholders(sql), [ledgerId, uid]);
    return (res.rows[0]?.id as string | undefined) ?? null;
  }
  const row = ctx.sqlite.prepare(sql).get(ledgerId, uid) as { id: string } | undefined;
  return row?.id ?? null;
}

/** settlement_records -> SettlementEvent 事实 + ALLOCATE_TO(金额归属)边 + 回写; 幂等。 */
export async function materializeSettlementRecord(
  ctx: DbContext, record: SettlementRecordInput, userId?: string,
): Promise<{ factId: string | null; created: boolean }> {
  const uid = effectiveUserId(userId);
  const existing = await settlementWriteback(ctx, record.id, uid);
  if (existing) return { factId: existing, created: false };
  const payload: Record<string, unknown> = {
    eventBizType: '正向',
    amount: record.total_amount,
    currency: record.currency ?? 'CNY',
    ...(record.settled_quantity != null ? { settledQuantity: record.settled_quantity } : {}),
    ...(record.contract_no ? { contractNo: record.contract_no } : {}),
  };
  const validAt = new Date();
  const factId = await insertTradeFact(ctx, {
    entityType: 'SettlementEvent', payload, validAt, createdBy: 'materializer',
  }, userId);
  // 结算归属走 payload.contractNo（wave4 两路口径）；注册表连接对白名单是 SSOT，
  // SettlementEvent->TradeContract 当前不在 ALLOCATE_TO 合法对内，不建边（守卫防 throw）。
  // Wave 4 放开连接对前置条件: id 必须为台账行主键——先解析 contract_ledger_id 到行。
  const ledgerId = record.contract_ledger_id
    ? await resolveLedgerRowId(ctx, record.contract_ledger_id, uid)
    : null;
  if (ledgerId && isRelationPairAllowed('ALLOCATE_TO', 'SettlementEvent', 'TradeContract')) {
    await insertOntologyEdge(ctx, {
      relation: 'ALLOCATE_TO', fromType: 'SettlementEvent', fromId: factId,
      toType: 'TradeContract', toId: ledgerId,
      params: { amount: record.total_amount, method: '金额' }, validAt, createdBy: 'materializer',
    }, userId);
  }
  await writebackSettlementId(ctx, record.id, factId);
  return { factId, created: true };
}

// safe 包装: 永不抛出(挂点消费方 fire-and-forget); 成功路径末尾触发图投影。
export async function materializeDocumentOntologySafe(
  ctx: DbContext, docId: string, userId?: string,
): Promise<void> {
  try {
    await materializeDocumentOntology(ctx, docId, userId);
    void syncOntologyGraphSafe(ctx, userId);
  } catch (e) {
    console.warn('[materialize] document materialization failed (swallowed):',
      e instanceof Error ? e.message : e);
  }
}

export async function materializeSettlementRecordSafe(
  ctx: DbContext, record: SettlementRecordInput, userId?: string,
): Promise<void> {
  try {
    await materializeSettlementRecord(ctx, record, userId);
    void syncOntologyGraphSafe(ctx, userId);
  } catch (e) {
    console.warn('[materialize] settlement materialization failed (swallowed):',
      e instanceof Error ? e.message : e);
  }
}
