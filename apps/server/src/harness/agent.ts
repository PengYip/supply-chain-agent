import { streamText, stepCountIs, type Tool, type ModelMessage, type LanguageModel } from 'ai';
import { createDeepSeek } from '@ai-sdk/deepseek';
import { env } from '../env.js';
import { getToolsForRole, type Role, type HarnessDeps } from './roleToolRegistry.js';
import { getPermission } from './permissionGate.js';
import { recordPendingApproval, countPendingApprovals } from './sessionStore.js';
import { auditRecorder, type ToolCallRecord } from './auditRecorder.js';
import { assertAllToolsContracted } from './contextContract.js';
import {
  compressByBudget,
  createFailureTracker,
  makeCircuitBreaker,
} from './compression.js';
import { appendStatusMessage, type AgentStatusSnapshot } from './agentStatus.js';
import { getToolCallCounts } from './statusAggregator.js';
import { countDocuments, countExtractionsNeedingReview } from '../pipeline/db/repositories.js';
import { DeterministicEmbedder, OllamaEmbedder, type Embedder } from '../pipeline/embedder.js';
import { type DbContext } from '../pipeline/db/client.js';
import { getDbContext } from '../pipeline/db/dbBackend.js';

// Shared agent configuration so /api/chat and /api/approval/callback run the
// exact same model + tools + system prompt + telemetry on a resume.

export const SYSTEM_PROMPT = [
  '你是供应链贸易执行助理（业务/贸易员视角），服务大宗商品贸易的合同履约与对账场景。',
  '护栏（必须严格遵守）：',
  '1. 所有业务数字（金额、数量、状态、差异等）必须来自工具调用结果，不得自行编造或凭记忆推断。',
  '2. 如果工具未返回数据或返回 notFound=true，必须明确告知用户"数据不可得/未找到该记录"，不得编造。',
  '3. 不要猜测合同号、订单号、发票号；如用户描述模糊，先用工具按已知字段查询。',
  '4. 你可以多次调用工具综合回答；回答时简要引用工具返回的关键数字与对象。',
  '5. 写操作（如挂接单据 link_document、发起付款 create_payment）需要用户确认或外部审批。',
  '   - 若工具被请求确认（tool-approval-request），必须如实告知用户"该操作需要你确认后才会执行"，不得谎称已执行。',
  '   - 若工具返回 ok=false / status=blocked，必须如实转达未执行的原因（如需财务主管外部审批/飞书审批流），不得谎称已执行。',
  '6. 付款/退款/合同变更属于资金或不可逆操作，禁止声称已完成，必须提示走外部审批流。',
  '7. 若用户消息指示某付款票据已审批通过，并要求用 create_payment 传入 authorizedTicketId 续跑，请按指示调用 create_payment 并带上 authorizedTicketId 完成付款。',
  '8. 不确定回退：当遇到数据冲突、置信度低、数据缺失、或业务规则边界等无法确定的情况，必须调用 escalate_to_human 工具转人工，生成工单号 ESC-xxx，不得自行编造或猜测。需明确告知用户已生成工单号。',
  '9. 单据字段核验：涉及提单/发票等单据的字段核验时调用 verify_document_fields；对返回 needsReview=true 的字段，必须如实告知用户"OCR 置信度低，建议人工复核"，不得自行决定该字段值。',
  '- 单据录入闭环: 用户上传原始单据后, 先调 ingest_document 解析为 BlockModel, 再调 extract_fields 抽取业务字段。',
  '- 数字零幻觉(硬约束): extract_fields 返回的每个值都已与原文 span 比对。任何 strength=none 或置信度低于复核阈值的字段必须如实告知用户, 不得编造; 关键字段(合同号/金额/发票号/价税合计)未达自动接受阈值时, 主动建议人工复核或调 escalate_to_human。',
  '- 业务绑定需授权: bind_document 为 L2 操作, 需要人工确认后方可执行。',
].join('\n');

