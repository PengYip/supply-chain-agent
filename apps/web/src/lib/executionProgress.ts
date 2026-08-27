/* ---------- 执行进度展示纯函数(项目台账视图, spec 2026-08-27 台账整合 §4) ----------
 *
 * 服务端 computeExecutionProgress 是数字口径的唯一事实源(单位换算只在可查时进行);
 * 本文件只做展示投影: 角色-方向映射、时间轴累计、已执行/待执行换算到台账原单位。
 * 待执行可为负(超额)、百分比可超 100% —— 如实呈现不封顶。
 */

/** 服务端 ExecutionProgress 的展示投影(与 apps/server executionProgress.ts 结构一致)。 */
export interface ExecutionProgressView {
  basis: { quantity: number; unit: string; dimension: 'mass' | 'count'; canonical: number } | null;
  delivered: { massKg: number | null; countPools: Record<string, number> } | null;
  progress: number | null;
  reason?: 'no-contract-basis' | 'dimension-mismatch' | 'unit-pool-missing';
}

/** 时间轴回放用的最小流水行(voucherDate 为 YYYY-MM-DD 或 null)。 */
export interface TimelineFlowRow {
  flowType: string;
  direction: 'in' | 'out';
  amount: number | null;
  quantityTon: number | null;
  voucherDate: string | null;
}

/** 六向单向累计(null = 该向无金额/数量数据, 与 0 区分)。 */
export interface DirAggregate {
  entryCount: number;
  totalAmount: number | null;
  totalQuantityTon: number | null;
}

/** 合同角色 -> 该流自然方向: 采购=收货(in)/付款(out)/收票(in); 销售=发货(out)/收款(in)/开票(out);
 *  其他角色返回 null(调用方按双向显示)。 */
export function roleNaturalDirection(role: string, flowType: '货物流' | '资金流' | '发票流'): 'in' | 'out' | null {
  if (role === '采购') return flowType === '资金流' ? 'out' : 'in';
  if (role === '销售') return flowType === '资金流' ? 'in' : 'out';
  return null;
}

/** 时间轴刻度: 升序去重的非空凭证日期; 无日期行不产生刻度(只在「最新」态计入)。 */
export function timelineDates(rows: TimelineFlowRow[]): string[] {
  return [...new Set(rows.map((r) => r.voucherDate).filter((d): d is string => d != null && d !== ''))].sort();
}

/** 截至某日的六向累计: 只累计 voucherDate 非空且 <= asOf 的行; 无数据的方向不出现在 Map。
 *  「最新」态不走此函数(直接用 rollup summaries, 含无日期行)。 */
export function cumulativeAsOf(rows: TimelineFlowRow[], asOf: string): Map<string, DirAggregate> {
  const map = new Map<string, DirAggregate>();
  for (const r of rows) {
    if (!r.voucherDate || r.voucherDate > asOf) continue;
    const key = `${r.flowType}-${r.direction}`;
    const cur = map.get(key) ?? { entryCount: 0, totalAmount: null, totalQuantityTon: null };
    cur.entryCount += 1;
    if (r.amount !== null) cur.totalAmount = (cur.totalAmount ?? 0) + r.amount;
    if (r.quantityTon !== null) cur.totalQuantityTon = (cur.totalQuantityTon ?? 0) + r.quantityTon;
    map.set(key, cur);
  }
  return map;
}

/** 已执行量换算到台账基准原单位: mass 按 canonical 线性回换(基准吨->已执行千克同比例);
 *  count 取对应单位池。无法对齐返回 null。 */
export function executedInBasisUnit(progress: ExecutionProgressView): number | null {
  if (!progress.basis || !progress.delivered) return null;
  if (progress.basis.dimension === 'mass') {
    if (progress.delivered.massKg === null || progress.basis.canonical <= 0) return null;
    return (progress.delivered.massKg * progress.basis.quantity) / progress.basis.canonical;
  }
  const pool = progress.delivered.countPools[progress.basis.unit];
  return pool === undefined ? null : pool;
}

/** 待执行 = 基准 - 已执行(原单位); 无基准/量纲不对齐 -> null(不硬算); 可为负(超额), 如实呈现。 */
export function pendingInBasisUnit(progress: ExecutionProgressView): number | null {
  if (!progress.basis) return null;
  if (progress.reason === 'dimension-mismatch' || progress.reason === 'unit-pool-missing') return null;
  const executed = executedInBasisUnit(progress);
  if (executed === null) return progress.basis.quantity;
  return progress.basis.quantity - executed;
}
