import { describe, it, expect, beforeEach } from 'vitest';
import { createDb, migrate } from '../../../src/pipeline/db/client.js';
import {
  saveDocument, saveExtraction, saveDocumentTags, listDocumentTags,
  getReviewSnapshot, setReviewStatus, updateExtractionFields,
  setDocumentVectorization, applyDocumentCorrections, saveChunks,
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

// ---- Bug 1: vectorization outcome persistence -------------------------------
//
// lastVectorization was an in-memory Map written only by ingest_document, so the
// /api/files upload path (which calls ingestFile directly) never populated it
// and it was lost on restart. setDocumentVectorization persists it to the
// documents row; getReviewSnapshot reads it back (defaulting to 'unknown' for
// rows with no outcome, e.g. a saveDocument-direct test or a legacy DB).

describe('setDocumentVectorization + getReviewSnapshot', () => {
  it('round-trips the vectorization outcome through the documents row', async () => {
    await saveDocument(ctx, mkModel('DOC-v1'));
    await setDocumentVectorization(ctx, 'DOC-v1', { status: 'ok', mode: 'deterministic', chunkCount: 7 });
    const snap = await getReviewSnapshot(ctx, 'DOC-v1');
    expect(snap?.vectorization).toEqual({ status: 'ok', mode: 'deterministic', chunkCount: 7 });
  });

  it('carries the failure reason', async () => {
    await saveDocument(ctx, mkModel('DOC-v2'));
    await setDocumentVectorization(ctx, 'DOC-v2', { status: 'failed', mode: 'ollama', chunkCount: 3, reason: 'boom' });
    const snap = await getReviewSnapshot(ctx, 'DOC-v2');
    expect(snap?.vectorization.status).toBe('failed');
    expect(snap?.vectorization.reason).toBe('boom');
  });

  it('defaults to unknown when no outcome was persisted', async () => {
    await saveDocument(ctx, mkModel('DOC-v3'));
    const snap = await getReviewSnapshot(ctx, 'DOC-v3');
    expect(snap?.vectorization).toEqual({ status: 'unknown', mode: 'unknown', chunkCount: 0 });
  });
});

// ---- Bug 2: saveDocumentTags resilience -------------------------------------
//
// Internal duplicates in one call used to trip the UNIQUE index and the error
// was swallowed (console.warn) so tags silently disappeared. Now the input is
// deduped AND the INSERT is OR IGNORE / ON CONFLICT DO NOTHING.

describe('saveDocumentTags resilience', () => {
  it('does not throw and does not duplicate when the input has internal duplicates', async () => {
    await saveDocument(ctx, mkModel('DOC-tg1'));
    await expect(saveDocumentTags(ctx, 'DOC-tg1', ['动力煤', '动力煤', '上游'], 'auto', '')).resolves.toBeUndefined();
    const tags = await listDocumentTags(ctx, 'DOC-tg1');
    expect(tags.map((t) => t.tag).sort()).toEqual(['上游', '动力煤']);
  });

  it('re-adding an existing tag for the same source is a no-op (idempotent)', async () => {
    await saveDocument(ctx, mkModel('DOC-tg2'));
    await saveDocumentTags(ctx, 'DOC-tg2', ['动力煤'], 'auto', '');
    await expect(saveDocumentTags(ctx, 'DOC-tg2', ['动力煤'], 'auto', '')).resolves.toBeUndefined();
    const tags = await listDocumentTags(ctx, 'DOC-tg2');
    expect(tags.filter((t) => t.tag === '动力煤')).toHaveLength(1);
  });
});

// ---- Feature: shared in-card correction logic -------------------------------

describe('applyDocumentCorrections', () => {
  it('merges corrections, sets confidence 1.0 on corrected fields, preserves the rest, marks corrected', async () => {
    await saveDocument(ctx, mkModel('DOC-ac1'));
    await saveExtraction(ctx, {
      documentId: 'DOC-ac1', docType: '合同',
      fields: { 合同号: { value: 'HT001', sourceSpans: [] }, 金额: { value: 1000, sourceSpans: [] } },
      fieldMeta: { 合同号: { strength: 'exact', confidence: 0.5 }, 金额: { strength: 'fuzzy', confidence: 0.8 } },
      overallConfidence: 0.65, needsReview: true,
    });
    const snap = await applyDocumentCorrections(ctx, 'DOC-ac1', [{ name: '合同号', value: 'HT-Z' }], 'u1');
    expect(snap).not.toBeNull();
    expect(snap?.reviewStatus).toBe('corrected');
    const contract = snap?.fields.find((f) => f.name === '合同号');
    const amount = snap?.fields.find((f) => f.name === '金额');
    expect(contract?.value).toBe('HT-Z');
    expect(contract?.confidence).toBe(1.0); // human-confirmed
    expect(amount?.confidence).toBe(0.8);   // un-corrected field preserved
  });

  it('returns null when no extraction exists for the doc (covers doc-not-found)', async () => {
    await saveDocument(ctx, mkModel('DOC-ac2')); // doc but no extraction
    expect(await applyDocumentCorrections(ctx, 'DOC-ac2', [{ name: 'x', value: 'y' }])).toBeNull();
    expect(await applyDocumentCorrections(ctx, 'DOC-missing', [{ name: 'x', value: 'y' }])).toBeNull();
  });
});

// ---- Lane B: chunk tags on the review snapshot (分段标签) -------------------

describe('getReviewSnapshot chunkTags (Lane B)', () => {
  it('returns distinct chunk tags in first-appearance order, skipping null-tag chunks', async () => {
    await saveDocument(ctx, mkModel('DOC-ct1'));
    await saveChunks(ctx, 'DOC-ct1', [
      { text: 'a', index: 0 },
      { text: 'b', index: 1 },
      { text: 'c', index: 2 },
    ], [['当事人信息', '标的物'], null, ['标的物', '付款条款']]);
    const snap = await getReviewSnapshot(ctx, 'DOC-ct1');
    // Deduped (标的物 appears in chunk 0 and 2 -> once), first-appearance order
    // across chunk_index; the null-tags chunk (index 1) contributes nothing.
    expect(snap?.chunkTags).toEqual(['当事人信息', '标的物', '付款条款']);
  });

  it('caps chunkTags at 16 entries', async () => {
    await saveDocument(ctx, mkModel('DOC-ct2'));
    const many = Array.from({ length: 20 }, (_, i) => `标签${i}`);
    await saveChunks(ctx, 'DOC-ct2', [{ text: 'x', index: 0 }], [many]);
    const snap = await getReviewSnapshot(ctx, 'DOC-ct2');
    expect(snap?.chunkTags.length).toBe(16);
    expect(snap?.chunkTags[0]).toBe('标签0');
    expect(snap?.chunkTags[15]).toBe('标签15');
  });

  it('defaults to [] when no chunks are tagged', async () => {
    await saveDocument(ctx, mkModel('DOC-ct3'));
    await saveChunks(ctx, 'DOC-ct3', [{ text: 'x', index: 0 }]); // no tags param
    const snap = await getReviewSnapshot(ctx, 'DOC-ct3');
    expect(snap?.chunkTags).toEqual([]);
  });
});

describe('getReviewSnapshot chunkTagDetails (Lane B detail view)', () => {
  it('groups each tag with its chunks (first-appearance order, deduped, null-tags chunk skipped)', async () => {
    await saveDocument(ctx, mkModel('DOC-ctd1'));
    await saveChunks(ctx, 'DOC-ctd1', [
      { text: 'a', index: 0 },
      { text: 'b', index: 1 },
      { text: 'c', index: 2 },
    ], [['当事人信息', '标的物'], null, ['标的物', '付款条款']]);
    const snap = await getReviewSnapshot(ctx, 'DOC-ctd1');
    // 标的物 spans chunks 0 and 2 (both listed, chunk_index order); the
    // null-tags chunk (index 1) appears under no tag; tags in first-appearance order.
    expect(snap?.chunkTagDetails).toEqual([
      { tag: '当事人信息', chunks: [{ chunkIndex: 0, text: 'a' }] },
      { tag: '标的物', chunks: [{ chunkIndex: 0, text: 'a' }, { chunkIndex: 2, text: 'c' }] },
      { tag: '付款条款', chunks: [{ chunkIndex: 2, text: 'c' }] },
    ]);
  });

  it('caps each chunk text at 800 chars with an ellipsis marker', async () => {
    await saveDocument(ctx, mkModel('DOC-ctd2'));
    const long = '长'.repeat(900);
    await saveChunks(ctx, 'DOC-ctd2', [{ text: long, index: 0 }], [['付款条款']]);
    const snap = await getReviewSnapshot(ctx, 'DOC-ctd2');
    const entry = snap?.chunkTagDetails[0];
    expect(entry?.tag).toBe('付款条款');
    expect(entry?.chunks[0]?.text.length).toBe(803); // 800 + '...'
    expect(entry?.chunks[0]?.text.endsWith('...')).toBe(true);
  });

  it('defaults to [] when no chunks are tagged', async () => {
    await saveDocument(ctx, mkModel('DOC-ctd3'));
    await saveChunks(ctx, 'DOC-ctd3', [{ text: 'x', index: 0 }]);
    const snap = await getReviewSnapshot(ctx, 'DOC-ctd3');
    expect(snap?.chunkTagDetails).toEqual([]);
  });
});
