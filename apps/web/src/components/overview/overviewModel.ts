// apps/web/src/components/overview/overviewModel.ts
// 总览卡片纯展示逻辑：跳转映射与格式化，全部由接口数据驱动。
import type { ViewId } from '../shell/navigation';

export type OverviewCardKey =
  | 'pendingApprovals' | 'overReceipt' | 'paymentBlocks' | 'executionRate' | 'pendingWriteoff';

/** 卡片跳转目标：视图 + 可选 hash 参数（tab 合一后带 tab 定位，导航整合 2026-09-08）。 */
export interface JumpTarget {
  view: ViewId;
  params?: Record<string, string>;
}

export function jumpTargetForCard(card: OverviewCardKey): JumpTarget {
  switch (card) {
    case 'pendingApprovals':
    case 'paymentBlocks':
      return { view: 'approvals' };
    case 'overReceipt':
      // 实体台账已并入本体视图（导航整合）：跳本体台账 tab
      return { view: 'ontology', params: { tab: 'ledger' } };
    case 'pendingWriteoff':
      return { view: 'writeoff' };
    case 'executionRate':
      // 项目台账已并入项目视图（导航整合）：跳项目台账 tab
      return { view: 'projects', params: { tab: 'ledger' } };
  }
}

export function formatRate(rate: number | null): string {
  return rate == null ? '--' : `${Math.round(rate * 100)}%`;
}

export function formatAmount(n: number): string {
  return n.toLocaleString('zh-CN', { maximumFractionDigits: 2 });
}
