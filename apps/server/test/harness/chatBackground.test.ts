import { describe, it, expect, vi, beforeEach } from 'vitest';
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
const { createSession } = await import('../../src/harness/sessionStore.js');

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
});
