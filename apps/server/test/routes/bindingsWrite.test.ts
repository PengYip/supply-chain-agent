import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Hono } from 'hono';
import type { AuthEnv } from '../../src/lib/auth-middleware.js';
import { createDb, migrate, type DbContext } from '../../src/pipeline/db/client.js';
import {
  createDocumentStub, saveBinding, findBindingById,
} from '../../src/pipeline/db/repositories.js';

const { ctxHolder } = vi.hoisted(() => ({ ctxHolder: { current: null as DbContext | null } }));
vi.mock('../../src/pipeline/db/dbBackend.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../src/pipeline/db/dbBackend.js')>();
  return { ...mod, getDbContext: () => ctxHolder.current };
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
beforeEach(() => {
  ctx = createDb(':memory:');
  migrate(ctx.sqlite);
  ctxHolder.current = ctx;
  // 图同步默认 io 会在 NEO4J_PASSWORD 存在时连真实 Neo4j; 测试环境显式无密码,
  // 让所有写端点走 skipped 路径(业务写不被图同步阻塞)。
  delete process.env.NEO4J_PASSWORD;
});
afterEach(() => {
  if (prevPwd === undefined) delete process.env.NEO4J_PASSWORD;
  else process.env.NEO4J_PASSWORD = prevPwd;
});

describe('POST /api/bindings/confirm|reject|unbind|batch-confirm', () => {
  async function seedProposed(): Promise<string> {
    const { docId } = await createDocumentStub(ctx, { sourceUri: 'file:///v.pdf', docType: '付款凭证' });
    return saveBinding(ctx, {
      documentId: docId, contractNo: 'HT-1', relation: '付款',
      sourceRefs: [], confidence: 0.9, createdBy: 'system',
      status: 'proposed', proposedBy: 'system', evidence: null,
    }, 'u1');
  }

  it('confirm: proposed->confirmed(human), 无 Neo4j -> graphSync=skipped 且 graph_status 落库', async () => {
    const bindingId = await seedProposed();
    const res = await appAs('u1').request('/api/bindings/confirm', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bindingId }),
    });
    expect(res.status).toBe(200);
    const data = await res.json() as { graphSync: string };
    expect(data.graphSync).toBe('skipped');
    const row = await findBindingById(ctx!, bindingId, 'u1');
    expect(row?.status).toBe('confirmed');
    expect(row?.confirmationSource).toBe('human');
    expect(row?.graphStatus?.status).toBe('skipped');
  });

  it('重复 confirm -> 409', async () => {
    const bindingId = await seedProposed();
    await appAs('u1').request('/api/bindings/confirm', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ bindingId }) });
    const res = await appAs('u1').request('/api/bindings/confirm', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ bindingId }) });
    expect(res.status).toBe(409);
  });

  it('reject: proposed->rejected', async () => {
    const bindingId = await seedProposed();
    const res = await appAs('u1').request('/api/bindings/reject', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ bindingId }) });
    expect(res.status).toBe(200);
    expect((await findBindingById(ctx!, bindingId, 'u1'))?.status).toBe('rejected');
  });

  it('手动创建: 已有非 rejected 同对行 -> 幂等 existing:true', async () => {
    const { docId } = await createDocumentStub(ctx, { sourceUri: 'file:///m.pdf', docType: '发票' });
    const existingId = await saveBinding(ctx, { documentId: docId, contractNo: 'HT-2', relation: '凭证', sourceRefs: [], confidence: 0.8, createdBy: 'agent', status: 'confirmed', confirmationSource: 'human' }, 'u1');
    const res = await appAs('u1').request('/api/bindings', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ documentId: docId, contractNo: 'HT-2', relation: '凭证' }),
    });
    const data = await res.json() as { existing?: boolean; bindingId: string };
    expect(data.existing).toBe(true);
    expect(data.bindingId).toBe(existingId);
  });

  it('unbind: confirmed->rejected', async () => {
    const bindingId = await seedProposed();
    await appAs('u1').request('/api/bindings/confirm', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ bindingId }) });
    const res = await appAs('u1').request('/api/bindings/unbind', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ bindingId }) });
    expect(res.status).toBe(200);
    expect((await findBindingById(ctx!, bindingId, 'u1'))?.status).toBe('rejected');
  });

  it('batch-confirm: 逐条结果, 失败项 ok:false 不影响他行', async () => {
    const id1 = await seedProposed();
    const res = await appAs('u1').request('/api/bindings/batch-confirm', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bindingIds: [id1, 'BD-not-exist'] }),
    });
    const data = await res.json() as { results: Array<{ bindingId: string; ok: boolean }> };
    expect(data.results.find((r) => r.bindingId === id1)?.ok).toBe(true);
    expect(data.results.find((r) => r.bindingId === 'BD-not-exist')?.ok).toBe(false);
  });
});
