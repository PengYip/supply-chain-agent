// apps/server/eval/agent/judge.ts
// LLM-as-a-Judge over the episode artifact. Follows the book's rubric rules:
// four-level anchors per dimension, hallucination as a veto, structured JSON
// output with step references. Prompt explicitly de-biases length ("score by
// the anchors, not by verbosity") to counter the known length bias.
import { generateText, type LanguageModel } from 'ai';
import { z } from 'zod';
import type { EpisodeArtifact, JudgeDimensionScore, JudgeOutcome, Rubric } from './types.js';

export class JudgeError extends Error {}

const JudgeOutputSchema = z.object({
  dimensions: z.array(z.object({
    name: z.string(),
    score: z.number().min(1).max(4),
    rationale: z.string().min(1),
  })),
  vetoTriggered: z.boolean(),
  vetoRationale: z.string().optional(),
  confidence: z.number().min(0).max(1),
});

export function buildJudgePrompt(rubric: Rubric, artifact: EpisodeArtifact): { system: string; user: string } {
  const dims = rubric.dimensions
    .map((d, i) => {
      const anchors = Object.entries(d.scoring)
        .sort((a, b) => Number(b[0]) - Number(a[0]))
        .map(([k, v]) => `      ${k} 分: ${v}`)
        .join('\n');
      return `  维度${i + 1}: ${d.name} (权重: ${d.weight})\n${anchors}`;
    })
    .join('\n');
  const veto = rubric.veto
    ? `一票否决项(触发则整体判败): ${rubric.veto.hallucination}`
    : '(本场景无一票否决项)';
  const system = [
    '你是供应链贸易 Agent 的评估裁判。依据给定 Rubric 对一次 Agent 运行轨迹评分。规则:',
    '1. 逐维度打 1-4 分, 严格按各档行为锚点判定, 引用具体步骤/工具调用作为理由。',
    '2. 按锚点评分, 不要因回复更长更详尽而给高分(长度偏差防范)。',
    `3. ${veto}`,
    '4. confidence 为你对本次评判的置信度(0-1); 证据不足时给低值, 不要硬判。',
    '输出严格 JSON: {"dimensions":[{"name","score","rationale"}],"vetoTriggered":boolean,"vetoRationale"?:string,"confidence":number}',
    '',
    'Rubric 维度:',
    dims,
  ].join('\n');
  const toolLines = artifact.toolCalls
    .map((t, i) => `  ${i + 1}. ${t.toolName}(${JSON.stringify(t.args)}) -> ${JSON.stringify(t.result).slice(0, 400)}`)
    .join('\n');
  const transcriptLines = artifact.transcript
    .map((e) => `  ${e.role === 'user' ? '用户' : e.role === 'assistant' ? 'Agent' : '系统'}: ${e.text}`)
    .join('\n');
  const approvalLines = artifact.approvals
    .map((a) => `  ${a.level} ${a.toolName} -> ${a.decision} (${a.reason})`)
    .join('\n');
  const user = [
    '== 运行轨迹 ==',
    transcriptLines || '  (空)',
    '== 工具调用 ==',
    toolLines || '  (无)',
    '== 审批事件 ==',
    approvalLines || '  (无)',
    `== 环境最终状态 ==`,
    `  contractLinked: ${JSON.stringify(artifact.envSnapshot.contractLinked)}`,
    artifact.simError ? `== 模拟用户异常 ==\n  ${artifact.simError}` : '',
    '',
    '请按 Rubric 输出评判 JSON。',
  ].filter(Boolean).join('\n');
  return { system, user };
}

export function parseJudgeOutput(text: string, rubric: Rubric): {
  dimensions: JudgeDimensionScore[];
  vetoTriggered: boolean;
  vetoRationale?: string;
  confidence: number;
} {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  let obj: unknown;
  try {
    obj = JSON.parse(cleaned);
  } catch {
    throw new JudgeError(`judge 输出不是合法 JSON: ${text.slice(0, 200)}`);
  }
  const r = JudgeOutputSchema.safeParse(obj);
  if (!r.success) {
    throw new JudgeError(`judge 输出 schema 不符: ${JSON.stringify(r.error.flatten().fieldErrors)}`);
  }
  const weightByName = new Map(rubric.dimensions.map((d) => [d.name, d.weight]));
  const dims: JudgeDimensionScore[] = rubric.dimensions.map((want) => {
    const got = r.data.dimensions.find((d) => d.name === want.name);
    if (!got) throw new JudgeError(`judge 缺少维度评分: ${want.name}`);
    return { name: want.name, weight: weightByName.get(want.name)!, score: got.score, rationale: got.rationale };
  });
  return {
    dimensions: dims,
    vetoTriggered: r.data.vetoTriggered,
    vetoRationale: r.data.vetoRationale,
    confidence: r.data.confidence,
  };
}

export async function judgeEpisode(
  model: LanguageModel,
  rubric: Rubric,
  artifact: EpisodeArtifact,
): Promise<JudgeOutcome> {
  const { system, user } = buildJudgePrompt(rubric, artifact);
  let lastErr = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const { text } = await generateText({ model, system, prompt: user, temperature: 0 });
      const parsed = parseJudgeOutput(text, rubric);
      return {
        ok: true,
        dimensions: parsed.dimensions,
        vetoTriggered: parsed.vetoTriggered,
        vetoRationale: parsed.vetoRationale,
        confidence: parsed.confidence,
      };
    } catch (err) {
      lastErr = err instanceof Error ? err.message : String(err);
    }
  }
  return { ok: false, error: lastErr, dimensions: [], vetoTriggered: false, confidence: 0 };
}
