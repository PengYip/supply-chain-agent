// Background run executor. Reuses runStream (full streamText config) but, instead
// of returning result.toUIMessageStreamResponse as an HTTP body, CONSUMES the
// result's UI message stream: each chunk is emitted to the session event bus,
// and the stream's onFinish persists the assistant UIMessage. This is the
// connection-decoupling core.
//
// Status ownership (Task 7a): runSession NO LONGER touches session status. The
// caller (RunManager.startSessionRun, Task 4) owns the busy->idle lifecycle and
// the canonical runId; runSession setting its own status would overwrite
// sessions.run_id with a different uuid (Task 5 concern 3). A throwing runSession
// lets the error propagate to RunManager's wrapper, which resets idle in its
// finally.
//
// AI SDK 6 note (verified against ai@6.0.246 d.ts): streamText's own onFinish
// event (OnFinishEvent = StepResult & {...}) carries response.messages as
// ModelMessages -- it has NO UIMessage `responseMessage`. The assistant
// UIMessage is assembled by toUIMessageStream's finish handling
// (handleUIMessageStreamFinish), the exact mechanism chat.ts already relies on
// via toUIMessageStreamResponse. So persistence is wired on
// result.toUIMessageStream here rather than forwarded through streamText.
// toUIMessageStream is a tee'd view of result.fullStream: background-consuming
// it drives generation exactly the same, and chunks are already in the wire
// format a reconnecting SSE client (Task 6) can forward.

import type { ModelMessage, LanguageModel, UIMessage } from 'ai';
import { randomUUID } from 'node:crypto';
import { runStream, recordL2PendingFromResponse } from './agent.js';
import { appendMessages, replaceMessage, setSessionTitle } from './sessionStore.js';
import { emit } from './sessionEvents.js';
import { generateSessionTitle, getTitleModel } from './titleGen.js';
import { maybeCompactHistory } from './historyCompaction.js';
import { recordLlmCall } from './usageAudit.js';
import { env } from '../env.js';
import type { Role } from './roleToolRegistry.js';

export interface RunSessionOpts {
  sessionId: string;
  userId?: string;
  role: Role;
  messages: ModelMessage[];
  auditTraceId: string;
  abortSignal: AbortSignal;
  model?: LanguageModel; // test seam
  /** title-gen: fires on the first turn of a session. */
  isFirstTurn?: boolean;
  /** title-gen: the first user message text (pre-extracted by the caller). */
  firstUserText?: string;
  /**
   * Opt-out of the <agent_status> injection inside runStream. Approval-resume
   * callers (approvalCallback) set this so the transient trailing role:'tool'
   * tool-approval-response stays the last message (SDK collectToolApprovals
   * pairing), instead of being displaced by an appended user status message.
   */
  skipStatusMessage?: boolean;
  /**
   * Continuation mode for approval-resume runs: the persisted UI history whose
   * LAST message is the assistant message to continue (the L2
   * approval-requested message). The SDK seeds UI assembly from it, so
   * re-executed tool-result / tool-output-denied chunks find the
   * approval-requested part and update it in place, instead of throwing
   * "No tool invocation found for tool call ID" against a freshly assembled
   * message. onFinish then reports isContinuation=true and runSession replaces
   * that message in place rather than appending.
   */
  originalMessages?: UIMessage[];
}

/**
 * Defensively extract text from a message, handling BOTH shapes:
 *   - ModelMessage: `.content` is a string or an array of `{type:'text', text}` parts.
 *   - UIMessage (AI SDK 6 parts format): `.parts` is an array of `{type:'text', text}`.
 * Duplicated from routes/chat.ts pending Task 7b consolidation (chat.ts will
 * delegate to runSession and drop its own copy).
 */
export function extractMessageText(msg: any): string {
  const content = msg?.content;
  if (typeof content === 'string') return content;
  const parts = Array.isArray(content) ? content : msg?.parts;
  if (Array.isArray(parts)) {
    return parts
      .filter((p: any) => p?.type === 'text')
      .map((p: any) => String(p?.text ?? ''))
      .join('');
  }
  return '';
}

