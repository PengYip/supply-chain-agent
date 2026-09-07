import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Hono } from 'hono';
import { createDb, migrate, type DbContext } from '../../src/pipeline/db/client.js';
import type { AuthEnv } from '../../src/lib/auth-middleware.js';

const { ctxHolder } = vi.hoisted(() => ({ ctxHolder: { current: null as DbContext | null } }));
vi.mock('../../src/pipeline/db/dbBackend.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../src/pipeline/db/dbBackend.js')>();
  return { ...mod, getDbContext: () => ctxHolder.current };
});
const { writeoffRoute } = await import('../../src/routes/writeoff.js');
const { insertTradeFact, insertOntologyEdge } = await import('../../src/ontology/repo.js');

function appAs(userId: string) {
  const app = new Hono<AuthEnv>();
  app.use('*', async (c, next) => {
    c.set('user', { id: userId, email: 't@t', role: 'trader' } as never);
    await next();
  });
  app.route('/api/writeoff', writeoffRoute);
  return app;
}

let ctx: DbContext;
beforeEach(() => {
  ctx = createDb(':memory:');
  migrate(ctx.sqlite);
  ctxHolder.current = ctx;
});

describe('GET /api/writeoff/overview', () => {
  it('401 without session', async () => {
    const app = new Hono<AuthEnv>();
    app.route('/api/writeoff', writeoffRoute);
    const res = await app.request('http://test/api/writeoff/overview');
    expect(res.status).toBe(401);
  });

  it('返回模式与两侧余额行', async () => {
    const p = await insertTradeFact(ctx, {
      entityType: 'PaymentEvent',
      payload: { eventBizType: '正向', amount: 100, currency: 'CNY', payType: '尾款' },
      validAt: '2026-06-01', createdBy: 'demo',
    }, 'u1');
    const inv = await insertTradeFact(ctx, {
      entityType: 'InvoiceEvent',
      payload: { eventBizType: '正向', amount: 100, currency: 'CNY', invoiceNo: 'INV-X', invoiceType: '进项' },
      validAt: '2026-06-02', createdBy: 'demo',
    }, 'u1');
    await insertOntologyEdge(ctx, {
      relation: 'WRITE_OFF', fromType: 'PaymentEvent', fromId: p, toType: 'InvoiceEvent', toId: inv,
      params: { amount: 30, partial: true }, validAt: '2026-07-01', createdBy: 'demo',
    }, 'u1');
    const res = await appAs('u1').request('http://test/api/writeoff/overview');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      modes: Array<{
        relation: string; funds: Array<{ remaining: number; status: string }>;
        targets: Array<{ label: string; applied: number }>;
      }>;
    };
    const wo = body.modes.find((m) => m.relation === 'WRITE_OFF')!;
    expect(wo.funds[0]!.remaining).toBe(70);
    expect(wo.funds[0]!.status).toBe('partial');
    expect(wo.targets[0]!.label).toBe('INV-X');
    expect(wo.targets[0]!.applied).toBe(30);
  });

  it('空数据不报错（空模式列表行）', async () => {
    const res = await appAs('u1').request('http://test/api/writeoff/overview');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { modes: unknown[] };
    expect(body.modes.map((m) => (m as { relation: string }).relation)).toEqual(['OFFSET_SETTLE', 'WRITE_OFF']);
  });
});