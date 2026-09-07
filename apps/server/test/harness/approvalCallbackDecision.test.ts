import { describe, it, expect, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import type { AuthEnv } from '../../src/lib/auth-middleware.js';

// Same resolve-holder pattern as approvalCallbackBackground.test.ts: the stubbed
// runSession blocks until released, keeping the RunManager slot "busy".
const { runResolve } = vi.hoisted(() => ({
  runResolve: { current: (() => {}) } as { current: () => void },
}));

vi.mock('../../src/harness/runSession.js', () => ({
  runSession: vi.fn(
    () => new Promise<void>((r) => { runResolve.current = r; }),
  ),
}));

const { approvalCallback } = await import('../../src/routes/approvalCallback.js');
const { createSession, recordPendingApproval, getPending } =
  await import('../../src/harness/sessionStore.js');

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

// Local helper（同 Task 4 测试的 seed 模式；createSession 签名以 sessionStore.ts
// facade 为准: createSession(role, userId?)）—— L2 行 PK id = approvalId。
async function seedL2Pending(userId: string) {
  const s = await createSession('trader', userId);
  const approvalId = `ap_${uid('a')}`;
  await recordPendingApproval({ sessionId: s.id, level: 'L2', toolName: 'bind_document',
    toolCallId: `call_${uid('c')}`, input: {}, approvalId });
  return { sid: s.id, approvalId, rowId: approvalId };
}

describe('POST /api/approval/callback decision audit', () => {
  it('批准时记录决策人与理由', async () => {
    const { sid, approvalId, rowId } = await seedL2Pending('u1');
    const res = await post(appAs('u1'), { approvalId, approved: true, reason: '已核对附件' });
    expect(res.status).toBe(200);
    const row = await getPending(approvalId);
    expect(row?.decided_by).toBe('u1');
    expect(row?.reason).toBe('已核对附件');
    expect(row?.decided_at).toBeTruthy();
  });

  it('拒绝同样留痕', async () => {
    const { approvalId } = await seedL2Pending('u1');
    const res = await post(appAs('u1'), { approvalId, approved: false, reason: '金额不符' });
    expect(res.status).toBe(200);
    const row = await getPending(approvalId);
    expect(row?.status).toBe('denied');
    expect(row?.reason).toBe('金额不符');
  });
});