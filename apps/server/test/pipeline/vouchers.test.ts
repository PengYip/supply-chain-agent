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

  it('化验报告: 四基(ar/ad/d/daf)指标通过校验', () => {
    const parsed = 化验报告Schema.safeParse(化验报告Fixture);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.指标).toHaveLength(3);
      expect(parsed.data.指标![0]!.基准).toBe('ar');
      expect(parsed.data.指标![2]!.基准).toBe('d');
    }
  });

  it('化验报告: daf 基准(干燥无灰基, 挥发分常用)通过校验', () => {
    const parsed = 化验报告Schema.safeParse({
      ...化验报告Fixture,
      指标: [
        ...化验报告Fixture.指标!,
        { 基准: 'daf', 挥发分_百分比: 38.5 },
      ],
    });
    expect(parsed.success).toBe(true);
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
    expect(a.quantityUnit).toBe('吨');
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
    expect(a.quantityUnit).toBe('吨');
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

  // 跨量纲修复(设计文档 §8.2): ar 行报千卡/kg、ad 行报 MJ/kg 属可互换单位,
  // 换算后物理关系成立时不得再报(此前直接比数值 -> 必然误报)。
  it('化验报告: 跨量纲 ar(千卡) < ad(MJ) 换算后成立 -> 无 warning', () => {
    // 25.7 MJ/kg = 25.7 * 238.8459 ~= 6138 kcal/kg > 5500 kcal/kg, 物理成立。
    const mixed = {
      指标: [
        { 基准: 'ar', 低位发热量_千卡每kg: 5500 },
        { 基准: 'ad', 低位发热量_MJ每kg: 25.7 },
      ],
    };
    expect(validateVoucher('化验报告', mixed)).toEqual([]);
  });

  it('化验报告: 跨量纲但换算后 ar>=ad(真实违反) -> warning', () => {
    // 25.7 MJ/kg ~= 6138 kcal/kg < 6500 kcal/kg, 物理违反 -> 必须仍告警。
    const mixedBad = {
      指标: [
        { 基准: 'ar', 低位发热量_千卡每kg: 6500 },
        { 基准: 'ad', 低位发热量_MJ每kg: 25.7 },
      ],
    };
    const warnings = validateVoucher('化验报告', mixedBad);
    expect(warnings.some((w) => w.includes('ar') && w.includes('ad'))).toBe(true);
  });

  it('化验报告: 混合单位 ad(kcal) < d(MJ) 换算后成立 -> 无 warning', () => {
    // ad 行千卡 6600 < d 行 28 MJ/kg(~6688 kcal) -> 成立。
    const mixed = {
      指标: [
        { 基准: 'ad', 低位发热量_千卡每kg: 6600 },
        { 基准: 'd', 低位发热量_MJ每kg: 28 },
      ],
    };
    expect(validateVoucher('化验报告', mixed)).toEqual([]);
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
// ---- v2.1 重量凭证组(汽运磅单/轨道衡称重单/水尺计重单) ----------------------

import {
  汽运磅单Schema,
  轨道衡称重单Schema,
  水尺计重单Schema,
  VOUCHER_SCHEMAS,
  WEIGHT_AGGREGATE_DOCTYPES,
} from '../../src/pipeline/schemas/vouchers.js';

describe('汽运磅单 schema + 校验', () => {
  const rows = [
    { 编号: 'ERP1', 车号: '渝DD5739', 毛重_吨: 48.82, 皮重_吨: 16.18, 净重_吨: 32.64, 毛重时间: '2025-09-10 09:25', 皮重时间: '2025-09-10 09:44', 称号: '#6轻磅' },
    { 编号: 'ERP2', 车号: '贵F31172', 毛重_吨: 48.5, 皮重_吨: 16.02, 净重_吨: 32.48 },
  ];
  const fields = { 明细行: rows, 总净重_吨: 65.12, 页数: 2, 失败页: [] };

  it('schema parse 通过(实测样例形状)', () => {
    expect(汽运磅单Schema.safeParse(fields).success).toBe(true);
  });
  it('缺 总净重_吨 拒绝', () => {
    const { 总净重_吨: _drop, ...rest } = fields;
    expect(汽运磅单Schema.safeParse(rest).success).toBe(false);
  });
  it('毛重-皮重 != 净重 -> warning', () => {
    const bad = { ...fields, 明细行: [{ ...rows[0]!, 净重_吨: 30 }] };
    const w = validateVoucher('汽运磅单', bad);
    expect(w.some((x) => x.includes('明细行1'))).toBe(true);
  });
  it('行净重合计 != 总净重 -> warning; 一致 -> 空', () => {
    const w = validateVoucher('汽运磅单', { ...fields, 总净重_吨: 60 });
    expect(w.some((x) => x.includes('总净重'))).toBe(true);
    expect(validateVoucher('汽运磅单', fields)).toEqual([]);
  });
  it('失败页落 fields 且参与校验不产生额外 warning', () => {
    const w = validateVoucher('汽运磅单', { ...fields, 失败页: [7] });
    expect(w).toEqual([]);
  });
});

describe('轨道衡称重单 schema + 校验', () => {
  const rows = [
    { 车型: 'C70', 车号: '1616368', 毛重_吨: 85.2, 皮重_吨: 22.4, 净重_吨: 62.8, 票重_吨: 70, 盈亏_吨: -7.2 },
    { 车型: 'C64K', 车号: '4895414', 毛重_吨: 80.1, 皮重_吨: 20.2, 净重_吨: 59.9, 票重_吨: 61, 盈亏_吨: -1.1 },
  ];
  const fields = { 编号: '2494', 称量日期: '2024-08-27', 明细行: rows, 总净重_吨: 122.7, 页数: 2, 失败页: [] };

  it('schema parse 通过', () => {
    expect(轨道衡称重单Schema.safeParse(fields).success).toBe(true);
  });
  it('毛重-皮重 != 净重 -> warning', () => {
    const bad = { ...fields, 明细行: [{ ...rows[0]!, 净重_吨: 60 }] };
    expect(validateVoucher('轨道衡称重单', bad).some((x) => x.includes('第1行'))).toBe(true);
  });
  it('净重-票重 != 盈亏 -> warning', () => {
    const bad = { ...fields, 明细行: [{ ...rows[0]!, 盈亏_吨: 0 }] };
    expect(validateVoucher('轨道衡称重单', bad).some((x) => x.includes('盈亏'))).toBe(true);
  });
  it('合计一致且行自洽 -> 空 warnings', () => {
    expect(validateVoucher('轨道衡称重单', fields)).toEqual([]);
  });
});

describe('水尺计重单 schema + 锚点', () => {
  const fields = { 船名: '硕隆817', 航次: '2511', 泊位: '泉州沙格码头', 货名: '煤炭', 卸货量_吨: 72079, 检测日期: '2025.6.22' };
  it('schema parse 通过; 缺船名/卸货量拒绝', () => {
    expect(水尺计重单Schema.safeParse(fields).success).toBe(true);
    expect(水尺计重单Schema.safeParse({ ...fields, 船名: '' }).success).toBe(false);
  });
  it('anchors: quantityTon=卸货量 date=检测日期', () => {
    const a = extractAnchors('水尺计重单', fields);
    expect(a.quantityTon).toBe(72079);
    expect(a.date).toBe('2025.6.22');
  });
  it('磅单 anchors: quantityTon=总净重', () => {
    const a = extractAnchors('汽运磅单', { 明细行: [], 总净重_吨: 65.12 });
    expect(a.quantityTon).toBe(65.12);
  });
});

describe('VOUCHER_SCHEMAS 注册表与聚合模式集合', () => {
  it('三种重量类型已注册且有聚合标记', () => {
    for (const t of ['汽运磅单', '轨道衡称重单', '水尺计重单'] as const) {
      expect(VOUCHER_SCHEMAS[t]).toBeDefined();
      expect(WEIGHT_AGGREGATE_DOCTYPES.has(t)).toBe(true);
    }
    expect(WEIGHT_AGGREGATE_DOCTYPES.has('货转单')).toBe(false);
  });
});
