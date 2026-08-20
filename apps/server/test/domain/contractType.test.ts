import { describe, expect, it } from 'vitest';
import { deriveContractType } from '../../src/domain/contractType.js';

const F = (name: string, value: string | number) => ({ name, value });

describe('deriveContractType', () => {
  it('非合同 docType 一律 null', () => {
    const r = deriveContractType({ docType: '发票', fields: [F('合同类型', '销售合同')], selfPartyNames: ['我方'] });
    expect(r).toEqual({ contractType: null, source: null, conflict: false });
  });

  it('合同类型字段命中别名映射 -> field 来源', () => {
    const r = deriveContractType({ docType: '合同', fields: [F('合同类型', '运输合同')], selfPartyNames: [] });
    expect(r.contractType).toBe('物流');
    expect(r.source).toBe('field');
  });

  it('字段是受控值本身时直接采用', () => {
    const r = deriveContractType({ docType: '合同', fields: [F('合同类型', '租赁')], selfPartyNames: [] });
    expect(r.contractType).toBe('租赁');
    expect(r.source).toBe('field');
  });

  it('购销合同不映射(无方向语义), 回退主体侧别', () => {
    const r = deriveContractType({
      docType: '合同',
      fields: [F('合同类型', '购销合同'), F('甲方', '我方贸易'), F('乙方', '某供应商')],
      selfPartyNames: ['我方贸易'],
    });
    // 甲方=主体 -> buyer -> 采购; 购销合同字段不产生 fieldType, 不算冲突
    expect(r).toEqual({ contractType: '采购', source: 'side', conflict: false });
  });

  it('字段与主体侧别方向相反 -> conflict 标记, 字段胜出', () => {
    const r = deriveContractType({
      docType: '合同',
      fields: [F('合同类型', '销售合同'), F('买方', '我方贸易'), F('卖方', '某厂')],
      selfPartyNames: ['我方贸易'],
    });
    expect(r.contractType).toBe('销售');
    expect(r.source).toBe('field');
    expect(r.conflict).toBe(true);
  });

  it('非方向类型不参与冲突判定', () => {
    const r = deriveContractType({
      docType: '合同',
      fields: [F('合同类型', '物流合同'), F('买方', '我方贸易'), F('卖方', '某厂')],
      selfPartyNames: ['我方贸易'],
    });
    expect(r.contractType).toBe('物流');
    expect(r.conflict).toBe(false);
  });

  it('无字段: 非方向标题关键词优先于主体侧别', () => {
    const r = deriveContractType({
      docType: '合同',
      fields: [F('合同名称', '焦煤公路运输合同'), F('买方', '我方贸易'), F('卖方', '某厂')],
      selfPartyNames: ['我方贸易'],
    });
    expect(r).toEqual({ contractType: '物流', source: 'keyword', conflict: false });
  });

  it('无字段无关键词: 主体侧别兜底(主体是卖方 -> 销售)', () => {
    const r = deriveContractType({
      docType: '合同',
      fields: [F('买方', '某钢厂'), F('卖方', '我方贸易')],
      selfPartyNames: ['我方贸易'],
    });
    expect(r).toEqual({ contractType: '销售', source: 'side', conflict: false });
  });

  it('名单未配置且侧别判不出: 方向标题关键词兜底', () => {
    const r = deriveContractType({ docType: '合同', fields: [F('合同名称', '2026年度焦炭采购合同')], selfPartyNames: [] });
    expect(r).toEqual({ contractType: '采购', source: 'keyword', conflict: false });
  });

  it('全无信号 -> null', () => {
    const r = deriveContractType({ docType: '合同', fields: [F('合同名称', '框架协议')], selfPartyNames: [] });
    expect(r).toEqual({ contractType: null, source: null, conflict: false });
  });
});
