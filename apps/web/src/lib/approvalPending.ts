/** 审批待办角标的外部 store（菜单重构 2026-09-23）。
 *  侧边栏「审批中心」入口需要在不进入视图的情况下显示 pending 总数：
 *  AppSession 挂 30s 全局轮询写入学 store；审批中心视图自身加载 pending tab
 *  时也回写（决策后即时生效）；AppNav / CommandPalette 经 useSyncExternalStore
 *  订阅渲染。模块级单例 —— 与用户会话同生命周期，账号切换重挂载时保留旧值
 *  无害（下一次轮询即收敛）。 */

let count = 0;
const listeners = new Set<() => void>();

export function getApprovalPendingCount(): number {
  return count;
}

/** 更新 pending 总数；值不变时不通知订阅者，负数 / 非有限数收敛为 0。 */
export function setApprovalPendingCount(next: number): void {
  const n = Number.isFinite(next) ? Math.max(0, Math.floor(next)) : 0;
  if (n === count) return;
  count = n;
  listeners.forEach((l) => l());
}

export function subscribeApprovalPending(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
