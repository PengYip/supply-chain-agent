// 凭证 schema 族纯函数测试 (Phase A): 三类 zod schema(用实测真实输出做 fixture)、
// 锚点提取、交叉校验(含中文大写金额正负例)。无 DB 依赖, 全 lane 运行。

import { describe, it, expect } from 'vitest';
import {
  货转单Schema,
  付款凭证Schema,
  化验报告Schema,
  extractAnchors,
  validateVoucher,
  parseChineseAmount,
} from '../../src/pipeline/schemas/vouchers.js';

// ---- 实测真实输出 fixture ----------------------------------------------------

const 货转单Fixture = {
  编号: 'HZ-2024-0715',
  合同号: 'CJXC-CTCL-JY-2024-131-01',
  买方: '山西焦煤集团有限责任公司',
  卖方: '内蒙古伊泰煤炭股份有限公司',
  交货日期: '2024-07-15',
  交货地点: '秦皇岛港',
  交货总量_吨: 5259.54,
  明细行: [
    {
      煤种: '低硫主焦煤',
      运输方式: '铁路',
      数量_吨: 2629.77,
      低位发热量_千卡: 6800,
      全硫: '0.8%',
      暂估价_元每吨: 1330.5,
      含税总价_元: 3498909.29,
      货款75_元: 2624181.97,
    },
    {
      煤种: '低硫主焦煤',
      运输方式: '铁路',
      数量_吨: 2629.77,
      低位发热量_千卡: 6800,
      全硫: '0.8%',
      暂估价_元每吨: 1330.5,
      含税总价_元: 1475.88,
      货款75_元: 1106.91,
    },
  ],
  合计含税总价_元: 3500385.17,
  日期: '2024-07-15',
};

const 付款凭证Fixture = {
  付款人名称: '山西焦煤集团有限责任公司',
  收款人名称: '内蒙古伊泰煤炭股份有限公司',
  金额: 2841620.27,
  金额大写: '贰佰捌拾肆万壹仟陆佰贰拾元零贰角柒分',
  入账日期: '2024-07-16',
  回单编号: 'RC20240716000123',
  附言: '货款',
  付款人账号: '6222020200012345678',
  收款人账号: '6222020200098765432',
};

const 化验报告Fixture = {
  出具机构: '秦皇岛煤炭质量监督检验中心',
  报告编号: 'BG-2024-0715-088',
  送检单位: '山西焦煤集团有限责任公司',
  委托方: '山西焦煤集团有限责任公司',
  品名: '低硫主焦煤',
  重量_吨: 5259.54,
  采样地点: '秦皇岛港',
  装卸地点: '秦皇岛港',
  检测日期: '2024-07-15',
  指标: [
    { 基准: 'ar', 全水_百分比: 8.5, 灰分_百分比: 9.2, 挥发分_百分比: 22.1, 全硫_百分比: 0.8, 低位发热量_千卡每kg: 6200 },
    { 基准: 'ad', 水分_百分比: 2.1, 灰分_百分比: 9.8, 挥发分_百分比: 21.5, 全硫_百分比: 0.82, 低位发热量_千卡每kg: 6500 },
    { 基准: 'd', 灰分_百分比: 10.1, 挥发分_百分比: 21.0, 全硫_百分比: 0.85, 低位发热量_千卡每kg: 6800 },
  ],
};

describe('三类凭证 schema 校验 (实测真实输出 fixture)', () => {
  it('货转单: 2 明细行 5259.54 吨 / 3500385.17 元 通过校验', () => {
    const parsed = 货转单Schema.safeParse(货转单Fixture);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.明细行).toHaveLength(2);
      expect(parsed.data.交货总量_吨).toBe(5259.54);
      expect(parsed.data.合计含税总价_元).toBe(3500385.17);
    }
  });

  it('货转单: 必填字段缺失时校验失败', () => {
    const { 合同号: _合同号, ...missing } = 货转单Fixture;
    const parsed = 货转单Schema.safeParse(missing);
    expect(parsed.success).toBe(false);
  });

  it('付款凭证: 2841620.27 / 贰佰捌拾肆万壹仟陆佰贰拾元零贰角柒分 通过校验', () => {
    const parsed = 付款凭证Schema.safeParse(付款凭证Fixture);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.金额).toBe(2841620.27);
      expect(parsed.data.金额大写).toBe('贰佰捌拾肆万壹仟陆佰贰拾元零贰角柒分');
    }
  });

  it('化验报告: 三基(ar/ad/d)指标通过校验', () => {
    const parsed = 化验报告Schema.safeParse(化验报告Fixture);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.指标).toHaveLength(3);
      expect(parsed.data.指标![0]!.基准).toBe('ar');
      expect(parsed.data.指标![2]!.基准).toBe('d');
    }
  });

  it('化验报告: 非法基准值校验失败', () => {
    const bad = {
      ...化验报告Fixture,
      指标: [{ 基准: 'xyz', 低位发热量_千卡每kg: 6200 }],
    };
    expect(化验报告Schema.safeParse(bad).success).toBe(false);
  });
});

