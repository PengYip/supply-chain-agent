import { describe, it, expect } from 'vitest';
import {
  checkWeighRow,
  checkWeighTotal,
  WORKBENCH_TABLE_DOCTYPES,
} from '../../src/pipeline/reviewChecks.js';

describe('checkWeighRow(汽运磅单)', () => {
  const okRow = { 毛重_吨: 40.5, 皮重_吨: 15.2, 净重_吨: 25.3, 页码: 1 };

  it('毛-皮=净 精确成立 -> 无 issue', () => {
    expect(checkWeighRow(okRow, '汽运磅单')).toEqual([]);
  });

  it('进位误差 <= 0.02 -> 通过', () => {
    expect(checkWeighRow({ ...okRow, 净重_吨: 25.29 }, '汽运磅单')).toEqual([]);
  });

  it('偏差 > 0.02 -> gross_minus_tare error 且三列标红', () => {
    const issues = checkWeighRow({ ...okRow, 净重_吨: 24.0 }, '汽运磅单');
    const bad = issues.find((i) => i.rule === 'gross_minus_tare')!;
    expect(bad.severity).toBe('error');
    expect(bad.columns).toEqual(['毛重_吨', '皮重_吨', '净重_吨']);
  });

  it('净重 <= 0 -> net_positive error', () => {
    const issues = checkWeighRow({ 毛重_吨: 40, 皮重_吨: 15, 净重_吨: 0 }, '汽运磅单');
    expect(issues.some((i) => i.rule === 'net_positive' && i.severity === 'error')).toBe(true);
  });

  it('毛/皮/净缺失 -> required_missing warning 且不再数值勾稽', () => {
    const issues = checkWeighRow(
      { 毛重_吨: null, 皮重_吨: 15, 净重_吨: 25, 页码: 3 },
      '汽运磅单',
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]!.rule).toBe('required_missing');
    expect(issues[0]!.severity).toBe('warning');
  });
});

describe('checkWeighRow(轨道衡称重单)', () => {
  it('盈亏 = 票重 - 净重 成立 -> 无 issue', () => {
    const row = { 毛重_吨: 80, 皮重_吨: 20, 净重_吨: 60, 票重_吨: 60.5, 盈亏_吨: 0.5, 页码: 2 };
    expect(checkWeighRow(row, '轨道衡称重单')).toEqual([]);
  });

  it('盈亏方向不符 -> surplus_check error', () => {
    const row = { 毛重_吨: 80, 皮重_吨: 20, 净重_吨: 60, 票重_吨: 60.5, 盈亏_吨: -0.5, 页码: 2 };
    expect(
      checkWeighRow(row, '轨道衡称重单').some((i) => i.rule === 'surplus_check'),
    ).toBe(true);
  });

  it('票重/盈亏缺失 -> 不做 surplus 勾稽(可空字段)', () => {
    expect(checkWeighRow({ 毛重_吨: 80, 皮重_吨: 20, 净重_吨: 60, 页码: 2 }, '轨道衡称重单')).toEqual([]);
  });
});

describe('checkWeighTotal', () => {
  it('Σ净重与存量一致(<=0.05) -> pass', () => {
    const t = checkWeighTotal([{ 净重_吨: 25.3, 页码: 1 }, { 净重_吨: 30.0, 页码: 2 }], 55.32);
    expect(t.pass).toBe(true);
    expect(t.actual).toBe(55.3);
    expect(t.tolerance).toBe(0.05);
  });

  it('编辑后漂移 -> fail', () => {
    expect(
      checkWeighTotal([{ 净重_吨: 25.3, 页码: 1 }, { 净重_吨: 31.0, 页码: 2 }], 55.3).pass,
    ).toBe(false);
  });

  it('无存量总净重 -> 恒 pass(expected=null)', () => {
    expect(checkWeighTotal([{ 净重_吨: 10, 页码: 1 }], null).pass).toBe(true);
  });
});

describe('WORKBENCH_TABLE_DOCTYPES', () => {
  it('含两类 schema 票据, 不含化验报告', () => {
    expect(WORKBENCH_TABLE_DOCTYPES.has('汽运磅单')).toBe(true);
    expect(WORKBENCH_TABLE_DOCTYPES.has('轨道衡称重单')).toBe(true);
    expect(WORKBENCH_TABLE_DOCTYPES.has('化验报告')).toBe(false);
  });
});