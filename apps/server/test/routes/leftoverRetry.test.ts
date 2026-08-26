import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Hono } from 'hono';
import type { AuthEnv } from '../../src/lib/auth-middleware.js';
import { createDb, migrate, type DbContext } from '../../src/pipeline/db/client.js';
import { ensureTemplateSeed } from '../../src/pipeline/templateSeed.js';
import { createDocumentStub, saveBinding, setBindingGraphStatus } from '../../src/pipeline/db/repositories.js';

const { ctxHolder, syncCalls, materializeMock, retractMock } = vi.hoisted(() => ({
  ctxHolder: { current: null as DbContext | null },
  syncCalls: [] as Array<Record<string, unknown>>,
  materializeMock: vi.fn<() => Promise<unknown>>(async () => null),
  retractMock: vi.fn<() => Promise<unknown>>(async () => undefined),
}));
vi.mock('../../src/pipeline/db/dbBackend.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../src/pipeline/db/dbBackend.js')>();
  return { ...mod, getDbContext: () => ctxHolder.current };
});
// 捕获 syncBindingEdge 入参(路由无 io 注入点, 经模块 mock 断言 templateVersion)。
vi.mock('../../src/pipeline/bindingGraphSync.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../src/pipeline/bindingGraphSync.js')>();
  return {
    ...mod,
    syncBindingEdge: async (input: Record<string, unknown>) => {
      syncCalls.push(input);
      return { outcome: 'ok' as const };
    },
  };
});
vi.mock('../../src/pipeline/executionFlow.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../src/pipeline/executionFlow.js')>();
  return { ...mod, materializeExecutionFlow: materializeMock, retractExecutionFlow: retractMock };
});
const { bindingsRoute } = await import('../../src/routes/bindings.js');

function appAs(userId: string) {
  const app = new Hono<AuthEnv>();
  app.use('*', async (c, next) => {
    c.set('user', { id: userId, email: 't@t', role: 'trader' } as never);
    await next();
  });
  app.route('/api/bindings', bindingsRoute);
  return app;
}

let ctx: DbContext;
const prevPwd = process.env.NEO4J_PASSWORD;
beforeEach(async () => {
  ctx = createDb(':memory:');
  migrate(ctx.sqlite);
  await ensureTemplateSeed(ctx);
  ctxHolder.current = ctx;
  syncCalls.length = 0;
  materializeMock.mockReset();
  materializeMock.mockResolvedValue(null);
  retractMock.mockReset();
  retractMock.mockResolvedValue(undefined);
  delete process.env.NEO4J_PASSWORD;
});
afterEach(() => {
  if (prevPwd === undefined) delete process.env.NEO4J_PASSWORD;
  else process.env.NEO4J_PASSWORD = prevPwd;
});

describe('bindings confirmed retry templateVersion', () => {
  it('confirmed 行 graph_status=failed 后 POST / 重试, syncBindingEdge 入参含 templateVersion', async () => {
    const { docId } = await createDocumentStub(ctx, { sourceUri: 'file:///fk.pdf', docType: '付款凭证' });
    const bindingId = await saveBinding(ctx, {
      documentId: docId, contractNo: 'HT-1', relation: '付款',
      sourceRefs: [], confidence: 1, createdBy: 'agent',
      status: 'confirmed', confirmationSource: 'human',
    }, 'u1');
    await setBindingGraphStatus(ctx, bindingId, { status: 'failed', reason: 'boom', syncedAt: '2026-08-26T00:00:00Z' }, 'u1');
    const res = await appAs('u1').request('/api/bindings', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ documentId: docId, contractNo: 'HT-1', relation: '付款' }),
    });
    expect(res.status).toBe(200);
    const call = syncCalls.find((c) => c.bindingId === bindingId);
    expect(call?.templateVersion).toBeGreaterThanOrEqual(1);
  });
});