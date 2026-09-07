import { describe, it, expect } from 'vitest';
import { jumpTargetForCard, formatRate, formatAmount } from './overviewModel';

describe('jumpTargetForCard', () => {
  it('卡片跳转目标映射（点击跳转验收）', () => {
    expect(jumpTargetForCard('pendingApprovals')).toBe('approvals');
    expect(jumpTargetForCard('paymentBlocks')).toBe('approvals');
    expect(jumpTargetForCard('overReceipt')).toBe('entities');
    expect(jumpTargetForCard('pendingWriteoff')).toBe('writeoff');
    expect(jumpTargetForCard('executionRate')).toBe('ledger');
  });
});

describe('format helpers', () => {
  it('rate null 显示 --；amount 千分位', () => {
    expect(formatRate(null)).toBe('--');
    expect(formatRate(0.75)).toBe('75%');
    expect(formatAmount(1234567.5)).toBe('1,234,567.5');
  });
});
