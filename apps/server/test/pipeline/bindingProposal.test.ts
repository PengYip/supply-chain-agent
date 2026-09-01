// Phase B: 绑定 proposal 生成器纯函数测试(parseCnDate / matchEntity /
// generateBindingProposals 路由)。无 DB 依赖, 全 lane 运行。

import { describe, it, expect } from 'vitest';
import {
  parseCnDate,
  matchEntity,
  normalizeEntityName,
  generateBindingProposals,
  type LedgerEntryLike,
} from '../../src/pipeline/bindingProposal.js';
import type { VoucherAnchors } from '../../src/pipeline/schemas/vouchers.js';

function ledger(contractNo: string, fields: Record<string, string | number>): LedgerEntryLike {
  const out: LedgerEntryLike = { contractNo, fields: {} };
  for (const [k, v] of Object.entries(fields)) {
    out.fields[k] = { value: v, sourceSpans: [] };
  }
  return out;
}

describe('parseCnDate (中文/ISO 日期与区间解析)', () => {
  it('ISO 日期', () => {
    expect(parseCnDate('2023-04-11')).toEqual({ min: '2023-04-11', max: '2023-04-11' });
  });

  it('紧凑 8 位', () => {
    expect(parseCnDate('20230411')).toEqual({ min: '2023-04-11', max: '2023-04-11' });
  });

  it('中文日期', () => {
    expect(parseCnDate('2023年3月24日')).toEqual({ min: '2023-03-24', max: '2023-03-24' });
  });

  it('中文区间', () => {
    expect(parseCnDate('2023年3月24日-2023年3月27日')).toEqual({
      min: '2023-03-24',
      max: '2023-03-27',
    });
  });

  it('斜杠日期带时间', () => {
    expect(parseCnDate('2023/04/18 22:02')).toEqual({ min: '2023-04-18', max: '2023-04-18' });
  });

  it('紧凑区间(连字符分隔)', () => {
    expect(parseCnDate('20230411-20230413')).toEqual({ min: '2023-04-11', max: '2023-04-13' });
  });

  it('无法解析返回 null', () => {
    expect(parseCnDate('not a date')).toBeNull();
    expect(parseCnDate('')).toBeNull();
  });
});

describe('matchEntity (主体模糊匹配)', () => {
  it('归一化后完全相等 -> 1.0(含公司后缀剥离)', () => {
    expect(matchEntity('山西焦煤集团有限责任公司', '山西焦煤集团有限责任公司')).toBe(1.0);
    expect(matchEntity('山西焦煤集团有限责任公司', '山西焦煤集团')).toBe(1.0);
  });

  it('一方包含另一方 -> 0.9', () => {
    expect(matchEntity('山西焦煤集团', '山西焦煤集团运销公司')).toBe(0.9);
  });

  it('括号段剥离 + 后缀剥离 -> 1.0', () => {
    expect(matchEntity('山西焦煤集团有限责任公司（海南）', '山西焦煤集团')).toBe(1.0);
  });

  it('南证/南征 单字差异 -> 0.75(VLM 非确定性容错)', () => {
    expect(matchEntity('南证能源', '南征能源')).toBe(0.75);
  });

  it('不相关 -> 0', () => {
    expect(matchEntity('山西焦煤集团', '中国神华能源')).toBe(0);
  });

  it('主体名变体(2026-09-01): 剥集团/公司尾缀后相等 -> 0.85', () => {
    expect(matchEntity('新疆能源集团', '新疆能源公司')).toBe(0.85);
  });

  it('主体名变体: 短名是长名的有序子序列 -> 0.8(如 中石化 ⊂ 中国石化化工销售)', () => {
    expect(matchEntity('中石化', '中国石化化工销售有限公司')).toBe(0.8);
  });

  it('主体名变体: 子序列要求短名>=3字, 两字短名不适用', () => {
    // '宝钢' 与 '中国宝武' 无包含关系且非子序列路径(两字), 不匹配。
    expect(matchEntity('宝钢', '中国宝武')).toBe(0);
  });

  it('归一化去全角空格', () => {
    expect(normalizeEntityName('山西 焦煤集团')).toBe('山西焦煤集团');
  });
});

