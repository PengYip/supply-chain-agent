import { Hono } from 'hono';
import { randomUUID } from 'node:crypto';
import { convertToModelMessages, type ModelMessage } from 'ai';
import { z } from 'zod';
import { runStream, recordL2PendingFromResponse } from '../harness/agent.js';
import type { Role } from '../harness/roleToolRegistry.js';
import {
  createSession,
  loadSession,
  appendMessages,
  sessionBelongsTo,
} from '../harness/sessionStore.js';
import { setSessionContext } from '../harness/sessionContext.js';
import type { AuthEnv } from '../lib/auth-middleware.js';

export const chatRoute = new Hono<AuthEnv>();

// AI SDK 6 `useChat` posts UIMessages in the `parts` format
// ({ id, role, parts: [...] }), NOT the legacy { role, content: string }.
// Be permissive here and let `convertToModelMessages` do the real validation.
const BodySchema = z.object({
  messages: z.array(z.any()).min(1),
  role: z.enum(['trader']).default('trader'),
});

function isModelNotFound(message: string): boolean {
  return /model not found|model .* does not exist|invalid model|unknown model/i.test(
    message,
  );
}

chatRoute.post('/chat', async (c) => {
  let json: unknown;
  try {
    json = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  const parsed = BodySchema.safeParse(json);
  if (!parsed.success) {
    return c.json(
      { error: 'Invalid request body', detail: parsed.error.flatten() },
      400,
    );
  }

  const { messages, role } = parsed.data;

  // Session: reuse x-session-id if it exists AND belongs to the authenticated
  // user (Phase 2 data isolation), else create a new one owned by the user.
  // Sets the request context so L3 tool execute can attribute pending tickets.
  const user = c.get('user');
  const userId = user?.id ?? null;
  const headerId = c.req.header('x-session-id');
  const candidate = headerId && userId ? (sessionBelongsTo(headerId, userId) ? loadSession(headerId) : null) : null;
  const loaded = headerId && !userId ? loadSession(headerId) : candidate;
  const sessionId = loaded?.id ?? createSession(role as Role, userId).id;
  const priorMessages = loaded?.messages ?? [];
  setSessionContext(sessionId);

  const auditTraceId = randomUUID();
  console.log(
    JSON.stringify({
      event: 'chat_request',
      traceId: auditTraceId,
      role,
      sessionId,
      resumed: loaded != null,
    }),
  );

  // Convert incoming UIMessages -> model messages and persist the user input.
  let newModelMessages: ModelMessage[];
  try {
    newModelMessages = (await convertToModelMessages(messages)) as ModelMessage[];
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return c.json({ error: 'Failed to convert messages', detail: msg }, 400);
  }
  appendMessages(sessionId, newModelMessages);

  try {
    const result = runStream({
      messages: [...priorMessages, ...newModelMessages],
      role: role as Role,
      auditTraceId,
    });

    // After the stream completes, persist the assistant response messages and
    // record any L2 soft-gate approvals that were requested this turn.
    // `result.response` is a PromiseLike (no .catch), so use the 2-arg .then.
    result.response.then(
      (r) => {
        try {
          appendMessages(sessionId, r.messages);
          recordL2PendingFromResponse(sessionId, r.messages);
        } catch (err) {
          console.error('[chat] persist failed:', err instanceof Error ? err.message : err);
        }
      },
      () => {
        /* stream errors surface via onError below */
      },
    );

    const streamResp = result.toUIMessageStreamResponse({
      onError: (error: unknown) => {
        const msg = error instanceof Error ? error.message : String(error);
        console.error('[chat] streamText error:', msg);
        if (isModelNotFound(msg)) {
          return `Model "${process.env.OPENAI_MODEL ?? ''}" was rejected by the provider (${msg}). Try OPENAI_MODEL=deepseek-chat.`;
        }
        return msg;
      },
    });

    // Return the stream with the session id so the client can resume.
    return new Response(streamResp.body, {
      status: streamResp.status,
      headers: { ...streamResp.headers, 'x-session-id': sessionId },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[chat] setup error:', msg);
    return c.json({ error: 'Chat stream failed', detail: msg }, 500);
  }
});
