// 核销工作台读侧（roadmap Item 5）：余额聚合 + 模式发现。
// 独立文件，不改动 repo.ts / projection.ts（与 Item 4 并行开发的分区约定）。
// v1 口径：行余额 = 事实金额 − 该行作为端点的核销类边 amount 累计（业务时间 as-of 现在）。
// 红冲/退款是独立负数行，不轧差进本行；净额视角属台账详情（Item 3）。
import type { DbContext } from '../pipeline/db/client.js';
import {
  listTradeFactsAsOf, listOntologyEdgesAsOf, type TradeFactRow,
} from './repo.js';
import { asOfBusinessTime } from './asof.js';
import { ONTOLOGY_RELATIONS, ENTITY_LABELS, type OntologyEntityName, isRelationPairAllowed } from './index.js';

/** 资金侧实体（模式发现的种子口径：from ∈ 资金侧且 params 带 amount 的关系 = 核销类）。 */
const FUND_ENTITY_TYPES: ReadonlySet<OntologyEntityName> = new Set<OntologyEntityName>(['PaymentEvent', 'CollectionEvent']);
/** 余额聚合纳入的实体（资金 + 发票 + 结算）。 */
const BALANCE_ENTITY_TYPES: ReadonlySet<OntologyEntityName> = new Set<OntologyEntityName>([
  'PaymentEvent', 'CollectionEvent', 'InvoiceEvent', 'SettlementEvent',
]);
const EPSILON = 0.005;

export interface WriteoffBalanceRow {
  id: string;
  entityType: string;
  label: string;
  currency: string | null;
  amount: number;
  applied: number;
  remaining: number;
  validAt: string | null;
  status: 'none' | 'partial' | 'full';
}

export interface WriteoffMode {
  relation: string;
  description: string;
  srcTypes: string[];
  dstTypes: string[];
  funds: WriteoffBalanceRow[];
  targets: WriteoffBalanceRow[];
}

/** 核销类关系发现（映射驱动）：params 含 amount 且存在资金侧发起连接对。 */
export function writeoffModeRelations(): string[] {
  return ONTOLOGY_RELATIONS
    .filter((r) => 'amount' in r.params.shape)
    .filter((r) => r.pairs.some((p) => FUND_ENTITY_TYPES.has(p.from)))
    .map((r) => r.name);
}

