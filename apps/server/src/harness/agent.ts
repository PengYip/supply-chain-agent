import { streamText, stepCountIs, type Tool, type ModelMessage, type LanguageModel } from 'ai';
import { detectScenario, scenarioActiveTools } from './scenarios.js';
import { createDeepSeek } from '@ai-sdk/deepseek';
import { env } from '../env.js';
import { getToolsForRole, type Role, type HarnessDeps } from './roleToolRegistry.js';
import { getPermission } from './permissionGate.js';
import { recordPendingApproval, countPendingApprovals } from './sessionStore.js';
import { auditRecorder, type ToolCallRecord } from './auditRecorder.js';
import { classifyToolError } from './errorClassification.js';
import { assertAllToolsContracted } from './contextContract.js';
import {
  compressByBudget,
  createFailureTracker,
  makeCircuitBreaker,
  type FailureTracker,
} from './compression.js';
import { appendStatusMessage, type AgentStatusSnapshot } from './agentStatus.js';
import { getToolCallCounts } from './statusAggregator.js';
import { countDocuments, countExtractionsNeedingReview } from '../pipeline/db/repositories.js';
import { discoverSkills, buildSkillIndexSection } from './skillDiscovery.js';
// defaultEmbedder priority chain lives in ingestModel.ts (single source of
// truth, shared with the parse path / backfill).
import { defaultEmbedder } from '../pipeline/ingestModel.js';
import { makeLlmTagger } from '../pipeline/chunkTagging.js';
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
  '5. 写操作（如绑定单据 bind_document、标注/改字段 update_document_fields、建关系 link_documents）需用户确认后执行。若工具被请求确认（tool-approval-request），必须如实告知用户"该操作需要你确认后才会执行"，不得谎称已执行。',
  '6. 付款/退款/合同变更属于资金或不可逆操作，系统内没有对应的执行工具，禁止声称已完成或编造执行流程；如需人工决策或人工执行，必须调用 escalate_to_human 生成工单转人工，并如实告知用户。',
  '7. 不确定回退：遇到数据冲突、置信度低、数据缺失或业务规则边界时，调用 escalate_to_human 转人工并向用户告知工单号，不得自行编造或猜测。',
  // 各工具的用法手册(文档检索/合同台账/图关系/单据录入闭环)已按 tool-inventory
  // 方法论收敛到对应工具的 description(whenToUse/boundary SSOT, 2026-09-01 瘦身)。
  // Skill 索引(方法论第4步 Skill 化, 2026-08-28): 模块加载时同步扫描一次
   // apps/server/skills/, 把技能清单拼进静态系统提示词尾部; 运行期不变
   // (KV cache 静态前缀)。扫描失败/无技能 -> 空串, 不阻塞启动。
   ...buildSkillIndexSection(discoverSkills()).split('\n'),
].join('\n');

/** Extract the trailing user message's text for scenario detection (阶段3). */
function lastUserText(msgs: ModelMessage[]): string {
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i]!;
    if (m.role !== 'user') continue;
    if (typeof m.content === 'string') return m.content;
    if (Array.isArray(m.content)) {
      return m.content
        .map((p) => (p && typeof p === 'object' && (p as { type?: string }).type === 'text'
          ? String((p as { text?: string }).text ?? '')
          : ''))
        .join(' ');
    }
  }
  return '';
}

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
export function withAudit(name: string, execute: Tool['execute'], failures?: FailureTracker): Tool['execute'] {
  if (!execute) return execute;
  return async (input: any, options: any) => {
    const start = Date.now();
    let result: any;
    try {
      result = await execute(input, options);
    } catch (err) {
      // Book Ch5:196 + Ch5:184: surface the error as a structured tool RESULT
      // (not an SDK tool-error part) so the model sees a uniform shape incl.
      // whether retrying is worthwhile. This makes withAudit NEVER throw.
      const classified = classifyToolError(err);
      result = { status: 'error', reason: 'tool_error', toolName: name, ...classified };
    }
    const durationMs = Date.now() - start;
    auditRecorder.recordToolCall({ toolName: name, args: input, result, durationMs });
    // Record the REAL success/fail signal directly (certain knowledge from the
    // try/catch + result shape). After T3, withAudit never throws, so the SDK's
    // experimental_onToolCallFinish would see every call as success=true;
    // recording here keeps the consecutive-failure circuit breaker alive. A
    // result with status==='error' (thrown+caught OR T1 structured timeout)
    // counts as a failure.
    const isError = result?.status === 'error';
    failures?.recordToolFinish(!isError);
    // Phase 6 T2 (book Ch5:186): fingerprint for repeat-call loop detection.
    // Unconditional (incl. caught throws) — the model DID call the tool.
    failures?.recordToolCall(name, input);
    return result;
  };
}

