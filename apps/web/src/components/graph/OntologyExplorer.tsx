// apps/web/src/components/graph/OntologyExplorer.tsx
// 本体穿透模式(roadmap Item 4)：起点选择器 + 邻接画布 + 双击 lazy 展开 + 边参数悬停。
// 复用 GraphCanvas(g6)与 useGraph 的 GraphNode/GraphEdge 形状；DTO -> 画布数据映射时
// elementId 用 `<type>:<id>` 复合键(两套身份体系不冲突)，业务键放 props 供展开回读。
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  fetchOntologyNeighbors, listEntities, fetchOntologySchema,
  type NeighborsResultDTO, type NeighborNodeDTO, type NeighborEdgeDTO,
  type OntologyEntitySchemaDTO, type ProjectedEntity,
} from '../../api/ontology';
import type { GraphEdge, GraphNode, InspectTarget, Subgraph } from '../../hooks/useGraph';
import { GraphCanvas } from './GraphCanvas';
import { ONTOLOGY_EDGE_LEGEND, edgeLabel } from './businessTypes';

export interface OntologyAnchorJump {
  type: string;
  id: string;
  label: string;
  nonce: number;
}

interface Props {
  initialAnchor?: OntologyAnchorJump | null;
}

const nodeKey = (type: string, id: string) => `${type}:${id}`;

/** 穿透模式不过滤类型：模块级空集，避免每次渲染 new Set() 触发 GraphCanvas 全量重排。 */
const NO_HIDDEN_KINDS: ReadonlySet<string> = new Set();

function toGraphNode(n: NeighborNodeDTO): GraphNode {
  return {
    elementId: nodeKey(n.entityType, n.id),
    kind: n.entityType,
    name: n.label,
    props: { ...(n.props ?? {}), __type: n.entityType, __id: n.id },
  };
}

function toGraphEdge(e: NeighborEdgeDTO): GraphEdge {
  return {
    elementId: e.id,
    type: e.relation,
    srcId: nodeKey(e.fromType, e.fromId),
    dstId: nodeKey(e.toType, e.toId),
    props: e.params,
    confidence: null,
  };
}

const EDGE_PARAM_LABELS: Record<string, string> = {
  amount: '金额', ratio: '比例', method: '方式', batch: '批次',
  partial: '部分核销', reason: '原因', unitIndex: '序号', pages: '页码',
};

/** 边参数摘要(spec: 金额/比例/方式)：hover 浮层与选中详情共用。 */
export function formatEdgeParams(params: Record<string, unknown> | null | undefined): string {
  if (!params) return '';
  const parts: string[] = [];
  for (const [k, v] of Object.entries(params)) {
    if (v == null || v === '') continue;
    let text = String(v);
    if (k === 'ratio' && typeof v === 'number') text = `${Math.round(v * 100)}%`;
    if (k === 'amount' && typeof v === 'number') text = v.toLocaleString();
    if (k === 'partial') text = v ? '是' : '否';
    parts.push(`${EDGE_PARAM_LABELS[k] ?? k} ${text}`);
  }
  return parts.join(' / ');
}

