import { tool } from 'ai';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { findDocument, type OcrField } from '../data/seed.js';
import { tagExternal } from '../harness/injectionDefense.js';
import { recordPendingApproval } from '../harness/sessionStore.js';
import { getSessionId } from '../harness/sessionContext.js';

// HITL tools (T3 + T4). Both L1 (auto-execute, no approval gate).
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

// ---- T4: verify_document_fields (document OCR field check, L1) --------------
//
// Mock field-level OCR verification. High confidence (>=0.9) auto-accept, low
// (<0.7) flagged needsReview. Marked mock -- no real OCR engine.

const VERIFY_REVIEW_THRESHOLD = 0.7;
const VERIFY_AUTO_THRESHOLD = 0.9;

const verifySchema = z.object({
  documentId: z
    .string()
    .describe('单据号，如提单 BL-2024-0920-002 或发票 FP-2024-0920-009'),
  expectedFields: z
    .array(z.string())
    .optional()
    .describe('期望核验的字段名列表，不传则核验该单据所有已知字段'),
});

interface VerifiedField {
  name: string;
  ocrValue: string;
  confidence: number;
  needsReview: boolean;
  autoAccepted: boolean;
  note?: string;
}

export const verifyDocumentFields = tool({
  description:
    '单据字段 OCR 核验：对提单/发票等单据做字段级 OCR 置信度核验，高置信度字段自动接受，低置信度字段标记 needsReview 建议人工复核。对返回 needsReview=true 的字段，必须如实告知用户"OCR 置信度低，建议人工复核"，不得自行决定该字段值。',
  inputSchema: verifySchema,
  execute: async ({ documentId, expectedFields }) => {
    const doc = findDocument(documentId);
    if (!doc) {
      const result = { ok: false as const, status: 'not_found' as const, documentId };
      return result;
    }

    let ocr: OcrField[] = doc.ocrFields ?? [];
    if (expectedFields && expectedFields.length > 0) {
      const want = new Set(expectedFields);
      ocr = ocr.filter((f) => want.has(f.name));
    }

    const fields: VerifiedField[] = ocr.map((f) => {
      const verified: VerifiedField = {
        name: f.name,
        // Injection defense (output:tagged): ocrValue/note are strings read from
        // an untrusted document via mock OCR -- wrap them as DATA so embedded
        // prompt-injection text cannot be executed by the model. confidence/name
        // are not document text and are left untouched.
        ocrValue: tagExternal(f.ocrValue),
        confidence: f.confidence,
        needsReview: f.confidence < VERIFY_REVIEW_THRESHOLD,
        autoAccepted: f.confidence >= VERIFY_AUTO_THRESHOLD,
      };
      if (f.note) verified.note = tagExternal(f.note);
      return verified;
    });

    const overallConfidence =
      fields.length === 0
        ? 0
        : Math.round(
            (fields.reduce((sum, f) => sum + f.confidence, 0) / fields.length) *
              100,
          ) / 100;

    const result = {
      ok: true as const,
      status: 'verified' as const,
      documentId,
      docType: doc.type,
      overallConfidence,
      fields,
      needsManualReview: fields.some((f) => f.needsReview),
    };
    return result;
  },
});
