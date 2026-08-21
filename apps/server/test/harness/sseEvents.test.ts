import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { sessionsRoute } from '../../src/routes/sessions.js';
import type { AuthEnv, SessionUser } from '../../src/lib/auth-middleware.js';
import { createSession, setSessionStatus } from '../../src/harness/sessionStore.js';
import { subscriberCount, emit } from '../../src/harness/sessionEvents.js';

// The SSE route reads the auth user via c.get('user') (attached by
// attachSession + requireAuth in production). sessionsRoute's handlers are all
// registered at import time, so a use() added to the imported route object now
// would compose AFTER those handlers and never run -- instead each test wraps
// sessionsRoute in a fresh outer Hono app whose injection middleware is
// registered BEFORE app.route(), the standard sub-app testing shape. This also
// avoids the module-level middleware accumulation the task brief warns about.
function appAs(user: SessionUser | null): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();
  app.use('*', async (c, next) => {
    c.set('user', user);
    await next();
  });
  app.route('/api/sessions', sessionsRoute);
  return app;
}

describe('GET /api/sessions/:id/events SSE', () => {
  it('streams text/event-stream, snapshots status, forwards emits, cleans up on disconnect', async () => {
    const s = await createSession('trader', 'sse-u1');
    await setSessionStatus(s.id, 'busy', 'run-sse');
    const app = appAs({ id: 'sse-u1', email: 'sse-u1@test', role: 'trader' });

    // The request carries an AbortSignal: aborting it is the client-disconnect
    // path the route listens for (c.req.raw.signal).
    const ac = new AbortController();
    const res = await app.request(
      new Request(`http://test/api/sessions/${s.id}/events`, { signal: ac.signal }),
    );

    try {
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('text/event-stream');

      // Subscription registered for this session.
      expect(subscriberCount(s.id)).toBeGreaterThanOrEqual(1);

      const reader = (res.body as ReadableStream<Uint8Array>).getReader();
      const decoder = new TextDecoder();

      // First event: current status snapshot.
      const first = decoder.decode((await reader.read()).value);
      expect(first).toContain('session.status');
      expect(first).toContain('busy');
      expect(first).toContain('run-sse');

      // An event emitted on the bus is forwarded onto the stream.
      await emit({ type: 'run.started', sessionId: s.id, runId: 'r2' });
      const second = decoder.decode((await reader.read()).value);
      expect(second).toContain('run.started');
      expect(second).toContain('r2');
    } finally {
      // Client disconnect -> cleanup (unsubscribe + clear heartbeat + close).
      ac.abort();
      await new Promise((r) => setTimeout(r, 30));
    }
    expect(subscriberCount(s.id)).toBe(0);
  });

  it('404 for a session not owned by the user', async () => {
    const s = await createSession('trader', 'owner-x');
    const app = appAs({ id: 'intruder', email: 'intruder@test', role: 'trader' });
    const res = await app.request(`http://test/api/sessions/${s.id}/events`);
    expect(res.status).toBe(404);
    expect(subscriberCount(s.id)).toBe(0);
  });
});
