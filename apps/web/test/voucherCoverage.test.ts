// voucherCoverage 纯函数单测: 维度映射(relation 优先/docType 兜底)、齐套率聚合、
// 未登记条目不计入维度(不虚增覆盖率)。
import { describe, expect, it } from 'vitest';
import {
  VOUCHER_DIMENSIONS,
  coverageOf,
  countByDimension,
  dimensionOfEntry,
} from '../src/lib/voucherCoverage';

describe('dimensionOfEntry', () => {
  it('relation 优先: 引用->合同文本, 收货->货权, 开票->发票', () => {
    expect(dimensionOfEntry({ relation: '引用', docType: '发票' })).toBe('contract');
    expect(dimensionOfEntry({ relation: '收货', docType: '货转单' })).toBe('goods');
    expect(dimensionOfEntry({ relation: '开票', docType: '发票' })).toBe('invoice');
  });

  it('relation 未登记时 docType 兜底: 凭证(fallback 词)+提单->货权', () => {
    expect(dimensionOfEntry({ relation: '凭证', docType: '提单' })).toBe('goods');
    expect(dimensionOfEntry({ relation: '', docType: '付款凭证' })).toBe('fund');
    expect(dimensionOfEntry({ relation: '', docType: '化验报告' })).toBe('quality');
  });

  it('两侧都未登记 -> null(其他/凭证 不计入任何维度)', () => {
    expect(dimensionOfEntry({ relation: '凭证', docType: '其他' })).toBeNull();
    expect(dimensionOfEntry({ relation: '', docType: '' })).toBeNull();
  });

  it('方向编码 settles 词都映射: 收货/发货/收票/开票/收款/付款申请', () => {
    expect(dimensionOfEntry({ relation: '发货', docType: '' })).toBe('goods');
    expect(dimensionOfEntry({ relation: '收票', docType: '' })).toBe('invoice');
    expect(dimensionOfEntry({ relation: '收款', docType: '' })).toBe('fund');
    expect(dimensionOfEntry({ relation: '付款申请', docType: '' })).toBe('fund');
  });
});

describe('coverageOf', () => {
  it('空条目 -> 0% 且缺全部五维', () => {
    const c = coverageOf([]);
    expect(c.ratio).toBe(0);
    expect(c.covered.size).toBe(0);
    expect(c.missingLabels).toEqual(VOUCHER_DIMENSIONS.map((d) => d.label));
  });

  it('五维各一张 -> 100%', () => {
    const c = coverageOf([
      { relation: '引用', docType: '合同' },
      { relation: '货权转移', docType: '货转单' },
      { relation: '付款', docType: '付款凭证' },
      { relation: '开票', docType: '发票' },
      { relation: '质检', docType: '化验报告' },
    ]);
    expect(c.ratio).toBe(1);
    expect(c.missingLabels).toEqual([]);
  });

  it('同维多张只计一次覆盖: 三张货转单 -> 1/5', () => {
    const c = coverageOf([
      { relation: '货权转移', docType: '货转单' },
      { relation: '收货', docType: '收货单' },
      { relation: '', docType: '提单' },
    ]);
    expect(c.covered.size).toBe(1);
    expect(c.ratio).toBeCloseTo(1 / 5);
    expect(c.missingLabels).not.toContain('货权');
  });

  it('未登记条目不虚增覆盖率', () => {
    const withOther = coverageOf([
      { relation: '引用', docType: '合同' },
      { relation: '凭证', docType: '其他' },
    ]);
    const without = coverageOf([{ relation: '引用', docType: '合同' }]);
    expect(withOther.ratio).toBe(without.ratio);
  });
});

describe('countByDimension', () => {
  it('按维度计数; 未覆盖维度不出现(取值侧给 0)', () => {
    const counts = countByDimension([
      { relation: '货权转移', docType: '货转单' },
      { relation: '收货', docType: '收货单' },
      { relation: '付款', docType: '付款凭证' },
    ]);
    expect(counts.get('goods')).toBe(2);
    expect(counts.get('fund')).toBe(1);
    expect(counts.has('invoice')).toBe(false);
  });
});
