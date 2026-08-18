import { describe, it, expect } from 'vitest';
import { buildAnchorsFromFields } from '../../src/pipeline/bindingProposal.js';

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
  });

  it('空字段/无法解析的数值 -> 对应锚点缺省', () => {
    const a = buildAnchorsFromFields('装箱单', { 备注: { value: '无' } });
    expect(a).toEqual({});
  });

  it('无可用字段返回空对象(调用方以此判定缺锚点)', () => {
    expect(buildAnchorsFromFields('其他', {})).toEqual({});
  });
});
