import { streamText, stepCountIs, type Tool, type ModelMessage } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { env } from '../env.js';
import { getToolsForRole, type Role, type HarnessDeps } from './roleToolRegistry.js';
import { getPermission } from './permissionGate.js';
import { recordPendingApproval } from './sessionStore.js';
import { createDb, migrate, type DbContext } from '../pipeline/db/client.js';

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
export function buildGatedTools(role: Role, deps?: HarnessDeps): Record<string, Tool> {
  const list = getToolsForRole(role, deps);
  const gated: Record<string, Tool> = {};
  for (const t of list) {
    const name = t.name;
    // L2 via the permission gate (source of truth) OR a literal boolean
    // needsApproval stamped at registration (e.g. bind_document). `=== true`
    // avoids matching Tool's needsApproval-function form.
    if (getPermission(name) === 'L2' || t.needsApproval === true) {
      gated[name] = { ...t, needsApproval: true };
    } else {
      gated[name] = t;
    }
  }
  return gated;
}

// Process-wide DbContext for the doc-entry pipeline tools. Created once (lazy)
// and migrated; the default createDb() uses an in-memory SQLite database. A
// later phase can swap in a file-backed DB by passing a path to createDb.
let harnessCtx: DbContext | null = null;
function getHarnessDbContext(): DbContext {
  if (!harnessCtx) {
    harnessCtx = createDb();
    migrate(harnessCtx.sqlite);
  }
  return harnessCtx;
}

export interface RunStreamOpts {
  messages: ModelMessage[];
  role: Role;
  auditTraceId: string;
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

// Create the streamText result for one agent turn. Caller is responsible for
// session persistence and for returning result.toUIMessageStreamResponse().
export function runStream({ messages, role, auditTraceId }: RunStreamOpts) {
  const openai = createOpenAI({
    baseURL: env.OPENAI_BASE_URL,
    apiKey: env.OPENAI_API_KEY,
  });
  // Reuse the same model handle for both the agent loop and extract_fields so
  // there is a single DeepSeek client per turn.
  const model = openai.chat(env.OPENAI_MODEL);
  const tools = buildGatedTools(role, { ctx: getHarnessDbContext(), extraction: { model } });
  return streamText({
    // Chat Completions API (.chat) -- DeepSeek's Responses-API compatibility
    // corrupts tool-call id correlation.
    model,
    system: SYSTEM_PROMPT,
    messages,
    tools,
    stopWhen: stepCountIs(5),
    // AI SDK 6 option name is `experimental_telemetry` (v7 renames to `telemetry`).
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
  });
}
