// 数量单位注册表(L1): 通用履约物化层的量纲与换算唯一归宿(spec 2026-08-27 §3)。
// 纯数据 + 纯函数; 新增单位 = 注册表加一行, 机制不变。未知单位宁可 null 不猜。

export type QuantityDimension = 'mass' | 'count';

/** mass: canonical=千克, factorToKg 为换算系数; count: 各单位自成聚合池, factor 恒 1。 */
export interface UnitDef {
  readonly dimension: QuantityDimension;
  readonly factorToKg: number;
}

export const UNIT_REGISTRY: Readonly<Record<string, UnitDef>> = {
  吨: { dimension: 'mass', factorToKg: 1000 },
  千克: { dimension: 'mass', factorToKg: 1 },
  公斤: { dimension: 'mass', factorToKg: 1 },
  克: { dimension: 'mass', factorToKg: 0.001 },
  箱: { dimension: 'count', factorToKg: 1 },
  件: { dimension: 'count', factorToKg: 1 },
  车: { dimension: 'count', factorToKg: 1 },
};

/** 归一化后精确匹配(trim; 不做别名/模糊匹配), 未注册返回 null。 */
export function resolveUnit(name: string): UnitDef | null {
  const key = name.trim();
  return UNIT_REGISTRY[key] ?? null;
}

export interface CanonicalQuantity {
  readonly dimension: QuantityDimension;
  /** mass -> 千克; count -> 原值。 */
  readonly canonical: number;
}

/** 未注册单位返回 null(调用方保留原值, dimension/canonical 落 NULL)。 */
export function canonicalizeQuantity(value: number, unit: string): CanonicalQuantity | null {
  const def = resolveUnit(unit);
  if (!def) return null;
  return {
    dimension: def.dimension,
    canonical: def.dimension === 'mass' ? value * def.factorToKg : value,
  };
}

/** 锚点数量投影(物化层统一形状): 原值+原始单位+量纲+规范值。 */
export interface AnchorQuantity {
  readonly value: number;
  readonly unit?: string;
  readonly dimension: QuantityDimension | null;
  readonly canonical: number | null;
}
