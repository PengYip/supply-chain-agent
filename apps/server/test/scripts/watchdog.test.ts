// withWatchdog 单测(R16): 超时失败形态的三种路径 —— 正常透传 / 慢 promise 超时 /
// rejected 原错误透传。用真实短 ms(20/50), 不引入 fake timers。
import { describe, it, expect } from 'vitest';
import { withWatchdog, WatchdogTimeoutError } from '../../scripts/lib/watchdog.js';

describe('withWatchdog', () => {
  it('正常路径: resolved promise 透传值, 不超时', async () => {
    const p = Promise.resolve('ok');
    await expect(withWatchdog(p, 50, 'fast-task')).resolves.toBe('ok');
  });

  it('慢 promise + 短预算 -> 抛含 label 的超时错误(不吞成其他错误)', async () => {
    const slow = new Promise<string>((resolve) => setTimeout(() => resolve('late'), 500));
    const err = await withWatchdog(slow, 20, 'slow-task').then(
      () => { throw new Error('should not resolve'); },
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(WatchdogTimeoutError);
    expect((err as WatchdogTimeoutError).label).toBe('slow-task');
    expect((err as WatchdogTimeoutError).ms).toBe(20);
    expect((err as Error).message).toBe('slow-task timed out after 20ms');
  });

  it('rejected promise -> 透传原错误, 不被看门狗吞成超时', async () => {
    const boom = Promise.reject(new Error('original boom'));
    await expect(withWatchdog(boom, 50, 'boom-task')).rejects.toThrow('original boom');
  });

  it('rejected 发生在预算内(迟到 reject) -> 仍是原错误而非超时', async () => {
    const lateReject = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error('late boom')), 10);
    });
    await expect(withWatchdog(lateReject, 500, 'late-task')).rejects.toThrow('late boom');
  });
});