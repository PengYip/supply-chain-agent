import { Hono } from 'hono';
import { randomUUID } from 'node:crypto';
import type { ModelMessage } from 'ai';
import { z } from 'zod';
import { runStream, recordL2PendingFromResponse } from '../harness/agent.js';
import {
  getPending,
  resolveApproval,
  addAuthorizedTicket,
  loadSession,
  appendMessages,
  sessionBelongsTo,
} from '../harness/sessionStore.js';
import { setSessionContext } from '../harness/sessionContext.js';
import type { Role } from '../harness/roleToolRegistry.js';
import type { AuthEnv } from '../lib/auth-middleware.js';

export const approvalCallback = new Hono<AuthEnv>();

const CallbackSchema = z
  .object({
    ticketId: z.string().optional(),
    approvalId: z.string().optional(),
    approved: z.boolean(),
    reason: z.string().optional(),
  })
  .refine((v) => v.ticketId || v.approvalId, {
    message: 'ticketId (L3) or approvalId (L2) is required',
  });

function isModelNotFound(message: string): boolean {
  return /model not found|model .* does not exist|invalid model|unknown model/i.test(
    message,
  );
}

// Resume a session: re-run the agent over the full persisted history (including
// the message the caller just appended) and return the stream. Persists the
// assistant response and records any new L2 pending approvals when done.
function resumeSession(sessionId: string): Response {
  setSessionContext(sessionId);
  const session = loadSession(sessionId);
  const role: Role = (session?.role ?? 'trader') as Role;
  const messages = session?.messages ?? [];
  const auditTraceId = randomUUID();
  console.log(
    JSON.stringify({
      event: 'approval_resume',
      traceId: auditTraceId,
      sessionId,
      role,
      historyLen: messages.length,
    }),
  );

  const result = runStream({ messages, role, auditTraceId });
  // `result.response` is a PromiseLike (no .catch), so use the 2-arg .then.
  result.response.then(
    (r) => {
      try {
        appendMessages(sessionId, r.messages);
        recordL2PendingFromResponse(sessionId, r.messages);
      } catch (err) {
        console.error(
          '[approval] persist failed:',
          err instanceof Error ? err.message : err,
        );
      }
    },
    () => {},
  );

  const resp = result.toUIMessageStreamResponse({
    onError: (error: unknown) => {
      const msg = error instanceof Error ? error.message : String(error);
      console.error('[approval] streamText error:', msg);
      if (isModelNotFound(msg)) {
        return `Model rejected by provider (${msg}). Try OPENAI_MODEL=deepseek-chat.`;
      }
      return msg;
    },
  });
  return new Response(resp.body, {
    status: resp.status,
    headers: { ...resp.headers, 'x-session-id': sessionId },
  });
}

// Mock 飞书 webhook. Two paths:
//  - L3 (ticketId): mark ticket authorized, append a user instruction telling
//    the model to re-run create_payment with authorizedTicketId, resume.
//  - L2 (approvalId): append a tool-approval-response message that matches the
//    prior tool-approval-request, resume (the SDK then runs the gated execute).
approvalCallback.post('/approval/callback', async (c) => {
  let json: unknown;
  try {
    json = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  const parsed = CallbackSchema.safeParse(json);
  if (!parsed.success) {
    return c.json(
      { error: 'Invalid request body', detail: parsed.error.flatten() },
      400,
    );
  }

  const { ticketId, approvalId, approved, reason } = parsed.data;

  // Phase 2 ownership gate: the authenticated user must own the session the
  // pending approval belongs to. /api/approval/* is requireAuth-gated in
  // index.ts, so a user is always attached here. External systems that need to
  // post webhooks without a user session would use a separate, separately-
  // authenticated route (not this one).
  const user = c.get('user');
  const assertOwnership = (sessionId: string): Response | null => {
    if (!user) return c.json({ error: 'unauthorized' }, 401);
    if (!sessionBelongsTo(sessionId, user.id)) {
      return c.json({ error: 'forbidden' }, 403);
    }
    return null;
  };

  // ---- L3: external approval ticket ----
  if (ticketId) {
    const pending = getPending(ticketId);
    if (!pending) {
      return c.json({ error: 'ticket not found', ticketId }, 404);
    }
    const forbidden = assertOwnership(pending.session_id);
    if (forbidden) return forbidden;
    resolveApproval(ticketId, approved ? 'approved' : 'denied');
    if (!approved) {
      return c.json({ ok: false, status: 'denied', ticketId });
    }
    addAuthorizedTicket(ticketId, pending.session_id);
    const instruction =
      `外部审批已通过（票据 ${ticketId}，理由：${reason ?? '财务已审批'}）。` +
      `请立即调用 create_payment 并传入 authorizedTicketId=${ticketId} 续跑付款以真正执行。`;
    appendMessages(pending.session_id, [
      { role: 'user', content: instruction } as ModelMessage,
    ]);
    console.log(
      JSON.stringify({
        event: 'approval_authorized',
        ticketId,
        sessionId: pending.session_id,
      }),
    );
    return resumeSession(pending.session_id);
  }

  // ---- L2: inline soft-gate approval ----
  const id = approvalId as string;
  const pending = getPending(id);
  if (!pending) {
    return c.json({ error: 'approval not found', approvalId: id }, 404);
  }
  {
    const forbidden = assertOwnership(pending.session_id);
    if (forbidden) return forbidden;
  }
  resolveApproval(id, approved ? 'approved' : 'denied');
  if (!approved) {
    return c.json({ ok: false, status: 'denied', approvalId: id });
  }
  // v6 resume message: a tool message whose content carries a
  // tool-approval-response part matching the prior tool-approval-request's
  // approvalId. The TS ToolContent union only models tool-result parts, so the
  // approval-response part is cast through unknown.
  const toolCallId = pending.tool_call_id ?? id;
  const resumeMessage = {
    role: 'tool',
    content: [
      {
        type: 'tool-approval-response',
        approvalId: id,
        toolCallId,
        approved: true,
        reason: reason ?? '用户已确认',
      },
    ],
  } as unknown as ModelMessage;
  appendMessages(pending.session_id, [resumeMessage]);
  console.log(
    JSON.stringify({
      event: 'approval_l2_resolved',
      approvalId: id,
      sessionId: pending.session_id,
    }),
  );
  return resumeSession(pending.session_id);
});
