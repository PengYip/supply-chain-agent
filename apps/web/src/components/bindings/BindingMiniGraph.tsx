import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import clsx from 'clsx';
import {
  ReactFlow,
  Background,
  BackgroundVariant,
  MarkerType,
  type Edge,
  type Node,
  type NodeProps,
  type NodeTypes,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import './binding-mini-graph.css';
import { AlertTriangle, Network, RefreshCw } from 'lucide-react';
import {
  EDGE_STYLE_OVERRIDES,
  KIND_ICONS,
  docTypeName,
  edgeLabel,
  kindStyle,
  nodeDisplayName,
  type DocMetaResolver,
} from '../graph/businessTypes';
import { AllSideHandles } from '../graph/GraphFlowNode';
import type { GraphFocusTarget } from '../graph/focus';
import type { GraphEdge, GraphNode } from '../../hooks/useGraph';

/* ---------- 数据获取（照 useGraph.ts 的错误语义：中文错误 + {ok,data} 信封兼容） ---------- */

async function getJson<T>(url: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, { credentials: 'include' });
  } catch {
    throw new Error('网络错误，请稍后重试');
  }
  if (!res.ok) {
    let message = `请求失败（${res.status}）`;
    try {
      const data = (await res.json()) as { error?: unknown; message?: unknown };
      const serverMsg =
        typeof data.error === 'string' && data.error
          ? data.error
          : typeof data.message === 'string' && data.message
            ? data.message
            : '';
      if (serverMsg) message = serverMsg;
    } catch {
      /* 非 JSON 响应，保留状态码消息 */
    }
    throw new Error(message);
  }
  let data: unknown;
  try {
    data = await res.json();
  } catch {
    throw new Error('响应格式异常');
  }
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    const envelope = data as { ok?: unknown; data?: unknown };
    if (envelope.ok === true && 'data' in envelope) data = envelope.data;
  }
  return data as T;
}

function asStr(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function asProps(v: unknown): Record<string, unknown> | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  return v as Record<string, unknown>;
}

function normalizeNode(raw: unknown): GraphNode | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const elementId = asStr(r.elementId);
  if (!elementId) return null;
  return { elementId, kind: asStr(r.kind), name: asStr(r.name), props: asProps(r.props) };
}

function normalizeEdge(raw: unknown): GraphEdge | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const elementId = asStr(r.elementId);
  const srcId = asStr(r.srcId);
  const dstId = asStr(r.dstId);
  if (!elementId || !srcId || !dstId) return null;
  return {
    elementId,
    type: asStr(r.type),
    srcId,
    dstId,
    props: asProps(r.props),
    confidence: typeof r.confidence === 'number' && Number.isFinite(r.confidence) ? r.confidence : null,
  };
}

/** GET /api/graph/resolve：把绑定（docId + 合同号）解析成图谱节点；null 表示尚未同步到图谱。 */
async function resolveBindingNodes(
  docId: string,
  contractNo: string,
): Promise<{ doc: GraphNode | null; contract: GraphNode | null }> {
  const qs = new URLSearchParams({ docId, contractNo });
  const data = await getJson<{ doc?: unknown; contract?: unknown }>(`/api/graph/resolve?${qs.toString()}`);
  return { doc: normalizeNode(data?.doc), contract: normalizeNode(data?.contract) };
}

/** GET /api/graph/query（depth=1 双向）：合同节点 1 跳邻域。subject 单独返回，这里并入 nodes。 */
async function fetchNeighborhood(subject: string): Promise<{ nodes: GraphNode[]; edges: GraphEdge[] }> {
  const qs = new URLSearchParams({ subject, depth: '1', direction: 'both' });
  const data = await getJson<{ subject?: unknown; nodes?: unknown[]; edges?: unknown[] }>(
    `/api/graph/query?${qs.toString()}`,
  );
  const nodes = (Array.isArray(data?.nodes) ? data.nodes : [])
    .map(normalizeNode)
    .filter((n): n is GraphNode => n !== null);
  const edges = (Array.isArray(data?.edges) ? data.edges : [])
    .map(normalizeEdge)
    .filter((e): e is GraphEdge => e !== null);
  const subjectNode = normalizeNode(data?.subject);
  if (subjectNode && !nodes.some((n) => n.elementId === subjectNode.elementId)) {
    nodes.unshift(subjectNode);
  }
  return { nodes, edges };
}

/* ---------- 迷你节点：与主画布同语言的两族卡片（文档=纸片+类型徽章，实体=类别色实底）的紧凑版 ---------- */

type MiniNodeData = { graph: GraphNode; isCenter: boolean; isBound: boolean; docMeta: DocMetaResolver | null };
type MiniFlowNode = Node<MiniNodeData, 'mini'>;

