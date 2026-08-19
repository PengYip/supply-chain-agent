import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createDb, migrate, type DbContext } from '../../src/pipeline/db/client.js';

// 桩掉存储层(并行任务实现中): 只测物化决策逻辑, 不碰真实 DB。
// 存储层契约类型(ExecutionFlowRow 等)由并行任务落地, 此处 mock 用宽松签名。
const mocks = vi.hoisted(() => ({
  upsertExecutionFlow: vi.fn<(args: any[]) => Promise<any>>(async () => 'EX-1'),
  retractExecutionFlowForBinding: vi.fn<(args: any[]) => Promise<any>>(async () => true),
  retractExecutionFlowsForDocument: vi.fn<(args: any[]) => Promise<any>>(async () => 0),
  listConfirmedBindingsForDocument: vi.fn<(args: any[]) => Promise<any>>(async () => []),
  loadLatestExtractionByDocId: vi.fn<(args: any[]) => Promise<any>>(async () => null),
  summarizeExecutionFlows: vi.fn<(args: any[]) => Promise<any>>(async () => []),
  listExecutionFlows: vi.fn<(args: any[]) => Promise<any>>(async () => []),
  // 自主体名单(Task A): materializeExecutionFlow 缺省名单走 getEffectiveSelfPartyNames
  // -> listSelfParties。测试均显式注入 selfPartyNames, 此 mock 仅兜底默认路径。
  listSelfParties: vi.fn<(args: any[]) => Promise<any>>(async () => []),
}));

vi.mock('../../src/pipeline/db/repositories.js', () => ({
  upsertExecutionFlow: mocks.upsertExecutionFlow,
  retractExecutionFlowForBinding: mocks.retractExecutionFlowForBinding,
  retractExecutionFlowsForDocument: mocks.retractExecutionFlowsForDocument,
  listConfirmedBindingsForDocument: mocks.listConfirmedBindingsForDocument,
  loadLatestExtractionByDocId: mocks.loadLatestExtractionByDocId,
  summarizeExecutionFlows: mocks.summarizeExecutionFlows,
  listExecutionFlows: mocks.listExecutionFlows,
  listSelfParties: mocks.listSelfParties,
}));

import {
  materializeExecutionFlow,
  refreshExecutionFlowsForDocument,
  retractExecutionFlow,
  buildQueryExecutionFlowsTool,
} from '../../src/pipeline/executionFlow.js';

const execOpts = { messages: [], toolCallId: 't', abortSignal: undefined };

let ctx: DbContext;
beforeEach(() => {
  ctx = createDb(':memory:');
  migrate(ctx.sqlite);
  vi.clearAllMocks();
  mocks.upsertExecutionFlow.mockResolvedValue('EX-1');
  mocks.retractExecutionFlowForBinding.mockResolvedValue(true);
  mocks.retractExecutionFlowsForDocument.mockResolvedValue(0);
  mocks.listConfirmedBindingsForDocument.mockResolvedValue([]);
  mocks.summarizeExecutionFlows.mockResolvedValue([]);
  mocks.listExecutionFlows.mockResolvedValue([]);
});

/** 构造 loadLatestExtractionByDocId 返回的抽取行(fields 为 {value, sourceSpans} 包装)。 */
function extractionRow(docType: string, rawFields: Record<string, unknown>) {
  return {
    id: 'EX-1',
    documentId: 'DOC-1',
    docType,
    fields: Object.fromEntries(
      Object.entries(rawFields).map(([k, v]) => [k, { value: v, sourceSpans: [] }]),
    ),
    fieldMeta: {},
    overallConfidence: 1,
    needsReview: false,
  };
}

const baseInput = {
  documentId: 'DOC-1',
  contractNo: 'CJXC-001',
  bindingId: 'BD-1',
  confidence: 0.99,
  createdBy: 'test',
};

const SELF = ['我方贸易有限公司'];

