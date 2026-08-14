# Approval Decoupling (Phase 4) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate L2/L3 approval callbacks onto the background run runtime (RunManager + runSession + SSE), delete the legacy sessionContext single-slot, and adapt the frontend to fire-and-forget approval posts.

**Architecture:** `POST /api/approval/callback` becomes symmetric with `POST /api/chat`: validate → pre-check single-flight → assemble resume input (persisted history + transient L2 `tool-approval-response`) → `resolveApproval` (DB first) → `startSessionRun(runSession)` → return `{runId}`. Resume output streams over the existing SSE bus. The synchronous `toUIMessageStreamResponse` path and the legacy single-slot are deleted.

**Tech Stack:** Hono, AI SDK 6 (ai@6.0.246), vitest, React 19.

**Spec:** `docs/superpowers/specs/2026-08-14-approval-decoupling-design.md` (commit 55abedb)

## Global Constraints

- Work in git worktree `D:\Users\yepeng\supply-chain-bg-runtime`, branch `feat/approval-decoupling`. Never touch the main checkout.
- AI SDK 6 only: `inputSchema` (not parameters), `convertToModelMessages` (async), resume via transient `role:'tool'` + `tool-approval-response` ModelMessage (never persisted, has no UIMessage form).
- No emoji in code or comments.
- Test command: `npm test --workspace apps/server -- test/harness/<file>.test.ts` (run from worktree root). Full CI-equivalent run: `DATABASE_URL= npm test --workspace apps/server` (local .env has a DATABASE_URL that flips 2 unrelated Postgres FTS tests — blank it to match CI).
- Required order before claiming done: build (`npm run build`) → lint (`npm run lint`) → test.
- SessionStore is a shared file DB (`data/agent.db`): every test uses unique session/approval/ticket ids (`randomUUID()` suffix) — never fixed ids across runs.
- Commit only the files a task touched; leave unrelated modified/untracked files alone.
- Tool permission SSOT: `permissionGate.ts` — L2 set includes `tag_document` (safe, pure SQLite); `create_entity`/`link_entities`/`graph_query` need Neo4j — never drive them in tests.

## File Structure

| Task | File | Responsibility |
|---|---|---|
| A | `apps/server/src/routes/approvalCallback.ts` (rewrite), `apps/server/test/harness/approvalCallbackBackground.test.ts` (new) | HTTP contract: fire-and-forget + 409 + ownership + instruction append |
| B | `apps/server/test/harness/approvalResume.runtime.test.ts` (new) | SDK gate/resume semantics via real runStream/runSession (I-1 verification) |
| C | `apps/server/src/harness/sessionContext.ts` (simplify), `apps/server/test/harness/sessionContext.test.ts` (update) | ALS-only session context |
| D | `apps/web/src/components/RealChatView.tsx` (edit) | postApproval pure-fetch + 409 handling |
| E | — | Manual acceptance + full regression + whole-branch review |

---

### Task A: approvalCallback background rewrite (HTTP contract)

**Files:**
- Modify: `apps/server/src/routes/approvalCallback.ts` (full rewrite, 232 lines → ~160)
- Test: `apps/server/test/harness/approvalCallbackBackground.test.ts` (new)

**Interfaces:**
- Consumes (verified signatures):
  - `startSessionRun(sessionId: string, userId: string | undefined, role: string, fn: (signal: AbortSignal) => Promise<void>): { runId: string } | { conflict: true }` (`harness/runManager.ts:22`)
  - `isRunning(sessionId: string): boolean` (`harness/runManager.ts:73`)
  - `runSession(opts: RunSessionOpts): Promise<void>`; `RunSessionOpts = { sessionId: string; userId?: string; role: Role; messages: ModelMessage[]; auditTraceId: string; abortSignal: AbortSignal; model?: LanguageModel; isFirstTurn?: boolean; firstUserText?: string }` (`harness/runSession.ts:33`)
  - `getPending(id: string): PendingApprovalRow | null`; `PendingApprovalRow = { id, session_id, level, tool_name, tool_call_id: string | null, input_json, ticket_id, approval_id, status, created_at }` (`harness/sessionStore.ts:117,415`)
  - `resolveApproval(id: string, status: 'pending'|'approved'|'denied'): void`; `addAuthorizedTicket(ticketId: string, sessionId: string): void`; `isAuthorized(ticketId: string, sessionId: string): boolean`; `recordPendingApproval(input: { sessionId, level, toolName, toolCallId?, input, ticketId?, approvalId? }): void`; `createSession(role, userId?)`; `loadSession(id)`; `appendMessages(sessionId, msgs: UIMessage[])`; `sessionBelongsTo(id, userId)`; `getSessionStatus(sessionId)`
- Produces: HTTP contract `POST /api/approval/callback` → `200 {ok:true, status:'approved'|'denied', sessionId, runId}` (+`x-session-id` header) | `409 {error:'session_busy', approvalResolved:boolean, activeRunId}` | `404` | `403` | `401` | `400`

- [ ] **Step 1: Write the failing tests**

