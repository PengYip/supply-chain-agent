import { describe, it, expect, beforeEach } from 'vitest';
import { createDb, migrate } from '../../src/pipeline/db/client.js';
import {
  createDocumentStub,
  saveExtraction,
  saveBinding,
  updateDocumentType,
  listExecutionFlows,
} from '../../src/pipeline/db/repositories.js';
import { refreshExecutionFlowsForDocument } from '../../src/pipeline/executionFlow.js';

// docType 修正 -> 执行流水级联(真内存 sqlite, 不 mock 存储层):
// documents.doc_type 修正会级联 extractions.doc_type, 而执行流水物化以
// extraction docType 为事实来源, 因此改类型后重建的流水反映新类型。
let ctx: ReturnType<typeof createDb>;
beforeEach(() => {
  ctx = createDb(':memory:');
  migrate(ctx.sqlite);
});

const CONTRACT_NO = '2021-ZNFXCG(T1)-010';
const SELF = ['浙江浙能富兴燃料有限公司'];

/** 发票样式字段(真实键名): 受票方(购买方名称)= 本公司, 开票方(销售方名称)= 对手方。 */
function invoiceFields(): Record<string, { value: string | number; sourceSpans: unknown[] }> {
  return {
    购买方名称: { value: '浙江浙能富兴燃料有限公司', sourceSpans: [] },
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

describe('docType 修正 -> 执行流水级联(executionFlowTypeCascade)', () => {
  it('其他 -> 发票: 重建物化 1 条发票流(in/收票); 发票 -> 其他: 重建后清空', async () => {
    // 初始: 文档被(错误)分类为 其他, 抽取字段实为发票字段, 一条 confirmed 绑定。
    const { docId } = await createDocumentStub(ctx, {
      sourceUri: 'file:///inv.pdf', docType: '其他', userId: 'u1',
    });
    await saveExtraction(ctx, {
      documentId: docId, docType: '其他',
      fields: invoiceFields(),
      fieldMeta: {}, overallConfidence: 1, needsReview: false,
    }, 'u1');
    await saveBinding(ctx, {
      documentId: docId, contractNo: CONTRACT_NO, relation: '收票',
      sourceRefs: [], confidence: 1, createdBy: 'u1',
    }, 'u1');

    // 修正为 发票 -> 按最新类型重建: 1 条发票流, 方向 in(受票方=本公司, 收票),
    // 金额/数量/单位取自最新抽取的发票字段。
    expect(await updateDocumentType(ctx, docId, '发票', 'u1')).toBe(true);
    const first = await refreshExecutionFlowsForDocument(ctx, docId, 'u1', SELF);
    expect(first).toEqual({ retracted: 0, materialized: 1 });

    const flows = await listExecutionFlows(ctx, CONTRACT_NO, 'u1');
    expect(flows).toHaveLength(1);
    expect(flows[0]!.flowType).toBe('发票流');
    expect(flows[0]!.direction).toBe('in');
    expect(flows[0]!.amount).toBeCloseTo(1128515.08, 2);
    expect(flows[0]!.quantityTon).toBe(3819.65);
    expect(flows[0]!.unit).toBe('吨');
    expect(flows[0]!.docType).toBe('发票');
    expect(flows[0]!.contractNo).toBe(CONTRACT_NO);

    // 改回 其他 -> 重建后白名单外, 流水清空(0 行)。
    expect(await updateDocumentType(ctx, docId, '其他', 'u1')).toBe(true);
    const second = await refreshExecutionFlowsForDocument(ctx, docId, 'u1', SELF);
    expect(second).toEqual({ retracted: 1, materialized: 0 });
    expect(await listExecutionFlows(ctx, CONTRACT_NO, 'u1')).toHaveLength(0);
  });

  it('updateDocumentType 级联 extractions.doc_type(物化事实来源)', async () => {
    const { docId } = await createDocumentStub(ctx, {
      sourceUri: 'file:///inv.pdf', docType: '其他', userId: 'u1',
    });
    await saveExtraction(ctx, {
      documentId: docId, docType: '其他',
      fields: invoiceFields(),
      fieldMeta: {}, overallConfidence: 1, needsReview: false,
    }, 'u1');

    await updateDocumentType(ctx, docId, '发票', 'u1');
    const row = ctx.sqlite
      .prepare('SELECT doc_type AS t FROM extractions WHERE document_id = ?')
      .get(docId) as { t: string };
    expect(row.t).toBe('发票');
  });

  it('不存在的文档 -> false(路由映射 404)', async () => {
    expect(await updateDocumentType(ctx, 'DOC-NOPE', '发票', 'u1')).toBe(false);
  });
});
