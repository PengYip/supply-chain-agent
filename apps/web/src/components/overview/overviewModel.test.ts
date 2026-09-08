import { describe, it, expect } from 'vitest';
import { jumpTargetForCard, formatRate, formatAmount } from './overviewModel';

describe('jumpTargetForCard', () => {
  it('卡片跳转目标映射（点击跳转验收；实体台账并入本体后带 tab 参数）', () => {
    expect(jumpTargetForCard('pendingApprovals')).toEqual({ view: 'approvals' });
    expect(jumpTargetForCard('paymentBlocks')).toEqual({ view: 'approvals' });
    expect(jumpTargetForCard('overReceipt')).toEqual({ view: 'ontology', params: { tab: 'ledger' } });
    expect(jumpTargetForCard('pendingWriteoff')).toEqual({ view: 'writeoff' });
    expect(jumpTargetForCard('executionRate')).toEqual({ view: 'ledger' });
  });
});

describe('format helpers', () => {
  it('rate null 显示 --；amount 千分位', () => {
    expect(formatRate(null)).toBe('--');
    expect(formatRate(0.75)).toBe('75%');
    expect(formatAmount(1234567.5)).toBe('1,234,567.5');
  });
});
