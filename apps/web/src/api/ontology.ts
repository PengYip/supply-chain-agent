export interface OntologyEntitySchemaDTO {
  name: string;
  label: string;
  ownFields: string[];
  fields: string[];
  meaning: string | null;
}

export interface OntologySchemaDTO {
  version: string;
  enums: Record<string, string[]>;
  entities: OntologyEntitySchemaDTO[];
  relations: Array<{
    name: string;
    description: string;
    pairs: Array<{ from: string; to: string }>;
    params: string[];
    meaning: string | null;
  }>;
}

async function request<T>(url: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, { credentials: 'include' });
  } catch {
    throw new Error('网络错误，请稍后重试');
  }
  if (!res.ok) {
    let message = `请求失败（${res.status}）`;
    try {
      const data = (await res.json()) as { error?: string; detail?: string };
      if (data?.error) message = data.detail ? `${data.error}：${data.detail}` : data.error;
    } catch { /* 非 JSON 响应，保留状态码消息 */ }
    throw new Error(message);
  }
  return (await res.json()) as T;
}

export function fetchOntologySchema(): Promise<OntologySchemaDTO> {
  return request<OntologySchemaDTO>('/api/ontology/schema');
}

export interface ProjectedEntity {
  id: string;
  entityType: string;
  label: string;
  fields: Record<string, unknown>;
  meta?: Record<string, string | null>;
  source: 'contract_ledger' | 'documents' | 'trade_facts';
  validAt: string | null;
  ingestedAt: string | null;
}

export interface EntityListResult {
  items: ProjectedEntity[];
  total: number;
  page: number;
  pageSize: number;
}

export function listEntities(
  type: string,
  opts: { page?: number; pageSize?: number; q?: string } = {},
): Promise<EntityListResult> {
  const params = new URLSearchParams();
  if (opts.page) params.set('page', String(opts.page));
  if (opts.pageSize) params.set('pageSize', String(opts.pageSize));
  if (opts.q) params.set('q', opts.q);
  const qs = params.toString();
  return request<EntityListResult>(`/api/ontology/entities/${encodeURIComponent(type)}${qs ? `?${qs}` : ''}`);
}

export interface EntityDetailResult {
  entity: ProjectedEntity;
  timeline: ProjectedEntity[];
  netAmount: number | null;
  asOf: { mode: 'business' | 'system'; at: string };
}

export function getEntityDetail(
  type: string,
  id: string,
  opts: { asOf?: 'business' | 'system'; at?: string } = {},
): Promise<EntityDetailResult> {
  const params = new URLSearchParams();
  if (opts.asOf) params.set('asOf', opts.asOf);
  if (opts.at) params.set('at', opts.at);
  const qs = params.toString();
  return request<EntityDetailResult>(
    `/api/ontology/entities/${encodeURIComponent(type)}/${encodeURIComponent(id)}${qs ? `?${qs}` : ''}`);
}

export interface NeighborNodeDTO {
  id: string;
  entityType: string;
  label: string;
  source: 'contract_ledger' | 'documents' | 'trade_facts' | 'neo4j' | 'unresolved';
  props?: Record<string, unknown>;
}

export interface NeighborEdgeDTO {
  id: string;
  relation: string;
  origin: 'ontology' | 'lineage';
  fromType: string;
  fromId: string;
  toType: string;
  toId: string;
  params: Record<string, unknown>;
  validAt: string | null;
}

export interface NeighborsResultDTO {
  anchor: { type: string; id: string };
  anchorNode: NeighborNodeDTO;
  nodes: NeighborNodeDTO[];
  edges: NeighborEdgeDTO[];
  lineage: { available: boolean; subjectFound: boolean };
  truncated: boolean;
}

export function fetchOntologyNeighbors(
  type: string, id: string, depth = 1,
): Promise<NeighborsResultDTO> {
  const params = new URLSearchParams({ type, id, depth: String(depth) });
  return request<NeighborsResultDTO>(`/api/ontology/graph/neighbors?${params.toString()}`);
}
