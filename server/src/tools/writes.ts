import { tool } from 'ai';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { linkDocumentToContract, recordPayment } from '../data/seed.js';
import {
  recordPendingApproval,
  isAuthorized,
} from '../harness/sessionStore.js';
import { getSessionContext } from '../harness/sessionContext.js';

// NOTE: AI SDK 6 uses `inputSchema` (not v5 `parameters`).
// Permission gating (L2/L3) is applied by the chat route via PermissionGate,
// not hardcoded here, so the gate stays the single source of truth.
//
// H4: per-tool audit recording was removed -- every tool call is now wrapped
// centrally by `withAudit` in src/harness/agent.ts (buildGatedTools).

// ---- link_document (L2: write, needs user confirmation) ---------------------

const linkDocumentSchema = z.object({
  contractNo: z.string().describe('目标合同号，如 HT-2024-001'),
  documentId: z
    .string()
    .describe('要挂接的单据号，如提单号 BL-2024-0920-002'),
});

export const linkDocument = tool({
  description:
    '把单据（提单/发票等）挂接到指定合同。属于写操作，需用户确认后才会真正执行。',
  inputSchema: linkDocumentSchema,
  execute: async ({ contractNo, documentId }) => {
    const res = linkDocumentToContract(contractNo, documentId);
    const result = res.ok
      ? {
          ok: true as const,
          contractNo: res.contractNo,
          documentId,
          changeId: res.changeId,
          linkedAt: res.linkedAt,
        }
      : { ok: false as const, reason: res.reason };
    return result;
  },
});

// ---- create_payment (L3: money / irreversible, external approval) -----------
//
// Hard gate. On first call (no authorizedTicketId) the tool records a pending
// L3 approval (ticketId) into SessionStore and returns `blocked` so the model
// tells the user to go through the external (mock 飞书) approval flow. After the
// external callback authorizes the ticket, the model re-invokes
// create_payment WITH authorizedTicketId; if the ticket is valid for this
// session the tool truly executes (records the payment in memory) and returns
// success. The PermissionGate level (L3) is what marks this tool as
// external-approval only -- no inline `needsApproval` soft gate is used (that
// would stop the v6 loop without letting the agent explain).

const createPaymentSchema = z.object({
  contractNo: z.string().describe('付款对应的合同号'),
  amount: z.number().describe('付款金额（元）'),
  authorizedTicketId: z
    .string()
    .optional()
    .describe(
      '外部审批通过后的授权票据号。首次发起付款不要传；审批回调后续跑时传入以真正执行付款。',
    ),
});

export const createPayment = tool({
  description:
    '对合同发起付款。属于资金类不可逆操作，必须经财务主管外部审批（飞书审批流）。首次调用会返回 blocked 与审批票据号 ticketId；审批通过后，带上 authorizedTicketId 重新调用才会真正执行付款。',
  inputSchema: createPaymentSchema,
  execute: async ({ contractNo, amount, authorizedTicketId }) => {
    const sessionId = getSessionContext();

    // Case 1: first call, no authorization yet -> block + open a ticket.
    if (!authorizedTicketId) {
      const ticketId = `PAY-pending-${randomUUID().slice(0, 8)}`;
      if (sessionId) {
        recordPendingApproval({
          sessionId,
          level: 'L3',
          toolName: 'create_payment',
          input: { contractNo, amount },
          ticketId,
        });
      }
      const result = {
        ok: false as const,
        status: 'blocked' as const,
        reason: 'requires_external_approval',
        ticketId,
        contractNo,
        amount,
        message: `付款操作需财务主管审批，已生成审批工单 ${ticketId}。请等待飞书审批通过后，带上该票据号重新发起以完成付款。合同 ${contractNo}，金额 ${amount} 元。`,
      };
      return result;
    }

    // Case 2: ticket provided but not authorized for this session -> still blocked.
    if (!sessionId || !isAuthorized(authorizedTicketId, sessionId)) {
      const result = {
        ok: false as const,
        status: 'blocked' as const,
        reason: 'ticket_not_authorized',
        authorizedTicketId,
        message: `授权票据 ${authorizedTicketId} 无效或未审批通过，无法执行付款。`,
      };
      return result;
    }

    // Case 3: ticket authorized -> truly execute.
    const payment = recordPayment({ contractNo, amount, authorizedTicketId });
    const result = {
      ok: true as const,
      status: 'executed' as const,
      paymentId: payment.paymentId,
      contractNo: payment.contractNo,
      amount: payment.amount,
      authorizedTicketId: payment.authorizedTicketId,
      paidAt: payment.paidAt,
      message: `付款已执行。付款单号 ${payment.paymentId}，合同 ${payment.contractNo}，金额 ${payment.amount} 元，授权票据 ${payment.authorizedTicketId}。`,
    };
    return result;
  },
});
