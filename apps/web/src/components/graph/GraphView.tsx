import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import clsx from 'clsx';
import { AlertTriangle, Network, RefreshCw } from 'lucide-react';
import { useGraph, type GraphDirection, type GraphDocument, type GraphEdge, type GraphNode, type InspectTarget } from '../../hooks/useGraph';
import { fetchGraphSchema, type GraphLabelCount } from '../../api/contractSearch';
import { ContractSearchBar } from '../common/ContractSearchBar';
import { PanelRail } from '../shell/PanelRail';
import { DocumentListPanel } from './DocumentListPanel';
import { GraphCanvas } from './GraphCanvas';
import { DetailPanel } from './DetailPanel';
import { BUSINESS_TYPES, nodeDisplayName, prettyDocName } from './businessTypes';
import { DocMetaProvider, buildDocMetaResolver } from './docMeta';
import type { GraphFocus } from './focus';

const DEPTH_OPTIONS = [1, 2, 3, 4, 5];

const DIRECTION_OPTIONS: Array<{ value: GraphDirection; label: string }> = [
  { value: 'both', label: '双向' },
  { value: 'out', label: '出边' },
  { value: 'in', label: '入边' },
];

interface CenterState {
  id: string;
  label: string;
  /** 中心是否来自左侧文档列表（用于展示「返回文档」入口） */
  fromDocument: boolean;
}

