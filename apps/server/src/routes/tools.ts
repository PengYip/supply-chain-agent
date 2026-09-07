// apps/server/src/routes/tools.ts
// 治理后台只读 HTTP 面（roadmap Item 6, 2026-09-08）：工具 inventory 视图 +
// 权限快照。挂载：index.ts `app.use('/api/tools/*', requireAuth)` +
// `app.route('/api/tools', toolsRoute)`。
// 注意：这是 HTTP 视图层，不是 agent 工具——不进 roleToolRegistry，也不进
// docs/tool-inventory.json（先例：/api/ontology/* 同样无 inventory 条目）。
import { Hono } from 'hono';
import type { AuthEnv } from '../lib/auth-middleware.js';
import { buildToolInventoryView } from '../harness/toolInventoryView.js';
import { listPermissions, TOOL_PERMISSION_LEVELS } from '../harness/permissionGate.js';

export const toolsRoute = new Hono<AuthEnv>();

toolsRoute.use('*', async (c, next) => {
  if (!c.get('user')) return c.json({ error: 'unauthorized' }, 401);
  await next();
});

/** GET /inventory — docs/tool-inventory.json × 注册表实测挂载对比。 */
toolsRoute.get('/inventory', (c) => {
  try {
    return c.json(buildToolInventoryView());
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    console.error('[tools] inventory view failed:', detail);
    return c.json({ error: 'inventory view failed', detail }, 500);
  }
});

/** GET /permissions — permissionGate 注册声明快照（治理后台权限矩阵数据源）。 */
toolsRoute.get('/permissions', (c) => {
  return c.json({
    source: 'apps/server/src/harness/permissionGate.ts',
    levels: TOOL_PERMISSION_LEVELS,
    entries: listPermissions(),
    note:
      '未注册工具经 getPermission 兜底为 L1（不在此快照内）；' +
      'L3 当前无注册工具：资金/不可逆操作走 escalate_to_human 工单（该工具本身 L1），经审批中心回调复核。',
  });
});