// Apply the PermissionGate to the role's toolset:
//   L1 -> auto execute
//   L2 -> v6 `needsApproval: true` (soft gate)
//   L3 -> no soft gate here; the tool's execute self-blocks (returns blocked)
//
// T9: doc-entry tools (ingest/extract/bind) are appended by getToolsForRole when
// a DbContext is supplied via deps. bind_document carries needsApproval (L2).
//
// H4: centralized audit wrapper. Every tool's execute is wrapped here -- the
// single choke point through which all tools (existing 7 + 3 doc-entry) flow --
// so each call emits a uniform auditRecorder record. The per-tool recordCall
// helpers that previously lived in tools/{queries,writes,hitl}.ts were removed
// to avoid double-recording. The wrapper is transparent: same input/output/
// errors (it records on success right before returning, matching the prior
// per-tool semantics; on throw the error propagates and no record is emitted,
// exactly as before).
function withAudit(name: string, execute: Tool['execute']): Tool['execute'] {
  if (!execute) return execute;
  return async (input: any, options: any) => {
    const start = Date.now();
    const result = await execute(input, options);
    auditRecorder.recordToolCall({ toolName: name, args: input, result, durationMs: Date.now() - start });
    return result;
  };
}

export function buildGatedTools(role: Role, deps?: HarnessDeps): Record<string, Tool> {
  const list = getToolsForRole(role, deps);
  // Contract guard: no tool may go live for the model without a declared
  // tool-context contract. Fail fast (first turn) if a new tool is added to
  // RoleToolRegistry without an entry in TOOL_CONTEXT_CONTRACTS.
  assertAllToolsContracted(list.map((t) => t.name));
  const gated: Record<string, Tool> = {};
  for (const t of list) {
    const name = t.name;
    const audited: Tool = { ...t, execute: withAudit(name, t.execute) };
    // L2 via the permission gate (source of truth) OR a literal boolean
    // needsApproval stamped at registration (e.g. bind_document). `=== true`
    // avoids matching Tool's needsApproval-function form.
    if (getPermission(name) === 'L2' || t.needsApproval === true) {
      gated[name] = { ...audited, needsApproval: true };
    } else {
      gated[name] = audited;
    }
  }
  return gated;
}

// Process-wide DbContext for the doc-entry pipeline tools. Created once (lazy)
// via getDbContext (which selects SQLite by default, or Postgres when
// DB_BACKEND=postgres). SQLite is fully initialized here (migrate + sqlite-vec);
// Postgres is migrated out-of-band via drizzle-kit. File-backed SQLite so doc-entry
// persistence survives restart (gitignored at server/pipeline.db*).
let harnessCtx: DbContext | null = null;
function getHarnessDbContext(): DbContext {
  if (!harnessCtx) {
    harnessCtx = getDbContext();
  }
  return harnessCtx;
}

/**
 * Default embedder for production. Real bge-m3 via Ollama when OLLAMA_BASE_URL is
 * configured; otherwise the deterministic test embedder (offline, no model pull).
 * Tests bypass this by injecting their own embedder via RunStreamOpts.deps.
 */
function defaultEmbedder(): Embedder {
  if (env.OLLAMA_BASE_URL) {
    return new OllamaEmbedder({ baseUrl: env.OLLAMA_BASE_URL, model: env.OLLAMA_EMBED_MODEL });
  }
  return new DeterministicEmbedder();
}

export interface RunStreamOpts {
  messages: ModelMessage[];
  role: Role;
  auditTraceId: string;
  /**
   * Optional injected language model (testability seam). When omitted, runStream
   * constructs the real DeepSeek model via deepseek.chat(env.OPENAI_MODEL) exactly
   * as before -- production behavior is unchanged.
   */
  model?: LanguageModel;
  /**
   * Optional injected harness deps (testability seam). When omitted, runStream
   * uses the process-wide harness DbContext + the resolved model -- production
   * behavior is unchanged. When `model` is injected, no provider client is built.
   */
  deps?: HarnessDeps;
  /**
   * Phase 2 business-data isolation: owning user for documents / extractions /
   * bindings / chunks touched by the doc-entry tools this turn. Empty/undefined
   * = unscoped (legacy/tests; no filtering).
   */
  userId?: string;
  /**
   * Phase 3 status bar: when set, a model-facing <agent_status> user-role
   * message is appended at the trajectory tail for this turn (never persisted;
   * only the real conversation is, via appendMessages). Unset = no status
   * injection (tests that don't need it).
   */
  sessionId?: string;
}

