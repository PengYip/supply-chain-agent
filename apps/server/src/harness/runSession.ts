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

import type { ModelMessage, LanguageModel } from 'ai';
import { randomUUID } from 'node:crypto';
import { runStream, recordL2PendingFromResponse } from './agent.js';
import { appendMessages, setSessionTitle } from './sessionStore.js';
import { emit } from './sessionEvents.js';
import { generateSessionTitle, getTitleModel } from './titleGen.js';
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
}

/**
 * Defensively extract text from a message, handling BOTH shapes:
 *   - ModelMessage: `.content` is a string or an array of `{type:'text', text}` parts.
 *   - UIMessage (AI SDK 6 parts format): `.parts` is an array of `{type:'text', text}`.
 * Duplicated from routes/chat.ts pending Task 7b consolidation (chat.ts will
 * delegate to runSession and drop its own copy).
 */
function extractMessageText(msg: any): string {
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
  const { sessionId, role, messages, auditTraceId, abortSignal, userId, model, isFirstTurn, firstUserText } = opts;

  const result = await runStream({
    messages,
    role,
    auditTraceId,
    sessionId,
    userId,
    model,
    abortSignal,
  });

  // After the stream completes, record any L2 soft-gate approvals requested this
  // turn + fire title-gen on the first exchange. Same fire-and-forget pattern
  // chat.ts uses via result.response.then(...). result.response is a PromiseLike
  // (no .catch), so use the 2-arg .then. Migrated here so chat.ts can go
  // background in Task 7b without holding the result itself.
  result.response.then(
    async (r) => {
      try {
        recordL2PendingFromResponse(sessionId, r.messages);
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
    generateMessageId: randomUUID,
    onFinish: ({ responseMessage }) => {
      appendMessages(sessionId, [responseMessage]);
    },
  });

  for await (const part of uiStream) {
    emit({ type: 'message.part', sessionId, part });
  }
}
