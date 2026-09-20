// business-loop Wave 2: execution_flows/settlement_records -> 本体事实+归属边。
// 铁律: 本体写入只经 repo 写入边界; safe 包装永不抛(钩子 fire-and-forget);
// 跳过计数不造假数据(W2-C: payType/invoiceNo 解析不到就跳)。
import type { DbContext, PostgresDbContext } from './db/client.js';
import {
  insertTradeFact, insertOntologyEdge, listTradeFactsAsOf,
  invalidateTradeFact, invalidateOntologyEdgesFromFact,
  type TradeFactRow,
} from '../ontology/repo.js';
import { syncOntologyGraphSafe } from '../ontology/graphSync.js';
import { isRelationPairAllowed, type OntologyEntityName } from '../ontology/index.js';
import { asOfBusinessTime, numberPlaceholders } from '../ontology/asof.js';
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

async function listPendingFlows(ctx: DbContext, docId: string, uid: string): Promise<FlowRow[]> {
  const sql = `SELECT * FROM execution_flows WHERE document_id = ? AND ontology_fact_id IS NULL AND ${USER_SCOPE}`;
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

/** R11: 同 documentId+entityType 的现行事实(业务时间 now 口径, 内存过滤 documentId)。 */
async function findCurrentFactForFlow(
  ctx: DbContext, docId: string, entity: OntologyEntityName, userId?: string,
): Promise<TradeFactRow | null> {
  const rows = await listTradeFactsAsOf(
    ctx, asOfBusinessTime(new Date().toISOString()), { entityType: entity }, userId,
  );
  return rows.find((f) => f.documentId === docId) ?? null;
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
  const flows = await listPendingFlows(ctx, docId, uid);
  res.attempted = flows.length;
  // 补充字段读取: 同文档最新 extraction(中文键 fields); 无 extraction 时 fields 为空。
  const extraction = await loadLatestExtractionByDocId(ctx, docId, userId);
  const fields = (extraction?.fields ?? {}) as Record<string, unknown>;

  for (const flow of flows) {
    const entity = FLOW_ENTITY[flow.flow_type]?.[flow.direction];
    if (!entity) { res.skippedNoMap += 1; continue; }
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
      const validAt = flow.voucher_date ?? new Date();
      // R11 refresh-proof: 同 documentId+entityType 现行事实存在时先判等价。
      const current = await findCurrentFactForFlow(ctx, docId, entity, userId);
      if (current) {
        if (payloadEquivalent(payload, current.payload)) {
          // 实质等价 -> 复用: 只回写 flow 认领, 不插新事实不插新边(计数不进 created)。
          await writebackFlowId(ctx, flow.id, current.id);
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
      }
    } catch (e) {
      res.failures.push(`${flow.id}: ${e instanceof Error ? e.message : String(e)}`);
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