describe('generateBindingProposals (路由)', () => {
  const 货转单Anchors: VoucherAnchors = {
    contractNo: 'CJXC-CTCL-JY-2024-131-01',
    buyer: '山西焦煤集团有限责任公司',
    seller: '内蒙古伊泰煤炭股份有限公司',
    date: '2024-07-15',
    amount: 3500385.17,
    quantityTon: 5259.54,
  };

  const 主合同 = ledger('CJXC-CTCL-JY-2024-131-01', {
    甲方: '山西焦煤集团有限责任公司',
    乙方: '内蒙古伊泰煤炭股份有限公司',
    签订日: '2024-06-01',
    交货日期: '2024-07-20',
    金额: 3500000,
    数量: 5259,
  });

  it('合同号精确命中 -> auto_rule 0.99', () => {
    const proposals = generateBindingProposals(货转单Anchors, [主合同]);
    expect(proposals).toHaveLength(1);
    expect(proposals[0]!.route).toBe('auto_rule');
    expect(proposals[0]!.score).toBe(0.99);
    expect(proposals[0]!.contractNo).toBe('CJXC-CTCL-JY-2024-131-01');
    expect(proposals[0]!.evidence.details.some((d) => d.includes('精确匹配'))).toBe(true);
  });

  it('合同号大小写/空白差异仍精确命中(归一化)', () => {
    const anchors = { ...货转单Anchors, contractNo: ' cjxc-ctcl-jy-2024-131-01 ' };
    const proposals = generateBindingProposals(anchors, [主合同]);
    expect(proposals[0]!.route).toBe('auto_rule');
  });

  it('合同号括号参与精确匹配(全角/半角括号不产生新合同)', () => {
    const anchors = {
      ...货转单Anchors,
      contractNo: ' ２０２１－ＺＮＦＸＣＧ（Ｔ１）－０１０ ',
    };
    const contract = ledger('2021-ZNFXCG(T1)-010', {
      甲方: '山西焦煤集团有限责任公司',
      乙方: '内蒙古伊泰煤炭股份有限公司',
    });
    const proposals = generateBindingProposals(anchors, [contract]);
    expect(proposals).toHaveLength(1);
    expect(proposals[0]!.route).toBe('auto_rule');
    expect(proposals[0]!.contractNo).toBe('2021-ZNFXCG(T1)-010');
  });

  it('多个条目共享同一归一化合同号 -> 不落 auto_rule(歧义)', () => {
    const otherUser = ledger('CJXC-CTCL-JY-2024-131-01', { 甲方: '另一公司', 乙方: '另一公司' });
    const proposals = generateBindingProposals(货转单Anchors, [主合同, otherUser]);
    expect(proposals.every((p) => p.route !== 'auto_rule')).toBe(true);
  });

  it('主体+时间窗唯一命中 -> human', () => {
    const anchors: VoucherAnchors = {
      buyer: '山西焦煤集团有限责任公司',
      seller: '内蒙古伊泰煤炭股份有限公司',
      date: '2024-07-15',
      amount: 3500385.17,
      quantityTon: 5259.54,
    };
    const contract = ledger('HT-2024-001', {
      甲方: '山西焦煤集团有限责任公司',
      乙方: '内蒙古伊泰煤炭股份有限公司',
      签订日: '2024-06-01',
      交货日期: '2024-07-20',
      金额: 3500000,
      数量: 5200,
    });
    const proposals = generateBindingProposals(anchors, [contract]);
    expect(proposals[0]!.route).toBe('human');
    expect(proposals[0]!.score).toBeGreaterThanOrEqual(0.75);
    expect(proposals[0]!.contractNo).toBe('HT-2024-001');
    expect(proposals[0]!.evidence.details.length).toBeGreaterThan(0);
  });

  it('两个相似合同分差 < 0.05 -> none(歧义)', () => {
    const anchors: VoucherAnchors = {
      buyer: '山西焦煤集团有限责任公司',
      seller: '内蒙古伊泰煤炭股份有限公司',
      date: '2024-07-15',
      amount: 3500385.17,
      quantityTon: 5259.54,
    };
    const a = ledger('HT-A-001', {
      甲方: '山西焦煤集团有限责任公司',
      乙方: '内蒙古伊泰煤炭股份有限公司',
      签订日: '2024-06-01',
      交货日期: '2024-07-20',
      金额: 3500000,
      数量: 5259,
    });
    // 乙方多了 分公司 后缀 -> 卖方匹配 0.9(包含), 总分略低 -> 分差 < 0.05。
    const b = ledger('HT-B-002', {
      甲方: '山西焦煤集团有限责任公司',
      乙方: '内蒙古伊泰煤炭股份有限公司分公司',
      签订日: '2024-06-01',
      交货日期: '2024-07-20',
      金额: 3499000,
      数量: 5260,
    });
    const proposals = generateBindingProposals(anchors, [a, b]);
    expect(proposals).toHaveLength(2);
    expect(proposals.every((p) => p.route === 'none')).toBe(true);
  });

  it('弱锚点 -> none(分数低)', () => {
    const anchors: VoucherAnchors = { buyer: '未知公司XYZ' };
    const contract = ledger('HT-2024-001', {
      甲方: '山西焦煤集团有限责任公司',
      乙方: '内蒙古伊泰煤炭股份有限公司',
    });
    const proposals = generateBindingProposals(anchors, [contract]);
    expect(proposals[0]!.route).toBe('none');
    expect(proposals[0]!.score).toBeLessThan(0.75);
  });

  it('缺失锚点 -> 中性分 0.5(不误报)', () => {
    const anchors: VoucherAnchors = {};
    const contract = ledger('HT-2024-001', {
      甲方: '山西焦煤集团有限责任公司',
      乙方: '内蒙古伊泰煤炭股份有限公司',
    });
    const proposals = generateBindingProposals(anchors, [contract]);
    expect(proposals[0]!.evidence.partyScore).toBe(0.5);
    expect(proposals[0]!.evidence.timeScore).toBe(0.5);
    expect(proposals[0]!.evidence.amountScore).toBe(0.5);
    expect(proposals[0]!.evidence.qtyScore).toBe(0.5);
    expect(proposals[0]!.route).toBe('none');
  });

  it('无 ledger 条目 -> 空数组', () => {
    expect(generateBindingProposals(货转单Anchors, [])).toEqual([]);
  });

  it('台账锚点为空串(模板保底空值) -> 中性分 0.5 不误报', () => {
    const anchors: VoucherAnchors = { amount: 1000, quantityTon: 10, date: '2024-07-15' };
    const contract = ledger('HT-2024-001', { 金额: '', 数量: '', 交货日期: '' });
    const proposals = generateBindingProposals(anchors, [contract]);
    expect(proposals[0]!.evidence.amountScore).toBe(0.5);
    expect(proposals[0]!.evidence.qtyScore).toBe(0.5);
    expect(proposals[0]!.evidence.timeScore).toBe(0.5);
  });

  it('买卖方向错配 -> partyScore 0', () => {
    const anchors: VoucherAnchors = {
      buyer: '内蒙古伊泰煤炭股份有限公司',
      seller: '山西焦煤集团有限责任公司',
    };
    const contract = ledger('HT-2024-001', {
      甲方: '山西焦煤集团有限责任公司',
      乙方: '内蒙古伊泰煤炭股份有限公司',
    });
    const proposals = generateBindingProposals(anchors, [contract]);
    expect(proposals[0]!.evidence.partyScore).toBe(0);
  });
});