describe('extractAnchors (锚点提取)', () => {
  it('货转单: buyer/seller/amount/quantityTon/contractNo', () => {
    const a = extractAnchors('货转单', 货转单Fixture);
    expect(a.buyer).toBe('山西焦煤集团有限责任公司');
    expect(a.seller).toBe('内蒙古伊泰煤炭股份有限公司');
    expect(a.amount).toBe(3500385.17);
    expect(a.quantityTon).toBe(5259.54);
    expect(a.contractNo).toBe('CJXC-CTCL-JY-2024-131-01');
    expect(a.date).toBe('2024-07-15');
  });

  it('付款凭证: buyer=付款人 seller=收款人 amount=金额 date=入账日期', () => {
    const a = extractAnchors('付款凭证', 付款凭证Fixture);
    expect(a.buyer).toBe('山西焦煤集团有限责任公司');
    expect(a.seller).toBe('内蒙古伊泰煤炭股份有限公司');
    expect(a.amount).toBe(2841620.27);
    expect(a.date).toBe('2024-07-16');
    expect(a.contractNo).toBeUndefined();
  });

  it('化验报告: buyer=送检单位||委托方 quantityTon=重量_吨 date=检测日期', () => {
    const a = extractAnchors('化验报告', 化验报告Fixture);
    expect(a.buyer).toBe('山西焦煤集团有限责任公司');
    expect(a.quantityTon).toBe(5259.54);
    expect(a.date).toBe('2024-07-15');
    expect(a.amount).toBeUndefined();
  });

  it('化验报告: 送检单位缺失时回退委托方', () => {
    const { 送检单位: _送检单位, ...rest } = 化验报告Fixture;
    const a = extractAnchors('化验报告', rest);
    expect(a.buyer).toBe('山西焦煤集团有限责任公司');
  });

  it('其他: 返回空锚点', () => {
    expect(extractAnchors('其他', {})).toEqual({});
  });
});

describe('parseChineseAmount (中文大写金额解析)', () => {
  it('正例: 贰佰捌拾肆万壹仟陆佰贰拾元零贰角柒分 = 2841620.27', () => {
    expect(parseChineseAmount('贰佰捌拾肆万壹仟陆佰贰拾元零贰角柒分')).toBeCloseTo(2841620.27, 2);
  });

  it('正例: 壹佰元整 = 100', () => {
    expect(parseChineseAmount('壹佰元整')).toBe(100);
  });

  it('正例: 拾万 = 100000 (缺省 1)', () => {
    expect(parseChineseAmount('拾万')).toBe(100000);
  });

  it('正例: 壹亿贰仟万 = 120000000', () => {
    expect(parseChineseAmount('壹亿贰仟万')).toBe(120000000);
  });

  it('正例: 伍角 = 0.5 (无元)', () => {
    expect(parseChineseAmount('伍角')).toBeCloseTo(0.5, 2);
  });

  it('正例: 壹元零贰分 = 1.02', () => {
    expect(parseChineseAmount('壹元零贰分')).toBeCloseTo(1.02, 2);
  });

  it('反例: 含未知字符(人民币前缀)返回 null', () => {
    expect(parseChineseAmount('人民币贰佰元整')).toBeNull();
  });

  it('反例: 空串返回 null', () => {
    expect(parseChineseAmount('')).toBeNull();
  });
});

describe('validateVoucher (交叉校验 warnings)', () => {
  it('货转单: 明细合计与总量/总价一致 -> 无 warning', () => {
    expect(validateVoucher('货转单', 货转单Fixture)).toEqual([]);
  });

  it('货转单: 数量合计与交货总量不一致 -> warning', () => {
    const bad = { ...货转单Fixture, 交货总量_吨: 9999.99 };
    const warnings = validateVoucher('货转单', bad);
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings.some((w) => w.includes('数量合计'))).toBe(true);
  });

  it('货转单: 含税总价合计与合计总价不一致 -> warning', () => {
    const bad = { ...货转单Fixture, 合计含税总价_元: 1.0 };
    const warnings = validateVoucher('货转单', bad);
    expect(warnings.some((w) => w.includes('含税总价合计'))).toBe(true);
  });

  it('付款凭证: 大写金额与金额一致 -> 无 warning', () => {
    expect(validateVoucher('付款凭证', 付款凭证Fixture)).toEqual([]);
  });

  it('付款凭证: 大写金额与金额不一致 -> warning', () => {
    const bad = { ...付款凭证Fixture, 金额: 100.0 };
    const warnings = validateVoucher('付款凭证', bad);
    expect(warnings.some((w) => w.includes('金额大写'))).toBe(true);
  });

  it('付款凭证: 大写金额无法解析 -> 跳过校验(不产生 warning)', () => {
    const bad = { ...付款凭证Fixture, 金额大写: '人民币贰佰元整' };
    expect(validateVoucher('付款凭证', bad)).toEqual([]);
  });

  it('化验报告: 三基 ar<ad<d 且 全水(ar)<=水分(ad) -> 无 warning', () => {
    expect(validateVoucher('化验报告', 化验报告Fixture)).toEqual([]);
  });

  it('化验报告: 低位发热量 ar>=ad -> warning', () => {
    const bad = {
      ...化验报告Fixture,
      指标: [
        { 基准: 'ar', 低位发热量_千卡每kg: 6800 },
        { 基准: 'ad', 低位发热量_千卡每kg: 6500 },
      ],
    };
    const warnings = validateVoucher('化验报告', bad);
    expect(warnings.some((w) => w.includes('ar') && w.includes('ad'))).toBe(true);
  });

  it('化验报告: 全水(ar) <= 水分(ad) -> warning', () => {
    const bad = {
      ...化验报告Fixture,
      指标: [
        { 基准: 'ar', 全水_百分比: 1.0 },
        { 基准: 'ad', 水分_百分比: 2.1 },
      ],
    };
    const warnings = validateVoucher('化验报告', bad);
    expect(warnings.some((w) => w.includes('全水'))).toBe(true);
  });

  it('其他: 无校验规则 -> 空 warnings', () => {
    expect(validateVoucher('其他', {})).toEqual([]);
  });
});