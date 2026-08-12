import type { Tool } from 'ai';
import { queryContract, queryOrders, crossCheck } from '../tools/queries.js';
import { linkDocument, createPayment } from '../tools/writes.js';
import { escalateToHuman, verifyDocumentFields } from '../tools/hitl.js';
import {
  buildIngestDocumentTool, buildExtractFieldsTool, buildBindDocumentTool, buildInspectExtractionTool,
  buildTagDocumentTool,
} from '../pipeline/tools/documentEntry.js';
import { buildRecallDocumentsTool } from '../pipeline/tools/recall.js';
import { buildExecuteCodeTool } from '../pipeline/tools/executeCode.js';
import type { DbContext } from '../pipeline/db/client.js';
import type { ExtractionDeps } from '../pipeline/extraction.js';
import type { ClassifierDeps } from '../pipeline/classifier.js';
import type { Embedder } from '../pipeline/embedder.js';
import { env } from '../env.js';

// MVP roles. Later phases add risk / finance / management with their own toolsets.
export type Role = 'trader';

// Runtime deps threaded through tool construction. The doc-entry tools (T8) need
// a DbContext to persist/loaded BlockModels; extract_fields additionally needs
// an injected LanguageModel (ExtractionDeps); ingest_document + recall_documents
// optionally take an Embedder for the L4 vector recall index (Task 6 v2).
// Existing static tools ignore these.
export interface HarnessDeps {
  ctx: DbContext;
  extraction?: ExtractionDeps;
  /** Phase 2 routing-classify stage. Unset -> ingest degrades to the hint docType. */
  classifier?: ClassifierDeps;
  embedder?: Embedder;
  /** Phase 2 business-data isolation: stamp + filter doc/extraction/binding/chunk
   *  rows by this user. Empty/undefined = unscoped (legacy/tests; no filtering). */
  userId?: string;
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

// Doc-entry + recall tool names are part of the trader's capability set even
// though constructing their instances requires a DbContext (see getToolsForRole).
const TRADER_CTX_TOOL_NAMES = ['ingest_document', 'extract_fields', 'bind_document', 'recall_documents', 'execute_code', 'inspect_extraction', 'tag_document'] as const;

export function getToolsForRole(role: Role, deps?: HarnessDeps): GatedTool[] {
  const base: GatedTool[] = (BASE_TOOLS_FOR_ROLE[role] ?? []).map((t) => ({ ...t }));
  if (role === 'trader' && deps?.ctx) {
    const { ctx, extraction, embedder, classifier, userId } = deps;
    base.push(
      { ...buildIngestDocumentTool({ ctx, embedder, classifier, userId }), name: 'ingest_document' },
      { ...buildExtractFieldsTool({ ctx, extraction, userId }), name: 'extract_fields' },
      // bind_document is L2: caller must attach human approval (needsApproval).
      { ...buildBindDocumentTool({ ctx, userId }), name: 'bind_document', needsApproval: true },
      // inspect_extraction is L1: on-demand evidence drill-down for a single
      // already-extracted field (citedText recomputed from persisted spans).
      { ...buildInspectExtractionTool({ ctx, userId }), name: 'inspect_extraction' },
      // tag_document is L2: explicit user/agent labels, post-ingest, any time.
      // needsApproval = soft gate (v6): the agent must have user consent to label.
      { ...buildTagDocumentTool({ ctx, userId }), name: 'tag_document', needsApproval: true },
      // recall_documents is L1: FTS5/vector/hybrid recall over ingested chunks.
      { ...buildRecallDocumentsTool({ ctx, embedder, userId }), name: 'recall_documents' },
      // execute_code is L1: run Python in an isolated CubeSandbox microVM.
      {
        ...buildExecuteCodeTool({
          cubeApiUrl: env.CUBE_API_URL,
          sandboxDomain: env.CUBE_SANDBOX_DOMAIN,
          templateAlias: env.CUBE_TEMPLATE_ALIAS,
        }),
        name: 'execute_code',
      },
    );
  }
  return base;
}

export function listToolNames(role: Role): string[] {
  const base = (BASE_TOOLS_FOR_ROLE[role] ?? []).map((t) => t.name);
  if (role === 'trader') {
    return [...base, ...TRADER_CTX_TOOL_NAMES];
  }
  return base;
}