describe('materializeExecutionFlow 物化决策', () => {
  it('付款凭证 + 名单命中 buyer -> 资金流/out, amount 取锚点金额', async () => {
    mocks.loadLatestExtractionByDocId.mockResolvedValue(
      extractionRow('付款凭证', {
        付款人名称: '我方贸易有限公司',
        收款人名称: '对手方有限公司',
        金额: 1234500,
        入账日期: '2026-08-01',
      }),
    );
    const id = await materializeExecutionFlow(ctx, baseInput, 'u1', SELF);
    expect(id).toBe('EX-1');
    expect(mocks.upsertExecutionFlow).toHaveBeenCalledTimes(1);
    expect(mocks.upsertExecutionFlow).toHaveBeenCalledWith(
      ctx,
      expect.objectContaining({
        bindingId: 'BD-1',
        documentId: 'DOC-1',
        contractNo: 'CJXC-001',
        flowType: '资金流',
        direction: 'out',
        amount: 1234500,
        quantityTon: null,
        docType: '付款凭证',
        voucherDate: '2026-08-01',
        confidence: 0.99,
        createdBy: 'test',
      }),
      'u1',
    );
  });

  it('货转单 + 名单命中 seller -> 货物流/out, quantityTon 取交货总量', async () => {
    mocks.loadLatestExtractionByDocId.mockResolvedValue(
      extractionRow('货转单', {
        买方: '对手方有限公司',
        卖方: '我方贸易有限公司',
        交货总量_吨: 50000,
        合计含税总价_元: 26000000,
        交货日期: '2026-07-15',
      }),
    );
    const id = await materializeExecutionFlow(ctx, baseInput, 'u1', SELF);
    expect(id).toBe('EX-1');
    expect(mocks.upsertExecutionFlow).toHaveBeenCalledTimes(1);
    expect(mocks.upsertExecutionFlow).toHaveBeenCalledWith(
      ctx,
      expect.objectContaining({
        flowType: '货物流',
        direction: 'out',
        amount: 26000000,
        quantityTon: 50000,
        unit: '吨',
        docType: '货转单',
        voucherDate: '2026-07-15',
      }),
      'u1',
    );
  });

  it('发票 + 名单命中 buyer -> 发票流/in(通用锚点 buildAnchorsFromFields)', async () => {
    mocks.loadLatestExtractionByDocId.mockResolvedValue(
      extractionRow('发票', {
        买方: '我方贸易有限公司',
        卖方: '对手方有限公司',
        金额: 88000,
        开票日期: '2026-08-05',
      }),
    );
    const id = await materializeExecutionFlow(ctx, baseInput, 'u1', SELF);
    expect(id).toBe('EX-1');
    expect(mocks.upsertExecutionFlow).toHaveBeenCalledTimes(1);
    expect(mocks.upsertExecutionFlow).toHaveBeenCalledWith(
      ctx,
      expect.objectContaining({
        flowType: '发票流',
        direction: 'in',
        amount: 88000,
        docType: '发票',
        voucherDate: '2026-08-05',
      }),
      'u1',
    );
  });

  it('发票 + 裸 数量 字段 -> quantityTon 有值但 unit 为 null(不带单位语义, 不猜测)', async () => {
    mocks.loadLatestExtractionByDocId.mockResolvedValue(
      extractionRow('发票', {
        买方: '我方贸易有限公司',
        卖方: '对手方有限公司',
        金额: 88000,
        数量: 120,
        开票日期: '2026-08-05',
      }),
    );
    const id = await materializeExecutionFlow(ctx, baseInput, 'u1', SELF);
    expect(id).toBe('EX-1');
    expect(mocks.upsertExecutionFlow).toHaveBeenCalledWith(
      ctx,
      expect.objectContaining({
        flowType: '发票流',
        direction: 'in',
        quantityTon: 120,
        unit: null,
      }),
      'u1',
    );
  });

  it('SELF_PARTY_NAMES 未配置(名单为空) -> 返回 null 且未调 upsert', async () => {
    mocks.loadLatestExtractionByDocId.mockResolvedValue(
      extractionRow('付款凭证', {
        付款人名称: '我方贸易有限公司',
        收款人名称: '对手方有限公司',
        金额: 100,
        入账日期: '2026-08-01',
      }),
    );
    const id = await materializeExecutionFlow(ctx, baseInput, 'u1', []);
    expect(id).toBeNull();
    expect(mocks.upsertExecutionFlow).not.toHaveBeenCalled();
  });

  it('docType=化验报告(白名单外) -> 返回 null 且未调 upsert', async () => {
    mocks.loadLatestExtractionByDocId.mockResolvedValue(
      extractionRow('化验报告', { 送检单位: '我方贸易有限公司', 重量_吨: 100 }),
    );
    const id = await materializeExecutionFlow(ctx, baseInput, 'u1', SELF);
    expect(id).toBeNull();
    expect(mocks.upsertExecutionFlow).not.toHaveBeenCalled();
  });

  it('两侧同命中(数据异常) -> 返回 null 且未调 upsert', async () => {
    mocks.loadLatestExtractionByDocId.mockResolvedValue(
      extractionRow('付款凭证', {
        付款人名称: '我方贸易有限公司',
        收款人名称: '我方贸易有限公司',
        金额: 100,
        入账日期: '2026-08-01',
      }),
    );
    const id = await materializeExecutionFlow(ctx, baseInput, 'u1', SELF);
    expect(id).toBeNull();
    expect(mocks.upsertExecutionFlow).not.toHaveBeenCalled();
  });

  it('无抽取行 -> 返回 null 且未调 upsert', async () => {
    mocks.loadLatestExtractionByDocId.mockResolvedValue(null);
    const id = await materializeExecutionFlow(ctx, baseInput, 'u1', SELF);
    expect(id).toBeNull();
    expect(mocks.upsertExecutionFlow).not.toHaveBeenCalled();
  });

  it('同 bindingId 重复物化 -> upsert 被再次调用(幂等语义交由存储层)', async () => {
    mocks.loadLatestExtractionByDocId.mockResolvedValue(
      extractionRow('付款凭证', {
        付款人名称: '我方贸易有限公司',
        收款人名称: '对手方有限公司',
        金额: 100,
        入账日期: '2026-08-01',
      }),
    );
    await materializeExecutionFlow(ctx, baseInput, 'u1', SELF);
    await materializeExecutionFlow(ctx, baseInput, 'u1', SELF);
    expect(mocks.upsertExecutionFlow).toHaveBeenCalledTimes(2);
  });
});

