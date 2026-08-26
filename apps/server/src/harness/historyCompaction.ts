// Conversation-level history compaction (integration point B, 2026-08).
//
// Pattern borrowed from Codex / OpenCode / Pi auto-compact (research
// 2026-08-26, source-verified): no hard round cap -- context growth is
// governed by TOKEN thresholds. When a run's total token usage crosses
// AGENT_CONTEXT_WINDOW_TOKENS - AGENT_COMPACT_RESERVE_TOKENS, older turns
// are LLM-summarized into a structured summary; the boundary + summary are
// stored in sessions.metadata_json.historyCompaction. Later turns send the
// model [summary + recent tail] instead of the full history.
//
// Three-segment assembly (Pi style):
//   [summary message | verbatim recent tail | this turn's new messages]
//
// Safety properties:
//   - session_messages rows are NEVER deleted (UI history stays complete);
//     compaction only changes what the MODEL sees.
//   - Fail-open everywhere: summarizer failure => full history is sent
//     (compaction simply does not happen that turn).
//   - Boundary only moves forward and messages are append-only, so a
//     fire-and-forget compaction that lands after the next turn started is
//     still consistent (the next turn just sends the un-compacted history).
//   - The summarizer prompt requires exact preservation of business
//     identifiers (contract numbers, amounts, ticket ids) to keep the
//     zero-hallucination guardrail meaningful after compaction.

import {
  convertToModelMessages,
  generateText,
  type LanguageModel,
  type ModelMessage,
  type UIMessage,
} from 'ai';
import { env } from '../env.js';
import { loadSession, mergeSessionMetadata } from './sessionStore.js';
import { getTitleModel } from './titleGen.js';

export interface CompactionPlan {
  /** Number of leading UIMessages the summary covers (exclusive bound). */
  boundary: number;
  summary: string;
}

/** metadata_json key the plan is stored under. */
const METADATA_KEY = 'historyCompaction';

/** Read the stored plan out of a LoadedSession.metadata blob (defensive). */
export function readCompactionPlan(metadata?: Record<string, unknown>): CompactionPlan | null {
  if (!metadata) return null;
  const raw = metadata[METADATA_KEY] as { boundary?: unknown; summary?: unknown } | undefined;
  if (!raw || typeof raw !== 'object') return null;
  const { boundary, summary } = raw;
  if (typeof boundary !== 'number' || !Number.isInteger(boundary) || boundary < 0) return null;
  if (typeof summary !== 'string' || summary.trim().length === 0) return null;
  return { boundary, summary };
}

/** Token trigger: compact once a run's total usage crosses window - reserve. */
export function shouldCompact(totalTokens: number): boolean {
  return totalTokens >= env.AGENT_CONTEXT_WINDOW_TOKENS - env.AGENT_COMPACT_RESERVE_TOKENS;
}

// ---- transcript rendering (bounded; feeds the summarizer LLM call) ----

const PER_TEXT_CHARS = 2000;
const PER_TOOL_CHARS = 300;
const TOTAL_CHARS = 80_000;

function extractText(msg: UIMessage): string {
  return (msg.parts as Array<{ type?: string; text?: string }>)
    .filter((p) => p?.type === 'text')
    .map((p) => String(p.text ?? ''))
    .join('')
    .trim();
}

function renderToolLines(msg: UIMessage): string[] {
  const lines: string[] = [];
  for (const p of msg.parts as Array<{ type?: string; toolName?: string; state?: string; output?: unknown }>) {
    if (p?.type !== 'dynamic-tool' && !(p?.type ?? '').startsWith('tool-')) continue;
    let out = '';
    try {
      out = JSON.stringify(p.output ?? null) ?? '';
    } catch {
      out = String(p.output ?? '');
    }
    if (out.length > PER_TOOL_CHARS) out = out.slice(0, PER_TOOL_CHARS) + '...';
    lines.push(`  [工具 ${p.toolName ?? p.type} | ${p.state ?? '?'}] ${out}`);
  }
  return lines;
}

/** Deterministic, length-capped text rendering of a UIMessage slice. */
export function renderTranscript(messages: UIMessage[]): string {
  const blocks: string[] = [];
  let total = 0;
  for (const m of messages) {
    let block = `${m.role === 'user' ? '用户' : '助手'}: ${extractText(m).slice(0, PER_TEXT_CHARS)}`;
    const tools = renderToolLines(m);
    if (tools.length > 0) block += '\n' + tools.join('\n');
    total += block.length;
    blocks.push(block);
    if (total >= TOTAL_CHARS) {
      const skipped = messages.length - blocks.length;
      if (skipped > 0) blocks.push(`(...其余 ${skipped} 条消息省略...)`);
      break;
    }
  }
  return blocks.join('\n\n');
}

// ---- summarizer (LLM, same model family as the agent) ----

