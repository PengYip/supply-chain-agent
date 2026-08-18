import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import clsx from 'clsx';
import { AlertTriangle, ChevronLeft, ChevronRight, Network, RefreshCw, type LucideIcon } from 'lucide-react';
import { useGraph, type GraphDirection, type GraphDocument, type GraphEdge, type GraphNode, type InspectTarget } from '../../hooks/useGraph';
import { DocumentListPanel } from './DocumentListPanel';
import { GraphCanvas } from './GraphCanvas';
import { DetailPanel } from './DetailPanel';
import { KIND_STYLES, nodeDisplayName, prettyDocName } from './kinds';
import type { GraphFocus } from './focus';

const DEPTH_OPTIONS = [1, 2, 3, 4, 5];

const DIRECTION_OPTIONS: Array<{ value: GraphDirection; label: string }> = [
  { value: 'both', label: '双向' },
  { value: 'out', label: '出边' },
  { value: 'in', label: '入边' },
];

const LEGEND_KINDS = ['Document', 'Party', 'Commodity', 'Contract'] as const;

interface CenterState {
  id: string;
  label: string;
  /** 中心是否来自左侧文档列表（用于展示「返回文档」入口） */
  fromDocument: boolean;
}

/** 面板折叠把手：贴在面板画布侧边缘的窄竖条。折叠后仅剩本条，画布占满剩余空间。 */
function PanelRail({
  collapsed,
  side,
  label,
  onToggle,
}: {
  collapsed: boolean;
  side: 'left' | 'right';
  label: string;
  onToggle: () => void;
}) {
  // 箭头指向状态变化方向：展开态指向收起方向，折叠态指向展开方向
  const Chevron: LucideIcon = collapsed
    ? side === 'left'
      ? ChevronRight
      : ChevronLeft
    : side === 'left'
      ? ChevronLeft
      : ChevronRight;
  const action = collapsed ? `展开${label}面板` : `收起${label}面板`;
  return (
    <div
      className={clsx(
        'flex w-7 shrink-0 flex-col items-center bg-white',
        side === 'left' ? 'border-r border-borderGray' : 'border-l border-borderGray',
      )}
    >
      <button
        type="button"
        onClick={onToggle}
        title={action}
        aria-label={action}
        className="mt-1 flex h-7 w-7 items-center justify-center rounded-md text-textGray transition-colors hover:bg-bgGray hover:text-deepSea"
      >
        <Chevron className="h-4 w-4" aria-hidden />
      </button>
      {collapsed && (
        <div className="flex flex-1 items-center justify-center pt-2 text-[11px] tracking-[0.3em] text-textGray [writing-mode:vertical-rl]">
          {label}
        </div>
      )}
    </div>
  );
}

