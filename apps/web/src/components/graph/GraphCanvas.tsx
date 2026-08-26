// G6 v5 画布(spec 2026-08-26 §4.4): 命令式生命周期 + 稳定 props 契约。
// GraphView 以 key={center-depth-direction} 重挂载本组件, 内部不做增量 diff,
// 只在 hiddenKinds 变化时 setData 重绘。@xyflow/react 退役(本期仅 BindingMiniGraph 仍用)。
import { useEffect, useMemo, useRef } from 'react';
import { Graph as G6Graph, type EdgeData, type IElementEvent, type NodeData } from '@antv/g6';
import type { GraphEdge, GraphNode, InspectTarget, Subgraph } from '../../hooks/useGraph';
import { EDGE_STYLE_OVERRIDES, businessTypeOf, edgeLabel, nodeDisplayName } from './businessTypes';
import { fitCaption } from './captionFit';
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
  // 渲染串行化: 所有 render/setData 排队执行, 避免并发渲染交错
  // (StrictMode 双挂载、快速切换类型过滤时 render 仍在途)。
  const renderChainRef = useRef<Promise<void>>(Promise.resolve());
  // 已应用的类型过滤集合: 建图 effect 已按初始值渲染, hiddenKinds effect 跳过首次。
  const appliedKindsRef = useRef<ReadonlySet<string> | null>(null);

  // 度数自适应 + label 画入圆内(spec 2026-08-26 §2): 度数高=连接多=节点大,
  // 大节点装得下更多文字且给布局留出物理间距(Neo4j Browser 同款行为)。
  // label 原本悬浮在节点下方(labelPlacement:'bottom'), radial 布局节点密集时
  // 相邻 label 互相覆盖且 G6 preventOverlap 只约束节点圆形、不管文本。
  const buildData = (nodes: GraphNode[], edges: GraphEdge[]) => {
    const visibleNodes = nodes.filter((n) => !hiddenKinds.has(n.kind));
    const visibleIds = new Set(visibleNodes.map((n) => n.elementId));
    const visibleEdges = edges.filter(
      (e) => visibleIds.has(e.srcId) && visibleIds.has(e.dstId),
    );
    const degree = new Map<string, number>();
    for (const e of visibleEdges) {
      degree.set(e.srcId, (degree.get(e.srcId) ?? 0) + 1);
      degree.set(e.dstId, (degree.get(e.dstId) ?? 0) + 1);
    }
    const sizeOf = (n: GraphNode): number => {
      const base = Math.min(Math.max(16 + (degree.get(n.elementId) ?? 0) * 1.8, 16), 34);
      return n.elementId === centerElementId ? Math.max(base, 44) : base;
    };
    const g6Nodes = visibleNodes.map((n) => {
      const bt = businessTypeOf(n.kind);
      const size = sizeOf(n);
      // Document=空心(描边家族区分, 深色文字), 实体=实心(白色文字)
      const hollow = n.kind === 'Document';
      return {
        id: n.elementId,
        // data.size 供 radial 布局的 nodeSize 回调读取(碰撞检测按真实尺寸)
        data: { kind: n.kind, name: n.name, props: n.props, rawNode: n, size } as CanvasDatum,
        style: {
          size,
          fill: bt.color,
          ...(hollow ? { fill: '#FFFFFF', lineWidth: 2, stroke: bt.color } : {}),
          labelText: fitCaption(nodeDisplayName(n, docMeta), { diameter: size, fontSize: 11 }),
          labelPlacement: 'center' as const,
          labelFill: hollow ? '#374151' : '#FFFFFF',
          labelFontSize: 11,
          labelLineHeight: 1.1,
          labelTextAlign: 'center' as const,
        },
      };
    });
    const g6Edges = visibleEdges.map((e) => {
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
          // 白色衬底: 边文字不再被线穿过(label shape 的 background 系列样式)
          labelBackground: true,
          labelBackgroundFill: '#FFFFFF',
          labelBackgroundRadius: 2,
          labelBackgroundOpacity: 0.85,
          endArrow: true,
        },
      };
    });
    return { nodes: g6Nodes, edges: g6Edges };
  };

  // 建图(重挂载时全量重建)
  useEffect(() => {
    if (!containerRef.current) return;
    appliedKindsRef.current = hiddenKinds;
    const { nodes, edges } = buildData(subgraph.nodes, subgraph.edges);
    const graph = new G6Graph({
      container: containerRef.current,
      autoFit: 'view',
      data: { nodes, edges },
      // 力导布局在 animation:false 下节点堆叠原点(实测 G6 5.1.1), 改用径向布局:
      // 中心节点置中、其余按环半径展开, 契合"以查询节点为中心"的探索语义。
      layout: {
        type: 'radial',
        focusNode: centerElementId ?? undefined,
        unitRadius: 110,
        linkDistance: 90,
        preventOverlap: true,
        // 防重叠按各节点真实直径(data.size) + 24px 最小间距计算;
        // 原来固定 nodeSize:30 与实际尺寸脱节, 大节点仍会被挤到一起。
        nodeSpacing: 24,
        nodeSize: (d: NodeData) => (d.data as CanvasDatum | undefined)?.size ?? 30,
      },
      behaviors: ['drag-canvas', 'zoom-canvas', 'drag-element', 'click-select'],
      plugins: [{ type: 'minimap', size: [140, 90] }],
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

    // 渲染入队: 销毁后跳过, 避免 G6 render 续体访问已清空的 context 抛 TypeError。
    // 首帧延迟到 requestAnimationFrame: StrictMode 双挂载在提交阶段同步完成,
    // 实例 A 会在 RAF 前被销毁(disposed=true), 其渲染根本不启动, 消除 G6 内部
    // "instance has been destroyed" 中断日志。
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
    // 注: 不调用 focusElement — 它会把视口缩放到单个节点(实测 G6 5.1.1),
    // autoFit:'view' + radial focusNode 已让中心节点居中, 无需二次定位。

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
    const { nodes, edges } = buildData(subgraph.nodes, subgraph.edges);
    renderChainRef.current = renderChainRef.current
      .then(() => {
        if (graphRef.current !== graph) return; // 实例已被销毁/替换
        graph.setData({ nodes, edges });
        return graph.render();
      })
      .catch((e) => {
        if (graphRef.current === graph) console.error(e);
      });
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