function MiniDocumentNode({ graph, isCenter, isBound, docMeta }: Omit<MiniNodeData, 'isBound'> & { isBound: boolean }) {
  const style = kindStyle(graph.kind);
  const name = nodeDisplayName(graph, docMeta);
  const docType = docTypeName(graph, docMeta) || '文档';
  return (
    <div
      className={clsx('w-28 rounded-lg border-l-[3px] bg-white px-2.5 py-1.5 shadow-card', isCenter ? 'border-l-4' : '')}
      style={{
        borderLeftColor: style.color,
        ...(isBound ? { boxShadow: '0 0 0 2px #0F3A5C' } : undefined),
      }}
      title={name}
    >
      <div className="flex items-center gap-1">
        <span
          className="flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded"
          style={{ background: style.softBg, color: style.color }}
        >
          <KIND_ICONS.Document className="h-2 w-2" aria-hidden />
        </span>
        <span className="min-w-0 max-w-[68px] shrink truncate rounded border border-primary/20 bg-primary/10 px-1 py-px text-[9px] leading-4 text-primary-500">
          {docType}
        </span>
        {isBound && (
          <span className="ml-auto shrink-0 rounded bg-primary px-1 py-px text-[9px] leading-4 text-white">绑定</span>
        )}
      </div>
      <div className="mt-0.5 line-clamp-2 break-all text-[11px] leading-4 text-ink">{name}</div>
      <AllSideHandles />
    </div>
  );
}

function MiniEntityNode({ graph, isCenter }: { graph: GraphNode; isCenter: boolean }) {
  const style = kindStyle(graph.kind);
  const Icon = KIND_ICONS[graph.kind] ?? KIND_ICONS.Document;
  const name = nodeDisplayName(graph);
  return (
    <div
      className={clsx('rounded-md px-2.5 py-1.5', isCenter ? 'w-36' : 'w-28')}
      style={{
        background: style.color,
        boxShadow: isCenter ? '0 3px 10px rgba(15, 58, 92, 0.3)' : '0 1px 2px rgba(15, 58, 92, 0.2)',
      }}
      title={name}
    >
      <div className="flex items-center gap-1">
        <span
          className="flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded"
          style={{ background: 'rgba(255,255,255,0.18)' }}
        >
          <Icon className="h-2 w-2 text-white" aria-hidden />
        </span>
        <span className="shrink-0 truncate text-[9px] font-medium tracking-wider" style={{ color: 'rgba(255,255,255,0.85)' }}>
          {style.label}
        </span>
        {isCenter && (
          <span className="ml-auto shrink-0 rounded bg-white/20 px-1 py-px text-[9px] leading-4 text-white">中心</span>
        )}
      </div>
      <div className="mt-0.5 line-clamp-2 break-all text-[11px] font-medium leading-4 text-white">{name}</div>
      <AllSideHandles />
    </div>
  );
}

function MiniGraphNode({ data }: NodeProps<MiniFlowNode>) {
  if (data.graph.kind === 'Document') {
    return <MiniDocumentNode graph={data.graph} isCenter={data.isCenter} isBound={data.isBound} docMeta={data.docMeta} />;
  }
  return <MiniEntityNode graph={data.graph} isCenter={data.isCenter} />;
}

const MINI_NODE_TYPES: NodeTypes = { mini: MiniGraphNode };

/* ---------- 布局：中心在原点，1 跳邻居按排序后单环分布（复用主画布径向思路的紧凑版） ---------- */

const EDGE_STROKE = '#9DB0C3';
const GOLDEN_ANGLE = 2.39996;

interface Point {
  x: number;
  y: number;
}

/** 按两端相对方位挑选锚点：水平主导走左右，垂直主导走上下（与主画布一致）。 */
function handlePairFor(src: Point, dst: Point): { sourceHandle: string; targetHandle: string } {
  const dx = dst.x - src.x;
  const dy = dst.y - src.y;
  if (Math.abs(dx) >= Math.abs(dy)) {
    return dx >= 0
      ? { sourceHandle: 'right-s', targetHandle: 'left-t' }
      : { sourceHandle: 'left-s', targetHandle: 'right-t' };
  }
  return dy >= 0
    ? { sourceHandle: 'bottom-s', targetHandle: 'top-t' }
    : { sourceHandle: 'top-s', targetHandle: 'bottom-t' };
}

