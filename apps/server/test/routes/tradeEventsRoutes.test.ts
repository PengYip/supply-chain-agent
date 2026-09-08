import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Hono } from 'hono';
import { createDb, migrate, type DbContext } from '../../src/pipeline/db/client.js';
import type { AuthEnv } from '../../src/lib/auth-middleware.js';

const { ctxHolder } = vi.hoisted(() => ({ ctxHolder: { current: null as DbContext | null } }));
vi.mock('../../src/pipeline/db/dbBackend.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../src/pipeline/db/dbBackend.js')>();
  return { ...mod, getDbContext: () => ctxHolder.current };
});
const { tradeEventsRoute } = await import('../../src/routes/tradeEvents.js');
vi.mock('../../src/harness/runSession.js', () => ({
  runSession: vi.fn(async () => {}),
}));
const { loadSession } = await import('../../src/harness/sessionStore.js');
const { runSession } = await import('../../src/harness/runSession.js');
const { buildTradeEventInstruction } = await import('../../src/routes/tradeEvents.js');
const { detectScenario } = await import('../../src/harness/scenarios.js');
const { buildStatusMessage } = await import('../../src/harness/agentStatus.js');

function appAs(userId: string) {
  const app = new Hono<AuthEnv>();
  app.use('*', async (c, next) => {
    c.set('user', { id: userId, email: 't@t', role: 'trader' } as never);
    await next();
  });
  app.route('/api/trade-events', tradeEventsRoute);
  return app;
}

let ctx: DbContext;
beforeEach(() => {
  ctx = createDb(':memory:');
  migrate(ctx.sqlite);
  ctxHolder.current = ctx;
});

describe('GET /api/trade-events/schema', () => {
  it('401 without session', async () => {
    const app = new Hono<AuthEnv>();
    app.route('/api/trade-events', tradeEventsRoute);
    const res = await app.request('http://test/api/trade-events/schema');
    expect(res.status).toBe(401);
  });

  it('字段投影反射 inputSchema：枚举取注册表闭枚举值', async () => {
    const res = await appAs('u1').request('http://test/api/trade-events/schema');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      tool: string;
      fields: Array<{ name: string; kind: string; required: boolean; options?: string[]; formDefault?: unknown }>;
    };
    expect(body.tool).toBe('create_trade_event');
    const byName = new Map(body.fields.map((f) => [f.name, f]));
    expect(byName.get('entityType')!.kind).toBe('enum');
    expect(byName.get('entityType')!.options).toContain('PaymentEvent');
    expect(byName.get('eventBizType')!.options).toEqual(['正向', '逆向']);
    expect(byName.get('payType')!.options).toEqual(['预付', '尾款', '进度款', '质保金']);
    expect(byName.get('amount')!.kind).toBe('number');
    expect(byName.get('amount')!.required).toBe(true);
    expect(byName.get('invoiceNo')!.required).toBe(false);
    expect(byName.get('currency')!.formDefault).toBe('CNY');
  });
});

describe('buildTradeEventInstruction', () => {
  it('含逐字 JSON、工具名与场景关键词（settlement 命中）', () => {
    const input = {
      entityType: 'PaymentEvent' as const, eventBizType: '正向' as const,
      amount: 300000, currency: 'CNY', validAt: '2026-06-25', payType: '预付' as const,
    };
    const text = buildTradeEventInstruction(input);
    expect(text).toContain('create_trade_event');
    expect(text).toContain(JSON.stringify(input));
    expect(text).toContain('结算');
    expect(text).toContain('禁止修改');
  });
});

