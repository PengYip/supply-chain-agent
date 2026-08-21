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
    const s = await createSession('trader', 'u-a1');
    await appendMessages(s.id, [userMsg('hi') as any]);
    const aid = uid('appr');
    await recordPendingApproval({
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
    expect((await getPending(aid))?.status).toBe('approved');

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
    const loaded = await loadSession(s.id)!;
    expect(loaded.messages[loaded.messages.length - 1].role).toBe('user');
    runResolve.current();
  });

  it('L2 deny: also starts a resume run with approved:false and default reason', async () => {
    const s = await createSession('trader', 'u-a2');
    const aid = uid('appr');
    await recordPendingApproval({
      sessionId: s.id, level: 'L2', toolName: 'tag_document',
      toolCallId: 'call_y', input: {}, approvalId: aid,
    });

    const res = await post(appAs('u-a2'), { approvalId: aid, approved: false });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.status).toBe('denied');
    expect((await getPending(aid))?.status).toBe('denied');
    expect(runSession).toHaveBeenCalledTimes(1);
    const opts = (runSession as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const part = (opts.messages[opts.messages.length - 1].content as any[])[0];
    expect(part.approved).toBe(false);
    expect(part.reason).toBe('用户已拒绝');
    runResolve.current();
  });

  it('L3 approve (escalate_to_human): appends the unified human-reviewed instruction and starts the run', async () => {
    const s = await createSession('trader', 'u-a3');
    const tid = uid('T');
    await recordPendingApproval({
      sessionId: s.id, level: 'L3', toolName: 'escalate_to_human',
      input: {}, ticketId: tid,
    });

    const res = await post(appAs('u-a3'), { ticketId: tid, approved: true });
    expect(res.status).toBe(200);
    expect((await getPending(tid))?.status).toBe('approved');

    // The unified approved instruction is appended to the persisted history.
    const loaded = await loadSession(s.id)!;
    const lastMsg = loaded.messages[loaded.messages.length - 1];
    expect(lastMsg.role).toBe('user');
    const text = JSON.stringify(lastMsg);
    expect(text).toContain(`人工已复核工单 ${tid}`);
    expect(text).not.toContain('authorizedTicketId');
    expect(text).not.toContain('create_payment');

    // The instruction is ALSO in the model messages handed to runSession.
    const opts = (runSession as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const lastModel = opts.messages[opts.messages.length - 1];
    expect(lastModel.role).toBe('user');
    expect(JSON.stringify(lastModel)).toContain(`人工已复核工单 ${tid}`);
    expect(JSON.stringify(lastModel)).not.toContain('authorizedTicketId');
    runResolve.current();
  });

  it('L3 approve (escalate_to_human): appends the generic human-review instruction', async () => {
    const s = await createSession('trader', 'u-a4');
    const tid = uid('T');
    await recordPendingApproval({
      sessionId: s.id, level: 'L3', toolName: 'escalate_to_human',
      input: {}, ticketId: tid,
    });

    const res = await post(appAs('u-a4'), { ticketId: tid, approved: true });
    expect(res.status).toBe(200);
    const loaded = await loadSession(s.id)!;
    const text = JSON.stringify(loaded.messages[loaded.messages.length - 1]);
    expect(text).toContain('人工已复核');
    expect(text).not.toContain('authorizedTicketId');
    runResolve.current();
  });

  it('L3 deny: appends deny instruction and still resumes', async () => {
    const s = await createSession('trader', 'u-a5');
    const tid = uid('T');
    await recordPendingApproval({
      sessionId: s.id, level: 'L3', toolName: 'escalate_to_human',
      input: {}, ticketId: tid,
    });

    const res = await post(appAs('u-a5'), { ticketId: tid, approved: false });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.status).toBe('denied');
    const loaded = await loadSession(s.id)!;
    const text = JSON.stringify(loaded.messages[loaded.messages.length - 1]);
    expect(text).toContain('已拒绝');
    expect(runSession).toHaveBeenCalledTimes(1);
    runResolve.current();
  });

  it('returns 409 session_busy (approvalResolved:false) when a run is in-flight; DB untouched', async () => {
    const s = await createSession('trader', 'u-a6');
    const aid = uid('appr');
    await recordPendingApproval({
      sessionId: s.id, level: 'L2', toolName: 'tag_document',
      input: {}, approvalId: aid,
    });

    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    await startSessionRun(s.id, 'u-a6', 'trader', () => gate);

    const res = await post(appAs('u-a6'), { approvalId: aid, approved: true });
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.error).toBe('session_busy');
    expect(json.approvalResolved).toBe(false);
    expect((await getPending(aid))?.status).toBe('pending');
    expect(runSession).not.toHaveBeenCalled();
    release();
  });

  it('returns 404 for unknown ids and 403 for non-owners', async () => {
    const res404 = await post(appAs('u-a7'), { approvalId: 'nope-' + randomUUID().slice(0, 6), approved: true });
    expect(res404.status).toBe(404);

    const s = await createSession('trader', 'u-owner');
    const aid = uid('appr');
    await recordPendingApproval({
      sessionId: s.id, level: 'L2', toolName: 'tag_document',
      input: {}, approvalId: aid,
    });
    const res403 = await post(appAs('u-other'), { approvalId: aid, approved: true });
    expect(res403.status).toBe(403);
    expect((await getPending(aid))?.status).toBe('pending');
  });

  it('replay of an already-resolved approval returns 409 approval_already_resolved and does not re-run', async () => {
    const s = await createSession('trader', 'u-replay');
    const tid = uid('T');
    await recordPendingApproval({
      sessionId: s.id, level: 'L3', toolName: 'escalate_to_human',
      input: {}, ticketId: tid,
    });

    // First callback: approve -> 200, one run started, instruction appended once.
    const res1 = await post(appAs('u-replay'), { ticketId: tid, approved: true });
    expect(res1.status).toBe(200);
    expect((await getPending(tid))?.status).toBe('approved');
    expect(runSession).toHaveBeenCalledTimes(1);
    runResolve.current();
    // Let the first run's cleanup (RunManager finally) settle so this replay
    // truly exercises the resolved-approval guard, not the single-flight check.
    await new Promise((r) => setTimeout(r, 10));

    // Replay the exact same POST: must be rejected without any state change.
    const res2 = await post(appAs('u-replay'), { ticketId: tid, approved: true });
    expect(res2.status).toBe(409);
    const json2 = await res2.json();
    expect(json2.error).toBe('approval_already_resolved');
    expect(json2.approvalResolved).toBe(true);
    // runSession was NOT called again (mock call count unchanged).
    expect(runSession).toHaveBeenCalledTimes(1);
    // The L3 instruction was not re-appended (history still has the single one).
    const loaded = await loadSession(s.id)!;
    expect(loaded.messages.length).toBe(1);
  });
});
