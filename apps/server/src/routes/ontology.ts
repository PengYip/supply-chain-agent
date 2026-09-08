// 本体只读 REST 面(roadmap Item 3)：/schema + /entities 列表/详情 + /counts 实体计数(Item 8)。
// 2026-09-08 增补主数据登记直写端点：POST /master-data（表单入口第二个客户端），
// 直调 insertTradeFact 唯一写入边界——主数据非资金事实，不走 agent 会话不加 L2 工具。
// 2026-09-09 增补 POST /graph/sync 本体图谱回填——写 Neo4j 投影，不写任何源表；
// 成功路径附带 fire-and-forget 图投影（syncOntologyGraphSafe）。
import { Hono } from 'hono';
import { z } from 'zod';
import type { AuthEnv } from '../lib/auth-middleware.js';
import { getDbContext } from '../pipeline/db/dbBackend.js';
import {
  ontologySchemaJson, OntologyEntityNameSchema, ENTITY_NAMES, entitySchema,
} from '../ontology/index.js';
import { listProjectedEntities, getProjectedEntityDetail } from '../ontology/projection.js';
import { getNeighbors } from '../ontology/neighbors.js';
import { insertTradeFact } from '../ontology/repo.js';
import { syncOntologyGraph, syncOntologyGraphSafe } from '../ontology/graphSync.js';
import {
  CreateMasterDataInputSchema, commodityCodeGateError, masterDataFormSchemaJson,
} from '../ontology/masterData.js';
import { fieldLevelErrors } from '../lib/zodFieldErrors.js';

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

/** GET /master-data/schema — 主数据登记表单投影（字段反射自注册表 3 类静态实体）。 */
ontologyRoute.get('/master-data/schema', (c) => c.json(masterDataFormSchemaJson()));

/** POST /master-data — 主数据登记直写端点（商品/交易对手/内部组织）。
 *  校验链：inputSchema strict（字段级报错）-> 注册表 entitySchema strict（各实体
 *  必填/词汇权威校验）-> 商品码词汇门禁（COMMODITY_CODES 非空时收紧）-> insertTradeFact
 *  唯一写入边界（createdBy='manual' 溯源）。成功后台账列表/详情即时可见。 */
ontologyRoute.post('/master-data', async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'unauthorized' }, 401);

  let json: unknown;
  try { json = await c.req.json(); } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }
  const parsed = CreateMasterDataInputSchema.strict().safeParse(json);
  if (!parsed.success) {
    return c.json({ error: 'invalid_body', detail: fieldLevelErrors(parsed.error) }, 400);
  }
  const { entityType, validAt, ...payload } = parsed.data;

  // 注册表权威预检（快速失败，省一次失败写入）：各实体 strict schema（必填/实体词汇边界）。
  const entityCheck = entitySchema(entityType).safeParse(payload);
  if (!entityCheck.success) {
    return c.json({ error: 'invalid_master_data', detail: fieldLevelErrors(entityCheck.error) }, 400);
  }
  // 商品码词汇门禁：v1 词汇为空 => 自由填写（见 index.ts COMMODITY_CODES 注释）。
  if (entityType === 'TradeGoods' && typeof payload['commodityCode'] === 'string') {
    const gate = commodityCodeGateError(payload['commodityCode']);
    if (gate) {
      return c.json({
        error: 'invalid_master_data',
        detail: { formErrors: [gate], fieldErrors: { commodityCode: [gate] } },
      }, 400);
    }
  }

  try {
    const id = await insertTradeFact(
      getDbContext(),
      { entityType, payload, validAt: validAt ?? new Date(), createdBy: 'manual' },
      user.id,
    );
    // 落账成功后图投影 fire-and-forget(spec 2026-09-09): 永不阻塞登记主流程。
    void syncOntologyGraphSafe(getDbContext(), user.id);
    return c.json({ id, entityType });
  } catch (e) {
    console.error('[ontology] master-data write failed:', errDetail(e));
    return c.json({ error: 'master-data write failed', detail: errDetail(e) }, 500);
  }
});

/** POST /graph/sync — 本体图谱手动全量回填(spec 2026-09-09)：trade_facts/ontology_edges
 *  最新业务口径幂等投影到 Neo4j（事实节点 + 带参关系 + prune 收敛）。图未配置
 *  （NEO4J_PASSWORD 未设）返回 {status:'skipped'}；存量数据一次性收敛入口。 */
ontologyRoute.post('/graph/sync', async (c) => {
  const user = c.get('user')!;
  try {
    const result = await syncOntologyGraph({ ctx: getDbContext(), userId: user.id });
    return c.json(result);
  } catch (e) {
    console.error('[ontology] graph sync failed:', errDetail(e));
    return c.json({ error: 'graph sync failed', detail: errDetail(e) }, 500);
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
