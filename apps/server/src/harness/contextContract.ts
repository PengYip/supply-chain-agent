// Tool-Context Contract (工具-上下文契约).
//
// Declares, per tool, how its result interacts with the agent context window
// across the three interfaces defined in the integration architecture doc
// (VD3gdFCOlo61SyxXGBhcUUvvnUf §5):
//   (1) output  -> injection defense + source tagging on the tool->context edge
//   (2) budget  -> how much of the result enters the context (compression +
//                  recall k-value sizing for in-context residency)
//   (3) signal  -> what the status bar aggregates from this tool's calls
//   (4) persist -> where the tool's effect lives (recall routing target)
//   (5) risk    -> permission level + injection exposure
//
// This is a PARALLEL registry, intentionally NOT a field on AI SDK's tool().
// Keeping it separate means the harness reads contracts as a first-class concept
// without fighting the tool() API, and both the context layers (injection
// defense / compression / status bar -- upcoming tasks 2-5) and the tool layers
// share one declaration. Every tool registered in RoleToolRegistry must have an
// entry here; assertAllToolsContracted enforces that at the buildGatedTools
// choke point so a new tool can never silently ship without a contract.

/** output: how the tool result must be tagged as it enters the context. */
export type ContractOutput = 'raw' | 'tagged';

/** budget: how much of the result is allowed to enter the context. */
export type ContractBudget = 'full' | 'summary' | 'snippets' | 'verdict';

/** signal: how the status bar aggregates this tool's calls. */
export type ContractSignal = 'counter' | 'todo' | 'env' | 'none';

/** persist: where the tool's effect lives (recall routing target). */
export type ContractPersist = 'business' | 'vector' | 'graph' | 'session';

/** risk: permission level + whether the tool handles external content. */
export interface ContractRisk {
  level: 'L1' | 'L2' | 'L3';
  // injection: 'external' = the tool consumes uploaded/external documents or web
  // content. The defense layer applies heightened scrutiny even when output is
  // 'raw' (e.g. ingest_document returns only a docId handle but parsed an
  // untrusted file). 'safe' = the tool reads/writes internal trusted state only.
  injection: 'safe' | 'external';
}

/** The full per-tool contract. Read by both context layers and tool layers. */
export interface ToolContextContract {
  output: ContractOutput;
  budget: ContractBudget;
  signal: ContractSignal;
  persist: ContractPersist;
  risk: ContractRisk;
}

