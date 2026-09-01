import { describe, it, expect, beforeEach } from 'vitest';
import { createDb, migrate } from '../../../src/pipeline/db/client.js';
import {
  saveDocument, saveExtraction, saveDocumentTags, listDocumentTags,
  getReviewSnapshot, setReviewStatus, updateExtractionFields,
  setDocumentVectorization, applyDocumentCorrections, saveChunks, addSelfParty,
  createDocumentStub, saveDocumentUnits, setDocumentBatchRole,
} from '../../../src/pipeline/db/repositories.js';
import type { BlockModel } from '../../../src/pipeline/types.js';
import type { SpanMatchStrength } from '../../../src/pipeline/spanValidator.js';

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
    // proposedRelationships is DERIVED from the current fields (same rule as the
    // graph writer), not the persisted proposed_relationships column — the column
    // can go stale after a correction (2026-08-17 followup P0).
    expect(snap?.proposedRelationships[0]).toMatchObject({ kind: 'Contract', name: 'HT001' });
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

  // 回归(2026-08-28 用户报告 "数量录入20万吨保存后变成20"): 服务端必须原样存储
  // 带单位的更正值 — 数值字段收到非纯数字字符串时不得静默数值化。
  it('stores a unit-qualified correction ("20万吨") verbatim on a numeric field', async () => {
    await saveDocument(ctx, mkModel('DOC-ac3'));
    await saveExtraction(ctx, {
      documentId: 'DOC-ac3', docType: '合同',
      fields: { 数量: { value: 20, sourceSpans: [] } },
      fieldMeta: { 数量: { strength: 'exact', confidence: 0.9 } },
      overallConfidence: 0.9, needsReview: false,
    });
    const snap = await applyDocumentCorrections(ctx, 'DOC-ac3', [{ name: '数量', value: '20万吨' }], 'u1');
    const qty = snap?.fields.find((f) => f.name === '数量');
    expect(qty?.value).toBe('20万吨');
    expect(qty?.confidence).toBe(1.0);
    // 重读快照一致(卡片保存后的回显路径)
    const reread = await getReviewSnapshot(ctx, 'DOC-ac3');
    expect(reread?.fields.find((f) => f.name === '数量')?.value).toBe('20万吨');
  });
});

// ---- Lane B: chunk tags on the review snapshot (分段标签) -------------------

describe('getReviewSnapshot contractType (合同类型派生, spec 2026-08-20)', () => {
  it('甲方命中主体名单 -> 采购/side; 与台账/图提交同一派生规则', async () => {
    await addSelfParty(ctx, '我方贸易', 'u1');
    await saveDocument(ctx, mkModel('DOC-cty1'));
    await saveExtraction(ctx, {
      documentId: 'DOC-cty1', docType: '合同',
      fields: {
        甲方: { value: '我方贸易', sourceSpans: [] },
        乙方: { value: '某供应商', sourceSpans: [] },
      },
      fieldMeta: {
        甲方: { strength: 'exact', confidence: 0.9 },
        乙方: { strength: 'exact', confidence: 0.9 },
      },
      overallConfidence: 0.9, needsReview: false,
    });
    const snap = await getReviewSnapshot(ctx, 'DOC-cty1');
    expect(snap?.contractType).toEqual({ contractType: '采购', source: 'side', conflict: false });
  });

  it('非合同 docType -> contractType null', async () => {
    await saveDocument(ctx, { ...mkModel('DOC-cty2'), docType: '发票' });
    await saveExtraction(ctx, {
      documentId: 'DOC-cty2', docType: '发票',
      fields: { 金额: { value: 100, sourceSpans: [] } },
      fieldMeta: { 金额: { strength: 'exact', confidence: 0.9 } },
      overallConfidence: 0.9, needsReview: false,
    });
    const snap = await getReviewSnapshot(ctx, 'DOC-cty2');
    expect(snap?.contractType).toBeNull();
  });
});

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

// ---- P3 谱系(批量拆分器 Phase 3): snapshot.batch + snapshot.warnings --------
//
// batch_role IS NULL 的老数据零行为变化: batch=null / warnings=[]。container
// 快照带 units 清单(needsReview 聚合), unit 快照带 parent 谱系与 manifest
// 派生字段; _warnings 是 Phase 2 写进 field_meta 顶层的共识分歧键。

