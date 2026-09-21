// wave5 收尾修复: 流水重建必须读取最新抽取行。
// 缺陷实证(dev 库): DOC-muaky52k-ozz6 强制重抽后最新抽取 EX-muaob8z4-yffm 含
// 数量_吨=2000.049, 但重建的 execution_flows 行 extraction_id 指向旧抽取行
// (EX-mual11sk-lelp) -> quantity_ton=NULL -> 事实裸壳、ALLOCATE_TO 边无法生成。
// 根因: SQLite extractions.created_at 默认 datetime('now') 为秒精度, 同秒两次
// 抽取 created_at 相同 -> loadLatestExtractionByDocId 的 ORDER BY created_at DESC
// 对平局行回到旧行(rowid 序), 重建读到旧抽取。本测试复现同秒平局并断言重建后
// 流水 extraction_id 指向最新抽取行 B 且数量派生读新行(quantity_ton=2000.049)。
import { describe, it, expect, beforeEach } from 'vitest';
import { createDb, migrate } from '../../src/pipeline/db/client.js';
import { saveExtraction, saveBinding, listExecutionFlows } from '../../src/pipeline/db/repositories.js';
import { materializeExecutionFlow, refreshExecutionFlowsForDocument } from '../../src/pipeline/executionFlow.js';

let ctx: ReturnType<typeof createDb>;
beforeEach(() => {
  ctx = createDb(':memory:');
  migrate(ctx.sqlite);
});

const fields = (o: Record<string, string | number>) =>
  Object.fromEntries(Object.entries(o).map(([k, v]) => [k, { value: v, sourceSpans: [] }]));

async function seedDocAndBinding(): Promise<string> {
  ctx.sqlite.prepare(
    `INSERT INTO documents (id, doc_type, modality, source_uri, block_model, user_id)
     VALUES ('DOC-1', '收货单', 'text', 'stub://doc', 'stub', 'u1')`,
  ).run();
  return saveBinding(ctx, {
    documentId: 'DOC-1', contractNo: 'CJXC-001', relation: 'primary',
    sourceRefs: [], confidence: 0.99, createdBy: 'system',
  }, 'u1');
}

describe('流水(重)建读取最新抽取行(wave5 收尾修复)', () => {
  it('同秒重抽取后重建: 新流水 extraction_id=B 且 quantity_ton=2000.049(不读旧行)', async () => {
    const bindingId = await seedDocAndBinding();
    // 抽取 A: 无数量。
    const exA = await saveExtraction(ctx, {
      documentId: 'DOC-1', docType: '收货单',
      fields: fields({ 买方: '我方', 卖方: '对手' }),
      fieldMeta: {}, overallConfidence: 1, needsReview: false,
    }, 'u1');
    // 物化流水 -> 指向 A, 数量为空。
    const first = await materializeExecutionFlow(ctx, {
      documentId: 'DOC-1', contractNo: 'CJXC-001', bindingId,
      confidence: 0.99, createdBy: 'test',
    }, 'u1', ['我方']);
    expect(first?.flowType).toBe('货物流');
    let flows = await listExecutionFlows(ctx, 'CJXC-001', 'u1');
    expect(flows[0]!.extractionId).toBe(exA);
    expect(flows[0]!.quantityTon).toBeNull();

    // 抽取 B(强制重抽后的最新抽取行): 带 数量_吨。
    const exB = await saveExtraction(ctx, {
      documentId: 'DOC-1', docType: '收货单',
      fields: fields({ 买方: '我方', 卖方: '对手', 数量_吨: 2000.049 }),
      fieldMeta: {}, overallConfidence: 1, needsReview: false,
    }, 'u1');
    // 复现 SQLite datetime('now') 秒精度平局: B 的 created_at 与 A 完全相同。
    ctx.sqlite.prepare(
      'UPDATE extractions SET created_at = (SELECT created_at FROM extractions WHERE id = ?) WHERE id = ?',
    ).run(exA, exB);

    // 触发重建(refresh 链: 撤回 -> 按最新抽取重物化)。
    const out = await refreshExecutionFlowsForDocument(ctx, 'DOC-1', 'u1', ['我方']);
    expect(out.materialized).toBe(1);
    flows = await listExecutionFlows(ctx, 'CJXC-001', 'u1');
    expect(flows).toHaveLength(1);
    // 修复核心: 重建后的流水指向最新抽取行 B, 数量派生读新行(2000.049)。
    expect(flows[0]!.extractionId).toBe(exB);
    expect(flows[0]!.quantityTon).toBe(2000.049);
    expect(flows[0]!.unit).toBe('吨');
  });
});