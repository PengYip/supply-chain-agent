// apps/server/src/overview/metrics.ts
// 总览工作台聚合层（roadmap Item 7, 2026-09-08）。只读：纯规则函数 + DB 装配，
// 全部走既有 SSOT 读路径（repo.ts / projection.ts / writeoff.ts / sessionStore），
// 本模块绝不写任何表。异常规则 v1 两条（路线图 Item 7）：
//   a) 超合同量收货: GoodsReceiptEvent(正向) 按 ALLOCATE_TO 边挂合同, quantity
//      合计 > 合同数量（contract_ledger.fields 键序与 bindingProposal.ts:316 同源,
//      读字段值不猜单位）; 逆向(负数)收货不轧差(与核销余额 v1 口径一致)。
//   b) 无票付款拦截: 审批中心 L3 历史 reason 含「付款」关键词(扫描最新 200 条)。

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
