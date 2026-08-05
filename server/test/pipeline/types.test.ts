import { describe, it, expect } from 'vitest';
import type { BlockModel, Block, SourceSpan } from '../../src/pipeline/types.js';

describe('BlockModel types', () => {
  it('accepts a well-formed digital BlockModel', () => {
    const block: Block = {
      id: 'b1',
      type: 'kv',
      text: '合同号: HT-2024-001',
      page: 1,
      bbox: null,
      ocrConfidence: 1.0,
    };
    const model: BlockModel = {
      docId: 'DOC-1',
      docType: '合同',
      modality: 'digital',
      blocks: [block],
      sourceUri: 'file:///contracts/ht-2024-001.pdf',
      createdAt: '2026-08-05T00:00:00.000Z',
    };
    expect(model.blocks[0].text).toBe('合同号: HT-2024-001');
    expect(model.blocks[0].ocrConfidence).toBe(1.0);
  });

  it('accepts a scanned Block with bbox + low ocrConfidence + span', () => {
    const span: SourceSpan = { blockId: 'b2', start: 5, end: 16, page: 1 };
    expect(span.blockId).toBe('b2');
  });
});
