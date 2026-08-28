import type { Tool } from 'ai';
import { buildQueryContractTool, buildProjectRollupTool, queryOrders, crossCheck } from '../tools/queries.js';
import { escalateToHuman, verifyDocumentFields } from '../tools/hitl.js';
import {
  buildIngestDocumentTool, buildExtractFieldsTool, buildBindDocumentTool, buildInspectExtractionTool,
  buildTagDocumentTool, buildPresentDocumentReviewTool, buildUpdateDocumentFieldsTool,
  buildListBindingProposalsTool,
} from '../pipeline/tools/documentEntry.js';
import { buildQueryExecutionFlowsTool } from '../pipeline/executionFlow.js';
import { buildRecallDocumentsTool } from '../pipeline/tools/recall.js';
import { buildExecuteCodeTool } from '../pipeline/tools/executeCode.js';
import { buildCreateEntityTool, buildLinkEntitiesTool, buildGraphQueryTool, buildGraphFindEntityTool } from '../graph/tools.js';
import { buildLinkContractsTool, buildLinkProjectsTool, buildLinkAmendsTool } from '../pipeline/tools/graphLinkTools.js';
import { buildTemplateOverviewTool } from '../pipeline/tools/templateOverviewTool.js';
import { buildManageTemplateTool } from '../pipeline/tools/manageTemplateTool.js';
import { buildManageQuotaTool, buildQueryQuotaUsageTool } from '../pipeline/tools/quotaTools.js';
import { buildGatherSettlementEvidenceTool, buildConfirmSettlementTool } from '../pipeline/tools/settlementTools.js';
import type { DbContext } from '../pipeline/db/client.js';
import type { ExtractionDeps } from '../pipeline/extraction.js';
import type { ClassifierDeps } from '../pipeline/classifier.js';
import type { Embedder } from '../pipeline/embedder.js';
import type { ChunkTagger } from '../pipeline/chunkTagging.js';
import type { Reranker } from '../pipeline/reranker.js';
import { defaultReranker } from '../pipeline/reranker.js';
import { env } from '../env.js';

// MVP roles. Later phases add risk / finance / management with their own toolsets.
export type Role = 'trader';

/**
 * CubeSandbox is a deployment concern (tool-inventory methodology, 2026-08-28):
 * mount execute_code only on deployments that explicitly opt in via
 * CUBE_SANDBOX_ENABLED=true. Read straight off process.env (not the zod env
 * contract) so tests / air-gapped hosts default to the safe minimal toolset --
 * same direct-env pattern as defaultEmbedder(). Unset -> the tool is ABSENT
 * from the list, not a runtime error the model has to stumble into.
 */
export function isCubeSandboxEnabled(e: NodeJS.ProcessEnv = process.env): boolean {
  return e.CUBE_SANDBOX_ENABLED === 'true';
}

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
  /** Optional recall precision stage (bge-reranker via SiliconFlow). Unset ->
   *  registry builds one from env when SILICONFLOW_API_KEY is present. */
  reranker?: Reranker | null;
  /** Lane B: per-chunk semantic tagger for ingest. Unset -> chunks stored untagged. */
  tagger?: ChunkTagger;
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
// Trader's static BASE set is 4 tools (2 L1 reads: query_orders / cross_check +
// 2 L1 HITL/doc tools: escalate_to_human / verify_document_fields). All L2
// writes (bind_document / tag_document / create_entity / ...) are the
// DbContext-dependent builders appended in getToolsForRole(deps) below.
//
// T9: trader gains three doc-entry tools (ingest_document L1, extract_fields L1,
// bind_document L2). Their INSTANCES need a DbContext, so they are appended in
// getToolsForRole(deps) rather than declared statically here.
//
// NOTE on activeTools: in a later phase, a `prepareStep` hook will narrow
// `activeTools` per step based on the current role + parsed intent, so each step
// only sees the tools it is allowed to call. For now we hand the role its full
// toolset and let the model pick.
//
// 接线闭环: query_contract 已从静态 BASE 表移除 -- 它是台账优先的 builder
// (buildQueryContractTool), 需要可选 DbContext, 所以在 getToolsForRole 中对
// trader 无条件 push(无 ctx 时降级为纯 seed 行为)。
const BASE_TOOLS_FOR_ROLE: Record<Role, GatedTool[]> = {
  trader: [
    { ...queryOrders, name: 'query_orders' },
    { ...crossCheck, name: 'cross_check' },
    { ...escalateToHuman, name: 'escalate_to_human' },
    { ...verifyDocumentFields, name: 'verify_document_fields' },
  ],
};

