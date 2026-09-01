// 合同执行进度(spec 2026-08-27 §9/§15): 流水行 + 台账字段 -> 进度块。纯函数零 IO。
// 数字零幻觉: 换算只在单位注册表可查时进行; 量纲/计数池不一致如实报 reason, 不硬算。
// 节点权威聚合(§15): 同批货的预告凭证(发货单/派船通知单)被实重凭证(轨道衡/磅单/
// 收货单等)覆盖时不重复累计 —— 每个量纲取 max(实重, 预告), 未覆盖批次仍按预告计入。

import { canonicalizeQuantity, type QuantityDimension } from '../domain/units.js';
import { flowNodeTier } from '../domain/tradeSemantics.js';
import type { ExecutionFlowRow } from './db/repositories.js';
import { isEmptyValue } from './fieldValue.js';

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

// ---- 口径透明化(2026-09-01, additive): 计入/排除明细 + 运输方式分组 --------

/** docType -> 运输方式(前缀/精确名匹配, 未映射 -> '其他')。 */
export const TRANSPORT_MODE_BY_DOC_TYPE: Readonly<Record<string, readonly string[]>> = {
  火车: ['火运大票', '轨道衡称重单'],
  汽车: ['磅单', '汽运'],
  船舶: ['水尺计重单'],
};

/** 运输方式归组(口径透明化); 空名/未知 docType -> '其他'。 */
export function transportModeForDocType(docType: string | undefined | null): string {
  if (!docType) return '其他';
  for (const [mode, prefixes] of Object.entries(TRANSPORT_MODE_BY_DOC_TYPE)) {
    for (const p of prefixes) {
      if (docType === p || docType.startsWith(p)) return mode;
    }
  }
  return '其他';
}

/** 计入流水的排除原因(节点权威聚合语义: max(实重, 预告) 未成为合计基准的一层排除)。 */
export type FlowExcludeReason =
  | 'no-valid-quantity'   // 无有效数量(量纲缺失/未知)
  | 'no-canonical'        // mass 但无规范值(单位未注册, 物化层不猜)
  | 'no-unit'             // count 但缺单位(不成池)
  | 'covered-by-actual'   // 预告被实重覆盖(取 max)
  | 'covered-by-notice';  // 实重被预告覆盖(在途批次取预告)

/** 每条流水对 delivered 的贡献归类(additive, 供口径解释)。 */
export interface FlowContribution {
  flowId: string;
  docType: string;
  /** 节点层: actual=实重, notice=预告。 */
  tier: 'actual' | 'notice';
  counted: boolean;
  /** counted=false 时的排除原因。 */
  excludeReason?: FlowExcludeReason;
  /** counted 且 mass: 规范值(千克)。 */
  massKg?: number;
  /** counted 且 count: 池单位 + 原值。 */
  countUnit?: string;
  countValue?: number;
}

/** 计入流水按运输方式分组(每模式条数/质量合计/计数池/docType 构成)。 */
export interface TransportModeGroup {
  mode: string;
  flowCount: number;
  /** 计入 mass 规范合计(千克)。 */
  massKg: number;
  countPools: Record<string, number>;
  /** docType -> 计入条数。 */
  docTypes: Record<string, number>;
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
  /** 口径明细(additive): 每条流水的计入/排除归类(delivered 构成溯源)。 */
  contributions: FlowContribution[];
  /** 计入流水按运输方式分组(additive); 空流水 -> []。 */
  transportModes: TransportModeGroup[];
}

type FlowQty = Pick<
  ExecutionFlowRow,
  'quantityDimension' | 'quantityCanonical' | 'quantityValue' | 'unit'
> & { docType?: string; id?: string };
type LedgerFields = Record<string, { value: string | number }> | null | undefined;

/**
 * 台账数量字段常把单位写进值里(非标合同极常见, 如 "20000吨±10%"/"1000箱")。
 * 保守解析: 前导数字 + 紧随的注册单位后缀; 解析不出返回 null(不猜)。
 */