Create `apps/server/test/harness/approvalCallbackBackground.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import type { AuthEnv } from '../../src/lib/auth-middleware.js';

// Same resolve-holder pattern as chatBackground.test.ts: the stubbed runSession
// blocks until the test releases it, keeping the RunManager slot "busy" when
// a test needs an in-flight run.
const { runResolve } = vi.hoisted(() => ({
  runResolve: { current: (() => {}) } as { current: () => void },
}));

vi.mock('../../src/harness/runSession.js', () => ({
  runSession: vi.fn(
    () => new Promise<void>((r) => { runResolve.current = r; }),
  ),
}));

const { approvalCallback } = await import('../../src/routes/approvalCallback.js');
const {
  createSession,
  appendMessages,
  loadSession,
  getPending,
  isAuthorized,
  recordPendingApproval,
} = await import('../../src/harness/sessionStore.js');
const { runSession } = await import('../../src/harness/runSession.js');
const { startSessionRun } = await import('../../src/harness/runManager.js');

function appAs(userId: string) {
  const app = new Hono<AuthEnv>();
  app.use('*', async (c, next) => {
    c.set('user', { id: userId, email: 't@t', role: 'trader' } as any);
    await next();
  });
  app.route('/api', approvalCallback);
  return app;
}

const post = (app: Hono<AuthEnv>, body: unknown) =>
  app.request('http://test/api/approval/callback', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

// Shared file DB: unique ids per run.
const uid = (p: string) => `${p}-${randomUUID().slice(0, 8)}`;

const userMsg = (text: string) => ({
  id: randomUUID(),
  role: 'user',
  parts: [{ type: 'text', text }],
});

describe('POST /api/approval/callback (background runtime)', () => {
  beforeEach(() => {
    runResolve.current = () => {};
    (runSession as ReturnType<typeof vi.fn>).mockClear();
  });

  it('L2 approve: starts a background resume run and returns {ok, status, sessionId, runId}', async () => {
    const s = createSession('trader', 'u-a1');
    appendMessages(s.id, [userMsg('hi') as any]);
    const aid = uid('appr');
    recordPendingApproval({
      sessionId: s.id, level: 'L2', toolName: 'tag_document',
      toolCallId: 'call_x', input: {}, approvalId: aid,
    });

    const res = await post(appAs('u-a1'), { approvalId: aid, approved: true });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.status).toBe('approved');
    expect(json.sessionId).toBe(s.id);
    expect(json.runId).toBeTruthy();
    expect(res.headers.get('x-session-id')).toBe(s.id);

    // DB state flipped synchronously, before/independent of the run.
    expect(getPending(aid)?.status).toBe('approved');

    // runSession got the transient tool-approval-response as the LAST message.
    expect(runSession).toHaveBeenCalledTimes(1);
    const opts = (runSession as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const last = opts.messages[opts.messages.length - 1];
    expect(last.role).toBe('tool');
    const part = (last.content as any[])[0];
    expect(part.type).toBe('tool-approval-response');
    expect(part.approvalId).toBe(aid);
    expect(part.toolCallId).toBe('call_x');
    expect(part.approved).toBe(true);

    // The transient message was NOT persisted: history still ends with the user msg.
    const loaded = loadSession(s.id)!;
    expect(loaded.messages[loaded.messages.length - 1].role).toBe('user');
    runResolve.current();
  });

  it('L2 deny: also starts a resume run with approved:false and default reason', async () => {
    const s = createSession('trader', 'u-a2');
    const aid = uid('appr');
    recordPendingApproval({
      sessionId: s.id, level: 'L2', toolName: 'tag_document',
      toolCallId: 'call_y', input: {}, approvalId: aid,
    });

    const res = await post(appAs('u-a2'), { approvalId: aid, approved: false });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.status).toBe('denied');
    expect(getPending(aid)?.status).toBe('denied');
    expect(runSession).toHaveBeenCalledTimes(1);
    const opts = (runSession as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const part = (opts.messages[opts.messages.length - 1].content as any[])[0];
    expect(part.approved).toBe(false);
    expect(part.reason).toBe('用户已拒绝');
    runResolve.current();
  });

  it('L3 approve (create_payment): appends instruction with authorizedTicketId, authorizes ticket, starts run', async () => {
    const s = createSession('trader', 'u-a3');
    const tid = uid('T');
    recordPendingApproval({
      sessionId: s.id, level: 'L3', toolName: 'create_payment',
      input: {}, ticketId: tid,
    });

    const res = await post(appAs('u-a3'), { ticketId: tid, approved: true });
    expect(res.status).toBe(200);
    expect(getPending(tid)?.status).toBe('approved');
    expect(isAuthorized(tid, s.id)).toBe(true);

    const loaded = loadSession(s.id)!;
    const lastMsg = loaded.messages[loaded.messages.length - 1];
    expect(lastMsg.role).toBe('user');
    const text = JSON.stringify(lastMsg);
    expect(text).toContain('create_payment');
    expect(text).toContain(`authorizedTicketId=${tid}`);

    // The instruction is ALSO in the model messages handed to runSession.
    const opts = (runSession as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const lastModel = opts.messages[opts.messages.length - 1];
    expect(lastModel.role).toBe('user');
    expect(JSON.stringify(lastModel)).toContain(`authorizedTicketId=${tid}`);
    runResolve.current();
  });

  it('L3 approve (escalate_to_human): appends the generic human-review instruction', async () => {
    const s = createSession('trader', 'u-a4');
    const tid = uid('T');
    recordPendingApproval({
      sessionId: s.id, level: 'L3', toolName: 'escalate_to_human',
      input: {}, ticketId: tid,
    });

    const res = await post(appAs('u-a4'), { ticketId: tid, approved: true });
    expect(res.status).toBe(200);
    const loaded = loadSession(s.id)!;
    const text = JSON.stringify(loaded.messages[loaded.messages.length - 1]);
    expect(text).toContain('人工已复核');
    expect(text).not.toContain('authorizedTicketId');
    runResolve.current();
  });

  it('L3 deny: appends deny instruction, does NOT authorize the ticket, still resumes', async () => {
    const s = createSession('trader', 'u-a5');
    const tid = uid('T');
    recordPendingApproval({
      sessionId: s.id, level: 'L3', toolName: 'create_payment',
      input: {}, ticketId: tid,
    });

    const res = await post(appAs('u-a5'), { ticketId: tid, approved: false });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.status).toBe('denied');
    expect(isAuthorized(tid, s.id)).toBe(false);
    const loaded = loadSession(s.id)!;
    const text = JSON.stringify(loaded.messages[loaded.messages.length - 1]);
    expect(text).toContain('已拒绝');
    expect(runSession).toHaveBeenCalledTimes(1);
    runResolve.current();
  });

  it('returns 409 session_busy (approvalResolved:false) when a run is in-flight; DB untouched', async () => {
    const s = createSession('trader', 'u-a6');
    const aid = uid('appr');
    recordPendingApproval({
      sessionId: s.id, level: 'L2', toolName: 'tag_document',
      input: {}, approvalId: aid,
    });

    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    startSessionRun(s.id, 'u-a6', 'trader', () => gate);

    const res = await post(appAs('u-a6'), { approvalId: aid, approved: true });
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.error).toBe('session_busy');
    expect(json.approvalResolved).toBe(false);
    expect(getPending(aid)?.status).toBe('pending');
    expect(runSession).not.toHaveBeenCalled();
    release();
  });

  it('returns 404 for unknown ids and 403 for non-owners', async () => {
    const res404 = await post(appAs('u-a7'), { approvalId: 'nope-' + randomUUID().slice(0, 6), approved: true });
    expect(res404.status).toBe(404);

    const s = createSession('trader', 'u-owner');
    const aid = uid('appr');
    recordPendingApproval({
      sessionId: s.id, level: 'L2', toolName: 'tag_document',
      input: {}, approvalId: aid,
    });
    const res403 = await post(appAs('u-other'), { approvalId: aid, approved: true });
    expect(res403.status).toBe(403);
    expect(getPending(aid)?.status).toBe('pending');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test --workspace apps/server -- test/harness/approvalCallbackBackground.test.ts`
