import { describe, it, expect } from 'vitest';
import { validateSpan } from '../../src/pipeline/spanValidator.js';
import type { Block } from '../../src/pipeline/types.js';

const blocks: Block[] = [
  { id: 'b1', type: 'kv', text: '合同号: HT-2024-001', page: 1, bbox: null, ocrConfidence: 1 },
  { id: 'b2', type: 'kv', text: '金额(元): 2,860,000', page: 1, bbox: null, ocrConfidence: 0.95 },
];

describe('validateSpan', () => {
  it('exact match when normalized value equals cited text', () => {
    const r = validateSpan('HT-2024-001', { blockId: 'b1', start: 5, end: 16 }, blocks);
    expect(r.ok).toBe(true);
    expect(r.strength).toBe('exact');
    expect(r.citedText).toBe('HT-2024-001');
  });

  it('fuzzy match when value is contained in cited text (ignore commas/space/case)', () => {
    const r = validateSpan('2860000', { blockId: 'b2', start: 7, end: 16 }, blocks);
    expect(r.ok).toBe(true);
    expect(r.strength).toBe('fuzzy');
  });

  it('none when value absent from cited text', () => {
    const r = validateSpan('999', { blockId: 'b1', start: 0, end: 16 }, blocks);
    expect(r.ok).toBe(false);
    expect(r.strength).toBe('none');
    expect(r.reason).toMatch(/not found/);
  });

  it('none when block id is unknown', () => {
    const r = validateSpan('x', { blockId: 'zzz', start: 0, end: 1 }, blocks);
    expect(r.strength).toBe('none');
    expect(r.reason).toMatch(/not found/);
  });

  it('none when span range is invalid', () => {
    const r = validateSpan('x', { blockId: 'b1', start: 10, end: 2 }, blocks);
    expect(r.strength).toBe('none');
  });
});
