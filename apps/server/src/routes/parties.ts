// 自主体名单管理 REST 面(Task A)。挂在 /api/parties(requireAuth, index.ts)。
//
// 事故背景: env.SELF_PARTY_NAMES 未配置时六向执行流水静默跳过。本路由提供:
//   - GET   名单 = DB 行(source 'db') + env 名单中不在 DB 的部分(source 'env')
//           + 读时候选建议(从已有凭证确定性汇总, 不落库, 无 LLM)
//   - POST  新增名单(归一化去重); 新增成功后触发回填: 对白名单内、已有 confirmed
//           绑定、且尚无执行流水的文档重建流水
//   - DELETE 删除(按原始名精确匹配, URL-decode 后); 不追溯撤销已物化流水(设计如此)
//
// 名单租户全局(与 env 变量同域); 路由级 auth 中间件 + 每次调用取 fresh DbContext
// (与 bindings.ts 一致, 不做模块级单例缓存)。

import { Hono } from 'hono';
import { z } from 'zod';
import type { AuthEnv } from '../lib/auth-middleware.js';
import { getDbContext } from '../pipeline/db/dbBackend.js';
import type { DbContext } from '../pipeline/db/client.js';
import {
  listSelfParties,
  addSelfParty,
  removeSelfParty,
  listDocumentIdsWithConfirmedBindings,
  hasExecutionFlowsForDocument,
  getDocumentMeta,
} from '../pipeline/db/repositories.js';
import { getEffectiveSelfPartyNames, refreshExecutionFlowsForDocument } from '../pipeline/executionFlow.js';
import { buildSelfPartyCandidatesForUser } from '../pipeline/selfPartyCandidates.js';
import { normalizeCompanyName, parseSelfPartyNames } from '../domain/flowDirection.js';
import { env } from '../env.js';

export const partiesRoute = new Hono<AuthEnv>();

partiesRoute.use('*', async (c, next) => {
  if (!c.get('user')) return c.json({ error: 'unauthorized' }, 401);
  await next();
});

/** GET / — parties(DB + env) + envOnly + candidates。 */
partiesRoute.get('/', async (c) => {
  const user = c.get('user')!;
  const ctx = getDbContext();
  const [dbRows, effective] = await Promise.all([
    listSelfParties(ctx),
    getEffectiveSelfPartyNames(ctx),
  ]);
  const dbNorm = new Set(dbRows.map((r) => normalizeCompanyName(r.name)));
  const envNames = parseSelfPartyNames(env.SELF_PARTY_NAMES);
  const envOnly = envNames.filter((n) => !dbNorm.has(n));
  const parties = [
    ...dbRows.map((r) => ({ name: r.name, source: 'db' as const, createdAt: r.createdAt })),
    ...envOnly.map((n) => ({ name: n, source: 'env' as const, createdAt: null })),
  ];
  const candidates = await buildSelfPartyCandidatesForUser(ctx, user.id, effective);
  return c.json({ parties, envOnly, candidates });
});

const partyAddSchema = z.object({ name: z.string().min(1) });

/** POST / — {name} 新增名单; added=true 时触发流水回填。 */
partiesRoute.post('/', async (c) => {
  const user = c.get('user')!;
  const parsed = partyAddSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ ok: false, error: 'invalid_name' }, 400);
  const name = parsed.data.name;
  if (name.trim().length === 0 || normalizeCompanyName(name).length === 0) {
    return c.json({ ok: false, error: 'invalid_name' }, 400);
  }
  const ctx = getDbContext();
  const added = await addSelfParty(ctx, name, user.id);
  if (!added) {
    return c.json({ ok: true, added: false, refreshedFlows: 0, failed: 0 });
  }
  const { refreshedFlows, failed } = await backfillFlows(ctx, user.id);
  return c.json({ ok: true, added: true, refreshedFlows, failed });
});

/** DELETE /:name — URL-encoded 原始名精确删除; 不追溯撤销已物化流水。 */
partiesRoute.delete('/:name', async (c) => {
  const name = decodeURIComponent(c.req.param('name'));
  const removed = await removeSelfParty(getDbContext(), name);
  return c.json({ ok: true, removed });
});

// 六向流水白名单(与 FLOW_TYPE_BY_DOC_TYPE 语义一致; 此处为回填的 docType 前置,
// 不修改执行流水模块的映射或方向语义)。
const FLOW_DOCTYPES = new Set(['发票', '货转单', '付款凭证']);

/**
 * 回填: 对每个"持有 confirmed 绑定 + 白名单 docType + 尚无流水"的文档执行
 * refreshExecutionFlowsForDocument。refreshedFlows = 成功刷新的文档数,
 * failed = 抛出异常被按文档捕获的文档数(单文档失败不中断其余)。
 */
async function backfillFlows(
  ctx: DbContext,
  userId: string,
): Promise<{ refreshedFlows: number; failed: number }> {
  const docIds = await listDocumentIdsWithConfirmedBindings(ctx, userId);
  let refreshedFlows = 0;
  let failed = 0;
  for (const docId of docIds) {
    try {
      const meta = await getDocumentMeta(ctx, docId, userId);
      if (!meta || !meta.docType || !FLOW_DOCTYPES.has(meta.docType)) continue;
      if (await hasExecutionFlowsForDocument(ctx, docId, userId)) continue;
      await refreshExecutionFlowsForDocument(ctx, docId, userId);
      refreshedFlows += 1;
    } catch {
      failed += 1;
    }
  }
  return { refreshedFlows, failed };
}