// The registry. Keep names EXACTLY in sync with the `name:` stamps in
// roleToolRegistry.ts (BASE_TOOLS_FOR_ROLE + the doc-entry appends).
//
// Rationale for notable assignments:
//  - ingest_document: output 'raw' (returns only {docId,blockCount,modality},
//    no external content leaks into the return) BUT injection 'external'
//    (it parsed an untrusted uploaded file). The injection layer still
//    sanitizes the ingest path; the return itself is a safe handle.
//  - extract_fields / verify_document_fields: output 'tagged' (their RETURN
//    VALUES are field/OCR strings derived from external documents, which may
//    carry prompt injection -> must be wrapped in <external_content>).
//  - escalate_to_human: signal 'todo' (it opens a pending human ticket).
//  - Reads (query_*, cross_check): signal 'counter'; writes that mutate
//    business state (link/bind, e.g. bind_document): signal 'env'.
export const TOOL_CONTEXT_CONTRACTS: Readonly<Record<string, ToolContextContract>> = {
  // 阶段2 工具合并(2026-08-28): 结构化 SSOT 统一读入口, 原 query_contract /
  // query_execution_flows / query_quota_usage / project_rollup / template_overview
  // 五合一。全部为只读台账/物化数据(数值与短字符串, 无文档原文) -> output 'raw' /
  // injection 'safe'。子查询输出形态不一(枚举列表/汇总/模板层级), 取最宽松
  // budget 'full' 以免截掉枚举结果(与原 query_contract/quota/template 一致)。
  // signal 'counter'(读)。persist 'business' 标记它读取的业务存储。
  query_business: {
    output: 'raw', budget: 'full', signal: 'counter',
    persist: 'business', risk: { level: 'L1', injection: 'safe' },
  },
  query_orders: {
    output: 'raw', budget: 'summary', signal: 'counter',
    persist: 'business', risk: { level: 'L1', injection: 'safe' },
  },
  cross_check: {
    output: 'raw', budget: 'full', signal: 'counter',
    persist: 'business', risk: { level: 'L1', injection: 'safe' },
  },
  escalate_to_human: {
    output: 'raw', budget: 'full', signal: 'todo',
    persist: 'session', risk: { level: 'L1', injection: 'safe' },
  },
  verify_document_fields: {
    output: 'tagged', budget: 'summary', signal: 'counter',
    persist: 'session', risk: { level: 'L1', injection: 'external' },
  },
  ingest_document: {
    output: 'raw', budget: 'full', signal: 'todo',
    persist: 'business', risk: { level: 'L1', injection: 'external' },
  },
  extract_fields: {
    output: 'tagged', budget: 'summary', signal: 'todo',
    persist: 'business', risk: { level: 'L1', injection: 'external' },
  },
  inspect_extraction: {
    // On-demand drill-down for ONE already-extracted field. Returns the field
    // value + recomputed citedText (both document-derived strings) wrapped via
    // tagExternal -> output 'tagged' / injection 'external'. Bounded to a single
    // field -> budget 'summary'. Read-only lookup -> risk L1. Backed by the
    // persisted extraction row (business data) -> persist 'business'.
    output: 'tagged', budget: 'summary', signal: 'counter',
    persist: 'business', risk: { level: 'L1', injection: 'external' },
  },
  bind_document: {
    output: 'raw', budget: 'full', signal: 'env',
    persist: 'business', risk: { level: 'L2', injection: 'safe' },
  },
  // 阶段2b: tag_document 并入 update_document_fields(标签来源 explicit),
  // 后者契约不变(L2 写, output 'raw' / injection 'safe')。
  // Graph layer (§7): create/link/query entities in Neo4j. Agent-supplied open
  // kind/name/props are trusted input (no document-derived text returned), so
  // output 'raw' / injection 'safe'. Returns short handles/summaries -> budget
  // 'full'. Mutates/persists to the graph store -> signal 'env', persist 'graph'
  // (the new recall target). All L2 soft-gate writes.
  create_entity: {
    output: 'raw', budget: 'full', signal: 'env',
    persist: 'graph', risk: { level: 'L2', injection: 'safe' },
  },
  link_entities: {
    output: 'raw', budget: 'full', signal: 'env',
    persist: 'graph', risk: { level: 'L2', injection: 'safe' },
  },
  // 阶段2b(2026-08-28): link_documents 三合一(GraphLinkKind correlates/relates/
  // amends, 原 link_contracts/link_projects/link_amends)。Agent 传入的合同号/
  // 项目码/docId/份额为可信输入(与 link_entities 同源), 返回短 handle ->
  // output 'raw' / injection 'safe'。落 graph_links SSOT + 图边投影 ->
  // signal 'env', persist 'business'(SSOT 在关系库, 图只是投影)。L2 软门控。
  link_documents: {
    output: 'raw', budget: 'full', signal: 'env',
    persist: 'business', risk: { level: 'L2', injection: 'safe' },
  },
  // 2026-08-28 P4: 模板维护 manage_template(新增类型/改词表/软禁用激活)。
  // Agent 传入类型名/id 与词表为可信输入, 全部转调 templateManage 落三表 SSOT +
  // 版本审计 -> persist 'business', output 'raw' / injection 'safe'。L2 软门控。
  manage_template: {
    output: 'raw', budget: 'full', signal: 'env',
    persist: 'business', risk: { level: 'L2', injection: 'safe' },
  },
  // 2026-08-25 方案A §6: 两层额度管控。manage_quota 落 quotas SSOT + granted
  // 投影 + 即时占用重算 -> persist 'business'。占用查询并入 query_business。
  // 金额/限额为可信数值输入。
  manage_quota: {
    output: 'raw', budget: 'full', signal: 'env',
    persist: 'business', risk: { level: 'L2', injection: 'safe' },
  },
  graph_query: {
    output: 'raw', budget: 'full', signal: 'env',
    persist: 'graph', risk: { level: 'L1', injection: 'safe' },
  },
  graph_find_entity: {
    // Read-only kind+name lookup. Returns graph-stored names/ids (trusted
    // agent graph data, no document text) -> output 'raw' / injection 'safe'.
    // Short bounded lists -> budget 'summary'. signal 'counter' (a read).
    // persist 'graph' marks the store it reads.
    output: 'raw', budget: 'summary', signal: 'counter',
    persist: 'graph', risk: { level: 'L1', injection: 'safe' },
  },
  recall_documents: {
    // Returns BM25 snippets of ingested document text -> external content, so
    // output is 'tagged' (injectionDefense wraps each snippet, like extract_fields).
    // budget 'snippets': recall output is a matches array with NO key fields, so
    // the 'summary' tier would drop the entire matches array (model saw only
    // {contractNo, _summarized: true} and could not answer). 'snippets' keeps the
    // first 10 matches' document_id/chunk_index/snippet(<=500)/source so the model
    // can actually read the retrieved content. signal 'counter' (a read).
    // fullText mode (2026-08-28 spec): short docs additionally carry
    // mode/documents[]/degradedDocIds -- compressSnippetsOutput preserves those
    // (the per-document texts are the evidence, bounded <=16K chars upstream).
    // persist 'vector' is CONCEPTUAL here: v1 stores the index in FTS5 (not
    // pgvector/sqlite-vec); the field marks the recall layer's logical target for
    // when the vector path lands.
    output: 'tagged', budget: 'snippets', signal: 'counter',
    persist: 'vector', risk: { level: 'L1', injection: 'external' },
  },
  execute_code: {
    // Executes arbitrary Python in an isolated sandbox. stdout/stderr/results
    // may contain arbitrary text (user code can print anything, including
    // prompt-injection payloads) -> output 'tagged'. budget 'summary': code
    // output can be large (e.g. printing a big dataframe) and benefits from
    // compression. signal 'counter' (a read-like computation). persist 'session'
    // (ephemeral: no business state is mutated). risk L1 (auto-execute: the
    // sandbox is isolated, no real-world side effects) but injection 'external'
    // (user-supplied code runs inside).
    output: 'tagged', budget: 'summary', signal: 'counter',
    persist: 'session', risk: { level: 'L1', injection: 'external' },
  },
  present_document_review: {
    output: 'tagged', budget: 'summary', signal: 'none',
    persist: 'business', risk: { level: 'L1', injection: 'external' },
  },
  update_document_fields: {
    output: 'raw', budget: 'full', signal: 'none',
    persist: 'business', risk: { level: 'L2', injection: 'safe' },
  },
  list_binding_proposals: {
    // Phase B: 待确认的凭证-合同绑定建议(只读)。返回系统生成的 contractNo/score/
    // evidence(details 为人类可读的中文说明, 无文档原文) -> output 'raw' /
    // injection 'safe'。条数有界 -> budget 'summary'。signal 'counter'(读)。
    output: 'raw', budget: 'summary', signal: 'counter',
    persist: 'business', risk: { level: 'L1', injection: 'safe' },
  },
  // 2026-08-27 §15 结算引擎: gather_settlement_evidence 返回台账字段与化验/
  // 凭证抽取字段(文档原文回流, 可能携带注入话术) -> output 'tagged' /
  // injection 'external'。单合同证据有界 -> budget 'summary'。只读 -> L1,
  // signal 'counter', persist 'business'。
  gather_settlement_evidence: {
    output: 'tagged', budget: 'summary', signal: 'counter',
    persist: 'business', risk: { level: 'L1', injection: 'external' },
  },
  // confirm_settlement 是结算落台账的唯一写面(L2 软门控, 人工确认通道)。
  // 输入为模型已向用户展示并被确认的数值(可信输入), 返回短 handle ->
  // output 'raw' / injection 'safe'。落 settlement_records -> signal 'env',
  // persist 'business'。
  confirm_settlement: {
    output: 'raw', budget: 'full', signal: 'env',
    persist: 'business', risk: { level: 'L2', injection: 'safe' },
  },
};