// Scan a turn's response messages for v6 tool-approval-request parts (emitted
// when an L2 `needsApproval` tool is called) and persist each as a pending L2
// approval so the external /api/approval/callback can later resume it.
//
// Field-availability gotcha (AI SDK 6): in response.messages the
// tool-approval-request part only carries { approvalId, toolCallId } -- it has
// NO `toolCall` object, so the toolName/input must be recovered from the
// sibling `tool-call` part in the SAME assistant message (matched by
// toolCallId). The OUTPUT part in result.content does carry toolCall, but
// response.messages does not.
export function recordL2PendingFromResponse(
  sessionId: string,
  messages: ModelMessage[],
): void {
  for (const msg of messages) {
    if (msg.role !== 'assistant') continue;
    const content = msg.content;
    if (!Array.isArray(content)) continue;
    const parts = content as Array<{ type?: string; [k: string]: unknown }>;

    // Index tool-call parts by toolCallId -> { toolName, input }.
    const toolCallInfo = new Map<string, { toolName: string; input: unknown }>();
    for (const p of parts) {
      if (p?.type !== 'tool-call') continue;
      const id = p.toolCallId as string | undefined;
      if (!id) continue;
      toolCallInfo.set(id, {
        toolName: (p.toolName as string | undefined) ?? 'unknown',
        input: p.input,
      });
    }

    for (const part of parts) {
      if (part?.type !== 'tool-approval-request') continue;
      const approvalId = (part.approvalId as string | undefined) ?? null;
      const toolCallId = (part.toolCallId as string | undefined) ?? approvalId;
      if (!approvalId || !toolCallId) continue;
      const info = toolCallInfo.get(toolCallId);
      const toolName = info?.toolName ?? 'unknown';
      if (getPermission(toolName) !== 'L2') continue;
      recordPendingApproval({
        sessionId,
        level: 'L2',
        toolName,
        toolCallId,
        approvalId,
        input: info?.input ?? {},
      });
    }
  }
}

export interface BuildAgentStatusSnapshotOpts {
  sessionId: string;
  userId?: string;
  ctx: DbContext;
  recorder?: { records: ToolCallRecord[] };
}

/**
 * Assemble the model-facing status snapshot (design §9.2) from existing harness
 * sources: per-tool counts (auditRecorder), pending approvals (sessionStore),
 * and DB progress counts (repositories). Sync because better-sqlite3 is sync.
 * `recorder` defaults to the process-wide singleton; tests pass a local one for
 * deterministic isolation.
 */
export function buildAgentStatusSnapshot({
  sessionId,
  userId,
  ctx,
  recorder = auditRecorder,
}: BuildAgentStatusSnapshotOpts): AgentStatusSnapshot {
  const toolCounts = getToolCallCounts(sessionId, recorder);
  const totalCalls = toolCounts.reduce((sum, t) => sum + t.count, 0);
  return {
    toolCounts,
    totalCalls,
    pendingApprovals: countPendingApprovals(sessionId),
    docsIngested: countDocuments(ctx, userId),
    extractionsPendingReview: countExtractionsNeedingReview(ctx, userId),
  };
}

