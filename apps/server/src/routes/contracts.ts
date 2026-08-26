// 合同搜索 REST 面(spec 2026-08-26 §4.1)。挂在 /api/contracts(requireAuth,
// index.ts)。只读; 供图谱页/绑定页搜索组合框共用。
import { Hono } from 'hono';
import { z } from 'zod';
import type { AuthEnv } from '../lib/auth-middleware.js';
import { getDbContext } from '../pipeline/db/dbBackend.js';
import { searchContractLedger } from '../pipeline/db/repositories.js';

export const contractsRoute = new Hono<AuthEnv>();

contractsRoute.use('*', async (c, next) => {
  if (!c.get('user')) return c.json({ error: 'unauthorized' }, 401);
  await next();
});

const searchSchema = z.object({
  q: z.string().trim().min(1, 'q 必填'),
  limit: z.coerce.number().int().min(1).max(20).default(10),
});

function errDetail(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** GET /search?q=&limit= — 台账模糊搜索(编号/买方/卖方/标题), 分组字段 matchedField。 */
contractsRoute.get('/search', async (c) => {
  const user = c.get('user')!;
  const parsed = searchSchema.safeParse(c.req.query());
  if (!parsed.success) {
    return c.json(
      { error: 'invalid query params', detail: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) },
      400,
    );
  }
  const { q, limit } = parsed.data;
  try {
    const items = await searchContractLedger(getDbContext(), q, user.id, limit);
    return c.json({ items });
  } catch (e) {
    console.error('[contracts] search failed:', errDetail(e));
    return c.json({ error: 'search failed', detail: errDetail(e) }, 500);
  }
});
