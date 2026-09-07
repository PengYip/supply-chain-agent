// 本体只读 REST 面(roadmap Item 3)：/schema + /entities 列表/详情。
// 挂载：index.ts `app.use('/api/ontology/*', requireAuth)` + `app.route('/api/ontology', ontologyRoute)`。
// 只读：本文件与 projection 层绝不写任何源表。
import { Hono } from 'hono';
import type { AuthEnv } from '../lib/auth-middleware.js';
import { ontologySchemaJson } from '../ontology/index.js';

export const ontologyRoute = new Hono<AuthEnv>();

ontologyRoute.use('*', async (c, next) => {
  if (!c.get('user')) return c.json({ error: 'unauthorized' }, 401);
  await next();
});

/** GET /schema — 注册表纯 JSON 投影(台账列生成/类型列表的数据源)。 */
ontologyRoute.get('/schema', (c) => c.json(ontologySchemaJson()));