interface MiniReady {
  phase: 'ready';
  /** 本次加载的请求序号：用作画布 key，保证重新加载后重建并重新 fitView。 */
  loadId: number;
  contract: GraphNode;
  /** 被绑定的文档节点（resolve 结果），在迷你图中高亮；null 表示文档侧未同步。 */
  docElementId: string | null;
  nodes: GraphNode[];
  edges: GraphEdge[];
}

function buildMiniLayout(
  ready: MiniReady,
  bindingId: string | null,
  docMeta: DocMetaResolver | null,
): { flowNodes: MiniFlowNode[]; flowEdges: Edge[] } {
  const centerId = ready.contract.elementId;
  const others = ready.nodes
    .filter((n) => n.elementId !== centerId)
    .sort((a, b) => (a.elementId < b.elementId ? -1 : 1));

  const positions = new Map<string, Point>();
  positions.set(centerId, { x: 0, y: 0 });
  // 单环布局：节点越多半径越大，避免卡片压盖
  const radius = Math.max(130, others.length * 34);
  others.forEach((node, i) => {
    const theta = others.length === 1 ? GOLDEN_ANGLE : GOLDEN_ANGLE + (2 * Math.PI * i) / others.length;
    positions.set(node.elementId, { x: radius * Math.cos(theta), y: radius * Math.sin(theta) });
  });

  const flowNodes: MiniFlowNode[] = ready.nodes.map((node) => ({
    id: node.elementId,
    type: 'mini' as const,
    position: positions.get(node.elementId) ?? { x: 0, y: 0 },
    data: {
      graph: node,
      isCenter: node.elementId === centerId,
      isBound: ready.docElementId != null && node.elementId === ready.docElementId,
      docMeta,
    },
  }));

  const flowEdges: Edge[] = ready.edges.map((edge) => {
    const src = positions.get(edge.srcId) ?? { x: 0, y: 0 };
    const dst = positions.get(edge.dstId) ?? { x: 0, y: 0 };
    const { sourceHandle, targetHandle } = handlePairFor(src, dst);
    // 本绑定对应的 binds 边加粗，其余 binds 边保持常规虚线
    const isThisBinding = bindingId != null && edge.type === 'binds' && edge.props?.bindingId === bindingId;
    const override = EDGE_STYLE_OVERRIDES[edge.type];
    const stroke = override?.color ?? EDGE_STROKE;
    return {
      id: edge.elementId,
      source: edge.srcId,
      target: edge.dstId,
      sourceHandle,
      targetHandle,
      label: edgeLabel(edge.type),
      style: { stroke, strokeWidth: isThisBinding ? 2.5 : 1.5, ...(override?.dashed ? { strokeDasharray: '6 4' } : {}) },
      labelStyle: { fill: isThisBinding ? '#15803D' : '#4B5563', fontSize: 10, ...(isThisBinding ? { fontWeight: 600 } : {}) },
      labelBgStyle: { fill: '#FFFFFF', stroke: '#E5E7EB', strokeWidth: 1 },
      labelBgPadding: [4, 2] as [number, number],
      labelBgBorderRadius: 4,
      markerEnd: { type: MarkerType.ArrowClosed, width: 12, height: 12, color: stroke },
    };
  });

  return { flowNodes, flowEdges };
}

function MiniGraphCanvas({
  ready,
  bindingId,
  docMeta,
}: {
  ready: MiniReady;
  bindingId: string | null;
  docMeta: DocMetaResolver | null;
}) {
  const { flowNodes, flowEdges } = useMemo(
    () => buildMiniLayout(ready, bindingId, docMeta),
    [ready, bindingId, docMeta],
  );
  return (
    <ReactFlow<MiniFlowNode>
      className="sca-flow"
      nodes={flowNodes}
      edges={flowEdges}
      nodeTypes={MINI_NODE_TYPES}
      fitView
      fitViewOptions={{ padding: 0.2, maxZoom: 1.1 }}
      minZoom={0.2}
      maxZoom={1.4}
      nodesDraggable={false}
      nodesConnectable={false}
      zoomOnScroll={false}
      panOnScroll={false}
      preventScrolling={false}
      zoomOnDoubleClick={false}
      proOptions={{ hideAttribution: true }}
    >
      <Background variant={BackgroundVariant.Dots} gap={16} size={1.1} color="#CBD5E1" />
    </ReactFlow>
  );
}

/* ---------- 主组件 ---------- */

type MiniState =
  | { phase: 'loading' }
  | MiniReady
  | { phase: 'notSynced' }
  | { phase: 'error'; message: string };