Expected: FAIL — old route returns a UIMessageStream (not JSON `{ok,...}`), so `json.ok`/`json.runId` assertions fail; 409 test fails with old behavior.

- [ ] **Step 3: Rewrite approvalCallback.ts**

Replace the ENTIRE file content with:

```ts
import { Hono } from 'hono';
import { randomUUID } from 'node:crypto';
import { convertToModelMessages, type ModelMessage, type UIMessage } from 'ai';
import { z } from 'zod';
import {
  getPending,
  resolveApproval,
  addAuthorizedTicket,
  loadSession,
  appendMessages,
  sessionBelongsTo,
  getSessionStatus,
} from '../harness/sessionStore.js';
import { startSessionRun, isRunning } from '../harness/runManager.js';
import { runSession } from '../harness/runSession.js';
import type { Role } from '../harness/roleToolRegistry.js';
import type { AuthEnv } from '../lib/auth-middleware.js';

// Approval callbacks (L2 soft-gate / L3 external ticket) are fire-and-forget,
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
// and reruns the full history.

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

  const pending = getPending((ticketId ?? approvalId) as string);
  if (!pending) {
    return ticketId
      ? c.json({ error: 'ticket not found', ticketId }, 404)
      : c.json({ error: 'approval not found', approvalId }, 404);
  }

  const sessionId = pending.session_id;
  if (!sessionBelongsTo(sessionId, user.id)) {
    return c.json({ error: 'forbidden' }, 403);
  }

  // Pre-check single-flight BEFORE touching any state: reject early with
  // approvalResolved=false (the pending row is untouched).
  if (isRunning(sessionId)) {
    return c.json(
      {
        error: 'session_busy',
        approvalResolved: false,
        activeRunId: getSessionStatus(sessionId)?.runId ?? null,
      },
      409,
    );
  }

  const session = loadSession(sessionId);
  const role: Role = (session?.role ?? 'trader') as Role;
  const uiMessages = (session?.messages ?? []) as UIMessage[];
  const baseModelMessages = uiMessages.length > 0
    ? await convertToModelMessages(uiMessages)
    : ([] as ModelMessage[]);

  // Assemble the resume input. `extraModelMessages` carries one-shot messages
  // appended AFTER the persisted history:
  //  - L3: the just-persisted user instruction (also appended to the store).
  //  - L2: the transient tool-approval-response (never persisted).
  const extraModelMessages: ModelMessage[] = [];

  if (ticketId) {
    let instruction: string;
    if (!approved) {
      instruction =
        `外部审批已拒绝（票据 ${ticketId}，理由：${reason ?? '用户拒绝'}）。` +
        `请告知用户该操作未执行，并停止该操作的后续尝试。`;
    } else if (pending.tool_name === 'escalate_to_human') {
      instruction =
        `人工已复核工单 ${ticketId}（理由：${reason ?? '已处理'}）。` +
        `请根据人工判断继续处理用户之前的请求。如果人工反馈解决了不确定性，请直接回答用户；如果需要执行后续操作，请继续。`;
    } else {
      instruction =
        `外部审批已通过（票据 ${ticketId}，理由：${reason ?? '财务已审批'}）。` +
        `请立即调用 create_payment 并传入 authorizedTicketId=${ticketId} 续跑付款以真正执行。`;
    }
    appendMessages(sessionId, [
      { id: randomUUID(), role: 'user', parts: [{ type: 'text', text: instruction }] } as UIMessage,
    ]);
    extraModelMessages.push({ role: 'user', content: instruction });
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
  resolveApproval(pending.id, approved ? 'approved' : 'denied');
  if (ticketId && approved) addAuthorizedTicket(ticketId, sessionId);

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

  const start = startSessionRun(sessionId, user.id, role, (signal) =>
    runSession({
      sessionId,
      userId: user.id,
      role,
      messages,
      auditTraceId,
      abortSignal: signal,
      isFirstTurn: false,
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
        activeRunId: getSessionStatus(sessionId)?.runId ?? null,
      },
      409,
    );
  }

  return c.json(
    { ok: true, status: approved ? 'approved' : 'denied', sessionId, runId: start.runId },
    { status: 200, headers: { 'x-session-id': sessionId } },
  );
});
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test --workspace apps/server -- test/harness/approvalCallbackBackground.test.ts`
Expected: PASS 7/7.

