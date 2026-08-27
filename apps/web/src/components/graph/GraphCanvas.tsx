// G6 v5 画布 — 语义分层泳道布局 + HTML 信息卡节点(spec 2026-08-27 评审二轮)。
// 节点用 type:'html' 渲染 DOM 卡片: 类型 Chip / 名称加粗自动折行 / 概述单行省略,
// 排版交由 CSS, 从根本上解决文字溢出与徽标重叠; 坐标仍由 layeredLayout 给出。
// 导航优先: 初始视口聚焦中心节点所在泳道; GraphView 以 key={center} 重挂载。
import { useEffect, useMemo, useRef } from 'react';
import { Graph as G6Graph, type EdgeData, type IElementEvent, type NodeData } from '@antv/g6';
import type { GraphEdge, GraphNode, InspectTarget, Subgraph } from '../../hooks/useGraph';
import { EDGE_STYLE_OVERRIDES, businessTypeOf, docTypeName, nodeDisplayName } from './businessTypes';
import { useDocMeta } from './docMeta';
import { cardGeometry, classifyEdge, computeLayeredLayout } from './layeredLayout';

interface GraphCanvasProps {
  subgraph: Subgraph;
  centerElementId: string | null;
  /** 隐藏的节点类型(图例点选过滤), 空集合 = 全部可见。 */
  hiddenKinds: ReadonlySet<string>;
  /** 是否显示普通关系边(层级履约边与绑定边恒显)。 */
  showPlainEdges: boolean;
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
  /** HTML 卡片标记串(html 节点 innerHTML 直接消费)。 */
  html?: string;
  size?: [number, number];
  [key: string]: unknown;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** 概述行: Document 用业务类型, 其余取首个可读字符串 props。 */
function subtitleOf(nd: GraphNode, docMeta: ReturnType<typeof useDocMeta>): string {
  if (nd.kind === 'Document') return docTypeName(nd, docMeta);
  const keysByKind: Record<string, string[]> = {
    Contract: ['contractNo', 'status', 'amount'],
    Party: ['role', 'country'],
    Project: ['code', 'status'],
  };
  for (const k of keysByKind[nd.kind] ?? []) {
    const v = nd.props?.[k];
    if (typeof v === 'string' && v) return v;
  }
  return '';
}

/** DOM 信息卡模板: 左色条 + 类型 Chip + 名称两行截断 + 概述单行省略。 */
function cardHtml(opts: {
  kindLabel: string; color: string; border: string; name: string; subtitle: string;
  width: number; height: number; scatter: boolean; isRoot: boolean;
}): string {
  const { kindLabel, color, border, name, subtitle, width, height, scatter, isRoot } = opts;
  const bg = isRoot ? '#F5F3FC' : '#FFFFFF';
  const nameColor = '#0F172A';
  return `
<div style="width:${width}px;height:${height}px;box-sizing:border-box;background:${bg};
  border:1px solid ${border};border-left:4px solid ${color};border-radius:10px;
  box-shadow:0 2px 8px rgba(15,23,42,0.12);padding:9px 12px 8px 10px;
  font-family:'PingFang SC','Microsoft YaHei',system-ui,sans-serif;
  display:flex;flex-direction:column;gap:3px;pointer-events:none;user-select:none;overflow:hidden;">
  <div style="display:flex;align-items:center;gap:6px;">
    <span style="background:${color};color:#fff;font-size:10px;line-height:1;
      padding:3px 8px;border-radius:999px;font-weight:600;">${escapeHtml(kindLabel)}</span>
    ${scatter ? '<span style="font-size:10px;color:#94A3B8;border:1px dashed #CBD5E1;padding:2px 6px;border-radius:999px;">散件</span>' : ''}
  </div>
  <div style="font-size:13px;font-weight:600;color:${nameColor};line-height:18px;
    display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;">${escapeHtml(name)}</div>
  ${subtitle ? `<div style="font-size:11px;color:#64748B;line-height:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(subtitle)}</div>` : ''}
</div>`;
}

export function GraphCanvas({
  subgraph, centerElementId, hiddenKinds, showPlainEdges, onHover, onNodeSelect, onEdgeSelect, onPaneSelect, onNodeDoubleClick,
}: GraphCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const graphRef = useRef<G6Graph | null>(null);
  const docMeta = useDocMeta();
  // 渲染串行化: 所有 render/setData 排队执行, 避免并发渲染交错。
  const renderChainRef = useRef<Promise<void>>(Promise.resolve());
  // 已应用的过滤集合: 建图 effect 已按初始值渲染, 后续变化 effect 跳过首次。
  const appliedFiltersRef = useRef<{ kinds: ReadonlySet<string>; plain: boolean } | null>(null);

  const buildData = (nodes: GraphNode[], edges: GraphEdge[]) => {
    const visibleNodes = nodes.filter((n) => !hiddenKinds.has(n.kind));
    const visibleIds = new Set(visibleNodes.map((n) => n.elementId));
    const kindById = new Map(visibleNodes.map((n) => [n.elementId, n.kind]));
    const visibleEdges = edges.filter(
      (e) =>
        visibleIds.has(e.srcId) &&
        visibleIds.has(e.dstId) &&
        (showPlainEdges ||
          classifyEdge(e.type, kindById.get(e.srcId) ?? '', kindById.get(e.dstId) ?? '') === 'hierarchy' ||
          e.type === 'binds'),
    );

    const layout = computeLayeredLayout(visibleNodes, visibleEdges);

    const g6Nodes = visibleNodes.map((nd) => {
      const bt = businessTypeOf(nd.kind);
      const geo = cardGeometry(nd.kind, nd.name);
      const pos = layout.positions[nd.elementId] ?? { x: 0, y: 0 };
      const html = cardHtml({
        kindLabel: bt.displayName,
        color: bt.color,
        border: bt.softBorder,
        name: nodeDisplayName(nd, docMeta),
        subtitle: subtitleOf(nd, docMeta),
        width: geo.width,
        height: geo.height,
        scatter: layout.scatterIds.has(nd.elementId),
        isRoot: nd.kind === 'Project',
      });
      return {
        id: nd.elementId,
        type: 'html' as const,
        combo: layout.comboOf[nd.elementId],
        data: { kind: nd.kind, name: nd.name, props: nd.props, rawNode: nd, html, size: [geo.width, geo.height] } as CanvasDatum,
        style: {
          x: pos.x,
          y: pos.y,
          size: [geo.width, geo.height] as [number, number],
          dx: -geo.width / 2,
          dy: -geo.height / 2,
        },
      };
    });

    const g6Edges = visibleEdges.map((ed) => {
      const override = EDGE_STYLE_OVERRIDES[ed.type];
      const cls = classifyEdge(ed.type, kindById.get(ed.srcId) ?? '', kindById.get(ed.dstId) ?? '');
      return {
        id: ed.elementId,
        type: cls === 'hierarchy' ? ('cubic-vertical' as const) : ('line' as const),
        source: ed.srcId,
        target: ed.dstId,
        data: { kind: ed.type, name: ed.type, props: ed.props, rawEdge: ed } as CanvasDatum,
        style: {
          stroke: override?.color ?? (cls === 'hierarchy' ? '#64748B' : '#CBD5E1'),
          lineWidth: cls === 'hierarchy' ? 2 : 1.25,
          ...(override?.dashed ? { lineDash: [5, 4] } : {}),
          endArrow: true,
          endArrowSize: 7,
        },
      };
    });

    return {
      nodes: g6Nodes,
      edges: g6Edges,
      combos: layout.comboIds.map((c) => ({ id: c.id })),
      layout,
    };
  };

  // 建图(重挂载时全量重建)
  useEffect(() => {
    if (!containerRef.current) return;
    appliedFiltersRef.current = { kinds: hiddenKinds, plain: showPlainEdges };
    const built = buildData(subgraph.nodes, subgraph.edges);
    const { layout } = built;
    const graph = new G6Graph({
      container: containerRef.current,
      autoResize: true,
      data: built,
      behaviors: ['drag-canvas', 'zoom-canvas', 'drag-element', 'click-select'],
      node: {
        type: 'html',
        style: {
          // per-node 尺寸/偏移与卡片标记均预计算进 data
          size: (d: NodeData) => (d.data as unknown as CanvasDatum | undefined)?.size ?? [160, 56],
          dx: (d: NodeData) => -(((d.data as unknown as CanvasDatum | undefined)?.size?.[0] ?? 160) / 2),
          dy: (d: NodeData) => -(((d.data as unknown as CanvasDatum | undefined)?.size?.[1] ?? 56) / 2),
          innerHTML: (d: NodeData) => (d.data as unknown as CanvasDatum | undefined)?.html ?? '',
        },
      },
      combo: {
        style: {
          fill: '#F1F5F9',
          stroke: '#CBD5E1',
          lineWidth: 1,
          radius: 14,
        },
      },
      plugins: [
        { type: 'grid-line', size: 24 },
        { type: 'minimap', size: [140, 90] },
      ],
      animation: false,
    });
    graphRef.current = graph;
    let disposed = false;

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

    renderChainRef.current = renderChainRef.current
      .then(() => new Promise<void>((resolve) => { requestAnimationFrame(() => resolve()); }))
      .then(async () => {
        if (disposed) return;
        await graph.render();
        // 导航优先的初始视口: 聚焦中心节点(或首条泳道根), 自然缩放不拉远到全局。
        try {
          const size = graph.getSize();
          const focusLane =
            layout.lanes.find((l) =>
              centerElementId ? layout.comboOf[centerElementId] === l.id : false,
            ) ?? layout.lanes[0];
          const zoom = focusLane
            ? Math.min(1, Math.max(0.55, Math.min((size[0] * 0.62) / focusLane.width, (size[1] * 0.82) / focusLane.height)))
            : 1;
          await graph.zoomTo(zoom);
          const anchorId =
            centerElementId && layout.positions[centerElementId]
              ? centerElementId
              : Object.entries(layout.comboOf).find(([, lane]) => lane === focusLane?.id)?.[0];
          const fp = anchorId ? layout.positions[anchorId] : null;
          if (fp) {
            const vp = graph.getViewportByCanvas([fp.x, fp.y]);
            const dx = size[0] * 0.5 - vp[0];
            const dy = size[1] * 0.38 - vp[1];
            if (Number.isFinite(dx) && Number.isFinite(dy)) graph.translateBy([dx, dy]);
          }
        } catch (e) {
          console.warn('[graph] initial viewport adjust failed', e);
        }
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

  // 过滤条件变化: 重算布局后整页 setData 重绘(不重建实例)。
  useEffect(() => {
    const graph = graphRef.current;
    if (!graph) return;
    const applied = appliedFiltersRef.current;
    if (!applied || (applied.kinds === hiddenKinds && applied.plain === showPlainEdges)) return;
    appliedFiltersRef.current = { kinds: hiddenKinds, plain: showPlainEdges };
    const built = buildData(subgraph.nodes, subgraph.edges);
    renderChainRef.current = renderChainRef.current
      .then(() => {
        if (graphRef.current !== graph) return;
        graph.setData({ nodes: built.nodes, edges: built.edges, combos: built.combos });
        return graph.render();
      })
      .catch((e) => {
        if (graphRef.current === graph) console.error(e);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hiddenKinds, showPlainEdges]);

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
