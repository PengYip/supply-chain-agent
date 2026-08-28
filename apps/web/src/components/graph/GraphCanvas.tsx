// G6 v5 画布 — 语义分层泳道布局 + HTML 信息卡节点(spec 2026-08-27 评审二轮)。
// 节点用 type:'html' 渲染 DOM 卡片: 类型 Chip / 名称加粗自动折行 / 概述单行省略,
// 排版交由 CSS, 从根本上解决文字溢出与徽标重叠; 坐标仍由 layeredLayout 给出。
// 导航优先: 初始视口聚焦中心节点所在泳道; GraphView 以 key={center} 重挂载。
import { useEffect, useMemo, useRef } from 'react';
import { Graph as G6Graph, type EdgeData, type IElementEvent, type NodeData } from '@antv/g6';
import type { GraphEdge, GraphNode, InspectTarget, Subgraph } from '../../hooks/useGraph';
import { EDGE_STYLE_OVERRIDES, businessTypeOf, contractTypeStyle, docTypeName, docTypeStyle, nodeDisplayName } from './businessTypes';
import { useDocMeta } from './docMeta';
import { cardSpec, classifyEdge, computeLayeredLayout, type NodeCardMeta } from './layeredLayout';

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

/** DOM 信息卡模板: 左色条 + 类型 Chip + 名称两行截断 + 概述单行省略。
 *  尺寸 token 与 layeredLayout.cardSpec 严格一致(pad8/chip16/gap2/名称行17/概述13)。 */
function cardHtml(opts: {
  label: string; color: string; border: string; bg: string;
  name: string; subtitle: string; width: number; height: number; scatter: boolean;
}): string {
  const { label, color, border, bg, name, subtitle, width, height, scatter } = opts;
  return `
<div style="width:${width}px;height:${height}px;box-sizing:border-box;background:${bg};
  border:1px solid ${border};border-left:4px solid ${color};border-radius:10px;
  box-shadow:0 2px 8px rgba(15,23,42,0.12);padding:8px 12px 7px 9px;
  font-family:'PingFang SC','Microsoft YaHei',system-ui,sans-serif;
  display:flex;flex-direction:column;gap:2px;pointer-events:none;user-select:none;overflow:hidden;">
  <div style="display:flex;align-items:center;gap:6px;height:16px;flex:none;">
    <span style="background:${color};color:#fff;font-size:10px;line-height:16px;
      padding:0 8px;border-radius:999px;font-weight:600;">${escapeHtml(label)}</span>
    ${scatter ? '<span style="font-size:10px;color:#94A3B8;border:1px dashed #CBD5E1;padding:1px 6px;border-radius:999px;">散件</span>' : ''}
  </div>
  <div style="flex:none;font-size:13px;font-weight:600;color:#0F172A;line-height:17px;
    display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;">${escapeHtml(name)}</div>
  ${subtitle ? `<div style="flex:none;font-size:11px;color:#64748B;line-height:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(subtitle)}</div>` : ''}
</div>`;
}

/** 节点主题解析: 文档按 docType 分色、合同按子类型分色(spec 三轮), 项目紫/其余用 kind 色。 */
function themeOf(nd: GraphNode, subtitle: string): { label: string; color: string; border: string; bg: string } {
  if (nd.kind === 'Document') {
    const dts = docTypeStyle(docTypeName(nd, null) || subtitle);
    return { label: dts.label === '文档' ? '文档' : dts.label, color: dts.color, border: dts.border, bg: dts.bg };
  }
  if (nd.kind === 'Contract') {
    const cts = contractTypeStyle(nd.name, nd.props);
    return { label: cts.label, color: cts.color, border: cts.border, bg: cts.bg };
  }
  if (nd.kind === 'Project') {
    return { label: '项目', color: '#6D5FC3', border: '#D8D0F0', bg: '#F5F3FC' };
  }
  const bt = businessTypeOf(nd.kind);
  return { label: bt.displayName, color: bt.color, border: bt.softBorder, bg: '#FFFFFF' };
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

    // 展示元数据先解析(文件名兜底链 + 概述), 供布局精确测几何与卡片渲染共用
    const metaMap: Record<string, NodeCardMeta> = {};
    for (const nd of visibleNodes) {
      metaMap[nd.elementId] = { displayName: nodeDisplayName(nd, docMeta), subtitle: subtitleOf(nd, docMeta) };
    }

    const layout = computeLayeredLayout(visibleNodes, visibleEdges, metaMap);

    const g6Nodes = visibleNodes.map((nd) => {
      const meta = metaMap[nd.elementId]!;
      const theme = themeOf(nd, meta.subtitle ?? '');
      const geo = cardSpec(nd.kind, meta.displayName ?? nd.name, meta.subtitle ?? '');
      const pos = layout.positions[nd.elementId] ?? { x: 0, y: 0 };
      const html = cardHtml({
        label: theme.label,
        color: theme.color,
        border: theme.border,
        bg: theme.bg,
        name: meta.displayName ?? nd.name,
        subtitle: meta.subtitle ?? '',
        width: geo.width,
        height: geo.height,
        scatter: layout.scatterIds.has(nd.elementId),
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

  // 面板折叠/展开(transition-[width])或窗口缩放会改变容器尺寸。G6 的
  // autoResize 只重设画布表面, 相机(zoom/translate)不动 —— 内容仍锚在旧视口
  // 原点, 表现为「画布变大但绘图区域没变大」(新增区域空白)。监听容器尺寸,
  // 尺寸稳定后保持当前缩放把内容整体居中(fitCenter), 让扩出的区域真正可用。
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let lastW = el.clientWidth;
    let lastH = el.clientHeight;
    const ro = new ResizeObserver(() => {
      if (el.clientWidth === lastW && el.clientHeight === lastH) return;
      lastW = el.clientWidth;
      lastH = el.clientHeight;
      if (timer) clearTimeout(timer);
      // 宽度有 200ms 过渡: 等尺寸稳定再居中一次, 避免过渡帧反复重排。
      timer = setTimeout(() => {
        timer = null;
        const graph = graphRef.current;
        if (!graph) return;
        graph.fitCenter().catch((e) => console.warn('[graph] resize recenter failed', e));
      }, 250);
    });
    ro.observe(el);
    return () => {
      if (timer) clearTimeout(timer);
      ro.disconnect();
    };
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
