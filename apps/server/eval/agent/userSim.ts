// apps/server/eval/agent/userSim.ts
// tau-bench style LLM user simulator: progressive information disclosure,
// fact-anchored (must not invent beyond persona.facts), bounded patience.
// Output contract is strict JSON parsed locally (avoids provider JSON-mode
// quirks; works with any OpenAI-compatible endpoint).
import { generateText, type LanguageModel } from 'ai';
import { z } from 'zod';
import type { Persona, TranscriptEntry } from './types.js';

export class SimError extends Error {}

const SimOutputSchema = z.object({
  message: z.string().min(1),
  done: z.boolean(),
});

export function buildUserSimPrompt(
  persona: Persona,
  conversation: TranscriptEntry[],
): { system: string; user: string } {
  const system = [
    '你在一场供应链贸易 Agent 的评估中扮演"用户"(客户/贸易员)角色, 与被测 Agent 对话。严格遵守:',
    `1. 目标: ${persona.goal}`,
    '2. 渐进式透露: 不要一次性说出全部信息; 只在 Agent 询问或确有必要时才给出下一步信息。',
    `3. 事实锚定: 只能使用以下已知事实, 严禁编造事实之外的信息(数字/单号/日期等):\n${persona.facts.map((f) => `   - ${f}`).join('\n')}`,
    `4. 透露节奏: ${persona.disclosure}`,
    `5. 耐心: 你最多愿意接受 ${persona.patience} 轮含糊或无效的回复; 超过后 done=true 并用 message 简短表达不满后结束。`,
    '6. 当且仅当你的目标已达成(Agent 完成了你要求的事或给出明确结论)时 done=true, 并用 message 简短收尾。',
    '7. 用中文口语化表达, 每轮只输出下一句要说的话。',
    '输出严格 JSON: {"message": string, "done": boolean}, 不要输出任何其他内容。',
  ].join('\n');
  const transcript =
    conversation.length === 0
      ? '(对话尚未开始, 请说出你的第一句开场白)'
      : conversation
          .filter((e) => e.role !== 'system-note')
          .map((e) => `${e.role === 'user' ? '用户(你)' : 'Agent'}: ${e.text}`)
          .join('\n');
  const user = `${transcript}\n\n请输出你作为用户的下一句(严格 JSON)。`;
  return { system, user };
}

export function parseSimOutput(text: string): { message: string; done: boolean } {
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '');
  let obj: unknown;
  try {
    obj = JSON.parse(cleaned);
  } catch {
    throw new SimError(`userSim 输出不是合法 JSON: ${text.slice(0, 200)}`);
  }
  const r = SimOutputSchema.safeParse(obj);
  if (!r.success) {
    throw new SimError(
      `userSim 输出 schema 不符: ${JSON.stringify(r.error.flatten().fieldErrors)}`,
    );
  }
  return r.data;
}

export async function simulateUserTurn(
  model: LanguageModel,
  persona: Persona,
  conversation: TranscriptEntry[],
): Promise<{ message: string; done: boolean }> {
  const { system, user } = buildUserSimPrompt(persona, conversation);
  const { text } = await generateText({ model, system, prompt: user, temperature: 0 });
  return parseSimOutput(text);
}