describe('getReviewSnapshot batch lineage + warnings (P3)', () => {
  async function stubDoc(sourceUri: string, minioKey?: string): Promise<string> {
    const { docId } = await createDocumentStub(ctx, { sourceUri, minioKey, userId: 'u1' });
    return docId;
  }

  it('container snapshot lists units with needsReview aggregation', async () => {
    const containerId = await stubDoc('file:///container.pdf');
    const c1 = await stubDoc('file:///container.pdf');
    const c2 = await stubDoc('file:///container.pdf');
    await setDocumentBatchRole(ctx, containerId, 'container');
    await setDocumentBatchRole(ctx, c1, 'unit');
    await setDocumentBatchRole(ctx, c2, 'unit');
    // 故意乱序落库(unitIndex 2 先插): 快照必须按 unitIndex 升序。
    await saveDocumentUnits(ctx, [
      { parentDocumentId: containerId, childDocumentId: c2, unitIndex: 2, docType: '质检报告', pageStart: 2, pageEnd: 2 },
      { parentDocumentId: containerId, childDocumentId: c1, unitIndex: 1, docType: '汽运磅单', pageStart: 1, pageEnd: 1 },
    ]);
    // unit1 无 extraction -> needsReview false; unit2 最新 extraction needs_review=1。
    await saveExtraction(ctx, {
      documentId: c2, docType: '质检报告',
      fields: { 结论: { value: '待定', sourceSpans: [] } },
      fieldMeta: { 结论: { strength: 'none', confidence: 0.3 } },
      overallConfidence: 0.3, needsReview: true,
    });
    const snap = await getReviewSnapshot(ctx, containerId);
    expect(snap?.batch?.role).toBe('container');
    expect(snap?.batch?.unitCount).toBe(2);
    expect(snap?.batch?.needsReviewCount).toBe(1);
    expect(snap?.batch?.units?.map((u) => u.unitIndex)).toEqual([1, 2]);
    expect(snap?.batch?.units?.[0]).toMatchObject({
      docId: c1,
      detectedFormType: '汽运磅单',
      childDocType: '其他',
      unitStatus: 'pending',
      reviewStatus: 'pending',
      needsReview: false,
    });
    expect(snap?.batch?.units?.[1]?.needsReview).toBe(true);
  });

  it('unit snapshot carries parent lineage', async () => {
    // parentFileName: container 行 minio_key 最后段去 UUID 前缀(parseFileKey 同规则)。
    const parentId = await stubDoc(
      'file:///scans/batch.pdf',
      'users/u1/8f0e2c10-9d3f-4f5a-8b6c-7d1e2f3a4b5c-批次件.pdf',
    );
    const childId = await stubDoc('file:///scans/batch.pdf');
    await setDocumentBatchRole(ctx, parentId, 'container');
    await setDocumentBatchRole(ctx, childId, 'unit');
    await saveDocumentUnits(ctx, [
      {
        parentDocumentId: parentId, childDocumentId: childId, unitIndex: 1,
        docType: '汽运磅单', pageStart: 3, pageEnd: 5, rotationDeg: 270,
        manifest: { regions: [{ page: 3 }, { page: 4 }, { page: 5 }] },
      },
    ]);
    const snap = await getReviewSnapshot(ctx, childId);
    expect(snap?.batch).toMatchObject({
      role: 'unit',
      parentDocumentId: parentId,
      parentFileName: '批次件.pdf',
      unitIndex: 1,
      detectedFormType: '汽运磅单',
      pageStart: 3,
      pageEnd: 5,
      rotationDeg: 270,
      regionCount: 3,
    });
  });

  it('field_meta _warnings surfaced as snapshot.warnings (absent -> [])', async () => {
    await saveDocument(ctx, mkModel('DOC-w1'));
    const meta: Record<string, { strength: SpanMatchStrength; confidence: number }> = {
      编号: { strength: 'none', confidence: 0.4 },
    };
    (meta as Record<string, unknown>)['_warnings'] = {
      strength: 'none',
      confidence: 1,
      warnings: ['编号两遍分歧: 10384417 vs 10394417'],
    };
    await saveExtraction(ctx, {
      documentId: 'DOC-w1', docType: '汽运磅单',
      fields: { 编号: { value: '10394417', sourceSpans: [] } },
      fieldMeta: meta,
      overallConfidence: 0.4, needsReview: true,
    });
    const snap = await getReviewSnapshot(ctx, 'DOC-w1');
    expect(snap?.warnings).toEqual(['编号两遍分歧: 10384417 vs 10394417']);
  });

  it('legacy doc (batch_role null) has batch null and empty warnings', async () => {
    await saveDocument(ctx, mkModel('DOC-w2'));
    const snap = await getReviewSnapshot(ctx, 'DOC-w2');
    expect(snap?.batch).toBeNull();
    expect(snap?.warnings).toEqual([]);
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
