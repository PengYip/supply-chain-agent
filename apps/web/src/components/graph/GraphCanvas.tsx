// G6 v5 画布 — 语义分层泳道布局(spec 2026-08-27 评审修订版)。
// 导航优先: 初始视口聚焦中心节点所在泳道(自然缩放, 不做全局 fit),
// 白底信息卡三层结构(类型徽标/名称加粗/概述次行), 泳道=浅灰 Combo。
// GraphView 以 key={center} 重挂载本组件, 内部不做增量 diff,
// 只在 hiddenKinds/showPlainEdges 变化时 setData 重绘。
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
  [key: string]: unknown;
}

/** 按像素宽度手工断行(CJK≈15px / 其他≈8px @12px 字号), 保证文字不溢出卡片。 */
function wrapLabel(text: string, maxWidthPx: number, maxLines: number): string {
  if (!text) return '';
  const limit = Math.max(maxWidthPx, 40);
  const lines: string[] = [];
  let current = '';
  let currentW = 0;
  for (const ch of text) {
    const cw = ch.charCodeAt(0) > 0x2e7f ? 15 : 8;
    if (currentW + cw > limit && current) {
      lines.push(current);
      current = ch;
      currentW = cw;
      if (lines.length === maxLines) break;
    } else {
      current += ch;
      currentW += cw;
    }
  }
  // 截断路径: 还有剩余字符则末行以省略号收尾
  const consumed = lines.join('').length + current.length;
  const truncated = consumed < text.length;
  if (current && lines.length < maxLines) {
    lines.push(current);
    return lines.join('\n') + (truncated ? '' : '');
  }
  if (lines.length === maxLines && (truncated || current)) {
    let last = lines[maxLines - 1] ?? '';
    if (last.length > 1) last = last.slice(0, -1);
    lines[maxLines - 1] = `${last}…`;
  }
  return lines.join('\n');
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
    const visibleEdges = edges.filter(
      (e) =>
        visibleIds.has(e.srcId) &&
        visibleIds.has(e.dstId) &&
        // 边降噪: 层级履约边与绑定边恒显, 其余普通关系由开关控制
        (showPlainEdges ||
          classifyEdge(e.type, nodes.find((n) => n.elementId === e.srcId)?.kind ?? '', nodes.find((n) => n.elementId === e.dstId)?.kind ?? '') === 'hierarchy' ||
          e.type === 'binds'),
    );

    const layout = computeLayeredLayout(visibleNodes, visibleEdges);
    const kindById = new Map(visibleNodes.map((n) => [n.elementId, n.kind]));

    const g6Nodes = visibleNodes.map((nd) => {
      const bt = businessTypeOf(nd.kind);
      const geo = cardGeometry(nd.kind, nd.name);
      const pos = layout.positions[nd.elementId] ?? { x: 0, y: 0 };
      const isScatter = layout.scatterIds.has(nd.elementId);
      const displayName = nodeDisplayName(nd, docMeta);
      // 三层信息卡: 名称加粗(最多两行, 手工断行防溢出) + 概述次行(badge 承载)
      const nameLabel = wrapLabel(displayName, geo.width - 20, 2);
      let subtitle = '';
      if (nd.kind === 'Document') subtitle = docTypeName(nd, docMeta);
      else if (nd.kind === 'Contract') {
        for (const k of ['contractNo', 'status', 'amount']) {
          const v = nd.props?.[k];
          if (typeof v === 'string' && v) { subtitle = v; break; }
        }
      } else if (nd.kind === 'Party') {
        for (const k of ['role', 'country']) {
          const v = nd.props?.[k];
          if (typeof v === 'string' && v) { subtitle = v; break; }
        }
      } else if (nd.kind === 'Project') {
        for (const k of ['code', 'status']) {
          const v = nd.props?.[k];
          if (typeof v === 'string' && v) { subtitle = v; break; }
        }
      }
      const subtitleBadge = subtitle ? [{
        text: wrapLabel(subtitle, geo.width - 26, 1),
        placement: 'bottom' as const,
        backgroundFill: '#F1F5F9',
        fill: '#475569',
        fontSize: 9,
        padding: [1, 4],
      }] : [];
      return {
        id: nd.elementId,
        type: 'rect',
        combo: layout.comboOf[nd.elementId],
        data: { kind: nd.kind, name: nd.name, props: nd.props, rawNode: nd } as CanvasDatum,
        style: {
          x: pos.x,
          y: pos.y,
          width: geo.width,
          height: geo.height,
          radius: nd.kind === 'Project' ? 10 : 8,
          fill: '#FFFFFF',
          stroke: bt.color,
          lineWidth: nd.kind === 'Project' ? 2 : 1,
          lineDash: isScatter ? [4, 3] : undefined,
          shadowColor: 'rgba(15,23,42,0.10)',
          shadowBlur: 8,
          shadowOffsetY: 2,
          labelText: nameLabel,
          labelPlacement: 'center' as const,
          labelFill: '#1E293B',
          labelFontSize: 12,
          labelFontWeight: nd.kind === 'Project' ? ('bold' as const) : 500,
          labelLineHeight: 16,
          // 顶部类型徽标(chip)
          badges: [
            {
              text: bt.displayName,
              placement: 'top' as const,
              backgroundFill: bt.color,
              fill: '#FFFFFF',
              fontSize: 9,
              padding: [1, 6],
            },
            ...subtitleBadge,
          ],
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
          stroke: override?.color ?? (cls === 'hierarchy' ? '#94A3B8' : '#CBD5E1'),
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
      combo: {
        style: {
          fill: '#F8FAFC',
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
            layout.lanes.find((l) => {
              const owner = Object.entries(layout.comboOf).find(([id]) => id === centerElementId);
              return owner ? l.id === layout.comboOf[owner[0]] : false;
            }) ?? layout.lanes[0];
          const zoom = focusLane
            ? Math.min(1, Math.max(0.55, Math.min((size[0] * 0.62) / focusLane.width, (size[1] * 0.82) / focusLane.height)))
            : 1;
          await graph.zoomTo(zoom);
          const anchorId = centerElementId && layout.positions[centerElementId]
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
