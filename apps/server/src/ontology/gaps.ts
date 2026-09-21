// 勾稽缺口聚合(Wave 4 Task 1, 对齐原型 reportGaps 金标准)。纯只读——只经 repo 读函数
// (listTradeFactsAsOf/listOntologyEdgesAsOf) 与 projection 合同解析, 不写任何表。
// 金额 EPSILON=0.005(对齐 writeoff.ts); DTO 金额 round 2 位; 某口径缺输入 -> null +
// missingInputs 标注, 不造数(R19)。合同归属两路: payload.contractNo(款/票/结算) 与
// ALLOCATE_TO 边(收/发货 -> 台账行 id)。
import type { DbContext } from '../pipeline/db/client.js';
import { listTradeFactsAsOf, listOntologyEdgesAsOf, type TradeFactRow } from './repo.js';
import { asOfBusinessTime } from './asof.js';
import { findContractRowById } from './projection.js';
import { findContractLedgerByNo } from '../pipeline/db/repositories.js';
import { effectiveUserId } from '../pipeline/db/repositories.js';

export interface GapItem {
  code: string;
  label: string;
  qty?: number | null;
  amt?: number | null;
  basis: string;
  missingInputs?: string[];
}

export interface GapGroup {
  key: 'stock' | 'recv' | 'pay' | 'mis';
  label: string;
  desc: string;
  items: GapItem[];
}

export interface GapTile {
  key: string;
  label: string;
  qty?: number | null;
  amt?: number | null;
  hint?: string;
}

export interface GapsReport {
  scope: string;
  tiles: GapTile[];
  groups: GapGroup[];
  checks: string[];
}

const EPSILON = 0.005;
const R2 = (n: number): number => Math.round(n * 100) / 100;
/** 近零判断: |x| < EPSILON 视为噪声归 0 展示(对齐 writeoff.ts 口径)。 */
const nearZero = (x: number): boolean => Math.abs(x) < EPSILON;

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** 合同侧判定: contract_type 含"销"=销侧; 含"采/购"=购侧; 双侧同含(购销合同)
 *  或无法判定 -> null(计入 missingInputs 口径提示, 不得任一先命中就定侧)。 */
function sideOf(contractType: string | null | undefined): 'buy' | 'sell' | null {
  if (!contractType) return null;
  const sell = contractType.includes('销');
  const buy = contractType.includes('采') || contractType.includes('购');
  if (sell && buy) return null; // 购销合同 等混合口径: 侧别不明, 不猜侧
  if (sell) return 'sell';
  if (buy) return 'buy';
  return null;
}

const fmt = (n: number): string => Math.round(n).toLocaleString('en-US');

interface ContractAgg {
  id: string;
  contractNo: string;
  side: 'buy' | 'sell' | null;
  receiptsQty: number;
  receiptsQtyMissing: boolean;
  receiptsAmt: number;
  receiptsAmtMissing: boolean;
  deliveriesQty: number;
  deliveriesQtyMissing: boolean;
  deliveriesAmt: number;
  deliveriesAmtMissing: boolean;
  settlements: number;
  invoicesIn: number;
  invoicesOut: number;
  payments: number;
  paymentsNonPrepay: number;
  paymentsMissing: boolean;
  collections: number;
}

function mkAgg(id: string, contractNo: string, side: 'buy' | 'sell' | null): ContractAgg {
  return {
    id, contractNo, side,
    receiptsQty: 0, receiptsQtyMissing: false, receiptsAmt: 0, receiptsAmtMissing: false,
    deliveriesQty: 0, deliveriesQtyMissing: false, deliveriesAmt: 0, deliveriesAmtMissing: false,
    settlements: 0, invoicesIn: 0, invoicesOut: 0,
    payments: 0, paymentsNonPrepay: 0, paymentsMissing: false, collections: 0,
  };
}

/** 某口径缺输入 -> 该项 null + missingInputs 标注(R19), 不造数。
 *  sideUnknown 为侧别无法判定的合同号列表——口径缺但数据在, 值照算、missingInputs
 *  非空提示口径不完整(不置 null)。 */
function annotateSide(
  value: number,
  baseMissing: string[],
  sideUnknown: string[],
): { amt: number | null; missingInputs?: string[] } {
  const note = sideUnknown.length > 0 ? `合同侧别无法判定: ${sideUnknown.join('/')}` : null;
  const inputs = baseMissing.length > 0 ? [...baseMissing, ...(note ? [note] : [])] : [];
  if (inputs.length > 0) return { amt: null, missingInputs: inputs }; // 真缺输入 -> null(R19)
  return note ? { amt: R2(value), missingInputs: [note] } : { amt: R2(value) }; // 仅口径缺 -> 值照算+标注
}