// Doc-entry + recall tool names are part of the trader's capability set even
// though constructing their instances requires a DbContext (see getToolsForRole).
// query_contract is listed here too: after the BASE removal above its name would
// otherwise drop out of listToolNames (it is still always registered for trader).
const TRADER_CTX_TOOL_NAMES = ['query_contract', 'ingest_document', 'extract_fields', 'bind_document', 'recall_documents', 'execute_code', 'inspect_extraction', 'tag_document', 'create_entity', 'link_entities', 'graph_query', 'graph_find_entity', 'present_document_review', 'update_document_fields', 'list_binding_proposals', 'query_execution_flows', 'project_rollup', 'link_contracts', 'link_projects', 'link_amends', 'template_overview', 'manage_template', 'manage_quota', 'query_quota_usage', 'gather_settlement_evidence', 'confirm_settlement'] as const;

export function getToolsForRole(role: Role, deps?: HarnessDeps): GatedTool[] {
  const base: GatedTool[] = (BASE_TOOLS_FOR_ROLE[role] ?? []).map((t) => ({ ...t }));
  if (role === 'trader') {
    const { userId } = deps ?? {};
    // query_contract 无条件注册(台账优先; deps.ctx 缺省时降级纯 seed)。
    base.push({ ...buildQueryContractTool({ ctx: deps?.ctx, userId }), name: 'query_contract' });
    // project_rollup 同款无条件注册(L1 只读; 无 ctx 时 execute 返回 notConfigured)。
    base.push({ ...buildProjectRollupTool({ ctx: deps?.ctx, userId }), name: 'project_rollup' });
    if (deps?.ctx) {
      const { ctx, extraction, embedder, classifier, tagger, userId } = deps;
      const reranker = deps.reranker !== undefined ? deps.reranker : defaultReranker();
      base.push(
        { ...buildIngestDocumentTool({ ctx, embedder, classifier, extraction, tagger, userId }), name: 'ingest_document' },
        { ...buildExtractFieldsTool({ ctx, extraction, userId }), name: 'extract_fields' },
        // present_document_review is L1: read-only 5-dim review card (业务类型/字段/关系/TAG/向量化).
        { ...buildPresentDocumentReviewTool({ ctx, userId }), name: 'present_document_review' },
        // update_document_fields is L2: apply user field corrections (needs user consent).
        { ...buildUpdateDocumentFieldsTool({ ctx, userId }), name: 'update_document_fields', needsApproval: true },
        // list_binding_proposals is L1 (Phase B): 查看待确认的凭证-合同绑定建议。
        { ...buildListBindingProposalsTool({ ctx, userId }), name: 'list_binding_proposals' },
        // query_execution_flows is L1: 只读查询某合同的执行流水六向汇总与逐笔明细。
        { ...buildQueryExecutionFlowsTool({ ctx, userId }), name: 'query_execution_flows' },
        // bind_document is L2: caller must attach human approval (needsApproval).
        { ...buildBindDocumentTool({ ctx, userId }), name: 'bind_document', needsApproval: true },
        // inspect_extraction is L1: on-demand evidence drill-down for a single
        // already-extracted field (citedText recomputed from persisted spans).
        { ...buildInspectExtractionTool({ ctx, userId }), name: 'inspect_extraction' },
        // tag_document is L2: explicit user/agent labels, post-ingest, any time.
        // needsApproval = soft gate (v6): the agent must have user consent to label.
        { ...buildTagDocumentTool({ ctx, userId }), name: 'tag_document', needsApproval: true },
        // Graph layer (§7): create/link entities in Neo4j are L2 (mutate
        // graph state / soft gate). Builders take no deps (use getDriver() directly).
        { ...buildCreateEntityTool(), name: 'create_entity', needsApproval: true },
        { ...buildLinkEntitiesTool(), name: 'link_entities', needsApproval: true },
        // graph_query is L1: read-only graph traversal (READ session, no writes).
        { ...buildGraphQueryTool(), name: 'graph_query' },
        // graph_find_entity is L1: read-only name lookup —— graph_query 缺的
        // "按名称找实体"入口（用户说名称，不说 elementId）。
        { ...buildGraphFindEntityTool(), name: 'graph_find_entity' },
        // link_contracts / link_projects are L2 (2026-08-25 方案A §6):
        // 背靠背购销对应(correlates)与项目级关联(relates), 落 graph_links
        // SSOT + best-effort 边投影, 与 bind_document 同款软门控。
        { ...buildLinkContractsTool({ ctx, userId }), name: 'link_contracts', needsApproval: true },
        { ...buildLinkProjectsTool({ ctx, userId }), name: 'link_projects', needsApproval: true },
        // link_amends is L2 (2026-08-26 模板): 补充合同修订关系(amends), 落
        // graph_links SSOT + best-effort 边投影, 与 link_contracts 同款软门控。
        { ...buildLinkAmendsTool({ ctx, userId }), name: 'link_amends', needsApproval: true },
        // manage_template is L2 (2026-08-28 P4): 模板维护唯一写入面(新增类型/
        // 改词表/软禁用激活), 转 templateManage 与管理 REST 共享业务规则, 软门控。
        { ...buildManageTemplateTool({ ctx, userId }), name: 'manage_template', needsApproval: true },
        // template_overview is L1 (2026-08-26 模板): 类型层级/允许挂接合同类型与词表。
        { ...buildTemplateOverviewTool({ ctx, userId }), name: 'template_overview' },
        // manage_quota is L2 (2026-08-25 方案A §6): 两层额度创建/调整/停用,
        // 落 quotas SSOT + granted 投影 + 即时占用重算, 软门控。
        { ...buildManageQuotaTool({ ctx, userId }), name: 'manage_quota', needsApproval: true },
        // query_quota_usage is L1: 只读额度占用(读对账桥物化结果)。
        { ...buildQueryQuotaUsageTool({ ctx, userId }), name: 'query_quota_usage' },
        // gather_settlement_evidence is L1 (2026-08-27 §15): 结算取证(合同条款+
        // 数量流水+质量凭证+历史结算), 计算前的必经步骤。
        { ...buildGatherSettlementEvidenceTool({ ctx, userId }), name: 'gather_settlement_evidence' },
        // confirm_settlement is L2 (2026-08-27 §15): 结算结果人工确认后落
        // settlement_records 台账(金额锚点), 软门控。
        { ...buildConfirmSettlementTool({ ctx, userId }), name: 'confirm_settlement', needsApproval: true },
        // recall_documents is L1: FTS5/vector/hybrid recall over ingested chunks
        // (+ optional bge-reranker precision stage from env).
        { ...buildRecallDocumentsTool({ ctx, embedder, reranker, userId }), name: 'recall_documents' },
      );
      // execute_code is L1: run Python in an isolated CubeSandbox microVM.
      // Env-gated: absent from the toolset unless the deployment opted in
      // (isCubeSandboxEnabled). See docs/tool-inventory.json.
      if (isCubeSandboxEnabled()) {
        base.push({
          ...buildExecuteCodeTool({
            cubeApiUrl: env.CUBE_API_URL,
            sandboxDomain: env.CUBE_SANDBOX_DOMAIN,
            templateAlias: env.CUBE_TEMPLATE_ALIAS,
          }),
          name: 'execute_code',
        });
      }
    }
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
