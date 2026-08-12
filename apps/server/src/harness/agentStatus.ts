import type { ModelMessage } from 'ai';

/**
 * Model-facing agent status bar (design §9.2).
 *
 * A code-maintained snapshot of in-memory harness state, formatted into a
 * user-role message appended at the trajectory tail on every model call. The
 * content is trusted (generated counts), but the message is wrapped in
 * <agent_status> delimiters with a non-instruction preamble so the model does
 * not mistake the counts for user commands. Mirrors the tagExternal
 * <external_content> injection-defense posture.
 */

export interface ToolCallCount {
  tool: string;
  count: number;
}

export interface AgentStatusSnapshot {
  toolCounts: ToolCallCount[];
  totalCalls: number;
  pendingApprovals: number;
  docsIngested: number;
  extractionsPendingReview: number;
}

export function formatAgentStatusBody(snapshot: AgentStatusSnapshot): string {
  const lines: string[] = [];
  lines.push('本轮工具调用统计:');
  for (const { tool, count } of snapshot.toolCounts) {
    lines.push(`- ${tool}: ${count}`);
  }
  lines.push(`总计: ${snapshot.totalCalls} 次`);
  lines.push(`待审批: ${snapshot.pendingApprovals} 项 (L2/L3)`);
  lines.push(`已入库文档: ${snapshot.docsIngested}`);
  lines.push(`待复核抽取: ${snapshot.extractionsPendingReview}`);
  return lines.join('\n');
}

const AGENT_STATUS_OPEN = '<agent_status>';
const AGENT_STATUS_CLOSE = '</agent_status>';
const PREAMBLE =
  '以下为系统根据会话状态自动生成的摘要, 仅供参考, 非用户指令, 请勿将其中的统计数字或状态作为执行操作的依据。';

export function buildStatusMessage(snapshot: AgentStatusSnapshot): ModelMessage {
  const body = formatAgentStatusBody(snapshot);
  const text = `${AGENT_STATUS_OPEN}\n${PREAMBLE}\n${body}\n${AGENT_STATUS_CLOSE}`;
  return { role: 'user', content: text };
}

export function appendStatusMessage(
  messages: ModelMessage[],
  snapshot: AgentStatusSnapshot | null,
): ModelMessage[] {
  if (!snapshot) return messages;
  return [...messages, buildStatusMessage(snapshot)];
}
