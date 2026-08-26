import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Hono } from 'hono';
import type { AuthEnv } from '../../src/lib/auth-middleware.js';
import { createDb, migrate, type DbContext } from '../../src/pipeline/db/client.js';
import {
  createDocumentStub, saveBinding, upsertContractLedgerEntry,
} from '../../src/pipeline/db/repositories.js';
import { ensureTemplateSeed } from '../../src/pipeline/templateSeed.js';

const { ctxHolder, syncCalls } = vi.hoisted(() => ({
  ctxHolder: { current: null as DbContext | null },
  syncCalls: [] as Array<Record<string, unknown>>,
}));
vi.mock('../../src/pipeline/db/dbBackend.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../src/pipeline/db/dbBackend.js')>();
  return { ...mod, getDbContext: () => ctxHolder.current };
});
// 捕获 syncBindingEdge 入参(路由无 io 注入点, 经模块 mock 断言 templateVersion 透传)。
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
  delete process.env.NEO4J_PASSWORD;
});
afterEach(() => {
  if (prevPwd === undefined) delete process.env.NEO4J_PASSWORD;
  else process.env.NEO4J_PASSWORD = prevPwd;
});

/** 建立合同实体锚点: 合同类型文件绑定 + 台账行(合同类型=采购), 满足业务顺序门禁。 */
async function establishContract(contractNo: string): Promise<void> {
  const { docId } = await createDocumentStub(ctx, { sourceUri: 'file:///c.pdf', docType: '合同' });
  await saveBinding(ctx, {
    documentId: docId, contractNo, relation: '引用', sourceRefs: [],
    confidence: 1, createdBy: 'agent', status: 'confirmed', confirmationSource: 'human',
  }, 'u1');
  await upsertContractLedgerEntry(ctx, {
    contractNo, displayContractNo: contractNo, docType: '合同', documentId: docId,
    title: '', contractType: '采购', fields: {}, fieldMeta: {},
    overallConfidence: 1, needsReview: false, userId: 'u1',
  }, 'u1');
}

describe('bindings template guard', () => {
  it('禁用全部 binds 规则后, create 绑定被 409 拒绝且原因可读', async () => {
    await establishContract('HT-1');
    const { docId } = await createDocumentStub(ctx, { sourceUri: 'file:///h.pdf', docType: '化验报告' });
    ctx.sqlite.prepare("UPDATE template_edge_rules SET is_active = 0 WHERE edge_type = 'binds'").run();
    const res = await appAs('u1').request('/api/bindings', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ documentId: docId, contractNo: 'HT-1', relation: '质检' }),
    });
    expect(res.status).toBe(409);
    const data = await res.json() as { error: string; guard?: string };
    expect(data.error).toContain('不允许');
    expect(data.guard).toBe('template');
  });

  it('种子兜底在位时, 现有合法组合照常通过(行为零变化)', async () => {
    await establishContract('HT-2');
    const { docId } = await createDocumentStub(ctx, { sourceUri: 'file:///h2.pdf', docType: '化验报告' });
    const res = await appAs('u1').request('/api/bindings', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ documentId: docId, contractNo: 'HT-2', relation: '质检' }),
    });
    expect(res.status).toBe(200);
  });

  it('成功绑定的 binds 边带 templateVersion(经 io 注入断言)', async () => {
    await establishContract('HT-3');
    const { docId } = await createDocumentStub(ctx, { sourceUri: 'file:///h3.pdf', docType: '化验报告' });
    const res = await appAs('u1').request('/api/bindings', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ documentId: docId, contractNo: 'HT-3', relation: '质检' }),
    });
    expect(res.status).toBe(200);
    const call = syncCalls.find((c) => c.bindingId);
    expect(call?.templateVersion).toBeGreaterThanOrEqual(1);
  });
});