/**
 * 勾稽缺口(对齐原型 reportGaps, W4-A)。opts.projectNo 时经 BELONGS_TO 反查合同集合,
 * 无 projectNo = 全部合同。user 隔离沿 repo 模式。
 */
export async function computeGaps(
  ctx: DbContext,
  opts: { projectNo?: string } = {},
  userId?: string,
): Promise<GapsReport> {
  const uid = effectiveUserId(userId);
  const now = new Date().toISOString();
  const pred = asOfBusinessTime(now);
  const facts = await listTradeFactsAsOf(ctx, pred, {}, userId);
  const allocEdges = await listOntologyEdgesAsOf(ctx, pred, { relation: 'ALLOCATE_TO' }, userId);

  // projectNo 范围: BELONGS_TO 边(TradeContract 台账行id -> TradeProject 事实) 反查合同集合。
  let contractScope: Set<string> | null = null;
  if (opts.projectNo) {
    const belongs = await listOntologyEdgesAsOf(ctx, pred, { relation: 'BELONGS_TO' }, userId);
    const projectByFact = new Map(facts.map((f) => [f.id, f]));
    contractScope = new Set<string>();
    for (const e of belongs) {
      if (e.fromType !== 'TradeContract') continue;
      const proj = projectByFact.get(e.toId);
      if (proj && proj.payload['projectNo'] === opts.projectNo) contractScope.add(e.fromId);
    }
  }

  // 合同解析缓存: 台账行 id -> {contractNo, side}。
  const contractCache = new Map<string, { contractNo: string; side: 'buy' | 'sell' | null }>();
  const resolveByEdge = async (toId: string): Promise<{ contractNo: string; side: 'buy' | 'sell' | null } | null> => {
    const hit = contractCache.get(toId);
    if (hit) return hit;
    const row = await findContractRowById(ctx, toId, uid);
    if (!row) return null;
    const resolved = { contractNo: String(row.fields['contractNo'] ?? toId), side: sideOf(String(row.fields['contractType'] ?? '')) };
    contractCache.set(toId, resolved);
    return resolved;
  };
  // resolveByNo 缓存(镜像 resolveByEdge 惯例): contractNo -> resolved。款/票/结算
  // 事实同一合同号反复命中, 避免每行重复查台账。
  const contractNoCache = new Map<string, { id: string; contractNo: string; side: 'buy' | 'sell' | null }>();
  const resolveByNo = async (contractNo: string): Promise<{ id: string; contractNo: string; side: 'buy' | 'sell' | null } | null> => {
    const hit = contractNoCache.get(contractNo);
    if (hit) return hit;
    const entry = await findContractLedgerByNo(ctx, contractNo, userId);
    if (!entry) return null;
    const resolved = { id: entry.id, contractNo: entry.contractNo, side: sideOf(entry.contractType as string | null) };
    contractNoCache.set(contractNo, resolved);
    contractCache.set(entry.id, resolved);
    return resolved;
  };

  const aggs = new Map<string, ContractAgg>();
  for (const f of facts) {
    const p = f.payload as Record<string, unknown>;
    let cid: string | null = null;
    let contractNo: string | null = null;
    let side: 'buy' | 'sell' | null = null;
    if (f.entityType === 'GoodsReceiptEvent' || f.entityType === 'GoodsDeliveryEvent') {
      // 收/发货归属走 ALLOCATE_TO 边(-> 台账行 id)。
      const edge = allocEdges.find((e) => e.fromId === f.id);
      if (edge) {
        const c = await resolveByEdge(edge.toId);
        if (c) { cid = edge.toId; contractNo = c.contractNo; side = c.side; }
      }
    } else {
      // 款/票/结算归属走 payload.contractNo。
      const no = typeof p['contractNo'] === 'string' && p['contractNo'] !== '' ? p['contractNo'] : null;
      if (no) {
        const c = await resolveByNo(no);
        if (c) { cid = c.id; contractNo = c.contractNo; side = c.side; }
      }
    }
    if (!cid || !contractNo) continue; // 未归属合同的事实不参与聚合
    if (contractScope && !contractScope.has(cid)) continue; // projectNo 过滤
    const agg = aggs.get(cid) ?? mkAgg(cid, contractNo, side);
    switch (f.entityType) {
      case 'GoodsReceiptEvent': {
        const q = num(p['quantity']);
        if (q !== null) agg.receiptsQty += q; else agg.receiptsQtyMissing = true;
        const a = num(p['amount']);
        if (a !== null) agg.receiptsAmt += a; else agg.receiptsAmtMissing = true;
        break;
      }
      case 'GoodsDeliveryEvent': {
        const q = num(p['quantity']);
        if (q !== null) agg.deliveriesQty += q; else agg.deliveriesQtyMissing = true;
        const a = num(p['amount']);
        if (a !== null) agg.deliveriesAmt += a; else agg.deliveriesAmtMissing = true;
        break;
      }
      case 'SettlementEvent': {
        const a = num(p['amount']);
        if (a !== null) agg.settlements += a;
        break;
      }
      case 'InvoiceEvent': {
        const a = num(p['amount']);
        if (a === null) break;
        if (p['invoiceType'] === '进项') agg.invoicesIn += a;
        else if (p['invoiceType'] === '销项') agg.invoicesOut += a; // 红冲负数自然轧差
        break;
      }
      case 'PaymentEvent': {
        const a = num(p['amount']);
        if (a === null) { agg.paymentsMissing = true; break; }
        agg.payments += a; // 退款负数自然轧差
        // ⑦⑨ 用非预付付款净(结算/收票未付只抵尾款类——预付属收货前货款, 不抵结算);
        // ⑧⑩ 用全部付款净。原型 reportGaps 金标准口径。
        if (p['payType'] !== '预付') agg.paymentsNonPrepay += a;
        break;
      }
      case 'CollectionEvent': {
        const a = num(p['amount']);
        if (a !== null) agg.collections += a;
        break;
      }
      default:
        break;
    }
    aggs.set(cid, agg);
  }

  // 全局/侧向合计。
  const all = {
    allReceiptQty: 0, allReceiptQtyMissing: false, allDeliveryQty: 0, allDeliveryQtyMissing: false,
    buyReceiptAmt: 0, buyReceiptAmtMissing: false, buySettlement: 0, buyInvoicesIn: 0,
    buyPayments: 0, buyPaymentsMissing: false, buyPaymentsNonPrepay: 0,
    sellDeliveryAmt: 0, sellDeliveryAmtMissing: false, sellSettlement: 0, sellInvoicesOut: 0,
    sellCollections: 0,
  };
  for (const agg of aggs.values()) {
    if (agg.receiptsQtyMissing) all.allReceiptQtyMissing = true; else all.allReceiptQty += agg.receiptsQty;
    if (agg.deliveriesQtyMissing) all.allDeliveryQtyMissing = true; else all.allDeliveryQty += agg.deliveriesQty;
    if (agg.side === 'buy') {
      if (agg.receiptsAmtMissing) all.buyReceiptAmtMissing = true; else all.buyReceiptAmt += agg.receiptsAmt;
      all.buySettlement += agg.settlements;
      all.buyInvoicesIn += agg.invoicesIn;
      if (agg.paymentsMissing) all.buyPaymentsMissing = true; else all.buyPayments += agg.payments;
      all.buyPaymentsNonPrepay += agg.paymentsNonPrepay;
    } else if (agg.side === 'sell') {
      if (agg.deliveriesAmtMissing) all.sellDeliveryAmtMissing = true; else all.sellDeliveryAmt += agg.deliveriesAmt;
      all.sellSettlement += agg.settlements;
      all.sellInvoicesOut += agg.invoicesOut;
      all.sellCollections += agg.collections;
    }
  }

  // W4-R1: 侧别无法判定的合同(contract_type 开放词不命中销/采购)计入 sideUnknown——
  // 其数据不在侧向合计内; 相关侧向项 missingInputs 提示口径不完整(值照算, 不置 null)。
  const sideUnknown = [...aggs.values()].filter((a) => a.side === null).map((a) => a.contractNo);

  // 11 项勾稽。
  const items: GapItem[] = [];
  const checks: string[] = [];

  // ① 已采购未销售(全局口径 R18, 不需侧别)
  {
    const qtyInputs = all.allReceiptQtyMissing ? ['收货数量'] : [];
    if (all.allDeliveryQtyMissing) qtyInputs.push('发货数量');
    if (qtyInputs.length > 0) {
      items.push({ code: '①', label: '已采购未销售', qty: null, basis: 'Σ收货 − Σ发货', missingInputs: qtyInputs });
    } else {
      const q = all.allReceiptQty - all.allDeliveryQty;
      items.push({ code: '①', label: '已采购未销售', qty: R2(q), basis: 'Σ收货 − Σ发货' });
      checks.push(`① ${fmt(q)}t = Σ收货 ${fmt(all.allReceiptQty)} − Σ发货 ${fmt(all.allDeliveryQty)}`);
    }
  }
  // ② 已收货未结算(购侧)
  {
    const r = annotateSide(all.buyReceiptAmt - all.buySettlement, all.buyReceiptAmtMissing ? ['购收金额'] : [], sideUnknown);
    items.push({ code: '②', label: '已收货未结算', ...(r.amt === null ? { amt: null, missingInputs: r.missingInputs } : { amt: r.amt, ...(r.missingInputs ? { missingInputs: r.missingInputs } : {}) }), basis: 'Σ购收amt − Σ购结算' });
    if (r.amt !== null && !r.missingInputs) checks.push(`② ${fmt(r.amt)} = Σ购收amt ${fmt(all.buyReceiptAmt)} − Σ购结算 ${fmt(all.buySettlement)}`);
  }
  // ③ 已发货未结算(销侧)
  {
    const r = annotateSide(all.sellDeliveryAmt - all.sellSettlement, all.sellDeliveryAmtMissing ? ['销发金额'] : [], sideUnknown);
    items.push({ code: '③', label: '已发货未结算', ...(r.amt === null ? { amt: null, missingInputs: r.missingInputs } : { amt: r.amt, ...(r.missingInputs ? { missingInputs: r.missingInputs } : {}) }), basis: 'Σ销发amt − Σ销结算' });
    if (r.amt !== null && !r.missingInputs) checks.push(`③ ${fmt(r.amt)} = Σ销发amt ${fmt(all.sellDeliveryAmt)} − Σ销结算 ${fmt(all.sellSettlement)}`);
  }
  // ④ 结算未收(销侧)
  {
    const r = annotateSide(all.sellSettlement - all.sellCollections, [], sideUnknown);
    items.push({ code: '④', label: '结算未收', ...(r.amt === null ? { amt: null, missingInputs: r.missingInputs } : { amt: r.amt, ...(r.missingInputs ? { missingInputs: r.missingInputs } : {}) }), basis: 'Σ销结算 − Σ收款' });
    if (r.amt !== null && !r.missingInputs) checks.push(`④ ${fmt(r.amt)} = Σ销结算 ${fmt(all.sellSettlement)} − Σ收款 ${fmt(all.sellCollections)}`);
  }
  // ⑤ 发货未收(销侧)
  {
    const r = annotateSide(all.sellDeliveryAmt - all.sellCollections, all.sellDeliveryAmtMissing ? ['销发金额'] : [], sideUnknown);
    items.push({ code: '⑤', label: '发货未收', ...(r.amt === null ? { amt: null, missingInputs: r.missingInputs } : { amt: r.amt, ...(r.missingInputs ? { missingInputs: r.missingInputs } : {}) }), basis: 'Σ销发amt − Σ收款' });
    if (r.amt !== null && !r.missingInputs) checks.push(`⑤ ${fmt(r.amt)} = Σ销发amt ${fmt(all.sellDeliveryAmt)} − Σ收款 ${fmt(all.sellCollections)}`);
  }
  // ⑥ 开票未收(销侧)
  {
    const r = annotateSide(all.sellInvoicesOut - all.sellCollections, [], sideUnknown);
    items.push({ code: '⑥', label: '开票未收', ...(r.amt === null ? { amt: null, missingInputs: r.missingInputs } : { amt: r.amt, ...(r.missingInputs ? { missingInputs: r.missingInputs } : {}) }), basis: '净销项 − Σ收款' });
    if (r.amt !== null && !r.missingInputs) checks.push(`⑥ ${fmt(r.amt)} = 净销项 ${fmt(all.sellInvoicesOut)} − Σ收款 ${fmt(all.sellCollections)}`);
  }
  // ⑦ 结算未付(购侧, 结算口径; 只抵非预付付款——原型金标准)
  {
    const r = annotateSide(all.buySettlement - all.buyPaymentsNonPrepay, [], sideUnknown);
    items.push({ code: '⑦', label: '结算未付', ...(r.amt === null ? { amt: null, missingInputs: r.missingInputs } : { amt: r.amt, ...(r.missingInputs ? { missingInputs: r.missingInputs } : {}) }), basis: 'Σ购结算 − Σ非预付付款' });
    if (r.amt !== null && !r.missingInputs) checks.push(`⑦ ${fmt(r.amt)} = Σ购结算 ${fmt(all.buySettlement)} − Σ非预付付款 ${fmt(all.buyPaymentsNonPrepay)}`);
  }
  // ⑧ 收货未付(购侧)
  {
    const r = annotateSide(all.buyReceiptAmt - all.buyPayments, all.buyReceiptAmtMissing ? ['购收金额'] : [], sideUnknown);
    items.push({ code: '⑧', label: '收货未付', ...(r.amt === null ? { amt: null, missingInputs: r.missingInputs } : { amt: r.amt, ...(r.missingInputs ? { missingInputs: r.missingInputs } : {}) }), basis: 'Σ购收amt − Σ付款净' });
    if (r.amt !== null && !r.missingInputs) checks.push(`⑧ ${fmt(r.amt)} = Σ购收amt ${fmt(all.buyReceiptAmt)} − Σ付款净 ${fmt(all.buyPayments)}`);
  }
  // ⑨ 收票未付(购侧; ⑨=⑦)
  {
    const r = annotateSide(all.buyInvoicesIn - all.buyPaymentsNonPrepay, [], sideUnknown);
    items.push({ code: '⑨', label: '收票未付', ...(r.amt === null ? { amt: null, missingInputs: r.missingInputs } : { amt: r.amt, ...(r.missingInputs ? { missingInputs: r.missingInputs } : {}) }), basis: 'Σ进项 − Σ非预付付款' });
    if (r.amt !== null && !r.missingInputs) checks.push(`⑨ ${fmt(r.amt)} = Σ进项 ${fmt(all.buyInvoicesIn)} − Σ非预付付款 ${fmt(all.buyPaymentsNonPrepay)}`);
  }
  // ⑩ 付无票(错配; EPSILON 近零归 0 展示)
  {
    const raw = Math.abs(all.buyPayments - all.buyInvoicesIn);
    const shown = nearZero(raw) ? 0 : raw;
    const r = annotateSide(shown, [], sideUnknown);
    items.push({ code: '⑩', label: '付无票', ...(r.amt === null ? { amt: null, missingInputs: r.missingInputs } : { amt: r.amt, ...(r.missingInputs ? { missingInputs: r.missingInputs } : {}) }), basis: '|付款净 − Σ进项|' });
    if (r.amt !== null && !r.missingInputs) checks.push(`⑩ ${fmt(r.amt)} = |付款净 ${fmt(all.buyPayments)} − Σ进项 ${fmt(all.buyInvoicesIn)}|`);
  }
  // ⑪ 收无票(错配; EPSILON 近零归 0 展示)
  {
    const raw = Math.abs(all.sellCollections - all.sellInvoicesOut);
    const shown = nearZero(raw) ? 0 : raw;
    const r = annotateSide(shown, [], sideUnknown);
    items.push({ code: '⑪', label: '收无票', ...(r.amt === null ? { amt: null, missingInputs: r.missingInputs } : { amt: r.amt, ...(r.missingInputs ? { missingInputs: r.missingInputs } : {}) }), basis: '|Σ收款 − 净销项|' });
    if (r.amt !== null && !r.missingInputs) checks.push(`⑪ ${fmt(r.amt)} = |Σ收款 ${fmt(all.sellCollections)} − 净销项 ${fmt(all.sellInvoicesOut)}|`);
  }

  const stockItems = items.filter((i) => ['①', '②', '③'].includes(i.code));
  const recvItems = items.filter((i) => ['④', '⑤', '⑥'].includes(i.code));
  const payItems = items.filter((i) => ['⑦', '⑧', '⑨'].includes(i.code));
  const misItems = items.filter((i) => ['⑩', '⑪'].includes(i.code));

  const tileOf = (code: string) => items.find((i) => i.code === code);
  const stockTile = tileOf('①');
  const recvTile = tileOf('⑤');
  const payTile = tileOf('⑦');
  const misAmt = (tileOf('⑩')?.amt ?? 0) + (tileOf('⑪')?.amt ?? 0);

  return {
    scope: opts.projectNo ?? 'all',
    tiles: [
      { key: 'stock', label: '存货结存', qty: stockTile?.qty ?? null, hint: '已采购未销售(数量, R18 全局口径)' },
      { key: 'recv', label: '应收未收', amt: recvTile?.amt ?? null, hint: '发货口径(⑤ 发货未收)' },
      { key: 'pay', label: '应付未付', amt: payTile?.amt ?? null, hint: '结算口径(⑦ 结算未付)' },
      { key: 'mis', label: '票款错配', amt: R2(misAmt), hint: '付无票 + 收无票' },
    ],
    groups: [
      { key: 'stock', label: '存货缺口', desc: '采购收货与销售发货的数量/金额勾稽', items: stockItems },
      { key: 'recv', label: '应收缺口', desc: '销售侧结算/发货/开票与收款的勾稽', items: recvItems },
      { key: 'pay', label: '应付缺口', desc: '采购侧结算/收货/收票与付款的勾稽', items: payItems },
      { key: 'mis', label: '票款错配', desc: '付款/收款与进销项票的绝对差异', items: misItems },
    ],
    checks,
  };
}
