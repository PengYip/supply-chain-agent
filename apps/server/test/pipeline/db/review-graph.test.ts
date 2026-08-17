import { describe, it, expect, beforeEach } from 'vitest';
import { createDb, migrate, type DbContext } from '../../../src/pipeline/db/client.js';
import {
  createDocumentStub, saveExtraction, getReviewSnapshot,
  setDocumentGraphStatus, setReviewStatus,
} from '../../../src/pipeline/db/repositories.js';

let ctx: DbContext;
beforeEach(() => {
  ctx = createDb(':memory:');
  migrate(ctx.sqlite);
});

describe('review snapshot 图字段（design 2026-08-17）', () => {
  it('proposedEdges 从持久化字段派生（发票 -> executes+references+party）', async () => {
    const { docId } = await createDocumentStub(ctx, { sourceUri: 'file:///inv.pdf', docType: '发票' });
    await saveExtraction(ctx, {
      documentId: docId, docType: '发票',
      fields: { 合同号: { value: 'HT-1', sourceSpans: [] }, 卖方: { value: 'B公司', sourceSpans: [] } },
      fieldMeta: { 合同号: { strength: 'exact', confidence: 0.9 }, 卖方: { strength: 'exact', confidence: 0.9 } },
      overallConfidence: 0.9, needsReview: false,
    });
    const snap = await getReviewSnapshot(ctx, docId);
    expect(snap?.proposedEdges.map((e) => e.type).sort()).toEqual(['executes', 'party', 'references']);
  });

  it('graphStatus 确认前为 null，setDocumentGraphStatus 后可读回', async () => {
    const { docId } = await createDocumentStub(ctx, { sourceUri: 'file:///c.pdf' });
    await saveExtraction(ctx, {
      documentId: docId, docType: '其他',
      fields: {}, fieldMeta: {}, overallConfidence: 0, needsReview: false,
    });
    let snap = await getReviewSnapshot(ctx, docId);
    expect(snap?.graphStatus).toBeNull();
    await setReviewStatus(ctx, docId, 'confirmed');
    const status = { status: 'ok' as const, nodeCount: 5, edgeCount: 4, writtenAt: '2026-08-17T00:00:00Z' };
    await setDocumentGraphStatus(ctx, docId, status);
    snap = await getReviewSnapshot(ctx, docId);
    expect(snap?.graphStatus).toEqual(status);
  });
});
