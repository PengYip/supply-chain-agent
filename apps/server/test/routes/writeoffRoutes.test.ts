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
vi.mock('../../src/harness/runSession.js', () => ({
  runSession: vi.fn(async () => {}),
}));
const { createSession, loadSession } = await import('../../src/harness/sessionStore.js');
const { runSession } = await import('../../src/harness/runSession.js');
const { buildWriteoffInstruction } = await import('../../src/routes/writeoff.js');

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

describe('buildWriteoffInstruction', () => {
  it('含逐字 JSON、工具名与场景关键词（settlement 命中）', () => {
    const items = [{ srcId: 'TF-p1', dstId: 'TF-i1', amount: 60, partial: true }];
    const text = buildWriteoffInstruction('WRITE_OFF', items);
    expect(text).toContain('create_writeoff');
    expect(text).toContain(JSON.stringify(items));
    expect(text).toContain('核销');
    expect(text).toContain('禁止修改');
  });
});

describe('POST /api/writeoff/submit', () => {
  const post = (app: Hono<AuthEnv>, body: unknown) =>
    app.request('http://test/api/writeoff/submit', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });

  it('401 without session', async () => {
    const app = new Hono<AuthEnv>();
    app.route('/api/writeoff', writeoffRoute);
    const res = await post(app, { relation: 'WRITE_OFF', items: [] });
    expect(res.status).toBe(401);
  });

  it('400 zod：空 items / 非法 relation', async () => {
    const app = appAs('u1');
    expect((await post(app, { relation: 'WRITE_OFF', items: [] })).status).toBe(400);
    expect((await post(app, { relation: 'NOPE', items: [{ srcId: 'a', dstId: 'b', amount: 1 }] })).status).toBe(400);
  });

  it('400 守恒预检：超额返回 violations，不建会话不启 run', async () => {
    const p = await insertTradeFact(ctx, {
      entityType: 'PaymentEvent',
      payload: { eventBizType: '正向', amount: 100, currency: 'CNY', payType: '预付' },
      validAt: '2026-06-01', createdBy: 'demo',
    }, 'u1');
    const inv = await insertTradeFact(ctx, {
      entityType: 'InvoiceEvent',
      payload: { eventBizType: '正向', amount: 60, currency: 'CNY', invoiceNo: 'INV-C', invoiceType: '进项' },
      validAt: '2026-06-02', createdBy: 'demo',
    }, 'u1');
    (runSession as ReturnType<typeof vi.fn>).mockClear();
    const res = await post(appAs('u1'), {
      relation: 'WRITE_OFF',
      items: [{ srcId: p, dstId: inv, amount: 70 }],
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; violations: Array<{ code: string }> };
    expect(body.error).toBe('allocation_violations');
    expect(body.violations.map((v) => v.code)).toContain('dst_over_remaining');
    expect(runSession).not.toHaveBeenCalled();
  });

  it('200：建会话+注标题+追加逐字指令+启动后台 run', async () => {
    const p = await insertTradeFact(ctx, {
      entityType: 'PaymentEvent',
      payload: { eventBizType: '正向', amount: 100, currency: 'CNY', payType: '尾款' },
      validAt: '2026-06-01', createdBy: 'demo',
    }, 'u1');
    const inv = await insertTradeFact(ctx, {
      entityType: 'InvoiceEvent',
      payload: { eventBizType: '正向', amount: 60, currency: 'CNY', invoiceNo: 'INV-D', invoiceType: '进项' },
      validAt: '2026-06-02', createdBy: 'demo',
    }, 'u1');
    (runSession as ReturnType<typeof vi.fn>).mockClear();
    const res = await post(appAs('u1'), {
      relation: 'WRITE_OFF',
      items: [{ srcId: p, dstId: inv, amount: 60 }],
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sessionId: string; runId: string; status: string };
    expect(body.status).toBe('busy');
    expect(body.sessionId).toBeTruthy();
    // run 以提交用户身份启动
    expect(runSession).toHaveBeenCalledTimes(1);
    const opts = (runSession as ReturnType<typeof vi.fn>).mock.calls[0]![0] as {
      userId?: string; messages: Array<{ role: string; content: unknown }>;
    };
    expect(opts.userId).toBe('u1');
    // 首条消息即逐字指令：直接断言原始 content（外层 JSON.stringify 会转义引号）
    const first = opts.messages[0] as { role: string; content: string };
    expect(first.role).toBe('user');
    expect(first.content).toContain('create_writeoff');
    expect(first.content).toContain('"amount":60');
    // 会话标题已设 + 指令作为首条消息持久化
    const session = await loadSession(body.sessionId);
    expect(session?.title).toContain('核销');
    const persisted = JSON.stringify(session?.messages ?? []);
    expect(persisted).toContain('create_writeoff');
  });
});