import { describe, expect, it } from 'vitest';
import {
  LANEPAD,
  classifyEdge,
  computeLayeredLayout,
} from '../src/components/graph/layeredLayout';
import type { GraphEdge, GraphNode } from '../src/hooks/useGraph';

function n(elementId: string, kind: string, name = elementId): GraphNode {
  return { elementId, kind, name, props: null };
}
function e(elementId: string, type: string, srcId: string, dstId: string): GraphEdge {
  return { elementId, type, srcId, dstId, props: null, confidence: null };
}

describe('classifyEdge', () => {
  it('part_of 的项目-合同边是层级边', () => {
    expect(classifyEdge('part_of', 'Contract', 'Project')).toBe('hierarchy');
  });
  it('executes/references/binds 类合同-单据边是层级边', () => {
    expect(classifyEdge('executes', 'Contract', 'Document')).toBe('hierarchy');
    expect(classifyEdge('references', 'Document', 'Contract')).toBe('hierarchy');
    expect(classifyEdge('binds', 'Document', 'Contract')).toBe('hierarchy');
  });
  it('其余是普通边', () => {
    expect(classifyEdge('counterparty', 'Party', 'Party')).toBe('plain');
    expect(classifyEdge('part_of', 'Document', 'Project')).toBe('plain');
  });
});

describe('computeLayeredLayout', () => {
  const project = n('p1', 'Project', '电解铜进口');
  const contract = n('c1', 'Contract', 'HT-2026-001');
  const party = n('s1', 'Party', '赣州冶炼厂');
  const docA = n('d1', 'Document', '发票.pdf');
  const docB = n('d2', 'Document', '提单.pdf');
  const nodes = [contract, docA, docB, party, project];
  const edges = [
    e('e1', 'part_of', 'c1', 'p1'),
    e('e2', 'party', 'c1', 's1'),
    e('e3', 'references', 'd1', 'c1'),
    e('e4', 'binds', 'd2', 'c1'),
  ];

  it('单据归首次引用它的合同下方（y 大于合同）', () => {
    const r = computeLayeredLayout(nodes, edges);
    const c = r.positions['c1']!;
    const d = r.positions['d1']!;
    expect(d.y).toBeGreaterThan(c.y);
    expect(r.comboOf['d1']).toBe(r.comboOf['c1']);
  });

  it('单据只占一处位置（跨合同引用不复制节点）', () => {
    const c2 = n('c2', 'Contract', 'HT-2026-002');
    const r = computeLayeredLayout(
      [...nodes, c2],
      [...edges, e('e5', 'references', 'd1', 'c2')],
    );
    const positionsForD1 = Object.entries(r.positions).filter(([id]) => id === 'd1');
    expect(positionsForD1.length).toBe(1);
  });

  it('主体挂在项目旁边（同泳道、位于项目与合同之间）', () => {
    const r = computeLayeredLayout(nodes, edges);
    expect(r.comboOf['s1']).toBe(r.comboOf['p1']);
    const proj = r.positions['p1']!;
    const aux = r.positions['s1']!;
    const con = r.positions['c1']!;
    expect(aux.y).toBeGreaterThan(proj.y);
    expect(aux.y).toBeLessThan(con.y);
  });

  it('单项目时恰好一个泳道 Combo（孤儿区除外）', () => {
    const r = computeLayeredLayout(nodes, edges);
    expect(r.comboIds.length).toBe(1);
    expect(r.scatterIds.size).toBe(0);
  });

  it('多项目各自成泳道且水平错开', () => {
    const p2 = n('p2', 'Project', '锌锭出口');
    const c2 = n('c2', 'Contract', 'ZN-2026-002');
    const d3 = n('d3', 'Document', '箱单.pdf');
    const r = computeLayeredLayout(
      [...nodes, p2, c2, d3],
      [...edges, e('e6', 'part_of', 'c2', 'p2'), e('e7', 'references', 'd3', 'c2')],
    );
    expect(new Set([r.comboOf['p1'], r.comboOf['p2']]).size).toBe(2);
    expect(r.positions['p2']!.x).not.toBe(r.positions['p1']!.x);
    expect(Object.keys(r.positions).length).toBe(nodes.length + 3);
    // 泳道包围盒随节点输出, 且互不重叠(x 区间分离)
    const [l1, l2] = r.lanes;
    expect(l1 && l2 && l1.x + l1.width <= l2.x || l2.x + l2.width <= l1.x).toBe(true);
  });

  it('无合同时散落单据进孤儿区标记 scatterIds', () => {
    const lone = n('dx', 'Document', '申报单.pdf');
    const r = computeLayeredLayout([lone], []);
    expect(r.scatterIds.has('dx')).toBe(true);
  });

  it('无项目时合同作为伪泳道根仍然成立', () => {
    const r = computeLayeredLayout([contract, docA], [e('e8', 'references', 'd1', 'c1')]);
    expect(r.comboOf['c1']).toBeTruthy();
    expect(r.positions['c1']).toBeTruthy();
    expect(r.positions['d1']).toBeTruthy();
  });

  it('合同超宽时折成多排(第二排 y 更大)', () => {
    const many = Array.from({ length: 6 }, (_, i) =>
      n(`cw${i}`, 'Contract', `LONG-CONTRACT-NO-${i}-ABCDEF`),
    );
    const bigProj = n('bp', 'Project', '超大项目集');
    const r = computeLayeredLayout(
      [bigProj, ...many],
      many.map((m, i) => e(`el${i}`, 'part_of', m.elementId, 'bp')),
    );
    const ys = new Set(many.map((m) => r.positions[m.elementId]!.y));
    expect(ys.size).toBeGreaterThanOrEqual(2);
    // 每条泳道宽度受预算限制(合同排宽 <= 预算 + 内边距)
    for (const l of r.lanes) {
      expect(l.width).toBeLessThanOrEqual(720 + LANEPAD * 2);
    }
  });

  it('泳道几何已导出且首条含项目根', () => {
    const r = computeLayeredLayout(nodes, edges);
    expect(r.lanes.length).toBeGreaterThanOrEqual(1);
    const firstLane = r.lanes[0]!;
    const projPos = r.positions[project.elementId]!;
    expect(projPos.x).toBeGreaterThanOrEqual(firstLane.x);
    expect(projPos.x).toBeLessThanOrEqual(firstLane.x + firstLane.width);
  });
});
