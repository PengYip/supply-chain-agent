// Usage audit REST (spec docs/superpowers/specs/2026-08-31-usage-audit-design.md).
// Mounted at /api/audit in index.ts, gated by requireAuth: every logged-in
// user can see global usage (small internal tool, no role system yet).
import { Hono } from 'hono';
import type { AuthEnv } from '../lib/auth-middleware.js';
import { getDbContext } from '../pipeline/db/dbBackend.js';
import {
  usageAuditSummary, listLlmCalls, listOcrCalls,
} from '../harness/usageAudit.js';

export const auditRoute = new Hono<AuthEnv>();

function ctx() {
  return getDbContext();
}

const numParam = (v: string | undefined, def: number, max: number) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), max) : def;
};

/** GET /api/audit/summary?range=7d|30d — aggregate usage stats. */
auditRoute.get('/summary', async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'unauthorized' }, 401);
  const range = c.req.query('range') === '30d' ? 30 : 7;
  const summary = await usageAuditSummary(ctx(), range);
  return c.json(summary);
});

/** GET /api/audit/llm?limit&offset&kind&sessionId — recent LLM calls. */
auditRoute.get('/llm', async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'unauthorized' }, 401);
  const { rows, total } = await listLlmCalls(ctx(), {
    limit: numParam(c.req.query('limit'), 50, 200),
    offset: Math.max(Number(c.req.query('offset')) || 0, 0),
    kind: c.req.query('kind') || undefined,
    sessionId: c.req.query('sessionId') || undefined,
  });
  return c.json({ rows, total });
});

/** GET /api/audit/ocr?limit&offset&backend — recent parse/OCR calls. */
auditRoute.get('/ocr', async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'unauthorized' }, 401);
  const { rows, total } = await listOcrCalls(ctx(), {
    limit: numParam(c.req.query('limit'), 50, 200),
    offset: Math.max(Number(c.req.query('offset')) || 0, 0),
    backend: c.req.query('backend') || undefined,
  });
  return c.json({ rows, total });
});
