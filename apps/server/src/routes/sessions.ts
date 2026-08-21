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
  listSessionEventsSince,
  loadSession,
  purgeEmptySessionsForUser,
  sessionBelongsTo,
} from '../harness/sessionStore.js';
import { subscribe, type SessionEvent } from '../harness/sessionEvents.js';
import { abortSessionRun } from '../harness/runManager.js';
import type { Role } from '../harness/roleToolRegistry.js';

export const sessionsRoute = new Hono<AuthEnv>();

const CreateBody = z.object({
  role: z.enum(['trader']).default('trader'),
});

// List the current user's chat sessions (newest first).
// Phase 4 RBAC: admin/trader can manage sessions; viewer is read-only (list only).
sessionsRoute.get('/', requireRole('admin', 'trader', 'viewer'), async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'unauthorized' }, 401);
  const rows = await listSessionsForUser(user.id);
  return c.json({
    sessions: rows.map((r) => ({ id: r.id, role: r.role, createdAt: r.createdAt, title: r.title, status: r.status, favorited: r.favorited, messageCount: r.messageCount })),
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
  // A new session implies the previous one is done: drop the user's leftover
  // zero-message sessions so empties never accumulate (the sidebar hides them
  // anyway; this keeps the DB honest).
  await purgeEmptySessionsForUser(user.id);
  const info = await createSession(parsed.data.role as Role, user.id);
  return c.json({ id: info.id, role: info.role }, 201);
});

// Get a session's messages -- only if the authenticated user owns it.
sessionsRoute.get('/:id', async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'unauthorized' }, 401);
  const id = c.req.param('id');
  if (!(await sessionBelongsTo(id, user.id))) {
    // 403 (not 404) would leak existence; use 404 to avoid confirming an id an
    // untrusted user does not own. Either is defensible -- 404 hides existence.
    return c.json({ error: 'not found' }, 404);
  }
  const loaded = await loadSession(id);
  if (!loaded) return c.json({ error: 'not found' }, 404);
  return c.json({ id: loaded.id, role: loaded.role, messages: loaded.messages, title: loaded.title });
});

// Delete a session -- only if the authenticated user owns it. Also cascades to
// messages, pending approvals, and authorized tickets (see deleteSession).
// Returns 404 (existence hidden) for both unknown and not-owned ids.
// Phase 4 RBAC: only admin/trader may delete sessions (viewer cannot).
sessionsRoute.delete('/:id', requireRole('admin', 'trader'), async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'unauthorized' }, 401);
  const id = c.req.param('id');
  // Ownership check: distinguish not-found from forbidden. The brief asks for a
  // 403 'forbidden' on not-owned and a 404 'not_found' on missing.
  const loaded = await loadSession(id);
  if (!loaded) return c.json({ error: 'not_found' }, 404);
  if (!(await sessionBelongsTo(id, user.id))) {
    return c.json({ error: 'forbidden' }, 403);
  }
  const removed = await deleteSession(id);
  if (!removed) return c.json({ error: 'not_found' }, 404);
  return c.json({ ok: true });
});

// Abort an in-flight background run for a session. Signals the run's
// AbortController; the run decides how to unwind (AI SDK streamText propagates
// the abort to tool calls). Returns aborted=false when no run is in-flight.
// Phase 4 RBAC: only admin/trader may abort (same as delete).
sessionsRoute.post('/:id/abort', requireRole('admin', 'trader'), async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'unauthorized' }, 401);
  const id = c.req.param('id');
  if (!(await sessionBelongsTo(id, user.id))) return c.json({ error: 'not found' }, 404);
  const aborted = abortSessionRun(id);
  return c.json({ ok: true, aborted });
});

// SSE event stream for a session. Subscribes to the in-memory event bus and
// fans out events. Client disconnect (req.signal abort) unsubscribes; the
// background run is unaffected (runs live in RunManager, not this request).
// Every forwarded bus event carries an `id: <seq>` line (standard SSE reconnect
// protocol); on reconnect the browser resends Last-Event-ID and the server
// replays persisted events `seq > lastEventId` before continuing live.
sessionsRoute.get('/:id/events', async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'unauthorized' }, 401);
  const id = c.req.param('id');
  if (!(await sessionBelongsTo(id, user.id))) {
    return c.json({ error: 'not found' }, 404);
  }

  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();
  // Catch on every write: after cleanup closes the writer, a late write (or a
  // write racing the client disconnect) must reject silently.
  const sendRaw = (text: string) => writer.write(encoder.encode(text)).catch(() => {});
  const send = (obj: unknown, seq?: number) =>
    sendRaw(`${seq === undefined ? '' : `id: ${seq}\n`}data: ${JSON.stringify(obj)}\n\n`);

  // First event: current status snapshot. No id line — a snapshot is not a
  // log entry and must not advance the browser's lastEventId.
  const st = await getSessionStatus(id);
  void send({ type: 'session.status', sessionId: id, status: st?.status ?? 'idle', runId: st?.runId ?? null });

  // Reconnect replay: the browser resends the last seen id as Last-Event-ID.
  const rawId = c.req.header('Last-Event-ID');
  const sinceSeq = rawId !== undefined && /^\d+$/.test(rawId) ? Number(rawId) : null;

  // Buffer-mode subscribe before replaying from the DB, then drain with a
  // seq filter — closes the replay-vs-live race. (better-sqlite3 replay is
  // synchronous so the buffer is empty in practice today; the pattern stays
  // correct if the store ever becomes async.)
  const buffer: SessionEvent[] = [];
  let buffering = sinceSeq !== null;
  const unsub = subscribe(id, (e) => {
    if (buffering) {
      buffer.push(e);
      return;
    }
    void send(e, e.seq);
  });

  if (sinceSeq !== null) {
    try {
      const missed = await listSessionEventsSince(id, sinceSeq);
      let maxSent = sinceSeq;
      for (const row of missed) {
        // Prefer the DB columns (type/session_id) over payload-embedded
        // duplicates when reconstructing the event JSON — avoids divergence
        // if a row was ever written with a stale payload copy.
        void send({ ...row.payload, type: row.type, sessionId: id, seq: row.seq }, row.seq);
        maxSent = Math.max(maxSent, row.seq);
      }
      buffering = false;
      for (const e of buffer) {
        if ((e.seq ?? Number.POSITIVE_INFINITY) > maxSent) void send(e, e.seq);
      }
    } catch {
      // Replay unavailable (degraded persistence) — fall through to live.
      buffering = false;
      for (const e of buffer) void send(e, e.seq);
    }
    buffer.length = 0;
  }

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
