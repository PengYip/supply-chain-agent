// 对账桥 REST(spec 2026-08-25 方案A §5/§6)。Mounted at /api/reconcile in
// index.ts, gated by requireAuth。
//   POST /run         — 全量对账(R1/R2/R3): DB 物化 + 图属性回写 + 完整报告。
//   GET  /report      — 报表数据源(前端看板页消费)。与 /run 同源: 内部即
//                       reconcileAll, 调用会刷新用量物化与图属性——幂等可重放。
import { Hono } from 'hono';
import type { AuthEnv } from '../lib/auth-middleware.js';
import { getDbContext } from '../pipeline/db/dbBackend.js';
import { reconcileAll } from '../pipeline/reconciliation.js';

export const reconciliationRoute = new Hono<AuthEnv>();

/** POST /api/reconcile/run — 全量对账报告。 */
reconciliationRoute.post('/run', async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'unauthorized' }, 401);
  const report = await reconcileAll(getDbContext(), user.id);
  return c.json(report);
});

/** GET /api/reconcile/report — 对账报表(幂等, 副作用即产物)。 */
reconciliationRoute.get('/report', async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'unauthorized' }, 401);
  const report = await reconcileAll(getDbContext(), user.id);
  return c.json(report);
});
