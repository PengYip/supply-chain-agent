// 额度管控 REST(spec 2026-08-25 方案A §6)。Mounted at /api/quotas in index.ts,
// gated by requireAuth。quotas 表是 SSOT; granted 边/Quota 节点是投影
// (quotaGraphSync best-effort, NEO4J_PASSWORD 未设 -> skipped, 业务不受阻)。
// create/patch 后立即单条重算占用(reconcileQuotaOne)——前端拿到的
// used/overLimit 永远是刚算过的。
import { Hono } from 'hono';
import { z } from 'zod';
import type { AuthEnv } from '../lib/auth-middleware.js';
import { getDbContext } from '../pipeline/db/dbBackend.js';
import type { DbContext } from '../pipeline/db/client.js';
import {
  saveQuota, findQuotaById, listQuotas, updateQuota,
} from '../pipeline/db/repositories.js';
import type { QuotaScope } from '../domain/tradeSemantics.js';
import { syncQuotaGraph, removeQuotaGrantedEdge } from '../pipeline/quotaGraphSync.js';
import { reconcileQuotaOne } from '../pipeline/reconciliation.js';

export const quotasRoute = new Hono<AuthEnv>();

function ctx(): DbContext {
  return getDbContext();
}

const createSchema = z.object({
  scope: z.enum(['counterparty', 'project'] satisfies [QuotaScope, QuotaScope]),
  ownerKey: z.string().min(1, 'ownerKey 必填'),
  ownerLabel: z.string().max(200).optional(),
  limitAmount: z.number().positive('limitAmount 必须为正数'),
  currency: z.string().max(10).optional(),
  period: z.string().max(50).optional(),
});

/** POST /api/quotas — 创建 + 图投影 + 即时占用重算。 */
quotasRoute.post('/', async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'unauthorized' }, 401);
  const parsed = createSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: 'invalid body', detail: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) }, 400);
  }
  const db = ctx();
  const { scope, ownerKey, ownerLabel, limitAmount, currency, period } = parsed.data;
  const quotaId = await saveQuota(db, {
    scope, ownerKey, ownerLabel: ownerLabel ?? '', limitAmount,
    currency: currency ?? null, period: period ?? null, createdBy: user.id,
  }, user.id);
  const sync = await syncQuotaGraph({
    quotaId, scope, ownerKey, ownerLabel: ownerLabel ?? '',
    limitAmount, currency: currency ?? null, period: period ?? null,
  });
  const row = await findQuotaById(db, quotaId, user.id);
  const usage = row ? await reconcileQuotaOne(db, row) : { used: 0, remaining: limitAmount, overLimit: false };
  return c.json({ ok: true, quotaId, graphSync: sync.outcome, ...usage });
});

/** GET /api/quotas — 当前用户 active 额度(含 DB 已物化 used/computedAt)。 */
quotasRoute.get('/', async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'unauthorized' }, 401);
  const rows = await listQuotas(ctx(), { userId: user.id });
  return c.json({ quotas: rows });
});

const patchSchema = z.object({
  limitAmount: z.number().positive().optional(),
  currency: z.string().max(10).nullable().optional(),
  period: z.string().max(50).nullable().optional(),
});

/** PATCH /api/quotas/:id — 字段更新 + Quota 节点重投影 + 占用重算。 */
quotasRoute.patch('/:id', async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'unauthorized' }, 401);
  const parsed = patchSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'invalid body' }, 400);
  const id = c.req.param('id');
  const db = ctx();
  const row = await findQuotaById(db, id, user.id);
  if (!row || row.status !== 'active') return c.json({ error: 'quota not found', id }, 404);
  const ok = await updateQuota(db, id, parsed.data, user.id);
  if (!ok) return c.json({ error: 'quota update failed', id }, 409);
  const fresh = await findQuotaById(db, id, user.id);
  if (!fresh) return c.json({ error: 'quota not found', id }, 404);
  const sync = await syncQuotaGraph({
    quotaId: fresh.id, scope: fresh.scope, ownerKey: fresh.ownerKey, ownerLabel: fresh.ownerLabel,
    limitAmount: fresh.limitAmount, currency: fresh.currency, period: fresh.period,
  });
  const usage = await reconcileQuotaOne(db, fresh);
  return c.json({ ok: true, quotaId: id, graphSync: sync.outcome, ...usage });
});

const idSchema = z.object({ id: z.string().min(1) });

/** POST /api/quotas/:id/deactivate — status->inactive + granted 边移除
 *  (Quota 节点保留作历史)。幂等: 重复 deactivate 返回 ok。 */
quotasRoute.post('/:id/deactivate', async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'unauthorized' }, 401);
  const parsed = idSchema.safeParse({ id: c.req.param('id') });
  if (!parsed.success) return c.json({ error: 'invalid id' }, 400);
  const db = ctx();
  const row = await findQuotaById(db, parsed.data.id, user.id);
  if (!row) return c.json({ error: 'quota not found', id: parsed.data.id }, 404);
  if (row.status === 'active') {
    const ok = await updateQuota(db, row.id, { status: 'inactive' }, user.id);
    if (!ok) return c.json({ error: 'quota update failed', id: row.id }, 409);
  }
  const sync = await removeQuotaGrantedEdge({
    quotaId: row.id, scope: row.scope, ownerKey: row.ownerKey,
  });
  return c.json({ ok: true, quotaId: row.id, graphSync: sync.outcome });
});
