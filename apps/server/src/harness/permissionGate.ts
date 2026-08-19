// PermissionGate: source of truth for the L1/L2/L3 tool permission model
// (ARCHITECTURE.md section 5).
//
//   L1 readonly auto    -> query_* : runs automatically, no prompt
//   L2 write confirm    -> internal writes: soft gate, needs user confirmation
//   L3 external approval-> money/irreversible: NO registered tools today
//
// In AI SDK 6 the soft gate is implemented via the per-tool `needsApproval`
// property (v6). The L3 tier currently has NO registered tools: money /
// irreversible operations are not executable in-system. Human-in-the-loop for
// such cases is handled by the `escalate_to_human` tool (an L1 tool) which
// registers a pending L3 ticket in sessionStore and returns a `blocked` result
// so the frontend renders an in-app human-review card; approval resumes via
// /api/approval/callback -- not through permissionGate. The 'L3' member stays
// in ToolPermission because sessionStore approval rows still use the level
// string.

export type ToolPermission = 'L1' | 'L2' | 'L3';

const PERMISSIONS = new Map<string, ToolPermission>();

/** Register (or override) the permission level for a tool name. */
export function registerPermission(
  toolName: string,
  level: ToolPermission,
): void {
  PERMISSIONS.set(toolName, level);
}

/** Get the permission level for a tool. Unknown tools default to L1. */
export function getPermission(toolName: string): ToolPermission {
  return PERMISSIONS.get(toolName) ?? 'L1';
}

/** L1 tools only read data and may run automatically. */
export function isReadonly(toolName: string): boolean {
  return getPermission(toolName) === 'L1';
}

/** Any tool above L1 must pass through a gate (confirm / external approval). */
export function needsApproval(toolName: string): boolean {
  return getPermission(toolName) !== 'L1';
}

/** Whether a tool maps to the v6 `needsApproval` soft gate (L2 only). */
export function isSoftGate(toolName: string): boolean {
  return getPermission(toolName) === 'L2';
}

// ---- default registrations (declared up-front as the system source of truth) ----
// L1 readonly
registerPermission('query_contract', 'L1');
registerPermission('query_orders', 'L1');
registerPermission('cross_check', 'L1');
registerPermission('escalate_to_human', 'L1'); // T3: uncertainty fallback
registerPermission('verify_document_fields', 'L1'); // T4: document OCR check
// T9: document-entry pipeline tools
registerPermission('ingest_document', 'L1'); // T9: parse + persist BlockModel
registerPermission('extract_fields', 'L1'); // T9: grounded field extraction
registerPermission('inspect_extraction', 'L1'); // on-demand field-evidence drill-down
registerPermission('recall_documents', 'L1'); // T6: FTS5 keyword recall over chunks
registerPermission('execute_code', 'L1'); // CubeSandbox: isolated Python execution
registerPermission('present_document_review', 'L1'); // post-ingest review card (read-only present)
registerPermission('graph_find_entity', 'L1'); // 2026-08-17: 按名查图实体（只读入口）
registerPermission('graph_query', 'L1'); // 2026-08-18: 图遍历是只读查询（READ session），与 graph_find_entity 同级
registerPermission('list_binding_proposals', 'L1'); // Phase B: 待确认的凭证-合同绑定建议（只读）
registerPermission('query_execution_flows', 'L1'); // 执行流水六向汇总与逐笔明细（只读）
// L2 write confirm
registerPermission('advance_contract_stage', 'L2');
registerPermission('bind_document', 'L2'); // T9: bind document to contract
registerPermission('tag_document', 'L2'); // Phase 2: explicit document labeling
registerPermission('create_entity', 'L2'); // Phase 4 §7: graph entity create
registerPermission('link_entities', 'L2'); // Phase 4 §7: graph edge create
registerPermission('update_document_fields', 'L2'); // post-ingest field correction (write)
// L3: no registered tools -- money/irreversible operations are not executable
// in-system. Human-in-the-loop goes through escalate_to_human tickets
// (sessionStore pending approvals + /api/approval/callback resume).
