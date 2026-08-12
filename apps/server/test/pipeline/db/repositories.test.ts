import { describe, it, expect, beforeEach } from 'vitest';
import { createDb, migrate } from '../../../src/pipeline/db/client.js';
import {
  saveDocument, loadDocument, saveExtraction, saveBinding, listBindingsForContract,
  saveDocumentTags, listDocumentTags,
} from '../../../src/pipeline/db/repositories.js';
import type { BlockModel } from '../../../src/pipeline/types.js';

function mkModel(docId: string): BlockModel {
  return {
    docId, docType: '合同', modality: 'digital',
    blocks: [{ id: 'b1', type: 'kv', text: '合同号: HT-2024-001', page: 1, bbox: null, ocrConfidence: 1 }],
    sourceUri: 'file:///x', createdAt: '2026-08-05T00:00:00.000Z',
  };
}

let ctx: ReturnType<typeof createDb>;
beforeEach(() => {
  ctx = createDb(':memory:');
  migrate(ctx.sqlite);
});

describe('repositories', () => {
  it('round-trips a document BlockModel', async () => {
    const id = await saveDocument(ctx, mkModel('DOC-1'));
    expect(id).toBe('DOC-1');
    const loaded = await loadDocument(ctx, 'DOC-1');
    expect(loaded?.blocks[0].text).toBe('合同号: HT-2024-001');
  });

  it('saves and lists an extraction + binding', async () => {
    await saveDocument(ctx, mkModel('DOC-1'));
    const exId = await saveExtraction(ctx, {
      documentId: 'DOC-1', docType: '合同',
      fields: { 合同号: { value: 'HT-2024-001', sourceSpans: [{ blockId: 'b1', start: 5, end: 16 }] } },
      fieldMeta: { 合同号: { strength: 'exact', confidence: 0.98 } },
      overallConfidence: 0.98, needsReview: false,
    });
    expect(exId).toMatch(/^EX-/);
    const bId = await saveBinding(ctx, {
      documentId: 'DOC-1', contractNo: 'HT-2024-001', relation: 'primary',
      sourceRefs: [{ blockId: 'b1', start: 5, end: 16 }], confidence: 0.98, createdBy: 'agent',
    });
    expect(bId).toMatch(/^BD-/);
    const list = await listBindingsForContract(ctx, 'HT-2024-001');
    expect(list).toHaveLength(1);
    expect(list[0].documentId).toBe('DOC-1');
  });

  it('saveDocumentTags is idempotent per (document, tag, source, user)', async () => {
    // Seed a real document row so the document_tags FK is satisfied.
    await saveDocument(ctx, mkModel('DOC-TAG-1'));
    const userId = 'user-1';
    const tags = ['合同', '信用证'];

    // First write: seeds both rows.
    await saveDocumentTags(ctx, 'DOC-TAG-1', tags, 'auto', userId);
    const rowsBefore = await listDocumentTags(ctx, 'DOC-TAG-1', userId);
    expect(rowsBefore).toHaveLength(2);

    // Second write with the SAME (document, tag, source, user): MUST not grow.
    // This is the load-bearing invariant -- fails if anyone removes the dedup
    // guard (and the UNIQUE index backstop turns a regression into a loud
    // constraint error instead of silent duplicate rows).
    await saveDocumentTags(ctx, 'DOC-TAG-1', tags, 'auto', userId);
    const rowsAfter = await listDocumentTags(ctx, 'DOC-TAG-1', userId);

    // No-growth + order stability (both queries use the same ORDER BY tag ASC).
    expect(rowsAfter).toEqual(rowsBefore);
    expect(rowsAfter).toHaveLength(2);
    // Pin the exact survivor set (order-independent content check).
    expect(rowsAfter.map((r) => r.tag).sort()).toEqual(['信用证', '合同']);
    expect(rowsAfter.every((r) => r.source === 'auto')).toBe(true);
  });
});
