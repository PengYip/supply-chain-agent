import { describe, it, expect } from 'vitest';
import { attachConfidence } from '../../src/pipeline/extraction.js';
import type { BlockModel, SourceSpan } from '../../src/pipeline/types.js';

const model: BlockModel = {
  docId: 'D1', docType: '合同', modality: 'digital',
  blocks: [
    { id: 'b1', type: 'kv', text: '合同号: HT-2024-001', page: 1, bbox: null, ocrConfidence: 1 },
    { id: 'b2', type: 'kv', text: '金额: 2860000', page: 1, bbox: null, ocrConfidence: 0.92 },
  ],
  sourceUri: 'u', createdAt: '2026-08-05T00:00:00.000Z',
};

describe('attachConfidence', () => {
  it('validates spans, computes confidence, sets key-field gate', () => {
    const grounded = [
      { name: '合同号', value: 'HT-2024-001', sourceSpans: [{ blockId: 'b1', start: 5, end: 16 } as SourceSpan] },
      { name: '金额', value: '2860000', sourceSpans: [{ blockId: 'b2', start: 4, end: 11 } as SourceSpan] },
    ];
    const out = attachConfidence(model, grounded, 0.9 /* llmConsistency */);
    const contractNo = out.find((f) => f.name === '合同号')!;
    expect(contractNo.strength).toBe('exact');
    expect(contractNo.confidence).toBeGreaterThan(0.95);
    expect(contractNo.autoAccepted).toBe(true);

    const amount = out.find((f) => f.name === '金额')!;
    expect(amount.strength).toBe('exact');
    // 金额 is a key field => needs >=0.95; with conf 0.92*0.4+1*0.4+0.9*0.2 = 0.848 < 0.95 => not auto
    expect(amount.autoAccepted).toBe(false);
  });

  it('ungrounded field lands below review threshold', () => {
    const out = attachConfidence(model, [
      { name: '备注', value: 'free-invented', sourceSpans: [{ blockId: 'b1', start: 0, end: 1 }] },
    ], 0.9);
    expect(out[0].strength).toBe('none');
    expect(out[0].needsReview).toBe(true);
    expect(out[0].autoAccepted).toBe(false);
  });
});
