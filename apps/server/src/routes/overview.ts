// apps/server/src/routes/overview.ts
// 总览工作台只读聚合面（roadmap Item 7, 2026-09-08）。
// 挂载：index.ts `app.use('/api/overview/*', requireAuth)` + `app.route('/api/overview', overviewRoute)`。
// HTTP 视图层：不进 roleToolRegistry，也不进 docs/tool-inventory.json（先例 /api/ontology/*）。
import { Hono } from 'hono';
import type { AuthEnv } from '../lib/auth-middleware.js';
import { env } from '../env.js';
import { getDbContext } from '../pipeline/db/dbBackend.js';
import { buildOverviewMetrics, cubePlaceholderPayload } from '../overview/metrics.js';

export const overviewRoute = new Hono<AuthEnv>();

overviewRoute.use('*', async (c, next) => {
  if (!c.get('user')) return c.json({ error: 'unauthorized' }, 401);
  await next();
});

overviewRoute.get('/', async (c) => {
  const user = c.get('user')!;
  const asOf = new Date().toISOString();
  if (env.METRICS_SOURCE === 'cube') {
    return c.json(cubePlaceholderPayload(asOf)); // 预留位：不触发本地聚合
  }
  try {
    return c.json(await buildOverviewMetrics(getDbContext(), user.id));
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    console.error('[overview] metrics failed:', detail);
    return c.json({ error: 'overview failed', detail }, 500);
  }
});
