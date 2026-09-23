import { describe, it, expect } from 'vitest';
import { TASK_CARDS, jumpTargetForCard, formatRate, formatAmount } from './overviewModel';
import { isRoutableView } from '../shell/navigation';

describe('jumpTargetForCard', () => {
  it('卡片跳转目标映射（点击跳转验收；实体台账并入本体后带 tab 参数）', () => {
    expect(jumpTargetForCard('pendingApprovals')).toEqual({ view: 'approvals' });
    expect(jumpTargetForCard('paymentBlocks')).toEqual({ view: 'approvals' });
    expect(jumpTargetForCard('overReceipt')).toEqual({ view: 'ontology', params: { tab: 'ledger' } });
    expect(jumpTargetForCard('pendingWriteoff')).toEqual({ view: 'writeoff' });
    expect(jumpTargetForCard('executionRate')).toEqual({ view: 'projects', params: { tab: 'ledger' } });
  });
});

describe('TASK_CARDS（菜单重构 2026-09-23 二期）', () => {
  it('任务卡目标全部指向已开放视图（想干事 -> 去哪干不掉链）', () => {
    for (const t of TASK_CARDS) {
      expect(isRoutableView(t.target.view)).toBe(true);
    }
  });
  it('录入新单据带 files=1 哨兵联动文件面板；勾稽直达顶层视图', () => {
    const intake = TASK_CARDS.find((t) => t.key === 'intake');
    expect(intake?.target).toEqual({ view: 'bindings', params: { files: '1' } });
    const gaps = TASK_CARDS.find((t) => t.key === 'gaps');
    expect(gaps?.target).toEqual({ view: 'gaps' });
  });
  it('任务卡 key 唯一', () => {
    expect(new Set(TASK_CARDS.map((t) => t.key)).size).toBe(TASK_CARDS.length);
  });
});

describe('format helpers', () => {
  it('rate null 显示 --；amount 千分位', () => {
    expect(formatRate(null)).toBe('--');
    expect(formatRate(0.75)).toBe('75%');
    expect(formatAmount(1234567.5)).toBe('1,234,567.5');
  });
});