/** 行主标签：发票号优先，其次实体中文标签 + 短 id。 */
function factLabel(fact: TradeFactRow): string {
  const payload = fact.payload as Record<string, unknown>;
  const invoiceNo = payload['invoiceNo'];
  if (typeof invoiceNo === 'string' && invoiceNo) return invoiceNo;
  return `${ENTITY_LABELS[fact.entityType as keyof typeof ENTITY_LABELS] ?? fact.entityType} ${fact.id.slice(-6)}`;
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** 全量余额行（资金/发票/结算），applied = 核销类边 amount 按端点累计。 */
export async function listWriteoffBalances(
  ctx: DbContext, userId?: string,
): Promise<WriteoffBalanceRow[]> {
  const now = new Date().toISOString();
  const pred = asOfBusinessTime(now);
  const relations = writeoffModeRelations();

  const facts: TradeFactRow[] = [];
  for (const entityType of BALANCE_ENTITY_TYPES) {
    facts.push(...await listTradeFactsAsOf(ctx, pred, { entityType }, userId));
  }

  // 端点 -> 累计核销额（from 与 to 端点都计：资金在 from，发票/结算在 to）。
  const appliedById = new Map<string, number>();
  for (const relation of relations) {
    const edges = await listOntologyEdgesAsOf(ctx, pred, { relation }, userId);
    for (const e of edges) {
      const amount = num(e.params['amount']) ?? 0;
      for (const endpoint of [e.fromId, e.toId]) {
        appliedById.set(endpoint, (appliedById.get(endpoint) ?? 0) + amount);
      }
    }
  }

  return facts.map((f) => {
    const amount = num((f.payload as Record<string, unknown>)['amount']) ?? 0;
    const applied = appliedById.get(f.id) ?? 0;
    const remaining = amount - applied;
    const status: WriteoffBalanceRow['status'] =
      remaining <= EPSILON ? 'full' : applied > EPSILON ? 'partial' : 'none';
    return {
      id: f.id,
      entityType: f.entityType,
      label: factLabel(f),
      currency: (typeof (f.payload as Record<string, unknown>)['currency'] === 'string'
        ? ((f.payload as Record<string, unknown>)['currency'] as string) : null),
      amount, applied, remaining,
      validAt: f.validAt ?? null,
      status,
    };
  });
}

/** 工作台总览：按发现的关系分模式，两侧列表就位。 */
export async function getWriteoffOverview(
  ctx: DbContext, userId?: string,
): Promise<{ asOf: string; modes: WriteoffMode[] }> {
  const rows = await listWriteoffBalances(ctx, userId);
  const modes: WriteoffMode[] = writeoffModeRelations().map((name) => {
    const def = ONTOLOGY_RELATIONS.find((r) => r.name === name)!;
    const srcTypes: string[] = [...new Set(def.pairs.map((p) => p.from))];
    const dstTypes: string[] = [...new Set(def.pairs.map((p) => p.to))];
    return {
      relation: name,
      description: def.description,
      srcTypes,
      dstTypes,
      funds: rows.filter((r) => srcTypes.includes(r.entityType)),
      targets: rows.filter((r) => dstTypes.includes(r.entityType)),
    };
  });
  return { asOf: new Date().toISOString(), modes };
}

export interface AllocationItem {
  srcId: string;
  dstId: string;
  amount: number;
  partial?: boolean;
  batch?: string;
}

export interface AllocationViolation {
  itemIndex: number;
  code: 'non_positive' | 'unknown_fact' | 'pair_not_allowed' | 'src_over_remaining' | 'dst_over_remaining';
  detail: string;
}

/** 整单守恒校验：提交路由（预检）与工具 execute（权威）共用。
 *  规则见计划 Task 4：正数 -> 事实存在 -> 连接对合法 -> 同单按 src/dst 累计不超各自 remaining。 */
export async function validateAllocationPlan(
  ctx: DbContext, relation: string, items: AllocationItem[], userId?: string,
): Promise<AllocationViolation[]> {
  const violations: AllocationViolation[] = [];
  const rows = await listWriteoffBalances(ctx, userId);
  const byId = new Map(rows.map((r) => [r.id, r]));

  const srcUsed = new Map<string, number>();
  const dstUsed = new Map<string, number>();

  items.forEach((item, i) => {
    if (!(item.amount > 0)) {
      violations.push({ itemIndex: i, code: 'non_positive', detail: `分配额必须为正数, got ${item.amount}` });
    }
    const src = byId.get(item.srcId);
    const dst = byId.get(item.dstId);
    if (!src) violations.push({ itemIndex: i, code: 'unknown_fact', detail: `资金行 ${item.srcId} 不存在或不属于当前用户` });
    if (!dst) violations.push({ itemIndex: i, code: 'unknown_fact', detail: `目标行 ${item.dstId} 不存在或不属于当前用户` });
    if (src && dst && !isRelationPairAllowed(relation, src.entityType, dst.entityType)) {
      violations.push({
        itemIndex: i, code: 'pair_not_allowed',
        detail: `${relation} 不允许 ${src.entityType} -> ${dst.entityType}`,
      });
    }
    if (src) {
      const used = (srcUsed.get(item.srcId) ?? 0) + item.amount;
      srcUsed.set(item.srcId, used);
      if (used > src.remaining + EPSILON) {
        violations.push({
          itemIndex: i, code: 'src_over_remaining',
          detail: `资金行 ${src.label} 累计分配 ${used} 超余额 ${src.remaining}`,
        });
      }
    }
    if (dst) {
      const used = (dstUsed.get(item.dstId) ?? 0) + item.amount;
      dstUsed.set(item.dstId, used);
      if (used > dst.remaining + EPSILON) {
        violations.push({
          itemIndex: i, code: 'dst_over_remaining',
          detail: `目标行 ${dst.label} 累计分配 ${used} 超余额 ${dst.remaining}`,
        });
      }
    }
  });
  return violations;
}
