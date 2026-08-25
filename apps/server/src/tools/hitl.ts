import { tool } from 'ai';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { recordPendingApproval } from '../harness/sessionStore.js';
import { getSessionId } from '../harness/sessionContext.js';

// HITL tool (T3). L1 (auto-execute, no approval gate).
// AI SDK 6 uses `inputSchema` (not v5 `parameters`).
//
// H4: per-tool audit recording was removed -- every tool call is now wrapped
// centrally by `withAudit` in src/harness/agent.ts (buildGatedTools).

// ---- T3: escalate_to_human (uncertainty fallback, L1 in tool registry but
// uses the L3 approval pattern so the frontend renders an approval card with a
// resume path. escalate_to_human is the dedicated HITL tool: it registers a
// pending L3 ticket in sessionStore and returns `blocked` so the frontend
// renders an in-app human-review card; approval via /api/approval/callback
// appends a human-reviewed instruction and resumes.)
//
// Zero-hallucination backstop: when the model hits a data conflict / missing
// data / low confidence / rule boundary, it calls this instead of guessing.
// No write side effect -- just issues a ticket id (audit is centralized).

const escalateSchema = z.object({
  issue: z
    .string()
    .describe('问题描述：什么不确定/冲突/缺失，需要人工判断'),
  category: z
    .enum(['data_conflict', 'data_missing', 'low_confidence', 'rule_boundary', 'other'])
    .describe('问题类别'),
  context: z
    .record(z.any())
    .optional()
    .describe('相关上下文数据（合同号/订单号/金额等）'),
  severity: z
    .enum(['low', 'medium', 'high'])
    .default('medium')
    .describe('严重程度'),
});

export const escalateToHuman = tool({
  description:
    '不确定回退：当遇到数据冲突、置信度低、数据缺失或业务规则边界情况无法确定时，转人工处理。不要自行编造或猜测，调用本工具生成人工处理工单。',
  inputSchema: escalateSchema,
  execute: async ({ issue, category, context, severity }) => {
    const sessionId = getSessionId();
    const ticketId = `ESC-${randomUUID().slice(0, 8)}`;
    if (sessionId) {
      await recordPendingApproval({
        sessionId,
        level: 'L3',
        toolName: 'escalate_to_human',
        input: { issue, category, severity, context: context ?? {} },
        ticketId,
      });
    }
    const result = {
      ok: false as const,
      status: 'blocked' as const,
      reason: 'requires_external_approval' as const,
      ticketId,
      message: `已生成人工处理工单 ${ticketId}，等待人工复核通过后将继续处理。问题类别：${category}，严重程度：${severity}。`,
      issue,
      category,
      severity,
    };
    return result;
  },
});
