// Phase 2: chat-session list / create / history API, scoped to the authenticated
// user (data isolation). These are APP sessions (chat conversations in
// sessionStore), NOT Better Auth login sessions -- the auth `user` on the context
// is the login identity; sessions are filtered/owned by user.id.
//
// Mounted at /api/sessions in index.ts. /api/sessions/:id/status (status.ts) is a
// distinct 3-segment path and does NOT conflict with /:id here.

import { Hono } from 'hono';
import { z } from 'zod';
import type { AuthEnv } from '../lib/auth-middleware.js';
import { requireRole } from '../lib/auth-middleware.js';
import {
  createSession,
  deleteSession,
  getSessionStatus,
  listSessionsForUser,
  loadSession,
  sessionBelongsTo,
} from '../harness/sessionStore.js';
import { subscribe } from '../harness/sessionEvents.js';
import type { Role } from '../harness/roleToolRegistry.js';

export const sessionsRoute = new Hono<AuthEnv>();

const CreateBody = z.object({
  role: z.enum(['trader']).default('trader'),
});

// List the current user's chat sessions (newest first).
// Phase 4 RBAC: admin/trader can manage sessions; viewer is read-only (list only).
sessionsRoute.get('/', requireRole('admin', 'trader', 'viewer'), (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'unauthorized' }, 401);
  const rows = listSessionsForUser(user.id);
  return c.json({
    sessions: rows.map((r) => ({ id: r.id, role: r.role, createdAt: r.createdAt, title: r.title })),
  });
});

// Create a new chat session owned by the current user.
// Phase 4 RBAC: only admin/trader may create sessions (viewer cannot).
sessionsRoute.post('/', requireRole('admin', 'trader'), async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'unauthorized' }, 401);
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    body = {};
  }
  const parsed = CreateBody.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'invalid body', detail: parsed.error.flatten() }, 400);
  }
  const info = createSession(parsed.data.role as Role, user.id);
  return c.json({ id: info.id, role: info.role }, 201);
});

// Get a session's messages -- only if the authenticated user owns it.
sessionsRoute.get('/:id', (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'unauthorized' }, 401);
  const id = c.req.param('id');
  if (!sessionBelongsTo(id, user.id)) {
    // 403 (not 404) would leak existence; use 404 to avoid confirming an id an
    // untrusted user does not own. Either is defensible -- 404 hides existence.
    return c.json({ error: 'not found' }, 404);
  }
  const loaded = loadSession(id);
  if (!loaded) return c.json({ error: 'not found' }, 404);
  return c.json({ id: loaded.id, role: loaded.role, messages: loaded.messages, title: loaded.title });
});

// Delete a session -- only if the authenticated user owns it. Also cascades to
// messages, pending approvals, and authorized tickets (see deleteSession).
// Returns 404 (existence hidden) for both unknown and not-owned ids.
// Phase 4 RBAC: only admin/trader may delete sessions (viewer cannot).
sessionsRoute.delete('/:id', requireRole('admin', 'trader'), (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'unauthorized' }, 401);
  const id = c.req.param('id');
  // Ownership check: distinguish not-found from forbidden. The brief asks for a
  // 403 'forbidden' on not-owned and a 404 'not_found' on missing.
  const loaded = loadSession(id);
  if (!loaded) return c.json({ error: 'not_found' }, 404);
  if (!sessionBelongsTo(id, user.id)) {
    return c.json({ error: 'forbidden' }, 403);
  }
  const removed = deleteSession(id);
  if (!removed) return c.json({ error: 'not_found' }, 404);
  return c.json({ ok: true });
});

// SSE event stream for a session. Subscribes to the in-memory event bus and
// fans out events. Client disconnect (req.signal abort) unsubscribes; the
// background run is unaffected (runs live in RunManager, not this request).
sessionsRoute.get('/:id/events', (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'unauthorized' }, 401);
  const id = c.req.param('id');
  if (!sessionBelongsTo(id, user.id)) {
    return c.json({ error: 'not found' }, 404);
  }

  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();
  // Catch on every write: after cleanup closes the writer, a late write (or a
  // write racing the client disconnect) must reject silently, never surface as
  // an unhandled rejection.
  const send = (obj: unknown) =>
    writer.write(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`)).catch(() => {});

  // First event: current status snapshot.
  const st = getSessionStatus(id);
  void send({ type: 'session.status', sessionId: id, status: st?.status ?? 'idle', runId: st?.runId });

  const unsub = subscribe(id, (e) => {
    void send(e);
  });

  const heartbeat = setInterval(() => {
    void writer.write(encoder.encode(`: heartbeat\n\n`)).catch(() => {});
  }, 10000);

  const cleanup = () => {
    unsub();
    clearInterval(heartbeat);
    void writer.close().catch(() => {});
  };
  // Client disconnect: Hono/node-server aborts req.raw.signal.
  c.req.raw.signal?.addEventListener('abort', cleanup);

  return new Response(readable, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    },
  });
});
