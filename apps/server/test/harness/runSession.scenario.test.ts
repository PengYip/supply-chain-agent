// 场景透传链测试（2026-09-08 事件登记挂载 bug）：路由把 scenario 传给 runSession 后，
// runSession 必须原样转发给 runStream（agent.ts 用它覆盖 detectScenario 自动检测）。
// 只 mock agent.js 这一跳：证明的是转发行为，而非 agent 内部的挂载逻辑（后者已有
// e2e-loop/toolInventory 覆盖）。
import { describe, it, expect, beforeEach, vi } from 'vitest';

const { runStreamMock } = vi.hoisted(() => ({ runStreamMock: vi.fn() }));
vi.mock('../../src/harness/agent.js', () => ({
  runStream: runStreamMock,
  recordL2PendingFromResponse: vi.fn(async () => {}),
}));

const { runSession } = await import('../../src/harness/runSession.js');
const { createSession } = await import('../../src/harness/sessionStore.js');

/** runSession 消费的 runStream 返回值最小形状：三个 promise/流钩子。 */
function fakeResult() {
  return {
    totalUsage: Promise.resolve({ totalTokens: 0 }),
    response: Promise.resolve({ messages: [] }),
    toUIMessageStream: () => (async function* () {})(),
  };
}

describe('runSession scenario 透传', () => {
  beforeEach(() => {
    runStreamMock.mockReset();
    runStreamMock.mockImplementation(fakeResult);
  });

  it('显式传入的 scenario 原样转发给 runStream', async () => {
    const s = await createSession('trader', 'u-scenario');
    await runSession({
      sessionId: s.id,
      userId: 'u-scenario',
      role: 'trader',
      messages: [{ role: 'user', content: 'hi' }],
      auditTraceId: 't-scenario',
      abortSignal: new AbortController().signal,
      scenario: 'settlement',
    });
    expect(runStreamMock).toHaveBeenCalledWith(expect.objectContaining({ scenario: 'settlement' }));
  });

  it('未传 scenario 时保持 undefined（对话路由继续走自动检测）', async () => {
    const s = await createSession('trader', 'u-noscenario');
    await runSession({
      sessionId: s.id,
      userId: 'u-noscenario',
      role: 'trader',
      messages: [{ role: 'user', content: 'hi' }],
      auditTraceId: 't-noscenario',
      abortSignal: new AbortController().signal,
    });
    const arg = runStreamMock.mock.calls[0]![0] as { scenario?: string };
    expect(arg.scenario).toBeUndefined();
  });
});
