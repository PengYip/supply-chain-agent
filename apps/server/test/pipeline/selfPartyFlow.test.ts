import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Hono } from 'hono';
import type { AuthEnv } from '../../src/lib/auth-middleware.js';
import { createDb, migrate, type DbContext } from '../../src/pipeline/db/client.js';
import {
  createDocumentStub,
  saveExtraction,
  saveBinding,
  addSelfParty,
  listExecutionFlows,
} from '../../src/pipeline/db/repositories.js';
import { materializeExecutionFlow } from '../../src/pipeline/executionFlow.js';

// 自主体名单 -> 执行流水物化(真 sqlite, 不 mock 存储层): 名单未配置时物化落空,
// addSelfParty 后默认名单(getEffectiveSelfPartyNames)生效, 回填路由触发重建。
//
// ctxHolder mock 仅服务于回填路由测试(parties.ts 每次调用 getDbContext());
// 前两个物化测试直接传 ctx, 不受 mock 影响。
const { ctxHolder } = vi.hoisted(() => ({
  ctxHolder: { current: null as DbContext | null },
}));
vi.mock('../../src/pipeline/db/dbBackend.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../src/pipeline/db/dbBackend.js')>();
  return { ...mod, getDbContext: () => ctxHolder.current };
});
const { partiesRoute } = await import('../../src/routes/parties.js');

const CONTRACT_NO = '2021-ZNFXCG(T1)-010';
const SELF_NAME = '浙江浙能富兴燃料有限公司';

/** 发票样式字段(真实键名): 受票方(购买方名称)= 本公司, 开票方(销售方名称)= 对手方。 */
function invoiceFields(): Record<string, { value: string | number; sourceSpans: unknown[] }> {
  return {
    购买方名称: { value: SELF_NAME, sourceSpans: [] },
    销售方名称: { value: '上海某能源有限公司', sourceSpans: [] },
    价税合计小写_元: { value: '1128515.08', sourceSpans: [] },
    开票日期: { value: '2021-06-08', sourceSpans: [] },
    发票号码: { value: '04981234', sourceSpans: [] },
    数量: { value: '3819.65', sourceSpans: [] },
    单位: { value: '吨', sourceSpans: [] },
    税率: { value: '13%', sourceSpans: [] },
    税额_元: { value: '129842.34', sourceSpans: [] },
  };
}

/** 种子: 发票文档 + 发票抽取 + 一条 confirmed 绑定(无执行流水)。 */
async function seedInvoiceDoc(ctx: DbContext, userId = 'u1'): Promise<string> {
  const { docId } = await createDocumentStub(ctx, {
    sourceUri: 'file:///inv.pdf', docType: '发票', userId,
  });
  await saveExtraction(ctx, {
    documentId: docId, docType: '发票',
    fields: invoiceFields(),
    fieldMeta: {}, overallConfidence: 1, needsReview: false,
  }, userId);
  await saveBinding(ctx, {
    documentId: docId, contractNo: CONTRACT_NO, relation: '收票',
    sourceRefs: [], confidence: 1, createdBy: userId,
  }, userId);
  return docId;
}

describe('自主体名单 -> 执行流水物化(真 sqlite)', () => {
  let ctx: ReturnType<typeof createDb>;
  beforeEach(() => {
    ctx = createDb(':memory:');
    migrate(ctx.sqlite);
  });

  it('名单未配置(DB 空 + env 未设) -> materializeExecutionFlow 返回 null, 无流水行', async () => {
    const docId = await seedInvoiceDoc(ctx);
    const flowId = await materializeExecutionFlow(ctx, {
      documentId: docId, contractNo: CONTRACT_NO, bindingId: 'BD-1',
      confidence: 1, createdBy: 'u1',
    }, 'u1');
    expect(flowId).toBeNull();
    expect(await listExecutionFlows(ctx, CONTRACT_NO, 'u1')).toHaveLength(0);
  });

  it('addSelfParty 后默认名单生效 -> 物化 1 条发票流 in, 金额 1128515.08', async () => {
    const docId = await seedInvoiceDoc(ctx);
    expect(await addSelfParty(ctx, SELF_NAME, 'u1')).toBe(true);
    const flowId = await materializeExecutionFlow(ctx, {
      documentId: docId, contractNo: CONTRACT_NO, bindingId: 'BD-1',
      confidence: 1, createdBy: 'u1',
    }, 'u1');
    expect(flowId).toMatch(/^EF-/);
    const flows = await listExecutionFlows(ctx, CONTRACT_NO, 'u1');
    expect(flows).toHaveLength(1);
    expect(flows[0]!.flowType).toBe('发票流');
    expect(flows[0]!.direction).toBe('in');
    expect(flows[0]!.amount).toBeCloseTo(1128515.08, 2);
    expect(flows[0]!.quantityTon).toBe(3819.65);
    expect(flows[0]!.unit).toBe('吨');
    expect(flows[0]!.docType).toBe('发票');
  });

  it('POST /api/parties 新增名单触发回填: refreshedFlows>=1 且流水落库', async () => {
    // 独立内存库: 种子同款文档/抽取/绑定, 但名单为空。
    const routeCtx = createDb(':memory:');
    migrate(routeCtx.sqlite);
    ctxHolder.current = routeCtx;
    const docId = await seedInvoiceDoc(routeCtx);

    const app = new Hono<AuthEnv>();
    app.use('*', async (c, next) => {
      c.set('user', { id: 'u1', email: 't@t', role: 'trader' } as never);
      await next();
    });
    app.route('/api/parties', partiesRoute);

    const res = await app.request('/api/parties', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: SELF_NAME }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean; added: boolean; refreshedFlows: number; failed: number;
    };
    expect(body.ok).toBe(true);
    expect(body.added).toBe(true);
    expect(body.refreshedFlows).toBeGreaterThanOrEqual(1);
    expect(body.failed).toBe(0);

    // 回填物化的流水行已落库。
    const flows = await listExecutionFlows(routeCtx, CONTRACT_NO, 'u1');
    expect(flows).toHaveLength(1);
    expect(flows[0]!.flowType).toBe('发票流');
    expect(flows[0]!.direction).toBe('in');
    expect(flows[0]!.amount).toBeCloseTo(1128515.08, 2);
    expect(flows[0]!.documentId).toBe(docId);
  });
});