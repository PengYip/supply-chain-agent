import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import clsx from 'clsx';
import { AlertTriangle, Network, RefreshCw } from 'lucide-react';
import { useGraph, type GraphDirection, type GraphDocument, type GraphEdge, type GraphNode, type InspectTarget } from '../../hooks/useGraph';
import { fetchGraphSchema, type GraphLabelCount } from '../../api/contractSearch';
import { ContractSearchBar } from '../common/ContractSearchBar';
import { ProjectSearchBar } from './ProjectSearchBar';
import { PanelRail } from '../shell/PanelRail';
import { DocumentListPanel } from './DocumentListPanel';
import { GraphCanvas } from './GraphCanvas';
import { DetailPanel } from './DetailPanel';
import { BUSINESS_TYPES, nodeDisplayName, prettyDocName } from './businessTypes';
import { DocMetaProvider, buildDocMetaResolver } from './docMeta';
import type { GraphFocus } from './focus';

interface CenterState {
  id: string;
  label: string;
  /** 中心是否来自左侧文档列表（用于展示「返回文档」入口） */
  fromDocument: boolean;
}

/** 分层探索固定查询参数(spec 2026-08-27 §6): 深度3/双向覆盖 项目→合同→单据 的完整链条。 */
const FIXED_DEPTH = 3;
const FIXED_DIRECTION: GraphDirection = 'both';

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
    tree,
    subgraph,
    graphLoading,
    graphError,
    loadSubgraph,
  } = useGraph();

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
  // 边降噪: 普通关系默认隐藏, 只保留层级履约边与绑定边(评审修订)。
  const [showPlainEdges, setShowPlainEdges] = useState(false);
  const [labelCounts, setLabelCounts] = useState<GraphLabelCount[]>([]);
  // 合同搜索跳转的临时提示(合同在台账但未入图等), 下次查询自动清除。
  const [searchNotice, setSearchNotice] = useState<string | null>(null);
  // Inspector 薄互通: docId -> 绑定计数(懒加载一次 overview)。
  const [docBindingCounts, setDocBindingCounts] = useState<Map<string, { confirmed: number; proposed: number }> | null>(null);
  const bindingCountsLoadedRef = useRef(false);
  // 绑定计数加载失败标记: 详情面板据此显示失败而非一直「加载中」。
  const [bindingCountsFailed, setBindingCountsFailed] = useState(false);

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
      .then((r) => {
        if (!r.ok) {
          // 失败: 重置 ref 允许后续重试, 并标记失败态(详情面板显示失败而非一直加载)。
          bindingCountsLoadedRef.current = false;
          setBindingCountsFailed(true);
          return null;
        }
        return r.json();
      })
      .then((data: { documents?: Array<{ docId: string; bindings: Array<{ status: string }> }> } | null) => {
        if (!data?.documents) return;
        setBindingCountsFailed(false);
        const map = new Map<string, { confirmed: number; proposed: number }>();
        for (const d of data.documents) {
          map.set(d.docId, {
            confirmed: d.bindings.filter((b) => b.status === 'confirmed').length,
            proposed: d.bindings.filter((b) => b.status === 'proposed').length,
          });
        }
        setDocBindingCounts(map);
      })
      .catch(() => { bindingCountsLoadedRef.current = false; setBindingCountsFailed(true); });
  }, []);

  // docId -> 文件名/业务类型 兜底解析：老图谱 Document 节点缺 sourceUri/docType 时，
  // 用文档列表补齐展示（画布节点卡/详情/边端点名共用，经 context 下发到节点卡）。
  const docMetaResolver = useMemo(() => buildDocMetaResolver(documents), [documents]);

  const query = useCallback(
    (id: string, label: string, fromDocument: boolean) => {
      setCenter({ id, label, fromDocument });
      setPinned(null);
      setHovered(null);
      setSearchNotice(null);
      void loadSubgraph(id, FIXED_DEPTH, FIXED_DIRECTION);
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
        query(elementId, item.displayContractNo, false);
      } catch {
        setSearchNotice('图谱定位失败，请稍后重试');
      }
    },
    [query],
  );

  // 项目搜索选中: /entities 直接回传 elementId, 无需 resolve, 直接为中心查询。
  const handleProjectSelect = useCallback(
    (item: { elementId: string; name: string }) => {
      setSearchNotice(null);
      query(item.elementId, item.name, false);
    },
    [query],
  );

  // 外部定位（绑定工作台跳入）：以合同节点为中心重新查询，替换原有中心。
  // nonce 保证重复跳转同一节点也会触发；页内切换深度/方向不会误触发。
  const handledFocusNonceRef = useRef(-1);
  useEffect(() => {
    if (!focus || focus.nonce === handledFocusNonceRef.current) return;
    handledFocusNonceRef.current = focus.nonce;
    setSelectedDoc(null);
    query(focus.elementId, focus.label, false);
  }, [focus, query]);

  // 左侧树面板选中(项目/合同/单据任意层级): 以该节点为中心展开。
  // 单据选中时回填 selectedDoc(供「返回文档」入口), 文件名从已入库文档兜底解析。
  const handleSelectListNode = useCallback(
    (item: { elementId: string; label: string; kind: string }) => {
      if (item.kind === 'Document') {
        const meta = documents.find((d) => d.elementId === item.elementId) ?? null;
        setSelectedDoc(
          meta ?? { elementId: item.elementId, docId: '', docType: '', sourceUri: '', createdAt: '' },
        );
        const label = meta ? (prettyDocName(meta.sourceUri) || meta.docId || item.label) : item.label;
        query(item.elementId, label, true);
      } else {
        setSelectedDoc(null);
        query(item.elementId, item.label, false);
      }
    },
    [documents, query],
  );

  const handleExpandNode = useCallback(
    (node: GraphNode) => {
      query(node.elementId, nodeDisplayName(node, docMetaResolver), false);
    },
    [query, docMetaResolver],
  );

  const handleRefresh = useCallback(() => {
    void refreshDocuments();
    if (center) query(center.id, center.label, center.fromDocument);
  }, [refreshDocuments, center, query]);

  const backToDocument = useCallback(() => {
    if (selectedDoc) {
      query(selectedDoc.elementId, prettyDocName(selectedDoc.sourceUri), true);
    }
  }, [selectedDoc, query]);

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

  // part_of 项目归属聚合: 节点 elementId -> 对端展示名列表(去重)。
  // 详情面板据此渲染「项目归属」区, 不再让归属关系只沉在画布边线里。
  const partOfLinks = useMemo(() => {
    const map = new Map<string, string[]>();
    if (!subgraph) return map;
    for (const e of subgraph.edges) {
      if (e.type !== 'part_of') continue;
      const srcName = nameLookup.get(e.srcId);
      const dstName = nameLookup.get(e.dstId);
      if (srcName && dstName) {
        const push = (id: string, name: string) => {
          const list = map.get(id) ?? [];
          if (!list.includes(name)) list.push(name);
          map.set(id, list);
        };
        push(e.dstId, srcName);
        push(e.srcId, dstName);
      }
    }
    return map;
  }, [subgraph, nameLookup]);

  const inspect = pinned ?? hovered;
  const busy = graphLoading || docsLoading;
  const hasGraph = !!subgraph && subgraph.nodes.length > 0;
  const graphEmpty = !!subgraph && subgraph.nodes.length === 0 && !graphLoading && !graphError;

  // 关系洞察(详情面板消费): 从子图边就地聚合对手方/履约/参与等业务视图,
  // 不依赖节点 props(图节点 props 只有薄字段, 业务信息大多在边与台账)。
  const nodeInsights = useMemo(() => {
    const map = new Map<string, {
      counterparties: Array<{ name: string; role: string }>;
      contractCount: number;
      docCount: number;
      participantNames: string[];
      participantRoles: string[];
    }>();
    if (!subgraph) return map;
    const FULFILL = new Set(['executes', 'references', 'binds', 'trades', 'settles', 'amends', 'granted']);
    const entry = (id: string) => {
      let e = map.get(id);
      if (!e) {
        e = { counterparties: [], contractCount: 0, docCount: 0, participantNames: [], participantRoles: [] };
        map.set(id, e);
      }
      return e;
    };
    for (const ed of subgraph.edges) {
      const srcName = nameLookup.get(ed.srcId);
      const dstName = nameLookup.get(ed.dstId);
      const srcKind = subgraph.nodes.find((n) => n.elementId === ed.srcId)?.kind;
      const dstKind = subgraph.nodes.find((n) => n.elementId === ed.dstId)?.kind;
      const role = typeof ed.props?.role === 'string' ? ed.props.role : '';
      if (ed.type === 'counterparty' && srcName && dstName) {
        const roleA = typeof ed.props?.role === 'string' ? ed.props.role : '';
        entry(ed.srcId).counterparties.push({ name: dstName, role: roleA });
        entry(ed.dstId).counterparties.push({ name: srcName, role: roleA });
        continue;
      }
      if (FULFILL.has(ed.type)) {
        if (srcKind === 'Contract' && dstKind === 'Document') { entry(ed.srcId).docCount += 1; entry(ed.dstId).contractCount += 1; }
        else if (srcKind === 'Document' && dstKind === 'Contract') { entry(ed.dstId).docCount += 1; entry(ed.srcId).contractCount += 1; }
        continue;
      }
      if (ed.type === 'participates' && srcName && dstName) {
        if (role) entry(ed.dstId).participantRoles.push(role);
        entry(ed.dstId).participantNames.push(srcName);
      }
    }
    return map;
  }, [subgraph, nameLookup]);

  return (
    <DocMetaProvider value={docMetaResolver}>
    <div className="flex h-full flex-col bg-surface">
      {/* 二级工具条（视图标题由 AppTopbar 承担） */}
      <div className="flex h-12 shrink-0 items-center gap-3 border-b border-line bg-white px-4">
        <ContractSearchBar className="w-[300px]" onSelect={(it) => void handleSearchSelect(it)} />
        <ProjectSearchBar className="w-[200px]" onSelect={handleProjectSelect} />
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
                  <span
                    className="h-2 w-2 rounded-[2px]"
                    style={{ background: bt.softBg, border: `1.5px solid ${bt.color}` }}
                    aria-hidden
                  />
                  {bt.displayName}
                  {typeof count === 'number' && <span className="tabular-nums">({count})</span>}
                </button>
              );
            })}
            <span className="text-[10px] text-ink-soft/60">自上而下：项目 · 合同 · 履约</span>
            <button
              type="button"
              onClick={() => setShowPlainEdges((v) => !v)}
              title="显示/隐藏非层级的普通关系连线"
              className={clsx(
                'rounded px-1.5 py-0.5 text-[11px] transition-colors',
                showPlainEdges ? 'bg-primary/10 text-primary' : 'text-ink-soft hover:bg-surface',
              )}
            >
              {showPlainEdges ? '普通关系 开' : '普通关系 关'}
            </button>
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
            tree={tree}
            documents={documents}
            loading={docsLoading}
            error={docsError}
            selectedId={center?.id ?? null}
            onSelectNode={handleSelectListNode}
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
              <div className="mt-4 text-[14px] font-medium text-ink">从左侧选择一个文档或搜索节点</div>
              <div className="mt-1 max-w-[320px] text-[12px] leading-5 text-ink-soft">
                在画布上浏览项目的合同与履约单据，双击任意节点向外展开
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
                onClick={() => center && query(center.id, center.label, center.fromDocument)}
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
                该节点暂无可展示的关联，可尝试以其他节点为中心重新展开
              </div>
            </div>
          )}

          {/* 加载中卸载画布（避免旧数据上的错误布局），数据到位后全新挂载 */}
          {hasGraph && !graphLoading && (
            <GraphCanvas
              key={`${center?.id ?? ''}`}
              subgraph={subgraph}
              centerElementId={center?.id ?? null}
              hiddenKinds={hiddenKinds}
              showPlainEdges={showPlainEdges}
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
            partOfLinks={partOfLinks}
            insights={nodeInsights}
            docBindingCounts={docBindingCounts}
            bindingCountsFailed={bindingCountsFailed}
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
