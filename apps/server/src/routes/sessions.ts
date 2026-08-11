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
  listSessionsForUser,
  loadSession,
  sessionBelongsTo,
} from '../harness/sessionStore.js';
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
    sessions: rows.map((r) => ({ id: r.id, role: r.role, createdAt: r.createdAt })),
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
  return c.json({ id: loaded.id, role: loaded.role, messages: loaded.messages });
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
