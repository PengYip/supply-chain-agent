import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Hono } from 'hono';
import type { AuthEnv } from '../../src/lib/auth-middleware.js';
import { createDb, migrate, type DbContext } from '../../src/pipeline/db/client.js';
import { ensureTemplateSeed } from '../../src/pipeline/templateSeed.js';
import { saveBinding, createDocumentStub } from '../../src/pipeline/db/repositories.js';

const { ctxHolder, syncCalls, removeCalls, materializeMock, retractMock } = vi.hoisted(() => ({
  ctxHolder: { current: null as DbContext | null },
  syncCalls: [] as Array<Record<string, unknown>>,
  removeCalls: [] as Array<Record<string, unknown>>,
  materializeMock: vi.fn<() => Promise<unknown>>(async () => null),
  retractMock: vi.fn<() => Promise<unknown>>(async () => undefined),
}));
vi.mock('../../src/pipeline/db/dbBackend.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../src/pipeline/db/dbBackend.js')>();
  return { ...mod, getDbContext: () => ctxHolder.current };
});
// 捕获 syncBindingEdge/removeBindingEdge 入参(路由无 io 注入点, 经模块 mock 断言 dstKind)。
vi.mock('../../src/pipeline/bindingGraphSync.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../src/pipeline/bindingGraphSync.js')>();
  return {
    ...mod,
    syncBindingEdge: async (input: Record<string, unknown>) => {
      syncCalls.push(input);
      return { outcome: 'ok' as const };
    },
    removeBindingEdge: async (input: Record<string, unknown>) => {
      removeCalls.push(input);
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
  removeCalls.length = 0;
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

describe('bindings route Project target', () => {
  it('Project 提案 confirm 同步到 Project 节点(dstKind=Project)', async () => {
    const { docId } = await createDocumentStub(ctx, { sourceUri: 'file:///l.pdf', docType: '立项书' });
    const bindingId = await saveBinding(ctx, {
      documentId: docId, contractNo: 'PRJ-1', relation: '立项',
      sourceRefs: [], confidence: 0.9, createdBy: 'system',
      status: 'proposed', proposedBy: 'system', evidence: null, targetKind: 'Project',
    }, 'u1');
    const res = await appAs('u1').request('/api/bindings/confirm', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bindingId }),
    });
    expect(res.status).toBe(200);
    const call = syncCalls.find((c) => c.bindingId === bindingId);
    expect(call?.dstKind).toBe('Project');
  });

  it('/unbind 删 Project binds 边(dstKind=Project)', async () => {
    const { docId } = await createDocumentStub(ctx, { sourceUri: 'file:///l2.pdf', docType: '立项书' });
    const bindingId = await saveBinding(ctx, {
      documentId: docId, contractNo: 'PRJ-2', relation: '立项',
      sourceRefs: [], confidence: 1, createdBy: 'agent',
      status: 'confirmed', confirmationSource: 'human', targetKind: 'Project',
    }, 'u1');
    const res = await appAs('u1').request('/api/bindings/unbind', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bindingId }),
    });
    expect(res.status).toBe(200);
    expect(removeCalls[0]?.dstKind).toBe('Project');
  });
});