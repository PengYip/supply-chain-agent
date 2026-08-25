import { describe, it, expect } from 'vitest';
import { buildJudgePrompt, parseJudgeOutput, judgeEpisode, JudgeError } from '../../eval/agent/judge.js';
import { aggregateScore } from '../../eval/agent/scoring.js';
import type { EpisodeArtifact, Rubric } from '../../eval/agent/types.js';
import type { VerifierResult } from '../../eval/agent/verifiers.js';

const rubric: Rubric = {
  dimensions: [
    { name: '操作正确性', weight: 'essential', scoring: { 4: '调用工具且正确', 1: '未调用工具' } },
    { name: '沟通质量', weight: 'optional', scoring: { 4: '清晰', 1: '无法理解' } },
  ],
  veto: { hallucination: '编造工具返回之外的事实' },
};

function artifact(partial: Partial<EpisodeArtifact> = {}): EpisodeArtifact {
  return {
    scenarioId: 'x', runIndex: 1, sessionId: 's', startedAt: '', wallMs: 0, turnsUsed: 2,
    transcript: [
      { role: 'user', text: '查一下订单' },
      { role: 'assistant', text: '已查询, 共 4 笔订单' },
    ],
    toolCalls: [{ toolName: 'query_orders', args: { contractNo: 'HT-2024-001' }, result: { count: 4 }, durationMs: 10 }],
    approvals: [],
    finalAssistantText: '共 4 笔订单',
    totalUsage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
    ...partial,
  };
}

function fakeTextModel(text: string, calls: string[] = []) {
  return {
    specificationVersion: 'v2' as const,
    provider: 'fake', modelId: 'fake-judge',
    supportedUrls: {} as Record<string, RegExp[]>,
    async doGenerate() {
      calls.push(text);
      return {
        content: [{ type: 'text' as const, text }],
        finishReason: 'stop' as const,
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        warnings: [] as unknown[],
      };
    },
    async doStream() { throw new Error('stream not expected'); },
  };
}

describe('buildJudgePrompt', () => {
  it('embeds every dimension anchor, veto rule, transcript and tool calls', () => {
    const { system, user } = buildJudgePrompt(rubric, artifact());
    expect(system).toContain('操作正确性');
    expect(system).toContain('调用工具且正确');
    expect(system).toContain('编造工具返回之外的事实');
    expect(user).toContain('query_orders');
    expect(user).toContain('共 4 笔订单');
  });
});

describe('parseJudgeOutput', () => {
  it('parses a valid verdict with dimensions and veto false', () => {
    const out = parseJudgeOutput(JSON.stringify({
      dimensions: [
        { name: '操作正确性', score: 4, rationale: '调用了工具' },
        { name: '沟通质量', score: 3, rationale: '清楚' },
      ],
      vetoTriggered: false,
      confidence: 0.9,
    }), rubric);
    expect(out.dimensions).toHaveLength(2);
    expect(out.dimensions[0]!.score).toBe(4);
    expect(out.dimensions[0]!.weight).toBe('essential');
    expect(out.vetoTriggered).toBe(false);
    expect(out.confidence).toBe(0.9);
  });
  it('parses veto true with rationale', () => {
    const out = parseJudgeOutput(JSON.stringify({
      dimensions: [
        { name: '操作正确性', score: 4, rationale: 'ok' },
        { name: '沟通质量', score: 3, rationale: 'ok' },
      ],
      vetoTriggered: true,
      vetoRationale: '编造了 5 笔订单',
      confidence: 0.85,
    }), rubric);
    expect(out.vetoTriggered).toBe(true);
    expect(out.vetoRationale).toBe('编造了 5 笔订单');
  });
  it('parses fenced JSON', () => {
    const out = parseJudgeOutput('```json\n{"dimensions":[{"name":"操作正确性","score":2,"rationale":"部分"},{"name":"沟通质量","score":3,"rationale":"部分"}],"vetoTriggered":false,"confidence":0.6}\n```', rubric);
    expect(out.dimensions[0]!.score).toBe(2);
  });
  it('throws JudgeError on non-JSON', () => {
    expect(() => parseJudgeOutput('我觉得不错', rubric)).toThrow(JudgeError);
  });
  it('throws JudgeError when a dimension is missing', () => {
    expect(() => parseJudgeOutput(JSON.stringify({
      dimensions: [{ name: '操作正确性', score: 4, rationale: 'ok' }],
      vetoTriggered: false,
      confidence: 0.9,
    }), rubric)).toThrow(JudgeError);
  });
  it('throws JudgeError on out-of-range score', () => {
    expect(() => parseJudgeOutput(JSON.stringify({
      dimensions: [
        { name: '操作正确性', score: 4, rationale: 'ok' },
        { name: '沟通质量', score: 9, rationale: 'x' },
      ],
      vetoTriggered: false,
      confidence: 0.9,
    }), rubric)).toThrow(JudgeError);
  });
});

