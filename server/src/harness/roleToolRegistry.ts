import type { Tool } from 'ai';
import { queryContract, queryOrders, crossCheck } from '../tools/queries.js';
import { linkDocument, createPayment } from '../tools/writes.js';
import { escalateToHuman, verifyDocumentFields } from '../tools/hitl.js';

// MVP roles. Later phases add risk / finance / management with their own toolsets.
export type Role = 'trader';

// role -> tool subset.
//
// Phase 3a: trader gets all 5 tools (3 L1 reads + 1 L2 write + 1 L3 write) so
// the permission gates can be exercised end-to-end. Real RBAC / role isolation
// is a later phase.
//
// T3/T4 add two more L1 tools (escalate_to_human, verify_document_fields) so
// the full HITL T1-T6 flow is backend-testable.
//
// NOTE on activeTools: in a later phase, a `prepareStep` hook will narrow
// `activeTools` per step based on the current role + parsed intent, so each step
// only sees the tools it is allowed to call. For now we hand the role its full
// toolset and let the model pick.
const REGISTRY: Record<Role, Record<string, Tool>> = {
  trader: {
    query_contract: queryContract,
    query_orders: queryOrders,
    cross_check: crossCheck,
    link_document: linkDocument,
    create_payment: createPayment,
    escalate_to_human: escalateToHuman,
    verify_document_fields: verifyDocumentFields,
  },
};

export function getToolsForRole(role: Role): Record<string, Tool> {
  return REGISTRY[role] ?? {};
}

export function listToolNames(role: Role): string[] {
  return Object.keys(REGISTRY[role] ?? {});
}
