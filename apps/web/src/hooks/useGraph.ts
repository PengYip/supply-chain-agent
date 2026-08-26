import { useState, useEffect, useCallback, useRef } from 'react';

/** 节点类别（/api/graph 契约）：Document / Party / Commodity / Contract。 */
export type GraphKind = 'Document' | 'Party' | 'Commodity' | 'Contract';

/** 子图方向：双向 / 出边 / 入边。 */
export type GraphDirection = 'both' | 'out' | 'in';

export interface GraphDocument {
  elementId: string;
  docId: string;
  docType: string;
  sourceUri: string;
  createdAt: string;
}

export interface GraphNode {
  elementId: string;
  kind: string;
  name: string;
  props: Record<string, unknown> | null;
}

export interface GraphEdge {
  elementId: string;
  type: string;
  srcId: string;
  dstId: string;
  props: Record<string, unknown> | null;
  confidence: number | null;
}

export interface Subgraph {
  subject: GraphNode | null;
  nodes: GraphNode[];
  edges: GraphEdge[];
}

/** 详情面板/悬停查看的目标：节点或关系。 */
export type InspectTarget =
  | { type: 'node'; node: GraphNode }
  | { type: 'edge'; edge: GraphEdge };

/* ---------- 响应解析（对齐 api/eval.ts 的错误处理，兼容 {ok,data} 信封） ---------- */

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
    } catch { /* 非 JSON 响应，保留状态码消息 */ }
    throw new Error(message);
  }
  let data: unknown;
  try {
    data = await res.json();
  } catch {
    throw new Error('响应格式异常');
  }
  // 图谱接口可能直接返回载荷，也可能套 {ok:true,data:...} 信封，两者都兼容。
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    const envelope = data as { ok?: unknown; data?: unknown };
    if (envelope.ok === true && 'data' in envelope) data = envelope.data;
  }
  return data as T;
}

function asStr(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function asNum(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function asProps(v: unknown): Record<string, unknown> | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  return v as Record<string, unknown>;
}

function normalizeDocument(raw: { elementId?: unknown; docId?: unknown; docType?: unknown; sourceUri?: unknown; createdAt?: unknown }): GraphDocument {
  return {
    elementId: asStr(raw.elementId),
    docId: asStr(raw.docId),
    docType: asStr(raw.docType),
    sourceUri: asStr(raw.sourceUri),
    createdAt: asStr(raw.createdAt),
  };
}

function normalizeNode(raw: { elementId?: unknown; kind?: unknown; name?: unknown; props?: unknown }): GraphNode {
  return {
    elementId: asStr(raw.elementId),
    kind: asStr(raw.kind),
    name: asStr(raw.name),
    props: asProps(raw.props),
  };
}

function normalizeEdge(raw: { elementId?: unknown; type?: unknown; srcId?: unknown; dstId?: unknown; props?: unknown; confidence?: unknown }): GraphEdge {
  return {
    elementId: asStr(raw.elementId),
    type: asStr(raw.type),
    srcId: asStr(raw.srcId),
    dstId: asStr(raw.dstId),
    props: asProps(raw.props),
    confidence: asNum(raw.confidence),
  };
}

/* ---------- 独立 API（实体检索，契约保留入口，页面暂未接线） ---------- */

export async function fetchGraphEntities(
  params: { kind?: string; name?: string; exact?: boolean } = {},
): Promise<unknown[]> {
  const qs = new URLSearchParams();
  if (params.kind) qs.set('kind', params.kind);
  if (params.name) qs.set('name', params.name);
  if (params.exact) qs.set('exact', 'true');
  const suffix = qs.toString() ? `?${qs.toString()}` : '';
  const data = await getJson<{ entities?: unknown[] }>(`/api/graph/entities${suffix}`);
  return Array.isArray(data?.entities) ? data.entities : [];
}

/* ---------- Hook ---------- */

export function useGraph() {
  // 文档列表（左侧面板）
  const [documents, setDocuments] = useState<GraphDocument[]>([]);
  const [docsLoading, setDocsLoading] = useState(true);
  const [docsError, setDocsError] = useState<string | null>(null);

  // 以某节点为中心的子图（画布）
  const [subgraph, setSubgraph] = useState<Subgraph | null>(null);
  const [graphLoading, setGraphLoading] = useState(false);
  const [graphError, setGraphError] = useState<string | null>(null);
  // 子图请求序号: 用于丢弃过期响应(慢的旧查询晚到时不覆盖新结果)。
  const subgraphReqIdRef = useRef(0);

  const refreshDocuments = useCallback(async () => {
    setDocsLoading(true);
    setDocsError(null);
    try {
      const data = await getJson<{ documents?: unknown[] }>('/api/graph/documents');
      const rawList = Array.isArray(data?.documents) ? data.documents : [];
      const docs = rawList
        .map((raw) => normalizeDocument(raw as Record<string, unknown>))
        .filter((d) => d.elementId);
      // 新抽取的文档排前面（createdAt 为 ISO 字符串，直接字典序比较）。
      docs.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
      setDocuments(docs);
    } catch (e) {
      setDocsError(e instanceof Error ? e.message : '文档列表加载失败');
    } finally {
      setDocsLoading(false);
    }
  }, []);

  useEffect(() => { void refreshDocuments(); }, [refreshDocuments]);

  const loadSubgraph = useCallback(async (subject: string, depth: number, direction: GraphDirection) => {
    // 请求序号守卫: 慢的旧查询晚到时不覆盖新查询的结果(center 已反映新查询)。
    const reqId = ++subgraphReqIdRef.current;
    setGraphLoading(true);
    setGraphError(null);
    try {
      const qs = new URLSearchParams({ subject, depth: String(depth), direction });
      const data = await getJson<{ subject?: unknown; nodes?: unknown[]; edges?: unknown[] }>(
        `/api/graph/query?${qs.toString()}`,
      );
      if (reqId !== subgraphReqIdRef.current) return;
      const rawNodes = Array.isArray(data?.nodes) ? data.nodes : [];
      const rawEdges = Array.isArray(data?.edges) ? data.edges : [];
      const nodes = rawNodes
        .map((raw) => normalizeNode(raw as Record<string, unknown>))
        .filter((n) => n.elementId);
      const edges = rawEdges
        .map((raw) => normalizeEdge(raw as Record<string, unknown>))
        .filter((e) => e.elementId && e.srcId && e.dstId);
      const subjectNode =
        data?.subject != null && typeof data.subject === 'object'
          ? normalizeNode(data.subject as Record<string, unknown>)
          : null;
      // 服务端契约: subject 单独返回, nodes 只含邻居。画布只渲染 nodes,
      // 因此把中心节点并入 nodes(按 elementId 去重), 否则画布缺中心卡片。
      if (subjectNode?.elementId && !nodes.some((n) => n.elementId === subjectNode.elementId)) {
        nodes.unshift(subjectNode);
      }
      setSubgraph({ subject: subjectNode?.elementId ? subjectNode : null, nodes, edges });
    } catch (e) {
      if (reqId !== subgraphReqIdRef.current) return;
      setSubgraph(null);
      setGraphError(e instanceof Error ? e.message : '图谱加载失败');
    } finally {
      if (reqId === subgraphReqIdRef.current) setGraphLoading(false);
    }
  }, []);

  return {
    documents,
    docsLoading,
    docsError,
    refreshDocuments,
    subgraph,
    graphLoading,
    graphError,
    loadSubgraph,
  };
}

export type GraphApi = ReturnType<typeof useGraph>;
