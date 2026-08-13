import { describe, it, expect } from 'vitest';
import { deriveProposedRelationships } from '../../src/pipeline/extraction.js';
import type { ExtractedField } from '../../src/pipeline/extraction.js';

function f(name: string, value: string, confidence = 0.9): ExtractedField {
  return { name, value, sourceSpans: [], strength: 'exact', confidence, needsReview: false, autoAccepted: true, citedText: '' };
}

describe('deriveProposedRelationships', () => {
  it('derives Party(买方/卖方) + Commodity from contract fields', () => {
    const rels = deriveProposedRelationships([
      f('甲方', 'ABC公司'), f('乙方', 'XYZ公司'), f('标的物', '动力煤'), f('合同号', 'HT001'),
    ]);
    expect(rels).toContainEqual(expect.objectContaining({ kind: 'Party', role: '买方', name: 'ABC公司' }));
    expect(rels).toContainEqual(expect.objectContaining({ kind: 'Party', role: '卖方', name: 'XYZ公司' }));
    expect(rels).toContainEqual(expect.objectContaining({ kind: 'Commodity', name: '动力煤' }));
    expect(rels.find((r) => r.name === 'HT001')).toBeUndefined();
  });
  it('returns [] when no counterparty/commodity fields present', () => {
    expect(deriveProposedRelationships([f('合同号', 'HT001')])).toEqual([]);
  });
  it('skips empty/whitespace values', () => {
    expect(deriveProposedRelationships([f('甲方', '   ')])).toEqual([]);
  });
  it('carries field confidence onto the relationship', () => {
    const rels = deriveProposedRelationships([f('甲方', 'ACME', 0.55)]);
    expect(rels[0].confidence).toBe(0.55);
  });
});
