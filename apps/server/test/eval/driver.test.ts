import { describe, it, expect } from 'vitest';
import { runEpisode } from '../../eval/agent/driver.js';
import { loadByFileUrl } from '../../eval/agent/datasets.js';
import { createDb, migrate } from '../../src/pipeline/db/client.js';
import type { Scenario } from '../../eval/agent/types.js';

// Fake agent model, scripted BY PROMPT CONTENT (not call count): on the first
// turn the model calls escalate_to_human (L3 human-review ticket); after the
// driver simulates a human approve, the resume prompt carries the unified
// "人工已复核工单" instruction and the model produces final text. This mirrors
// how the production model behaves across the resume turn.
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
      const humanReviewed = /人工已复核工单 (ESC-[0-9a-f]{8})/.exec(promptJson);
      // Note: the system prompt itself contains the literal "ESC-xxx", so match
      // a REAL ticket id pattern (hex uuid slice), not the bare "ESC-" prefix.
      const escPending = !/ESC-[0-9a-f]{8}/.test(promptJson) && promptJson.includes('帮我安排');
      const stream = new ReadableStream<unknown>({
        start(controller) {
          if (humanReviewed) {
            // Resume turn after human review: final text (no re-escalation).
            controller.enqueue({ type: 'text-start', id: 't1' });
            controller.enqueue({ type: 'text-delta', id: 't1', delta: finalText });
            controller.enqueue({ type: 'text-end', id: 't1' });
            controller.enqueue({ type: 'finish', finishReason: 'stop', usage: usage() });
          } else if (escPending) {
            // First turn: open an ESC ticket via escalate_to_human.
            controller.enqueue({ type: 'tool-call', toolCallId: `call_esc_${Date.now()}`, toolName: 'escalate_to_human', input: JSON.stringify({ issue: '安排 ORD-2024-0881 付款需人工复核', category: 'rule_boundary', severity: 'high' }) });
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
  it('drives turns, executes the L3 escalate-to-human flow, and captures the artifact', async () => {
    const ds = loadByFileUrl(new URL('../../eval/agent/datasets/core.yaml', import.meta.url).href);
    const t2 = scenario(ds.find((s) => s.id === 't2-payment-flow')!);
    const ctx = createDb(':memory:');
    migrate(ctx.sqlite);
    const prompts: unknown[] = [];
    const finalText = '已为您生成 ESC 工单转人工复核, 人工确认后将按指示继续处理。';
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
    // escalate_to_human was called and the pending ticket was approved.
    expect(artifact.toolCalls.some((t) => t.toolName === 'escalate_to_human')).toBe(true);
    expect(artifact.approvals.some((a) => a.toolName === 'escalate_to_human' && a.decision === 'approved')).toBe(true);
    // The resume instruction is the unified human-reviewed message -- no
    // authorizedTicketId / create_payment legacy resume text anywhere.
    const resumePrompt = JSON.stringify(prompts.find((p) => JSON.stringify(p).includes('人工已复核工单')));
    expect(resumePrompt).toContain('人工已复核工单');
    expect(resumePrompt).not.toContain('authorizedTicketId');
    expect(resumePrompt).not.toContain('create_payment');
    expect(artifact.finalAssistantText).toContain('ESC');
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