// Create the streamText result for one agent turn. Caller is responsible for
// session persistence and for returning result.toUIMessageStreamResponse().
//
// Testability seam (H1): `model` and `deps` are optional. When omitted, runStream
// uses the real DeepSeek model + the process-wide harness DbContext -- identical
// to pre-H1 behavior. When supplied (tests), no provider client is constructed and
// no network/env is required, so the agent loop can be exercised offline against
// a canned fake model + in-memory DbContext.
export function runStream({ messages, role, auditTraceId, model, deps, userId, sessionId }: RunStreamOpts) {
  // Production default: real DeepSeek model. If a model was injected, skip
  // building the provider client so tests need no API key / network.
  //
  // Provider: @ai-sdk/deepseek (NOT @ai-sdk/openai). DeepSeek's
  // reasoning_content is only surfaced by the deepseek provider's Chat
  // Completions doStream (it reads delta.reasoning_content and emits
  // reasoning-start/delta/end), so reasoning survives the sessionStore
  // resume round-trip as a reasoning part in the ModelMessage. The openai
  // provider's chat doStream never reads reasoning_content, which dropped all
  // reasoning state on multi-turn resume.
  //
  // The OPENAI_* env names are kept (they already point at DeepSeek: base url
  // https://api.deepseek.com, model deepseek-v4-flash) to avoid churning .env
  // and deployment config; they are DeepSeek credentials misnamed as OPENAI_*.
  const resolvedModel =
    model ??
    createDeepSeek({
      baseURL: env.OPENAI_BASE_URL,
      apiKey: env.OPENAI_API_KEY,
    }).chat(env.OPENAI_MODEL);
  // Reuse the same model handle for both the agent loop and extract_fields so
  // there is a single DeepSeek client per turn.
  const harnessDeps = deps ?? {
    ctx: getHarnessDbContext(),
    extraction: { model: resolvedModel },
    classifier: { model: resolvedModel },
    embedder: defaultEmbedder(),
    userId,
  };
  const ctx = harnessDeps.ctx;
  const tools = buildGatedTools(role, harnessDeps);
  // Context compression + circuit breaker (AUTO-LOOP variant). prepareStep runs
  // compressByBudget one step LATE (the just-produced result is already
  // committed), which is acceptable for the short stepCountIs(5) internal tool.
  // withAudit already archived the FULL result to auditRecorder before the next
  // prepareStep runs, so audit/status see uncompressed data -- no re-archive.
  const failures = createFailureTracker(3);
  // Phase 3 status bar: append a per-turn model-facing <agent_status> snapshot
  // at the trajectory tail. The snapshot is built from existing harness state
  // (audit recorder + sessionStore + DB counts). The appended message is NEVER
  // persisted (only appendMessages() is, which stores the real conversation),
  // so the status message is replaced fresh on every turn.
  const snapshot = sessionId ? buildAgentStatusSnapshot({ sessionId, userId, ctx }) : null;
  const messagesForModel = appendStatusMessage(messages, snapshot);
  return streamText({
    // Chat Completions API (.chat) -- DeepSeek's Responses-API compatibility
    // corrupts tool-call id correlation.
    model: resolvedModel,
    system: SYSTEM_PROMPT,
    messages: messagesForModel,
    tools,
    // L5 circuit breaker: stop after 3 consecutive tool failures (infra errors,
    // not business ok:false -- those return success:true with the payload).
    // Kept alongside the step cap so the loop still terminates on runaway tool
    // errors. Failure count is updated by experimental_onToolCallFinish (and on
    // a prepareStep compression throw) via the shared `failures` tracker.
    stopWhen: [stepCountIs(5), makeCircuitBreaker(() => failures.shouldStop)],
    // AI SDK 6 option name is `experimental_telemetry` (v7 renames to `telemetry`).
    // In tests no OTel exporter is registered (instrumentation.ts is not loaded),
    // so these spans are no-op and emit no network traffic.
    experimental_telemetry: {
      isEnabled: true,
      recordInputs: true,
      recordOutputs: true,
      functionId: `role-${role}-chat`,
      metadata: {
        role,
        auditTraceId,
      },
    },
    // L1/L2 context compression: shrink tool results to their declared budget
    // before each step. Returns {} on error (fail-open) and bumps the failure
    // streak so the circuit breaker can still trip on a pathological history.
    prepareStep: async ({ messages: stepMessages }) => {
      try {
        return { messages: compressByBudget(stepMessages) };
      } catch {
        failures.recordToolFinish(false);
        return {};
      }
    },
    // L5 failure signal: success resets the streak, failure increments it.
    // finishReason stays 'tool-calls' even on a tool error in v6, so this is the
    // authoritative failure signal.
    experimental_onToolCallFinish: ({ success }) => {
      failures.recordToolFinish(success);
    },
  });
}
