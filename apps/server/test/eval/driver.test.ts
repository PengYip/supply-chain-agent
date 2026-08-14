import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { ModelMessage } from 'ai';
import { runEpisode } from '../../eval/agent/driver.js';
import { loadByFileUrl } from '../../eval/agent/datasets.js';
import { createDb, migrate } from '../../src/pipeline/db/client.js';
import { listPending } from '../../src/harness/sessionStore.js';
import { payments } from '../../src/data/seed.js';
import type { Scenario } from '../../eval/agent/types.js';

// Fake agent model, scripted BY PROMPT CONTENT (not call count): whenever the
// model sees the L3-authorized instruction in its prompt, it re-emits the
// create_payment call WITH authorizedTicketId (the real behavior under test);
// otherwise it emits final text. This mirrors how the production model behaves
// across the resume turn.
function fakeAgentModel(finalText: string, prompts: unknown[]) {
  const usage = () => ({ inputTokens: 5, outputTokens: 7, totalTokens: 12 });
  return {
    specificationVersion: 'v2' as const, provider: 'fake', modelId: 'fake-agent',
    supportedUrls: {} as Record<string, RegExp[]>,
    async doGenerate() {
      return { content: [{ type: 'text' as const, text: 'ok' }], finishReason: 'stop' as const, usage: usage(), warnings: [] as unknown[] };
    },
    async doStream(options: { tools?: Array<{ name?: string }>; prompt?: unknown }) {
      prompts.push(options.prompt);
      const promptJson = JSON.stringify(options.prompt ?? '');
      const authorized = /authorizedTicketId=?(PAY-pending-[0-9a-f]{8})/.exec(promptJson);
      const paymentPending = !promptJson.includes('PAY-pending-') && promptJson.includes('帮我安排');
      const paymentExecuted = promptJson.includes('"status":"executed"') || promptJson.includes('paymentId');
      const stream = new ReadableStream<unknown>({
        start(controller) {
          if (authorized && !paymentExecuted) {
            // Resume turn: re-run create_payment with the ticket -> truly executes.
            controller.enqueue({ type: 'tool-call', toolCallId: `call_pay_${Date.now()}`, toolName: 'create_payment', input: JSON.stringify({ contractNo: 'HT-2024-001', amount: 858000, authorizedTicketId: authorized[1] }) });
            controller.enqueue({ type: 'finish', finishReason: 'tool-calls', usage: usage() });
          } else if (paymentPending) {
            controller.enqueue({ type: 'tool-call', toolCallId: 'call_pay_1', toolName: 'create_payment', input: JSON.stringify({ contractNo: 'HT-2024-001', amount: 858000 }) });
            controller.enqueue({ type: 'finish', finishReason: 'tool-calls', usage: usage() });
          } else {
            controller.enqueue({ type: 'text-start', id: 't1' });
            controller.enqueue({ type: 'text-delta', id: 't1', delta: finalText });
            controller.enqueue({ type: 'text-end', id: 't1' });
            controller.enqueue({ type: 'finish', finishReason: 'stop', usage: usage() });
          }
          controller.close();
        },
      });
      return { stream };
    },
  };
}

// Scripted sim: one user opening, then done.
function scriptedSim(script: Array<{ message: string; done: boolean }>) {
  let i = 0;
  return async () => {
    const turn = script[Math.min(i, script.length - 1)]!;
    i++;
    return turn;
  };
}

function scenario(t2payment: Scenario): Scenario {
  return { ...t2payment, maxTurns: 4 };
}

describe('runEpisode', () => {
  it('drives turns, executes the L3 approval flow, and captures the artifact', async () => {
    const ds = loadByFileUrl(new URL('../../eval/agent/datasets/core.yaml', import.meta.url).href);
    const t2 = scenario(ds.find((s) => s.id === 't2-payment-flow')!);
    const ctx = createDb(':memory:');
    migrate(ctx.sqlite);
    const prompts: unknown[] = [];
    const finalText = '付款已执行, 付款单号 PAY-1, 授权票据已核验。';
    const artifact = await runEpisode({
      scenario: t2,
      runIndex: 1,
      agentModel: fakeAgentModel(finalText, prompts) as any,
      simModel: undefined as any, // overridden below
      simFn: scriptedSim([
        { message: '帮我安排 ORD-2024-0881 的付款 858000 元', done: false },
        { message: '好的, 谢谢', done: true },
      ]),
      deps: { ctx, extraction: { model: null as any } },
    } as any);

    expect(artifact.scenarioId).toBe('t2-payment-flow');
    expect(artifact.turnsUsed).toBeGreaterThan(0);
    expect(artifact.toolCalls.some((t) => t.toolName === 'create_payment')).toBe(true);
    // approval simulated + payment truly executed (L3 ticket authorized -> re-run path)
    expect(artifact.approvals.some((a) => a.toolName === 'create_payment' && a.decision === 'approved')).toBe(true);
    expect(payments.some((p) => p.contractNo === 'HT-2024-001' && p.amount === 858000)).toBe(true);
    expect(artifact.envSnapshot.payments.length).toBeGreaterThan(0);
    expect(artifact.finalAssistantText).toContain('PAY-1');
    expect(artifact.totalUsage.totalTokens).toBeGreaterThan(0);
  }, 60000);

  it('cleans up the session even when the sim fails (simError artifact)', async () => {
    const ds = loadByFileUrl(new URL('../../eval/agent/datasets/core.yaml', import.meta.url).href);
    const t1 = ds.find((s) => s.id === 't1-order-status')!;
    const ctx = createDb(':memory:');
    migrate(ctx.sqlite);
    const artifact = await runEpisode({
      scenario: t1,
      runIndex: 1,
      agentModel: fakeAgentModel('查询完成', []) as any,
      simModel: undefined as any,
      simFn: async () => { throw new Error('sim exploded'); },
      deps: { ctx, extraction: { model: null as any } },
    } as any);
    expect(artifact.simError).toContain('sim exploded');
  }, 60000);
});
