// 对账面板聚合(spec 2026-09-09 §15): GET /api/contracts/:contractNo/flow-panel 的
// 数据源。L1 只读——纯 SELECT 聚合 bindings/execution_flows/settlement_records/
// trade_facts + ontology_edges 核销 completeness, 绝不写库。
// 数字证据纪律: 每个非 pending 里程碑必带 evidenceIds(流水/事实/结算/边 id),
// 明细 breakdown 逐笔可溯; 端点层不做推算性补数——缺数据输出 null/reason,
// 派生数字(在途/库存=收发差)全部注明口径。
import type { DbContext } from './db/client.js';
import {
  findContractLedgerByNo, listExecutionFlows, listSettlementRecords,
  listGraphLinks, getDocumentSourcesByIds, effectiveUserId,
  type ExecutionFlowRow,
} from './db/repositories.js';
import { normalizeContractNo, type ContractLedgerEntry } from './contractLedger.js';
import { computeExecutionProgress } from './executionProgress.js';
import { flowNodeTier } from '../domain/tradeSemantics.js';
import { parseCnDate } from './bindingProposal.js';
import { normalizeName } from '../graph/normalize.js';
import { listTradeFactsAsOf, listOntologyEdgesAsOf, type TradeFactRow } from '../ontology/repo.js';
import { asOfBusinessTime } from '../ontology/asof.js';
import { listContractLedgerRefs } from '../ontology/projection.js';

// ---------------------------------------------------------------------------
// DTO（路由直接透出; web api/flowPanel.ts 镜像同构类型）
// ---------------------------------------------------------------------------

export type FlowLane = 'goods' | 'title' | 'funds' | 'invoice';
export type MilestoneStatus = 'done' | 'ongoing' | 'pending' | 'abnormal';
/** 四泳道共享节点轴(spec §15: 上游 -> 在途 -> 我方 -> 下游)。 */
export type FlowNode = '上游' | '在途' | '我方' | '下游';

export interface FlowPanelAmount { value: number; currency: string }

export interface FlowPanelBreakdownRow {
  label: string;
  quantity: { value: number; unit: string } | null;
  amount: FlowPanelAmount | null;
  date: string | null;
  evidenceIds: string[];
  documentId: string | null;
}

export interface FlowPanelMilestone {
  key: string;
  lane: FlowLane;
  node: FlowNode;
  label: string;
  status: MilestoneStatus;
  quantity: { value: number; unit: string } | null;
  amount: FlowPanelAmount | null;
  date: string | null;
  count: number;
  evidenceIds: string[];
  note: string | null;
  breakdown: FlowPanelBreakdownRow[];
}

export interface TitleTransferPoint {
  factId: string;
  /** 收货事件=转入(in) / 发货事件=转出(out)。 */
  direction: 'in' | 'out';
  /** titleTransfer 口径原文(发货即转/签收转/验收转/到岸转, v1 开放文本)。 */
  caliber: string;
  /** 转移时点 = titleTransferAt ?? validAt。 */
  at: string;
  quantity: { value: number; unit: string } | null;
  documentId: string | null;
}

export type FlowPanelAlertCode =
  | 'delivery-overdue' | 'draft-survey-tolerance' | 'invoice-funds-mismatch';

export interface FlowPanelAlert {
  code: FlowPanelAlertCode;
  level: 'warn' | 'info';
  message: string;
  evidenceIds: string[];
  /** 红圈联动: 被本告警覆盖的泳道里程碑 key(spec §15 告警同步标在节点上)。 */
  milestoneKeys: string[];
}

export interface FlowPanelContractRef { contractNo: string; displayContractNo: string; title: string }

export interface FlowPanelDocRef { fileName: string; minioKey: string | null }

export interface FlowPanelResult {
  contractNo: string;
  displayContractNo: string;
  /** 合同标题(台账 title 字段); 权泳道键名为 title, 二者并存故此处改名。 */
  contractTitle: string;
  asOf: string;
  basis: { quantity: number; unit: string } | null;
  progress: number | null;
  progressReason: string | null;
  goods: FlowPanelMilestone[];
  title: {
    /** 当前货权归属(色带); null=事件存在但无 titleTransfer 口径, 不猜。 */
    currentHolder: '上游' | '我方' | '下游' | null;
    note: string | null;
    transferPoints: TitleTransferPoint[];
    milestones: FlowPanelMilestone[];
  };
  funds: FlowPanelMilestone[];
  invoice: FlowPanelMilestone[];
  alerts: FlowPanelAlert[];
  netPosition: {
    currencies: Array<{ currency: string; paid: number; received: number; netOccupancy: number }>;
    invoices: Array<{ currency: string; inAmount: number; outAmount: number }>;
  };
  correlates: FlowPanelContractRef[];
  documents: Record<string, FlowPanelDocRef>;
}

