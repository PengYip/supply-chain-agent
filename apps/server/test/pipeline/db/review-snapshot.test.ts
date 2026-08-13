import { describe, it, expect, beforeEach } from 'vitest';
import { createDb, migrate } from '../../../src/pipeline/db/client.js';
import {
  saveDocument, saveExtraction, saveDocumentTags,
  getReviewSnapshot, setReviewStatus, updateExtractionFields,
} from '../../../src/pipeline/db/repositories.js';
import type { BlockModel } from '../../../src/pipeline/types.js';

function mkModel(docId: string): BlockModel {
  return {
    docId, docType: '合同', modality: 'digital',
    blocks: [{ id: 'b1', type: 'kv', text: '合同号: HT001', page: 1, bbox: null, ocrConfidence: 1 }],
    sourceUri: 'file:///x', createdAt: '2026-08-13T00:00:00.000Z',
  };
}

let ctx: ReturnType<typeof createDb>;
beforeEach(() => { ctx = createDb(':memory:'); migrate(ctx.sqlite); });

describe('getReviewSnapshot', () => {
  it('assembles docType + tags + fields + reviewStatus + proposedRelationships', async () => {
    await saveDocument(ctx, mkModel('DOC-t1'));
    await saveDocumentTags(ctx, 'DOC-t1', ['动力煤', '上游'], 'auto', '');
    await saveExtraction(ctx, {
      documentId: 'DOC-t1', docType: '合同',
      fields: { 合同号: { value: 'HT001', sourceSpans: [] } },
      fieldMeta: { 合同号: { strength: 'exact', confidence: 0.95 } },
      overallConfidence: 0.95, needsReview: false,
      proposedRelationships: [{ kind: 'Party', role: '买方', name: 'ACME', confidence: 0.9 }],
    });
    const snap = await getReviewSnapshot(ctx, 'DOC-t1');
    expect(snap?.docType).toBe('合同');
    expect(snap?.tags).toEqual(['动力煤', '上游']);
    expect(snap?.reviewStatus).toBe('pending');
    expect(snap?.fields[0]).toMatchObject({ name: '合同号', value: 'HT001', confidence: 0.95, needsReview: false });
    expect(snap?.proposedRelationships[0]).toMatchObject({ kind: 'Party', role: '买方', name: 'ACME' });
  });

  it('returns null when doc not found', async () => {
    expect(await getReviewSnapshot(ctx, 'DOC-missing')).toBeNull();
  });

  it('marks low-confidence fields needsReview', async () => {
    await saveDocument(ctx, mkModel('DOC-t2'));
    await saveExtraction(ctx, {
      documentId: 'DOC-t2', docType: '合同',
      fields: { 备注: { value: 'x', sourceSpans: [] } },
      fieldMeta: { 备注: { strength: 'none', confidence: 0.4 } },
      overallConfidence: 0.4, needsReview: true,
    });
    const snap = await getReviewSnapshot(ctx, 'DOC-t2');
    expect(snap?.fields[0].needsReview).toBe(true);
  });
});

describe('setReviewStatus', () => {
  it('transitions pending -> confirmed and stamps reviewed_at/by', async () => {
    await saveDocument(ctx, mkModel('DOC-t3'));
    await setReviewStatus(ctx, 'DOC-t3', 'confirmed', 'u1');
    const snap = await getReviewSnapshot(ctx, 'DOC-t3');
    expect(snap?.reviewStatus).toBe('confirmed');
  });
});

describe('updateExtractionFields', () => {
  it('overwrites fields for the doc and marks reviewStatus=corrected', async () => {
    await saveDocument(ctx, mkModel('DOC-t4'));
    await saveExtraction(ctx, {
      documentId: 'DOC-t4', docType: '合同',
      fields: { 合同号: { value: 'HT001', sourceSpans: [] } },
      fieldMeta: { 合同号: { strength: 'exact', confidence: 0.9 } },
      overallConfidence: 0.9, needsReview: false,
    });
    await updateExtractionFields(ctx, 'DOC-t4',
      { 合同号: { value: 'HT999', sourceSpans: [] } },
      { 合同号: { strength: 'exact', confidence: 1 } });
    await setReviewStatus(ctx, 'DOC-t4', 'corrected', 'u1');
    const snap = await getReviewSnapshot(ctx, 'DOC-t4');
    expect(snap?.fields.find((f) => f.name === '合同号')?.value).toBe('HT999');
    expect(snap?.reviewStatus).toBe('corrected');
  });
});
