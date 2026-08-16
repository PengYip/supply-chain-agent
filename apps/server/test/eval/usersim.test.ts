import { describe, it, expect } from 'vitest';
import { buildUserSimPrompt, parseSimOutput, simulateUserTurn, SimError } from '../../eval/agent/userSim.js';
import type { Persona, TranscriptEntry } from '../../eval/agent/types.js';

const persona: Persona = {
  facts: ['合同 HT-2024-001 金额 2860000 元'],
  disclosure: '被问及再给合同号',
  goal: '确认合同金额',
  patience: 3,
};

// Minimal fake LanguageModelV2 whose doGenerate returns a fixed text payload.
function fakeTextModel(text: string) {
  return {
    specificationVersion: 'v2' as const,
    provider: 'fake',
    modelId: 'fake-sim',
    supportedUrls: {} as Record<string, RegExp[]>,
    async doGenerate() {
      return {
        content: [{ type: 'text' as const, text }],
        finishReason: 'stop' as const,
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        warnings: [] as unknown[],
      };
    },
    async doStream() {
      throw new Error('stream not expected');
    },
  };
}

describe('buildUserSimPrompt', () => {
  it('embeds facts, goal, disclosure rules and demands strict JSON', () => {
    const { system, user } = buildUserSimPrompt(persona, []);
    expect(system).toContain('渐进式');
    expect(system).toContain('HT-2024-001');
    expect(system).toContain('严禁编造');
    expect(system).toContain('"done"');
    expect(user).toContain('对话尚未开始');
  });
  it('renders an existing conversation with role labels', () => {
    const convo: TranscriptEntry[] = [
      { role: 'user', text: '你好' },
      { role: 'assistant', text: '请问有什么可以帮你?' },
    ];
    const { user } = buildUserSimPrompt(persona, convo);
    expect(user).toContain('用户(你): 你好');
    expect(user).toContain('Agent: 请问有什么可以帮你?');
  });
});

describe('parseSimOutput', () => {
  it('parses plain JSON', () => {
    expect(parseSimOutput('{"message":"好的","done":false}')).toEqual({ message: '好的', done: false });
  });
  it('parses JSON wrapped in code fences', () => {
    expect(parseSimOutput('```json\n{"message":"谢谢","done":true}\n```')).toEqual({ message: '谢谢', done: true });
  });
  it('throws SimError on non-JSON', () => {
    expect(() => parseSimOutput('随便说说')).toThrow(SimError);
  });
  it('throws SimError on schema violation (empty message)', () => {
    expect(() => parseSimOutput('{"message":"","done":false}')).toThrow(SimError);
  });
});

describe('simulateUserTurn', () => {
  it('round-trips a valid fake model response', async () => {
    const turn = await simulateUserTurn(fakeTextModel('{"message":"我想查合同","done":false}') as any, persona, []);
    expect(turn).toEqual({ message: '我想查合同', done: false });
  });
  it('propagates SimError for invalid JSON (never silently passes)', async () => {
    await expect(
      simulateUserTurn(fakeTextModel('not json') as any, persona, []),
    ).rejects.toBeInstanceOf(SimError);
  });
});
