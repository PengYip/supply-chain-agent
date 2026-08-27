// 合同执行进度(spec 2026-08-27 §9/§15): 流水行 + 台账字段 -> 进度块。纯函数零 IO。
// 数字零幻觉: 换算只在单位注册表可查时进行; 量纲/计数池不一致如实报 reason, 不硬算。
// 节点权威聚合(§15): 同批货的预告凭证(发货单/派船通知单)被实重凭证(轨道衡/磅单/
// 收货单等)覆盖时不重复累计 —— 每个量纲取 max(实重, 预告), 未覆盖批次仍按预告计入。

import { canonicalizeQuantity, type QuantityDimension } from '../domain/units.js';
import { flowNodeTier } from '../domain/tradeSemantics.js';
import type { ExecutionFlowRow } from './db/repositories.js';

export interface ExecutionProgressNodes {
  /** 实重节点(权威)质量合计(千克)。 */
  actualMassKg: number;
  /** 预告节点质量合计(千克)。 */
  noticeMassKg: number;
  /** 实重节点计数池(按单位)。 */
  actualPools: Record<string, number>;
  /** 预告节点计数池(按单位)。 */
  noticePools: Record<string, number>;
}

export interface ExecutionProgress {
  /** 台账基准(数量+单位 canonicalize); null = 无可用基准。 */
  basis: { quantity: number; unit: string; dimension: QuantityDimension; canonical: number } | null;
  /**
   * 已发生量: mass 按千克累计(节点权威聚合后); count 按单位各自成池(箱/件不混算);
   * nodes 保留实重/预告分层供溯源展示。
   */
  delivered: {
    massKg: number | null;
    countPools: Record<string, number>;
    nodes: ExecutionProgressNodes;
  } | null;
  /** delivered/basis; 无法对齐时 null + reason。 */
  progress: number | null;
  reason?: 'no-contract-basis' | 'dimension-mismatch' | 'unit-pool-missing';
}

type FlowQty = Pick<
  ExecutionFlowRow,
  'quantityDimension' | 'quantityCanonical' | 'quantityValue' | 'unit'
> & { docType?: string };
type LedgerFields = Record<string, { value: string | number }> | null | undefined;

export function computeExecutionProgress(flows: FlowQty[], ledgerFields: LedgerFields): ExecutionProgress {
  const nodes: ExecutionProgressNodes = { actualMassKg: 0, noticeMassKg: 0, actualPools: {}, noticePools: {} };
  let hasMass = false;
  for (const f of flows) {
    const pool = flowNodeTier(f.docType) === 'notice' ? nodes.noticePools : nodes.actualPools;
    if (f.quantityDimension === 'mass' && f.quantityCanonical != null) {
      hasMass = true;
      if (flowNodeTier(f.docType) === 'notice') nodes.noticeMassKg += f.quantityCanonical;
      else nodes.actualMassKg += f.quantityCanonical;
    } else if (f.quantityDimension === 'count' && f.unit) {
      pool[f.unit] = (pool[f.unit] ?? 0) + (f.quantityValue ?? 0);
    }
  }
  const countPools: Record<string, number> = {};
  for (const unit of new Set([...Object.keys(nodes.actualPools), ...Object.keys(nodes.noticePools)])) {
    countPools[unit] = Math.max(nodes.actualPools[unit] ?? 0, nodes.noticePools[unit] ?? 0);
  }
  const massKg = hasMass ? Math.max(nodes.actualMassKg, nodes.noticeMassKg) : null;
  const delivered = { massKg, countPools, nodes };

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