export function GraphView({ focus = null }: { focus?: GraphFocus | null }) {
  const {
    documents,
    docsLoading,
    docsError,
    refreshDocuments,
    subgraph,
    graphLoading,
    graphError,
    loadSubgraph,
  } = useGraph();

  const [depth, setDepth] = useState(2);
  const [direction, setDirection] = useState<GraphDirection>('both');
  const [selectedDoc, setSelectedDoc] = useState<GraphDocument | null>(null);
  const [center, setCenter] = useState<CenterState | null>(null);
  // 悬停即时查看，点击固定详情；固定优先展示
  const [hovered, setHovered] = useState<InspectTarget | null>(null);
  const [pinned, setPinned] = useState<InspectTarget | null>(null);
  // 面板折叠（默认展开，不持久化）：折叠后只留窄把手，画布占满
  const [docsCollapsed, setDocsCollapsed] = useState(false);
  const [detailCollapsed, setDetailCollapsed] = useState(false);

  const query = useCallback(
    (id: string, label: string, fromDocument: boolean, d: number, dir: GraphDirection) => {
      setCenter({ id, label, fromDocument });
      setPinned(null);
      setHovered(null);
      void loadSubgraph(id, d, dir);
    },
    [loadSubgraph],
  );

  // 外部定位（绑定工作台跳入）：以合同节点为中心重新查询，替换原有中心。
  // nonce 保证重复跳转同一节点也会触发；页内切换深度/方向不会误触发。
  const handledFocusNonceRef = useRef(-1);
  useEffect(() => {
    if (!focus || focus.nonce === handledFocusNonceRef.current) return;
    handledFocusNonceRef.current = focus.nonce;
    setSelectedDoc(null);
    query(focus.elementId, focus.label, false, depth, direction);
  }, [focus, query, depth, direction]);

  const handleSelectDoc = useCallback(
    (doc: GraphDocument) => {
      setSelectedDoc(doc);
      query(doc.elementId, prettyDocName(doc.sourceUri), true, depth, direction);
    },
    [query, depth, direction],
  );

  const handleExpandNode = useCallback(
    (node: GraphNode) => {
      query(node.elementId, nodeDisplayName(node), false, depth, direction);
    },
    [query, depth, direction],
  );

  const handleDepthChange = useCallback(
    (d: number) => {
      setDepth(d);
      if (center) query(center.id, center.label, center.fromDocument, d, direction);
    },
    [center, direction, query],
  );

  const handleDirectionChange = useCallback(
    (dir: GraphDirection) => {
      setDirection(dir);
      if (center) query(center.id, center.label, center.fromDocument, depth, dir);
    },
    [center, depth, query],
  );

  const handleRefresh = useCallback(() => {
    void refreshDocuments();
    if (center) query(center.id, center.label, center.fromDocument, depth, direction);
  }, [refreshDocuments, center, depth, direction, query]);

  const backToDocument = useCallback(() => {
    if (selectedDoc) {
      query(selectedDoc.elementId, prettyDocName(selectedDoc.sourceUri), true, depth, direction);
    }
  }, [selectedDoc, depth, direction, query]);

  const isCenter = useCallback((elementId: string) => center?.id === elementId, [center]);

  const nameLookup = useMemo(() => {
    const map = new Map<string, string>();
    if (subgraph) {
      // 统一走展示名解析：Document 节点解析出原始文件名，避免显示 docId
      for (const node of subgraph.nodes) map.set(node.elementId, nodeDisplayName(node));
    }
    return map;
  }, [subgraph]);

  const resolveName = useCallback((elementId: string) => nameLookup.get(elementId) ?? '', [nameLookup]);

  const inspect = pinned ?? hovered;
  const busy = graphLoading || docsLoading;
  const hasGraph = !!subgraph && subgraph.nodes.length > 0;
  const graphEmpty = !!subgraph && subgraph.nodes.length === 0 && !graphLoading && !graphError;

  return (
    <div className="flex h-full flex-col bg-bgGray">
      {/* 顶部工具条 */}
      <div className="flex h-14 shrink-0 items-center gap-3 border-b border-borderGray bg-white px-4">
        <div className="flex items-center gap-2">
          <span className="flex h-7 w-7 items-center justify-center rounded-md bg-deepSea">
            <Network className="h-4 w-4 text-white" aria-hidden />
          </span>
          <span className="text-[15px] font-semibold text-textDark">文档图谱</span>
        </div>

        {center && (
          <div className="flex min-w-0 items-center gap-2 rounded-md bg-bgGray px-2.5 py-1">
            <span className="shrink-0 text-[11px] text-textGray">当前中心</span>
            <span className="max-w-[220px] truncate text-[12px] font-medium text-textDark" title={center.label}>
              {center.label}
            </span>
            {!center.fromDocument && selectedDoc && (
              <button
                type="button"
                onClick={backToDocument}
                className="shrink-0 text-[12px] text-deepSea underline underline-offset-2 hover:text-[#164a76]"
              >
                返回文档
              </button>
            )}
          </div>
        )}

        <div className="ml-auto flex items-center gap-3">
          <label className="flex items-center gap-1.5 text-[12px] text-textGray">
            深度
            <select
              value={depth}
              onChange={(e) => handleDepthChange(Number(e.target.value))}
              className="h-7 rounded-md border border-borderGray bg-white px-1.5 text-[12px] text-textDark focus:border-deepSea focus:outline-none"
            >
              {DEPTH_OPTIONS.map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </select>
          </label>

          <div className="flex overflow-hidden rounded-md border border-borderGray">
            {DIRECTION_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                type="button"
                onClick={() => handleDirectionChange(opt.value)}
                className={clsx(
                  'h-7 px-2.5 text-[12px] transition-colors',
                  direction === opt.value
                    ? 'bg-deepSea text-white'
                    : 'bg-white text-textGray hover:bg-bgGray',
                )}
              >
                {opt.label}
              </button>
            ))}
          </div>

          <button
            type="button"
            onClick={handleRefresh}
            className="flex h-7 items-center gap-1 rounded-md border border-borderGray bg-white px-2.5 text-[12px] text-textDark hover:bg-bgGray"
          >
            <RefreshCw className={clsx('h-3.5 w-3.5', busy && 'animate-spin')} aria-hidden />
            刷新
          </button>

          <div className="hidden items-center gap-2.5 border-l border-borderGray pl-3 xl:flex">
            {LEGEND_KINDS.map((kind) => (
              <span key={kind} className="flex items-center gap-1 text-[11px] text-textGray">
                <span className="h-2 w-2 rounded-full" style={{ background: KIND_STYLES[kind].color }} />
                {KIND_STYLES[kind].label}
              </span>
            ))}
          </div>
        </div>
      </div>

      {/* 三栏主体：左右面板可折叠，宽度过渡期间内容溢出裁剪 */}
      <div className="flex min-h-0 flex-1">
        <div
          className={clsx(
            'flex min-h-0 shrink-0 overflow-hidden transition-[width] duration-200',
            docsCollapsed ? 'w-0' : 'w-64',
          )}
        >
          <DocumentListPanel
            documents={documents}
            loading={docsLoading}
            error={docsError}
            selectedId={selectedDoc?.elementId ?? null}
            onSelect={handleSelectDoc}
            onRetry={() => void refreshDocuments()}
          />
        </div>
        <PanelRail
          collapsed={docsCollapsed}
          side="left"
          label="文档"
          onToggle={() => setDocsCollapsed((v) => !v)}
        />

        <main className="relative min-w-0 flex-1">
          {!center && !graphLoading && !graphError && (
            <div className="flex h-full flex-col items-center justify-center px-6 text-center">
              <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-[#E8EEF4]">
                <Network className="h-7 w-7 text-deepSea" aria-hidden />
              </span>
              <div className="mt-4 text-[14px] font-medium text-textDark">从左侧选择一个文档</div>
              <div className="mt-1 max-w-[320px] text-[12px] leading-5 text-textGray">
                以它为中心浏览关联的交易方、商品、合同与其他文档，点击任意节点可继续向外展开
              </div>
            </div>
          )}

          {center && graphError && (
            <div className="flex h-full flex-col items-center justify-center px-6 text-center">
              <AlertTriangle className="h-10 w-10 text-danger" aria-hidden />
              <div className="mt-3 text-[14px] font-medium text-textDark">图谱加载失败</div>
              <div className="mt-1 max-w-[360px] break-all text-[12px] leading-5 text-danger">{graphError}</div>
              <button
                type="button"
                onClick={() => center && query(center.id, center.label, center.fromDocument, depth, direction)}
                className="mt-4 flex items-center gap-1 rounded-md border border-borderGray bg-white px-3 py-1.5 text-[12px] text-textDark hover:bg-bgGray"
              >
                <RefreshCw className="h-3.5 w-3.5" aria-hidden />
                重试
              </button>
            </div>
          )}

          {center && graphEmpty && (
            <div className="flex h-full flex-col items-center justify-center px-6 text-center">
              <Network className="h-10 w-10 text-borderGray" aria-hidden />
              <div className="mt-3 text-[14px] font-medium text-textDark">未找到关联节点</div>
              <div className="mt-1 text-[12px] leading-5 text-textGray">
                该节点在当前深度和方向下没有可展示的关联，可尝试增大深度或切换方向
              </div>
            </div>
          )}

          {/* 加载中卸载画布（避免旧数据上的错误布局），数据到位后全新挂载 */}
          {hasGraph && !graphLoading && (
            <GraphCanvas
              key={`${center?.id ?? ''}-${depth}-${direction}`}
              subgraph={subgraph}
              centerElementId={center?.id ?? null}
              onHover={setHovered}
              onNodeSelect={(node: GraphNode) => setPinned({ type: 'node', node })}
              onEdgeSelect={(edge: GraphEdge) => setPinned({ type: 'edge', edge })}
              onPaneSelect={() => setPinned(null)}
            />
          )}

          {graphLoading && (
            <div className="absolute inset-0 z-10 flex items-center justify-center bg-white/70">
              <div className="flex flex-col items-center gap-3">
                <span className="h-8 w-8 animate-spin rounded-full border-2 border-borderGray border-t-deepSea" />
                <span className="text-[12px] text-textGray">子图查询中</span>
              </div>
            </div>
          )}

          {hasGraph && !graphLoading && (
            <div className="pointer-events-none absolute left-3 top-3 z-10 rounded-md border border-borderGray bg-white/90 px-2.5 py-1 text-[11px] text-textGray shadow-card">
              节点 {subgraph.nodes.length} · 关系 {subgraph.edges.length}
            </div>
          )}
        </main>

        <PanelRail
          collapsed={detailCollapsed}
          side="right"
          label="详情"
          onToggle={() => setDetailCollapsed((v) => !v)}
        />
        <div
          className={clsx(
            'flex min-h-0 shrink-0 overflow-hidden transition-[width] duration-200',
            detailCollapsed ? 'w-0' : 'w-72',
          )}
        >
          <DetailPanel
            inspect={inspect}
            isCenter={isCenter}
            resolveName={resolveName}
            onExpand={handleExpandNode}
          />
        </div>
      </div>
    </div>
  );
}

export default GraphView;