describe('POST /api/trade-events', () => {
  const post = (app: Hono<AuthEnv>, body: unknown) =>
    app.request('http://test/api/trade-events', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });

  const validInput = {
    entityType: 'PaymentEvent', eventBizType: '正向',
    amount: 300000, currency: 'CNY', validAt: '2026-06-25', payType: '预付',
  };

  it('401 without session', async () => {
    const app = new Hono<AuthEnv>();
    app.route('/api/trade-events', tradeEventsRoute);
    const res = await post(app, validInput);
    expect(res.status).toBe(401);
  });

  it('400 inputSchema strict：未知字段/非法枚举，字段级报错且不建会话不启 run', async () => {
    const app = appAs('u1');
    (runSession as ReturnType<typeof vi.fn>).mockClear();
    const res1 = await post(app, { ...validInput, phantomField: 1 });
    expect(res1.status).toBe(400);
    const bad1 = (await res1.json()) as { error: string; detail: { fieldErrors: Record<string, string[]> } };
    expect(bad1.error).toBe('invalid_body');
    expect(Object.keys(bad1.detail.fieldErrors)).toContain('phantomField');
    const res2 = await post(app, { ...validInput, entityType: 'NopeEvent' });
    expect(res2.status).toBe(400);
    const bad2 = (await res2.json()) as { error: string; detail: { fieldErrors: Record<string, string[]> } };
    expect(Object.keys(bad2.detail.fieldErrors)).toContain('entityType');
    expect(runSession).not.toHaveBeenCalled();
  });

  it('400 注册表语义预检：逆向金额为正，整单拒绝不启 run', async () => {
    const app = appAs('u1');
    (runSession as ReturnType<typeof vi.fn>).mockClear();
    const res = await post(app, { ...validInput, eventBizType: '逆向' });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; detail: { fieldErrors: Record<string, string[]> } };
    expect(body.error).toBe('invalid_event');
    expect(Object.keys(body.detail.fieldErrors)).toContain('amount');
    expect(runSession).not.toHaveBeenCalled();
  });

  it('200：建会话+注标题+追加逐字指令+启动后台 run，返回工单号', async () => {
    const app = appAs('u1');
    (runSession as ReturnType<typeof vi.fn>).mockClear();
    const res = await post(app, validInput);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ticketId: string; sessionId: string; runId: string; status: string };
    expect(body.status).toBe('busy');
    expect(body.ticketId).toBeTruthy();
    expect(body.sessionId).toBeTruthy();
    // run 以提交用户身份启动；场景必须显式 settlement（见下方回归 describe），
    // 否则首轮 create_trade_event 不可见，模型只能 escalate_to_human 兜底。
    expect(runSession).toHaveBeenCalledTimes(1);
    const opts = (runSession as ReturnType<typeof vi.fn>).mock.calls[0]![0] as {
      userId?: string; auditTraceId?: string; scenario?: string; messages: Array<{ role: string; content: unknown }>;
    };
    expect(opts.userId).toBe('u1');
    expect(opts.scenario).toBe('settlement');
    expect(opts.auditTraceId).toBe(body.ticketId);
    // 首条消息即逐字指令：直接断言原始 content（外层 JSON.stringify 会转义引号）
    const first = opts.messages[0] as { role: string; content: string };
    expect(first.role).toBe('user');
    expect(first.content).toContain('create_trade_event');
    expect(first.content).toContain('"amount":300000');
    expect(first.content).toContain('"payType":"预付"');
    // 会话标题已设 + 指令作为首条消息持久化
    const session = await loadSession(body.sessionId);
    expect(session?.title).toContain('事件登记');
    const persisted = JSON.stringify(session?.messages ?? []);
    expect(persisted).toContain('create_trade_event');
  });
});

describe('场景挂载回归（为何后台 run 必须显式传 scenario）', () => {
  it('首轮生效的末尾用户文本是 <agent_status> 快照而非指令：detectScenario 对其落 entry，自动检测不可依赖', () => {
    // runStream 会把 role:'user' 的状态快照追加到轨迹尾部（agentStatus.ts），而
    // detectScenario(lastUserText) 只扫末尾 user 消息 —— 状态文本的「待复核抽取」
    // 被 ENTRY_RE 的「复核」命中落 entry（非 settlement），create_trade_event 在
    // entry/qa 场景都不可见（dev 2026-09-08 事故根因），故后台 run 必须显式传场景。
    const status = buildStatusMessage({
      toolCounts: [], totalCalls: 0, pendingApprovals: 0, docsIngested: 0, extractionsPendingReview: 0,
    });
    expect(status.role).toBe('user');
    expect(detectScenario(typeof status.content === 'string' ? status.content : '')).toBe('entry');
  });

  it('指令文本本身命中 settlement：审批恢复轮（skipStatusMessage）仍靠它路由，模板关键词不可删', () => {
    const instruction = buildTradeEventInstruction({
      entityType: 'PaymentEvent', eventBizType: '正向',
      amount: 300000, currency: 'CNY', validAt: '2026-06-25', payType: '预付',
    });
    expect(detectScenario(instruction)).toBe('settlement');
  });
});