export function GraphView({
  focus = null,
  onOpenInBindings,
}: {
  focus?: GraphFocus | null;
  onOpenInBindings?: (docId: string) => void;
}) {
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

  // 节点类型过滤(spec 2026-08-26 §4.4): 空集合 = 全部可见; 图例计数来自 /api/graph/schema。
  const [hiddenKinds, setHiddenKinds] = useState<ReadonlySet<string>>(new Set());
  const [labelCounts, setLabelCounts] = useState<GraphLabelCount[]>([]);
  // 合同搜索跳转的临时提示(合同在台账但未入图等), 下次查询自动清除。
  const [searchNotice, setSearchNotice] = useState<string | null>(null);
  // Inspector 薄互通: docId -> 绑定计数(懒加载一次 overview)。
  const [docBindingCounts, setDocBindingCounts] = useState<Map<string, { confirmed: number; proposed: number }> | null>(null);
  const bindingCountsLoadedRef = useRef(false);

  const toggleKind = useCallback((kind: string) => {
    setHiddenKinds((prev) => {
      const next = new Set(prev);
      if (next.has(kind)) next.delete(kind);
      else next.add(kind);
      return next;
    });
  }, []);

  useEffect(() => {
    void fetchGraphSchema().then(setLabelCounts);
  }, []);

  const loadBindingCounts = useCallback(() => {
    if (bindingCountsLoadedRef.current) return;
    bindingCountsLoadedRef.current = true;
    void fetch('/api/bindings/overview', { credentials: 'include' })
      .then((r) => (r.ok ? r.json() : null))
      .then((data: { documents?: Array<{ docId: string; bindings: Array<{ status: string }> }> } | null) => {
        if (!data?.documents) return;
        const map = new Map<string, { confirmed: number; proposed: number }>();
        for (const d of data.documents) {
          map.set(d.docId, {
            confirmed: d.bindings.filter((b) => b.status === 'confirmed').length,
            proposed: d.bindings.filter((b) => b.status === 'proposed').length,
          });
        }
        setDocBindingCounts(map);
      })
      .catch(() => { bindingCountsLoadedRef.current = false; });
  }, []);

  // docId -> 文件名/业务类型 兜底解析：老图谱 Document 节点缺 sourceUri/docType 时，
  // 用文档列表补齐展示（画布节点卡/详情/边端点名共用，经 context 下发到节点卡）。
  const docMetaResolver = useMemo(() => buildDocMetaResolver(documents), [documents]);

  const query = useCallback(
    (id: string, label: string, fromDocument: boolean, d: number, dir: GraphDirection) => {
      setCenter({ id, label, fromDocument });
      setPinned(null);
      setHovered(null);
      setSearchNotice(null);
      void loadSubgraph(id, d, dir);
    },
    [loadSubgraph],
  );

  // 合同搜索选中: resolve 定位合同节点 -> 以它为中心查询; 未入图给出提示。
  // 依赖 query, 故声明在 query 之后。
  const handleSearchSelect = useCallback(
    async (item: { contractNo: string; displayContractNo: string }) => {
      setSearchNotice(null);
      try {
        const res = await fetch(`/api/graph/resolve?contractNo=${encodeURIComponent(item.contractNo)}`, { credentials: 'include' });
        if (!res.ok) throw new Error('resolve failed');
        const data = (await res.json()) as { contract?: { elementId?: string } | null };
        const elementId = data.contract?.elementId;
        if (!elementId) {
          setSearchNotice(`合同 ${item.displayContractNo} 尚未同步到图谱（无合同节点）`);
          return;
        }
        query(elementId, item.displayContractNo, false, depth, direction);
      } catch {
        setSearchNotice('图谱定位失败，请稍后重试');
      }
    },
    [query, depth, direction],
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
      query(node.elementId, nodeDisplayName(node, docMetaResolver), false, depth, direction);
    },
    [query, depth, direction, docMetaResolver],
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
      // 统一走展示名解析：Document 节点解析出原始文件名（缺 props 时按 docId 查文档列表兜底）
      for (const node of subgraph.nodes) map.set(node.elementId, nodeDisplayName(node, docMetaResolver));
    }
    return map;
  }, [subgraph, docMetaResolver]);

  const resolveName = useCallback((elementId: string) => nameLookup.get(elementId) ?? '', [nameLookup]);

  const inspect = pinned ?? hovered;
  const busy = graphLoading || docsLoading;
  const hasGraph = !!subgraph && subgraph.nodes.length > 0;
  const graphEmpty = !!subgraph && subgraph.nodes.length === 0 && !graphLoading && !graphError;

  return (
    <DocMetaProvider value={docMetaResolver}>
    <div className="flex h-full flex-col bg-surface">
      {/* 二级工具条（视图标题由 AppTopbar 承担） */}
      <div className="flex h-12 shrink-0 items-center gap-3 border-b border-line bg-white px-4">
        <ContractSearchBar className="w-[300px]" onSelect={(it) => void handleSearchSelect(it)} />
        {searchNotice && (
          <span className="max-w-[260px] truncate rounded-md bg-warning/15 px-2 py-1 text-[11px] text-warning" title={searchNotice}>
            {searchNotice}
          </span>
        )}
        {center && (
          <div className="flex min-w-0 items-center gap-2 rounded-md bg-surface px-2.5 py-1">
            <span className="shrink-0 text-[11px] text-ink-soft">当前中心</span>
            <span className="max-w-[220px] truncate text-[12px] font-medium text-ink" title={center.label}>
              {center.label}
            </span>
            {!center.fromDocument && selectedDoc && (
              <button
                type="button"
                onClick={backToDocument}
                className="shrink-0 text-[12px] text-primary underline underline-offset-2 hover:text-primary-800"
              >
                返回文档
              </button>
            )}
          </div>
        )}

        <div className="ml-auto flex items-center gap-3">
          <label className="flex items-center gap-1.5 text-[12px] text-ink-soft">
            深度
            <select
              value={depth}
              onChange={(e) => handleDepthChange(Number(e.target.value))}
              className="h-7 rounded-md border border-line bg-white px-1.5 text-[12px] text-ink focus:border-primary focus:outline-none"
            >
              {DEPTH_OPTIONS.map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </select>
          </label>

          <div className="flex overflow-hidden rounded-md border border-line">
            {DIRECTION_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                type="button"
                onClick={() => handleDirectionChange(opt.value)}
                className={clsx(
                  'h-7 px-2.5 text-[12px] transition-colors',
                  direction === opt.value
                    ? 'bg-primary text-white'
                    : 'bg-white text-ink-soft hover:bg-surface',
                )}
              >
                {opt.label}
              </button>
            ))}
          </div>

          <button
            type="button"
            onClick={handleRefresh}
            className="flex h-7 items-center gap-1 rounded-md border border-line bg-white px-2.5 text-[12px] text-ink hover:bg-surface"
          >
            <RefreshCw className={clsx('h-3.5 w-3.5', busy && 'animate-spin')} aria-hidden />
            刷新
          </button>

          <div className="hidden items-center gap-2.5 border-l border-line pl-3 xl:flex">
            {Object.values(BUSINESS_TYPES).map((bt) => {
              const hidden = hiddenKinds.has(bt.label);
              const count = labelCounts.find((x) => x.label === bt.label)?.count;
              return (
                <button
                  key={bt.label}
                  type="button"
                  onClick={() => toggleKind(bt.label)}
                  title={hidden ? `显示${bt.displayName}` : `隐藏${bt.displayName}`}
                  className={clsx(
                    'flex items-center gap-1 rounded px-1 text-[11px] transition-opacity',
                    hidden ? 'text-ink-soft/50 opacity-50 line-through' : 'text-ink-soft hover:bg-surface',
                  )}
                >
                  {bt.label === 'Document' ? (
                    <span className="h-2 w-2 rounded-full border-2 bg-white" style={{ borderColor: bt.color }} aria-hidden />
                  ) : (
                    <span className="h-2 w-2 rounded-full" style={{ background: bt.color }} aria-hidden />
                  )}
                  {bt.displayName}
                  {typeof count === 'number' && <span className="tabular-nums">({count})</span>}
                </button>
              );
            })}
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
              <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-primary/10">
                <Network className="h-7 w-7 text-primary" aria-hidden />
              </span>
              <div className="mt-4 text-[14px] font-medium text-ink">从左侧选择一个文档</div>
              <div className="mt-1 max-w-[320px] text-[12px] leading-5 text-ink-soft">
                以它为中心浏览关联的交易方、商品、合同与其他文档，点击任意节点可继续向外展开
              </div>
            </div>
          )}

          {center && graphError && (
            <div className="flex h-full flex-col items-center justify-center px-6 text-center">
              <AlertTriangle className="h-10 w-10 text-danger" aria-hidden />
              <div className="mt-3 text-[14px] font-medium text-ink">图谱加载失败</div>
              <div className="mt-1 max-w-[360px] break-all text-[12px] leading-5 text-danger">{graphError}</div>
              <button
                type="button"
                onClick={() => center && query(center.id, center.label, center.fromDocument, depth, direction)}
                className="mt-4 flex items-center gap-1 rounded-md border border-line bg-white px-3 py-1.5 text-[12px] text-ink hover:bg-surface"
              >
                <RefreshCw className="h-3.5 w-3.5" aria-hidden />
                重试
              </button>
            </div>
          )}

          {center && graphEmpty && (
            <div className="flex h-full flex-col items-center justify-center px-6 text-center">
              <Network className="h-10 w-10 text-line" aria-hidden />
              <div className="mt-3 text-[14px] font-medium text-ink">未找到关联节点</div>
              <div className="mt-1 text-[12px] leading-5 text-ink-soft">
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
              hiddenKinds={hiddenKinds}
              onHover={setHovered}
              onNodeSelect={(node: GraphNode) => {
                setPinned({ type: 'node', node });
                if (node.kind === 'Document') loadBindingCounts();
              }}
              onEdgeSelect={(edge: GraphEdge) => setPinned({ type: 'edge', edge })}
              onPaneSelect={() => setPinned(null)}
              onNodeDoubleClick={handleExpandNode}
            />
          )}

          {graphLoading && (
            <div className="absolute inset-0 z-10 flex items-center justify-center bg-white/70">
              <div className="flex flex-col items-center gap-3">
                <span className="h-8 w-8 animate-spin rounded-full border-2 border-line border-t-primary" />
                <span className="text-[12px] text-ink-soft">子图查询中</span>
              </div>
            </div>
          )}

          {hasGraph && !graphLoading && (
            <div className="pointer-events-none absolute left-3 top-3 z-10 rounded-md border border-line bg-white/90 px-2.5 py-1 text-[11px] text-ink-soft shadow-card">
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
            docBindingCounts={docBindingCounts}
            onLoadBindingCounts={loadBindingCounts}
            onOpenInBindings={onOpenInBindings}
          />
        </div>
      </div>
    </div>
    </DocMetaProvider>
  );
}

export default GraphView;
