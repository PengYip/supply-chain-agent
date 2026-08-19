import { describe, it, expect } from 'vitest';
import { buildAnchorsFromFields, PARTY_FIELD_ALIASES } from '../../src/pipeline/bindingProposal.js';

describe('buildAnchorsFromFields(非图片凭证文档)', () => {
  it('发票: 合同号/买方/卖方/金额/日期字段映射到锚点', () => {
    const a = buildAnchorsFromFields('发票', {
      合同号: { value: 'HT-2024-001' },
      买方: { value: '甲公司' },
      卖方: { value: '乙公司' },
      价税合计: { value: '12345.67' },
      开票日期: { value: '2024-08-01' },
    });
    expect(a).toEqual({
      contractNo: 'HT-2024-001', buyer: '甲公司', seller: '乙公司',
      date: '2024-08-01', amount: 12345.67,
    });
  });

  it('提单: 甲方/乙方(合同角色别名)与数量解析', () => {
    const a = buildAnchorsFromFields('提单', {
      合同编号: { value: 'CJXC-131' },
      甲方: { value: '买方公司' },
      乙方: { value: '卖方公司' },
      数量: { value: '150' },
    });
    expect(a.contractNo).toBe('CJXC-131');
    expect(a.buyer).toBe('买方公司');
    expect(a.seller).toBe('卖方公司');
    expect(a.quantityTon).toBe(150);
    // 裸 '数量' 字段不带单位语义: unit 缺省, 不猜测。
    expect(a.quantityUnit).toBeUndefined();
  });

  it("'_吨' 后缀数量字段 -> quantityUnit 确定为吨", () => {
    const a = buildAnchorsFromFields('装箱单', {
      重量_吨: { value: '80.5' },
    });
    expect(a.quantityTon).toBe(80.5);
    expect(a.quantityUnit).toBe('吨');
  });

  it('空字段/无法解析的数值 -> 对应锚点缺省', () => {
    const a = buildAnchorsFromFields('装箱单', { 备注: { value: '无' } });
    expect(a).toEqual({});
  });

  it('无可用字段返回空对象(调用方以此判定缺锚点)', () => {
    expect(buildAnchorsFromFields('其他', {})).toEqual({});
  });

  it('真实发票字段(购买方名称/销售方名称/价税合计小写_元 + 单位=吨) -> 新别名与显式单位命中', () => {
    const a = buildAnchorsFromFields('发票', {
      购买方名称: { value: '浙江浙能富兴燃料有限公司' },
      销售方名称: { value: '上海某贸易有限公司' },
      价税合计小写_元: { value: '1128515.08' },
      开票日期: { value: '2021-06-08' },
      发票号码: { value: '04981234' },
      数量: { value: '3819.65' },
      单位: { value: '吨' },
      税率: { value: '13%' },
      税额_元: { value: '129842.34' },
    });
    expect(a.buyer).toBe('浙江浙能富兴燃料有限公司');
    expect(a.seller).toBe('上海某贸易有限公司');
    expect(a.amount).toBe(1128515.08);
    expect(a.date).toBe('2021-06-08');
    expect(a.quantityTon).toBe(3819.65);
    // 显式 单位=吨 字段 -> 裸 '数量' 的单位确定为吨。
    expect(a.quantityUnit).toBe('吨');
  });

  it("数量 + 单位=千克 -> quantityUnit 缺省(仅'吨'被显式认定)", () => {
    const a = buildAnchorsFromFields('发票', {
      数量: { value: '1000' },
      单位: { value: '千克' },
    });
    expect(a.quantityTon).toBe(1000);
    expect(a.quantityUnit).toBeUndefined();
  });

  it('数量 + 无单位字段 -> quantityUnit 缺省(不猜测)', () => {
    const a = buildAnchorsFromFields('发票', { 数量: { value: '120' } });
    expect(a.quantityTon).toBe(120);
    expect(a.quantityUnit).toBeUndefined();
  });

  it('货转单: 受让方/转让方 别名映射到买方/卖方', () => {
    const a = buildAnchorsFromFields('货转单', {
      受让方: { value: '浙江浙能富兴燃料有限公司' },
      转让方: { value: '某电厂' },
      航次: { value: 'V2021-01' },
      船名: { value: '浙能1号' },
      起运港: { value: '宁波' },
      到达港: { value: '舟山' },
    });
    expect(a.buyer).toBe('浙江浙能富兴燃料有限公司');
    expect(a.seller).toBe('某电厂');
  });

  it('只做精确键匹配: 部分重叠键(销售方/价税合计大写_元/购买方)不命中新别名', () => {
    const a = buildAnchorsFromFields('发票', {
      销售方: { value: '上海某贸易有限公司' },
      价税合计大写_元: { value: '壹佰壹拾贰万捌仟伍佰壹拾伍元零捌分' },
      购买方: { value: '浙江浙能富兴燃料有限公司' },
    });
    expect(a.seller).toBeUndefined();
    expect(a.amount).toBeUndefined();
    expect(a.buyer).toBeUndefined();
  });

  it('PARTY_FIELD_ALIASES 导出买方/卖方别名常量(供候选扫描复用)', () => {
    expect(PARTY_FIELD_ALIASES.buyer).toEqual(['买方', '甲方', '收货人', '购买方名称', '受让方']);
    expect(PARTY_FIELD_ALIASES.seller).toEqual(['卖方', '乙方', '发货人', '销售方名称', '转让方']);
  });
});
