// Per-container async mutex(batch.ts 原实现抽出共享, 集中复核 2026-09-04)。
// 单 Node 进程内串行化同一单据组的谱系/复核改写; 长耗时模型工作刻意在
// DB 事务之外, 路由变更至少按 container 串行避免交错覆写。
const containerLocks = new Map<string, Promise<unknown>>();

export async function withContainerLock<T>(docId: string, fn: () => Promise<T>): Promise<T> {
  const previous = containerLocks.get(docId) ?? Promise.resolve();
  const run = previous.catch(() => undefined).then(fn);
  // Map 里保留 ignored 分支: 单条失败不留 unhandled rejection, 后来者照常排队。
  const queued = run.catch(() => undefined);
  containerLocks.set(docId, queued);
  try {
    return await run;
  } finally {
    if (containerLocks.get(docId) === queued) containerLocks.delete(docId);
  }
}