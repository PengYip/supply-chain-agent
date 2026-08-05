// PermissionGate: source of truth for the L1/L2/L3 tool permission model
// (ARCHITECTURE.md section 5).
//
//   L1 readonly auto    -> query_* : runs automatically, no prompt
//   L2 write confirm    -> internal writes: soft gate, needs user confirmation
//   L3 external approval-> money/irreversible: hard gate, external approval flow
//
// In AI SDK 6 the soft gate is implemented via the per-tool `needsApproval`
// property (v6). The L3 hard gate is enforced inside the tool's execute
// (returns a `blocked` result) because v6's approval mechanism only emits an
// approval-request and stops the loop without letting the agent narrate; the
// execute-blocked path is what produces a clear verbal response for L3.

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
// L2 write confirm
registerPermission('link_document', 'L2');
registerPermission('advance_contract_stage', 'L2');
// L3 external approval
registerPermission('create_payment', 'L3');
registerPermission('refund_payment', 'L3');
registerPermission('modify_contract', 'L3');
