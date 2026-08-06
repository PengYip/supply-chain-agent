import { tool } from 'ai';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import type { DbContext } from '../db/client.js';
import {
  saveDocument, loadDocument, saveExtraction, saveBinding,
} from '../db/repositories.js';
import { ingestWithDigital } from '../digitalAdapter.js';
import { ingestWithMinerU } from '../mineruAdapter.js';
import { extractGroundedFields, type ExtractionDeps } from '../extraction.js';
import { linkDocumentToContract } from '../../data/seed.js';
import type { DocType, SourceSpan } from '../types.js';
import type { SpanMatchStrength } from '../spanValidator.js';

export interface ToolDeps {
  ctx: DbContext;
  extraction?: ExtractionDeps; // inject for extract_fields; defaults to real model
}

const newDocId = () => `DOC-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

// T8 deviation from brief (per cross-task directive): T4's createDb omits the
// foreign_keys pragma, and SQLite defaults FK enforcement OFF. Without this,
// extractions/bindings could persist against a phantom document_id. Set it on
// the connection before any write. Idempotent and cheap.
function ensureFk(ctx: DbContext): void {
  ctx.sqlite.pragma('foreign_keys = ON');
}

export function buildIngestDocumentTool(deps: ToolDeps) {
  return tool({
    description:
      '录入一份原始单据(合同/发票/提单/装箱单)。解析文件为结构化 BlockModel 并持久化, 返回 docId 与解析信息。不抽取业务字段(用 extract_fields)。',
    inputSchema: z.object({
      sourceUri: z.string().min(1).describe('本地文件路径 (PDF/TXT/DOCX); scanned 还需配套 <sourceUri>.mineru.json'),
      docType: z.enum(['合同', '发票', '提单', '装箱单', '其他']),
      modality: z.enum(['digital', 'scanned']),
    }),
    execute: async ({ sourceUri, docType, modality }) => {
      ensureFk(deps.ctx);
      const docId = newDocId();
      const dt = docType as DocType;
      const blockModel =
        modality === 'scanned'
          ? await ingestWithMinerU(sourceUri, dt, docId)
          : await ingestWithDigital(sourceUri, dt, docId);
      // Re-ingest guard: docId is freshly generated per call (timestamp + random),
      // so a duplicate-PK constraint is structurally impossible (append-only audit).
      // saveDocument propagates any error rather than silently swallowing.
      saveDocument(deps.ctx, blockModel);
      return { docId, blockCount: blockModel.blocks.length, modality: blockModel.modality };
    },
  });
}

export function buildExtractFieldsTool(deps: ToolDeps) {
  return tool({
    description:
      '从已录入单据(docId)中抽取业务字段。强制原文 span 接地: 每个值必须可在 BlockModel 原文中定位, 否则不自动接受。返回带置信度的字段集 + 是否需人工复核(needsReview)。',
    inputSchema: z.object({
      docId: z.string().min(1),
      docType: z.enum(['合同', '发票', '提单', '装箱单', '其他']),
    }),
    execute: async ({ docId, docType }) => {
      const blockModel = loadDocument(deps.ctx, docId);
      if (!blockModel) return { status: 'error' as const, reason: 'document_not_found' };
      if (!deps.extraction) {
        return { status: 'error' as const, reason: 'extraction_model_not_configured' };
      }
      const result = await extractGroundedFields(deps.extraction, { blockModel, docType: docType as DocType });
      const fieldMeta: Record<string, { strength: SpanMatchStrength; confidence: number }> = {};
      const fields: Record<string, { value: string | number; sourceSpans: SourceSpan[] }> = {};
      for (const f of result.fields) {
        fields[f.name] = { value: f.value, sourceSpans: f.sourceSpans };
        fieldMeta[f.name] = { strength: f.strength, confidence: f.confidence };
      }
      ensureFk(deps.ctx);
      // Zero-hallucination directives:
      //  - empty LLM output (no fields) is surfaced as needsReview + reason, never a silent empty success;
      //  - "neither bucket" (confidence in [0.7,0.9): not needsReview, not autoAccepted) is listed in pendingManual.
      const needsReview = result.needsReview || result.fields.length === 0;
      const pendingManual = result.fields
        .filter((f) => !f.needsReview && !f.autoAccepted)
        .map((f) => f.name);
      const extractionId = saveExtraction(deps.ctx, {
        documentId: docId,
        docType: docType as DocType,
        fields,
        fieldMeta,
        overallConfidence: result.overallConfidence,
        needsReview,
      });
      return {
        extractionId,
        fields: result.fields,
        overallConfidence: result.overallConfidence,
        needsReview,
        missingRequired: result.missingRequired,
        pendingManual,
        reason: result.fields.length === 0 ? 'no_fields_extracted' : undefined,
      };
    },
  });
}

export function buildBindDocumentTool(deps: ToolDeps) {
  return tool({
    description:
      '将已录入并抽取的单据绑定到业务实体(合同号)。L2 操作: 调用方需附带人工授权(needsApproval)。每条绑定记录来源 span 与置信度, 写入审计。',
    inputSchema: z.object({
      documentId: z.string().min(1),
      contractNo: z.string().min(1),
      relation: z.string().min(1).describe('关系类型, 1a 用 primary; 1c 扩展 logistics_for_contract 等'),
      confidence: z.number().min(0).max(1),
      sourceSpan: z.object({
        blockId: z.string(), start: z.number().int(), end: z.number().int(),
      }).describe('证明该绑定的原文 span'),
    }),
    execute: async ({ documentId, contractNo, relation, confidence, sourceSpan }) => {
      ensureFk(deps.ctx);
      const blockModel = loadDocument(deps.ctx, documentId);
      if (!blockModel) return { ok: false as const, reason: 'document_not_found' };
      const bindingId = saveBinding(deps.ctx, {
        documentId, contractNo, relation,
        sourceRefs: [sourceSpan], confidence, createdBy: 'trader-agent',
      });
      // T8 deviation (per cross-task directive): bind extends the existing
      // link_document — also reflect the binding in the in-memory contract graph.
      const linkRes = linkDocumentToContract(contractNo, documentId);
      return { ok: true as const, bindingId, contractNo, documentId, linkedToContract: linkRes.ok };
    },
  });
}
