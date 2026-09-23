import { useSyncExternalStore } from 'react';
import { getApprovalPendingCount, subscribeApprovalPending } from '../lib/approvalPending';

/** 订阅审批待办角标数（lib/approvalPending.ts 外部 store 的 React 绑定）。
 *  供 AppNav 菜单项与 CommandPalette 结果行共用，避免多份轮询。 */
export function useApprovalPendingCount(): number {
  return useSyncExternalStore(subscribeApprovalPending, getApprovalPendingCount, getApprovalPendingCount);
}
