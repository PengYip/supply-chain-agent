import { describe, it, expect, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import type { AuthEnv } from '../../src/lib/auth-middleware.js';

// Same resolve-holder pattern as approvalCallbackBackground.test.ts (fixture
// parity; the GET routes never start a run, so runResolve stays unused).
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

const get = (app: Hono<AuthEnv>, path: string) =>
  app.request(`http://test/api${path}`, { method: 'GET' });

// Shared file DB: unique ids per run.
const uid = (p: string) => `${p}-${randomUUID().slice(0, 8)}`;

describe('GET /api/approval/list', () => {
  it('200 返回本人 items 且 sideEffects 已解析', async () => {
    // createSession 签名以 sessionStore.ts facade 为准: createSession(role, userId?)
    const s = await createSession('trader', 'u1');
    await recordPendingApproval({ sessionId: s.id, level: 'L3', toolName: 'escalate_to_human',
      input: { issue: 'x' }, ticketId: `ESC-${uid('t')}` });
    const res = await get(appAs('u1'), '/approval/list?status=pending');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.items)).toBe(true);
    expect(body.items[0]).toHaveProperty('level');
    expect(body.items[0]).toHaveProperty('sideEffects');
  });

  it('limit/status 非法 400', async () => {
    const res = await get(appAs('u1'), '/approval/list?limit=abc');
    expect(res.status).toBe(400);
  });
});

describe('GET /api/approval/:id', () => {
  it('他人票据 404（防枚举）', async () => {
    const s = await createSession('trader', 'u2');
    const approvalId = `ap_${uid('a')}`;
    await recordPendingApproval({ sessionId: s.id, level: 'L2', toolName: 'bind_document',
      toolCallId: `call_${uid('c')}`, input: {}, approvalId });
    const row = await getPending(approvalId);
    const res = await get(appAs('u1'), `/approval/${row!.id}`);
    expect(res.status).toBe(404);
  });

  it('未知 id 404', async () => {
    const res = await get(appAs('u1'), '/approval/nonexistent');
    expect(res.status).toBe(404);
  });
});