// ---------------------------------------------------------------------------
// 内部工具
// ---------------------------------------------------------------------------

const EPSILON = 0.005;
const DAY_MS = 86_400_000;

const datePrefix = (iso: string | null | undefined): string => (iso ? iso.slice(0, 10) : '');
const shortId = (id: string): string => id.slice(-6);

const num = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;

const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);

function fieldText(entry: ContractLedgerEntry, keys: readonly string[]): string | null {
  for (const k of keys) {
    const v = entry.fields[k]?.value;
    if (v !== undefined && String(v).trim() !== '') return String(v).trim();
  }
  return null;
}

const massKg = (flows: readonly ExecutionFlowRow[]): number =>
  flows.reduce((s, f) => s + (f.quantityDimension === 'mass' && f.quantityCanonical != null ? f.quantityCanonical : 0), 0);

const tons = (kg: number): number => Math.round(kg / 1000 * 100) / 100;

function latestDate(flows: readonly ExecutionFlowRow[]): string | null {
  const ds = flows.map((f) => datePrefix(f.voucherDate)).filter((d) => d !== '').sort();
  return ds.length > 0 ? ds[ds.length - 1]! : null;
}

/** 金额按币种分组合计(净占用/进销项共用)。 */
function sumAmountsByCurrency(rows: Array<{ amount: number | null; currency: string | null }>): Map<string, number> {
  const m = new Map<string, number>();
  for (const r of rows) {
    if (r.amount == null) continue;
    const cur = r.currency ?? 'CNY';
    m.set(cur, (m.get(cur) ?? 0) + r.amount);
  }
  return m;
}

/** 主币种组(金额里程碑展示口径): |合计|最大的一组。 */
function dominantAmount(m: Map<string, number>): FlowPanelAmount | null {
  let best: { cur: string; v: number } | null = null;
  for (const [cur, v] of m) {
    if (!best || Math.abs(v) > Math.abs(best.v)) best = { cur, v };
  }
  return best ? { value: best.v, currency: best.cur } : null;
}

function flowRows(flows: readonly ExecutionFlowRow[]): FlowPanelBreakdownRow[] {
  return flows.map((f) => ({
    label: [f.docType, datePrefix(f.voucherDate)].filter(Boolean).join(' ') || shortId(f.id),
    quantity: f.quantityDimension === 'mass' && f.quantityCanonical != null
      ? { value: tons(f.quantityCanonical), unit: '吨' }
      : (f.quantityValue != null && f.unit ? { value: f.quantityValue, unit: f.unit } : null),
    amount: f.amount != null ? { value: f.amount, currency: 'CNY' } : null,
    date: datePrefix(f.voucherDate) || null,
    evidenceIds: [f.id],
    documentId: f.documentId,
  }));
}

function milestone(
  m: Omit<FlowPanelMilestone, 'breakdown'> & { breakdown?: FlowPanelBreakdownRow[] },
): FlowPanelMilestone {
  return { breakdown: [], ...m };
}

// ---------------------------------------------------------------------------
// 主聚合
// ---------------------------------------------------------------------------

