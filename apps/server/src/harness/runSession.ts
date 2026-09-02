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
import { classifyProviderError } from './providerErrors.js';
import { fetchDeepseekBalance, formatDeepseekBalance } from './deepseekBalance.js';
import { env } from '../env.js';
import type { Role } from './roleToolRegistry.js';

// Closing fallback texts for turns that end without any model text. They are
// DIFFERENTIATED (incident 2026-09-02): the tools/step-cap text must only be
// shown when the message actually contains tool parts -- a provider call that
// failed before producing any chunk leaves a ZERO-part message, and blaming
// tools/step-cap there is misleading.
const TOOLS_STOP_FALLBACK_TEXT =
  '本轮对话已停止：工具调用连续失败或达到步数上限，未能生成完整回复。请稍后重试，或换一种问法分步提出请求。';
const API_FAILURE_FALLBACK_TEXT =
  '本轮对话已停止：模型服务调用失败，请稍后重试(错误已记录，可联系管理员查看用量审计)。';

/**
 * Classified one-line diagnostic for a terminal stream error, used both for
 * the llm_calls `error` column and the pm2 console.error line. Format:
 * `<provider-code|error-name|stream_error>[ status=<code>]: <message>` -- the
 * provider status code is preserved so the audit page can tell a 402 arrears
 * from a 5xx outage without re-fetching anything.
 */