- [ ] **Step 5: Regression + build + lint**

Run: `DATABASE_URL= npm test --workspace apps/server && npm run build && npm run lint`
Expected: all existing tests pass (the old approvalCallback behavior had NO route-level tests — verify none broke), build clean, lint only the 3 pre-existing unrelated warnings.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/routes/approvalCallback.ts apps/server/test/harness/approvalCallbackBackground.test.ts
git commit -m "feat(approval): fire-and-forget background resume for L2/L3 callbacks"
```

---

### Task B: Runtime gate/resume semantics (I-1 verification)

**Files:**
- Test: `apps/server/test/harness/approvalResume.runtime.test.ts` (new)
- No production changes (this task VERIFIES the SDK semantics the rewrite relies on; failures here mean the spec's §2 assumptions are wrong and work must stop for re-design).

**Interfaces:**
- Consumes: `runStream(opts: RunStreamOpts)` with `RunStreamOpts = { messages, role, auditTraceId, model?, deps?: { ctx, extraction? }, userId?, sessionId?, abortSignal? }` (`harness/agent.ts:191`); `runSession(opts)` (Task A); `recordL2PendingFromResponse(sessionId, messages: ModelMessage[]): void` (`harness/agent.ts:237`); `createDb(':memory:') + migrate(sqlite)` from `pipeline/db/client.js`; sessionStore helpers.
- Produces: verified invariants — (1) a needsApproval tool-call makes the stream FINISH (not hang) with a `tool-approval-request` part; (2) resume with a transient `tool-approval-response` re-executes the tool (approve) or yields no tool execution (deny); (3) `runSession` persists the resume reply as a NEW message id.

- [ ] **Step 1: Verify the tag_document input schema**

Run: `grep -n "tag_document" -A 14 apps/server/src/pipeline/tools/documentEntry.ts`
Expected: the tool name plus an `inputSchema` around lines 868-905 with a docId string field and a tags array field. If the field names differ from `{ docId, tags }`, use the actual names everywhere in Step 2's `input:` values. (exp-1 evidence: `documentEntry.ts:879-899`, execute = loadDocument + listDocumentTags + saveDocumentTags, pure SQLite via deps.ctx.)

- [ ] **Step 2: Write the tests**

Create `apps/server/test/harness/approvalResume.runtime.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { convertToModelMessages, type ModelMessage, type UIMessage } from 'ai';
import { runStream, recordL2PendingFromResponse } from '../../src/harness/agent.js';
import { runSession } from '../../src/harness/runSession.js';
import { createDb, migrate } from '../../src/pipeline/db/client.js';
import {
  createSession,
  appendMessages,
  loadSession,
  listPending,
} from '../../src/harness/sessionStore.js';
import { env } from '../../src/env.js';

/**
 * Phase 4 runtime semantics (spec §2), verified end-to-end with a scripted
 * fake LanguageModelV2 and an in-memory pipeline DB:
 *  1. turn-1 gate: a needsApproval (L2) tool-call emits tool-approval-request
 *     and the stream FINISHES (I-1: the RunManager slot is released, not held).
 *  2. approve resume: history + transient tool-approval-response -> the SDK
 *     re-executes the gated tool (tag_document) and the model finishes.
 *  3. deny resume: approved:false -> the tool does NOT execute; the model
 *     receives the denial and answers.
 *  4. runSession persists the resume reply as a NEW message id (spec §5.3).
 */

interface ScriptStep {
  toolCall?: { toolCallId: string; toolName: string; input: unknown };
  text?: string;
}

