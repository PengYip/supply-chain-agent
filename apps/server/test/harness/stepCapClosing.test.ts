import { describe, it, expect } from 'vitest';
import type { ModelMessage } from 'ai';
import { runStream } from '../../src/harness/agent.js';
import { createDb, migrate } from '../../src/pipeline/db/client.js';
import { env } from '../../src/env.js';

/**
 * A: step-cap closing behavior (OpenCode MAX_STEPS_PROMPT pattern).
 *
 * A fake model that ALWAYS requests a tool call would previously end the turn
 * dangling on the last tool result (stepCountIs cap, no closing text). With
 * the last-step tool disabling, the capped turn must end with a model text
 * step: the final doStream call receives NO tools and a trailing closing
 * instruction message, and the model's text response closes the turn.
 *
 * runStream reads env.AGENT_MAX_STEPS (zod-parsed at import, default 8).
 * The fake below answers tool calls for the first N-1 steps then text.
 */

function createLoopingModel(opts: {
  onCall: (info: { call: number; toolNames: string[]; prompt: unknown }) => void;
  toolName: string;
}) {
  let calls = 0;
  const usage = () => ({ inputTokens: 1, outputTokens: 1, totalTokens: 2 });
  return {
    specificationVersion: 'v2' as const,
    provider: 'fake',
    modelId: 'fake-model',
    supportedUrls: {} as Record<string, RegExp[]>,
    async doGenerate() {
      throw new Error('not used');
    },
    async doStream(options: { tools?: Array<{ name?: string }>; prompt?: unknown }) {
      calls++;
      const toolNames = (options.tools ?? []).map((t) => t.name ?? '');
      opts.onCall({ call: calls, toolNames, prompt: options.prompt });
      const stream = new ReadableStream<unknown>({
        start(controller) {
          // Non-empty tool set => keep requesting a (harmless L1) tool.
          if (toolNames.length > 0) {
            controller.enqueue({
              type: 'tool-call',
              toolCallId: `call_${calls}_${Math.random().toString(36).slice(2, 6)}`,
              toolName: opts.toolName,
              input: JSON.stringify({ contractNo: `HT-${calls}` }),
            });
            controller.enqueue({ type: 'finish', finishReason: 'tool-calls', usage: usage() });
          } else {
            // Empty tool set (last step): must close with text.
            controller.enqueue({ type: 'text-start', id: 't-last' });
            controller.enqueue({ type: 'text-delta', id: 't-last', delta: '已达到步数上限，本轮收尾。' });
            controller.enqueue({ type: 'text-end', id: 't-last' });
            controller.enqueue({ type: 'finish', finishReason: 'stop', usage: usage() });
          }
          controller.close();
        },
      });
      return { stream };
    },
  };
}

describe('step-cap closing (A)', () => {
  it('disables tools on the last allowed step and the model closes with text', async () => {
    const ctx = createDb(':memory:');
    migrate(ctx.sqlite);

    const calls: Array<{ call: number; toolNames: string[]; prompt: unknown }> = [];
    const fake = createLoopingModel({
      toolName: 'query_contract',
      onCall: (info) => calls.push(info),
    });

    const messages: ModelMessage[] = [{ role: 'user', content: '连续查多份合同' }];
    const result = await runStream({
      messages,
      role: 'trader',
      auditTraceId: 't-cap',
      sessionId: undefined, // no <agent_status> injection; keep prompt shape simple
      model: fake as any,
      deps: { ctx, extraction: { model: fake as any } },
    });

    let sawText = false;
    for await (const part of result.fullStream as AsyncIterable<any>) {
      if (part?.type === 'text-delta') sawText = true;
    }

    // Exactly AGENT_MAX_STEPS model calls; the last one had NO tools.
    expect(calls).toHaveLength(env.AGENT_MAX_STEPS);
    for (let i = 0; i < calls.length - 1; i++) {
      expect(calls[i]!.toolNames.length).toBeGreaterThan(0);
    }
    const lastCall = calls[calls.length - 1]!;
    expect(lastCall.toolNames).toHaveLength(0);
    // The closing instruction was appended to the last-step prompt.
    const prompt = (lastCall.prompt ?? []) as Array<{ role?: string; content?: unknown }>;
    const lastMsg = prompt[prompt.length - 1];
    expect(lastMsg?.role).toBe('user');
    expect(JSON.stringify(lastMsg)).toContain('步数已达到上限');

    // The turn ended with model text, not a dangling tool result.
    expect(sawText).toBe(true);
  });
});
