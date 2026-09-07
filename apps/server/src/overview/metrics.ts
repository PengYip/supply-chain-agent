// apps/server/src/overview/metrics.ts
// 总览工作台聚合层（roadmap Item 7, 2026-09-08）。只读：纯规则函数 + DB 装配，
// 全部走既有 SSOT 读路径（repo.ts / projection.ts / writeoff.ts / sessionStore），
// 本模块绝不写任何表。异常规则 v1 两条（路线图 Item 7）：
//   a) 超合同量收货: GoodsReceiptEvent(正向) 按 ALLOCATE_TO 边挂合同, quantity
//      合计 > 合同数量（contract_ledger.fields 键序与 bindingProposal.ts:316 同源,
//      读字段值不猜单位）; 逆向(负数)收货不轧差(与核销余额 v1 口径一致)。
//   b) 无票付款拦截: 审批中心 L3 历史 reason 含「付款」关键词(扫描最新 200 条)。
import type { DbContext } from '../pipeline/db/client.js';
import { asOfBusinessTime } from '../ontology/asof.js';
import {
  listTradeFactsAsOf, listOntologyEdgesAsOf,
  type TradeFactRow, type OntologyEdgeRow,
} from '../ontology/repo.js';
import { listWriteoffBalances } from '../ontology/writeoff.js';
import { listApprovals, countApprovals, type ApprovalListItem } from '../harness/sessionStore.js';
import { listContractLedgerRefs } from '../ontology/projection.js';

// ---- 异常规则 a: 超合同量收货 ---------------------------------------------

export interface OverReceiptAnomaly {
  contractId: string;      // contract_ledger 行 id
  contractNo: string;
  contractQty: number;
  receivedQty: number;     // 正向收货 quantity 合计
}

const num = (v: unknown): number | null =>
  (typeof v === 'number' && Number.isFinite(v) ? v : null);

export function overReceiptViolations(
  contracts: Array<{ id: string; contractNo: string; qty: number | null }>,
  receipts: Array<{ id: string; quantity: number | null; bizType: string | null }>,
  allocEdges: Array<{ fromId: string; toType: string; toId: string }>,
): OverReceiptAnomaly[] {
  // 收货量合计（正向、有数量）按边端点归到合同。
  const receiptQty = new Map<string, number>();
  const receiptById = new Map(receipts.map((r) => [r.id, r]));
  for (const e of allocEdges) {
    if (e.toType !== 'TradeContract') continue;
    const r = receiptById.get(e.fromId);
    if (!r) continue;
    if (r.bizType !== '正向') continue;
    const q = num(r.quantity);
    if (q == null) continue;
    receiptQty.set(e.toId, (receiptQty.get(e.toId) ?? 0) + q);
  }
  const out: OverReceiptAnomaly[] = [];
  for (const c of contracts) {
    if (c.qty == null || c.qty <= 0) continue; // 合同数量缺失/0：不参与判定
    const received = receiptQty.get(c.id);
    if (received == null) continue;
    if (received > c.qty) {
      out.push({ contractId: c.id, contractNo: c.contractNo, contractQty: c.qty, receivedQty: received });
    }
  }
  return out;
}

// ---- 异常规则 b: 无票付款拦截 ---------------------------------------------

export interface PaymentBlockAnomaly {
  id: string;              // pending_approvals.id
  ticketId: string | null;
  reason: string | null;
  createdAt: string;
}

const PAYMENT_BLOCK_KEYWORD = '付款';

export function isPaymentBlockReason(reason: string | null | undefined): boolean {
  return typeof reason === 'string' && reason.includes(PAYMENT_BLOCK_KEYWORD);
}

// ---- 装配层（每卡片独立错误切片） ------------------------------------------

export type MetricsSource = 'local' | 'cube';
export type CardResult<T> = { status: 'ok'; data: T } | { status: 'error'; error: string };

export interface ExecutionRateMetric { total: number; executed: number; rate: number | null }
export interface PendingWriteoffMetric { amount: number; rows: number }

export interface OverviewCards {
  pendingApprovals: CardResult<{ count: number }>;
  overReceipt: CardResult<{ anomalies: OverReceiptAnomaly[]; scannedContracts: number }>;
  paymentBlocks: CardResult<{ records: PaymentBlockAnomaly[]; scanLimit: number }>;
  executionRate: CardResult<ExecutionRateMetric>;
  pendingWriteoff: CardResult<PendingWriteoffMetric>;
}

