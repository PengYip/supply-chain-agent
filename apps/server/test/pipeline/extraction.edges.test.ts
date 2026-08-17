import { describe, it, expect } from 'vitest';
import { deriveProposedEdges } from '../../src/pipeline/extraction.js';

const f = (name: string, value: string, confidence = 0.9) => ({ name, value, confidence });

describe('deriveProposedEdges', () => {
  it('合同字段派生 party/commodity/references 边，但不派生 executes', () => {
    const edges = deriveProposedEdges('合同', [
      f('甲方', 'A公司'), f('乙方', 'B公司'), f('标的物', '动力煤'), f('合同号', 'HT-1'),
    ]);
    expect(edges).toContainEqual(expect.objectContaining({ type: 'party', dstKind: 'Party', dstName: 'A公司', role: '买方' }));
    expect(edges).toContainEqual(expect.objectContaining({ type: 'party', dstKind: 'Party', dstName: 'B公司', role: '卖方' }));
    expect(edges).toContainEqual(expect.objectContaining({ type: 'commodity', dstKind: 'Commodity', dstName: '动力煤' }));
    expect(edges).toContainEqual(expect.objectContaining({ type: 'references', dstKind: 'Contract', dstName: 'HT-1' }));
    expect(edges.some((e) => e.type === 'executes')).toBe(false);
  });
  it('发票/提单/装箱单带合同号时派生 executes（执行合同）', () => {
    for (const docType of ['发票', '提单', '装箱单']) {
      const edges = deriveProposedEdges(docType, [f('合同号', 'HT-1', 0.8), f('卖方', 'B公司')]);
      expect(edges).toContainEqual(expect.objectContaining({ type: 'executes', dstKind: 'Contract', dstName: 'HT-1', confidence: 0.8 }));
    }
  });
  it('提单场景支持 发货人/收货人/承运人 party 角色', () => {
    const edges = deriveProposedEdges('提单', [f('发货人', 'S公司'), f('收货人', 'R公司'), f('承运人', 'C航运')]);
    expect(edges).toContainEqual(expect.objectContaining({ type: 'party', role: '发货人', dstName: 'S公司' }));
    expect(edges).toContainEqual(expect.objectContaining({ type: 'party', role: '收货人', dstName: 'R公司' }));
    expect(edges).toContainEqual(expect.objectContaining({ type: 'party', role: '承运人', dstName: 'C航运' }));
  });
  it('合同号与合同编号同值时 references/executes 去重', () => {
    const edges = deriveProposedEdges('发票', [f('合同号', 'HT-1'), f('合同编号', 'HT-1')]);
    expect(edges.filter((e) => e.type === 'references')).toHaveLength(1);
    expect(edges.filter((e) => e.type === 'executes')).toHaveLength(1);
  });
  it('无可关联字段返回 []', () => {
    expect(deriveProposedEdges('发票', [f('金额', '1000')])).toEqual([]);
  });
});
