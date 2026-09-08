// 本体只读 REST 面(roadmap Item 3)：/schema + /entities 列表/详情 + /counts 实体计数(Item 8)。
// 挂载：index.ts `app.use('/api/ontology/*', requireAuth)` + `app.route('/api/ontology', ontologyRoute)`。
// 只读：本文件与 projection 层绝不写任何源表。
import { Hono } from 'hono';
import { z } from 'zod';
import type { AuthEnv } from '../lib/auth-middleware.js';
import { getDbContext } from '../pipeline/db/dbBackend.js';
import { ontologySchemaJson, OntologyEntityNameSchema, ENTITY_NAMES } from '../ontology/index.js';
import { listProjectedEntities, getProjectedEntityDetail } from '../ontology/projection.js';
import { getNeighbors } from '../ontology/neighbors.js';

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

/** GET /counts — 11 实体逐一实时计数(治理全景图节点数据源, roadmap Item 8)。
 *  复用 listProjectedEntities 的列表口径(total 含共享域与用户域)，不引入新计数 SQL。 */
ontologyRoute.get('/counts', async (c) => {
  const user = c.get('user')!;
  try {
    const ctx = getDbContext();
    const entries = await Promise.all(
      ENTITY_NAMES.map(async (name) => {
        const total = (await listProjectedEntities(ctx, name, {}, user.id)).total;
        return [name, total] as const;
      }),
    );
    return c.json({ counts: Object.fromEntries(entries) });
  } catch (e) {
    console.error('[ontology] counts failed:', errDetail(e));
    return c.json({ error: 'counts failed', detail: errDetail(e) }, 500);
  }
});

const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  q: z.string().trim().max(100).optional(),
  // 基础过滤(2026-09-08)：业务时间范围(YYYY-MM-DD, 含端点) + 金额范围(事件实体有效)。
  validFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  validTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  amountMin: z.coerce.number().optional(),
  amountMax: z.coerce.number().optional(),
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

const detailQuerySchema = z.object({
  asOf: z.enum(['business', 'system']).default('business'),
  at: z.string().optional(),
});

/** GET /entities/:type/:id — 详情 + as-of 时间切片(红冲轧差时间线)。 */
ontologyRoute.get('/entities/:type/:id', async (c) => {
  const user = c.get('user')!;
  const parsedType = OntologyEntityNameSchema.safeParse(c.req.param('type'));
  if (!parsedType.success) {
    return c.json({ error: 'unknown entity type', detail: 'type 必须是本体注册表 11 实体之一' }, 400);
  }
  const parsed = detailQuerySchema.safeParse(c.req.query());
  if (!parsed.success) {
    return c.json(
      { error: 'invalid query params', detail: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) },
      400,
    );
  }
  try {
    const detail = await getProjectedEntityDetail(
      getDbContext(), parsedType.data, c.req.param('id'),
      { mode: parsed.data.asOf, at: parsed.data.at }, user.id,
    );
    if (!detail) return c.json({ error: 'not found' }, 404);
    return c.json(detail);
  } catch (e) {
    // normalizeIsoUtc 对非法 at 抛 'asof: invalid datetime' -> 400
    if (e instanceof Error && e.message.startsWith('asof:')) {
      return c.json({ error: 'invalid at', detail: e.message }, 400);
    }
    console.error('[ontology] entity detail failed:', errDetail(e));
    return c.json({ error: 'detail failed', detail: errDetail(e) }, 500);
  }
});

const neighborsQuerySchema = z.object({
  type: OntologyEntityNameSchema,
  id: z.string().trim().min(1).max(200),
  depth: z.coerce.number().int().min(1).max(3).default(1),
});

/** GET /graph/neighbors — 链路穿透(roadmap Item 4)：本体边 BFS + 文档血缘锚点层融合。
 *  depth 上限 3 + 节点/边截断(防全图爆炸)；血缘不可用时优雅降级(D5)。
 *  truncated 仅反映本体侧截断；血缘部分由 graphQuery 深度独立限界。 */
ontologyRoute.get('/graph/neighbors', async (c) => {
  const user = c.get('user')!;
  const parsed = neighborsQuerySchema.safeParse(c.req.query());
  if (!parsed.success) {
    return c.json(
      { error: 'invalid query params', detail: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) },
      400,
    );
  }
  try {
    const res = await getNeighbors(getDbContext(), parsed.data, user.id);
    // 锚点未解析且零邻接 -> 404；悬空锚点但有边(如 Counterparty + PROVIDE)仍返回(D8)
    if (res.anchorNode.source === 'unresolved' && res.edges.length === 0 && !res.lineage.subjectFound) {
      return c.json({ error: 'not found' }, 404);
    }
    return c.json(res);
  } catch (e) {
    console.error('[ontology] neighbors failed:', errDetail(e));
    return c.json({ error: 'neighbors failed', detail: errDetail(e) }, 500);
  }
});
