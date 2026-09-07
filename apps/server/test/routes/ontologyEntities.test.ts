// apps/server/test/routes/ontologyEntities.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
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

let ctx: DbContext;
beforeEach(() => {
  ctx = createDb(':memory:');
  migrate(ctx.sqlite);
  ctxHolder.current = ctx;
});

describe('GET /api/ontology/entities/:type', () => {
  it('401 without session', async () => {
    const app = new Hono<AuthEnv>();
    app.route('/api/ontology', ontologyRoute);
    const res = await app.request('http://test/api/ontology/entities/TradeContract');
    expect(res.status).toBe(401);
  });

  it('400 for type outside the registry whitelist', async () => {
    const res = await appAs('u1').request('http://test/api/ontology/entities/Nope');
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('unknown entity type');
  });

  it('400 for invalid pagination params', async () => {
    const res = await appAs('u1').request('http://test/api/ontology/entities/TradeContract?page=0');
    expect(res.status).toBe(400);
  });

  it('lists trade_facts entities scoped to the user', async () => {
    await insertTradeFact(ctx, {
      entityType: 'InvoiceEvent',
      payload: { invoiceNo: 'INV-1', invoiceType: '销项', eventBizType: '正向', amount: 10, currency: 'CNY' },
      validAt: '2026-06-15', createdBy: 'test',
    }, 'u1');
    const res = await appAs('u1').request('http://test/api/ontology/entities/InvoiceEvent?page=1&pageSize=10');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<{ label: string }>; total: number; page: number; pageSize: number };
    expect(body.total).toBe(1);
    expect(body.items[0]!.label).toBe('INV-1');
    expect(body.pageSize).toBe(10);
  });

  it('empty source type returns empty page, not error (acceptance 4)', async () => {
    const res = await appAs('u1').request('http://test/api/ontology/entities/TradeGoods');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: unknown[]; total: number };
    expect(body.items).toEqual([]);
    expect(body.total).toBe(0);
  });
});

describe('GET /api/ontology/entities/:type/:id (as-of detail)', () => {
  // 红冲两答案种子：原票 100 万 + 红冲 -100 万 + REVERSE_ORIGIN 边(8/5 入账)。
  const seedRedFlush = async () => {
    const originalId = await insertTradeFact(ctx, {
      entityType: 'InvoiceEvent',
      payload: { invoiceNo: 'INV-1', invoiceType: '销项', eventBizType: '正向', amount: 1_000_000, currency: 'CNY' },
      validAt: '2026-06-15', ingestedAt: '2026-06-16', createdBy: 'demo',
    }, 'u1');
    const reversalId = await insertTradeFact(ctx, {
      entityType: 'InvoiceEvent',
      payload: { invoiceNo: 'INV-1', invoiceType: '销项', eventBizType: '逆向', amount: -1_000_000, currency: 'CNY' },
      validAt: '2026-06-15', ingestedAt: '2026-08-05', createdBy: 'demo',
    }, 'u1');
    await insertOntologyEdge(ctx, {
      relation: 'REVERSE_ORIGIN', fromType: 'InvoiceEvent', fromId: reversalId,
      toType: 'InvoiceEvent', toId: originalId, params: { amount: 1_000_000 },
      validAt: '2026-06-15', ingestedAt: '2026-08-05', createdBy: 'demo',
    }, 'u1');
    return { originalId, reversalId };
  };

  it('red-flush two answers via API (acceptance 2)', async () => {
    const { originalId } = await seedRedFlush();

    const app = appAs('u1');
    const thenRes = await app.request(
      `http://test/api/ontology/entities/InvoiceEvent/${originalId}?asOf=system&at=2026-07-31T23:59:59.000Z`);
    expect(thenRes.status).toBe(200);
    const then = (await thenRes.json()) as { netAmount: number; timeline: unknown[] };
    expect(then.netAmount).toBe(1_000_000);
    expect(then.timeline).toHaveLength(1);

    const nowRes = await app.request(
      `http://test/api/ontology/entities/InvoiceEvent/${originalId}`);
    const now = (await nowRes.json()) as { netAmount: number; timeline: unknown[] };
    expect(now.netAmount).toBe(0);
    expect(now.timeline).toHaveLength(2);
  });

  it('404 unknown id; 400 invalid at', async () => {
    await seedRedFlush();
    const app = appAs('u1');
    const notFound = await app.request('http://test/api/ontology/entities/InvoiceEvent/TF-x');
    expect(notFound.status).toBe(404);
    const listRes = await app.request('http://test/api/ontology/entities/InvoiceEvent');
    const { items } = (await listRes.json()) as { items: Array<{ id: string }> };
    const bad = await app.request(
      `http://test/api/ontology/entities/InvoiceEvent/${items[0]!.id}?at=not-a-date`);
    expect(bad.status).toBe(400);
  });
});