describe('retractExecutionFlow', () => {
  it('转调 retractExecutionFlowForBinding 并透传 userId', async () => {
    const ok = await retractExecutionFlow(ctx, 'BD-1', 'u1');
    expect(ok).toBe(true);
    expect(mocks.retractExecutionFlowForBinding).toHaveBeenCalledWith(ctx, 'BD-1', 'u1');
  });
});

describe('refreshExecutionFlowsForDocument 修正后重建', () => {
  it('先撤回全部流水, 再按 confirmed 绑定逐条重物化(带最新 extractionId)', async () => {
    mocks.retractExecutionFlowsForDocument.mockResolvedValue(2);
    mocks.listConfirmedBindingsForDocument.mockResolvedValue([
      { id: 'BD-1', contractNo: 'CJXC-001', confidence: 0.9 },
      { id: 'BD-2', contractNo: 'CJXC-002', confidence: 0.8 },
    ]);
    mocks.loadLatestExtractionByDocId.mockResolvedValue(
      extractionRow('付款凭证', {
        付款人名称: '我方贸易有限公司',
        收款人名称: '对手方有限公司',
        金额: 500,
        入账日期: '2026-08-01',
      }),
    );
    const out = await refreshExecutionFlowsForDocument(ctx, 'DOC-1', 'u1', SELF);
    expect(out).toEqual({ retracted: 2, materialized: 2 });
    expect(mocks.retractExecutionFlowsForDocument).toHaveBeenCalledWith(ctx, 'DOC-1', 'u1');
    expect(mocks.listConfirmedBindingsForDocument).toHaveBeenCalledWith(ctx, 'DOC-1', 'u1');
    expect(mocks.upsertExecutionFlow).toHaveBeenCalledTimes(2);
    // 溯源: 重建后的流水指向触发本次重建的抽取行 id。
    expect(mocks.upsertExecutionFlow).toHaveBeenCalledWith(
      ctx,
      expect.objectContaining({
        bindingId: 'BD-2',
        contractNo: 'CJXC-002',
        flowType: '资金流',
        direction: 'out',
        amount: 500,
        extractionId: 'EX-1',
        createdBy: 'review-refresh',
      }),
      'u1',
    );
  });

  it('单条绑定重物化抛错 -> 告警跳过, 其余绑定继续', async () => {
    mocks.retractExecutionFlowsForDocument.mockResolvedValue(2);
    mocks.listConfirmedBindingsForDocument.mockResolvedValue([
      { id: 'BD-1', contractNo: 'CJXC-001', confidence: 0.9 },
      { id: 'BD-2', contractNo: 'CJXC-002', confidence: 0.8 },
    ]);
    // 第一条绑定的抽取行加载失败, 第二条正常。
    mocks.loadLatestExtractionByDocId
      .mockRejectedValueOnce(new Error('db boom'))
      .mockResolvedValue(
        extractionRow('发票', {
          买方: '我方贸易有限公司',
          卖方: '对手方有限公司',
          金额: 88000,
          开票日期: '2026-08-05',
        }),
      );
    const out = await refreshExecutionFlowsForDocument(ctx, 'DOC-1', 'u1', SELF);
    expect(out).toEqual({ retracted: 2, materialized: 1 });
    expect(mocks.upsertExecutionFlow).toHaveBeenCalledTimes(1);
    expect(mocks.upsertExecutionFlow).toHaveBeenCalledWith(
      ctx,
      expect.objectContaining({ bindingId: 'BD-2', flowType: '发票流', direction: 'in' }),
      'u1',
    );
  });

  it('无 confirmed 绑定 -> 只撤回不重建; 白名单外抽取自然落空', async () => {
    mocks.retractExecutionFlowsForDocument.mockResolvedValue(1);
    mocks.listConfirmedBindingsForDocument.mockResolvedValue([]);
    const out = await refreshExecutionFlowsForDocument(ctx, 'DOC-1', 'u1', SELF);
    expect(out).toEqual({ retracted: 1, materialized: 0 });
    expect(mocks.upsertExecutionFlow).not.toHaveBeenCalled();
  });
});

