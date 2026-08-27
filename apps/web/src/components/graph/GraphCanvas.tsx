// G6 v5 画布 — 语义分层泳道布局(spec 2026-08-27)。
// GraphView 以 key={center} 重挂载本组件, 内部不做增量 diff,
// 只在 hiddenKinds 变化时 setData 重绘(布局随过滤结果重算)。
// 布局为 layeredLayout 纯函数的显式坐标落位: 泳道=Combo, 节点=圆角卡片。
import { useEffect, useMemo, useRef } from 'react';
import { Graph as G6Graph, type EdgeData, type IElementEvent, type NodeData } from '@antv/g6';
import type { GraphEdge, GraphNode, InspectTarget, Subgraph } from '../../hooks/useGraph';
import { EDGE_STYLE_OVERRIDES, businessTypeOf, nodeDisplayName } from './businessTypes';
import { fitCaption } from './captionFit';
import { useDocMeta } from './docMeta';
import { cardGeometry, classifyEdge, computeLayeredLayout } from './layeredLayout';

interface GraphCanvasProps {
  subgraph: Subgraph;
  centerElementId: string | null;
  /** 隐藏的节点类型(图例点选过滤), 空集合 = 全部可见。 */
  hiddenKinds: ReadonlySet<string>;
  onHover: (t: InspectTarget | null) => void;
  onNodeSelect: (node: GraphNode) => void;
  onEdgeSelect: (edge: GraphEdge) => void;
  onPaneSelect: () => void;
  /** 双击节点 = 增量展开(以该节点为新中心)。 */
  onNodeDoubleClick: (node: GraphNode) => void;
}

interface CanvasDatum {
  kind: string;
  name: string;
  props: Record<string, unknown> | null;
  rawNode?: GraphNode;
  rawEdge?: GraphEdge;
  pseudo?: boolean;
  [key: string]: unknown;
}

