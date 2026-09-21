// 脚本级看门狗(R16 防御性加固): 给慢/卡查询加"可观测的超时失败", 而不是无界 await。
//
// 背景: Neo4j session.run 无查询级超时(acquisitionTimeout 只管池等待), 慢查询窗口期
// 形成无界 await, 叠加脚本无资源收尾 -> 进程悬挂。withWatchdog 把该失败形态变成
// 带 label 的可观测错误, 调用方捕获后按 non-fatal 继续。
//
// 设计: 超时不取消底层 promise(脚本进程随后会收尾退出, 无需 AbortController 复杂化);
// Promise.race 已为两侧挂处理, 底层 promise 的迟到 settle 不会触发 unhandledRejection。
// 独立成模块而非放进 backfillOntology.ts: 该脚本顶层有 main().catch 会执行回填,
// 测试 import 会误触发; scripts/lib 让测试零副作用 import。
export class WatchdogTimeoutError extends Error {
  readonly label: string;
  readonly ms: number;

  constructor(label: string, ms: number) {
    super(`${label} timed out after ${ms}ms`);
    this.name = 'WatchdogTimeoutError';
    this.label = label;
    this.ms = ms;
  }
}

export async function withWatchdog<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new WatchdogTimeoutError(label, ms)), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    // 快路径也必须清定时器: 残留 timer 会拖住事件循环(进程退出被推迟)。
    if (timer !== undefined) clearTimeout(timer);
  }
}