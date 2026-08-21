import { Hono } from 'hono';
import { randomUUID } from 'node:crypto';
import { convertToModelMessages, type ModelMessage, type UIMessage } from 'ai';
import { z } from 'zod';
import {
  getPending,
  resolveApproval,
  loadSession,
  appendMessages,
  sessionBelongsTo,
  getSessionStatus,
} from '../harness/sessionStore.js';
import { startSessionRun, isRunning } from '../harness/runManager.js';
import { runSession } from '../harness/runSession.js';
import type { Role } from '../harness/roleToolRegistry.js';
import type { AuthEnv } from '../lib/auth-middleware.js';

// Approval callbacks (L2 soft-gate / L3 human-review ticket) are fire-and-forget,
// symmetric with POST /api/chat: resolve the approval in the DB, then start a
// background resume run through RunManager. The resume output streams on the
// per-session SSE bus (GET /api/sessions/:id/events); this route never
// returns a model stream.
//
// Resume mechanics (verified against ai@6.0.246, see phase-4 spec §2): the
// L2 path appends a TRANSIENT role:'tool' message carrying a
// tool-approval-response part matching the persisted tool-approval-request;
// streamText re-pairs them at startup and re-executes the gated tool
// (approved) or feeds the model an execution-denied tool-result (denied).
// The L3 path has no SDK approval semantics: it persists a user instruction
// and reruns the full history. L3 tickets originate from escalate_to_human
// only (no system-internal money tools exist); an approved ticket resumes
// with a generic human-reviewed instruction.

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

  // requireAuth attaches the user; defensive re-check for direct-mount tests.
  const user = c.get('user');
  if (!user) return c.json({ error: 'unauthorized' }, 401);

  const pending = await getPending((ticketId ?? approvalId) as string);
  if (!pending) {
    return ticketId
      ? c.json({ error: 'ticket not found', ticketId }, 404)
      : c.json({ error: 'approval not found', approvalId }, 404);
  }

  const sessionId = pending.session_id;
  if (!(await sessionBelongsTo(sessionId, user.id))) {
    return c.json({ error: 'forbidden' }, 403);
  }

  // Idempotency guard: a replay of an already-resolved approval (same POST sent
  // again after the resume run completed) must not re-append the L3 instruction
  // or start a fresh run. Any subsequent callback for this id is a duplicate —
  // reject before ANY state change.
  if (pending.status !== 'pending') {
    return c.json({ error: 'approval_already_resolved', approvalResolved: true }, 409);
  }

  // Pre-check single-flight BEFORE touching any state: reject early with
  // approvalResolved=false (the pending row is untouched).
  if (isRunning(sessionId)) {
    return c.json(
      {
        error: 'session_busy',
        approvalResolved: false,
        activeRunId: (await getSessionStatus(sessionId))?.runId ?? null,
      },
      409,
    );
  }

  const session = await loadSession(sessionId);
  const role: Role = (session?.role ?? 'trader') as Role;
  const uiMessages = (session?.messages ?? []) as UIMessage[];
  const baseModelMessages = uiMessages.length > 0
    ? await convertToModelMessages(uiMessages)
    : ([] as ModelMessage[]);

  // Assemble the resume input. `extraModelMessages` carries one-shot messages
  // appended AFTER the persisted history:
  //  - L3: the just-persisted user instruction (also appended to the store).
  //  - L2: the transient tool-approval-response (never persisted).
  // `originalMessages` is the persisted UI history passed to the SDK's
  // continuation mode: for L2 its LAST message is the approval-requested
  // assistant message, so toUIMessageStream seeds assembly from it and the
  // re-executed tool result updates that message in place; for L3 its last
  // message is the just-appended user instruction (new-message behavior).
  const extraModelMessages: ModelMessage[] = [];
  let originalMessages: UIMessage[] = uiMessages;

  if (ticketId) {
    let instruction: string;
    if (!approved) {
      instruction =
        `外部审批已拒绝（票据 ${ticketId}，理由：${reason ?? '用户拒绝'}）。` +
        `请告知用户该操作未执行，并停止该操作的后续尝试。`;
    } else {
      instruction =
        `人工已复核工单 ${ticketId}（理由：${reason ?? '已处理'}）。` +
        `请根据人工判断继续处理用户之前的请求。如果人工反馈解决了不确定性，请直接回答用户；如果需要执行后续操作，请继续。`;
    }
    const instructionUIMsg = {
      id: randomUUID(),
      role: 'user',
      parts: [{ type: 'text', text: instruction }],
    } as UIMessage;
    await appendMessages(sessionId, [instructionUIMsg]);
    extraModelMessages.push({ role: 'user', content: instruction });
    originalMessages = [...uiMessages, instructionUIMsg];
  } else {
    // L2 resume message: role:'tool' has NO valid UIMessage form, so this is
    // TRANSIENT — passed into this resume turn only, never persisted. The TS
    // ToolContent union only models tool-result parts, hence the cast.
    const id = approvalId as string;
    extraModelMessages.push({
      role: 'tool',
      content: [
        {
          type: 'tool-approval-response',
          approvalId: id,
          toolCallId: pending.tool_call_id ?? id,
          approved,
          reason: reason ?? (approved ? '用户已确认' : '用户已拒绝'),
        },
      ],
    } as unknown as ModelMessage);
  }

  // DB state first: the decision is durable even if the run fails to start
  // or errors later.
  await resolveApproval(pending.id, approved ? 'approved' : 'denied');

  console.log(
    JSON.stringify({
      event: ticketId ? 'approval_authorized' : 'approval_l2_resolved',
      id: pending.id,
      approved,
      sessionId,
    }),
  );

  const messages: ModelMessage[] = [...baseModelMessages, ...extraModelMessages];
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

  const start = await startSessionRun(sessionId, user.id, role, (signal) =>
    runSession({
      sessionId,
      userId: user.id,
      role,
      messages,
      auditTraceId,
      abortSignal: signal,
      isFirstTurn: false,
      // Resume runs skip <agent_status> injection: the transient trailing
      // role:'tool' tool-approval-response (L2) must remain the LAST message
      // for SDK collectToolApprovals pairing, and the approval was just
      // resolved — a stale status block could mislead the model.
      skipStatusMessage: true,
      // Continuation mode: the persisted UI history (L2: ends with the
      // approval-requested assistant message -> SDK continues it in place;
      // L3: ends with the appended user instruction -> new message).
      originalMessages,
    }),
  );

  if ('conflict' in start) {
    // Narrow race: the pre-check passed, but another run grabbed the slot
    // while we awaited convertToModelMessages. The approval IS resolved;
    // only the resume did not start. The user's next message naturally
    // resumes the conversation.
    return c.json(
      {
        error: 'session_busy',
        approvalResolved: true,
        activeRunId: (await getSessionStatus(sessionId))?.runId ?? null,
      },
      409,
    );
  }

  return c.json(
    { ok: true, status: approved ? 'approved' : 'denied', sessionId, runId: start.runId },
    { status: 200, headers: { 'x-session-id': sessionId } },
  );
});