export async function runSession(opts: RunSessionOpts): Promise<void> {
  const { sessionId, role, messages, auditTraceId, abortSignal, userId, model, isFirstTurn, firstUserText, skipStatusMessage, originalMessages } = opts;
  const auditT0 = Date.now();
  // Audit: this turn's user input (prompt tail) for the usage-audit page.
  const lastUserMsg = [...messages].reverse().find((m) => m.role === 'user');
  const auditInputText = extractMessageText(lastUserMsg);

  const result = await runStream({
    messages,
    role,
    auditTraceId,
    sessionId,
    userId,
    model,
    abortSignal,
    skipStatusMessage,
  });

  // History compaction trigger (B): after the turn, compare the run's TOTAL
  // token usage against AGENT_CONTEXT_WINDOW_TOKENS - RESERVE; on breach,
  // fire-and-forget an LLM summarization of older turns (fail-open inside).
  result.totalUsage.then(
    (u) => {
      void maybeCompactHistory({ sessionId, totalTokens: u.totalTokens ?? 0 }).catch(() => {
        /* compaction is best-effort; full history is the fallback */
      });
    },
    () => {
      /* stream errors surface via the consumed uiStream */
    },
  );

  // After the stream completes, record any L2 soft-gate approvals requested this
  // turn + fire title-gen on the first exchange. Same fire-and-forget pattern
  // chat.ts uses via result.response.then(...). result.response is a PromiseLike
  // (no .catch), so use the 2-arg .then. Migrated here so chat.ts can go
  // background in Task 7b without holding the result itself.
  result.response.then(
    async (r) => {
      // Usage audit (fire-and-forget, best-effort): record this chat turn's
      // tokens + truncated input/output. totalUsage is resolved by the time
      // the response promise settles (the stream has flushed).
      try {
        const usage = await result.totalUsage;
        recordLlmCall({
          sessionId,
          userId,
          kind: 'chat',
          model: model ? String((model as { modelId?: string }).modelId ?? '') : env.OPENAI_MODEL,
          inputTokens: usage.inputTokens ?? null,
          outputTokens: usage.outputTokens ?? null,
          totalTokens: usage.totalTokens ?? null,
          inputText: auditInputText,
          outputText: extractMessageText(r.messages.find((m) => m.role === 'assistant')),
          durationMs: Date.now() - auditT0,
          status: 'ok',
        });
      } catch (err) {
        recordLlmCall({
          sessionId, userId, kind: 'chat',
          model: model ? String((model as { modelId?: string }).modelId ?? '') : env.OPENAI_MODEL,
          inputText: auditInputText, durationMs: Date.now() - auditT0,
          status: 'error', error: err instanceof Error ? err.message : String(err),
        });
      }
      try {
        await recordL2PendingFromResponse(sessionId, r.messages);
      } catch (err) {
        console.error('[runSession] L2 record failed:', err instanceof Error ? err.message : err);
      }
      if (isFirstTurn && firstUserText) {
        const replyText = extractMessageText(r.messages.find((m) => m.role === 'assistant'));
        void generateSessionTitle(getTitleModel(), firstUserText, replyText)
          .then((title) => setSessionTitle(sessionId, title))
          .catch(() => {
            /* title-gen is best-effort; never surface to the user */
          });
      }
    },
    () => {
      /* stream errors surface via the consumed uiStream */
    },
  );

  // R1 core: consume the stream so generation progresses in the background;
  // each chunk is broadcast on the session event bus. Not binding to any HTTP
  // response body. onFinish fires from the stream's flush (awaited before the
  // stream closes), so the assistant UIMessage is persisted by the time the
  // for-await below exits.
  const uiStream = result.toUIMessageStream({
    originalMessages,
    generateMessageId: randomUUID,
    // Async since the session store went dual-backend (SQLite/Postgres). The
    // SDK awaits onFinish during the stream's flush (before the stream
    // closes), so the message is durably persisted by the time the for-await
    // loop below exits.
    onFinish: async ({ responseMessage, isContinuation }) => {
      // Step-cap closing fallback (A): if the turn ended WITHOUT any text
      // part (circuit breaker tripped mid-tools, or the model ignored the
      // closing instruction), append a deterministic closing text so the
      // user never stares at a dangling tool result. Skipped when the
      // message carries an approval-requested tool part -- that is the
      // legitimate "waiting for user" terminal state, and the SDK must keep
      // assembling it (extra text would confuse the L2 resume pairing).
      const parts = (responseMessage as UIMessage).parts ?? [];
      const hasText = parts.some((p) => p?.type === 'text' && String((p as { text?: string }).text ?? '').trim().length > 0);
      const hasApprovalRequest = parts.some((p) => (p as { state?: string }).state === 'approval-requested');
      if (!hasText && !hasApprovalRequest && !abortSignal.aborted) {
        parts.push({
          type: 'text',
          text: '本轮对话已停止：工具调用连续失败或达到步数上限，未能生成完整回复。请稍后重试，或换一种问法分步提出请求。',
        } as unknown as (typeof parts)[number]);
      }
      if (isContinuation) {
        // Continuation run (L2 resume seeded from the approval-requested
        // assistant message): update that message IN PLACE — its tool part
        // flipped approval-requested -> output-available / output-denied and
        // the follow-up text was appended — instead of appending a duplicate
        // with the same id.
        await replaceMessage(sessionId, responseMessage);
      } else {
        await appendMessages(sessionId, [responseMessage]);
      }
    },
  });

  for await (const part of uiStream) {
    // await emit: the store persist is async on both backends; awaiting keeps
    // per-session seq assignment + SSE forwarding in stream order.
    await emit({ type: 'message.part', sessionId, part });
  }
}
