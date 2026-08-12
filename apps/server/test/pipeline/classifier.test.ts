import { describe, it, expect } from 'vitest';
import type { Block, DocType } from '../../src/pipeline/types.js';
import { classifyDocument } from '../../src/pipeline/classifier.js';

// Reuse the stub-model seam from documentEntry.test.ts. Its doGenerate returns
// JSON that generateObject parses against the classifier zod schema.
function stubModel(returnObject: unknown) {
  return {
    specificationVersion: 'v2' as const,
    provider: 'fake',
    modelId: 'fake-model',
    supportedUrls: {} as Record<string, RegExp[]>,
    async doGenerate() {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(returnObject) }],
        finishReason: 'stop' as const,
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        warnings: [] as unknown[],
      };
    },
    async doStream() {
      throw new Error('doStream not used by classifyDocument');
    },
  } as any;
}

const blocks = (text: string): Block[] => [
  { id: 'b0', type: 'text', text, page: 1, bbox: null, ocrConfidence: 1 },
];

describe('classifyDocument', () => {
  it('returns the LLM-classified docType + confidence', async () => {
    const model = stubModel({ docType: '发票', confidence: 0.93 });
    const res = await classifyDocument(
      { model },
      { blocks: blocks('这是发票号码 INV-001 的文档'), hint: '其他' },
    );
    expect(res.docType).toBe('发票');
    expect(res.confidence).toBeCloseTo(0.93, 5);
    expect(res.source).toBe('classified');
  });

  it('clamps out-of-range confidence into 0..1', async () => {
    const model = stubModel({ docType: '合同', confidence: 1.4 });
    const res = await classifyDocument({ model }, { blocks: blocks('x'), hint: '其他' });
    expect(res.confidence).toBeLessThanOrEqual(1);
    expect(res.confidence).toBeGreaterThanOrEqual(0);
  });

  it('falls back to the hint docType when the LLM output is unparseable', async () => {
    const model = stubModel({ notTheShape: true }); // fails zod parse
    const res = await classifyDocument(
      { model },
      { blocks: blocks('文本'), hint: '合同' as DocType },
    );
    expect(res.docType).toBe('合同');
    expect(res.source).toBe('fallback');
    expect(res.confidence).toBe(0);
  });

  it('returns hint docType with source "hint" when the model is absent', async () => {
    // No ClassifierDeps passed in — simulate the offline-degrade path used by
    // ingestFile when no classifier model is wired.
    // classifyDocumentWithoutModel is the degrade helper exported alongside.
    const { classifyDocumentWithoutModel } = await import('../../src/pipeline/classifier.js');
    const res = classifyDocumentWithoutModel({ blocks: blocks('x'), hint: '提单' });
    expect(res.docType).toBe('提单');
    expect(res.source).toBe('hint');
    expect(res.confidence).toBe(1);
  });
});