function parseEmbeddedQuantity(text: string): { qty: number; unit: string } | null {
  const m = /^([\d]+(?:\.\d+)?)(吨|千克|公斤|克|箱|件|车)/.exec(text);
  if (!m) return null;
  return { qty: Number(m[1]), unit: m[2]! };
}

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

  // 口径明细: 按最终池归属归类每条流水(max 语义未成为合计基准的一层排除)。
  const actualMassWins = nodes.actualMassKg >= nodes.noticeMassKg;
  const contributions: FlowContribution[] = flows.map((f) => {
    const tier: 'actual' | 'notice' = flowNodeTier(f.docType) === 'notice' ? 'notice' : 'actual';
    const base = { flowId: f.id ?? '', docType: f.docType ?? '', tier };
    if (f.quantityDimension === 'mass' && f.quantityCanonical != null) {
      const covered = tier === 'notice' ? actualMassWins : !actualMassWins;
      return covered
        ? { ...base, counted: false, excludeReason: tier === 'notice' ? 'covered-by-actual' as const : 'covered-by-notice' as const }
        : { ...base, counted: true, massKg: f.quantityCanonical };
    }
    if (f.quantityDimension === 'count' && f.unit) {
      const actualWins = (nodes.actualPools[f.unit] ?? 0) >= (nodes.noticePools[f.unit] ?? 0);
      const covered = tier === 'notice' ? actualWins : !actualWins;
      return covered
        ? { ...base, counted: false, excludeReason: tier === 'notice' ? 'covered-by-actual' as const : 'covered-by-notice' as const }
        : { ...base, counted: true, countUnit: f.unit, countValue: f.quantityValue ?? 0 };
    }
    if (f.quantityDimension === 'mass') {
      return { ...base, counted: false, excludeReason: 'no-canonical' as const };
    }
    if (f.quantityDimension === 'count') {
      return { ...base, counted: false, excludeReason: 'no-unit' as const };
    }
    return { ...base, counted: false, excludeReason: 'no-valid-quantity' as const };
  });

  // 计入流水按运输方式分组(数量与 contribution 同源)。
  const transportModes: TransportModeGroup[] = [];
  const byMode = new Map<string, TransportModeGroup>();
  for (const c of contributions) {
    if (!c.counted) continue;
    const mode = transportModeForDocType(c.docType);
    let g = byMode.get(mode);
    if (!g) {
      g = { mode, flowCount: 0, massKg: 0, countPools: {}, docTypes: {} };
      byMode.set(mode, g);
      transportModes.push(g);
    }
    g.flowCount += 1;
    g.docTypes[c.docType] = (g.docTypes[c.docType] ?? 0) + 1;
    if (c.massKg != null) g.massKg += c.massKg;
    if (c.countUnit) g.countPools[c.countUnit] = (g.countPools[c.countUnit] ?? 0) + (c.countValue ?? 0);
  }
  const breakdown = { contributions, transportModes };

  const rawQty = ledgerFields?.['数量']?.value;
  const rawUnit = ledgerFields?.['单位']?.value;
  // 空串保底字段等同缺失(spec 2026-08-28): 不产生 0 数量基准。
  if (rawQty === undefined || isEmptyValue(rawQty)) {
    return { basis: null, delivered, progress: null, reason: 'no-contract-basis', ...breakdown };
  }
  const qtyText = String(rawQty).replace(/[,\s]/g, '');
  // 单位优先级: 独立 单位 字段 > 数量值内嵌单位("20000吨±10%"); 都没有 -> 不猜。
  let qty = Number(qtyText);
  let unitText = rawUnit !== undefined && !isEmptyValue(rawUnit) ? String(rawUnit) : null;
  if (!Number.isFinite(qty) || unitText === null) {
    const embedded = parseEmbeddedQuantity(qtyText);
    if (embedded) {
      qty = embedded.qty;
      unitText = embedded.unit;
    }
  }
  if (!Number.isFinite(qty) || unitText === null) {
    return { basis: null, delivered, progress: null, reason: 'no-contract-basis', ...breakdown };
  }
  const canon = canonicalizeQuantity(qty, unitText);
  if (!canon) return { basis: null, delivered, progress: null, reason: 'no-contract-basis', ...breakdown };

  const basis = { quantity: qty, unit: unitText, dimension: canon.dimension, canonical: canon.canonical };
  if (canon.dimension === 'mass') {
    if (delivered.massKg === null) {
      // 有 count 池却要 mass 口径 -> 口径冲突如报 mismatch; 完全无流水 -> 尚未发生, 进度 0。
      if (Object.keys(countPools).length > 0) {
        return { basis, delivered, progress: null, reason: 'dimension-mismatch', ...breakdown };
      }
      return { basis, delivered, progress: 0, ...breakdown };
    }
    return { basis, delivered, progress: basis.canonical > 0 ? delivered.massKg / basis.canonical : null, ...breakdown };
  }
  const pool = countPools[basis.unit];
  if (pool === undefined) return { basis, delivered, progress: null, reason: 'unit-pool-missing', ...breakdown };
  return { basis, delivered, progress: basis.canonical > 0 ? pool / basis.canonical : null, ...breakdown };
}
