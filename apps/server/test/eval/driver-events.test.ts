// apps/server/test/eval/driver-events.test.ts
// Fake-model single-episode run; asserts the onEvent callback fires turn /
// tool_call events in causal order. Approval path is exercised by the L3
// payment script (same fake model as driver.test.ts).
import { describe, it, expect } from 'vitest';
import { runEpisode } from '../../eval/agent/driver.js';
import type { EvalRunEvent } from '../../eval/agent/events.js';
import type { Scenario } from '../../eval/agent/types.js';
import type { LanguageModelV2 } from 'ai';
import type { UIMessageChunk } from 'ai';

function fakeModel(): LanguageModelV2 {
  let calls = 0;
  return {
    specificationVersion: 'v2',
    provider: 'test',
    modelId: 'fake',
    supportsUrl: false,
    async doStream(options) {
      calls++;
      const chunks: UIMessageChunk[] = [];
      if (calls === 1) {
        chunks.push({ type: 'start' });
        chunks.push({
          type: 'tool-call',
          toolCallId: 'call_1', toolName: 'query_orders',
          input: JSON.stringify({ contractNo: 'HT-2024-001' }),
        } as unknown as UIMessageChunk);
        chunks.push({ type: 'finish', finishReason: 'tool-calls', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } } as unknown as UIMessageChunk);
      } else {
        chunks.push({ type: 'start' });
        chunks.push({ type: 'text-start', id: 't1' });
        chunks.push({ type: 'text-delta', id: 't1', delta: '订单已查到' });
        chunks.push({ type: 'text-end', id: 't1' });
        chunks.push({ type: 'finish', finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } } as unknown as UIMessageChunk);
      }
      return {
        stream: new ReadableStream<unknown>({
          start(controller) {
            for (const c of chunks) {
              if (c.type === 'tool-call') {
                controller.enqueue({
                  type: 'tool-call',
                  toolCallId: (c as { toolCallId: string }).toolCallId,
                  toolName: (c as { toolName: string }).toolName,
                  input: (c as { input: string }).input,
                });
              } else if (c.type === 'finish') {
                controller.enqueue({ type: 'finish', finishReason: (c as { finishReason: unknown }).finishReason, usage: (c as { usage: unknown }).usage });
              } else if (c.type === 'text-start') {
                controller.enqueue({ type: 'text-start', id: (c as { id: string }).id });
              } else if (c.type === 'text-delta') {
                controller.enqueue({ type: 'text-delta', id: (c as { id: string }).id, delta: (c as { delta: string }).delta });
              }
            }
            controller.close();
          },
        }),
        request: { body: JSON.stringify(options.prompt) },
        rawCall: { rawPrompt: null, rawSettings: {} },
      };
    },
  } as unknown as LanguageModelV2;
}

const scenario: Scenario = {
  id: 'evt-probe', tier: 1, capability: [],
  persona: { facts: ['订单 ORD-2024-0881'], disclosure: '按需', goal: '查订单后结束', patience: 3 },
  approvalPolicy: { default: 'approve', rules: [] },
  maxTurns: 4,
  verifiers: { mustAppear: ['query_orders'], forbidden: [], keywordInReply: [], keywordInTranscript: [] },
  rubric: { dimensions: [{ name: '准确性', weight: 'essential', scoring: { '4': '好', '1': '差' } }] },
};

describe('driver onEvent seam', () => {
  it('emits turn and tool_call events in causal order', async () => {
    const events: EvalRunEvent[] = [];
    let turn = 0;
    const artifact = await runEpisode({
      scenario, runIndex: 1,
      agentModel: fakeModel(),
      simModel: fakeModel(),
      onEvent: (e) => events.push(e),
      simFn: async () => (turn++ === 0 ? { message: '查一下 ORD-2024-0881', done: false } : { message: '好的', done: true }),
    });
    expect(artifact.toolCalls.some((t) => t.toolName === 'query_orders')).toBe(true);
    const kinds = events.map((e) => e.type);
    // First user turn, then a tool_call, then an assistant turn.
    expect(kinds[0]).toBe('turn');
    expect((events[0] as { role: string }).role).toBe('user');
    expect(kinds).toContain('tool_call');
    const firstTool = kinds.indexOf('tool_call');
    const firstAssistant = kinds.findIndex((k, i) => k === 'turn' && (events[i] as { role: string }).role === 'assistant');
    expect(firstTool).toBeGreaterThan(-1);
    expect(firstAssistant).toBeGreaterThan(firstTool);
    // every turn event carries the scenario identity
    for (const e of events) expect((e as { scenarioId: string }).scenarioId).toBe('evt-probe');
  });

  it('no callback passed -> zero impact (episode completes)', async () => {
    let turn = 0;
    const artifact = await runEpisode({
      scenario, runIndex: 1,
      agentModel: fakeModel(), simModel: fakeModel(),
      simFn: async () => (turn++ === 0 ? { message: '查一下', done: false } : { message: '好', done: true }),
    });
    expect(artifact.scenarioId).toBe('evt-probe');
  });
});
