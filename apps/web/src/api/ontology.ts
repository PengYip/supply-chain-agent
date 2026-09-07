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
