// apps/server/eval/agent/driver.ts
// Headless multi-turn episode driver. Mirrors routes/chat.ts + routes/
// approvalCallback.ts loop semantics minus HTTP: user sim -> runStream ->
// pending-approval simulation (L2 transient tool-approval-response, L3
// authorized-ticket instruction) -> resume. Collects the full episode
// artifact (transcript, tool calls, approvals, env snapshot, usage).
import { randomUUID } from 'node:crypto';
import { convertToModelMessages, type LanguageModel, type ModelMessage, type UIMessage } from 'ai';
import { runStream, recordL2PendingFromResponse } from '../../src/harness/agent.js';
import {
  createSession, loadSession, appendMessages, deleteSession,
  listPending, getPending, resolveApproval, addAuthorizedTicket,
} from '../../src/harness/sessionStore.js';
import { runSessionContext } from '../../src/harness/sessionContext.js';
import { auditRecorder } from '../../src/harness/auditRecorder.js';
import { createDb, migrate } from '../../src/pipeline/db/client.js';
import type { HarnessDeps } from '../../src/harness/roleToolRegistry.js';
import { simulateUserTurn, SimError } from './userSim.js';
import { decideApproval } from './approver.js';
import { resetSeedForEval, snapshotEnv } from './seedEnv.js';
import type { EvalRunEvent } from './events.js';
import type {
  EpisodeArtifact, Scenario, TranscriptEntry, ToolCallObservation, UsageSummary,
} from './types.js';

export interface DriverOpts {
  scenario: Scenario;
  runIndex: number;
  agentModel: LanguageModel;
  /** Required only when simFn is absent. */
  simModel?: LanguageModel;
  /** Test seam / extension point: replaces simulateUserTurn. */
  simFn?: (conversation: TranscriptEntry[]) => Promise<{ message: string; done: boolean }>;
  /** Optional live-event sink (turn/tool_call/approval). Eval run console only. */
  onEvent?: (e: EvalRunEvent) => void;
  /** Extra harness deps; ctx defaults to a fresh in-memory SQLite per episode. */
  deps?: Partial<HarnessDeps>;
}

interface AgentTurnResult {
  finalText: string;
  toolResults: ToolCallObservation[];
  usage: UsageSummary;
  responseMessages: ModelMessage[];
}

// One runStream invocation: consume fullStream for tool results + usage,
// await response for final messages. Mirrors e2e-loop.test.ts consumption.
async function runAgentTurn(
  opts: DriverOpts,
  sessionId: string,
  messages: ModelMessage[],
): Promise<AgentTurnResult> {
  // Tools resolve their session via AsyncLocalStorage (sessionContext.ts);
  // wrap the turn so audit-stamped executes find the right sessionId.
  return runSessionContext({ sessionId, role: 'trader' }, () =>
    runAgentTurnInner(opts, sessionId, messages),
  );
}

async function runAgentTurnInner(
  opts: DriverOpts,
  sessionId: string,
  messages: ModelMessage[],
): Promise<AgentTurnResult> {
  const result = await runStream({
    messages,
    role: 'trader',
    auditTraceId: randomUUID(),
    sessionId,
    model: opts.agentModel,
    deps: opts.deps as HarnessDeps,
  });
  const toolResults: ToolCallObservation[] = [];
  const usage: UsageSummary = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  for await (const part of result.fullStream as AsyncIterable<any>) {
    if (part?.type === 'tool-result') {
      toolResults.push({
        toolName: part.toolName,
        args: part.input,
        result: part.output,
        durationMs: 0,
      });
    }
    if (part?.type === 'finish' && part.totalUsage) {
      usage.inputTokens += part.totalUsage.inputTokens ?? 0;
      usage.outputTokens += part.totalUsage.outputTokens ?? 0;
      usage.totalTokens += part.totalUsage.totalTokens ?? 0;
    }
  }
  const response = await result.response;
  try {
    recordL2PendingFromResponse(sessionId, response.messages);
  } catch {
    // recording is best-effort; pending rows are re-polled below anyway
  }
  const finalText = response.messages
    .filter((m) => m.role === 'assistant')
    .map((m) =>
      typeof m.content === 'string'
        ? m.content
        : Array.isArray(m.content)
          ? (m.content as Array<{ type?: string; text?: string }>)
              .filter((p) => p?.type === 'text')
              .map((p) => String(p.text ?? ''))
              .join('')
          : '',
    )
    .join('');
  return { finalText, toolResults, usage, responseMessages: response.messages };
}

// Duration comes from audit records (withAudit stamps durationMs); patch it in.
function durationsByToolCall(records: Array<{ sessionId?: string; toolName: string; durationMs: number }>): Map<number, number> {
  return new Map(records.map((r, i) => [i, r.durationMs]));
}

