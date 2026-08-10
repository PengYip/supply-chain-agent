import { describe, it, expect, beforeEach } from 'vitest';
import { createDb, migrate } from '../../../src/pipeline/db/client.js';
import {
  saveDocument, loadDocument, saveExtraction, saveBinding, listBindingsForContract,
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
});
