// apps/web/src/components/overview/overviewModel.ts
// 总览卡片纯展示逻辑：任务卡配置、跳转映射与格式化。
import {
  ArrowLeftRight,
  ClipboardCheck,
  FolderKanban,
  MessageSquare,
  Scale,
  Stamp,
  Upload,
  type LucideIcon,
} from 'lucide-react';
import type { ViewId } from '../shell/navigation';

export type OverviewCardKey =
  | 'pendingApprovals' | 'overReceipt' | 'paymentBlocks' | 'executionRate' | 'pendingWriteoff';

/** 卡片跳转目标：视图 + 可选 hash 参数（tab 合一后带 tab 定位，导航整合 2026-09-08）。 */
export interface JumpTarget {
  view: ViewId;
  params?: Record<string, string>;
}

/** 「开始一件事」任务卡（菜单重构 2026-09-23 二期）：静态配置，回答
 *  「想干事去哪里干」。录入新单据带 files=1 哨兵联动展开文件面板；
 *  查合同执行 / 勾稽对账带任务直达定位（后者为顶层视图）。 */
export interface TaskCard {
  key: string;
  title: string;
  desc: string;
  icon: LucideIcon;
  target: JumpTarget;
}

export const TASK_CARDS: TaskCard[] = [
  { key: 'intake', title: '录入新单据', desc: '上传合同 / 发票 / 收货单，解析后挂到合同', icon: Upload, target: { view: 'bindings', params: { files: '1' } } },
  { key: 'verify', title: '核对抽取结果', desc: '票据表格化批量核对，高置信一键放行', icon: ClipboardCheck, target: { view: 'review' } },
  { key: 'execution', title: '查合同执行', desc: '项目台账 / 凭证齐套 / 执行时间轴回放', icon: FolderKanban, target: { view: 'projects', params: { tab: 'ledger' } } },
  { key: 'gaps', title: '勾稽对账', desc: '四组勾稽缺口与按合同明细', icon: Scale, target: { view: 'gaps' } },
  { key: 'approve', title: '处理审批', desc: 'L2/L3 审批待办与历史', icon: Stamp, target: { view: 'approvals' } },
  { key: 'writeoff', title: '款项核销', desc: '票款核销与预付冲抵', icon: ArrowLeftRight, target: { view: 'writeoff' } },
  { key: 'ask', title: '问 Agent', desc: '自然语言直接办事，工具调用全程留痕', icon: MessageSquare, target: { view: 'chat' } },
];

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
