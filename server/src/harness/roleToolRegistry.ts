import type { Tool } from 'ai';
import { queryContract, queryOrders, crossCheck } from '../tools/queries.js';
import { linkDocument, createPayment } from '../tools/writes.js';
import { escalateToHuman, verifyDocumentFields } from '../tools/hitl.js';
import {
  buildIngestDocumentTool, buildExtractFieldsTool, buildBindDocumentTool,
} from '../pipeline/tools/documentEntry.js';
import type { DbContext } from '../pipeline/db/client.js';
import type { ExtractionDeps } from '../pipeline/extraction.js';

// MVP roles. Later phases add risk / finance / management with their own toolsets.
export type Role = 'trader';

// Runtime deps threaded through tool construction. The doc-entry tools (T8) need
// a DbContext to persist/loaded BlockModels; extract_fields additionally needs
// an injected LanguageModel (ExtractionDeps). Existing static tools ignore these.
export interface HarnessDeps {
  ctx: DbContext;
  extraction?: ExtractionDeps;
}

// A registry entry: the AI SDK 6 Tool plus the name it is addressed by at
// runtime. `needsApproval` is inherited from Tool (in v6 it may be a boolean OR
// an approval-deciding function); we only ever set the boolean form here.
export type GatedTool = Tool<any, any> & { name: string };

// role -> tool subset.
//
// Phase 3a: trader gets all 5 tools (3 L1 reads + 1 L2 write + 1 L3 write) so
// the permission gates can be exercised end-to-end. Real RBAC / role isolation
// is a later phase.
//
// T3/T4 add two more L1 tools (escalate_to_human, verify_document_fields) so
// the full HITL T1-T6 flow is backend-testable.
//
// T9: trader gains three doc-entry tools (ingest_document L1, extract_fields L1,
// bind_document L2). Their INSTANCES need a DbContext, so they are appended in
// getToolsForRole(deps) rather than declared statically here.
//
// NOTE on activeTools: in a later phase, a `prepareStep` hook will narrow
// `activeTools` per step based on the current role + parsed intent, so each step
// only sees the tools it is allowed to call. For now we hand the role its full
// toolset and let the model pick.
const BASE_TOOLS_FOR_ROLE: Record<Role, GatedTool[]> = {
  trader: [
    { ...queryContract, name: 'query_contract' },
    { ...queryOrders, name: 'query_orders' },
    { ...crossCheck, name: 'cross_check' },
    { ...linkDocument, name: 'link_document' },
    { ...createPayment, name: 'create_payment' },
    { ...escalateToHuman, name: 'escalate_to_human' },
    { ...verifyDocumentFields, name: 'verify_document_fields' },
  ],
};

// Doc-entry tool names are part of the trader's capability set even though
// constructing their instances requires a DbContext (see getToolsForRole).
const TRADER_DOC_ENTRY_NAMES = ['ingest_document', 'extract_fields', 'bind_document'] as const;

export function getToolsForRole(role: Role, deps?: HarnessDeps): GatedTool[] {
  const base: GatedTool[] = (BASE_TOOLS_FOR_ROLE[role] ?? []).map((t) => ({ ...t }));
  if (role === 'trader' && deps?.ctx) {
    const { ctx, extraction } = deps;
    base.push(
      { ...buildIngestDocumentTool({ ctx }), name: 'ingest_document' },
      { ...buildExtractFieldsTool({ ctx, extraction }), name: 'extract_fields' },
      // bind_document is L2: caller must attach human approval (needsApproval).
      { ...buildBindDocumentTool({ ctx }), name: 'bind_document', needsApproval: true },
    );
  }
  return base;
}

export function listToolNames(role: Role): string[] {
  const base = (BASE_TOOLS_FOR_ROLE[role] ?? []).map((t) => t.name);
  if (role === 'trader') {
    return [...base, ...TRADER_DOC_ENTRY_NAMES];
  }
  return base;
}
