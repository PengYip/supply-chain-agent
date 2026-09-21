// wave7 sweep: loadLatestExtractionByDocId 确定性平局键(rowid DESC)。
// wave5 缺陷实证(executionFlowRebuild.test.ts): SQLite extractions.created_at 为
// 秒精度, 同秒两次抽取 created_at 相同 -> 无平局键时 ORDER BY created_at DESC 对
// 平局行回到旧行(rowid 序), 重建流水读到旧抽取。本测试直接锁 loadLatest 本身:
// 同秒两行抽取(沿 wave5 复现手段: 后插行 created_at 改写为与先行相同) ->
// loadLatest 必须返回后插的新行。
import { describe, it, expect, beforeEach } from 'vitest';
import { createDb, migrate } from '../../src/pipeline/db/client.js';
import {
  createDocumentStub,
  saveExtraction,
  loadLatestExtractionByDocId,
} from '../../src/pipeline/db/repositories.js';

let ctx: ReturnType<typeof createDb>;
beforeEach(() => {
  ctx = createDb(':memory:');
  migrate(ctx.sqlite);
});

const fields = (o: Record<string, string | number>) =>
  Object.fromEntries(Object.entries(o).map(([k, v]) => [k, { value: v, sourceSpans: [] }]));

async function seedDoc(): Promise<string> {
  const { docId } = await createDocumentStub(ctx, { sourceUri: 'file:///1.pdf', userId: 'u1' });
  return docId;
}

/** 把 rowB 的 created_at 改写为与 rowA 完全相同(复现 SQLite datetime('now') 秒精度平局)。 */
function tieCreatedAt(rowA: string, rowB: string): void {
  ctx.sqlite.prepare(
    'UPDATE extractions SET created_at = (SELECT created_at FROM extractions WHERE id = ?) WHERE id = ?',
  ).run(rowA, rowB);
}

describe('loadLatestExtractionByDocId 确定性(wave7 sweep)', () => {
  it('同秒两行抽取 -> 取后插的新行(created_at 平局, rowid DESC 决胜)', async () => {
    const docId = await seedDoc();
    const exA = await saveExtraction(ctx, {
      documentId: docId, docType: '收货单',
      fields: fields({ 买方: '我方', 卖方: '对手' }),
      fieldMeta: {}, overallConfidence: 1, needsReview: false,
    }, 'u1');
    const exB = await saveExtraction(ctx, {
      documentId: docId, docType: '收货单',
      fields: fields({ 买方: '我方', 卖方: '对手', 数量_吨: 2000.049 }),
      fieldMeta: {}, overallConfidence: 1, needsReview: false,
    }, 'u1');
    // 复现同秒平局: B 的 created_at 与 A 完全相同(只差 rowid)。
    tieCreatedAt(exA, exB);

    const latest = await loadLatestExtractionByDocId(ctx, docId, 'u1');
    expect(latest?.id).toBe(exB);
    expect((latest?.fields['数量_吨'] as { value: number } | undefined)?.value).toBe(2000.049);
  });

  it('不同 created_at: 取时间最新的一行(既有行为保持)', async () => {
    const docId = await seedDoc();
    const exA = await saveExtraction(ctx, {
      documentId: docId, docType: '收货单',
      fields: fields({ 数量_吨: 100 }),
      fieldMeta: {}, overallConfidence: 1, needsReview: false,
    }, 'u1');
    // 确保 B 晚于 A: 显式把 A 的 created_at 拨旧, B 保持 now。
    ctx.sqlite.prepare("UPDATE extractions SET created_at = '2020-01-01 00:00:00' WHERE id = ?").run(exA);
    const exB = await saveExtraction(ctx, {
      documentId: docId, docType: '收货单',
      fields: fields({ 数量_吨: 200 }),
      fieldMeta: {}, overallConfidence: 1, needsReview: false,
    }, 'u1');

    const latest = await loadLatestExtractionByDocId(ctx, docId, 'u1');
    expect(latest?.id).toBe(exB);
  });

  it('无抽取行 -> null', async () => {
    const docId = await seedDoc();
    expect(await loadLatestExtractionByDocId(ctx, docId, 'u1')).toBeNull();
  });
});
