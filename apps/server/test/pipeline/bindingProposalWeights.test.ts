import { describe, expect, it } from 'vitest';
import { generateBindingProposals } from '../../src/pipeline/bindingProposal.js';

// 夹具按 bindingProposal.ts 真实类型修正(brief 声明允许):
// 1. LedgerEntryLike.fields 值为 { value, sourceSpans }(brief 原文为裸字符串, 运行时
//    fields[k]?.value 取不到值, 主体/时间分全落中性);
// 2. 签订日期 -> 签订日(scoreTime 别名表为 ['签订日','签署日期','签约日期']);
// 3. anchors.amount 100 -> 500(brief 原文 100 使断言"HT-2(金额500)反超"逻辑不可能:
//    HT-2 金额 500 相对 100 是错配(0.2 分), 调高金额权重只会帮 HT-1)。
const anchors = { buyer: 'A公司', seller: 'B公司', date: '2026-01-10', amount: 500 };
const ledger = [
  { contractNo: 'HT-1', fields: { 买方: { value: 'A公司', sourceSpans: [] }, 卖方: { value: 'B公司', sourceSpans: [] }, 签订日: { value: '2026-01-10', sourceSpans: [] }, 合同金额: { value: 100, sourceSpans: [] } } },
  { contractNo: 'HT-2', fields: { 买方: { value: 'A公司', sourceSpans: [] }, 卖方: { value: 'C公司', sourceSpans: [] }, 签订日: { value: '2025-12-01', sourceSpans: [] }, 合同金额: { value: 500, sourceSpans: [] } } },
];

describe('generateBindingProposals weights', () => {
  it('缺省权重: 行为不变(top1=HT-1, route=human)', () => {
    const r = generateBindingProposals(anchors as never, ledger as never);
    expect(r[0]?.contractNo).toBe('HT-1');
    expect(r[0]?.route).toBe('human');
  });
  it('金额权重调高后 HT-2(金额500)反超', () => {
    const r = generateBindingProposals(anchors as never, ledger as never, { party: 0.2, time: 0.1, amount: 0.7, qty: 0 });
    expect(r[0]?.contractNo).toBe('HT-2');
  });
});