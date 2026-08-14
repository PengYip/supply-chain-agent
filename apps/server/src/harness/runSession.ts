// Background run executor. Reuses runStream (full streamText config) but, instead
// of returning result.toUIMessageStreamResponse as an HTTP body, CONSUMES the
// result's UI message stream: each chunk is emitted to the session event bus,
// and the stream's onFinish persists the assistant UIMessage. This is the
// connection-decoupling core.
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
import { runStream } from './agent.js';
import { appendMessages, setSessionStatus } from './sessionStore.js';
import { emit } from './sessionEvents.js';
import type { Role } from './roleToolRegistry.js';

export interface RunSessionOpts {
  sessionId: string;
  userId?: string;
  role: Role;
  messages: ModelMessage[];
  auditTraceId: string;
  abortSignal: AbortSignal;
  model?: LanguageModel; // test seam
}

export async function runSession(opts: RunSessionOpts): Promise<void> {
  const { sessionId, role, messages, auditTraceId, abortSignal, userId, model } = opts;
  setSessionStatus(sessionId, 'busy', randomUUID());

  try {
    const result = await runStream({
      messages,
      role,
      auditTraceId,
      sessionId,
      userId,
      model,
      abortSignal,
    });

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
  } finally {
    setSessionStatus(sessionId, 'idle');
  }
}
