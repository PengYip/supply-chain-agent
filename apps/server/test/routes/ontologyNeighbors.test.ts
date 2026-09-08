// apps/server/test/routes/ontologyNeighbors.test.ts
import { describe, it, expect, beforeEach, vi, beforeAll, afterAll } from 'vitest';
import { Hono } from 'hono';
import { createDb, migrate, type DbContext } from '../../src/pipeline/db/client.js';
import type { AuthEnv } from '../../src/lib/auth-middleware.js';

const { ctxHolder } = vi.hoisted(() => ({ ctxHolder: { current: null as DbContext | null } }));
vi.mock('../../src/pipeline/db/dbBackend.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../src/pipeline/db/dbBackend.js')>();
  return { ...mod, getDbContext: () => ctxHolder.current };
});
const { ontologyRoute } = await import('../../src/routes/ontology.js');
const { insertTradeFact, insertOntologyEdge } = await import('../../src/ontology/repo.js');

function appAs(userId: string) {
  const app = new Hono<AuthEnv>();
  app.use('*', async (c, next) => {
    c.set('user', { id: userId, email: 't@t', role: 'trader' } as never);
    await next();
  });
  app.route('/api/ontology', ontologyRoute);
  return app;
}

// 路由测试与 Neo4j 解耦：强制走降级分支(D5)，lineage.available 恒 false
let savedPassword: string | undefined;
beforeAll(() => { savedPassword = process.env.NEO4J_PASSWORD; delete process.env.NEO4J_PASSWORD; });
afterAll(() => { if (savedPassword !== undefined) process.env.NEO4J_PASSWORD = savedPassword; });

let ctx: DbContext;
beforeEach(() => {
  ctx = createDb(':memory:');
  migrate(ctx.sqlite);
  ctxHolder.current = ctx;
});

const insertContract = (id: string, contractNo: string) => {
  ctx.sqlite.prepare(
    `INSERT INTO contract_ledger (id, contract_no, display_contract_no, doc_type, document_id,
        title, fields, field_meta, overall_confidence, needs_review, user_id, contract_type)
     VALUES (?, ?, ?, '合同', 'doc-1', '', '{}', '{}', 1, 0, '', '采购')`,
  ).run(id, contractNo, contractNo);
};

async function seedBridge() {
  insertContract('C1', 'HT-DEMO-001');
  const s = await insertTradeFact(ctx, {
    entityType: 'ServiceCostEvent',
    payload: { eventBizType: '正向', amount: 50_000, currency: 'CNY', costType: '物流' },
    validAt: '2026-06-01', createdBy: 'test',
  }, 'u1');
  const i = await insertTradeFact(ctx, {
    entityType: 'InvoiceEvent',
    payload: { invoiceNo: 'INV-L1', invoiceType: '销项', eventBizType: '正向', amount: 800_000, currency: 'CNY' },
    validAt: '2026-06-10', createdBy: 'test',
  }, 'u1');
  const p = await insertTradeFact(ctx, {
    entityType: 'PaymentEvent',
    payload: { eventBizType: '正向', amount: 300_000, currency: 'CNY', payType: '预付' },
    validAt: '2026-06-20', createdBy: 'test',
  }, 'u1');
  await insertOntologyEdge(ctx, {
    relation: 'ALLOCATE_TO', fromType: 'ServiceCostEvent', fromId: s,
    toType: 'TradeContract', toId: 'C1',
    params: { amount: 50_000, method: '金额' }, validAt: '2026-06-01', createdBy: 'test',
  }, 'u1');
  await insertOntologyEdge(ctx, {
    relation: 'CORRESPONDS_TO', fromType: 'ServiceCostEvent', fromId: s,
    toType: 'InvoiceEvent', toId: i, validAt: '2026-06-10', createdBy: 'test',
  }, 'u1');
  await insertOntologyEdge(ctx, {
    relation: 'TRIGGERS', fromType: 'ServiceCostEvent', fromId: s,
    toType: 'PaymentEvent', toId: p, validAt: '2026-06-20', createdBy: 'test',
  }, 'u1');
  return { s, i, p };
}

describe('GET /api/ontology/graph/neighbors', () => {
  it('401 without session', async () => {
    const app = new Hono<AuthEnv>();
    app.route('/api/ontology', ontologyRoute);
    const res = await app.request(
      'http://test/api/ontology/graph/neighbors?type=TradeContract&id=C1');
    expect(res.status).toBe(401);
  });

  it('400 for type outside registry / depth over cap (acceptance 4)', async () => {
    const app = appAs('u1');
    const badType = await app.request(
      'http://test/api/ontology/graph/neighbors?type=Nope&id=x');
    expect(badType.status).toBe(400);
    await seedBridge();
    const badDepth = await app.request(
      'http://test/api/ontology/graph/neighbors?type=TradeContract&id=C1&depth=4');
    expect(badDepth.status).toBe(400);
  });

  it('zod query asserts: depth omitted defaults to 1; depth=abc / id= empty are 400', async () => {
    await seedBridge();
    const app = appAs('u1');
    // depth 省略 -> 默认 1, 仍可解析合同锚点 -> 200
    const noDepth = await app.request(
      'http://test/api/ontology/graph/neighbors?type=TradeContract&id=C1');
    expect(noDepth.status).toBe(200);
    const noDepthBody = (await noDepth.json()) as { edges: unknown[] };
    expect(noDepthBody.edges).toHaveLength(1);   // depth=1 只到服务费桥 S
    // depth 非数字 -> coerce 失败 -> 400
    const abcDepth = await app.request(
      'http://test/api/ontology/graph/neighbors?type=TradeContract&id=C1&depth=abc');
    expect(abcDepth.status).toBe(400);
    // id 空串 -> trim().min(1) 失败 -> 400
    const emptyId = await app.request(
      'http://test/api/ontology/graph/neighbors?type=TradeContract&id=');
    expect(emptyId.status).toBe(400);
  });

  it('404 when anchor resolves to nothing and no adjacency', async () => {
    const res = await appAs('u1').request(
      'http://test/api/ontology/graph/neighbors?type=TradeContract&id=C-nope&depth=1');
    expect(res.status).toBe(404);
  });

  it('returns merged shape with lineage degraded (acceptance 1 through the API)', async () => {
    const { i, p } = await seedBridge();
    const res = await appAs('u1').request(
      'http://test/api/ontology/graph/neighbors?type=TradeContract&id=C1&depth=2');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      anchorNode: { label: string; source: string };
      nodes: Array<{ id: string; entityType: string }>;
      edges: Array<{ relation: string; origin: string }>;
      lineage: { available: boolean; subjectFound: boolean };
      truncated: boolean;
    };
    expect(body.anchorNode.label).toBe('HT-DEMO-001');
    expect(body.nodes.some((n) => n.id === i && n.entityType === 'InvoiceEvent')).toBe(true);
    expect(body.nodes.some((n) => n.id === p && n.entityType === 'PaymentEvent')).toBe(true);
    expect(body.edges.every((e) => e.origin === 'ontology')).toBe(true);
    expect(body.lineage).toEqual({ available: false, subjectFound: false, bridgesExpanded: 0 });
    expect(body.truncated).toBe(false);
  });

  it('user scoping through the route', async () => {
    await seedBridge();
    const res = await appAs('u2').request(
      'http://test/api/ontology/graph/neighbors?type=TradeContract&id=C1&depth=2');
    // 共享域合同可解析, 但 u1 的边不可见 -> 锚点可解析故 200, 零邻接
    expect(res.status).toBe(200);
    const body = (await res.json()) as { edges: unknown[] };
    expect(body.edges).toHaveLength(0);
  });
});