/**
 * Per-tool timeout wrapper (book Ch5:314). Wraps an execute in a Promise.race
 * against a timeout. On timeout returns a STRUCTURED result — NOT a throw — so
 * the model sees the timeout as a tool result it can adapt to next turn (change
 * args, switch tool, give up) instead of a silent kill. The wrapper is INNERMOST
 * (composed inside withAudit in buildGatedTools) so withAudit records the
 * structured timeout like any other result. toolName is attached for context.
 */
export function withToolTimeout(
  execute: Tool['execute'],
  timeoutMs: number,
  toolName?: string,
): Tool['execute'] {
  if (!execute) return execute;
  return async (input: any, options: any) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => {
        resolve({ status: 'error', reason: 'tool_timeout', toolName, timeoutMs });
      }, timeoutMs);
    });
    const execPromise = execute(input, options);
    // Mark any late rejection handled: if the timeout wins the race, the
    // abandoned execPromise is still pending; a late DB/network rejection would
    // otherwise surface as an unhandled rejection under
    // --unhandled-rejections=throw and crash the PM2 process. The no-op catch
    // does NOT affect race behavior (fast-resolve: no-op; fast-reject before
    // timeout: throw still propagates via the race; timeout + late-reject:
    // swallowed here).
    execPromise.catch(() => {});
    try {
      const result = await Promise.race([execPromise, timeout]);
      return result;
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
}

// Per-tool timeout overrides for heavy model-bound operations. Large-contract
// extraction and scanned-PDF ingest can exceed the default 120s budget; other
// tools stay on env.TOOL_TIMEOUT_MS.
const TOOL_TIMEOUT_OVERRIDES: Record<string, number> = {
  extract_fields: 240000,
  ingest_document: 240000,
};

