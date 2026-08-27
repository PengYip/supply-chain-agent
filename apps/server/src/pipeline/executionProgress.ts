// 合同执行进度(spec 2026-08-27 §9): 流水行 + 台账字段 -> 进度块。纯函数零 IO。
// 数字零幻觉: 换算只在单位注册表可查时进行; 量纲/计数池不一致如实报 reason, 不硬算。

import { canonicalizeQuantity, type QuantityDimension } from '../domain/units.js';
import type { ExecutionFlowRow } from './db/repositories.js';

export interface ExecutionProgress {
  /** 台账基准(数量+单位 canonicalize); null = 无可用基准。 */
  basis: { quantity: number; unit: string; dimension: QuantityDimension; canonical: number } | null;
  /** 已发生量: mass 按千克累计; count 按单位各自成池(箱/件不混算)。 */
  delivered: { massKg: number | null; countPools: Record<string, number> } | null;
  /** delivered/basis; 无法对齐时 null + reason。 */
  progress: number | null;
  reason?: 'no-contract-basis' | 'dimension-mismatch' | 'unit-pool-missing';
}

type FlowQty = Pick<
  ExecutionFlowRow,
  'quantityDimension' | 'quantityCanonical' | 'quantityValue' | 'unit'
>;
type LedgerFields = Record<string, { value: string | number }> | null | undefined;

export function computeExecutionProgress(flows: FlowQty[], ledgerFields: LedgerFields): ExecutionProgress {
  const hasMass = flows.some((f) => f.quantityDimension === 'mass');
  const massKg = flows.reduce(
    (s, f) => s + (f.quantityDimension === 'mass' && f.quantityCanonical != null ? f.quantityCanonical : 0),
    0,
  );
  const countPools: Record<string, number> = {};
  for (const f of flows) {
    if (f.quantityDimension === 'count' && f.unit) {
      countPools[f.unit] = (countPools[f.unit] ?? 0) + (f.quantityValue ?? 0);
    }
  }
  const delivered = { massKg: hasMass ? massKg : null, countPools };

  const rawQty = ledgerFields?.['数量']?.value;
  const rawUnit = ledgerFields?.['单位']?.value;
  if (rawQty === undefined || rawUnit === undefined) {
    return { basis: null, delivered, progress: null, reason: 'no-contract-basis' };
  }
  const qty = Number(String(rawQty).replace(/[,\s]/g, ''));
  const canon = Number.isFinite(qty) ? canonicalizeQuantity(qty, String(rawUnit)) : null;
  if (!canon) return { basis: null, delivered, progress: null, reason: 'no-contract-basis' };

  const basis = { quantity: qty, unit: String(rawUnit), dimension: canon.dimension, canonical: canon.canonical };
  if (canon.dimension === 'mass') {
    if (delivered.massKg === null) {
      // 有 count 池却要 mass 口径 -> 口径冲突如报 mismatch; 完全无流水 -> 尚未发生, 进度 0。
      if (Object.keys(countPools).length > 0) {
        return { basis, delivered, progress: null, reason: 'dimension-mismatch' };
      }
      return { basis, delivered, progress: 0 };
    }
    return { basis, delivered, progress: basis.canonical > 0 ? delivered.massKg / basis.canonical : null };
  }
  const pool = countPools[basis.unit];
  if (pool === undefined) return { basis, delivered, progress: null, reason: 'unit-pool-missing' };
  return { basis, delivered, progress: basis.canonical > 0 ? pool / basis.canonical : null };
}
