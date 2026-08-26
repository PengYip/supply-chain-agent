import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Hono } from 'hono';
import type { AuthEnv } from '../../src/lib/auth-middleware.js';
import { createDb, migrate, type DbContext } from '../../src/pipeline/db/client.js';
import {
  createDocumentStub, upsertContractLedgerEntry, createProject, upsertProjectMembership,
} from '../../src/pipeline/db/repositories.js';
import { ensureTemplateSeed } from '../../src/pipeline/templateSeed.js';

const { ctxHolder } = vi.hoisted(() => ({ ctxHolder: { current: null as DbContext | null } }));
vi.mock('../../src/pipeline/db/dbBackend.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../src/pipeline/db/dbBackend.js')>();
  return { ...mod, getDbContext: () => ctxHolder.current };
});
const { templatesRoute } = await import('../../src/routes/templates.js');

function appAs(userId: string) {
  const app = new Hono<AuthEnv>();
  app.use('*', async (c, next) => {
    c.set('user', { id: userId, email: 't@t', role: 'trader' } as never);
    await next();
  });
  app.route('/api/templates', templatesRoute);
  return app;
}

let ctx: DbContext;
beforeEach(async () => {
  ctx = createDb(':memory:');
  migrate(ctx.sqlite);
  await ensureTemplateSeed(ctx);
  ctxHolder.current = ctx;
});
afterEach(() => { ctxHolder.current = null; });

/** 台账行(合同类型)。documentId 用占位(contract_ledger 无 FK)。 */
async function seedLedger(contractNo: string, contractType: string): Promise<void> {
  await upsertContractLedgerEntry(ctx, {
    contractNo, displayContractNo: contractNo, docType: '合同', documentId: 'DOC-LEDGER',
    title: '', contractType, fields: {}, fieldMeta: {},
    overallConfidence: 1, needsReview: false, userId: 'u1',
  }, 'u1');
}

describe('GET /api/templates/context', () => {
  it('返回类型链+派生词+项目合同树', async () => {
    const { docId } = await createDocumentStub(ctx, { sourceUri: 'file:///f.pdf', docType: '发票' });
    await seedLedger('HT-A', '采购');
    await seedLedger('HT-B', '销售');
    await createProject(ctx, { code: 'P1', name: '项目一', userId: 'u1' });
    await upsertProjectMembership(ctx, {
      contractNo: 'HT-A', projectCode: 'P1', role: '采购', status: 'confirmed',
      proposedBy: 'human', confirmationSource: 'human', createdBy: 'u1',
    }, 'u1');

    const res = await appAs('u1').request(`/api/templates/context?documentId=${docId}`);
    expect(res.status).toBe(200);
    const body = await res.json() as {
      docType: string; typeChain: string[]; bindsRelation: string; settlesVocab: string[] | null;
      allowedContractTypes: string[]; projects: Array<{ code: string; name: string; contracts: Array<{ contractNo: string; contractType: string | null; allowed: boolean }> }>;
      unassignedContracts: Array<{ contractNo: string; contractType: string | null; allowed: boolean }>;
    };
    // 发票链含自身: 发票 -> 发票凭证 -> 履约凭证(brief 注释 ['发票','履约凭证'] 漏了 发票凭证)。
    expect(body.typeChain).toEqual(['发票', '发票凭证', '履约凭证']);
    expect(body.bindsRelation).toBe('凭证'); // 发票不在 bindingRelationByVoucherType -> fallback
    expect(body.settlesVocab).toEqual(['收票', '开票']);
    expect(body.allowedContractTypes).toContain('采购');
    expect(body.allowedContractTypes).toContain('销售'); // 通配兜底 -> 全部六类
    expect(body.projects[0]?.code).toBe('P1');
    expect(body.projects[0]?.contracts[0]?.contractNo).toBe('HT-A');
    expect(body.projects[0]?.contracts[0]?.allowed).toBe(true);
    expect(body.unassignedContracts.map((c) => c.contractNo)).toContain('HT-B');
  });

  it('付款凭证: bindsRelation=付款, settlesVocab=[收款,付款]', async () => {
    const { docId } = await createDocumentStub(ctx, { sourceUri: 'file:///p.pdf', docType: '付款凭证' });
    const res = await appAs('u1').request(`/api/templates/context?documentId=${docId}`);
    expect(res.status).toBe(200);
    const body = await res.json() as { bindsRelation: string; settlesVocab: string[] | null };
    expect(body.bindsRelation).toBe('付款');
    expect(body.settlesVocab).toEqual(['收款', '付款']);
  });
});