const SUMMARIZER_SYSTEM = [
  '你是对话历史压缩器。请把用户与供应链贸易助手之间较早的对话历史，压缩成一份结构化摘要，',
  '供同一个助手在后续对话中继续工作使用。',
  '必须保留：',
  '- 用户的核心诉求；',
  '- 已确认的业务事实（合同号、单据号、工单号、金额、数量、日期等精确值必须逐字保留，不得改写、四舍五入或编造）；',
  '- 已完成的操作及其结果（录入、抽取、绑定、呈现复核卡、生成工单等）；',
  '- 未完成事项、用户的约束与偏好。',
  '输出格式（纯文本，只用这些小节）：',
  '## 用户目标',
  '## 关键业务数据（逐字精确）',
  '## 已完成操作',
  '## 未完成/待跟进',
  '## 其他约束与偏好',
  '只输出摘要本身，不要任何解释或前后缀。',
].join('\n');

/**
 * LLM-summarize a message slice. Returns null on any failure or empty output
 * (callers treat null as "do not compact" -- fail-open).
 */
export async function summarizeHistory(
  model: LanguageModel,
  messages: UIMessage[],
  priorSummary?: string,
): Promise<string | null> {
  const transcript = renderTranscript(messages);
  if (!transcript.trim()) return null;
  const updateNote = priorSummary
    ? `\n\n以下是此前已有的摘要，请把新对话合并进去，保留其中仍未失效的信息：\n<previous-summary>\n${priorSummary.slice(0, 8000)}\n</previous-summary>`
    : '';
  try {
    const { text } = await generateText({
      model,
      system: SUMMARIZER_SYSTEM,
      prompt: `<conversation>${transcript}</conversation>${updateNote}`,
      maxOutputTokens: 2048,
    });
    const t = text.trim();
    return t ? t : null;
  } catch {
    return null;
  }
}

// ---- compaction orchestration ----

export interface MaybeCompactOpts {
  sessionId: string;
  /** The finished run's total token usage (trigger signal). */
  totalTokens: number;
  /** Test seam; defaults to the shared DeepSeek client (getTitleModel). */
  model?: LanguageModel;
}

/**
 * Check the trigger and, if crossed, compact: summarize all messages before
 * the KEEP-messages tail (merging any prior summary) and persist the new
 * boundary + summary into session metadata. Returns true when a compaction
 * was written. Fail-open: every error path returns false and the next turn
 * simply sends the full history.
 */
export async function maybeCompactHistory(opts: MaybeCompactOpts): Promise<boolean> {
  if (!shouldCompact(opts.totalTokens)) return false;
  const session = await loadSession(opts.sessionId);
  if (!session) return false;
  const messages = session.messages;
  if (messages.length <= env.AGENT_COMPACT_KEEP_MESSAGES) return false;

  const prior = readCompactionPlan(session.metadata);
  const priorBoundary = prior?.boundary ?? 0;
  // Boundary lands on a user message so the tail starts with a clean Q/A pair.
  let boundary = messages.length - env.AGENT_COMPACT_KEEP_MESSAGES;
  while (boundary < messages.length && messages[boundary]?.role !== 'user') boundary++;
  // Nothing new to compact since the last summary (or worse): keep as is.
  if (boundary <= priorBoundary) return false;

  const model = opts.model ?? getTitleModel();
  const summary = await summarizeHistory(model, messages.slice(priorBoundary, boundary), prior?.summary);
  if (!summary) return false;

  await mergeSessionMetadata(opts.sessionId, {
    [METADATA_KEY]: {
      boundary,
      summary,
      compactedAt: new Date().toISOString(),
      triggerTokens: opts.totalTokens,
    },
  });
  return true;
}

// ---- model-input assembly (chat.ts / approvalCallback.ts seam) ----

/** Build the model-facing summary message (user role; machine-injected). */
export function buildSummaryMessage(summary: string): ModelMessage {
  return {
    role: 'user',
    content:
      '[系统注入·历史摘要] 本会话较早的对话已被压缩为下面的摘要（其中业务数字与单号要求逐字保留，可直接引用）。摘要之后是最近的原始对话。\n' +
      `<summary>\n${summary}\n</summary>`,
  };
}

/**
 * Convert the persisted UI history into model messages, applying the stored
 * compaction plan when present: [summary, ...tail]. Without a valid plan
 * (or when the plan no longer fits the current history) this is a plain
 * convertToModelMessages -- identical to the pre-compaction behavior.
 */
export async function buildHistoryModelMessages(
  prior: UIMessage[],
  metadata?: Record<string, unknown>,
): Promise<ModelMessage[]> {
  if (prior.length === 0) return [];
  const plan = readCompactionPlan(metadata);
  if (!plan || plan.boundary <= 0 || plan.boundary >= prior.length) {
    return convertToModelMessages(prior);
  }
  const tail = await convertToModelMessages(prior.slice(plan.boundary));
  return [buildSummaryMessage(plan.summary), ...tail];
}
