// apps/server/test/routes/ontologyCounts.test.ts
// GET /api/ontology/counts(治理全景图数据源, roadmap Item 8)：形状 + 共享域种子可见。
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
const { insertTradeFact } = await import('../../src/ontology/repo.js');
const { ENTITY_NAMES } = await import('../../src/ontology/index.js');

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

describe('GET /api/ontology/counts', () => {
  it('401 without session', async () => {
    const app = new Hono<AuthEnv>();
    app.route('/api/ontology', ontologyRoute);
    const res = await app.request('http://test/api/ontology/counts');
    expect(res.status).toBe(401);
  });

  it('returns a number for every registry entity (shape)', async () => {
    const res = await appAs('u1').request('http://test/api/ontology/counts');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { counts: Record<string, number> };
    expect(Object.keys(body.counts).sort()).toEqual([...ENTITY_NAMES].sort());
    for (const name of ENTITY_NAMES) {
      expect(typeof body.counts[name]).toBe('number');
      expect(body.counts[name]).toBeGreaterThanOrEqual(0);
    }
  });

  it('seeded facts are visible in counts, unseeded types stay 0', async () => {
    await insertTradeFact(ctx, {
      entityType: 'InvoiceEvent',
      payload: { invoiceNo: 'INV-1', invoiceType: '销项', eventBizType: '正向', amount: 10, currency: 'CNY' },
      validAt: '2026-06-15', createdBy: 'test',
    }, 'u1');
    await insertTradeFact(ctx, {
      entityType: 'InvoiceEvent',
      payload: { invoiceNo: 'INV-2', invoiceType: '进项', eventBizType: '正向', amount: 5, currency: 'CNY' },
      validAt: '2026-06-16', createdBy: 'test',
    }, 'u1');
    const res = await appAs('u1').request('http://test/api/ontology/counts');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { counts: Record<string, number> };
    expect(body.counts.InvoiceEvent).toBe(2);
    expect(body.counts.PaymentEvent).toBe(0);
    expect(body.counts.TradeContract).toBe(0);
  });

  it('reflects red-flush net口径 as raw fact count (list口径一致性)', async () => {
    // 与台账列表同口径：counts 数 = listProjectedEntities total，含逆向(负数)事实行。
    await insertTradeFact(ctx, {
      entityType: 'InvoiceEvent',
      payload: { invoiceNo: 'INV-1', invoiceType: '销项', eventBizType: '正向', amount: 1_000_000, currency: 'CNY' },
      validAt: '2026-06-15', createdBy: 'demo',
    }, 'u1');
    await insertTradeFact(ctx, {
      entityType: 'InvoiceEvent',
      payload: { invoiceNo: 'INV-1', invoiceType: '销项', eventBizType: '逆向', amount: -1_000_000, currency: 'CNY' },
      validAt: '2026-06-15', createdBy: 'demo',
    }, 'u1');
    const app = appAs('u1');
    const countRes = await app.request('http://test/api/ontology/counts');
    const listRes = await app.request('http://test/api/ontology/entities/InvoiceEvent');
    const countBody = (await countRes.json()) as { counts: Record<string, number> };
    const listBody = (await listRes.json()) as { total: number };
    expect(countBody.counts.InvoiceEvent).toBe(listBody.total);
    expect(countBody.counts.InvoiceEvent).toBe(2);
  });
});