/** 起点选择器 + 穿透画布。展开=对已见节点再取 depth=1 邻接并合并去重(逐步展开)。 */
export function OntologyExplorer({ initialAnchor }: Props) {
  const [entities, setEntities] = useState<OntologyEntitySchemaDTO[] | null>(null);
  const [selectedType, setSelectedType] = useState<string>('');
  const [q, setQ] = useState('');
  const [candidates, setCandidates] = useState<ProjectedEntity[]>([]);
  const [searching, setSearching] = useState(false);

  const [anchor, setAnchor] = useState<{ type: string; id: string; label: string } | null>(null);
  const [depth, setDepth] = useState(1);
  const [nodes, setNodes] = useState<GraphNode[]>([]);
  const [edges, setEdges] = useState<GraphEdge[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lineage, setLineage] = useState<NeighborsResultDTO['lineage'] | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [selected, setSelected] = useState<InspectTarget | null>(null);
  const [hoverEdge, setHoverEdge] = useState<GraphEdge | null>(null);
  const expandedRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    let alive = true;
    fetchOntologySchema()
      .then((s) => { if (alive) setEntities(s.entities); })
      .catch(() => { if (alive) setError('本体注册表加载失败'); });
    return () => { alive = false; };
  }, []);

  // 台账抽屉跳入(Task 8 通道)：nonce 变化即重置画布锚定
  useEffect(() => {
    if (!initialAnchor) return;
    setAnchor({ type: initialAnchor.type, id: initialAnchor.id, label: initialAnchor.label });
  }, [initialAnchor]);

  // 过期响应守卫: 连续点选两个锚点时, replace 语义下慢的旧响应不得整体覆盖
  // 新锚点的画布。搜索结果用独立序号。
  const loadSeqRef = useRef(0);
  const searchSeqRef = useRef(0);
  const load = useCallback(async (target: { type: string; id: string; label: string }, d: number) => {
    const seq = ++loadSeqRef.current;
    setLoading(true);
    setError(null);
    expandedRef.current = new Set([nodeKey(target.type, target.id)]);
    try {
      const res = await fetchOntologyNeighbors(target.type, target.id, d);
      if (seq !== loadSeqRef.current) return;
      // replace 语义：锚点节点 + 全量邻接重建画布
      const anchorNode = toGraphNode(res.anchorNode);
      const nodeMap = new Map<string, GraphNode>();
      nodeMap.set(anchorNode.elementId, anchorNode);
      for (const n of res.nodes) nodeMap.set(nodeKey(n.entityType, n.id), toGraphNode(n));
      setNodes([...nodeMap.values()]);
      setEdges(res.edges.map(toGraphEdge));
      setLineage(res.lineage);
      setTruncated(res.truncated);
      setAnchor(target);
      setSelected(null);
    } catch (e) {
      if (seq !== loadSeqRef.current) return;
      // 加载失败清空画布: 避免旧锚点的节点/边留在新「当前中心」chip 之下。
      setNodes([]);
      setEdges([]);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (seq === loadSeqRef.current) setLoading(false);
    }
  }, []);

  // anchor state 变化(选择器点选 / 抽屉跳入)触发加载
  useEffect(() => {
    if (anchor) void load(anchor, depth);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- depth 只在手动加载时读取,避免改深度自动刷新覆盖展开结果
  }, [anchor]);

  // 双击节点 = lazy 展开该节点 depth=1 邻接(与文档模式「双击增量展开」语义一致)
  const handleNodeDoubleClick = useCallback((node: GraphNode) => {
    const t = node.props?.['__type'];
    const id = node.props?.['__id'];
    if (typeof t !== 'string' || typeof id !== 'string') return;
    // 血缘 Document 节点无本体注册表类型(D7)：跨空间逐跳展开 deferred，静默忽略
    // (不标记 expanded，后续也不可展开，符合 v1 语义)。
    if (t === 'Document') return;
    const key = nodeKey(t, id);
    if (expandedRef.current.has(key)) return;
    setLoading(true);
    fetchOntologyNeighbors(t, id, 1)
      .then((res) => {
        // 展开成功才标记：失败可重试(不吞掉后续双击)
        expandedRef.current.add(key);
        // merge 语义：保留既有节点，新增未见的节点与边
        setNodes((prev) => {
          const nodeMap = new Map(prev.map((n) => [n.elementId, n] as const));
          for (const n of res.nodes) {
            const gn = toGraphNode(n);
            if (!nodeMap.has(gn.elementId)) nodeMap.set(gn.elementId, gn);
          }
          return [...nodeMap.values()];
        });
        setEdges((prev) => {
          const ids = new Set(prev.map((e) => e.elementId));
          return [...prev, ...res.edges.filter((e) => !ids.has(e.id)).map(toGraphEdge)];
        });
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, []);

  const search = useCallback(async () => {
    if (!selectedType) return;
    setSearching(true);
    const seq = ++searchSeqRef.current;
    try {
      const res = await listEntities(selectedType, { q: q.trim() || undefined, pageSize: 10 });
      if (seq !== searchSeqRef.current) return;
      setCandidates(res.items);
    } catch (e) {
      // 搜索失败不写全局 error: 画布数据完好, 写全局 error 会把上方状态行
      // 整个变成"加载失败"。仅停在旧候选列表即可(控制台留痕)。
      console.error('[OntologyExplorer] candidate search failed:', e);
    } finally {
      if (seq === searchSeqRef.current) setSearching(false);
    }
  }, [selectedType, q]);

  const subgraph: Subgraph = useMemo(() => {
    const anchorNode = anchor ? toGraphNode({ ...anchorProps(anchor) }) : null;
    const subject = nodes[0] && anchorNode ? nodes.find((n) => n.elementId === anchorNode.elementId) ?? nodes[0] : null;
    return { subject, nodes, edges };
  }, [nodes, edges, anchor]);
  const anchorKey = anchor ? nodeKey(anchor.type, anchor.id) : null;

  const hoverParams = hoverEdge ? formatEdgeParams(hoverEdge.props ?? null) : '';

  return (
    <div className="flex h-full min-w-0 flex-col bg-surface/40">
      {/* 工具栏：起点选择器 + 深度 + 状态 */}
      <div className="flex flex-wrap items-center gap-2 border-b border-line bg-white px-3 py-2 text-sm">
        <select
          value={selectedType}
          onChange={(e) => { setSelectedType(e.target.value); setCandidates([]); }}
          className="h-8 rounded border border-line bg-white px-2 text-sm text-ink"
          aria-label="实体类型"
        >
          <option value="">选择实体类型</option>
          {entities?.map((e) => <option key={e.name} value={e.name}>{e.label}</option>)}
        </select>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') void search(); }}
          placeholder="按标识 / 字段值搜索起点"
          className="h-8 w-56 rounded border border-line bg-white px-2 text-sm text-ink placeholder:text-ink-soft/60"
        />
        <button
          type="button"
          onClick={() => void search()}
          className="h-8 rounded border border-line px-3 text-xs text-ink-soft transition-colors hover:border-primary/40 hover:text-primary"
        >
          {searching ? '搜索中...' : '搜索'}
        </button>
        {candidates.length > 0 && (
          <div className="relative">
            <ul className="absolute z-20 mt-1 max-h-60 w-72 overflow-y-auto rounded border border-line bg-white shadow-lg">
              {candidates.map((c) => (
                <li key={c.id}>
                  <button
                    type="button"
                    onClick={() => { setCandidates([]); setAnchor({ type: selectedType, id: c.id, label: c.label }); }}
                    className="block w-full px-3 py-2 text-left text-sm text-ink hover:bg-surface/60"
                  >
                    <span className="font-medium">{c.label}</span>
                    <span className="ml-2 text-xs text-ink-soft">{c.id}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
        <label className="ml-2 flex items-center gap-1 text-xs text-ink-soft">
          初始深度
          <select
            value={depth}
            onChange={(e) => setDepth(Number(e.target.value))}
            className="h-7 rounded border border-line bg-white px-1 text-xs text-ink"
          >
            <option value={1}>1</option>
            <option value={2}>2</option>
            <option value={3}>3</option>
          </select>
        </label>
        {anchor && (
          <span className="rounded border border-line bg-surface px-2 py-1 text-xs text-ink">
            当前中心：<span className="font-medium">{anchor.label}</span>
            <span className="ml-1 text-ink-soft">{anchorKey}</span>
          </span>
        )}
        {loading && <span className="text-xs text-ink-soft">加载中...</span>}
        {error && <span className="text-xs text-danger">{error}</span>}
        {lineage && !lineage.available && (
          <span className="text-xs text-ink-soft" title="NEO4J_PASSWORD 未配置或图服务不可用">
            文档血缘不可用（仅本体邻接）
          </span>
        )}
        {truncated && <span className="text-xs text-ink-soft">结果已截断（缩小深度或逐跳展开）</span>}
      </div>

      {/* 边图例(验收 2：颜色/图例区分两类边) */}
      <div className="flex flex-wrap items-center gap-3 border-b border-line bg-white px-3 py-1.5 text-xs text-ink-soft">
        {ONTOLOGY_EDGE_LEGEND.map((l) => (
          <span key={l.relation} className="flex items-center gap-1">
            <span
              className="inline-block h-0 w-6 border-t-2"
              style={{ borderColor: l.color, borderTopStyle: l.dashed ? 'dashed' : 'solid' }}
            />
            {edgeLabel(l.relation)}
          </span>
        ))}
      </div>

      {/* 画布 + 悬停参数浮层 */}
      <div className="relative min-h-0 flex-1">
        {nodes.length > 0 ? (
          <GraphCanvas
            key={anchorKey ?? 'ontology'}
            subgraph={subgraph}
            centerElementId={anchorKey}
            hiddenKinds={NO_HIDDEN_KINDS}
            showPlainEdges
            onHover={(t) => {
              if (t && t.type === 'edge') setHoverEdge(t.edge);
              else setHoverEdge(null);
            }}
            onNodeSelect={(n) => setSelected({ type: 'node', node: n })}
            onEdgeSelect={(e) => setSelected({ type: 'edge', edge: e })}
            onPaneSelect={() => setSelected(null)}
            onNodeDoubleClick={handleNodeDoubleClick}
          />
        ) : (
          <div className="flex h-full items-center justify-center text-sm text-ink-soft">
            选择实体类型并搜索起点，或从实体台账详情「在图中查看」跳入；双击节点逐步展开邻接。
          </div>
        )}
        {hoverEdge && hoverParams && (
          <div className="pointer-events-none absolute left-3 top-3 rounded border border-line bg-white/95 px-2 py-1 text-xs text-ink shadow">
            <span className="font-medium">{edgeLabel(hoverEdge.type)}</span>
            <span className="ml-2 text-ink-soft">{hoverParams}</span>
          </div>
        )}
      </div>

      {/* 选中详情(节点/边参数) */}
      {selected && (
        <div className="max-h-48 overflow-y-auto border-t border-line bg-white px-3 py-2 text-sm">
          {selected.type === 'node' ? (
            <div>
              <div className="font-medium text-ink">{selected.node.name}</div>
              <div className="mt-0.5 text-xs text-ink-soft">
                {String(selected.node.props?.['__type'] ?? selected.node.kind)}
                {' / '}
                {String(selected.node.props?.['__id'] ?? selected.node.elementId)}
              </div>
            </div>
          ) : (
            <div>
              <div className="font-medium text-ink">{edgeLabel(selected.edge.type)}</div>
              <div className="mt-0.5 text-xs text-ink-soft">
                {formatEdgeParams(selected.edge.props ?? null) || '无参数'}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** subgraph.subject 的展示锚点(仅用于画布定位，不进 nodes)。 */
function anchorProps(anchor: { type: string; id: string; label: string }): NeighborNodeDTO {
  return { id: anchor.id, entityType: anchor.type, label: anchor.label, source: 'unresolved' };
}