export async function buildFlowPanel(
  ctx: DbContext, contractNo: string, userId?: string,
): Promise<FlowPanelResult | null> {
  const uid = effectiveUserId(userId);
  const entry = await findContractLedgerByNo(ctx, contractNo, uid);
  if (!entry) return null;
  const asOf = new Date().toISOString();
  const pred = asOfBusinessTime(asOf);
  const noKey = normalizeContractNo(contractNo);
  const sameNo = (v: unknown): boolean =>
    typeof v === 'string' && normalizeContractNo(v) === noKey;

  // ---- 并行取数(全部只读) -------------------------------------------------
  const [flows, settlements, ledgerRefs, linkRows, payFacts, collFacts, invFacts,
    receiptFacts, deliveryFacts, allocEdges, writeoffEdges] = await Promise.all([
    listExecutionFlows(ctx, entry.contractNo, uid),
    listSettlementRecords(ctx, entry.contractNo, uid),
    listContractLedgerRefs(ctx, uid),
    listGraphLinks(ctx, uid),
    listTradeFactsAsOf(ctx, pred, { entityType: 'PaymentEvent' }, uid),
    listTradeFactsAsOf(ctx, pred, { entityType: 'CollectionEvent' }, uid),
    listTradeFactsAsOf(ctx, pred, { entityType: 'InvoiceEvent' }, uid),
    listTradeFactsAsOf(ctx, pred, { entityType: 'GoodsReceiptEvent' }, uid),
    listTradeFactsAsOf(ctx, pred, { entityType: 'GoodsDeliveryEvent' }, uid),
    listOntologyEdgesAsOf(ctx, pred, { relation: 'ALLOCATE_TO' }, uid),
    listOntologyEdgesAsOf(ctx, pred, { relation: 'WRITE_OFF' }, uid),
  ]);

  // ---- 归属: 台账行 id(ALLOCATE_TO 终点) + 款/票 payload.contractNo --------
  const ledgerIds = new Set(ledgerRefs.filter((r) => normalizeContractNo(r.contractNo) === noKey).map((r) => r.id));
  const byContract = (facts: readonly TradeFactRow[]): TradeFactRow[] =>
    facts.filter((f) => sameNo((f.payload as Record<string, unknown>)['contractNo']));
  const payments = byContract(payFacts);
  const collections = byContract(collFacts);
  const invoices = byContract(invFacts);
  const contractFactIds = new Set([...payments, ...collections, ...invoices].map((f) => f.id));
  const goodsEvents = [...receiptFacts, ...deliveryFacts].filter((f) => {
    if (!ledgerIds.size) return false;
    return allocEdges.some((e) => e.toType === 'TradeContract' && ledgerIds.has(e.toId) && e.fromId === f.id);
  });

  // ---- 货泳道(数据源 bindings->execution_flows; 预告/实重不双计) -----------
  const goodsFlows = flows.filter((f) => f.flowType === '货物流');
  const noticeIn = goodsFlows.filter((f) => f.direction === 'in' && flowNodeTier(f.docType) === 'notice');
  const actualIn = goodsFlows.filter((f) => f.direction === 'in' && flowNodeTier(f.docType) !== 'notice');
  const outFlows = goodsFlows.filter((f) => f.direction === 'out');
  const actualOut = outFlows.filter((f) => flowNodeTier(f.docType) !== 'notice');
  const signOut = outFlows.filter((f) => f.docType.startsWith('货转单'));

  const progress = computeExecutionProgress(
    goodsFlows.map((f) => ({
      id: f.id, docType: f.docType, quantityDimension: f.quantityDimension,
      quantityCanonical: f.quantityCanonical, quantityValue: f.quantityValue, unit: f.unit,
    })),
    entry.fields,
  );

  const noticeInKg = massKg(noticeIn);
  const actualInKg = massKg(actualIn);
  const actualOutKg = massKg(actualOut);
  const inTransitKg = noticeInKg - actualInKg;

  const goods: FlowPanelMilestone[] = [
    milestone({
      key: 'upstream-ship', lane: 'goods', node: '上游', label: '上游发运',
      status: noticeIn.length > 0 ? 'done' : 'pending',
      quantity: noticeInKg > 0 ? { value: tons(noticeInKg), unit: '吨' } : null,
      amount: null, date: latestDate(noticeIn), count: noticeIn.length,
      evidenceIds: noticeIn.map((f) => f.id),
      note: '预告凭证(发货单/派船通知单); 实重凭证到达后不双计',
      breakdown: flowRows(noticeIn),
    }),
    milestone({
      key: 'in-transit', lane: 'goods', node: '在途', label: '在途',
      status: inTransitKg > EPSILON ? 'ongoing' : 'pending',
      quantity: inTransitKg > EPSILON ? { value: tons(inTransitKg), unit: '吨' } : null,
      amount: null, date: latestDate(noticeIn), count: noticeIn.length,
      evidenceIds: noticeIn.map((f) => f.id),
      note: '在途=上游预告未被我方实收覆盖部分(预告−实收, 决策 #11c)',
      breakdown: flowRows(noticeIn),
    }),
    milestone({
      key: 'receipt', lane: 'goods', node: '我方', label: '我方收货(实称)',
      status: actualIn.length > 0 ? 'done' : 'pending',
      quantity: actualInKg > 0 ? { value: tons(actualInKg), unit: '吨' } : null,
      amount: null, date: latestDate(actualIn), count: actualIn.length,
      evidenceIds: actualIn.map((f) => f.id),
      note: null,
      breakdown: flowRows(actualIn),
    }),
    milestone({
      key: 'inventory', lane: 'goods', node: '我方', label: '库存/拆分',
      status: actualIn.length > 0 ? 'done' : 'pending',
      quantity: actualIn.length > 0 ? { value: tons(Math.max(0, actualInKg - actualOutKg)), unit: '吨' } : null,
      amount: null, date: latestDate(actualIn), count: actualIn.length + actualOut.length,
      evidenceIds: [...actualIn, ...actualOut].map((f) => f.id),
      note: '库存=我方收货实重−我方发货实重(收发差口径; 批次对象见 Phase 3)',
      breakdown: [...flowRows(actualIn), ...flowRows(actualOut)],
    }),
    milestone({
      key: 'out-ship', lane: 'goods', node: '我方', label: '我方发货',
      status: actualOut.length > 0 ? 'done' : 'pending',
      quantity: actualOutKg > 0 ? { value: tons(actualOutKg), unit: '吨' } : null,
      amount: null, date: latestDate(actualOut), count: actualOut.length,
      evidenceIds: actualOut.map((f) => f.id),
      note: null,
      breakdown: flowRows(actualOut),
    }),
    milestone({
      key: 'downstream-sign', lane: 'goods', node: '下游', label: '下游签收',
      status: signOut.length > 0 ? 'done' : 'pending',
      quantity: massKg(signOut) > 0 ? { value: tons(massKg(signOut)), unit: '吨' } : null,
      amount: null, date: latestDate(signOut), count: signOut.length,
      evidenceIds: signOut.map((f) => f.id),
      note: '货转单(下游侧货权转移凭证); 签收回单链路 Phase 3 批次对象补齐',
      breakdown: flowRows(signOut),
    }),
  ];

  // ---- 权泳道(titleTransfer 口径 + 转移时点; 决策 #11) --------------------
  const payload = (f: TradeFactRow): Record<string, unknown> => f.payload as Record<string, unknown>;
  const transferPoints: TitleTransferPoint[] = goodsEvents
    .map((f) => {
      const p = payload(f);
      const caliber = str(p['titleTransfer']);
      if (!caliber) return null;
      const direction = f.entityType === 'GoodsReceiptEvent' ? 'in' as const : 'out' as const;
      const qty = num(p['quantity']);
      const unit = str(p['unit']);
      return {
        factId: f.id,
        direction,
        caliber,
        at: str(p['titleTransferAt']) ?? f.validAt,
        quantity: qty != null && unit ? { value: qty, unit } : null,
        documentId: f.documentId,
      };
    })
    .filter((tp): tp is TitleTransferPoint => tp !== null)
    .sort((a, b) => a.at.localeCompare(b.at));
  const missingCaliber = goodsEvents.some((f) => !str(payload(f)['titleTransfer']));

  const nowMs = Date.now();
  const inAt = transferPoints.filter((t) => t.direction === 'in').map((t) => t.at).sort()[0];
  const outAt = transferPoints.filter((t) => t.direction === 'out').map((t) => t.at).sort()[0];
  let currentHolder: FlowPanelResult['title']['currentHolder'] = null;
  if (transferPoints.length > 0) {
    if (outAt && Date.parse(outAt) <= nowMs) currentHolder = '下游';
    else if (inAt && Date.parse(inAt) <= nowMs) currentHolder = '我方';
    else currentHolder = '上游';
  }
  const titleNotes: string[] = [];
  if (transferPoints.length === 0) titleNotes.push('待货权凭证(titleTransfer 口径未登记, 色带不猜)');
  else if (missingCaliber) titleNotes.push('部分事件缺 titleTransfer 口径, 待货权凭证补登');
  if (transferPoints.some((t) => t.direction === 'in' && t.caliber.includes('发货即转'))) {
    titleNotes.push('发货即转: 在途已属我方存货口径(决策 #11)');
  }

  const titleMilestones: FlowPanelMilestone[] = [
    milestone({
      key: 'title-in', lane: 'title', node: '我方', label: '货权转入我方',
      status: inAt ? 'done' : 'pending',
      quantity: null, amount: null,
      date: inAt ? datePrefix(inAt) : null,
      count: transferPoints.filter((t) => t.direction === 'in').length,
      evidenceIds: transferPoints.filter((t) => t.direction === 'in').map((t) => t.factId),
      note: transferPoints.filter((t) => t.direction === 'in').map((t) => t.caliber).join('/') || null,
      breakdown: transferPoints.filter((t) => t.direction === 'in').map((t) => ({
        label: `收货事件 ${t.caliber}`,
        quantity: t.quantity,
        amount: null, date: datePrefix(t.at),
        evidenceIds: [t.factId], documentId: t.documentId,
      })),
    }),
    milestone({
      key: 'title-out', lane: 'title', node: '下游', label: '货权转出我方',
      status: outAt ? 'done' : 'pending',
      quantity: null, amount: null,
      date: outAt ? datePrefix(outAt) : null,
      count: transferPoints.filter((t) => t.direction === 'out').length,
      evidenceIds: transferPoints.filter((t) => t.direction === 'out').map((t) => t.factId),
      note: transferPoints.filter((t) => t.direction === 'out').map((t) => t.caliber).join('/') || null,
      breakdown: transferPoints.filter((t) => t.direction === 'out').map((t) => ({
        label: `发货事件 ${t.caliber}`,
        quantity: t.quantity,
        amount: null, date: datePrefix(t.at),
        evidenceIds: [t.factId], documentId: t.documentId,
      })),
    }),
  ];

  // ---- 款泳道(PaymentEvent/CollectionEvent + settlement_records) ----------
  const payAmounts = sumAmountsByCurrency(payments.map((f) => ({
    amount: num(payload(f)['amount']), currency: str(payload(f)['currency']),
  })));
  const collAmounts = sumAmountsByCurrency(collections.map((f) => ({
    amount: num(payload(f)['amount']), currency: str(payload(f)['currency']),
  })));

  const factRows = (facts: readonly TradeFactRow[], labelOf: (p: Record<string, unknown>) => string): FlowPanelBreakdownRow[] =>
    facts.map((f) => {
      const p = payload(f);
      const amt = num(p['amount']);
      return {
        label: labelOf(p),
        quantity: null,
        amount: amt != null ? { value: amt, currency: str(p['currency']) ?? 'CNY' } : null,
        date: datePrefix(f.validAt),
        evidenceIds: [f.id],
        documentId: f.documentId,
      };
    });

  const settledQty = settlements.reduce((s, r) => s + (r.settledQuantity ?? 0), 0);
  const settledAmounts = sumAmountsByCurrency(settlements.map((r) => ({
    amount: r.totalAmount, currency: r.currency,
  })));

  const funds: FlowPanelMilestone[] = [
    milestone({
      key: 'paid', lane: 'funds', node: '上游', label: '付出',
      status: payments.length > 0 ? 'done' : 'pending',
      quantity: null, amount: dominantAmount(payAmounts),
      date: payments.map((f) => datePrefix(f.validAt)).sort().pop() ?? null,
      count: payments.length,
      evidenceIds: payments.map((f) => f.id),
      note: '付款=预付/进度款/尾款/质保金(退款为逆向负数已轧差)',
      breakdown: factRows(payments, (p) => `付款${p['payType'] ? `(${String(p['payType'])})` : ''}`),
    }),
    milestone({
      key: 'received', lane: 'funds', node: '下游', label: '收到',
      status: collections.length > 0 ? 'done' : 'pending',
      quantity: null, amount: dominantAmount(collAmounts),
      date: collections.map((f) => datePrefix(f.validAt)).sort().pop() ?? null,
      count: collections.length,
      evidenceIds: collections.map((f) => f.id),
      note: '收款=预收/回款(退款为逆向负数已轧差)',
      breakdown: factRows(collections, () => '收款'),
    }),
    milestone({
      key: 'settled', lane: 'funds', node: '我方', label: '结算',
      status: settlements.length > 0 ? 'done' : 'pending',
      quantity: settlements.length > 0 && settlements[0]!.quantityUnit
        ? { value: settledQty, unit: settlements[0]!.quantityUnit! } : null,
      amount: dominantAmount(settledAmounts),
      date: settlements.map((r) => datePrefix(r.createdAt)).sort().pop() ?? null,
      count: settlements.length,
      evidenceIds: settlements.map((r) => r.id),
      note: '结算锚点=L2 人工确认后的 settlement_records(非暂估)',
      breakdown: settlements.map((r) => ({
        label: `结算 ${datePrefix(r.createdAt)}`,
        quantity: r.quantityUnit ? { value: r.settledQuantity, unit: r.quantityUnit } : null,
        amount: { value: r.totalAmount, currency: r.currency ?? 'CNY' },
        date: datePrefix(r.createdAt),
        evidenceIds: [r.id], documentId: null,
      })),
    }),
  ];

  // ---- 票泳道(InvoiceEvent + WRITE_OFF completeness) ----------------------
  // appliedByFact 按端点累计(行余额口径); 里程碑金额按边计一次(不跨端点双计)。
  const appliedByFact = new Map<string, number>();
  const woBreakdown: FlowPanelBreakdownRow[] = [];
  const woEdgeAmounts: Array<{ amount: number; currency: string | null }> = [];
  for (const e of writeoffEdges) {
    const touches = contractFactIds.has(e.fromId) || contractFactIds.has(e.toId);
    if (!touches) continue;
    const amt = num(e.params['amount']) ?? 0;
    for (const endpoint of [e.fromId, e.toId]) {
      if (contractFactIds.has(endpoint)) {
        appliedByFact.set(endpoint, (appliedByFact.get(endpoint) ?? 0) + amt);
      }
    }
    const fact = [...payments, ...collections, ...invoices]
      .find((f) => f.id === e.fromId || f.id === e.toId);
    woEdgeAmounts.push({ amount: amt, currency: fact ? str(payload(fact)['currency']) : null });
    woBreakdown.push({
      label: `核销 ${shortId(e.fromId)}→${shortId(e.toId)}`,
      quantity: null,
      amount: { value: amt, currency: fact ? str(payload(fact)['currency']) ?? 'CNY' : 'CNY' },
      date: datePrefix(e.validAt),
      evidenceIds: [e.id],
      documentId: null,
    });
  }
  const appliedTotals = sumAmountsByCurrency(woEdgeAmounts);
  const woRows = [...payments, ...collections, ...invoices];
  const allFull = woRows.length > 0
    && woRows.every((f) => {
      const amt = num(payload(f)['amount']) ?? 0;
      return amt - (appliedByFact.get(f.id) ?? 0) <= EPSILON;
    });
  const anyApplied = [...appliedByFact.values()].some((v) => v > EPSILON);

  const invIn = invoices.filter((f) => payload(f)['invoiceType'] === '进项');
  const invOut = invoices.filter((f) => payload(f)['invoiceType'] === '销项');
  const invInAmounts = sumAmountsByCurrency(invIn.map((f) => ({
    amount: num(payload(f)['amount']), currency: str(payload(f)['currency']),
  })));
  const invOutAmounts = sumAmountsByCurrency(invOut.map((f) => ({
    amount: num(payload(f)['amount']), currency: str(payload(f)['currency']),
  })));

  const invoice: FlowPanelMilestone[] = [
    milestone({
      key: 'invoice-in', lane: 'invoice', node: '上游', label: '进项(已收)',
      status: invIn.length > 0 ? 'done' : 'pending',
      quantity: null, amount: dominantAmount(invInAmounts),
      date: invIn.map((f) => datePrefix(f.validAt)).sort().pop() ?? null,
      count: invIn.length,
      evidenceIds: invIn.map((f) => f.id),
      note: null,
      breakdown: factRows(invIn, (p) => `进项 ${String(p['invoiceNo'] ?? '')}`),
    }),
    milestone({
      key: 'invoice-out', lane: 'invoice', node: '下游', label: '销项(已开)',
      status: invOut.length > 0 ? 'done' : 'pending',
      quantity: null, amount: dominantAmount(invOutAmounts),
      date: invOut.map((f) => datePrefix(f.validAt)).sort().pop() ?? null,
      count: invOut.length,
      evidenceIds: invOut.map((f) => f.id),
      note: null,
      breakdown: factRows(invOut, (p) => `销项 ${String(p['invoiceNo'] ?? '')}`),
    }),
    milestone({
      key: 'writeoff', lane: 'invoice', node: '我方', label: '核销状态',
      status: woRows.length === 0 ? 'pending' : allFull ? 'done' : anyApplied ? 'ongoing' : 'pending',
      quantity: null, amount: dominantAmount(appliedTotals),
      date: writeoffEdges.map((e) => datePrefix(e.validAt)).sort().pop() ?? null,
      count: woBreakdown.length,
      evidenceIds: woBreakdown.flatMap((r) => r.evidenceIds),
      note: woRows.length === 0 ? '无款/票事实' : '核销=WRITE_OFF 边金额按端点累计(部分核销可见)',
      breakdown: woBreakdown,
    }),
  ];

  // ---- netPosition(已付/已收/净占用、进/销项, 按币种) ---------------------
  const currencies = [...new Set([...payAmounts.keys(), ...collAmounts.keys()])]
    .map((cur) => ({
      currency: cur,
      paid: payAmounts.get(cur) ?? 0,
      received: collAmounts.get(cur) ?? 0,
    }))
    .map((r) => ({ ...r, netOccupancy: r.paid - r.received }))
    .sort((a, b) => (Math.abs(b.paid) + Math.abs(b.received)) - (Math.abs(a.paid) + Math.abs(a.received)));
  const invoiceCurrencies = [...new Set([...invInAmounts.keys(), ...invOutAmounts.keys()])]
    .map((cur) => ({
      currency: cur,
      inAmount: invInAmounts.get(cur) ?? 0,
      outAmount: invOutAmounts.get(cur) ?? 0,
    }))
    .sort((a, b) => (b.inAmount + b.outAmount) - (a.inAmount + a.outAmount));

  // ---- 告警(超发货期 / 水尺差超容差 / 票款不齐) ---------------------------
  const alerts: FlowPanelAlert[] = [];
  /** 告警 -> 泳道节点红圈: 按证据 id 交集定位被告警覆盖的里程碑。 */
  const keysByEvidence = (evidenceIds: string[]): string[] => {
    const ids = new Set(evidenceIds);
    const all = [...goods, ...titleMilestones, ...funds, ...invoice];
    return all.filter((m) => m.evidenceIds.some((id) => ids.has(id))).map((m) => m.key);
  };

  // 1) 超合同发货期: 台账交货期可解析且存在更晚的货物流凭证/事件日期。
  const deadlineText = fieldText(entry, ['合同交货期', '交货日期', '交货期', '供货期限', '履约期限']);
  const deadline = deadlineText ? parseCnDate(deadlineText)?.max : null;
  if (deadline) {
    const offenders = goodsFlows
      .map((f) => ({ id: f.id, d: datePrefix(f.voucherDate) }))
      .filter((x) => x.d !== '' && x.d > deadline)
      .map((x) => ({ ...x, src: 'flow' as const }));
    if (offenders.length > 0) {
      const worst = offenders.map((x) => x.d).sort().pop()!;
      const days = Math.round((Date.parse(worst) - Date.parse(deadline)) / DAY_MS);
      alerts.push({
        code: 'delivery-overdue', level: 'warn',
        message: `履约凭证 ${worst} 超合同交货期 ${deadline}（超 ${days} 天）`,
        evidenceIds: offenders.map((x) => x.id),
        milestoneKeys: keysByEvidence(offenders.map((x) => x.id)),
      });
    }
  }

  // 2) 水尺差超短溢装容差: 流入水尺 vs 实收, 对照台账短溢装条款(缺省 ±3%)。
  const surveyIn = goodsFlows.filter((f) => f.direction === 'in' && f.docType.startsWith('水尺'));
  const weighIn = actualIn.filter((f) => !f.docType.startsWith('水尺'));
  const surveyKg = massKg(surveyIn);
  const weighKg = massKg(weighIn);
  if (surveyKg > 0 && weighKg > 0) {
    const tolText = fieldText(entry, ['短溢装', '短溢装条款', '溢短装']);
    const tolMatch = tolText ? /([0-9]+(?:\.[0-9]+)?)\s*%/.exec(tolText) : null;
    const tolerance = tolMatch ? Number(tolMatch[1]) / 100 : 0.03;
    const ratio = Math.abs(surveyKg - weighKg) / surveyKg;
    if (ratio > tolerance + EPSILON) {
      alerts.push({
        code: 'draft-survey-tolerance', level: 'warn',
        message: `水尺 ${tons(surveyKg).toLocaleString()} 吨 vs 实收 ${tons(weighKg).toLocaleString()} 吨，差 ${(ratio * 100).toFixed(2)}% 超短溢装容差 ${tolerance * 100}%（建议核查计量与索赔时效）`,
        evidenceIds: [...surveyIn, ...weighIn].map((f) => f.id),
        milestoneKeys: keysByEvidence([...surveyIn, ...weighIn].map((f) => f.id)),
      });
    }
  }

  // 3) 票款不齐: 按合同归属的款/票事实单向存在(v1 确定性规则, 不猜时点差)。
  const fundsAbs = [...payAmounts.values(), ...collAmounts.values()].reduce((s, v) => s + Math.abs(v), 0);
  const invoiceAbs = [...invInAmounts.values(), ...invOutAmounts.values()].reduce((s, v) => s + Math.abs(v), 0);
  if (fundsAbs > EPSILON && invoices.length === 0) {
    alerts.push({
      code: 'invoice-funds-mismatch', level: 'warn',
      message: '票款不齐: 本合同已有付款/收款事实但无发票登记（有款无票）',
      evidenceIds: [...payments, ...collections].map((f) => f.id),
      milestoneKeys: ['paid', 'received'],
    });
  } else if (invoiceAbs > EPSILON && payments.length + collections.length === 0) {
    alerts.push({
      code: 'invoice-funds-mismatch', level: 'warn',
      message: '票款不齐: 本合同已有发票事实但无付款/收款登记（有票无款）',
      evidenceIds: invoices.map((f) => f.id),
      milestoneKeys: ['invoice-in', 'invoice-out'],
    });
  }

  // 红圈联动后置标记(spec §15): 被任一告警覆盖的里程碑 status -> abnormal。
  const alertedKeys = new Set(alerts.flatMap((a) => a.milestoneKeys));
  const markAbnormal = (ms: FlowPanelMilestone[]): FlowPanelMilestone[] =>
    ms.map((m) => (alertedKeys.has(m.key) && m.status !== 'pending' ? { ...m, status: 'abnormal' as const } : m));

  // ---- 背靠背对偶(graph_links correlates, 仅 confirmed) -------------------
  const linkKey = (k: string): string => normalizeName(normalizeContractNo(k));
  const correlates: FlowPanelContractRef[] = [];
  for (const l of linkRows) {
    if (l.kind !== 'correlates' || l.status !== 'confirmed') continue;
    let peer: string | null = null;
    if (linkKey(l.srcKey) === noKey) peer = l.dstKey;
    else if (linkKey(l.dstKey) === noKey) peer = l.srcKey;
    if (!peer) continue;
    const peerEntry = await findContractLedgerByNo(ctx, peer, uid);
    correlates.push({
      contractNo: peerEntry?.contractNo ?? peer,
      displayContractNo: peerEntry?.displayContractNo ?? peer,
      title: peerEntry?.title ?? '',
    });
  }

  // ---- 凭证单据映射(三级钻取第三级: 原始凭证直达) -------------------------
  const docIds = [...new Set([
    entry.documentId,
    ...flows.map((f) => f.documentId),
    ...[...payments, ...collections, ...invoices, ...goodsEvents].map((f) => f.documentId),
  ].filter((v): v is string => typeof v === 'string' && v !== ''))];
  const documents: Record<string, FlowPanelDocRef> = {};
  for (const d of await getDocumentSourcesByIds(ctx, docIds)) {
    const fileName = d.sourceUri.split(/[\\/]/).pop() ?? '';
    documents[d.id] = { fileName, minioKey: d.minioKey };
  }

  return {
    contractNo: entry.contractNo,
    displayContractNo: entry.displayContractNo,
    contractTitle: entry.title,
    asOf,
    basis: progress.basis ? { quantity: progress.basis.quantity, unit: progress.basis.unit } : null,
    progress: progress.progress,
    progressReason: progress.reason ?? null,
    goods: markAbnormal(goods),
    title: {
      currentHolder,
      note: titleNotes.length > 0 ? titleNotes.join('；') : null,
      transferPoints,
      milestones: markAbnormal(titleMilestones),
    },
    funds: markAbnormal(funds),
    invoice: markAbnormal(invoice),
    alerts,
    netPosition: { currencies, invoices: invoiceCurrencies },
    correlates,
    documents,
  };
}
