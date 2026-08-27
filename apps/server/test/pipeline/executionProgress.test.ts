import { describe, it, expect } from 'vitest';
import { computeExecutionProgress } from '../../src/pipeline/executionProgress.js';

const mass = (canonical: number) => ({
  quantityDimension: 'mass' as const,
  quantityCanonical: canonical,
  quantityValue: canonical,
  unit: '吨',
});
const count = (unit: string, value: number) => ({
  quantityDimension: 'count' as const,
  quantityCanonical: value,
  quantityValue: value,
  unit,
});
const wrap = (m: Record<string, string | number>) =>
  Object.fromEntries(Object.entries(m).map(([k, v]) => [k, { value: v }]));

describe('computeExecutionProgress(spec 2026-08-27 §9)', () => {
  it('mass 对齐: 台账 3吨, 已发 1+0.5吨 -> 0.5', () => {
    const r = computeExecutionProgress([mass(1000), mass(500)], wrap({ 数量: 3, 单位: '吨' }));
    expect(r.basis).toEqual({ quantity: 3, unit: '吨', dimension: 'mass', canonical: 3000 });
    expect(r.delivered!.massKg).toBe(1500);
    expect(r.progress).toBeCloseTo(0.5);
  });

  it('贵金属: 台账 500克, 流水 0.25kg(=250克) -> 进度 0.5(千克规范口径跨单位可算)', () => {
    const r = computeExecutionProgress([mass(0.25)], wrap({ 数量: 500, 单位: '克' }));
    expect(r.basis!.canonical).toBe(0.5); // 500克 -> 0.5 kg
    expect(r.progress).toBeCloseTo(0.5);
  });

  it('量纲不一致: 台账吨 vs 流水箱 -> progress null + dimension-mismatch', () => {
    const r = computeExecutionProgress([count('箱', 120)], wrap({ 数量: 3, 单位: '吨' }));
    expect(r.progress).toBeNull();
    expect(r.reason).toBe('dimension-mismatch');
  });

  it('count 池对齐: 台账箱 对 箱池', () => {
    const r = computeExecutionProgress([count('箱', 30), count('箱', 20)], wrap({ 数量: 100, 单位: '箱' }));
    expect(r.progress).toBeCloseTo(0.5);
  });

  it('count 池缺失(台账件 vs 流水箱) -> progress null + unit-pool-missing', () => {
    const r = computeExecutionProgress([count('箱', 30)], wrap({ 数量: 100, 单位: '件' }));
    expect(r.progress).toBeNull();
    expect(r.reason).toBe('unit-pool-missing');
  });

  it('无台账基准 -> no-contract-basis', () => {
    const r = computeExecutionProgress([mass(1000)], null);
    expect(r.basis).toBeNull();
    expect(r.reason).toBe('no-contract-basis');
  });

  it('台账数量非数值/单位未注册 -> no-contract-basis(不猜)', () => {
    expect(computeExecutionProgress([], wrap({ 数量: '未知', 单位: '吨' })).reason).toBe('no-contract-basis');
    expect(computeExecutionProgress([], wrap({ 数量: 3, 单位: '磅' })).reason).toBe('no-contract-basis');
    expect(computeExecutionProgress([], wrap({ 单位: '吨' })).reason).toBe('no-contract-basis');
  });

  it('基准为 0 -> progress null(避免除零)', () => {
    const r = computeExecutionProgress([mass(1000)], wrap({ 数量: 0, 单位: '吨' }));
    expect(r.progress).toBeNull();
  });
});
