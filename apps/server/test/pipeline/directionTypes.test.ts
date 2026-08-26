import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Hono } from 'hono';
import type { AuthEnv } from '../../src/lib/auth-middleware.js';
import { createDb, migrate, type DbContext } from '../../src/pipeline/db/client.js';
import { ensureTemplateSeed } from '../../src/pipeline/templateSeed.js';
import {
  listActiveEdgeRules, listTemplateTypes, createDocumentStub, saveBinding, upsertContractLedgerEntry,
} from '../../src/pipeline/db/repositories.js';

const ctx = createDb();
beforeEach(async () => { migrate(ctx.sqlite); await ensureTemplateSeed(ctx); });

describe('direction-encoded types', () => {
  it('种子激活后 收货单/发货单/进项票/销项票 settles 规则生效', async () => {
    const rules = await listActiveEdgeRules(ctx);
    const byId = new Map((await listTemplateTypes(ctx)).map((t) => [t.id, t.name]));
    const active = rules.filter((r) => r.edgeType === 'settles' && r.isActive);
    const srcNames = active.map((r) => byId.get(r.sourceTypeId));
    expect(srcNames).toContain('收货单');
    expect(srcNames).toContain('发货单');
    expect(srcNames).toContain('进项票');
    expect(srcNames).toContain('销项票');
    const shouhuo = active.find((r) => byId.get(r.sourceTypeId) === '收货单');
    expect(shouhuo?.allowedVocab).toEqual(['收货']);
  });
});

// ---- 路由层: syncSettlesByType(方向编码类型落 settles 边) + 交叉验证不阻断 ----
const { ctxHolder, settlesCalls, materializeMock } = vi.hoisted(() => ({
  ctxHolder: { current: null as DbContext | null },
  settlesCalls: [] as Array<Record<string, unknown>>,
  materializeMock: vi.fn<() => Promise<unknown>>(async () => null),
}));
vi.mock('../../src/pipeline/db/dbBackend.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../src/pipeline/db/dbBackend.js')>();
  return { ...mod, getDbContext: () => ctxHolder.current };
});
// 捕获 syncSettlesEdge 入参(路由无 io 注入点, 经模块 mock 断言 relation/direction)。
vi.mock('../../src/pipeline/settlesGraphSync.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../src/pipeline/settlesGraphSync.js')>();
  return {
    ...mod,
    syncSettlesEdge: async (input: Record<string, unknown>) => {
      settlesCalls.push(input);
      return { outcome: 'ok' as const };
    },
  };
});
// 桩掉 materializeExecutionFlow: 收货单(白名单外)返回 null; 付款凭证返回受控流水。
vi.mock('../../src/pipeline/executionFlow.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../src/pipeline/executionFlow.js')>();
  return { ...mod, materializeExecutionFlow: materializeMock };
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

let routeCtx: DbContext;
const prevPwd = process.env.NEO4J_PASSWORD;
beforeEach(async () => {
  routeCtx = createDb(':memory:');
  migrate(routeCtx.sqlite);
  await ensureTemplateSeed(routeCtx);
  ctxHolder.current = routeCtx;
  settlesCalls.length = 0;
  materializeMock.mockReset();
  materializeMock.mockResolvedValue(null);
  delete process.env.NEO4J_PASSWORD;
});
afterEach(() => {
  if (prevPwd === undefined) delete process.env.NEO4J_PASSWORD;
  else process.env.NEO4J_PASSWORD = prevPwd;
});

/** 建立合同实体锚点: 合同类型文件绑定 + 台账行(合同类型=采购), 满足业务顺序门禁。 */
async function establishContract(contractNo: string): Promise<void> {
  const { docId } = await createDocumentStub(routeCtx, { sourceUri: 'file:///c.pdf', docType: '合同' });
  await saveBinding(routeCtx, {
    documentId: docId, contractNo, relation: '引用', sourceRefs: [],
    confidence: 1, createdBy: 'agent', status: 'confirmed', confirmationSource: 'human',
  }, 'u1');
  await upsertContractLedgerEntry(routeCtx, {
    contractNo, displayContractNo: contractNo, docType: '合同', documentId: docId,
    title: '', contractType: '采购', fields: {}, fieldMeta: {},
    overallConfidence: 1, needsReview: false, userId: 'u1',
  }, 'u1');
}

describe('bindings settles 方向编码类型', () => {
  it('收货单确认绑定后 settles 边带 relation=收货(类型方向路径)', async () => {
    await establishContract('HT-SH');
    const { docId } = await createDocumentStub(routeCtx, { sourceUri: 'file:///sh.pdf', docType: '收货单' });
    const res = await appAs('u1').request('/api/bindings', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ documentId: docId, contractNo: 'HT-SH', relation: '收货' }),
    });
    expect(res.status).toBe(200);
    const call = settlesCalls.find((c) => c.relation === '收货');
    expect(call?.direction).toBe('in');
  });

  it('付款凭证派生 relation 与词表一致照常同步(交叉验证不阻断)', async () => {
    await establishContract('HT-FK');
    const { docId } = await createDocumentStub(routeCtx, { sourceUri: 'file:///fk.pdf', docType: '付款凭证' });
    materializeMock.mockResolvedValue({ flowId: 'F1', flowType: '资金流', direction: 'in', amount: 100 });
    const res = await appAs('u1').request('/api/bindings', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ documentId: docId, contractNo: 'HT-FK', relation: '付款' }),
    });
    expect(res.status).toBe(200);
    // 派生 relation=收款(资金流 in), 在 付款凭证 词表 [收款,付款] 内 -> 照常同步。
    const call = settlesCalls.find((c) => c.relation === '收款');
    expect(call?.direction).toBe('in');
  });
});