describe('judgeEpisode', () => {
  it('retries once on invalid JSON then succeeds', async () => {
    const calls: string[] = [];
    let n = 0;
    const model = {
      specificationVersion: 'v2' as const, provider: 'fake', modelId: 'fake-judge',
      supportedUrls: {} as Record<string, RegExp[]>,
      async doGenerate() {
        n++;
        const text = n === 1 ? 'oops not json' : JSON.stringify({
          dimensions: rubric.dimensions.map((d) => ({ name: d.name, score: 3, rationale: 'ok' })),
          vetoTriggered: false,
          confidence: 0.8,
        });
        calls.push(text);
        return { content: [{ type: 'text' as const, text }], finishReason: 'stop' as const, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, warnings: [] as unknown[] };
      },
      async doStream() { throw new Error('no stream'); },
    };
    const out = await judgeEpisode(model as any, rubric, artifact());
    expect(out.ok).toBe(true);
    expect(calls).toHaveLength(2);
  });
  it('returns ok=false after retry exhausted', async () => {
    const out = await judgeEpisode(fakeTextModel('garbage') as any, rubric, artifact());
    expect(out.ok).toBe(false);
    expect(out.error).toBeTruthy();
  });
});

describe('aggregateScore', () => {
  const vPass: VerifierResult = { passed: true, failures: [] };
  const vFail: VerifierResult = { passed: false, failures: [{ check: 'mustAppear', detail: '缺 query_orders' }] };
  const judgeOk = {
    ok: true, dimensions: [
      { name: '操作正确性', weight: 'essential' as const, score: 4, rationale: 'ok' },
      { name: '沟通质量', weight: 'optional' as const, score: 2, rationale: '一般' },
    ], vetoTriggered: false, confidence: 0.9,
  };
  it('verifier fail -> verdict fail even when judge is fine (deterministic veto first)', () => {
    const s = aggregateScore(artifact(), vFail, judgeOk);
    expect(s.verdict).toBe('fail');
    expect(s.firstFailure!.check).toBe('mustAppear');
  });
  it('all pass -> pass with weighted score', () => {
    const s = aggregateScore(artifact(), vPass, judgeOk);
    expect(s.verdict).toBe('pass');
    expect(s.rubricScore).toBe(3.333); // (4*1.0 + 2*0.5) / 1.5, toFixed(3)
  });
  it('judge veto -> fail regardless of dimension scores', () => {
    const s = aggregateScore(artifact(), vPass, { ...judgeOk, vetoTriggered: true, vetoRationale: '编造' });
    expect(s.verdict).toBe('fail');
    expect(s.vetoTriggered).toBe(true);
  });
  it('low judge confidence -> needs_human_review (not auto-pass)', () => {
    const s = aggregateScore(artifact(), vPass, { ...judgeOk, confidence: 0.4 });
    expect(s.verdict).toBe('needs_human_review');
  });
  it('essential dimension below 2 -> fail (essential gate)', () => {
    const s = aggregateScore(artifact(), vPass, {
      ...judgeOk,
      dimensions: [
        { name: '操作正确性', weight: 'essential' as const, score: 1, rationale: '没调工具' },
        { name: '沟通质量', weight: 'optional' as const, score: 4, rationale: '好' },
      ],
    });
    expect(s.verdict).toBe('fail');
  });
  it('judge error with passing verifiers -> judge_error verdict', () => {
    const s = aggregateScore(artifact(), vPass, null);
    expect(s.verdict).toBe('judge_error');
    expect(s.rubricScore).toBeNull();
  });
  it('simError -> sim_error verdict, verifier still recorded', () => {
    const s = aggregateScore(artifact({ simError: 'sim blew up' }), vFail, null);
    expect(s.verdict).toBe('sim_error');
  });
});

describe('env judge vars', () => {
  it('exposes optional EVAL_JUDGE_* with main-model fallback semantics', async () => {
    const { env } = await import('../../src/env.js');
    expect(typeof env.EVAL_JUDGE_BASE_URL === 'undefined' || typeof env.EVAL_JUDGE_BASE_URL === 'string').toBe(true);
  });
});
