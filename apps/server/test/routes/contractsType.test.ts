// PATCH /api/contracts/:contractNo/type 路由测试(wave7 Task 2): 合同类型人工
// 修正 + 绑定执行流水重建。白名单 = TRADE_VOCAB.contractTypes(受控值, 拒绝
// '购销合同' 等无方向语义的歧义值); 修正域 = 请求者本人的台账行(UNIQUE
// (contract_no, user_id)); 流水重建只作用于请求者 confirmed 绑定的去重文档。
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Hono } from 'hono';
import type { AuthEnv } from '../../src/lib/auth-middleware.js';
import { createDb, migrate, type DbContext } from '../../src/pipeline/db/client.js';
import {
  createDocumentStub,
  saveExtraction,
  saveBinding,
  upsertContractLedgerEntry,
  findContractLedgerByNo,
  updateDocumentType,
} from '../../src/pipeline/db/repositories.js';
import type { ContractLedgerEntry } from '../../src/pipeline/contractLedger.js';
import type { DocType } from '../../src/pipeline/types.js';
import { refreshExecutionFlowsForDocument } from '../../src/pipeline/executionFlow.js';

const { ctxHolder } = vi.hoisted(() => ({ ctxHolder: { current: null as DbContext | null } }));
vi.mock('../../src/pipeline/db/dbBackend.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../src/pipeline/db/dbBackend.js')>();
  return { ...mod, getDbContext: () => ctxHolder.current };
});
const { contractsRoute } = await import('../../src/routes/contracts.js');

function appAs(userId: string) {
  const app = new Hono<AuthEnv>();
  app.use('*', async (c, next) => {
    c.set('user', { id: userId, email: 't@t', role: 'trader' } as never);
    await next();
  });
  app.route('/api/contracts', contractsRoute);
  return app;
}

let ctx: DbContext;
beforeEach(() => { ctx = createDb(':memory:'); migrate(ctx.sqlite); ctxHolder.current = ctx; });

/** 台账行 + 绑定一张火运大票(适配表无 codedDirection): 无名单/无合同类型时
 *  方向三级链全判不出 -> direction-undeterminable 跳过。 */
async function seedBigTicketContract(no: string, opts: { owner?: string; ledgerDocType?: string } = {}) {
  const owner = opts.owner ?? 'u1';
  const { docId } = await createDocumentStub(ctx, {
    sourceUri: 'file:///rail.pdf', docType: '火运大票', userId: owner,
  });
  await saveExtraction(ctx, {
    documentId: docId, docType: '火运大票',
    fields: {
      合计净重: { value: 3.2, sourceSpans: [] },
      重量单位: { value: '吨', sourceSpans: [] },
      称量日期: { value: '2025-03-01', sourceSpans: [] },
    },
    fieldMeta: {}, overallConfidence: 1, needsReview: false,
  }, owner);
  await saveBinding(ctx, {
    documentId: docId, contractNo: no, relation: '凭证',
    sourceRefs: [], confidence: 1, createdBy: owner,
  }, owner);
  const e: ContractLedgerEntry = {
    contractNo: no, displayContractNo: no, docType: opts.ledgerDocType ?? '合同',
    documentId: docId, title: 'T', contractType: null,
    fields: { 合同号: { value: no, sourceSpans: [] } },
    fieldMeta: {}, overallConfidence: 1, needsReview: false, userId: owner,
  };
  await upsertContractLedgerEntry(ctx, e, owner);
  return docId;
}

