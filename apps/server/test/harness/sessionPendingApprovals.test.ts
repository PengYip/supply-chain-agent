import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import type { AuthEnv } from '../../src/lib/auth-middleware.js';

// GET /api/sessions/:id/pending-approvals — session-restore guard for the
// approval/review cards. Persisted message parts stay in approval-requested /
// blocked terminal state after an approval resolves (L3 blocked outputs are
// never rewritten; L2 stays stale when a resume run fails), so the client must
// gate card visibility on the authoritative pending_approvals roster instead.

const { sessionsRoute } = await import('../../src/routes/sessions.js');
const {
  createSession,
  recordPendingApproval,
  resolveApproval,
} = await import('../../src/harness/sessionStore.js');

function appAs(userId: string) {
  const app = new Hono<AuthEnv>();
  app.use('*', async (c, next) => {
    c.set('user', { id: userId, email: 't@t', role: 'trader' } as any);
    await next();
  });
  app.route('/api/sessions', sessionsRoute);
  return app;
}

// Shared file DB: unique ids per run.
const uid = (p: string) => `${p}-${randomUUID().slice(0, 8)}`;

describe('GET /api/sessions/:id/pending-approvals', () => {
  it('lists only still-pending ids (L2 approvalIds + L3 ticketIds); resolved ones excluded', async () => {
    const s = await createSession('trader', 'u-pa1');
    const l2Pending = uid('appr');
    const l3Pending = uid('T');
    const l3Resolved = uid('T');
    await recordPendingApproval({
      sessionId: s.id, level: 'L2', toolName: 'tag_document',
      toolCallId: 'call_pa', input: {}, approvalId: l2Pending,
    });
    await recordPendingApproval({
      sessionId: s.id, level: 'L3', toolName: 'escalate_to_human',
      input: {}, ticketId: l3Pending,
    });
    await recordPendingApproval({
      sessionId: s.id, level: 'L3', toolName: 'escalate_to_human',
      input: {}, ticketId: l3Resolved,
    });
    await resolveApproval(l3Resolved, 'approved');

    const res = await appAs('u-pa1').request(`http://test/api/sessions/${s.id}/pending-approvals`);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(Array.isArray(json.pendingApprovalIds)).toBe(true);
    expect(json.pendingApprovalIds).toContain(l2Pending);
    expect(json.pendingApprovalIds).toContain(l3Pending);
    expect(json.pendingApprovalIds).not.toContain(l3Resolved);
    expect(json.pendingApprovalIds).toHaveLength(2);
  });

  it('returns an empty list for a session with no approvals', async () => {
    const s = await createSession('trader', 'u-pa2');
    const res = await appAs('u-pa2').request(`http://test/api/sessions/${s.id}/pending-approvals`);
    expect(res.status).toBe(200);
    expect((await res.json()).pendingApprovalIds).toEqual([]);
  });

  it('404s for a non-owner and for an unknown session (existence hidden)', async () => {
    const s = await createSession('trader', 'u-pa3');
    const res403 = await appAs('u-pa-other').request(`http://test/api/sessions/${s.id}/pending-approvals`);
    expect(res403.status).toBe(404);
    const res404 = await appAs('u-pa3').request('http://test/api/sessions/nope/pending-approvals');
    expect(res404.status).toBe(404);
  });
});
