import { describe, it, expect } from 'vitest';
import {
  roleNaturalDirection,
  timelineDates,
  cumulativeAsOf,
  executedInBasisUnit,
  pendingInBasisUnit,
  type ExecutionProgressView,
  type TimelineFlowRow,
} from '../src/lib/executionProgress';

/* ---------- 执行进度展示纯函数(spec 2026-08-27 台账整合 §4) ---------- */

const row = (extra: Partial<TimelineFlowRow>): TimelineFlowRow => ({
  flowType: '资金流',
  direction: 'in',
  amount: null,
  quantityTon: null,
  voucherDate: null,
  ...extra,
});

describe('roleNaturalDirection', () => {
  it('采购: 收货(in)/付款(out)/收票(in)', () => {
    expect(roleNaturalDirection('采购', '货物流')).toBe('in');
    expect(roleNaturalDirection('采购', '资金流')).toBe('out');
    expect(roleNaturalDirection('采购', '发票流')).toBe('in');
  });
  it('销售: 发货(out)/收款(in)/开票(out)', () => {
    expect(roleNaturalDirection('销售', '货物流')).toBe('out');
    expect(roleNaturalDirection('销售', '资金流')).toBe('in');
    expect(roleNaturalDirection('销售', '发票流')).toBe('out');
  });
  it('其他角色 -> null(双向显示)', () => {
    expect(roleNaturalDirection('物流', '货物流')).toBeNull();
    expect(roleNaturalDirection('未分类', '资金流')).toBeNull();
  });
});

describe('timelineDates', () => {
  it('升序去重; 无日期行不产生刻度', () => {
    const rows = [
      row({ voucherDate: '2026-03-02' }),
      row({ voucherDate: '2026-01-15' }),
      row({ voucherDate: '2026-03-02' }),
      row({ voucherDate: null }),
      row({ voucherDate: '' }),
    ];
    expect(timelineDates(rows)).toEqual(['2026-01-15', '2026-03-02']);
  });
  it('空流水 -> 空刻度', () => {
    expect(timelineDates([])).toEqual([]);
  });
});

describe('cumulativeAsOf', () => {
  const rows = [
    row({ flowType: '货物流', direction: 'out', quantityTon: 3000, voucherDate: '2026-01-10' }),
    row({ flowType: '货物流', direction: 'out', quantityTon: 3200, voucherDate: '2026-02-05' }),
    row({ flowType: '资金流', direction: 'in', amount: 500, voucherDate: '2026-01-20' }),
    row({ flowType: '资金流', direction: 'out', amount: 100, voucherDate: null }), // 无日期, 回放不计
  ];

  it('截至首笔日: 只含 2026-01-10 的发货', () => {
    const m = cumulativeAsOf(rows, '2026-01-10');
    expect(m.get('货物流-out')).toEqual({ entryCount: 1, totalAmount: null, totalQuantityTon: 3000 });
    expect(m.has('资金流-in')).toBe(false);
  });
  it('截至月中: 发货累计 3000+3200, 收款 500; 无日期行不计', () => {
    const m = cumulativeAsOf(rows, '2026-02-05');
    expect(m.get('货物流-out')).toEqual({ entryCount: 2, totalAmount: null, totalQuantityTon: 6200 });
    expect(m.get('资金流-in')).toEqual({ entryCount: 1, totalAmount: 500, totalQuantityTon: null });
    expect(m.has('资金流-out')).toBe(false);
  });
  it('null 金额/数量保持 null(与 0 区分)', () => {
    const m = cumulativeAsOf([row({ amount: null, voucherDate: '2026-01-01' })], '2026-01-01');
    expect(m.get('资金流-in')?.totalAmount).toBeNull();
  });
});

describe('executedInBasisUnit / pendingInBasisUnit', () => {
  const massProgress = (partial: Partial<ExecutionProgressView>): ExecutionProgressView => ({
    basis: { quantity: 10000, unit: '吨', dimension: 'mass', canonical: 10_000_000 },
    delivered: { massKg: null, countPools: {} },
    progress: null,
    ...partial,
  });

  it('mass 线性回换: 6,000,000kg / 10,000,000kg * 10000 = 6000 吨', () => {
    const p = massProgress({ delivered: { massKg: 6_000_000, countPools: {} }, progress: 0.6 });
    expect(executedInBasisUnit(p)).toBeCloseTo(6000);
    expect(pendingInBasisUnit(p)).toBeCloseTo(4000);
  });
  it('超额: 已执行超基准 -> 待执行为负(如实呈现不封顶)', () => {
    const p = massProgress({ delivered: { massKg: 10_300_000, countPools: {} }, progress: 1.03 });
    expect(pendingInBasisUnit(p)).toBeCloseTo(-300);
  });
  it('count 口径取对应单位池', () => {
    const p: ExecutionProgressView = {
      basis: { quantity: 500, unit: '箱', dimension: 'count', canonical: 500 },
      delivered: { massKg: null, countPools: { 箱: 200 } },
      progress: 0.4,
    };
    expect(executedInBasisUnit(p)).toBe(200);
    expect(pendingInBasisUnit(p)).toBe(300);
  });
  it('无基准 -> 双 null; 有基准无流水 -> 待执行=全额', () => {
    const noBasis = massProgress({ basis: null, reason: 'no-contract-basis' });
    expect(executedInBasisUnit(noBasis)).toBeNull();
    expect(pendingInBasisUnit(noBasis)).toBeNull();
    const untouched = massProgress({ delivered: { massKg: null, countPools: {} }, progress: 0 });
    expect(pendingInBasisUnit(untouched)).toBe(10000);
  });
  it('量纲/单位池不对齐 -> 待执行 null(不硬算)', () => {
    const mismatch = massProgress({ reason: 'dimension-mismatch', delivered: { massKg: null, countPools: { 箱: 5 } } });
    expect(pendingInBasisUnit(mismatch)).toBeNull();
    const poolMissing = massProgress({ reason: 'unit-pool-missing', delivered: { massKg: null, countPools: { 件: 5 } } });
    expect(pendingInBasisUnit(poolMissing)).toBeNull();
  });
});
