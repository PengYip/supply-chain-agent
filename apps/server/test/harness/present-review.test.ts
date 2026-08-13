import { describe, it, expect, beforeEach } from 'vitest';
import { createDb, migrate, type SqliteDbContext } from '../../src/pipeline/db/client.js';
import { saveDocument, saveExtraction, saveDocumentTags, setDocumentVectorization } from '../../src/pipeline/db/repositories.js';
import { buildPresentDocumentReviewTool } from '../../src/pipeline/tools/documentEntry.js';
import type { BlockModel } from '../../src/pipeline/types.js';

const execOpts = { messages: [], toolCallId: 't', abortSignal: undefined } as unknown as Parameters<
  ReturnType<typeof buildPresentDocumentReviewTool>['execute']
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

describe('present_document_review', () => {
  it('assembles the 5-dimension review payload', async () => {
    await saveDocument(ctx, mkModel('DOC-p1'));
    await saveDocumentTags(ctx, 'DOC-p1', ['动力煤'], 'auto', '');
    await saveExtraction(ctx, {
      documentId: 'DOC-p1', docType: '合同',
      fields: { 合同号: { value: 'HT001', sourceSpans: [] } },
      fieldMeta: { 合同号: { strength: 'exact', confidence: 0.95 } },
      overallConfidence: 0.95, needsReview: false,
      proposedRelationships: [{ kind: 'Party', role: '买方', name: 'ACME', confidence: 0.9 }],
    });
    const t = buildPresentDocumentReviewTool({ ctx });
    const res: any = await t.execute({ docId: 'DOC-p1' }, execOpts);
    expect(res.docType).toBe('合同');
    expect(res.tags).toEqual(['动力煤']);
    expect(res.fields[0]).toMatchObject({ name: '合同号', value: 'HT001' });
    expect(res.proposedRelationships[0]).toMatchObject({ kind: 'Party', role: '买方' });
    expect(res.reviewStatus).toBe('pending');
    // no ingest populated the cache in this test -> unknown
    expect(res.vectorization.status).toBe('unknown');
  });

  it('returns status:error when doc not found', async () => {
    const t = buildPresentDocumentReviewTool({ ctx });
    const res: any = await t.execute({ docId: 'DOC-missing' }, execOpts);
    expect(res.status).toBe('error');
    expect(res.reason).toBe('document_not_found');
  });

  // Bug 1: vectorization status is persisted on the documents row and read back
  // via getReviewSnapshot (was an in-memory Map that the /api/files upload path
  // never populated and that was lost on restart -> always showed 'unknown').
  it('surfaces the persisted vectorization outcome', async () => {
    await saveDocument(ctx, mkModel('DOC-p2'));
    await saveDocumentTags(ctx, 'DOC-p2', ['动力煤'], 'auto', '');
    await saveExtraction(ctx, {
      documentId: 'DOC-p2', docType: '合同',
      fields: { 合同号: { value: 'HT001', sourceSpans: [] } },
      fieldMeta: { 合同号: { strength: 'exact', confidence: 0.95 } },
      overallConfidence: 0.95, needsReview: false,
    });
    await setDocumentVectorization(ctx, 'DOC-p2', { status: 'ok', mode: 'deterministic', chunkCount: 5 });
    const t = buildPresentDocumentReviewTool({ ctx });
    const res: any = await t.execute({ docId: 'DOC-p2' }, execOpts);
    expect(res.vectorization).toEqual({ status: 'ok', mode: 'deterministic', chunkCount: 5 });
  });
});
