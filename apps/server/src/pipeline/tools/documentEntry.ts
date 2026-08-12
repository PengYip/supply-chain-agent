import { tool } from 'ai';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import type { DbContext } from '../db/client.js';
import {
  saveDocument, loadDocument, saveExtraction, loadExtraction, saveBinding, saveChunks,
  saveClassification, saveDocumentTags, listDocumentTags,
} from '../db/repositories.js';
import { parseDocument } from '../parseDocument.js';
import { extractGroundedFields, type ExtractionDeps } from '../extraction.js';
import { classifyDocument, classifyDocumentWithoutModel, type ClassifierDeps } from '../classifier.js';
import { deriveAutoTags } from '../tagging.js';
import { chunkBlockModel } from '../chunking.js';
import { linkDocumentToContract } from '../../data/seed.js';
import { tagExternal, assertWithinRoot } from '../../harness/injectionDefense.js';
import type { Embedder } from '../embedder.js';
import { isVecReady, saveChunkVectors } from '../db/vecStore.js';
import type { DocType, Modality, SourceSpan } from '../types.js';
import { validateSpan, type SpanMatchStrength } from '../spanValidator.js';

export interface ToolDeps {
  ctx: DbContext;
  extraction?: ExtractionDeps; // inject for extract_fields; defaults to real model
  /** Phase 2 routing-classify stage. When unset, ingest degrades to the
   *  caller-supplied docType hint (source 'hint', confidence 0). */
  classifier?: ClassifierDeps;
  /** Embedder for the L4 vector recall index (Task 6 v2). When unset OR when
   *  sqlite-vec is unavailable on the connection, ingest skips vector population
   *  and only the FTS5 keyword index (Task 6 v1) is populated. */
  embedder?: Embedder;
  /** Phase 2 business-data isolation: stamp + filter rows by this user. When
   *  unset or empty, the unscoped (legacy/test) path is used -- no filtering. */
  userId?: string;
}

