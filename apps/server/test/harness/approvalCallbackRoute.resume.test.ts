import { describe, it, expect, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { convertToModelMessages, type UIMessage } from 'ai';
import type { AuthEnv } from '../../src/lib/auth-middleware.js';

// End-to-end minimal trajectory for the dev 2026-09-08 incident, at production
// fidelity: the REAL /api/approval/callback route (not a hand-built resume
// message) starts the REAL runSession, which must (a) assemble a prompt the SDK
// accepts despite the approval-requested assistant message in the persisted
// history (the AI_MissingToolResultsError regression), (b) re-execute the
// approved create_trade_event through its L2 gate (trade_facts +
// side_effect_results), or (c) feed the model an execution-denied result with
// the reason. The callback body uses the INCIDENT key shape -- { ticketId:
// <L2 approval id> } -- which used to misroute into the L3 instruction branch.
//
// The scripted fake model is injected by wrapping (not replacing) the real
// runStream, so gating (needsApproval -> tool-approval-request), SDK approval
// pairing, and history continuation all run their production code paths.

const { fakeModelRef } = vi.hoisted(() => ({
  fakeModelRef: { current: null as unknown },
}));

vi.mock('../../src/harness/agent.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/harness/agent.js')>();
  return {
    ...actual,
    runStream: ((opts: { model?: unknown }) =>
      actual.runStream({
        ...opts,
        model: (fakeModelRef.current ?? opts.model) as never,
      })) as typeof actual.runStream,
  };
});

const { approvalCallback } = await import('../../src/routes/approvalCallback.js');
const { buildTradeEventInstruction } = await import('../../src/routes/tradeEvents.js');
const {
  createSession,
  appendMessages,
  loadSession,
  setSessionTitle,
  getPending,
} = await import('../../src/harness/sessionStore.js');
const { runSession } = await import('../../src/harness/runSession.js');
const { getDbContext } = await import('../../src/pipeline/db/dbBackend.js');

interface ScriptStep {
  toolCall?: { toolCallId: string; toolName: string; input: unknown };
  text?: string;
}

