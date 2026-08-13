import { describe, it, expect, beforeEach } from 'vitest';
import { createDb, migrate, type SqliteDbContext } from '../../src/pipeline/db/client.js';
import { saveDocument, saveExtraction, getReviewSnapshot } from '../../src/pipeline/db/repositories.js';
import { buildUpdateDocumentFieldsTool } from '../../src/pipeline/tools/documentEntry.js';
import type { BlockModel } from '../../src/pipeline/types.js';

const execOpts = { messages: [], toolCallId: 't', abortSignal: undefined } as unknown as Parameters<
  ReturnType<typeof buildUpdateDocumentFieldsTool>['execute']
>[1];

function mkModel(docId: string): BlockModel {
  return {
    docId, docType: '合同', modality: 'digital',
    blocks: [{ id: 'b1', type: 'kv', text: '合同号: HT001', page: 1, bbox: null, ocrConfidence: 1 }],
    sourceUri: 'file:///x', createdAt: '2026-08-13T00:00:00.000Z',
  };
}

let ctx: SqliteDbContext;
beforeEach(() => { ctx = createDb(':memory:'); migrate(ctx.sqlite); });

describe('update_document_fields', () => {
  it('applies a correction, sets corrected field confidence 1.0, marks reviewStatus=corrected', async () => {
    await saveDocument(ctx, mkModel('DOC-u1'));
    await saveExtraction(ctx, {
      documentId: 'DOC-u1', docType: '合同',
      fields: { 合同号: { value: 'HT001', sourceSpans: [] }, 金额: { value: 2860000, sourceSpans: [] } },
      fieldMeta: { 合同号: { strength: 'exact', confidence: 0.95 }, 金额: { strength: 'fuzzy', confidence: 0.6 } },
      overallConfidence: 0.78, needsReview: true,
    });
    const t = buildUpdateDocumentFieldsTool({ ctx });
    const res: any = await t.execute({ docId: 'DOC-u1', corrections: [{ name: '合同号', value: 'HT-CORRECTED' }] }, execOpts);
    expect(res.ok).toBe(true);
    expect(res.reviewStatus).toBe('corrected');
    expect(res.correctedFields).toEqual(['合同号']);
    // un-corrected field's confidence preserved
    const snap = await getReviewSnapshot(ctx, 'DOC-u1');
    expect(snap?.fields.find((f) => f.name === '合同号')?.value).toBe('HT-CORRECTED');
    expect(snap?.fields.find((f) => f.name === '金额')?.confidence).toBe(0.6);
  });

  it('returns status:error when doc not found', async () => {
    const t = buildUpdateDocumentFieldsTool({ ctx });
    const res: any = await t.execute({ docId: 'DOC-missing', corrections: [{ name: '合同号', value: 'X' }] }, execOpts);
    expect(res.status).toBe('error');
    expect(res.reason).toBe('document_not_found');
  });
});
