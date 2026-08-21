import { Hono } from 'hono';
import { getSessionStatus } from '../harness/statusAggregator.js';
import { sessionBelongsTo } from '../harness/sessionStore.js';
import type { AuthEnv } from '../lib/auth-middleware.js';

export const statusRoute = new Hono<AuthEnv>();

// GET /api/sessions/:id/status -> AgentStatus snapshot for the frontend
// status bar to poll (the "signal" dimension of the tool-context contract,
// made visible). Mounted under the same /api prefix as the chat route.
//
// Phase 2: data isolation -- when an authenticated user is attached (the
// production path; /api/sessions/* is requireAuth-gated in index.ts), the
// session must belong to them or we 404. When no user is attached (legacy/test
// path that bypasses the middleware) the check is skipped so pre-Phase-2 callers
// keep working, mirroring the repository-layer "no userId -> no filter" rule.
statusRoute.get('/sessions/:id/status', async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  if (user && !(await sessionBelongsTo(id, user.id))) {
    return c.json({ error: 'not found' }, 404);
  }
  try {
    return c.json(await getSessionStatus(id));
  } catch (e) {
    return c.json(
      {
        error: 'status failed',
        detail: e instanceof Error ? e.message : String(e),
      },
      500,
    );
  }
});
