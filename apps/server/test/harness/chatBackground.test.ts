import { describe, it, expect, vi, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import type { AuthEnv } from '../../src/lib/auth-middleware.js';

// vi.mock factory cannot reference module-level variables directly (vitest
// hoists the mock call above all imports). Use vi.hoisted for the resolve
// holder so the stubbed runSession can hand the test its resolve fn: each call
// to runSession creates a pending promise that only resolves when the test
// invokes runResolve.current(), keeping the RunManager run "busy".
const { runResolve } = vi.hoisted(() => ({
  runResolve: { current: (() => {}) } as { current: () => void },
}));

vi.mock('../../src/harness/runSession.js', () => ({
  runSession: vi.fn(
    () => new Promise<void>((r) => { runResolve.current = r; }),
  ),
  extractMessageText: vi.fn((m: { content?: unknown }) =>
    typeof m?.content === 'string' ? m.content : '',
  ),
}));

const { chatRoute } = await import('../../src/routes/chat.js');
const { createSession, recordPendingApproval, resolveApproval, loadSession } = await import('../../src/harness/sessionStore.js');
const { runSession } = await import('../../src/harness/runSession.js');

// chatRoute reads the auth user via c.get('user') (attached by attachSession in
// production). Wrap chatRoute in a fresh outer Hono app per test with an
// injection middleware registered BEFORE app.route() — the standard sub-app
// testing shape (sessionsRoute's handlers are already registered at import).
function appAs(userId: string) {
  const app = new Hono<AuthEnv>();
  app.use('*', async (c, next) => {
    c.set('user', { id: userId, email: 't@t', role: 'trader' } as any);
    await next();
  });
  app.route('/api', chatRoute);
  return app;
}

// AI SDK 6 UIMessage shape: { id, role, parts: [...] }. convertToModelMessages
// (not mocked) validates this, so the route reaches startSessionRun.
const uiMsg = (text: string) => ({
  id: 'm1',
  role: 'user',
  parts: [{ type: 'text', text }],
});

const body = () =>
  JSON.stringify({ messages: [uiMsg('hi')], role: 'trader', contextFiles: [] });

const headers = (sessionId: string) => ({
  'Content-Type': 'application/json',
  'x-session-id': sessionId,
});

describe('POST /api/chat (background runtime)', () => {
  beforeEach(() => {
    runResolve.current = () => {};
    (runSession as ReturnType<typeof vi.fn>).mockClear();
  });

  it('starts a background run and returns {sessionId, runId, status:busy}', async () => {
    const s = createSession('trader', 'u-chat1');
    const res = await appAs('u-chat1').request('http://test/api/chat', {
      method: 'POST',
      headers: headers(s.id),
      body: body(),
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.runId).toBeTruthy();
    expect(json.status).toBe('busy');
    expect(json.sessionId).toBe(s.id);
    expect(res.headers.get('x-session-id')).toBe(s.id);
    runResolve.current(); // release the stubbed run
  });

  it('returns 409 session_busy when a run is already in-flight', async () => {
    const s = createSession('trader', 'u-chat2');
    // First request starts a run (the stub blocks until released).
    const res1 = await appAs('u-chat2').request('http://test/api/chat', {
      method: 'POST',
      headers: headers(s.id),
      body: body(),
    });
    expect(res1.status).toBe(200);

    // Second request -> single-flight conflict.
    const res2 = await appAs('u-chat2').request('http://test/api/chat', {
      method: 'POST',
      headers: headers(s.id),
      body: body(),
    });
    expect(res2.status).toBe(409);
    const json2 = await res2.json();
    expect(json2.error).toBe('session_busy');
    runResolve.current();
  });

  it('returns 409 approval_pending when an L2 approval is pending (user msg not persisted, run not started)', async () => {
    const s = createSession('trader', 'u-chat3');
    recordPendingApproval({
      sessionId: s.id, level: 'L2', toolName: 'tag_document',
      input: {}, approvalId: 'ap-' + s.id,
    });

    const res = await appAs('u-chat3').request('http://test/api/chat', {
      method: 'POST',
      headers: headers(s.id),
      body: body(),
    });
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.error).toBe('approval_pending');
    // The user message must NOT have been persisted on the 409.
    expect(loadSession(s.id)!.messages.length).toBe(0);
    // No background run was started.
    expect(runSession).not.toHaveBeenCalled();
  });

  it('L3 pending ticket does NOT block chat (blocked tool-result already in history)', async () => {
    const s = createSession('trader', 'u-chat4');
    recordPendingApproval({
      sessionId: s.id, level: 'L3', toolName: 'escalate_to_human',
      input: {}, ticketId: 'T-' + randomUUID().slice(0, 8),
    });

    const res = await appAs('u-chat4').request('http://test/api/chat', {
      method: 'POST',
      headers: headers(s.id),
      body: body(),
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.runId).toBeTruthy();
    runResolve.current();
  });

  it('a resolved L2 approval does NOT block chat', async () => {
    const s = createSession('trader', 'u-chat5');
    const aid = 'resolved-' + s.id;
    recordPendingApproval({
      sessionId: s.id, level: 'L2', toolName: 'tag_document',
      input: {}, approvalId: aid,
    });
    resolveApproval(aid, 'approved');

    const res = await appAs('u-chat5').request('http://test/api/chat', {
      method: 'POST',
      headers: headers(s.id),
      body: body(),
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.runId).toBeTruthy();
    runResolve.current();
  });
});
