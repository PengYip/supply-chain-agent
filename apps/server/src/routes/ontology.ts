// 本体只读 REST 面(roadmap Item 3)：/schema + /entities 列表/详情。
// 挂载：index.ts `app.use('/api/ontology/*', requireAuth)` + `app.route('/api/ontology', ontologyRoute)`。
// 只读：本文件与 projection 层绝不写任何源表。
import { Hono } from 'hono';
import { z } from 'zod';
import type { AuthEnv } from '../lib/auth-middleware.js';
import { getDbContext } from '../pipeline/db/dbBackend.js';
import { ontologySchemaJson, OntologyEntityNameSchema } from '../ontology/index.js';
import { listProjectedEntities } from '../ontology/projection.js';

export const ontologyRoute = new Hono<AuthEnv>();

function errDetail(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

ontologyRoute.use('*', async (c, next) => {
  if (!c.get('user')) return c.json({ error: 'unauthorized' }, 401);
  await next();
});

/** GET /schema — 注册表纯 JSON 投影(台账列生成/类型列表的数据源)。 */
ontologyRoute.get('/schema', (c) => c.json(ontologySchemaJson()));

const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  q: z.string().trim().max(100).optional(),
});

/** GET /entities/:type — 只读投影列表(type 白名单=注册表 11 实体)。 */
ontologyRoute.get('/entities/:type', async (c) => {
  const user = c.get('user')!;
  const parsedType = OntologyEntityNameSchema.safeParse(c.req.param('type'));
  if (!parsedType.success) {
    return c.json({ error: 'unknown entity type', detail: 'type 必须是本体注册表 11 实体之一' }, 400);
  }
  const parsed = listQuerySchema.safeParse(c.req.query());
  if (!parsed.success) {
    return c.json(
      { error: 'invalid query params', detail: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) },
      400,
    );
  }
  try {
    const result = await listProjectedEntities(getDbContext(), parsedType.data, parsed.data, user.id);
    return c.json(result);
  } catch (e) {
    console.error('[ontology] entities list failed:', errDetail(e));
    return c.json({ error: 'list failed', detail: errDetail(e) }, 500);
  }
});