export function describeStreamError(err: unknown): string {
  const e = err as
    | { name?: string; message?: string; statusCode?: number; status?: number }
    | undefined;
  const message =
    typeof e?.message === 'string' && e.message.trim().length > 0
      ? e.message
      : String(err ?? 'unknown error');
  const status = e?.statusCode ?? e?.status;
  const provider = classifyProviderError(err);
  const tag = provider.code ?? (e?.name ? e.name : 'stream_error');
  const statusPart = typeof status === 'number' ? ` status=${status}` : '';
  return `${tag}${statusPart}: ${message.slice(0, 300)}`;
}

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

  // Audit model identity shared by the ok/error llm_calls rows this turn.
  const auditModel = model ? String((model as { modelId?: string }).modelId ?? '') : env.OPENAI_MODEL;
  // Best-effort ERROR audit for failed turns. recordLlmCall is fail-open
  // (never throws), so no extra guard is needed around call sites.
  const auditStreamError = (errorText: string) => {
    recordLlmCall({
      sessionId,
      userId,
      kind: 'chat',
      model: auditModel,
      inputText: auditInputText,
      durationMs: Date.now() - auditT0,
      status: 'error',
      error: errorText,
    });
  };
  // Diagnostic line for pm2 logs on every failed turn (incident 2026-09-02:
  // the failure was previously invisible -- no audit row, no log line).
  const logStreamError = (errorText: string) => {
    console.error(JSON.stringify({ event: 'chat_stream_error', sessionId, error: errorText }));
  };
  // Arrears follow-up (dual-provider work 2026-09-02): when the failed turn
  // classifies as provider_arrears, fire-and-forget a DeepSeek balance
  // re-check so pm2 logs show the actual balance next to the error diagnostic.
  // Fault-isolated: fetchDeepseekBalance never throws (resolves null on any
  // skip condition) and the .catch swallows the rest. Never blocks the run.
  const recheckBalanceIfArrears = (raw: unknown) => {
    if (classifyProviderError(raw).code !== 'provider_arrears') return;
    void fetchDeepseekBalance()
      .then((b) => {
        if (!b) return;
        console.error(`[runSession] DeepSeek 余额复查: ${formatDeepseekBalance(b)} (sessionId=${sessionId})`);
      })
      .catch(() => {});
  };

  // Raw error of the terminal stream failure, captured via runStream's
  // onStreamError seam (streamText onError: invoked ONLY for terminal error
  // parts, never for non-fatal tool errors). The UI message stream only
  // carries the formatted errorText, so the raw error is stashed here for
  // classifyProviderError (statusCode/responseBody) at onFinish time.
  let streamError: unknown = null;
  // Set when the consumed UI stream actually delivered a terminal error part
  // (the in-band signal). Guarantees at most ONE error audit per turn even if
  // the outer catch below also fires.
  let streamFailed = false;

  try {
    const result = await runStream({
      messages,
      role,
      auditTraceId,
      sessionId,
      userId,
      model,
      abortSignal,
      skipStatusMessage,
      onStreamError: (error) => {
        streamError = error;
      },
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
        /* stream errors are audited on the in-band error part / outer catch below */
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
            model: auditModel,
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
            model: auditModel,
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
        /* stream errors are audited on the in-band error part / outer catch below */
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
      // Surface the CLASSIFIED error in the stream's errorText (and thus to
      // SSE clients) instead of the SDK default 'An error occurred.'.
      onError: describeStreamError,
      // Async since the session store went dual-backend (SQLite/Postgres). The
      // SDK awaits onFinish during the stream's flush (before the stream
      // closes), so the message is durably persisted by the time the for-await
      // loop below exits. NOTE (ai@6.0.259, handleUIMessageStreamFinish):
      // onFinish ALSO runs after a terminal error part -- the error chunk
      // itself creates NO message part, so a provider call that failed before
      // any chunk yields a zero-part responseMessage here.
      onFinish: async ({ responseMessage, isContinuation }) => {
        // Closing fallback (A): if the turn ended WITHOUT any text
        // part (circuit breaker tripped mid-tools, or the model ignored the
        // closing instruction), append a deterministic closing text so the
        // user never stares at a dangling tool result. Skipped when the
        // message carries an approval-requested tool part -- that is the
        // legitimate "waiting for user" terminal state, and the SDK must keep
        // assembling it (extra text would confuse the L2 resume pairing).
        const parts = (responseMessage as UIMessage).parts ?? [];
        const hasText = parts.some((p) => p?.type === 'text' && String((p as { text?: string }).text ?? '').trim().length > 0);
        const hasApprovalRequest = parts.some((p) => (p as { state?: string }).state === 'approval-requested');
        // Tool parts (type `tool-<name>` / `dynamic-tool`) mark the
        // tools/step-cap scenario the old fallback text describes. Their
        // absence with no text = the model produced nothing, i.e. the
        // API/stream-failure signature.
        const hasToolParts = parts.some((p) => {
          const t = (p as { type?: string }).type;
          return t === 'dynamic-tool' || (typeof t === 'string' && t.startsWith('tool-'));
        });
        if (!hasText && !hasApprovalRequest && !abortSignal.aborted) {
          const providerInfo = streamFailed ? classifyProviderError(streamError) : null;
          parts.push({
            type: 'text',
            text: hasToolParts
              ? TOOLS_STOP_FALLBACK_TEXT
              : providerInfo?.userMessage ?? API_FAILURE_FALLBACK_TEXT,
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
      if (part.type === 'error') {
        // Terminal in-band stream error (ai@6.0.259: streamText converts
        // internal failures into an `{type:'error'}` fullStream part, and
        // toUIMessageStream forwards it as `{type:'error', errorText}` --
        // nothing is thrown and onFinish still runs). Audit + log here, then
        // keep emitting so SSE clients see the error part too. streamFailed
        // switches the onFinish closing text to the API-failure variant.
        streamFailed = true;
        auditStreamError(part.errorText);
        logStreamError(part.errorText);
        recheckBalanceIfArrears(streamError);
      }
      // await emit: the store persist is async on both backends; awaiting keeps
      // per-session seq assignment + SSE forwarding in stream order.
      await emit({ type: 'message.part', sessionId, part });
    }
  } catch (err) {
    // Failure that did NOT surface as an in-band error part: runStream threw
    // before the stream started (e.g. prompt assembly / MissingToolResultsError)
    // or the UI stream assembly itself threw mid-consumption. Audit + log, then
    // rethrow UNCHANGED -- RunManager's wrapper owns the run.error event and
    // the busy->idle reset.
    if (!abortSignal.aborted && !streamFailed) {
      const errorText = describeStreamError(err);
      auditStreamError(errorText);
      logStreamError(errorText);
      recheckBalanceIfArrears(err);
    }
    throw err;
  }
}