describe('buildQueryExecutionFlowsTool', () => {
  it('execute 返回六向汇总 + 逐笔明细(只读, 无 needsApproval)', async () => {
    mocks.summarizeExecutionFlows.mockResolvedValue([
      {
        contractNo: 'CJXC-001', flowType: '资金流', direction: 'out', entryCount: 2,
        totalAmount: 1234500, totalQuantityTon: null, lastVoucherDate: '2026-08-01',
      },
    ]);
    mocks.listExecutionFlows.mockResolvedValue([
      {
        id: 'EF-1', bindingId: 'BD-1', documentId: 'DOC-1', contractNo: 'CJXC-001',
        flowType: '资金流', direction: 'out', amount: 1234500, quantityTon: null,
        docType: '付款凭证', voucherDate: '2026-08-01', confidence: 0.99,
        createdBy: 'human', userId: 'u1', createdAt: '2026-08-01T00:00:00Z',
      },
    ]);
    const t = buildQueryExecutionFlowsTool({ ctx, userId: 'u1' }) as any;
    const out = await t.execute({ contractNo: 'CJXC-001' }, execOpts);
    expect(out.contractNo).toBe('CJXC-001');
    expect(out.summaries).toHaveLength(1);
    expect(out.summaries[0]).toMatchObject({ flowType: '资金流', direction: 'out', totalAmount: 1234500 });
    expect(out.flows).toEqual([
      {
        flowId: 'EF-1', bindingId: 'BD-1', documentId: 'DOC-1',
        flowType: '资金流', direction: 'out', amount: 1234500, quantityTon: null,
        unit: null, voucherDate: '2026-08-01', docType: '付款凭证', extractionId: null,
      },
    ]);
    expect(mocks.summarizeExecutionFlows).toHaveBeenCalledWith(ctx, 'CJXC-001', 'u1');
    expect(mocks.listExecutionFlows).toHaveBeenCalledWith(ctx, 'CJXC-001', 'u1');
    expect((t as any).needsApproval).toBeUndefined();
  });
});