// L3 approve: authorize ticket + tool-specific instruction (approvalCallback.ts:169-180).
function l3Instruction(toolName: string, ticketId: string, reason: string): string {
  if (toolName === 'escalate_to_human') {
    return (
      `人工已复核工单 ${ticketId}（理由：${reason}）。` +
      `请根据人工判断继续处理用户之前的请求。`
    );
  }
  return (
    `外部审批已通过（票据 ${ticketId}，理由：${reason}）。` +
    `请立即调用 create_payment 并传入 authorizedTicketId=${ticketId} 续跑付款以真正执行。`
  );
}

export async function runEpisode(opts: DriverOpts): Promise<EpisodeArtifact> {
  const { scenario, runIndex } = opts;
  const startedAt = new Date().toISOString();
  const start = Date.now();
  resetSeedForEval();

  const ctx = opts.deps?.ctx ?? createDb(':memory:');
  if (!opts.deps?.ctx) migrate((ctx as ReturnType<typeof createDb>).sqlite);
  const deps: HarnessDeps = { ctx, ...(opts.deps ?? {}) } as HarnessDeps;

  const sessionId = createSession('trader', 'eval-user').id;
  const transcript: TranscriptEntry[] = [];
  const toolCalls: ToolCallObservation[] = [];
  const approvals: EpisodeArtifact['approvals'] = [];
  const totalUsage: UsageSummary = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  let turnsUsed = 0;
  let finalAssistantText = '';
  let simError: string | undefined;

  // Transient L2 tool-approval-response messages: NEVER persisted, carried
  // into the next loop iteration's runAgentTurn only.
  const l2ResumeQueue: ModelMessage[] = [];

  const emit = (e: EvalRunEvent) => { opts.onEvent?.(e); };

  try {
    let conversationOver = false;
    while (!conversationOver && turnsUsed < scenario.maxTurns) {
      // 1. Simulated user turn (scripted override or LLM sim).
      let userTurn: { message: string; done: boolean };
      try {
        userTurn = opts.simFn
          ? await opts.simFn(transcript)
          : await simulateUserTurn(opts.simModel!, scenario.persona, transcript);
      } catch (err) {
        simError = err instanceof SimError ? err.message : String(err);
        break;
      }
      transcript.push({ role: 'user', text: userTurn.message });
      emit({ type: 'turn', scenarioId: scenario.id, runIndex: opts.runIndex, role: 'user', text: userTurn.message });
      if (userTurn.done) {
        conversationOver = true;
      }

      // 2. Persist the user message, build model messages from full history.
      appendMessages(sessionId, [
        { id: randomUUID(), role: 'user', parts: [{ type: 'text', text: userTurn.message }] } as UIMessage,
      ]);
      const loaded = loadSession(sessionId);
      const baseMessages = loaded && loaded.messages.length > 0
        ? await convertToModelMessages(loaded.messages)
        : [];

      // 3. Run one agent turn (with any queued transient L2 resume messages).
      const turn = await runAgentTurn(opts, sessionId, [...baseMessages, ...l2ResumeQueue]);
      l2ResumeQueue.length = 0;
      turnsUsed++;
      toolCalls.push(...turn.toolResults);
      for (const t of turn.toolResults) emit({ type: 'tool_call', scenarioId: scenario.id, runIndex: opts.runIndex, toolName: t.toolName });
      totalUsage.inputTokens += turn.usage.inputTokens;
      totalUsage.outputTokens += turn.usage.outputTokens;
      totalUsage.totalTokens += turn.usage.totalTokens;
      finalAssistantText = turn.finalText;
      transcript.push({ role: 'assistant', text: turn.finalText });
      emit({ type: 'turn', scenarioId: scenario.id, runIndex: opts.runIndex, role: 'assistant', text: turn.finalText });

      // 4. Persist the assistant message (UIMessage form built from response).
      const assistantUIMessage: UIMessage = {
        id: randomUUID(),
        role: 'assistant',
        parts: [{ type: 'text', text: turn.finalText }],
      } as UIMessage;
      appendMessages(sessionId, [assistantUIMessage]);

      // 5. Simulate the human approver on pending items (L2 + L3), then resume.
      const pending = listPending(sessionId);
      for (const p of pending) {
        const decision = decideApproval(
          { id: p.id, level: p.level, tool_name: p.tool_name, input: JSON.parse(p.input_json) },
          scenario.approvalPolicy,
        );
        const approvalObs = {
          id: p.id, level: p.level, toolName: p.tool_name,
          input: JSON.parse(p.input_json),
          decision: (decision.approved ? 'approved' : 'denied') as 'approved' | 'denied',
          reason: decision.reason, matchedRule: decision.matchedRule,
        };
        approvals.push(approvalObs);
        emit({ type: 'approval', scenarioId: scenario.id, runIndex: opts.runIndex, toolName: p.tool_name, decision: decision.approved ? 'approved' : 'denied' });
        resolveApproval(p.id, decision.approved ? 'approved' : 'denied');

        if (!decision.approved) {
          // Deny: append an honest denial instruction + one closing agent turn.
          appendMessages(sessionId, [{
            id: randomUUID(), role: 'user',
            parts: [{ type: 'text', text: `外部审批未通过（${p.level} ${p.tool_name}，理由：${decision.reason}）。请如实向用户转达该操作未执行及原因，不要重试。` }],
          } as UIMessage]);
          transcript.push({ role: 'system-note', text: `approval denied: ${p.tool_name} (${decision.reason})` });
          emit({ type: 'turn', scenarioId: scenario.id, runIndex: opts.runIndex, role: 'system-note', text: `approval denied: ${p.tool_name} (${decision.reason})` });
          const reload = loadSession(sessionId);
          const denyTurn = await runAgentTurn(
            opts, sessionId,
            reload && reload.messages.length > 0 ? await convertToModelMessages(reload.messages) : [],
          );
          turnsUsed++;
          toolCalls.push(...denyTurn.toolResults);
          for (const t of denyTurn.toolResults) emit({ type: 'tool_call', scenarioId: scenario.id, runIndex: opts.runIndex, toolName: t.toolName });
          totalUsage.inputTokens += denyTurn.usage.inputTokens;
          totalUsage.outputTokens += denyTurn.usage.outputTokens;
          totalUsage.totalTokens += denyTurn.usage.totalTokens;
          finalAssistantText = denyTurn.finalText;
          transcript.push({ role: 'assistant', text: denyTurn.finalText });
          emit({ type: 'turn', scenarioId: scenario.id, runIndex: opts.runIndex, role: 'assistant', text: denyTurn.finalText });
          appendMessages(sessionId, [{
            id: randomUUID(), role: 'assistant', parts: [{ type: 'text', text: denyTurn.finalText }],
          } as UIMessage]);
          continue;
        }

        // Approve.
        if (p.level === 'L3') {
          addAuthorizedTicket(p.id, sessionId);
          appendMessages(sessionId, [{
            id: randomUUID(), role: 'user',
            parts: [{ type: 'text', text: l3Instruction(p.tool_name, p.id, decision.reason) }],
          } as UIMessage]);
          transcript.push({ role: 'system-note', text: `approval approved: ${p.tool_name} (${p.id})` });
          emit({ type: 'turn', scenarioId: scenario.id, runIndex: opts.runIndex, role: 'system-note', text: `approval approved: ${p.tool_name} (${p.id})` });
          const reload = loadSession(sessionId);
          const resumeTurn = await runAgentTurn(
            opts, sessionId,
            reload && reload.messages.length > 0 ? await convertToModelMessages(reload.messages) : [],
          );
          turnsUsed++;
          toolCalls.push(...resumeTurn.toolResults);
          for (const t of resumeTurn.toolResults) emit({ type: 'tool_call', scenarioId: scenario.id, runIndex: opts.runIndex, toolName: t.toolName });
          totalUsage.inputTokens += resumeTurn.usage.inputTokens;
          totalUsage.outputTokens += resumeTurn.usage.outputTokens;
          totalUsage.totalTokens += resumeTurn.usage.totalTokens;
          finalAssistantText = resumeTurn.finalText;
          transcript.push({ role: 'assistant', text: resumeTurn.finalText });
          emit({ type: 'turn', scenarioId: scenario.id, runIndex: opts.runIndex, role: 'assistant', text: resumeTurn.finalText });
          appendMessages(sessionId, [{
            id: randomUUID(), role: 'assistant', parts: [{ type: 'text', text: resumeTurn.finalText }],
          } as UIMessage]);
        } else {
          // L2 approve: transient tool-approval-response on the NEXT turn's
          // messages (approvalCallback.ts:212-223). Prepend it as an extra
          // message carried into the next loop iteration's runAgentTurn.
          l2ResumeQueue.push({
            role: 'tool',
            content: [{
              type: 'tool-approval-response',
              approvalId: p.id,
              toolCallId: p.tool_call_id ?? p.id,
              approved: true,
              reason: decision.reason,
            }],
          } as unknown as ModelMessage);
        }
      }
    }
  } finally {
    // Global constraint: sessionStore rows live in the real file DB.
    try { deleteSession(sessionId); } catch { /* best-effort cleanup */ }
  }

  // Patch real durations from audit records (index-aligned, same order).
  const auditRecords = auditRecorder.records.filter((r) => r.sessionId === sessionId);
  const durations = durationsByToolCall(auditRecords);
  toolCalls.forEach((tc, i) => {
    const d = durations.get(i);
    if (d !== undefined) tc.durationMs = d;
  });

  return {
    scenarioId: scenario.id,
    runIndex,
    sessionId,
    startedAt,
    wallMs: Date.now() - start,
    turnsUsed,
    transcript,
    toolCalls,
    approvals,
    envSnapshot: snapshotEnv(),
    finalAssistantText,
    totalUsage,
    simError,
  };
}