const newDocId = () => `DOC-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

// T8 deviation from brief (per cross-task directive): T4's createDb omits the
// foreign_keys pragma, and SQLite defaults FK enforcement OFF. Without this,
// extractions/bindings could persist against a phantom document_id. Set it on
// the connection before any write. Idempotent and cheap. (Postgres enforces FKs
// by default, so this is a no-op on the postgres backend.)
function ensureFk(ctx: DbContext): void {
  if (ctx.backend === 'sqlite') {
    ctx.sqlite.pragma('foreign_keys = ON');
  }
}

/**
 * Reusable ingest pipeline (Phase 3 bridge): parse -> persist BlockModel ->
 * chunk -> index (FTS5 always; vectors when an embedder is wired and the vector
 * backend is ready). Called by BOTH the ingest_document tool and the /api/files
 * upload route so there is ONE ingest path. Returns the new docId + block count.
 */
export interface IngestOptions {
  ctx: DbContext;
  sourcePath: string;
  /** Caller hint. Classification determines the effective docType when a
   *  classifier is wired; otherwise this hint is used directly. Defaults to '其他'. */
  docType?: DocType;
  modality: Modality;
  classifier?: ClassifierDeps;
  embedder?: Embedder;
  /** Phase 2: owning user for the new document + its chunks. */
  userId?: string;
}

export async function ingestFile(opts: IngestOptions): Promise<{
  docId: string;
  blockCount: number;
  modality: string;
  classifiedDocType: DocType;
  classificationConfidence: number;
  classificationSource: 'classified' | 'hint' | 'fallback';
  tags: string[];
}> {
  const { ctx, sourcePath, docType, modality, embedder, classifier, userId } = opts;
  ensureFk(ctx);
  // Path allowlist (injection defense): reject anything outside INGEST_ROOT.
  const safePath = assertWithinRoot(sourcePath);
  const docId = newDocId();
  // Parse (pure, no DB) — extracted into parseDocument primitive (Phase 1).
  const blockModel = await parseDocument({ sourcePath: safePath, docType: docType ?? '其他', docId, modality });

  // Classify (Phase 2 routing-classify): parsed blocks -> effective docType.
  // Degrades to the hint when no classifier is wired (tests / dev offline).
  const cls = classifier
    ? await classifyDocument(classifier, { blocks: blockModel.blocks, hint: docType })
    : classifyDocumentWithoutModel({ blocks: blockModel.blocks, hint: docType });
  // The classified docType is the source of truth from here on (design §6:
  // routing-classify picks the docType used downstream).
  blockModel.docType = cls.docType;

  await saveDocument(ctx, blockModel, userId);
  await saveClassification(
    ctx,
    { documentId: docId, docType: cls.docType, confidence: cls.confidence, source: cls.source, hint: docType },
    userId,
  );
  const chunks = chunkBlockModel(blockModel);
  const chunkRowIds = await saveChunks(ctx, docId, chunks);
  if (embedder && (await isVecReady(ctx))) {
    try {
      const vecs = await embedder.embed(chunks.map((c) => c.text));
      await saveChunkVectors(
        ctx,
        chunkRowIds.map((id, i) => ({ chunkRowId: id, vec: vecs[i] ?? [] })),
      );
    } catch (e) {
      console.warn(
        '[ingest] vector embedding skipped; FTS5 recall still available:',
        (e as Error).message,
      );
    }
  }
  // Auto-tag (Phase 2): derive a small deterministic tag set from the effective
  // docType + content (design §8: auto-tags are an ingest byproduct, persisted
  // and included in the return summary). Explicit tags come from tag_document.
  // Fault-tolerant like the vector block above: by design a byproduct, so a
  // persistence failure (UNIQUE regression, disk full, locked DB) degrades to
  // an empty tag set instead of killing the already-committed primary result.
  let tags: string[] = [];
  try {
    tags = deriveAutoTags({ docType: blockModel.docType, blocks: blockModel.blocks });
    await saveDocumentTags(ctx, docId, tags, 'auto', userId);
  } catch (e) {
    console.warn('[ingest] auto-tag persistence skipped:', (e as Error).message);
  }

  return {
    docId,
    blockCount: blockModel.blocks.length,
    modality: blockModel.modality,
    classifiedDocType: cls.docType,
    classificationConfidence: cls.confidence,
    classificationSource: cls.source,
    tags,
  };
}

export function buildIngestDocumentTool(deps: ToolDeps) {
  return tool({
    description:
      '录入一份原始单据(合同/发票/提单/装箱单)。解析文件为结构化 BlockModel 并持久化, ' +
      '内置分类器自动判定单据类型(docType 为可选提示, 分类器会确认或纠正)并打自动标签, ' +
      '返回 docId、分类结果(classifiedDocType / confidence / source)与标签。不抽取业务字段(用 extract_fields)。',
    inputSchema: z.object({
      sourceUri: z.string().min(1).describe('本地文件路径 (PDF/TXT/DOCX); scanned 还需配套 <sourceUri>.mineru.json'),
      docType: z.enum(['合同', '发票', '提单', '装箱单', '其他']).optional()
        .describe('可选的单据类型提示; 分类器会确认或纠正。省略时由分类器决定'),
      modality: z.enum(['digital', 'scanned']),
    }),
    execute: async ({ sourceUri, docType, modality }) => {
      return ingestFile({
        ctx: deps.ctx,
        sourcePath: sourceUri,
        docType: docType as DocType | undefined,
        modality: modality as Modality,
        classifier: deps.classifier,
        embedder: deps.embedder,
        userId: deps.userId,
      });
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
      const blockModel = await loadDocument(deps.ctx, docId, deps.userId);
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
      //  - empty LLM output (no fields) is surfaced as needsReview + reason, never a silent empty success.
      const needsReview = result.needsReview || result.fields.length === 0;
      const extractionId = await saveExtraction(
        deps.ctx,
        {
          documentId: docId,
          docType: docType as DocType,
          fields,
          fieldMeta,
          overallConfidence: result.overallConfidence,
          needsReview,
        },
        deps.userId,
      );
      // Bounded summary for the model trajectory. Full evidence (citedText,
      // sourceSpans) stays persisted via saveExtraction and is retrievable on
      // demand via inspect_extraction(extractionId, fieldName). The field VALUE
      // is the only document-derived string leaf exposed here, so wrap it in
      // <external_content> (injection defense: output-tagged).
      const summaryFields = result.fields.map((f) => ({
        name: f.name,
        value: typeof f.value === 'string' ? tagExternal(f.value) : f.value,
        confidence: f.confidence,
        needsReview: f.needsReview,
        autoAccepted: f.autoAccepted,
      }));

      return {
        extractionId,
        fields: summaryFields,
        overallConfidence: result.overallConfidence,
        needsReview,
        missingRequired: result.missingRequired,
        reason: result.fields.length === 0 ? 'no_fields_extracted' : undefined,
      };
    },
  });
}

/**
 * inspect_extraction — L1 perception tool.
 * On-demand evidence drill-down for a SINGLE already-extracted field.
 * Scope boundary: only fields that extract_fields already produced (given by
 * extractionId). NOT a general text-retrieval tool (use recall_documents for
 * arbitrary text). citedText is recomputed from persisted sourceSpans + the
 * loaded BlockModel via validateSpan, so the span validator stays the single
 * source of truth (citedText is never stored separately).
 */
export function buildInspectExtractionTool(deps: ToolDeps) {
  return tool({
    description:
      '查看某个已抽取字段的证据（原文片段 citedText 与 sourceSpans）。' +
      '仅限 extract_fields 已经抽取出的字段（用其返回的 extractionId）。' +
      '不要用它做任意文本检索（那应该用 recall_documents）。' +
      '使用场景：用户想看某字段值在原文哪里、或对抽取结果存疑需要取证时。',
    inputSchema: z.object({
      extractionId: z.string().min(1).describe('extract_fields 返回的 extractionId'),
      fieldName: z.string().min(1).describe('要查看证据的字段名，取自 extract_fields 返回 fields[].name'),
    }),
    execute: async ({ extractionId, fieldName }) => {
      const row = await loadExtraction(deps.ctx, extractionId, deps.userId);
      if (!row) return { status: 'error' as const, reason: 'extraction_not_found' as const };

      const field = row.fields[fieldName];
      if (!field) {
        return {
          status: 'error' as const,
          reason: 'field_not_found' as const,
          availableFields: Object.keys(row.fields),
        };
      }

      const blockModel = await loadDocument(deps.ctx, row.documentId, deps.userId);
      if (!blockModel) return { status: 'error' as const, reason: 'document_not_found' as const };

      // Recompute citedText from persisted spans + BlockModel (DRY): the span
      // validator stays the single source of truth. citedText is never stored.
      const meta = row.fieldMeta[fieldName];
      let citedText: string | null = null;
      let strength: SpanMatchStrength = meta?.strength ?? 'none';
      for (const span of field.sourceSpans) {
        const v = validateSpan(String(field.value), span, blockModel.blocks);
        if (v.citedText) {
          citedText = v.citedText;
          strength = v.strength;
          break;
        }
      }

      return {
        status: 'ok' as const,
        extractionId,
        fieldName,
        value: typeof field.value === 'string' ? tagExternal(field.value) : field.value,
        citedText: citedText ? tagExternal(citedText) : null,
        sourceSpans: field.sourceSpans,
        confidence: meta?.confidence ?? 0,
        strength,
      };
    },
  });
}

/**
 * tag_document — L2 explicit-tagging tool.
 * Adds user/agent-supplied labels to an EXISTING document, any time post-ingest.
 * Distinct from auto-tags (an ingest byproduct, source 'auto') and from graph
 * edges (link_entities, Step 4). Idempotent per (doc, tag, source='explicit'):
 * re-adding the same tag is a no-op. needsApproval (L2) because it mutates
 * business state (the agent must have user consent to label a document).
 */
export function buildTagDocumentTool(deps: ToolDeps) {
  return tool({
    description:
      '为已录入的单据打显式标签(用户/代理人工标注)。可在录入后任意时刻调用。' +
      '与 ingest 时自动生成的标签(来源 auto)不同, 这些标签来源为 explicit。' +
      '图关系(买方/卖方/引用)暂不支持, 将在后续工具中提供。' +
      '使用场景: 用户说"给这份合同打上 重要 / 客户A 标签"时。',
    inputSchema: z.object({
      docId: z.string().min(1).describe('目标单据 docId (来自 ingest_document 返回)'),
      tags: z.array(z.string().min(1)).min(1).describe('要添加的标签数组, 至少一个'),
    }),
    execute: async ({ docId, tags }) => {
      const blockModel = await loadDocument(deps.ctx, docId, deps.userId);
      if (!blockModel) return { status: 'error' as const, reason: 'document_not_found' as const };
      if (tags.length === 0) return { status: 'error' as const, reason: 'no_tags_provided' as const };

      ensureFk(deps.ctx);
      // Compute addedTags by diffing against existing explicit tags for this doc.
      const before = await listDocumentTags(deps.ctx, docId, deps.userId);
      const hadExplicit = new Set(
        before.filter((r) => r.source === 'explicit').map((r) => r.tag),
      );
      const addedTags = tags.filter((t) => !hadExplicit.has(t));
      await saveDocumentTags(deps.ctx, docId, tags, 'explicit', deps.userId);
      const after = await listDocumentTags(deps.ctx, docId, deps.userId);
      return {
        status: 'ok' as const,
        docId,
        addedTags,
        totalTags: after.length,
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
      const blockModel = await loadDocument(deps.ctx, documentId, deps.userId);
      if (!blockModel) return { ok: false as const, reason: 'document_not_found' };
      const bindingId = await saveBinding(
        deps.ctx,
        {
          documentId, contractNo, relation,
          sourceRefs: [sourceSpan], confidence, createdBy: 'trader-agent',
        },
        deps.userId,
      );
      // T8 deviation (per cross-task directive): bind extends the existing
      // link_document — also reflect the binding in the in-memory contract graph.
      const linkRes = linkDocumentToContract(contractNo, documentId);
      return { ok: true as const, bindingId, contractNo, documentId, linkedToContract: linkRes.ok };
    },
  });
}
