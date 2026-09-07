// 核销工作台路由（roadmap Item 5）：GET /overview 只读聚合。
// 挂载：index.ts `app.use('/api/writeoff/*', requireAuth)` + `app.route('/api/writeoff', writeoffRoute)`。
// 独立文件（与 Item 4 并行分区约定：不改 routes/ontology.ts）。
import { Hono } from 'hono';
import type { AuthEnv } from '../lib/auth-middleware.js';
import { getDbContext } from '../pipeline/db/dbBackend.js';
import { getWriteoffOverview } from '../ontology/writeoff.js';

export const writeoffRoute = new Hono<AuthEnv>();

writeoffRoute.use('*', async (c, next) => {
  if (!c.get('user')) return c.json({ error: 'unauthorized' }, 401);
  await next();
});

writeoffRoute.get('/overview', async (c) => {
  const user = c.get('user')!;
  try {
    const overview = await getWriteoffOverview(getDbContext(), user.id);
    return c.json(overview);
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    console.error('[writeoff] overview failed:', detail);
    return c.json({ error: 'overview failed', detail }, 500);
  }
});