// Canned fake model: each doStream call consumes the next script step.
// A toolCall step emits tool-call + finish('tool-calls'); a text step emits
// text parts + finish('stop'). Shape mirrors e2e-loop.test.ts (verified V2).
function scriptedModel(script: ScriptStep[]) {
  let calls = 0;
  const usage = () => ({ inputTokens: 1, outputTokens: 1, totalTokens: 2 });
  return {
    specificationVersion: 'v2' as const,
    provider: 'fake',
    modelId: 'fake-model',
    supportedUrls: {} as Record<string, RegExp[]>,
    async doGenerate() {
      return {
        content: [{ type: 'text' as const, text: 'ok' }],
        finishReason: 'stop' as const,
        usage: usage(),
        warnings: [] as unknown[],
      };
    },
    async doStream() {
      const step = script[Math.min(calls, script.length - 1)];
      calls++;
      const stream = new ReadableStream<unknown>({
        start(controller) {
          if (step.toolCall) {
            controller.enqueue({
              type: 'tool-call',
              toolCallId: step.toolCall.toolCallId,
              toolName: step.toolCall.toolName,
              input: JSON.stringify(step.toolCall.input),
            });
            controller.enqueue({ type: 'finish', finishReason: 'tool-calls', usage: usage() });
          } else {
            controller.enqueue({ type: 'text-start', id: 't1' });
            controller.enqueue({ type: 'text-delta', id: 't1', delta: step.text ?? 'done' });
            controller.enqueue({ type: 'text-end', id: 't1' });
            controller.enqueue({ type: 'finish', finishReason: 'stop', usage: usage() });
          }
          controller.close();
        },
      });
      return { stream };
    },
  };
}

// Seed one document row in a FRESH in-memory ctx by driving ingest_document
// (an L1 tool, executes immediately) with a canned tool-call.
async function seedDoc() {
  const ctx = createDb(':memory:');
  migrate(ctx.sqlite);
  const f = join(env.INGEST_ROOT, `apr-${Date.now()}-${randomUUID().slice(0, 6)}.txt`);
  writeFileSync(f, '合同号: HT-2024-009\n金额: 1000', 'utf-8');
  const fake = scriptedModel([
    { toolCall: { toolCallId: 'call_seed', toolName: 'ingest_document', input: { sourceUri: f, docType: '合同', modality: 'digital' } } },
    { text: 'seeded' },
  ]);
  const result = await runStream({
    messages: [{ role: 'user', content: '录入' }],
    role: 'trader',
    auditTraceId: 't-seed',
    sessionId: 'rt-seed',
    model: fake as any,
    deps: { ctx, extraction: { model: fake as any } },
  });
  let docId = '';
  for await (const part of result.fullStream as AsyncIterable<any>) {
    if (part?.type === 'tool-result' && part.toolName === 'ingest_document') {
      docId = part.output?.docId ?? '';
    }
  }
  expect(docId).toMatch(/^DOC-/);
  return { ctx, docId };
}

const userUIMsg = (text: string): UIMessage =>
  ({ id: randomUUID(), role: 'user', parts: [{ type: 'text', text }] }) as UIMessage;