export function buildGatedTools(role: Role, deps?: HarnessDeps, failures?: FailureTracker): Record<string, Tool> {
  const list = getToolsForRole(role, deps);
  // Contract guard: no tool may go live for the model without a declared
  // tool-context contract. Fail fast (first turn) if a new tool is added to
  // RoleToolRegistry without an entry in TOOL_CONTEXT_CONTRACTS.
  assertAllToolsContracted(list.map((t) => t.name));
  const gated: Record<string, Tool> = {};
  for (const t of list) {
    const name = t.name;
    const timeoutMs = TOOL_TIMEOUT_OVERRIDES[name] ?? env.TOOL_TIMEOUT_MS;
    const audited: Tool = { ...t, execute: withAudit(name, withToolTimeout(t.execute, timeoutMs, name), failures) };
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
 * Default embedder for production lives in ../pipeline/ingestModel.ts
 * (defaultEmbedder): SiliconFlow -> Ollama -> deterministic. Tests bypass it
 * by injecting their own embedder via RunStreamOpts.deps.
 */

// Model-facing closing instruction injected on the last allowed step
// (OpenCode MAX_STEPS_PROMPT pattern). Tools are disabled for that step, so
// the model can only acknowledge with text -- the turn always ends with an
// assistant closing instead of dangling on a tool result when the step cap
// trips.
const MAX_STEPS_CLOSING = [
  '系统提示：本轮对话的工具调用步数已达到上限，本步已禁用全部工具。',
  '请立即用简短文字向用户收尾，不要再请求任何工具。收尾内容必须包含：',
  '1. 本轮已完成的操作及其结果（引用工具返回的关键数字，不得编造）；',
  '2. 尚未完成的事项；',
  '3. 建议用户如何继续（例如换一种问法、或分步提出请求）。',
].join('\n');

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
  /**
   * Background-runtime seam: abort signal forwarded to streamText so a
   * background run can be cancelled (RunManager.abortSessionRun).
   */
  abortSignal?: AbortSignal;
  /**
   * Opt-out of the <agent_status> injection. Approval-resume callers append a
   * transient trailing role:'tool' tool-approval-response message that MUST
   * remain the LAST message for the SDK's collectToolApprovals pairing (ai
   * index.mjs:2810 requires messages.at(-1).role === 'tool'); appending a user
   * status message after it would silently disable L2 approve/deny semantics.
   * (Inserting it before the tool message is invalid too: a user message
   * between assistant tool_calls and its tool_result violates provider message
   * ordering.)
   */
  skipStatusMessage?: boolean;

  /**
   * 阶段3 场景挂载: 显式钉死本回合场景('all' = 不收窄)。缺省时按最后一条
   * 用户消息自动检测。测试与上游调用方(如审批恢复)可传入以固定可见工具集。
   */
  scenario?: import('./scenarios.js').ScenarioOrAll;

  /**
   * Terminal stream-error seam (incident 2026-09-02): invoked ONCE with the
   * RAW error when the stream ends with a terminal `{type:'error'}` fullStream
   * part (provider call failure / stream interruption). NEVER invoked for
   * tool errors (those are non-fatal `tool-error` parts the loop continues
   * past). Wired to streamText's `onError` (AI SDK 6: StreamTextOnErrorCallback,
   * called from the eventProcessor for terminal error parts only -- verified
   * against ai@6.0.259 index.mjs:7200-7210). runSession captures the raw error
   * here because the UI message stream only carries the FORMATTED errorText.
   */
  onStreamError?: (error: unknown) => void;
}

// Scan a turn's response messages for v6 tool-approval-request parts (emitted
// when an L2 `needsApproval` tool is called) and persist each as a pending L2
// approval so the external /api/approval/callback can later resume it.
// Async since the session store went dual-backend (SQLite/Postgres).
//
// Field-availability gotcha (AI SDK 6): in response.messages the
// tool-approval-request part only carries { approvalId, toolCallId } -- it has
// NO `toolCall` object, so the toolName/input must be recovered from the
// sibling `tool-call` part in the SAME assistant message (matched by
// toolCallId). The OUTPUT part in result.content does carry toolCall, but
// response.messages does not.
export async function recordL2PendingFromResponse(
  sessionId: string,
  messages: ModelMessage[],
): Promise<void> {
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
      await recordPendingApproval({
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
 * and DB progress counts (repositories). Async because the pg count fns are
 * async (better-sqlite3 is sync, but both branches share the async signature).
 * `recorder` defaults to the process-wide singleton; tests pass a local one for
 * deterministic isolation.
 */
export async function buildAgentStatusSnapshot({
  sessionId,
  userId,
  ctx,
  recorder = auditRecorder,
}: BuildAgentStatusSnapshotOpts): Promise<AgentStatusSnapshot> {
  const toolCounts = getToolCallCounts(sessionId, recorder);
  const totalCalls = toolCounts.reduce((sum, t) => sum + t.count, 0);
  return {
    toolCounts,
    totalCalls,
    pendingApprovals: await countPendingApprovals(sessionId),
    docsIngested: await countDocuments(ctx, userId),
    extractionsPendingReview: await countExtractionsNeedingReview(ctx, userId),
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
export async function runStream({ messages, role, auditTraceId, model, deps, userId, sessionId, abortSignal, skipStatusMessage, scenario: scenarioOverride, onStreamError }: RunStreamOpts) {
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
    // Lane B: reuse the same DeepSeek model handle for chunk tagging so there is
    // one provider client per turn (matches extraction/classifier).
    tagger: makeLlmTagger(resolvedModel),
    userId,
  };
  const ctx = harnessDeps.ctx;
  // Context compression + circuit breaker (AUTO-LOOP variant). prepareStep runs
  // compressByBudget one step LATE (the just-produced result is already
  // committed), which is acceptable for the short stepCountIs(5) internal tool.
  // withAudit already archived the FULL result to auditRecorder before the next
  // prepareStep runs, so audit/status see uncompressed data -- no re-archive.
  // Created BEFORE buildGatedTools so withAudit can record repeat-call
  // fingerprints into it (Phase 6 T2, book Ch5:186).
  const failures = createFailureTracker(env.AGENT_FAILURE_THRESHOLD);
  const tools = buildGatedTools(role, harnessDeps, failures);
  // Phase 3 status bar: append a per-turn model-facing <agent_status> snapshot
  // at the trajectory tail. The snapshot is built from existing harness state
  // (audit recorder + sessionStore + DB counts). The appended message is NEVER
  // persisted (only appendMessages() is, which stores the real conversation),
  // so the status message is replaced fresh on every turn.
  const snapshot = sessionId && !skipStatusMessage ? await buildAgentStatusSnapshot({ sessionId, userId, ctx }) : null;
  const messagesForModel = appendStatusMessage(messages, snapshot);
  // 阶段3 场景挂载(tool-inventory methodology): 按当前用户消息把本回合可见
  // 工具收窄到 场景集 ∪ CORE; 检测保守(无命中/涉及模板维护 -> 'all' 不收窄)。
  // prepareStep 的末步 activeTools:[] 覆盖本值, 收尾行为不变。
  const scenario = scenarioOverride ?? detectScenario(lastUserText(messagesForModel));
  const scenarioTools = scenarioActiveTools(scenario, Object.keys(tools));
  return streamText({
    // Chat Completions API (.chat) -- DeepSeek's Responses-API compatibility
    // corrupts tool-call id correlation.
    model: resolvedModel,
    system: SYSTEM_PROMPT,
    messages: messagesForModel,
    tools,
    // 场景挂载: 'all'(检测不确定)时为 undefined, 不收窄。
    ...(scenarioTools ? { activeTools: [...scenarioTools] } : {}),
    // L5 circuit breaker: stop after N consecutive tool failures (infra
    // errors, not business ok:false -- those return success:true with the
    // payload). Kept alongside the step cap so the loop still terminates on
    // runaway tool errors. Failure count is updated by withAudit (and on a
    // prepareStep compression throw) via the shared `failures` tracker.
    stopWhen: [stepCountIs(env.AGENT_MAX_STEPS), makeCircuitBreaker(() => failures.shouldStop || failures.isLooping)],
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
    // L1/L2 context compression + step-cap closing, both wired in prepareStep.
    //
    // Compression: shrink tool results to their declared budget before each
    // step; on a compression throw, fail-open with the original messages and
    // bump the failure streak so the circuit breaker can still trip on a
    // pathological history.
    //
    // Step-cap closing (OpenCode MAX_STEPS_PROMPT pattern): on the LAST
    // allowed step (stepNumber is 0-based) the tool set is emptied
    // (activeTools: [] -> the provider receives no tools at all) and a
    // closing instruction is appended. The model can only respond with text,
    // so a capped turn always ends with an assistant closing instead of
    // dangling on a tool result. runSession's onFinish fallback is the net
    // for the circuit-breaker path, which skips prepareStep entirely.
    prepareStep: async ({ messages: stepMessages, stepNumber }) => {
      const isLastStep = stepNumber >= env.AGENT_MAX_STEPS - 1;
      let compressed: ModelMessage[];
      try {
        compressed = compressByBudget(stepMessages);
      } catch {
        failures.recordToolFinish(false);
        compressed = stepMessages;
      }
      if (isLastStep) {
        return {
          messages: [...compressed, { role: 'user' as const, content: MAX_STEPS_CLOSING }],
          activeTools: [],
          toolChoice: 'none' as const,
        };
      }
      return { messages: compressed };
    },
    // Background-runtime seam: forwarded so RunManager can cancel a background
    // run via its AbortController (AI SDK 6 option name: abortSignal).
    ...(abortSignal ? { abortSignal } : {}),
    // Terminal stream-error seam: forward the RAW error to the caller
    // (runSession audits + classifies it). Trivially wrapped so a throwing
    // callback cannot break the stream pipeline.
    ...(onStreamError
      ? {
          onError: ({ error }: { error: unknown }) => {
            try {
              onStreamError(error);
            } catch {
              // the seam must never break the stream
            }
          },
        }
      : {}),
    // Phase 6 T3: experimental_onToolCallFinish was REMOVED. After T3,
    // withAudit catches all throws and records the success/fail signal directly
    // into `failures` (certain knowledge from its try/catch + result shape). The
    // SDK's `success` param would always be true now (withAudit never throws),
    // so the callback was dead for the circuit-breaker purpose. The `failures`
    // tracker is still updated by withAudit (tool success/fail + fingerprint)
    // and prepareStep (compression failure) — both certain signals.
  });
}
