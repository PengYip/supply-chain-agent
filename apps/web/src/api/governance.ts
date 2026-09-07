// apps/web/src/api/governance.ts
// 治理后台只读数据源（roadmap Item 6）。三条 SSOT：
// /api/tools/inventory（docs/tool-inventory.json x 注册表）、
// /api/tools/permissions（permissionGate）、/api/approval/list（pending_approvals）。

export interface InventoryRegistryStateDTO { mounted: boolean; needsApproval: boolean; }

export interface ToolInventoryItemDTO {
  name: string;
  layer: string;
  level: string;
  status: string;
  mount: string;
  requiresEnv?: string;
  whenToUse: string;
  boundary: string;
  rationale: string;
  removalPlan?: string;
  mergeInto?: string;
  registry: InventoryRegistryStateDTO;
}

export interface ToolInventoryDTO {
  source: string;
  version: string;
  policy: unknown;
  tools: ToolInventoryItemDTO[];
  removed: Array<{ name: string; reason: string; removedOn?: string; mergedInto?: string }>;
  merges: unknown;
  mountedCount: number;
  diff: { mountedNotInInventory: string[]; inventoryNotMounted: string[] };
}

export interface PermissionEntryDTO { toolName: string; level: 'L1' | 'L2' | 'L3'; }

export interface PermissionSnapshotDTO {
  source: string;
  levels: string[];
  entries: PermissionEntryDTO[];
  note: string;
}

export interface ApprovalAuditItemDTO {
  id: string;
  session_id: string;
  level: 'L2' | 'L3';
  tool_name: string;
  status: 'pending' | 'approved' | 'denied';
  created_at: string;
  decided_by?: string | null;
  decided_at?: string | null;
  reason?: string | null;
  sideEffects: Array<{ target: string; action: string; ok: boolean; detail: string; at: string }> | null;
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

export function fetchToolInventory(): Promise<ToolInventoryDTO> {
  return request<ToolInventoryDTO>('/api/tools/inventory');
}

export function fetchPermissionSnapshot(): Promise<PermissionSnapshotDTO> {
  return request<PermissionSnapshotDTO>('/api/tools/permissions');
}

export interface ApprovalAuditFilters {
  status?: string;
  toolName?: string;
  decidedBy?: string;
  createdFrom?: string;
  createdTo?: string;
  limit?: number;
}

export function fetchApprovalAudit(filters: ApprovalAuditFilters = {}): Promise<{ items: ApprovalAuditItemDTO[] }> {
  const params = new URLSearchParams();
  if (filters.status) params.set('status', filters.status);
  if (filters.toolName) params.set('toolName', filters.toolName);
  if (filters.decidedBy) params.set('decidedBy', filters.decidedBy);
  if (filters.createdFrom) params.set('createdFrom', filters.createdFrom);
  if (filters.createdTo) params.set('createdTo', filters.createdTo);
  params.set('limit', String(filters.limit ?? 100));
  return request<{ items: ApprovalAuditItemDTO[] }>(`/api/approval/list?${params.toString()}`);
}