describe('L2 gate/resume runtime semantics (fake model, in-memory ctx)', () => {
  it('turn-1 gates tag_document, the stream finishes, pending is recorded; approve resume re-executes it', async () => {
    const { ctx, docId } = await seedDoc();
    const s = createSession('trader', 'u-rt1');
    appendMessages(s.id, [userUIMsg('给文档打标签')]);

    // --- Turn 1 (production shape: via runSession, which persists + records) ---
    const gateFake = scriptedModel([
      { toolCall: { toolCallId: 'call_tag', toolName: 'tag_document', input: { docId, tags: ['重要'] } } },
      { text: '已打标' },
    ]);
    await runSession({
      sessionId: s.id,
      userId: 'u-rt1',
      role: 'trader',
      messages: await convertToModelMessages(loadSession(s.id)!.messages as UIMessage[]),
      auditTraceId: 'rt-gate',
      abortSignal: new AbortController().signal,
      model: gateFake as any,
    });

    // The assistant message with the approval-requested part IS persisted
    // (spec §2 Q4 closure) with its SDK-generated approval id.
    const loaded = loadSession(s.id)!;
    const assistantMsg = loaded.messages.find((m) => m.role === 'assistant');
    expect(assistantMsg).toBeTruthy();
    const part = (assistantMsg!.parts as any[]).find(
      (p) => typeof p?.type === 'string' && p.type.startsWith('tool-') && p.state === 'approval-requested',
    );
    expect(part).toBeTruthy();
    const approvalId = part.approval?.id as string;
    expect(approvalId).toBeTruthy();

    // L2 pending row recorded (runSession -> recordL2PendingFromResponse).
    const pend = listPending(s.id).find(
      (p) => p.level === 'L2' && p.tool_name === 'tag_document',
    );
    expect(pend).toBeTruthy();
    expect(pend!.approval_id).toBe(approvalId);
    expect(pend!.tool_call_id).toBe('call_tag');

    // --- Resume (approve): production message shape built from the store ---
    const resumeMsg = {
      role: 'tool',
      content: [
        {
          type: 'tool-approval-response',
          approvalId,
          toolCallId: 'call_tag',
          approved: true,
          reason: '用户已确认',
        },
      ],
    } as unknown as ModelMessage;
    const history = await convertToModelMessages(loadSession(s.id)!.messages as UIMessage[]);
    const resumeFake = scriptedModel([{ text: '已完成打标' }]);
    const result = await runStream({
      messages: [...history, resumeMsg],
      role: 'trader',
      auditTraceId: 'rt-resume',
      sessionId: s.id,
      model: resumeFake as any,
      deps: { ctx, extraction: { model: resumeFake as any } },
    });

    const parts: any[] = [];
    for await (const p of result.fullStream as AsyncIterable<any>) parts.push(p);

    // The SDK paired the response with the persisted request and EXECUTED
    // the gated tool (this is the core approve-resume proof).
    const toolResult = parts.find(
      (p) => p?.type === 'tool-result' && p.toolName === 'tag_document',
    );
    expect(toolResult).toBeTruthy();
    expect(String(JSON.stringify(toolResult.output))).not.toContain('error');
  });

  it('deny resume: the tool does NOT execute; the model still answers', async () => {
    const { ctx, docId } = await seedDoc();
    const s = createSession('trader', 'u-rt2');
    appendMessages(s.id, [userUIMsg('给文档打标签')]);

    const gateFake = scriptedModel([
      { toolCall: { toolCallId: 'call_tag2', toolName: 'tag_document', input: { docId, tags: ['次要'] } } },
      { text: '已打标' },
    ]);
    await runSession({
      sessionId: s.id,
      userId: 'u-rt2',
      role: 'trader',
      messages: await convertToModelMessages(loadSession(s.id)!.messages as UIMessage[]),
      auditTraceId: 'rt-gate2',
      abortSignal: new AbortController().signal,
      model: gateFake as any,
    });

    const loaded = loadSession(s.id)!;
    const assistantMsg = loaded.messages.find((m) => m.role === 'assistant')!;
    const part = (assistantMsg.parts as any[]).find(
      (p) => typeof p?.type === 'string' && p.type.startsWith('tool-') && p.state === 'approval-requested',
    )!;
    const approvalId = part.approval?.id as string;

    const resumeMsg = {
      role: 'tool',
      content: [
        {
          type: 'tool-approval-response',
          approvalId,
          toolCallId: 'call_tag2',
          approved: false,
          reason: '用户已拒绝',
        },
      ],
    } as unknown as ModelMessage;
    const history = await convertToModelMessages(loaded.messages as UIMessage[]);
    const resumeFake = scriptedModel([{ text: '好的，已按用户要求取消打标' }]);
    const result = await runStream({
      messages: [...history, resumeMsg],
      role: 'trader',
      auditTraceId: 'rt-resume2',
      sessionId: s.id,
      model: resumeFake as any,
      deps: { ctx, extraction: { model: resumeFake as any } },
    });

    const parts: any[] = [];
    for await (const p of result.fullStream as AsyncIterable<any>) parts.push(p);

    // Denied: NO successful tool-result for the gated tool (execute skipped).
    const toolResult = parts.find(
      (p) => p?.type === 'tool-result' && p.toolName === 'tag_document',
    );
    expect(toolResult).toBeUndefined();
    // The model produced its final text over the denial.
    expect(parts.some((p) => p?.type === 'text-delta')).toBe(true);
    const finish = parts.find((p) => p?.type === 'finish');
    expect(finish).toBeTruthy();
  });

  it('runSession resume persists the reply as a NEW message id (no originalMessages continuation)', async () => {
    const s = createSession('trader', 'u-rt3');
    appendMessages(s.id, [
      userUIMsg('第一轮'),
      { id: 'old-assistant-' + randomUUID().slice(0, 6), role: 'assistant', parts: [{ type: 'text', text: '旧回复' }] } as UIMessage,
      userUIMsg('继续'),
    ]);
    const before = loadSession(s.id)!.messages;

    const fake = scriptedModel([{ text: '续写回复' }]);
    await runSession({
      sessionId: s.id,
      userId: 'u-rt3',
      role: 'trader',
      messages: await convertToModelMessages(before),
      auditTraceId: 'rt-cont',
      abortSignal: new AbortController().signal,
      model: fake as any,
    });

    const after = loadSession(s.id)!.messages;
    expect(after.length).toBe(before.length + 1);
    const appended = after[after.length - 1];
    expect(appended.role).toBe('assistant');
    expect(before.some((m) => m.id === appended.id)).toBe(false);
  });
});
```

- [ ] **Step 3: Run tests to verify they pass**

Run: `npm test --workspace apps/server -- test/harness/approvalResume.runtime.test.ts`
Expected: PASS 3/3.

If test 1 or 2 FAILS in a way that contradicts spec §2 (stream hangs at the approval point; the response is not paired; execute does not re-run): STOP and report — the spec's technical premise is wrong and the design must be revisited before proceeding. Assertion-shape failures (e.g. chunk type names differ from `tool-result`) are test fixes, not design failures: consult `node_modules/ai/dist/index.d.ts` for the exact chunk type and adjust the matcher.

- [ ] **Step 4: Full regression + build + lint**

Run: `DATABASE_URL= npm test --workspace apps/server && npm run build && npm run lint`
Expected: all green (lint: only the 3 pre-existing unrelated warnings).

- [ ] **Step 5: Commit**

```bash
git add apps/server/test/harness/approvalResume.runtime.test.ts
git commit -m "test(approval): runtime L2 gate/resume semantics with scripted model"
```

---

### Task C: Delete the legacy sessionContext single-slot

**Files:**
- Modify: `apps/server/src/harness/sessionContext.ts` (58 lines → ~33)
- Modify: `apps/server/test/harness/sessionContext.test.ts` (69 lines → ~50)

**Interfaces:**
- Consumes: Task A removed the last `setSessionContext` caller (approvalCallback.ts rewrite). Verify first (Step 1).
- Produces: `sessionContext.ts` exports ONLY `SessionCtx`, `runSessionContext`, `getSessionCtx`, `getSessionId` (ALS-only; `getSessionId(): string | null`).

- [ ] **Step 1: Verify zero remaining consumers**

Run: `grep -rn "setSessionContext\|getSessionContext" apps/server/src apps/server/test`
Expected: matches ONLY in `sessionContext.ts` (definition) and `sessionContext.test.ts` (legacy tests). If any other file matches, STOP and report — do not delete a live consumer.

- [ ] **Step 2: Update the tests (red)**

Replace `apps/server/test/harness/sessionContext.test.ts` content with:

```ts
import { describe, it, expect } from 'vitest';
import {
  runSessionContext,
  getSessionCtx,
  getSessionId,
} from '../../src/harness/sessionContext.js';

