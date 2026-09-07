// apps/web/src/components/overview/overviewModel.ts
// 总览卡片纯展示逻辑：跳转映射与格式化，全部由接口数据驱动。
import type { ViewId } from '../shell/navigation';

export type OverviewCardKey =
  | 'pendingApprovals' | 'overReceipt' | 'paymentBlocks' | 'executionRate' | 'pendingWriteoff';

export function jumpTargetForCard(card: OverviewCardKey): ViewId {
  switch (card) {
    case 'pendingApprovals':
    case 'paymentBlocks':
      return 'approvals';
    case 'overReceipt':
      return 'entities';
    case 'pendingWriteoff':
      return 'writeoff';
    case 'executionRate':
      return 'ledger';
  }
}

export function formatRate(rate: number | null): string {
  return rate == null ? '--' : `${Math.round(rate * 100)}%`;
}

export function formatAmount(n: number): string {
  return n.toLocaleString('zh-CN', { maximumFractionDigits: 2 });
}
