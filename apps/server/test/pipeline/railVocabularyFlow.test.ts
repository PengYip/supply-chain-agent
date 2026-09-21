import { describe, it, expect, beforeEach } from 'vitest';
import { createDb, migrate } from '../../src/pipeline/db/client.js';
import {
  createDocumentStub,
  saveExtraction,
  saveBinding,
  listExecutionFlows,
} from '../../src/pipeline/db/repositories.js';
import { refreshExecutionFlowsForDocument } from '../../src/pipeline/executionFlow.js';
import type { DocType, SourceSpan } from '../../src/pipeline/types.js';

// wave6 火运词汇流水适配: 中间节点 运输凭证/重量凭证 接入 FLOW_ADAPTERS 后,
// 绑定(relation=货权转移, 重测实证 muant2ur 0 流水的现场)确认即物化货物流。
// 真 sqlite, 不 mock 存储层; 方向走既有三级链(主体锚点命中 -> 货物流 in)。
const CONTRACT_NO = '2021-ZNFXCG(T1)-010';
const SELF = ['浙江浙能富兴燃料有限公司'];

/** 火运样式字段(真实键名): 买方=本公司(方向锚点), 合计净重(适配数量键)。 */
function railFields(): Record<string, { value: string | number; sourceSpans: SourceSpan[] }> {
  return {
    买方: { value: '浙江浙能富兴燃料有限公司', sourceSpans: [] },
    卖方: { value: '上海某能源有限公司', sourceSpans: [] },
    合计净重: { value: '5259.54', sourceSpans: [] },
    称量日期: { value: '2021-06-08', sourceSpans: [] },
  };
}

/** 种子: 火运 docType 文档 + 抽取 + 一条 confirmed 绑定(relation=货权转移)。 */
async function seedRailDoc(
  ctx: ReturnType<typeof createDb>,
  docType: DocType,
  userId = 'u1',
): Promise<string> {
  const { docId } = await createDocumentStub(ctx, {
    sourceUri: 'file:///rail.pdf', docType, userId,
  });
  await saveExtraction(ctx, {
    documentId: docId, docType,
    fields: railFields(),
    fieldMeta: {}, overallConfidence: 1, needsReview: false,
  }, userId);
  await saveBinding(ctx, {
    documentId: docId, contractNo: CONTRACT_NO, relation: '货权转移',
    sourceRefs: [], confidence: 1, createdBy: userId,
  }, userId);
  return docId;
}

describe('火运词汇流水适配(wave6): 运输凭证/重量凭证 绑定后物化货物流', () => {
  let ctx: ReturnType<typeof createDb>;
  beforeEach(() => {
    ctx = createDb(':memory:');
    migrate(ctx.sqlite);
  });

  it.each(['运输凭证', '重量凭证'] as const)('%s × 货权转移 -> 物化 1 条货物流(in)', async (docType) => {
    const docId = await seedRailDoc(ctx, docType);
    const res = await refreshExecutionFlowsForDocument(ctx, docId, 'u1', SELF);
    expect(res).toEqual({ retracted: 0, materialized: 1, skipped: [] });
    const flows = await listExecutionFlows(ctx, CONTRACT_NO, 'u1');
    expect(flows).toHaveLength(1);
    expect(flows[0]!.flowType).toBe('货物流');
    expect(flows[0]!.direction).toBe('in');
    expect(flows[0]!.quantityTon).toBe(5259.54);
    expect(flows[0]!.docType).toBe(docType);
    expect(flows[0]!.contractNo).toBe(CONTRACT_NO);
  });
});