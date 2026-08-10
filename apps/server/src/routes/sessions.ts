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
import {
  createSession,
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
sessionsRoute.get('/', (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'unauthorized' }, 401);
  const rows = listSessionsForUser(user.id);
  return c.json({
    sessions: rows.map((r) => ({ id: r.id, role: r.role, createdAt: r.createdAt })),
  });
});

// Create a new chat session owned by the current user.
sessionsRoute.post('/', async (c) => {
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
