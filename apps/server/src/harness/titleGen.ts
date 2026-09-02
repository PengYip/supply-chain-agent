import { generateText, type LanguageModel } from 'ai';
import { env } from '../env.js';
import { resolveAuxModel } from '../pipeline/ingestModel.js';
import { recordLlmCall } from './usageAudit.js';

const MAX_TITLE_LEN = 20;

/** Best-effort model id for audit rows (LanguageModelV1 exposes modelId). */
function modelId(model: LanguageModel): string {
  return String((model as { modelId?: string }).modelId ?? '') || env.OPENAI_MODEL;
}

/** Deterministic fallback: truncated, whitespace-collapsed first user message. */
export function fallbackTitle(firstUserText: string): string {
  const trimmed = firstUserText.replace(/\s+/g, ' ').trim();
  if (!trimmed) return '新会话';
  return trimmed.length > MAX_TITLE_LEN ? trimmed.slice(0, MAX_TITLE_LEN) + '…' : trimmed;
}

/**
 * One-shot title from the first user/assistant exchange. Never throws:
 * on any error or empty model output, falls back to fallbackTitle(firstUserText).
 * Cheap model call (short prompt + short output) — fires after the stream.
 */
export async function generateSessionTitle(
  model: LanguageModel,
  firstUserText: string,
  firstReply: string,
): Promise<string> {
  try {
    const t0 = Date.now();
    const { text, usage } = await generateText({
      model,
      system:
        '你是一个会话标题生成器。根据用户的首条消息和助手的首条回复，生成一个不超过12个汉字的简洁标题。只输出标题文字，不要引号、不要标点、不要解释。',
      prompt: `用户: ${firstUserText.slice(0, 500)}\n助手: ${firstReply.slice(0, 500)}`,
      // 2026-09-02: 关闭 thinking(确定性标题生成, 推理 token 按输出计费)。
      providerOptions: {
        deepseek: { thinking: { type: 'disabled' } },
      },
      // 2026-09-02: 解析 LLM 调用接入 Langfuse 观测(Tier 1)。
      experimental_telemetry: {
        isEnabled: true,
        recordInputs: true,
        recordOutputs: true,
        functionId: 'harness.title_gen',
      },
    });
    recordLlmCall({
      kind: 'title',
      model: modelId(model),
      inputTokens: usage?.inputTokens ?? null,
      outputTokens: usage?.outputTokens ?? null,
      totalTokens: usage?.totalTokens ?? null,
      inputText: `用户: ${firstUserText.slice(0, 500)}\n助手: ${firstReply.slice(0, 500)}`,
      outputText: text,
      durationMs: Date.now() - t0,
      status: 'ok',
    });
    const t = text.replace(/\s+/g, ' ').trim();
    return t ? (t.length > MAX_TITLE_LEN ? t.slice(0, MAX_TITLE_LEN) + '…' : t) : fallbackTitle(firstUserText);
  } catch (e) {
    recordLlmCall({
      kind: 'title', model: modelId(model),
      status: 'error', error: e instanceof Error ? e.message : String(e),
    });
    return fallbackTitle(firstUserText);
  }
}

// Phase 5 title-generation model handle. Lazy singleton reusing the shared
// auxiliary resolver (resolveAuxModel): PIPELINE_LLM_* (Bailian qwen) when
// configured, else the main OPENAI_* (DeepSeek) config — the same model the
// ingest pipeline uses. Only used on the first turn of a session (one-shot
// title), so construction amortizes.
//
// Migrated here from routes/chat.ts so the background run executor (runSession)
// and chat.ts share one source of truth for the title model. chat.ts still has
// its own local copy for now (Task 7b removes it when chat.ts goes background).
let titleModel: LanguageModel | null = null;
export function getTitleModel(): LanguageModel {
  if (!titleModel) {
    const { model, label } = resolveAuxModel();
    titleModel = model;
    console.log(`[boot] title llm: ${label}`);
  }
  return titleModel;
}