export function GraphCanvas({
  subgraph, hiddenKinds, onHover, onNodeSelect, onEdgeSelect, onPaneSelect, onNodeDoubleClick,
}: GraphCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const graphRef = useRef<G6Graph | null>(null);
  const docMeta = useDocMeta();
  // 渲染串行化: 所有 render/setData 排队执行, 避免并发渲染交错
  // (StrictMode 双挂载、快速切换类型过滤时 render 仍在途)。
  const renderChainRef = useRef<Promise<void>>(Promise.resolve());
  // 已应用的类型过滤集合: 建图 effect 已按初始值渲染, hiddenKinds effect 跳过首次。
  const appliedKindsRef = useRef<ReadonlySet<string> | null>(null);

  const buildData = (nodes: GraphNode[], edges: GraphEdge[]) => {
    const visibleNodes = nodes.filter((n) => !hiddenKinds.has(n.kind));
    const visibleIds = new Set(visibleNodes.map((n) => n.elementId));
    const visibleEdges = edges.filter(
      (e) => visibleIds.has(e.srcId) && visibleIds.has(e.dstId),
    );

    // 分层泳道布局: 显式坐标, 交由 Combo 圈定泳道区域
    const layout = computeLayeredLayout(visibleNodes, visibleEdges);
    const kindById = new Map(visibleNodes.map((n) => [n.elementId, n.kind]));
    const nameOf = new Map(visibleNodes.map((n) => [n.elementId, nodeDisplayName(n, docMeta)]));

    const g6Nodes = visibleNodes.map((n) => {
      const bt = businessTypeOf(n.kind);
      const geo = cardGeometry(n.kind, n.name);
      const pos = layout.positions[n.elementId] ?? { x: 0, y: 0 };
      const isScatter = layout.scatterIds.has(n.elementId);
      const isRoot = n.kind === 'Project';
      return {
        id: n.elementId,
        type: 'rect',
        combo: layout.comboOf[n.elementId],
        data: { kind: n.kind, name: n.name, props: n.props, rawNode: n } as CanvasDatum,
        style: {
          x: pos.x,
          y: pos.y,
          width: geo.width,
          height: geo.height,
          radius: isRoot ? 10 : 8,
          fill: bt.softBg,
          stroke: bt.color,
          lineWidth: isRoot ? 0 : 1.5,
          lineDash: isScatter ? [4, 3] : undefined,
          ...(isRoot ? { fill: bt.color } : {}),
          labelText: fitCaption(nameOf.get(n.elementId) ?? '', { diameter: geo.width * 0.92, fontSize: 11 }),
          labelPlacement: 'center' as const,
          labelFill: isRoot ? '#FFFFFF' : '#374151',
          labelFontSize: 11,
          labelLineHeight: 13,
          labelMaxLines: 2,
          labelTextAlign: 'center' as const,
          // 左侧色标(badge): kind 主色的窄竖条, 承载语义色
          badges: [{
            text: '',
            placement: 'left' as const,
            backgroundFill: bt.color,
            padding: [0, 1],
            fill: 'transparent',
          }],
        },
      };
    });

    // 层标尺伪节点: 随画布平移缩放; 无 rawNode → 事件守卫天然免疫交互
    for (const anchor of layout.rulerAnchors) {
      g6Nodes.push({
        id: anchor.id,
        data: { kind: '__Ruler__', name: anchor.label, props: null, pseudo: true } as CanvasDatum,
        style: {
          x: anchor.x,
          y: anchor.y,
          width: 2,
          height: 2,
          fill: 'transparent',
          lineWidth: 0,
          labelText: anchor.label,
          labelFill: '#94A3B8',
          labelFontSize: 11,
        },
      } as (typeof g6Nodes)[number]);
    }

    const g6Edges = visibleEdges.map((ed) => {
      const override = EDGE_STYLE_OVERRIDES[ed.type];
      const cls = classifyEdge(ed.type, kindById.get(ed.srcId) ?? '', kindById.get(ed.dstId) ?? '');
      return {
        id: ed.elementId,
        type: cls === 'hierarchy' ? ('cubic-vertical' as const) : ('quadratic' as const),
        source: ed.srcId,
        target: ed.dstId,
        data: { kind: ed.type, name: ed.type, props: ed.props, rawEdge: ed } as CanvasDatum,
        style: {
          stroke: override?.color ?? (cls === 'hierarchy' ? '#CBD5E1' : '#94A3B8'),
          lineWidth: cls === 'hierarchy' ? 1.5 : 1,
          ...(override?.dashed ? { lineDash: [4, 3] } : {}),
          endArrow: true,
          endArrowSize: 6,
        },
      };
    });

    return {
      nodes: g6Nodes,
      edges: g6Edges,
      combos: layout.comboIds.map((c) => ({ id: c.id })),
    };
  };

  // 建图(重挂载时全量重建)
  useEffect(() => {
    if (!containerRef.current) return;
    appliedKindsRef.current = hiddenKinds;
    const data = buildData(subgraph.nodes, subgraph.edges);
    const graph = new G6Graph({
      container: containerRef.current,
      autoFit: 'view',
      // 侧栏折叠/窗口缩放时自动跟随容器尺寸重排, 避免画布被裁剪。
      autoResize: true,
      data,
      // 坐标由 layeredLayout 显式给出, 不再使用内置布局
      behaviors: ['drag-canvas', 'zoom-canvas', 'drag-element', 'click-select'],
      node: {
        state: {
          selected: { stroke: '#4A6D8C', lineWidth: 2 },
        },
      },
      combo: {
        style: {
          fill: '#FFFFFF',
          stroke: '#E2E8F0',
          lineWidth: 1,
          radius: 12,
        },
      },
      plugins: [
        // 贸易蓝图点阵底纹(「贸易蓝图」视觉方案 §5.1); 手动验证若报错可移除
        { type: 'grid-line', size: 22 },
        { type: 'minimap', size: [140, 90] },
      ],
      animation: false,
    });
    graphRef.current = graph;
    // 本实例销毁标记: StrictMode 卸载后, 排队的异步渲染续体不得再触碰该实例。
    let disposed = false;

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

    // 渲染入队: 销毁后跳过。首帧延迟到 requestAnimationFrame 规避 StrictMode 双挂载竞态。
    renderChainRef.current = renderChainRef.current
      .then(
        () =>
          new Promise<void>((resolve) => {
            requestAnimationFrame(() => resolve());
          }),
      )
      .then(() => {
        if (disposed) return;
        return graph.render();
      })
      .catch((e) => {
        if (!disposed) console.error(e);
      });

    return () => {
      disposed = true;
      graph.destroy();
      graphRef.current = null;
    };
    // 重挂载键在 GraphView 控制, 本 effect 只在挂载时执行一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // hiddenKinds 变化: 过滤重绘(不重建实例); 首次挂载已由建图 effect 渲染, 跳过避免并发 render。
  useEffect(() => {
    const graph = graphRef.current;
    if (!graph) return;
    if (appliedKindsRef.current === hiddenKinds) return;
    appliedKindsRef.current = hiddenKinds;
    const data = buildData(subgraph.nodes, subgraph.edges);
    renderChainRef.current = renderChainRef.current
      .then(() => {
        if (graphRef.current !== graph) return; // 实例已被销毁/替换
        graph.setData(data);
        return graph.render();
      })
      .catch((e) => {
        if (graphRef.current === graph) console.error(e);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hiddenKinds]);

  const tip = useMemo(
    () => `自上而下 项目 · 合同 · 履约 — 双击节点向外展开 · 已隐藏类型 ${hiddenKinds.size || '无'}`,
    [hiddenKinds],
  );

  return (
    <div className="animate-fade-in h-full w-full">
      <div ref={containerRef} className="h-full w-full" data-testid="g6-canvas" />
      <div className="pointer-events-none absolute bottom-3 left-3 z-10 rounded-md border border-line bg-white/90 px-2 py-1 text-[10px] text-ink-soft">
        {tip}
      </div>
    </div>
  );
}
