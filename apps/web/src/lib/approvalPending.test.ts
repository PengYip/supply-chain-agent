import { describe, it, expect, vi } from 'vitest';
import {
  getApprovalPendingCount,
  setApprovalPendingCount,
  subscribeApprovalPending,
} from './approvalPending';

/** 审批待办角标 store 语义（菜单重构 2026-09-23）：值变化才通知、
 *  非法值收敛为 0、退订后不再通知。注意模块级单例 —— 断言顺序敏感。 */
describe('审批待办角标 store', () => {
  it('数值变化时通知订阅者，不变时不重复通知', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeApprovalPending(listener);

    setApprovalPendingCount(3);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(getApprovalPendingCount()).toBe(3);

    setApprovalPendingCount(3);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(getApprovalPendingCount()).toBe(3);

    unsubscribe();
    setApprovalPendingCount(9);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('负数与非法输入收敛为 0', () => {
    // 模块级单例跨用例残留：先拨到非 0 基线，与本文件其他用例解耦。
    setApprovalPendingCount(5);
    const listener = vi.fn();
    const unsubscribe = subscribeApprovalPending(listener);

    setApprovalPendingCount(-5); // 5 -> 0，值变化通知一次
    expect(getApprovalPendingCount()).toBe(0);
    expect(listener).toHaveBeenCalledTimes(1);

    setApprovalPendingCount(Number.NaN); // 0 -> 0，值不变不再通知
    expect(getApprovalPendingCount()).toBe(0);
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
  });
});
