import { generateText, type LanguageModel } from 'ai';

const MAX_TITLE_LEN = 20;

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
    const { text } = await generateText({
      model,
      system:
        '你是一个会话标题生成器。根据用户的首条消息和助手的首条回复，生成一个不超过12个汉字的简洁标题。只输出标题文字，不要引号、不要标点、不要解释。',
      prompt: `用户: ${firstUserText.slice(0, 500)}\n助手: ${firstReply.slice(0, 500)}`,
    });
    const t = text.replace(/\s+/g, ' ').trim();
    return t ? (t.length > MAX_TITLE_LEN ? t.slice(0, MAX_TITLE_LEN) + '…' : t) : fallbackTitle(firstUserText);
  } catch {
    return fallbackTitle(firstUserText);
  }
}
