import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Hono } from 'hono';
import { createDb, migrate, type DbContext } from '../../src/pipeline/db/client.js';
import type { AuthEnv } from '../../src/lib/auth-middleware.js';
import { insertTradeFact, insertOntologyEdge } from '../../src/ontology/repo.js';

// 沿 writeoffRoutes.test.ts 范式: mock dbBackend.getDbContext -> ctxHolder。
const { ctxHolder } = vi.hoisted(() => ({ ctxHolder: { current: null as DbContext | null } }));
vi.mock('../../src/pipeline/db/dbBackend.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../src/pipeline/db/dbBackend.js')>();
  return { ...mod, getDbContext: () => ctxHolder.current };
});
const { ontologyRoute } = await import('../../src/routes/ontology.js');

function appAs(userId: string) {
  const app = new Hono<AuthEnv>();
  app.use('*', async (c, next) => {
    c.set('user', { id: userId, email: 't@t', role: 'trader' } as never);
    await next();
  });
  app.route('/api/ontology', ontologyRoute);
  return app;
}

let ctx: DbContext;
beforeEach(() => {
  ctx = createDb(':memory:');
  migrate(ctx.sqlite);
  ctxHolder.current = ctx;
});

const insertContract = (id: string, contractNo: string, contractType: string) => {
  ctx.sqlite.prepare(
    `INSERT INTO contract_ledger (id, contract_no, display_contract_no, doc_type, document_id,
        title, fields, field_meta, overall_confidence, needs_review, user_id, contract_type)
     VALUES (?, ?, ?, '合同', 'doc-1', '', '{}', '{}', 1, 0, '', ?)`,
  ).run(id, contractNo, contractNo, contractType);
};

describe('GET /api/ontology/gaps (business-loop wave4)', () => {
  it('200 形状: 空库也返回 scope/tiles/groups/checks 四键', async () => {
    const res = await appAs('u1').request('http://test/api/ontology/gaps');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      scope: string; tiles: unknown[]; groups: unknown[]; checks: string[];
    };
    expect(body.scope).toBe('all');
    expect(Array.isArray(body.tiles)).toBe(true);
    expect(Array.isArray(body.groups)).toBe(true);
    expect(Array.isArray(body.checks)).toBe(true);
    expect(body.tiles).toHaveLength(4);
  });

  it('projectNo 透传: 无匹配合同 -> 200 scope 反映 projectNo, 不报错', async () => {
    const res = await appAs('u1').request('http://test/api/ontology/gaps?projectNo=PRJ-NOPE');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { scope: string; tiles: Array<{ key: string; qty?: number | null; amt?: number | null }> };
    expect(body.scope).toBe('PRJ-NOPE');
    // 无合同在范围内 -> 存货 tile qty 为 0(空集聚合)
    expect(body.tiles.find((t) => t.key === 'stock')?.qty).toBe(0);
  });

  it('聚合异常 -> 500 {error, detail}(注入坏 ctx)', async () => {
    // ctxHolder.current 置 null -> computeGaps 抛 TypeError -> 500
    ctxHolder.current = null as never;
    const res = await appAs('u1').request('http://test/api/ontology/gaps');
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string; detail: string };
    expect(body.error).toBe('gaps compute failed');
    expect(body.detail.length).toBeGreaterThan(0);
  });

  it('seed 最小金标准子集 -> tiles/items 有数字(端到端)', async () => {
    insertContract('CL-1', 'CON-0817', '采购');
    const receipt = await insertTradeFact(ctx, {
      entityType: 'GoodsReceiptEvent',
      payload: { eventBizType: '正向', quantity: 1600, amount: 3_200_000, currency: 'CNY', unit: '吨' },
      validAt: '2026-09-01T00:00:00Z', createdBy: 'golden',
    }, 'u1');
    await insertOntologyEdge(ctx, {
      relation: 'ALLOCATE_TO', fromType: 'GoodsReceiptEvent', fromId: receipt,
      toType: 'TradeContract', toId: 'CL-1',
      params: { quantity: 1600, method: '数量' }, validAt: '2026-09-01T00:00:00Z', createdBy: 'golden',
    }, 'u1');
    const res = await appAs('u1').request('http://test/api/ontology/gaps');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      tiles: Array<{ key: string; qty?: number | null }>;
      groups: Array<{ items: Array<{ code: string; amt?: number | null }> }>;
    };
    expect(body.tiles.find((t) => t.key === 'stock')?.qty).toBe(1600);
    const all = body.groups.flatMap((g) => g.items);
    expect(all.find((i) => i.code === '②')?.amt).toBe(3_200_000); // 购收 3.2M − 购结算 0
  });
});
