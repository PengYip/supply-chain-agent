import { Hono } from 'hono';
import { getSessionStatus } from '../harness/statusAggregator.js';

export const statusRoute = new Hono();

// GET /api/sessions/:id/status -> AgentStatus snapshot for the frontend
// status bar to poll (the "signal" dimension of the tool-context contract,
// made visible). Mounted under the same /api prefix as the chat route.
statusRoute.get('/sessions/:id/status', (c) => {
  const id = c.req.param('id');
  try {
    return c.json(getSessionStatus(id));
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