describe('PATCH /api/contracts/:contractNo/type', () => {
  it('未认证 -> 401', async () => {
    const app = new Hono<AuthEnv>();
    app.route('/api/contracts', contractsRoute);
    const res = await app.request('/api/contracts/HT-1/type', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contractType: '采购' }),
    });
    expect(res.status).toBe(401);
  });

  it('缺 body / 空 contractType -> 400 invalid_body', async () => {
    const noBody = await appAs('u1').request('/api/contracts/HT-1/type', {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    });
    expect(noBody.status).toBe(400);
    expect(await noBody.json()).toEqual({ ok: false, error: 'invalid_body' });

    const empty = await appAs('u1').request('/api/contracts/HT-1/type', {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contractType: '' }),
    });
    expect(empty.status).toBe(400);
    expect(await empty.json()).toEqual({ ok: false, error: 'invalid_body' });
  });

  it('白名单外歧义值(购销合同) -> 400 invalid_contract_type 且台账未改动', async () => {
    await seedBigTicketContract('CJXC-1');
    const res = await appAs('u1').request('/api/contracts/CJXC-1/type', {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contractType: '购销合同' }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ ok: false, error: 'invalid_contract_type' });
    expect((await findContractLedgerByNo(ctx, 'CJXC-1', 'u1'))?.contractType).toBeNull();
  });

  it('未知合同号 -> 404 contract_not_found', async () => {
    const res = await appAs('u1').request('/api/contracts/NOPE/type', {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contractType: '采购' }),
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ ok: false, error: 'contract_not_found' });
  });

  it('他人台账行 -> 404 contract_not_found(修正域 = 请求者本人)', async () => {
    await seedBigTicketContract('CJXC-OTHER', { owner: 'u-other' });
    const res = await appAs('u1').request('/api/contracts/CJXC-OTHER/type', {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contractType: '采购' }),
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ ok: false, error: 'contract_not_found' });
    expect((await findContractLedgerByNo(ctx, 'CJXC-OTHER', 'u-other'))?.contractType).toBeNull();
  });

  it('happy path: 大票方向判不出 -> 修正采购后 200, contract_type 落库, refreshedFlows=1 且无 direction-undeterminable', async () => {
    const docId = await seedBigTicketContract('CJXC-1');
    // 前置: 无名单/无合同类型时该文档方向判不出(场景前提, 锁语义)。
    const before = await refreshExecutionFlowsForDocument(ctx, docId, 'u1');
    expect(before.skipped.map((s) => s.reason)).toContain('direction-undeterminable');

    const res = await appAs('u1').request('/api/contracts/CJXC-1/type', {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contractType: '采购' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean; contractNo: string; contractType: string;
      refreshedFlows: number; failed: number; skipped: Array<{ reason: string }>;
    };
    expect(body.ok).toBe(true);
    expect(body.contractNo).toBe('CJXC-1');
    expect(body.contractType).toBe('采购');
    expect(body.refreshedFlows).toBe(1);
    expect(body.failed).toBe(0);
    expect(body.skipped.map((s) => s.reason)).not.toContain('direction-undeterminable');
    expect((await findContractLedgerByNo(ctx, 'CJXC-1', 'u1'))?.contractType).toBe('采购');
  });

  it('非 合同 粗类台账行: docType 不设限, 仍允许修正', async () => {
    await seedBigTicketContract('CJXC-2', { ledgerDocType: '其他' });
    const res = await appAs('u1').request('/api/contracts/CJXC-2/type', {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contractType: '销售' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; contractType: string; refreshedFlows: number };
    expect(body.ok).toBe(true);
    expect(body.contractType).toBe('销售');
    expect((await findContractLedgerByNo(ctx, 'CJXC-2', 'u1'))?.contractType).toBe('销售');
  });

  it('人工修正值不被后续 docType 修正的重派生清空(守卫: 非空不动)', async () => {
    const docId = await seedBigTicketContract('CJXC-1');
    const res = await appAs('u1').request('/api/contracts/CJXC-1/type', {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contractType: '采购' }),
    });
    expect(res.status).toBe(200);
    expect((await findContractLedgerByNo(ctx, 'CJXC-1', 'u1'))?.contractType).toBe('采购');
    // 再改文档 docType 为 合同, 触发台账级联重派生 —— 已有的人工值必须保留。
    const updated = await updateDocumentType(ctx, docId, '合同' as DocType, 'u1');
    expect(updated).toBe(true);
    expect((await findContractLedgerByNo(ctx, 'CJXC-1', 'u1'))?.contractType).toBe('采购');
  });
});
