import { describe, it, expect } from 'vitest';
import { deriveProposedRelationships, deriveProposedEdges } from '../../src/pipeline/extraction.js';
import type { ExtractedField } from '../../src/pipeline/extraction.js';
import { TRADE_VOCAB, type TradeVocabulary } from '../../src/domain/tradeSemantics.js';

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
    // Lane A (2a): 合同号 now also lifts a Contract proposal.
    expect(rels).toContainEqual(expect.objectContaining({ kind: 'Contract', name: 'HT001' }));
  });
  it('returns [] when no relatable fields are present', () => {
    // 合同号 now lifts a Contract proposal, so use an inert field for the
    // empty-array case.
    expect(deriveProposedRelationships([f('金额', '1000')])).toEqual([]);
  });
  it('derives Contract from 合同号 / 合同编号 and carries confidence', () => {
    const a = deriveProposedRelationships([f('合同号', 'HT-2024-001', 0.97)]);
    expect(a).toEqual([{ kind: 'Contract', name: 'HT-2024-001', confidence: 0.97 }]);
    const b = deriveProposedRelationships([f('合同编号', 'CN-9', 0.8)]);
    expect(b).toEqual([{ kind: 'Contract', name: 'CN-9', confidence: 0.8 }]);
  });
  it('skips empty/whitespace values', () => {
    expect(deriveProposedRelationships([f('甲方', '   ')])).toEqual([]);
  });
  it('carries field confidence onto the relationship', () => {
    const rels = deriveProposedRelationships([f('甲方', 'ACME', 0.55)]);
    expect(rels[0].confidence).toBe(0.55);
  });

  it('发货人/收货人/承运人 提升为 Party 提议（design 2026-08-17）', () => {
    const rels = deriveProposedRelationships([f('发货人', 'S公司'), f('收货人', 'R公司'), f('承运人', 'C航运')]);
    expect(rels).toContainEqual(expect.objectContaining({ kind: 'Party', role: '发货人', name: 'S公司' }));
    expect(rels).toContainEqual(expect.objectContaining({ kind: 'Party', role: '收货人', name: 'R公司' }));
    expect(rels).toContainEqual(expect.objectContaining({ kind: 'Party', role: '承运人', name: 'C航运' }));
  });
});

describe('TradeVocabulary 注入（L2 租户定制口子）', () => {
  /** 客户别名词汇表: 「购方/销方」当角色字段, 私有合同号字段 「契约编号」。 */
  const custom: TradeVocabulary = {
    ...TRADE_VOCAB,
    roleByField: { 购方: '买方', 销方: '卖方' },
    contractFields: new Set(['契约编号']),
    executesDocTypes: new Set(['货转单']),
  };

  it('deriveProposedRelationships 用注入词汇表识别客户别名角色', () => {
    const rels = deriveProposedRelationships([f('购方', '华能'), f('契约编号', 'HT-9')], custom);
    expect(rels).toContainEqual(expect.objectContaining({ kind: 'Party', role: '买方', name: '华能' }));
    expect(rels).toContainEqual(expect.objectContaining({ kind: 'Contract', name: 'HT-9' }));
    // 默认词汇表不认识这些字段名 -> 同输入派生不出提议。
    expect(deriveProposedRelationships([f('购方', '华能')])).toEqual([]);
  });

  it('deriveProposedEdges 用注入词汇表决定 executes 边的 docType 集合', () => {
    const fields = [f('契约编号', 'HT-9')];
    const customEdges = deriveProposedEdges('货转单', fields, custom);
    expect(customEdges).toContainEqual(expect.objectContaining({ type: 'executes', dstName: 'HT-9' }));
    // 默认词汇表不认识 契约编号 字段 -> 同输入派生不出任何边。
    const defaultEdges = deriveProposedEdges('货转单', fields);
    expect(defaultEdges).toEqual([]);
  });
});
