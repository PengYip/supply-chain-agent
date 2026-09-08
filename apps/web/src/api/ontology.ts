export interface OntologyEntitySchemaDTO {
  name: string;
  label: string;
  /** 注册表说明性文字（业务定义 + 对账/履约链角色；治理 UI 四处落位的数据源）。 */
  description: string;
  /** 注册表派生（static=4 静态 / event=7 事件）；事件清单以此为 SSOT，禁止前端硬编码。 */
  phase: 'static' | 'event';
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

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, { credentials: 'include', ...init });
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

/** 11 实体实时计数(治理全景图数据源, roadmap Item 8)。key = 注册表实体名。 */
export interface OntologyCountsDTO {
  counts: Record<string, number>;
}

export function fetchOntologyCounts(): Promise<OntologyCountsDTO> {
  return request<OntologyCountsDTO>('/api/ontology/counts');
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
  opts: { page?: number; pageSize?: number; q?: string; validFrom?: string; validTo?: string; amountMin?: number; amountMax?: number } = {},
): Promise<EntityListResult> {
  const params = new URLSearchParams();
  if (opts.page) params.set('page', String(opts.page));
  if (opts.pageSize) params.set('pageSize', String(opts.pageSize));
  if (opts.q) params.set('q', opts.q);
  if (opts.validFrom) params.set('validFrom', opts.validFrom);
  if (opts.validTo) params.set('validTo', opts.validTo);
  if (opts.amountMin !== undefined) params.set('amountMin', String(opts.amountMin));
  if (opts.amountMax !== undefined) params.set('amountMax', String(opts.amountMax));
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
  lineage: { available: boolean; subjectFound: boolean; bridgesExpanded?: number };
  truncated: boolean;
}

export function fetchOntologyNeighbors(
  type: string, id: string, depth = 1,
): Promise<NeighborsResultDTO> {
  const params = new URLSearchParams({ type, id, depth: String(depth) });
  return request<NeighborsResultDTO>(`/api/ontology/graph/neighbors?${params.toString()}`);
}

// ---------------------------------------------------------------------------
// 图谱同步（spec 2026-09-09 P1/P2）：把台账事实/本体关系全量幂等投影到 Neo4j，
// 穿透视图因此可跨空间逐跳（本体走到合同 -> 合同带出单据血缘）。
// ---------------------------------------------------------------------------

export interface GraphSyncResultDTO {
  status: 'ok' | 'partial' | 'skipped';
  nodeCount: number;
  edgeCount: number;
  prunedCount: number;
  truncated: boolean;
  failures: string[];
}

export function syncOntologyGraph(): Promise<GraphSyncResultDTO> {
  return request<GraphSyncResultDTO>('/api/ontology/graph/sync', { method: 'POST' });
}

// ---------------------------------------------------------------------------
// 主数据登记表单（2026-09-08）：字段/必填/描述全部来自服务端注册表反射投影
// （GET /api/ontology/master-data/schema），提交走 POST /api/ontology/master-data
// 直写 trade_facts（写入边界 insertTradeFact，createdBy=manual）。
// ---------------------------------------------------------------------------

export interface MasterDataFormFieldDTO {
  name: string;
  kind: 'string' | 'number' | 'enum';
  required: boolean;
  description: string;
}

export interface MasterDataTypeFormDTO {
  name: string;
  label: string;
  description: string;
  fields: MasterDataFormFieldDTO[];
}

export interface MasterDataFormSchemaDTO {
  types: MasterDataTypeFormDTO[];
}

export interface MasterDataSubmitResult {
  id: string;
  entityType: string;
}

/** 字段级校验错误（服务端 invalid_body / invalid_master_data 投影）。 */
export interface MasterDataFieldErrors {
  formErrors: string[];
  fieldErrors: Record<string, string[]>;
}

export class MasterDataValidationError extends Error {
  readonly detail: MasterDataFieldErrors;
  constructor(detail: MasterDataFieldErrors) {
    super('校验失败，请检查标红字段');
    this.detail = detail;
  }
}

export function fetchMasterDataFormSchema(): Promise<MasterDataFormSchemaDTO> {
  return request<MasterDataFormSchemaDTO>('/api/ontology/master-data/schema');
}

export async function submitMasterData(
  input: Record<string, string | number>,
): Promise<MasterDataSubmitResult> {
  let res: Response;
  try {
    res = await fetch('/api/ontology/master-data', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(input),
    });
  } catch {
    throw new Error('网络错误，请稍后重试');
  }
  if (!res.ok) {
    let message = `请求失败（${res.status}）`;
    try {
      const data = (await res.json()) as { error?: string; detail?: MasterDataFieldErrors | string };
      if (data?.error === 'invalid_body' || data?.error === 'invalid_master_data') {
        const detail = (data.detail ?? { formErrors: [], fieldErrors: {} }) as MasterDataFieldErrors;
        throw new MasterDataValidationError({
          formErrors: detail.formErrors ?? [],
          fieldErrors: detail.fieldErrors ?? {},
        });
      }
      if (data?.error) {
        message = typeof data.detail === 'string' ? `${data.error}：${data.detail}` : data.error;
      }
    } catch (e) {
      if (e instanceof MasterDataValidationError) throw e;
      /* 非 JSON 响应，保留状态码消息 */
    }
    throw new Error(message);
  }
  return (await res.json()) as MasterDataSubmitResult;
}