interface BindingMiniGraphProps {
  /** 当前文档 docId（resolve 参数 + 文档节点识别）。 */
  docId: string;
  /** 绑定的合同号（resolve 参数 + 跳转标签）。 */
  contractNo: string;
  /** 用于精确高亮本绑定对应的 binds 边。 */
  bindingId: string | null;
  /** 可选 docId -> 文件名/业务类型 兜底（绑定文档节点缺 props 时补齐显示）。 */
  docMeta?: DocMetaResolver | null;
  /** 跳转完整图谱：以合同节点为中心展开。 */
  onOpenInGraph?: (target: GraphFocusTarget) => void;
}

/** 绑定条目的内嵌迷你图谱：合同节点为中心的 1 跳邻域，被绑定文档高亮。 */
export function BindingMiniGraph({ docId, contractNo, bindingId, docMeta = null, onOpenInGraph }: BindingMiniGraphProps) {
  const [state, setState] = useState<MiniState>({ phase: 'loading' });
  // 递增请求序号：丢弃过期响应（快速重试 / 参数变化时）
  const requestIdRef = useRef(0);

  const load = useCallback(async () => {
    const reqId = ++requestIdRef.current;
    setState({ phase: 'loading' });
    try {
      const resolved = await resolveBindingNodes(docId, contractNo);
      if (reqId !== requestIdRef.current) return;
      if (!resolved.contract) {
        setState({ phase: 'notSynced' });
        return;
      }
      const hood = await fetchNeighborhood(resolved.contract.elementId);
      if (reqId !== requestIdRef.current) return;
      setState({
        phase: 'ready',
        loadId: reqId,
        contract: resolved.contract,
        docElementId: resolved.doc?.elementId ?? null,
        nodes: hood.nodes,
        edges: hood.edges,
      });
    } catch (e) {
      if (reqId !== requestIdRef.current) return;
      setState({ phase: 'error', message: e instanceof Error ? e.message : '图谱加载失败' });
    }
  }, [docId, contractNo]);

  useEffect(() => {
    void load();
  }, [load]);

  const ready = state.phase === 'ready' ? state : null;

  return (
    <div className="mt-2.5 animate-fade-in overflow-hidden rounded-md border border-line bg-white">
      <div className="flex items-center gap-1.5 border-b border-line bg-surface px-2.5 py-1.5">
        <Network className="h-3.5 w-3.5 shrink-0 text-primary" aria-hidden />
        <span className="text-[11px] font-medium text-ink">图谱邻域 · 深度 1</span>
        {ready && (
          <span className="ml-auto text-[10px] tabular-nums text-ink-soft">
            节点 {ready.nodes.length} · 关系 {ready.edges.length}
          </span>
        )}
      </div>

      <div className="relative h-60 bg-surface">
        {state.phase === 'loading' && (
          <div className="flex h-full flex-col items-center justify-center gap-2">
            <span className="h-6 w-6 animate-spin rounded-full border-2 border-line border-t-primary" />
            <span className="text-[11px] text-ink-soft">图谱加载中</span>
          </div>
        )}
        {state.phase === 'notSynced' && (
          <div className="flex h-full flex-col items-center justify-center px-4 text-center">
            <Network className="h-7 w-7 text-line" aria-hidden />
            <div className="mt-2 text-[12px] leading-5 text-ink">该绑定尚未同步到图谱</div>
            <div className="mt-0.5 text-[11px] leading-4 text-ink-soft">
              重新确认或重试同步后，这里会展示该合同的关联
            </div>
          </div>
        )}
        {state.phase === 'error' && (
          <div className="flex h-full flex-col items-center justify-center px-4 text-center">
            <AlertTriangle className="h-7 w-7 text-danger" aria-hidden />
            <div className="mt-2 max-w-[220px] break-all text-[11px] leading-4 text-danger">{state.message}</div>
            <button
              type="button"
              onClick={() => void load()}
              className="mt-3 flex items-center gap-1 rounded-md border border-line bg-white px-2.5 py-1 text-[11px] text-ink transition-colors hover:bg-surface"
            >
              <RefreshCw className="h-3 w-3" aria-hidden />
              重试
            </button>
          </div>
        )}
        {ready && (
          <MiniGraphCanvas key={ready.loadId} ready={ready} bindingId={bindingId} docMeta={docMeta} />
        )}
      </div>

      {ready && onOpenInGraph && (
        <div className="border-t border-line bg-white px-2 py-1.5">
          <button
            type="button"
            onClick={() => onOpenInGraph({ elementId: ready.contract.elementId, label: contractNo })}
            className="flex h-7 w-full items-center justify-center gap-1.5 rounded-md bg-primary text-[11px] font-medium text-white transition-colors hover:bg-primary-800"
          >
            <Network className="h-3.5 w-3.5" aria-hidden />
            在完整图谱中查看
          </button>
        </div>
      )}
    </div>
  );
}
