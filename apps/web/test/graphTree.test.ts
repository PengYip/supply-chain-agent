import { describe, expect, it } from 'vitest';
import {
  defaultExpandedProjects,
  normalizeTree,
  treeDocIds,
} from '../src/components/graph/graphTree';

describe('normalizeTree', () => {
  it('归一化完整载荷并丢弃缺 elementId 的坏行', () => {
    const t = normalizeTree({
      projects: [
        {
          elementId: 'p1',
          name: '电解铜进口',
          contracts: [
            { elementId: 'c1', name: 'HT-001', docs: [{ elementId: 'd1', name: '发票.pdf' }, { elementId: '', name: 'bad' }] },
            { elementId: '', name: 'dropme', docs: [] },
          ],
        },
        { elementId: '', name: 'dropProject' },
      ],
      orphanContracts: [{ elementId: 'cx', name: '游离合同', docs: [] }],
    });
    expect(t.projects.length).toBe(1);
    expect(t.projects[0]!.contracts.length).toBe(1);
    expect(t.projects[0]!.contracts[0]!.docs.length).toBe(1);
    expect(t.orphanContracts.length).toBe(1);
  });

  it('非对象/空输入返回空树', () => {
    expect(normalizeTree(null)).toEqual({ projects: [], orphanContracts: [] });
    expect(normalizeTree(42)).toEqual({ projects: [], orphanContracts: [] });
  });
});

describe('treeDocIds', () => {
  it('收集项目与未分组下的全部单据 id', () => {
    const t = normalizeTree({
      projects: [{ elementId: 'p1', name: '', contracts: [{ elementId: 'c1', name: '', docs: [{ elementId: 'd1', name: '' }, { elementId: 'd2', name: '' }] }] }],
      orphanContracts: [{ elementId: 'c9', name: '', docs: [{ elementId: 'd9', name: '' }] }],
    });
    const ids = treeDocIds(t);
    expect([...ids].sort()).toEqual(['d1', 'd2', 'd9']);
    expect(treeDocIds(null).size).toBe(0);
  });
});

describe('defaultExpandedProjects', () => {
  it('全部项目默认展开、空树为空集合', () => {
    const t = normalizeTree({ projects: [{ elementId: 'p1', name: '', contracts: [] }, { elementId: 'p2', name: '', contracts: [] }], orphanContracts: [] });
    expect(defaultExpandedProjects(t)).toEqual(new Set(['p1', 'p2']));
    expect(defaultExpandedProjects(null).size).toBe(0);
  });
});
