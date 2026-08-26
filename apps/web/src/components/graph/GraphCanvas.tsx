// G6 v5 画布(spec 2026-08-26 §4.4): 命令式生命周期 + 稳定 props 契约。
// GraphView 以 key={center-depth-direction} 重挂载本组件, 内部不做增量 diff,
// 只在 hiddenKinds 变化时 setData 重绘。@xyflow/react 退役(本期仅 BindingMiniGraph 仍用)。
import { useEffect, useMemo, useRef } from 'react';
import { Graph as G6Graph, type EdgeData, type IElementEvent, type NodeData } from '@antv/g6';
import type { GraphEdge, GraphNode, InspectTarget, Subgraph } from '../../hooks/useGraph';
import { EDGE_STYLE_OVERRIDES, businessTypeOf, edgeLabel, nodeDisplayName } from './businessTypes';
import { useDocMeta } from './docMeta';

interface GraphCanvasProps {
  subgraph: Subgraph;
  centerElementId: string | null;
  /** 隐藏的节点类型(图例点选过滤), 空集合 = 全部可见。 */
  hiddenKinds: ReadonlySet<string>;
  onHover: (t: InspectTarget | null) => void;
  onNodeSelect: (node: GraphNode) => void;
  onEdgeSelect: (edge: GraphEdge) => void;
  onPaneSelect: () => void;
  /** 双击节点 = 增量展开(以该节点为新中心, Bloom 核心交互)。 */
  onNodeDoubleClick: (node: GraphNode) => void;
}

interface CanvasDatum {
  kind: string;
  name: string;
  props: Record<string, unknown> | null;
  rawNode?: GraphNode;
  rawEdge?: GraphEdge;
  // G6 NodeData/EdgeData 的 data 字段要求 Record<string, unknown> 索引签名。
  [key: string]: unknown;
}

export function GraphCanvas({
  subgraph, centerElementId, hiddenKinds, onHover, onNodeSelect, onEdgeSelect, onPaneSelect, onNodeDoubleClick,
}: GraphCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const graphRef = useRef<G6Graph | null>(null);
  const docMeta = useDocMeta();

  const toNodes = (nodes: GraphNode[]) =>
    nodes
      .filter((n) => !hiddenKinds.has(n.kind))
      .map((n) => {
        const bt = businessTypeOf(n.kind);
        const isCenter = n.elementId === centerElementId;
        return {
          id: n.elementId,
          data: { kind: n.kind, name: n.name, props: n.props, rawNode: n } as CanvasDatum,
          style: {
            size: isCenter ? 44 : 30,
            fill: bt.color,
            // Document=空心(描边家族区分), 实体=实心, 对齐原画布视觉
            ...(n.kind === 'Document' ? { fill: '#FFFFFF', lineWidth: 2, stroke: bt.color } : {}),
            labelText: nodeDisplayName(n, docMeta),
            labelPlacement: 'bottom' as const,
            labelFill: '#374151',
            labelFontSize: 11,
          },
        };
      });

  const toEdges = (edges: GraphEdge[], visibleNodeIds: Set<string>) =>
    edges
      .filter((e) => visibleNodeIds.has(e.srcId) && visibleNodeIds.has(e.dstId))
      .map((e) => {
        const override = EDGE_STYLE_OVERRIDES[e.type];
        return {
          id: e.elementId,
          source: e.srcId,
          target: e.dstId,
          data: { kind: e.type, name: e.type, props: e.props, rawEdge: e } as CanvasDatum,
          style: {
            stroke: override?.color ?? '#94A3B8',
            lineWidth: 1,
            ...(override?.dashed ? { lineDash: [4, 3] } : {}),
            labelText: edgeLabel(e.type),
            labelFontSize: 10,
            labelFill: '#6B7280',
            endArrow: true,
          },
        };
      });

  // 建图(重挂载时全量重建)
  useEffect(() => {
    if (!containerRef.current) return;
    const nodes = toNodes(subgraph.nodes);
    const nodeIds = new Set(nodes.map((n) => n.id));
    const edges = toEdges(subgraph.edges, nodeIds);
    const graph = new G6Graph({
      container: containerRef.current,
      autoFit: 'view',
      data: { nodes, edges },
      layout: { type: 'force', linkDistance: 90, nodeStrength: -120, collideStrength: 1 },
      behaviors: ['drag-canvas', 'zoom-canvas', 'drag-element', 'click-select'],
      plugins: [{ type: 'minimap', size: [140, 90] }],
      animation: false,
    });
    graphRef.current = graph;

    // G6 v5 事件对象 target 是元素实例(带 id), 数据经 graph.getElementData(id) 取回。
    graph.on<IElementEvent>('node:click', (ev) => {
      const datum = graph.getElementData(ev.target.id) as NodeData;
      const raw = (datum.data as unknown as CanvasDatum | undefined)?.rawNode;
      if (raw) onNodeSelect(raw);
    });
    graph.on<IElementEvent>('edge:click', (ev) => {
      const datum = graph.getElementData(ev.target.id) as EdgeData;
      const raw = (datum.data as unknown as CanvasDatum | undefined)?.rawEdge;
      if (raw) onEdgeSelect(raw);
    });
    graph.on('canvas:click', () => onPaneSelect());
    graph.on<IElementEvent>('node:dblclick', (ev) => {
      const datum = graph.getElementData(ev.target.id) as NodeData;
      const raw = (datum.data as unknown as CanvasDatum | undefined)?.rawNode;
      if (raw) onNodeDoubleClick(raw);
    });
    graph.on<IElementEvent>('node:pointerenter', (ev) => {
      const datum = graph.getElementData(ev.target.id) as NodeData;
      const raw = (datum.data as unknown as CanvasDatum | undefined)?.rawNode;
      if (raw) onHover({ type: 'node', node: raw });
    });
    graph.on('node:pointerleave', () => onHover(null));

    void graph.render()
      .then(() => {
        if (centerElementId) {
          // focusElement 返回 Promise, 异步拒绝用 catch 吞掉(中心节点被过滤时不定位)。
          graph.focusElement(centerElementId).catch(() => { /* 中心节点被过滤时不定位 */ });
        }
      })
      .catch(console.error);

    return () => {
      graph.destroy();
      graphRef.current = null;
    };
    // 重挂载键在 GraphView 控制, 本 effect 只在挂载时执行一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // hiddenKinds 变化: 过滤重绘(不重建实例)
  useEffect(() => {
    const graph = graphRef.current;
    if (!graph) return;
    const nodes = toNodes(subgraph.nodes);
    const nodeIds = new Set(nodes.map((n) => n.id));
    graph.setData({ nodes, edges: toEdges(subgraph.edges, nodeIds) });
    void graph.render();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hiddenKinds]);

  const tip = useMemo(
    () => `双击节点向外展开 · 已隐藏类型 ${hiddenKinds.size || '无'}`,
    [hiddenKinds],
  );

  return (
    <div className="h-full w-full">
      <div ref={containerRef} className="h-full w-full" data-testid="g6-canvas" />
      <div className="pointer-events-none absolute bottom-3 left-3 z-10 rounded-md border border-line bg-white/90 px-2 py-1 text-[10px] text-ink-soft">
        {tip}
      </div>
    </div>
  );
}