// Canned fake model: each doStream call consumes the next script step.
// Same shape as approvalResume.runtime.test.ts (verified V2). Optional onPrompt
// captures the converted prompt for model-facing assertions.
function scriptedModel(script: ScriptStep[], onPrompt?: (prompt: unknown) => void) {
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
    async doStream(options?: { prompt?: unknown }) {
      const step = script[Math.min(calls, script.length - 1)];
      calls++;
      if (onPrompt) onPrompt(options?.prompt);
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

function appAs(userId: string) {
  const app = new Hono<AuthEnv>();
  app.use('*', async (c, next) => {
    c.set('user', { id: userId, email: 't@t', role: 'trader' } as any);
    await next();
  });
  app.route('/api', approvalCallback);
  return app;
}

const EVENT_INPUT = {
  entityType: 'PaymentEvent',
  eventBizType: '正向',
  amount: 8800,
  currency: 'CNY',
  validAt: '2026-09-08',
  payType: '预付',
} as const;

const CALL_ID = 'call_route_e2e';

/** Seed + drive the gate turn through the real runSession: a form-submission
 *  style instruction turn that ends with create_trade_event gated at L2. */
async function seedGatedTurn(userId: string, sessionIdTag: string) {
  const s = await createSession('trader', userId);
  await setSessionTitle(s.id, `事件登记 ${sessionIdTag}`);
  await appendMessages(s.id, [
    {
      id: randomUUID(),
      role: 'user',
      parts: [{ type: 'text', text: buildTradeEventInstruction(EVENT_INPUT) }],
    } as UIMessage,
  ]);

  fakeModelRef.current = scriptedModel([
    { toolCall: { toolCallId: CALL_ID, toolName: 'create_trade_event', input: EVENT_INPUT } },
    { text: '已提交登记，等待审批' },
  ]);
  const loaded = (await loadSession(s.id))!;
  await runSession({
    sessionId: s.id,
    userId,
    role: 'trader',
    messages: await convertToModelMessages(loaded.messages as UIMessage[]),
    auditTraceId: `gate-${sessionIdTag}`,
    abortSignal: new AbortController().signal,
    scenario: 'settlement',
  });

  const after = (await loadSession(s.id))!;
  const assistant = after.messages.find((m) => m.role === 'assistant');
  expect(assistant).toBeTruthy();
  const part = (assistant!.parts as Array<Record<string, unknown>>).find(
    (p) => typeof p.type === 'string' && (p.type as string).startsWith('tool-')
      && p.state === 'approval-requested',
  );
  expect(part).toBeTruthy();
  const approval = part!.approval as { id: string };
  expect(approval.id).toBeTruthy();
  const pend = await getPending(approval.id);
  expect(pend?.level).toBe('L2');
  expect(pend?.status).toBe('pending');
  return { s, aid: approval.id };
}

/** Poll until the predicate holds; the resume run is fire-and-forget from the
 *  route's perspective, so tests wait on observable store effects. */
async function waitFor(desc: string, pred: () => Promise<boolean>, timeoutMs = 8000) {
  const t0 = Date.now();
  for (;;) {
    if (await pred()) return;
    if (Date.now() - t0 > timeoutMs) throw new Error(`timeout waiting for: ${desc}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

function approvalRequestedPart(msg: UIMessage | undefined) {
  return (msg?.parts as Array<Record<string, unknown>> | undefined)?.find(
    (p) => typeof p.type === 'string' && (p.type as string).startsWith('tool-')
      && p.toolCallId === CALL_ID,
  );
}

describe('POST /api/approval/callback -> runSession resume (route-level trajectory)', () => {
  it('approve via the incident ticketId key: prompt assembly survives, tool re-executes, trade_facts + side effects land', async () => {
    const userId = 'u-route-approve';
    const { s, aid } = await seedGatedTurn(userId, randomUUID().slice(0, 6));
    const ctx = getDbContext();

    let capturedPrompt: unknown;
    fakeModelRef.current = scriptedModel([{ text: '登记完成：付款 8800 CNY' }], (p) => {
      capturedPrompt = p;
    });

    // The EXACT body shape from the dev incident: the approval center posted
    // the L2 approval id under ticketId.
    const app = appAs(userId);
    const res = await app.request('http://test/api/approval/callback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ticketId: aid, approved: true }),
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.status).toBe('approved');

    // The gated tool ACTUALLY re-executed through the L2 wrapper: the fact is
    // written via insertTradeFact (the sole write boundary).
    await waitFor('trade_facts row', async () => {
      const row = ctx.sqlite
        .prepare(`SELECT COUNT(*) AS n FROM trade_facts WHERE user_id = ? AND entity_type = 'PaymentEvent'`)
        .get(userId) as { n: number };
      return row.n > 0;
    });

    // The L2 wrapper appended the execution audit row onto the approval.
    const pend = await getPending(aid);
    expect(pend?.status).toBe('approved');
    const sideEffects = pend?.side_effect_results ? JSON.parse(pend.side_effect_results) : [];
    expect(sideEffects.some((e: { action: string; ok: boolean }) => e.action === 'create_trade_event' && e.ok === true))
      .toBe(true);

    // Conversation-flow shape: the persisted tool part was flipped IN PLACE
    // from approval-requested to output-available (continuation, not a new
    // message), so no dangling tool call poisons later turns.
    await waitFor('part flipped to output-available', async () => {
      const loaded = (await loadSession(s.id))!;
      const assistant = loaded.messages.find((m) => m.role === 'assistant');
      return approvalRequestedPart(assistant)?.state === 'output-available';
    });
    const finalAssistant = (await loadSession(s.id))!.messages.find((m) => m.role === 'assistant');
    const partOutput = approvalRequestedPart(finalAssistant) as { output?: unknown };
    expect(JSON.stringify(partOutput.output)).toContain('ok');

    // The model's closing turn saw the real tool result (aligned toolCallId).
    expect(JSON.stringify(capturedPrompt)).toContain(CALL_ID);
  }, 20000);

  it('deny via the incident ticketId key: no execution, model receives execution-denied with the reason', async () => {
    const userId = 'u-route-deny';
    const { s, aid } = await seedGatedTurn(userId, randomUUID().slice(0, 6));
    const ctx = getDbContext();

    let capturedPrompt: unknown;
    fakeModelRef.current = scriptedModel([{ text: '好的，本次登记已取消' }], (p) => {
      capturedPrompt = p;
    });

    const app = appAs(userId);
    const res = await app.request('http://test/api/approval/callback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ticketId: aid, approved: false, reason: '金额不对' }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe('denied');

    // The decision is durable with the reviewer's reason.
    const pend = await getPending(aid);
    expect(pend?.status).toBe('denied');
    expect(pend?.reason).toBe('金额不对');

    await waitFor('part left approval-requested', async () => {
      const loaded = (await loadSession(s.id))!;
      const assistant = loaded.messages.find((m) => m.role === 'assistant');
      const state = approvalRequestedPart(assistant)?.state;
      return state === 'output-available' || state === 'output-denied';
    });

    // NO trade fact was written (deny must never execute the tool).
    const row = ctx.sqlite
      .prepare(`SELECT COUNT(*) AS n FROM trade_facts WHERE user_id = ?`)
      .get(userId) as { n: number };
    expect(row.n).toBe(0);

    // The model's prompt carries the execution-denied result with the reason,
    // aligned to the interrupted tool call -- it can close out politely.
    const promptJson = JSON.stringify(capturedPrompt);
    expect(promptJson).toContain('execution-denied');
    expect(promptJson).toContain('金额不对');
    expect(promptJson).toContain(CALL_ID);

    // No dangling approval-requested part left in the persisted history.
    const finalAssistant = (await loadSession(s.id))!.messages.find((m) => m.role === 'assistant');
    expect(approvalRequestedPart(finalAssistant)?.state).not.toBe('approval-requested');
  }, 20000);
});