// ALS-only session context. Every run (chat POST and approval-callback
// resume alike) is started through RunManager.startSessionRun, which wraps
// the run body in runSessionContext, so tool executes always resolve their
// session through the ALS store.
describe('sessionContext AsyncLocalStorage', () => {
  it('getSessionCtx throws outside a run context', () => {
    expect(() => getSessionCtx()).toThrow(/not set/i);
  });

  it('getSessionId returns null outside a run context', () => {
    expect(getSessionId()).toBeNull();
  });

  it('runSessionContext sets ALS context for the call', () => {
    runSessionContext({ sessionId: 's1', role: 'trader' }, () => {
      expect(getSessionCtx().sessionId).toBe('s1');
      expect(getSessionId()).toBe('s1');
    });
  });

  it('context isolates across nested async runs', async () => {
    await runSessionContext({ sessionId: 'outer', role: 'trader' }, async () => {
      expect(getSessionId()).toBe('outer');
      await runSessionContext({ sessionId: 'inner', role: 'trader' }, async () => {
        expect(getSessionId()).toBe('inner');
      });
      expect(getSessionId()).toBe('outer');
    });
  });

  it('context does not leak across concurrent async chains', async () => {
    const out: string[] = [];
    await Promise.all([
      runSessionContext({ sessionId: 'a', role: 'trader' }, async () => {
        await new Promise((r) => setTimeout(r, 5));
        out.push(getSessionId() ?? 'none');
      }),
      runSessionContext({ sessionId: 'b', role: 'trader' }, async () => {
        await new Promise((r) => setTimeout(r, 5));
        out.push(getSessionId() ?? 'none');
      }),
    ]);
    expect(out.sort()).toEqual(['a', 'b']);
  });
});
```

Run: `npm test --workspace apps/server -- test/harness/sessionContext.test.ts`
Expected: FAIL to compile — `sessionContext.js` still exports `setSessionContext` which the old import in the test file no longer... (actually the new test no longer imports it, so it PASSES; the point of this ordering is the next step's tsc gate). If it passes, proceed — the red/green cycle for this task is the tsc failure in Step 3.

- [ ] **Step 3: Simplify sessionContext.ts**

Replace the ENTIRE file content with:

```ts
import { AsyncLocalStorage } from 'node:async_hooks';

// Session-scoped context for tool execute functions.
//
// AI SDK 6 tool `execute` has no slot for arbitrary request context, so an
// AsyncLocalStorage carries the current session per background run. Every run
// (chat POST and approval-callback resume alike) is started through
// RunManager.startSessionRun, which wraps the run body in runSessionContext —
// so tool executes always find their session here.

export type SessionCtx = {
  sessionId: string;
  userId?: string;
  runId?: string;
  role: string;
};

const sessionALS = new AsyncLocalStorage<SessionCtx>();

export function runSessionContext<T>(ctx: SessionCtx, fn: () => T): T {
  return sessionALS.run(ctx, fn);
}

export function getSessionCtx(): SessionCtx {
  const ctx = sessionALS.getStore();
  if (!ctx) throw new Error('session context not set');
  return ctx;
}

// Returns null when read outside any session context (e.g. a tool execute
// invoked from a standalone script).
export function getSessionId(): string | null {
  return sessionALS.getStore()?.sessionId ?? null;
}
```

Run: `npm run build`
Expected: tsc clean — this is the hard gate that no consumer of `setSessionContext`/`getSessionContext`/`currentSessionId` remains. Any error names a missed consumer: migrate it to `getSessionId()`/`runSessionContext` and re-run.

- [ ] **Step 4: Tests + lint**

Run: `DATABASE_URL= npm test --workspace apps/server && npm run lint`
Expected: all green. Also `grep -rn "setSessionContext\|getSessionContext\|currentSessionId" apps/server/src` → zero matches.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/harness/sessionContext.ts apps/server/test/harness/sessionContext.test.ts
git commit -m "refactor(session): ALS-only session context, delete legacy single-slot"
```

---

### Task D: Frontend postApproval goes pure-fetch