export interface OverviewPayload {
  source: MetricsSource;
  asOf: string;
  note: string | null;
  cards: OverviewCards | null;
}

/** METRICS_SOURCE=cube 时的预留位载荷（路线图 OUT：Cube 实际接入不做）。 */
export function cubePlaceholderPayload(asOf: string): OverviewPayload {
  return {
    source: 'cube',
    asOf,
    note: 'METRICS_SOURCE=cube：Cube 数据源位已预留、未接入，本地聚合未执行。',
    cards: null,
  };
}

async function safeCard<T>(fn: () => Promise<T>): Promise<CardResult<T>> {
  try {
    return { status: 'ok', data: await fn() };
  } catch (e) {
    return { status: 'error', error: e instanceof Error ? e.message : String(e) };
  }
}

/** 合同数量键序与 bindingProposal.ts:316 同源（读字段值，不猜单位）。 */
function contractQtyOf(fields: Record<string, unknown>): number | null {
  for (const key of ['数量', '合同数量', '数量_吨']) {
    const v = num(fields[key]);
    if (v != null) return v;
  }
  return null;
}

export const PAYMENT_BLOCK_SCAN_LIMIT = 200;

export async function buildOverviewMetrics(ctx: DbContext, userId?: string): Promise<OverviewPayload> {
  const asOf = new Date().toISOString();
  const pred = asOfBusinessTime(asOf);

  const pendingApprovals = await safeCard(async () => ({
    count: await countApprovals({ userId: userId!, status: 'pending' }),
  }));

  const overReceipt = await safeCard(async () => {
    const contracts = await listContractLedgerRefs(ctx, userId!);
    const receipts = await listTradeFactsAsOf(ctx, pred, { entityType: 'GoodsReceiptEvent' }, userId);
    const edges = await listOntologyEdgesAsOf(ctx, pred, { relation: 'ALLOCATE_TO' }, userId);
    const anomalies = overReceiptViolations(
      contracts.map((c) => ({
        id: c.id,
        contractNo: c.contractNo,
        qty: contractQtyOf(c.extracted),
      })),
      receipts.map((r: TradeFactRow) => ({
        id: r.id,
        quantity: num((r.payload as Record<string, unknown>)['quantity']),
        bizType: (r.payload as Record<string, unknown>)['eventBizType'] as string | null,
      })),
      edges.map((e: OntologyEdgeRow) => ({ fromId: e.fromId, toType: e.toType, toId: e.toId })),
    );
    return { anomalies, scannedContracts: contracts.length };
  });

  const paymentBlocks = await safeCard(async () => {
    const rows: ApprovalListItem[] =
      await listApprovals({ userId: userId!, status: 'all', limit: PAYMENT_BLOCK_SCAN_LIMIT });
    const records: PaymentBlockAnomaly[] = rows
      .filter((r) => r.level === 'L3' && isPaymentBlockReason(r.reason))
      .map((r) => ({ id: r.id, ticketId: r.ticket_id, reason: r.reason ?? null, createdAt: r.created_at }));
    return { records, scanLimit: PAYMENT_BLOCK_SCAN_LIMIT };
  });

  const executionRate = await safeCard(async () => {
    const contracts = await listContractLedgerRefs(ctx, userId!);
    const edges = await listOntologyEdgesAsOf(ctx, pred, { relation: 'ALLOCATE_TO' }, userId);
    const executedIds = new Set(
      edges.filter((e) => e.toType === 'TradeContract').map((e) => e.toId),
    );
    const total = contracts.length;
    const executed = contracts.filter((c) => executedIds.has(c.id)).length;
    return { total, executed, rate: total > 0 ? executed / total : null };
  });

  const pendingWriteoff = await safeCard(async () => {
    const rows = await listWriteoffBalances(ctx, userId);
    const funds = rows.filter((r) =>
      (r.entityType === 'PaymentEvent' || r.entityType === 'CollectionEvent') && r.status !== 'full');
    return { amount: funds.reduce((acc, r) => acc + Math.max(0, r.remaining), 0), rows: funds.length };
  });

  return {
    source: 'local',
    asOf,
    note: null,
    cards: { pendingApprovals, overReceipt, paymentBlocks, executionRate, pendingWriteoff },
  };
}
