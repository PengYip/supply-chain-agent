import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Hono } from 'hono';
import type { AuthEnv } from '../../src/lib/auth-middleware.js';
import { createDb, migrate, type DbContext } from '../../src/pipeline/db/client.js';
import {
  createDocumentStub, saveExtraction, saveBinding, upsertContractLedgerEntry,
  addSelfParty, upsertExecutionFlow,
} from '../../src/pipeline/db/repositories.js';
import type { ContractLedgerEntry } from '../../src/pipeline/contractLedger.js';

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
beforeEach(() => { ctx = createDb(':memory:'); migrate(ctx.sqlite); ctxHolder.current = ctx; });

describe('GET /api/bindings/overview', () => {
  it('返回文档绑定总览: 未绑定文档 bindings=[], 已绑定带 contractNo', async () => {
    const a = await createDocumentStub(ctx, { sourceUri: 'file:///a.pdf', docType: '发票' });
    const b = await createDocumentStub(ctx, { sourceUri: 'file:///b.pdf', docType: '合同' });
    await saveBinding(ctx, {
      documentId: a.docId, contractNo: 'HT-1', relation: '付款',
      sourceRefs: [], confidence: 1, createdBy: 'system', status: 'confirmed',
      confirmationSource: 'human',
    }, 'u1');
    const res = await appAs('u1').request('/api/bindings/overview');
    expect(res.status).toBe(200);
    const data = await res.json() as { documents: Array<{ docId: string; bindings: Array<{ contractNo: string }> }> };
    const byId = new Map(data.documents.map((d) => [d.docId, d]));
    expect(byId.get(a.docId)?.bindings[0]?.contractNo).toBe('HT-1');
    expect(byId.get(b.docId)?.bindings).toEqual([]);
  });

  it('未认证 -> 401', async () => {
    const app = new Hono<AuthEnv>();
    app.route('/api/bindings', bindingsRoute);
    const res = await app.request('/api/bindings/overview');
    expect(res.status).toBe(401);
  });
});

describe('GET /api/bindings/candidates', () => {
  it('缺 documentId -> 400', async () => {
    const res = await appAs('u1').request('/api/bindings/candidates');
    expect(res.status).toBe(400);
  });

  it('按需生成候选(纯计算), auto_rule 0.99 头名', async () => {
    const { docId } = await createDocumentStub(ctx, { sourceUri: 'file:///inv.pdf', docType: '发票' });
    await saveExtraction(ctx, {
      documentId: docId, docType: '发票',
      fields: { 合同号: { value: 'HT-X', sourceSpans: [] } },
      fieldMeta: {}, overallConfidence: 1, needsReview: false,
    });
    const entry: ContractLedgerEntry = {
      contractNo: 'HT-X', displayContractNo: 'HT-X', docType: '合同', documentId: docId,
      title: 'T', fields: {}, fieldMeta: {}, overallConfidence: 1, needsReview: false, userId: 'u1',
    };
    await upsertContractLedgerEntry(ctx, entry, 'u1');
    const res = await appAs('u1').request(`/api/bindings/candidates?documentId=${docId}`);
    expect(res.status).toBe(200);
    const data = await res.json() as { candidates: Array<{ route: string; score: number }> };
    expect(data.candidates[0]?.route).toBe('auto_rule');
  });
});

describe('GET /api/bindings/flows (selfPartiesConfigured 标志)', () => {
  it('名单未配置 -> selfPartiesConfigured:false', async () => {
    const res = await appAs('u1').request('/api/bindings/flows?contractNo=HT-1');
    expect(res.status).toBe(200);
    const data = await res.json() as {
      contractNo: string; summaries: unknown[]; flows: unknown[]; selfPartiesConfigured: boolean;
    };
    expect(data.contractNo).toBe('HT-1');
    expect(data.summaries).toEqual([]);
    expect(data.flows).toEqual([]);
    expect(data.selfPartiesConfigured).toBe(false);
  });

  it('addSelfParty 后 -> selfPartiesConfigured:true', async () => {
    await addSelfParty(ctx, '浙江浙能富兴燃料有限公司', 'u1');
    const res = await appAs('u1').request('/api/bindings/flows?contractNo=HT-1');
    expect(res.status).toBe(200);
    const data = await res.json() as { selfPartiesConfigured: boolean };
    expect(data.selfPartiesConfigured).toBe(true);
  });

  it('缺 contractNo -> 400', async () => {
    const res = await appAs('u1').request('/api/bindings/flows');
    expect(res.status).toBe(400);
  });
});

describe('GET /api/bindings/flows (溯源列文件名与预览 key)', () => {
  it('flows 带 documentFileName(路径末段) 与 documentMinioKey; 文档缺 minio_key -> null', async () => {
    const { docId } = await createDocumentStub(ctx, {
      sourceUri: '/ingest/users_u1_721968f0-7f6f-4764-b36a-edf4742356d7-06_发票.jpg',
      docType: '发票',
    });
    ctx.sqlite
      .prepare('UPDATE documents SET minio_key = ? WHERE id = ?')
      .run('users/u1/721968f0-7f6f-4764-b36a-edf4742356d7-06_发票.jpg', docId);
    await upsertExecutionFlow(ctx, {
      bindingId: 'BD-T', documentId: docId, contractNo: 'HT-1', flowType: '发票流',
      direction: 'in', amount: 100, quantityTon: null, unit: null, docType: '发票',
      voucherDate: '2026-08-19', confidence: 1, createdBy: 'human',
    }, 'u1');
    const res = await appAs('u1').request('/api/bindings/flows?contractNo=HT-1');
    expect(res.status).toBe(200);
    const data = await res.json() as {
      flows: Array<{ documentId: string; documentFileName: string | null; documentMinioKey: string | null }>;
    };
    expect(data.flows).toHaveLength(1);
    expect(data.flows[0]!.documentFileName)
      .toBe('users_u1_721968f0-7f6f-4764-b36a-edf4742356d7-06_发票.jpg');
    expect(data.flows[0]!.documentMinioKey)
      .toBe('users/u1/721968f0-7f6f-4764-b36a-edf4742356d7-06_发票.jpg');
  });
});