**Files:**
- Modify: `apps/web/src/components/RealChatView.tsx:211-266` (postApproval body), imports at `:2-3`

**Interfaces:**
- Consumes: Task A's contract — `200 {ok,status,sessionId,runId}` (no event-stream body), `409 {error:'session_busy', approvalResolved, activeRunId}`.
- Produces: no interface change for callers (`handleApprove`/`handleDeny`/`handleApprovalCallback` untouched).

- [ ] **Step 1: Rewrite postApproval**

Replace the `postApproval` function (lines ~211-266) with:

```tsx
  const postApproval = async (body: { approvalId?: string; ticketId?: string; approved: boolean }) => {
    if (!sessionId || callbackState === 'loading') return
    setCallbackState('loading')
    setCallbackError(null)
    try {
      const res = await fetch('/api/approval/callback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-session-id': sessionId },
        body: JSON.stringify({ ...body, reason: body.approved ? '用户确认执行' : '用户拒绝执行' }),
      })
      if (!res.ok) {
        const text = await res.text()
        let detail = text
        let approvalResolved = false
        try {
          const json = JSON.parse(text)
          detail = json.error || JSON.stringify(json)
          approvalResolved = json.approvalResolved === true
        } catch {}
        if (res.status === 409) {
          throw new Error(
            approvalResolved
              ? '审批已记录，但会话正忙，稍后重发消息即可恢复'
              : '会话正忙，请稍后重试',
          )
        }
        throw new Error(`${res.status}: ${detail}`)
      }
      // 200: fire-and-forget. The resume run streams over SSE (run.started ->
      // message.part -> run.finished), which useSessionMessages already
      // renders; the approval card clears when the tool part reaches
      // output-available. No local stream merge is needed anymore.
      setLastApprovalApproved(body.approved)
      setCallbackState('success')
    } catch (err) {
      console.error('[approval callback] failed:', err)
      setCallbackError(err instanceof Error ? err.message : String(err))
      setCallbackState('error')
    }
  }
```

- [ ] **Step 2: Clean up now-unused imports**

Line 2 currently: `import { generateId, parseJsonEventStream, readUIMessageStream, uiMessageChunkSchema } from 'ai'`
Line 3 currently: `import type { UIMessage, UIMessageChunk } from 'ai'`

Run: `grep -n "generateId\|parseJsonEventStream\|readUIMessageStream\|uiMessageChunkSchema\|UIMessageChunk" apps/web/src/components/RealChatView.tsx`
Remove every symbol whose only remaining matches are inside the deleted code. Expected: all five become unused (the deleted merge block was their only user); `UIMessage` (line 3) stays only if other matches remain — if none, drop it too and let tsc confirm.

- [ ] **Step 3: Build + lint (web)**

Run: `npm run build && npm run lint`
Expected: build clean (tsc catches any missed usage), lint no new warnings.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/RealChatView.tsx
git commit -m "feat(web): approval callback pure-fetch with 409 handling"
```

---

### Task E: Manual acceptance + regression + whole-branch review

**Files:** none (verification only).

- [ ] **Step 1: Full CI-equivalent regression**

Run: `npm run build && npm run lint && DATABASE_URL= npm test --workspace apps/server`
Expected: all green.

- [ ] **Step 2: Manual E2E via agent-browser**

Start dev servers in the worktree (backend :3001, frontend :5173; do not duplicate if already running). Test account: `e2e@test.local` / `Test12345678`.

1. Open the app, create a session, send a message that triggers an L2 tool (e.g. ask to tag/bind an ingested document). The approval card renders; the session badge goes idle (run finished at the approval point).
2. Click 批准: the input shows the busy state, the resume streams in over SSE (new assistant message), the approval card disappears, no duplicated messages in history (compare with a page refresh).
3. In a second browser tab (same session, another window): approve/deny from tab A → tab B shows the same streamed resume (multi-client consistency).
4. Trigger an L2 deny: the model answers acknowledging the refusal; no tool output part appears.
5. Busy check: while a run streams, click an approval in another session → error banner "会话正忙" (or the approvalResolved variant).
6. L3 smoke: trigger `create_payment` (blocked card) → approve → instruction + resume run visible.

- [ ] **Step 3: Whole-branch review**

Generate a review package for `git merge-base main HEAD..HEAD` and dispatch the final code review (oracle). Triage findings; fix Critical/Important; record Minors in `.superpowers/sdd/progress.md`.

- [ ] **Step 4: Merge decision**

Report to the user with the review verdict; on approval, merge `feat/approval-decoupling` into main and push (triggers CI/CD).

---

## Self-Review (completed)

- **Spec coverage:** §4 contract (Task A), §5.1-5.4 (Task A; 5.4's conflict branch is code + covered by design review, only reachable in a narrow race), §5.5 (Task C), §6 (Task D), §8 tests 1-7 (Tasks A+B; spec test "busy 409" = A test 6; "resolveApproval before run" = A tests 1-2 assertions; legacy-slot regression = C), §8 acceptance (Task E).
- **Placeholders:** none — all code blocks complete.
- **Type consistency:** `startSessionRun(sessionId, userId, role, fn)` matches runManager.ts:22; `RunSessionOpts` matches runSession.ts:33; `recordPendingApproval` input matches sessionStore.ts:381; `PendingApprovalRow` matches sessionStore.ts:117.
