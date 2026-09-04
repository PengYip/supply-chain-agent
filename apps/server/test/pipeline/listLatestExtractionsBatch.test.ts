import { describe, it, expect, beforeAll } from 'vitest';
import { createDb, migrate, type DbContext } from '../../src/pipeline/db/client.js';
import {
  createDocumentStub,
  saveExtraction,
  setDocumentBatchRole,
  saveDocumentUnits,
  setReviewOutcome,
  listLatestExtractionsByDocIds,
  listContainerUnitSummaries,
} from '../../src/pipeline/db/repositories.js';

let ctx: DbContext;
beforeAll(() => {
  ctx = createDb(':memory:');
  migrate(ctx.sqlite);
});

describe('listLatestExtractionsByDocIds', () => {
  it('批量取每文档最新一条 extraction', async () => {
    const { docId: d1 } = await createDocumentStub(ctx, { sourceUri: 'file:///1.pdf', userId: 'u1' });
    const { docId: d2 } = await createDocumentStub(ctx, { sourceUri: 'file:///2.pdf', userId: 'u1' });
    await saveExtraction(ctx, {
      documentId: d1, docType: '汽运磅单',
      fields: { 总净重_吨: { value: 10, sourceSpans: [] } },
      fieldMeta: {}, overallConfidence: 0.5, needsReview: true,
    });
    await saveExtraction(ctx, {
      documentId: d1, docType: '汽运磅单',
      fields: { 总净重_吨: { value: 20, sourceSpans: [] } },
      fieldMeta: {}, overallConfidence: 0.9, needsReview: false,
    });
    await saveExtraction(ctx, {
      documentId: d2, docType: '轨道衡称重单',
      fields: { 编号: { value: 'X1', sourceSpans: [] } },
      fieldMeta: {}, overallConfidence: 0.8, needsReview: false,
    });

    const map = await listLatestExtractionsByDocIds(ctx, [d1, d2], 'u1');
    expect(map.size).toBe(2);
    expect(map.get(d1)!.fields['总净重_吨']!.value).toBe(20); // 最新一条
    expect(map.get(d1)!.overallConfidence).toBe(0.9);
    expect(map.get(d2)!.docType).toBe('轨道衡称重单');
  });

  it('无 extraction 的文档不在结果里; 空输入返回空 Map', async () => {
    const { docId: empty } = await createDocumentStub(ctx, { sourceUri: 'file:///3.pdf', userId: 'u1' });
    expect((await listLatestExtractionsByDocIds(ctx, [empty], 'u1')).size).toBe(0);
    expect((await listLatestExtractionsByDocIds(ctx, [], 'u1')).size).toBe(0);
  });

  it('他人文档不可见', async () => {
    const { docId } = await createDocumentStub(ctx, { sourceUri: 'file:///4.pdf', userId: 'u1' });
    await saveExtraction(ctx, {
      documentId: docId, docType: '汽运磅单',
      fields: {}, fieldMeta: {}, overallConfidence: 0.1, needsReview: false,
    }, 'u1');
    expect((await listLatestExtractionsByDocIds(ctx, [docId], 'u2')).size).toBe(0);
  });
});

describe('listContainerUnitSummaries 增补字段', () => {
  it('带 pageStart/pageEnd/reviewAction(additive)', async () => {
    const { docId: child } = await createDocumentStub(ctx, { sourceUri: 'file:///c.pdf', userId: 'u1' });
    await setDocumentBatchRole(ctx, child, 'unit');
    const { docId: container } = await createDocumentStub(ctx, { sourceUri: 'file:///p.pdf', userId: 'u1' });
    await setDocumentBatchRole(ctx, container, 'container');
    const bbox = { x: 0, y: 0, w: 1, h: 1 };
    await saveDocumentUnits(ctx, [{
      parentDocumentId: container, childDocumentId: child, unitIndex: 1,
      docType: '汽运磅单', pageStart: 3, pageEnd: 5, rotationDeg: 0,
      bboxJson: JSON.stringify(bbox),
      manifest: { regions: [{ page: 3, bbox, rotationDeg: 0 }, { page: 5, bbox, rotationDeg: 0 }] },
    }]);
    await setReviewOutcome(ctx, child, 'confirmed', 'auto-release', 'u1');
    const units = await listContainerUnitSummaries(ctx, container);
    expect(units[0]!.pageStart).toBe(3);
    expect(units[0]!.pageEnd).toBe(5);
    expect(units[0]!.reviewAction).toBe('auto-release');
  });
});