/** True iff a contract exists for the given tool name. */
export function hasContract(toolName: string): boolean {
  return toolName in TOOL_CONTEXT_CONTRACTS;
}

/**
 * Look up a tool's contract. Throws if none is registered -- the contract is
 * mandatory, so a missing entry is a programming error, not a fallback case.
 */
export function getContract(toolName: string): ToolContextContract {
  const contract = TOOL_CONTEXT_CONTRACTS[toolName];
  if (!contract) {
    throw new Error(
      `contextContract: no contract registered for tool "${toolName}". ` +
        'Every tool in RoleToolRegistry must declare a contract in contextContract.ts.',
    );
  }
  return contract;
}

/**
 * Startup consistency guard: every tool name a role exposes must have a
 * declared contract. Called at the buildGatedTools choke point so a tool can
 * never go live for the model without a contract. Throws listing the offenders.
 */
export function assertAllToolsContracted(toolNames: readonly string[]): void {
  const missing = toolNames.filter((n) => !hasContract(n));
  if (missing.length > 0) {
    throw new Error(
      'contextContract: tools missing contracts: ' +
        `${missing.join(', ')}. ` +
        'Add entries to TOOL_CONTEXT_CONTRACTS in contextContract.ts.',
    );
  }
}

/**
 * Names of all tools whose return value may carry external/untrusted content
 * (output 'tagged'). Consumed by the injection-defense layer (integration
 * point 1). Returns a readonly snapshot.
 */
export function getTaggedOutputTools(): readonly string[] {
  return Object.entries(TOOL_CONTEXT_CONTRACTS)
    .filter(([, c]) => c.output === 'tagged')
    .map(([name]) => name);
}

/**
 * Names of all tools that handle external content (risk.injection 'external'),
 * regardless of whether their return is tagged. Consumed by the injection
 * defense's input-sanitization layer (file-path / content scrutiny).
 */
export function getExternalHandlingTools(): readonly string[] {
  return Object.entries(TOOL_CONTEXT_CONTRACTS)
    .filter(([, c]) => c.risk.injection === 'external')
    .map(([name]) => name);
}
