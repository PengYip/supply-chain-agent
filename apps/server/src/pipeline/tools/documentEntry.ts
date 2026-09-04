import { tool } from 'ai';
import { z } from 'zod';
import { readFileSync } from 'node:fs';

import type { DbContext } from '../db/client.js';
import {
  saveDocument, loadDocument, saveExtraction, loadExtraction, saveBinding, saveChunks,
  saveClassification, saveDocumentTags, listDocumentTags, getReviewSnapshot,
  applyDocumentCorrections, setDocumentVectorization,
  // Model B (decouple upload from parse): stub + parse-lifecycle repo fns.
  getDocumentSourceUri, setDocumentParseStatus, getDocumentParseStatus, updateDocumentMeta,
  type ParseStatus,
  // Lane A (2a): extraction-status reader + extraction-row probe for
  // ensureDocumentExtracted's re-extraction decision.
  getExtractionStatus, loadLatestExtractionByDocId,
  // 6b 重跑覆盖守卫: 重解析前清空本文档旧 chunk 行(见 processDocument step 7)。
  deleteChunksForDocument,
  // 批量拆分器(spec 2026-09-01): document_units 读写 + batch_role + 子单据存根。
  saveDocumentUnits, listDocumentUnitsByParent, updateDocumentUnitChild, setDocumentBatchRole,
  updateDocumentUnitManifest,
  createDocumentStub,
  deleteDocument,
  clearDocumentUnits,
  failPendingUnitsByParent,
  updateDocumentParseStage,
  type TemplateTypeRow,
  // Phase B bindings state machine.
  listContractLedgerEntries, findBindingByDocAndContract, listBindingProposals,
  updateBindingStatus, listTemplateTypes,
} from '../db/repositories.js';
import {
  detectDocumentUnits,
  BatchSplitPageLimitError,
  CONTAINER_DOC_TYPE,
  UNIT_FORM_TYPE_ALIASES,
  type DetectedUnit,
} from '../batchSplit.js';
import {
  compareReadings,
  CONSENSUS_MISMATCH_CONFIDENCE_CAP,
  unitCandidateScore,
  type DetectionReading,
  type ReadingConsensus,
} from '../batchConsensus.js';
import { renderUnitImages, unitRotationPlans } from '../unitImages.js';
import { classifyOrientation, type OrientationImage, type OrientationResult } from '../orientationClassifier.js';
import { mapLimit } from '../pageRecords.js';
import { syncBatchLineageGraph } from '../batchLineageGraphSync.js';
import { parseDocument } from '../parseDocument.js';
import { extractGroundedFields, type ExtractionDeps } from '../extraction.js';
import { runAutoExtraction, buildAutoExtractionDeps, type AutoExtractionDeps } from '../autoExtraction.js';
import { tagChunks, type ChunkTagger } from '../chunkTagging.js';
import { getTaxonomy, bindingRelationFor } from '../../domain/tradeSemantics.js';
import { classifyDocument, classifyDocumentWithoutModel, buildClassifierVocab, type ClassifierDeps } from '../classifier.js';
import { deriveAutoTags } from '../tagging.js';
import { chunkBlockModel } from '../chunking.js';
import { linkDocumentToContract } from '../../data/seed.js';
import { tagExternal, assertWithinRoot } from '../../harness/injectionDefense.js';
import { classifyProviderError } from '../../harness/providerErrors.js';
import { isVectorizableDocType, SKIP_REASON_NOT_VECTORIZABLE } from '../vectorPolicy.js';
import type { Embedder } from '../embedder.js';
import { isVecReady, saveChunkVectors } from '../db/vecStore.js';
import type { BlockModel, DocType, Modality, SourceSpan } from '../types.js';
import { validateSpan, type SpanMatchStrength } from '../spanValidator.js';
import { buildLedgerEntryFromExtraction } from '../contractLedger.js';
import { upsertContractLedgerEntry } from '../db/repositories.js';
import { extractVoucher, extractVoucherTyped, mimeForExtension, type VlmResult } from '../vlmAdapter.js';
import { classifyForm, type FormClassifyResult } from '../vlmClassifier.js';
import { buildFormTypeIndex, collectFormTypes } from '../formTypeRegistry.js';
import { renderPdfPages, type RenderedPage } from '../pdfRender.js';
import { extractWeightDoc, type WeightDocType } from '../pageRecords.js';
import { pdfHasTextLayer } from '../digitalAdapter.js';
import { VOUCHER_SCHEMAS, WEIGHT_AGGREGATE_DOCTYPES, validateVoucher, type VoucherType } from '../schemas/vouchers.js';
import { extractAnchors } from '../schemas/vouchers.js';
import { generateBindingProposals, type BindingRoute } from '../bindingProposal.js';
import { ancestorChain, matchEdgeRule } from '../templateGuard.js';
import { listActiveEdgeRules } from '../db/repositories.js';
import { materializeExecutionFlow, refreshExecutionFlowsForDocument, getEffectiveSelfPartyNames } from '../executionFlow.js';
import { deriveContractType, type ContractTypeDerivation } from '../../domain/contractType.js';
import type { ContractType } from '../../domain/tradeSemantics.js';
import { proposeProjectMemberships } from '../projectProposal.js';
import { createProject, upsertProjectMembership } from '../db/repositories.js';
import { StageProfiler } from '../perf.js';
import { env } from '../../env.js';

/** Phase A: 图片凭证 VLM 解析依赖(可注入 fake 供测试; 缺省用真实 extractVoucher)。
 *  v2.1 双分支: 可选注入 classify/extractTyped/extractOne, 缺省用真实实现。 */
export interface VlmDeps {
  extract: (buffer: Buffer, mime: string) => Promise<VlmResult>;
  /** VLM 表单分类注入(缺省真实 classifyForm, 需 VLM 配置)。 */
  classify?: (input: {
    page: { mime: string; buffer: Buffer };
    formTypes: string[];
  }) => Promise<FormClassifyResult>;
  /** 按已知类型多图提取注入(缺省真实 extractVoucherTyped)。 */
  extractTyped?: (
    images: Array<{ mime: string; buffer: Buffer }>,
    docType: string,
  ) => Promise<{ fields: Record<string, unknown>; 字段置信度: Record<string, number> }>;
  /** 重量组单页提取注入(缺省真实 extractVoucherTyped 单图)。 */
  extractOne?: (
    image: { mime: string; buffer: Buffer },
    docType: string,
  ) => Promise<{ fields: Record<string, unknown> }>;
  /** 批量拆分器: 逐页版面清点调用注入(缺省真实 vlmCall, 需 VLM 配置)。 */
  detectUnits?: (
    prompt: string,
    page: { page: number; mime: string; buffer: Buffer },
  ) => Promise<string>;
}

export interface ToolDeps {
  ctx: DbContext;
  extraction?: ExtractionDeps; // inject for extract_fields; defaults to real model
  /** Lane B: per-chunk semantic tagger. When set, ingest tags chunks against the
   *  docType's closed taxonomy (getTaxonomy); unset -> chunks stored untagged. */
  tagger?: ChunkTagger;
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
  /** Phase A: 图片凭证 VLM 解析依赖。缺省用真实 extractVoucher(需 VLM 配置);
   *  测试注入 fake 以离线验证图片分支。 */
  vlm?: VlmDeps;
}

/**
 * Outcome of the L4 vector-embedding step of ingest. Surfaced on the ingestFile
 * return so the model/UI can report whether vectorization succeeded and which
 * mode was used. `status`:
 *  - 'ok'      : vectors written for all chunks (mode = embedder.kind).
 *  - 'skipped' : no embedder wired, OR sqlite-vec unavailable on the connection
 *                (reason 'vec_store_not_ready'); FTS5 recall still serves.
 *  - 'failed'  : embedder threw; FTS5 recall still serves (reason = error message).
 */
export type VectorizationStatus = {
  status: 'ok' | 'skipped' | 'failed';
  mode: string;
  chunkCount: number;
  reason?: string;
};

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

// ---- 接线闭环: 合同台账回写 -----------------------------------------------
//
// 抽取成功后把合同号等字段回写到 contract_ledger 台账, 使 query_contract 能立即
// 查到录入文档的合同(而不是 notFound)。台账回写是抽取的旁路 byproduct:
// writeContractLedger 永不抛出, 任何失败只 console.error, 绝不把已完成的
// save/抽取结果翻成失败。

/** 录入侧合同类型派生(纯函数 + 有效主体名单; 名单读取失败按空名单降级)。 */
async function deriveContractTypeForDoc(args: {
  ctx: DbContext;
  docType: string;
  fields: Record<string, { value: string | number; confidence?: number }>;
}): Promise<ContractTypeDerivation> {
  let names: string[] = [];
  try { names = await getEffectiveSelfPartyNames(args.ctx); } catch { names = []; }
  return deriveContractType({
    docType: args.docType,
    fields: Object.entries(args.fields).map(([name, f]) => ({ name, value: f.value })),
    selfPartyNames: names,
  });
}

// 项目归属自动提议(spec 2026-08-20 §4.2): 故障隔离, 失败只告警。createProject 幂等
// (已存在忽略), membership 以 (contractNo, projectCode) upsert 为 proposed。
async function writeProjectProposals(args: {
  ctx: DbContext;
  docType: string;
  fields: Record<string, { value: string | number; confidence?: number }>;
  contractType: ContractType | null;
  userId?: string;
}): Promise<void> {
  const proposals = proposeProjectMemberships({
    docType: args.docType,
    fields: Object.entries(args.fields).map(([name, f]) => ({ name, value: f.value, confidence: f.confidence ?? 0 })),
    contractType: args.contractType,
  });
  for (const p of proposals) {
    await createProject(args.ctx, { code: p.projectCode, name: p.projectName, userId: args.userId });
    await upsertProjectMembership(args.ctx, {
      contractNo: p.contractNo,
      projectCode: p.projectCode,
      role: p.role,
      status: 'proposed',
      proposedBy: 'system',
      confirmationSource: null,
      confidence: p.confidence,
      createdBy: 'system',
    }, args.userId);
  }
}

/**
 * Fault-isolated ledger write-back. buildLedgerEntryFromExtraction 返回 null
 * (无有效合同号, 如发票/提单) 时静默跳过; 其余路径的失败也只记日志。
 */
async function writeContractLedger(args: {
  ctx: DbContext;
  docId: string;
  docType: DocType;
  fields: Record<string, { value: string | number; sourceSpans: SourceSpan[] }>;
  fieldMeta: Record<string, { strength: SpanMatchStrength; confidence: number }>;
  userId?: string;
  contractType?: ContractType | null;
}): Promise<void> {
  try {
    const entry = buildLedgerEntryFromExtraction({
      documentId: args.docId,
      docType: args.docType,
      fields: args.fields,
      fieldMeta: args.fieldMeta,
      userId: args.userId,
      contractType: args.contractType,
    });
    if (!entry) return; // 无有效合同号 -> 不回写台账
    await upsertContractLedgerEntry(args.ctx, entry, args.userId);
  } catch (e) {
    console.error('[contractLedger] 台账回写失败:', (e as Error).message);
  }
}

/**
 * 复用点(extractionBackfill 等): 把台账回写挂到 AutoExtractionDeps.save 之后。
 * 原 save 成功后写台账(writeContractLedger 永不抛出, 所以 runAutoExtraction
 * 的容错语义不变 -- ledger 失败不会把 outcome 从 ok 翻成 failed)。
 */
export function buildLedgerWritingDeps(
  baseDeps: AutoExtractionDeps,
  opts: { ctx: DbContext; docType: DocType; userId?: string },
): AutoExtractionDeps {
  return {
    ...baseDeps,
    save: async (args) => {
      await baseDeps.save(args);
      const derivation = await deriveContractTypeForDoc({
        ctx: opts.ctx,
        docType: opts.docType,
        fields: args.fields,
      });
      await writeContractLedger({
        ctx: opts.ctx,
        docId: args.docId,
        docType: opts.docType,
        fields: args.fields,
        fieldMeta: args.fieldMeta,
        userId: args.userId,
        contractType: derivation.contractType,
      });
      // 项目归属自动提议(spec §4.2): 台账写回之后的旁路钩子, 故障隔离绝不阻塞录入。
      try {
        await writeProjectProposals({
          ctx: opts.ctx,
          docType: opts.docType,
          fields: Object.fromEntries(
            Object.entries(args.fields).map(([name, f]) => [
              name,
              { value: f.value, confidence: args.fieldMeta[name]?.confidence ?? 0 },
            ]),
          ),
          contractType: derivation.contractType,
          userId: args.userId ?? opts.userId,
        });
      } catch (e) {
        console.error('[documentEntry] 项目归属提议失败:', (e as Error).message);
      }
    },
  };
}

// ---- Phase A: 图片凭证 VLM 解析分支 ------------------------------------------
//
// 业务凭证(银行回单/货权转移单/化验报告, jpg/png 照片)无法走文本解析路径
// (digitalAdapter 按 utf-8 读图片是乱码, OCR 回退仅限 .pdf)。本分支在
// ingestFile 层分流: 扩展名 .jpg/.jpeg/.png -> VLM 端到端提取 -> zod 校验 ->
// 交叉校验 warnings -> 落库(document/classification/单chunk/extraction)。
// 不触发合同抽取/ledger 回写(writeContractLedger 仅合同类); VLM 失败时
// parse_status 置 'failed'(错误可追溯), 不静默成功。

const VOUCHER_IMAGE_EXT = /\.(jpe?g|png)$/i;

function isVoucherImage(sourcePath: string): boolean {
  return VOUCHER_IMAGE_EXT.test(sourcePath);
}

/** 把凭证字段序列化为紧凑中文 KV 文本(单虚拟 chunk 用): 编号:xxx 合同号:xxx ...,
 *  明细行/指标等数组拍平为 行N.字段:值。 */
function voucherFieldsToText(voucherType: VoucherType, fields: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(fields)) {
    if (v === null || v === undefined) continue;
    if (Array.isArray(v)) {
      v.forEach((row, i) => {
        if (row === null || typeof row !== 'object') return;
        for (const [rk, rv] of Object.entries(row as Record<string, unknown>)) {
          if (rv === null || rv === undefined) continue;
          parts.push(`${k}${i + 1}.${rk}:${String(rv)}`);
        }
      });
    } else {
      parts.push(`${k}:${String(v)}`);
    }
  }
  return parts.join(' ');
}

interface VoucherIngestInput {
  ctx: DbContext;
  sourcePath: string;
  docId: string;
  embedder?: Embedder;
  userId?: string;
  vlm?: VlmDeps;
  /** v2.1 双分支: PDF 凭证路由命中时携带(已渲染页 + 路由确定的业务类型)。
   *  存在时跳过单图读取, 走逐页聚合(重量组)或多图一次提取(其余组)。 */
  pdfVoucher?: { docType: DocType; pages: RenderedPage[] };
  /** Phase 2 批量拆分: unit 子单据的裁剪图凭证抽取(与 pdfVoucher 同构,
   *  额外携带旋回候选与检测遍读数)。 */
  unitVoucher?: UnitVoucherInput;
}

/** 批量拆分器 Phase 2 的 unit 凭证抽取输入。 */
export interface UnitVoucherInput {
  docType: DocType;
  /** 旋回候选图集(0/180 单候选; 90/270 双候选), rotations 为逐 region 的
   *  顺时针旋回度数(与 images 一一对应, 审计/择优日志用)。 */
  candidates: Array<{ rotations: number[]; images: RenderedPage[] }>;
  /** 检测遍读数(两遍共识 + 候选择优用)。 */
  detection: DetectionReading;
  /** unit 页区间的 OCR 块模型(保留给 chunk/recall, 与 Phase 1 一致)。 */
  ocrBlockModel: BlockModel;
  /** P3 择优旋回落库: 双候选择优胜出后把最终方向与择优证据写回 unit 行
   *  (fire-and-forget, 失败不阻断)。单候选(0/180)无择优不写。 */
  unitId?: string;
  /** unit 行当前 manifest(写回时合并 chosenRotation/candidateScores)。 */
  unitManifest?: Record<string, unknown>;
  /** 方向分类探针锚定信息(2026-09-04): 锚定模式(ANCHOR<=score<MIN)时随 P3
   *  择优写回 manifest(rotationSource='classifier-anchor' + classifierScore),
   *  chosenRotation/chosenRotations 以 P3 择优结果为准。 */
  classifierAnchor?: { rotation: number; score: number };
}

/** runVoucherPipeline / ingestVoucherImage 的返回形状(与 ingestFile 一致)。 */
interface VoucherPipelineResult {
  docId: string;
  blockCount: number;
  modality: string;
  classifiedDocType: DocType;
  classificationConfidence: number;
  classificationSource: 'classified' | 'hint' | 'fallback';
  tags: string[];
  vectorization: VectorizationStatus;
  bindingProposals: Array<{ contractNo: string; score: number; route: BindingRoute }>;
}

/**
 * pdfVoucher / unitVoucher 共用的按类型页图提取(纯编排, 无落库):
 * 重量组(WEIGHT_AGGREGATE_DOCTYPES)逐图单抽 + 服务端聚合, 其余类型多图
 * 一次提取。opts.pageConcurrency 限制重量组页级并发(unit 路径并发已由
 * 外层 unit 并发限制, 传较小值控制全局 VLM 在飞数)。
 */
async function extractVoucherPages(
  pages: RenderedPage[],
  dt: VoucherType,
  vlm: VlmDeps | undefined,
  opts: { pageConcurrency?: number } = {},
): Promise<{ result: VlmResult; warnings: string[]; okPages: number[]; failedPages: number[] }> {
  if (WEIGHT_AGGREGATE_DOCTYPES.has(dt)) {
    const agg = await extractWeightDoc(pages, dt as WeightDocType, {
      concurrency: opts.pageConcurrency,
      extractOne: vlm?.extractOne
        ? async (image, d) => vlm.extractOne!(image, d)
        : undefined,
    });
    return {
      result: { voucherType: dt, fields: agg.fields, 字段置信度: {} },
      warnings: agg.warnings,
      okPages: agg.okPages,
      failedPages: agg.failedPages,
    };
  }
  const typed = await (vlm?.extractTyped ?? extractVoucherTyped)(
    pages.map((p) => ({ mime: p.mime, buffer: p.buffer })),
    dt as Exclude<VoucherType, '其他'>,
  );
  return {
    result: { voucherType: dt, fields: typed.fields, 字段置信度: typed.字段置信度 },
    warnings: [],
    okPages: pages.map((p) => p.page),
    failedPages: [],
  };
}

/**
 * 图片凭证 VLM 流水线核心(可复用, 步骤 2-10): 在 EXISTING docId 上执行
 * VLM 提取 -> zod 校验 -> 交叉校验 warnings -> 合成 block_model
 * (updateDocumentMeta) -> 分类(source 'classified') -> 单 chunk + embed ->
 * 自动标签 -> 向量化状态 -> saveExtraction(字段置信度 + _warnings,
 * overallConfidence=min, needsReview) -> 绑定建议(fault-tolerant) ->
 * parse_status='parsed'。调用方负责前置占位/状态(ingestVoucherImage 落占位行
 * 并置 'parsing'; processDocument 在调用前已置 'parsing')。失败时 parse_status
 * 置 'failed' 并 rethrow(调用方决定转 STATE)。
 */
async function runVoucherPipeline(input: VoucherIngestInput): Promise<VoucherPipelineResult> {
  const { ctx, sourcePath, docId, embedder, userId, vlm, pdfVoucher, unitVoucher } = input;
  const perf = new StageProfiler(`voucher docId=${docId}`);
  try {
    // 2. VLM 提取(可注入 fake; 缺省真实 extractVoucher, 未配置时抛明确错误)。
    //    v2.1 双分支: pdfVoucher 携带路由确定的 docType + 渲染页 -> 重量组逐页聚合,
    //    其余组多图一次提取; 无 pdfVoucher = 现有单图路径(jpg/png, 类型由 VLM 自报)。
    //    Phase 2(unitVoucher): 裁剪图 + 旋回双候选(90/270 方向不可分辨, 各抽一次
    //    按共识+置信度择优) + 两遍读数共识(分歧压置信度并强制 needs_review)。
    let result: VlmResult;
    let routeWarnings: string[] = [];
    let consensus: ReadingConsensus | null = null;
    if (unitVoucher) {
      const dt = unitVoucher.docType as VoucherType;
      if (!(dt in VOUCHER_SCHEMAS)) {
        throw new Error(`凭证类型 ${dt} 无注册 schema, 不应进入 VLM 凭证分支`);
      }
      if (unitVoucher.candidates.length === 0) {
        throw new Error('unit 凭证抽取缺少旋回候选图');
      }
      interface CandidateAttempt {
        rotations: number[];
        result: VlmResult;
        warnings: string[];
        consensus: ReadingConsensus;
      }
      const attempts: CandidateAttempt[] = [];
      const failures: string[] = [];
      for (const cand of unitVoucher.candidates) {
        try {
          const ex = await extractVoucherPages(cand.images, dt, vlm, { pageConcurrency: 2 });
          attempts.push({
            rotations: cand.rotations,
            ...ex,
            consensus: compareReadings(unitVoucher.detection, ex.result.fields),
          });
        } catch (e) {
          const reason = e instanceof Error ? e.message : String(e);
          // 分类可见性(2026-09-02): 供应商级失败(欠费/限流/内容安全拦截等)
          // 逐候选告警; 失败仍只进 failures 汇总, 择优/报错行为不变。
          const cls = classifyProviderError(e);
          if (cls.code) {
            console.warn(`[batch-split] unit 凭证候选提取失败(${cls.shortLabel}): rot=[${cand.rotations.join('/')}] ${reason}`);
          }
          failures.push(`rot=[${cand.rotations.join('/')}] ${reason}`);
        }
      }
      if (attempts.length === 0) {
        throw new Error(`全部旋回候选提取失败: ${failures.join('; ')}`);
      }
      // 择优: 两遍共识命中 > 字段置信度均值 > 字段覆盖(unitCandidateScore)。
      // 检测方向先验(2026-09-04 宣威事故): 候选计划 0 = 检测方向(unitRotationPlans
      // 保证), 给与检测方向一致的候选 +DETECTION_DIRECTION_PRIOR, 防共识噪声
      // (数字型单据上 mismatch 是噪声)把正确方向翻成 180° 颠倒。
      const detectedRotation = unitVoucher.candidates[0]!.rotations[0] ?? null;
      const scored = attempts
        .map((a) => ({
          a,
          score: unitCandidateScore({
            fields: a.result.fields,
            fieldConfidences: a.result.字段置信度,
            mismatchCount: a.consensus.mismatches.length,
            rotations: a.rotations,
            detectedRotation,
          }),
        }))
        .sort((x, y) => y.score - x.score);
      const best = scored[0]!.a;
      result = best.result;
      routeWarnings = best.warnings;
      consensus = best.consensus;
      if (unitVoucher.candidates.length > 1) {
        console.log(
          `[perf-batch-split] unit docId=${docId} ${dt} 旋回双候选 ` +
          scored
            .map((s) => `rot=[${s.a.rotations.join('/')}] score=${s.score.toFixed(2)} mismatch=${s.a.consensus.mismatches.length}`)
            .join(' vs ') +
          ` -> 取 rot=[${best.rotations.join('/')}]`,
        );
        // P3 择优旋回落库(双候选才有择优): 最终方向 + 择优证据写回 unit 行,
        // 「来源与拆分」区块据此展示。fire-and-forget, 失败不阻断抽取主流程。
        // chosenRotations 为逐区域 winner(跨页混合旋回 unit 的预览/展示精确值)。
        if (unitVoucher.unitId) {
          const chosenRotation = best.rotations[0] ?? 0;
          void updateDocumentUnitManifest(ctx, unitVoucher.unitId, {
            rotationDeg: chosenRotation,
            manifest: {
              ...unitVoucher.unitManifest,
              chosenRotation,
              chosenRotations: best.rotations,
              candidateScores: scored.map((s) => ({
                rot: s.a.rotations[0] ?? 0,
                score: s.score,
                mismatch: s.a.consensus.mismatches.length,
              })),
              // 锚定模式: 随 P3 择优写回分类器来源与置信(不覆盖 P3 的 chosen 值)。
              ...(unitVoucher.classifierAnchor
                ? { rotationSource: 'classifier-anchor', classifierScore: unitVoucher.classifierAnchor.score }
                : {}),
            },
          }).catch(() => {});
        }
      }
      perf.mark(
        'vlm_extract_unit',
        `${dt} rot=[${best.rotations.join('/')}] candidates=${attempts.length}/${unitVoucher.candidates.length}`,
      );
    } else if (pdfVoucher) {
      const dt = pdfVoucher.docType;
      if (!(dt in VOUCHER_SCHEMAS)) {
        throw new Error(`凭证类型 ${dt} 无注册 schema, 不应进入 VLM 凭证分支`);
      }
      const ex = await extractVoucherPages(pdfVoucher.pages, dt as VoucherType, vlm);
      result = ex.result;
      routeWarnings = ex.warnings;
      perf.mark(
        WEIGHT_AGGREGATE_DOCTYPES.has(dt as VoucherType) ? 'vlm_extract_pages' : 'vlm_extract_typed',
        `${dt} ok=${ex.okPages.length} failed=${ex.failedPages.length}`,
      );
    } else {
      const ext = sourcePath.split('.').pop() ?? '';
      const mime = mimeForExtension(ext);
      if (!mime) {
        throw new Error(`不支持的图片扩展名 .${ext}，仅支持 jpg/jpeg/png`);
      }
      const buffer = readFileSync(sourcePath);
      const extract = vlm?.extract ?? extractVoucher;
      result = await extract(buffer, mime);
    }
    perf.mark('vlm_extract', `${result.voucherType}`);

    // 3. zod 校验(按 voucherType 选 schema; '其他' 无 schema 跳过)。
    const voucherType = result.voucherType;
    const schema = voucherType === '其他' ? undefined : VOUCHER_SCHEMAS[voucherType];
    if (schema) {
      const parsed = schema.safeParse(result.fields);
      if (!parsed.success) {
        const detail = parsed.error.issues
          .map((i) => `${i.path.join('.') || '(root)'} ${i.message}`)
          .join('; ');
        throw new Error(`凭证字段校验失败(${voucherType}): ${detail}`);
      }
    }
    const warnings = [...validateVoucher(voucherType, result.fields), ...routeWarnings];
    // Phase 2 两遍读数共识: 检测遍 evidence/identifier vs 抽取遍读数(设计 §5.3)。
    // 分歧进入 _warnings(审核卡可见), 并在步骤 8 压置信度 + 强制 needs_review。
    if (consensus) warnings.push(...consensus.mismatches.map((m) => m.message));
    const docType = voucherType as DocType;
    perf.mark('validate', `${warnings.length} warnings`);

    // 4. block_model: 单据级 = 单合成块; unit 子单据 = 页区间 OCR 块(保留给
    //    chunk/recall, 与 Phase 1 一致) + 凭证 KV 合成块(空 OCR 也有召回文本)。
    const chunkText = voucherFieldsToText(result.voucherType, result.fields);
    let blockModel: BlockModel;
    let chunks: Array<{ text: string; index: number }>;
    if (unitVoucher) {
      const ocr = unitVoucher.ocrBlockModel;
      const lastOcrPage = ocr.blocks.length > 0 ? ocr.blocks[ocr.blocks.length - 1]!.page : 1;
      blockModel = {
        docId,
        docType,
        modality: ocr.modality,
        blocks: [
          ...ocr.blocks,
          { id: 'b-voucher', type: 'text', text: chunkText, page: lastOcrPage, bbox: null, ocrConfidence: 1.0 },
        ],
        sourceUri: sourcePath,
        createdAt: new Date().toISOString(),
      };
      chunks = chunkBlockModel(blockModel);
    } else {
      blockModel = {
        docId,
        docType,
        modality: 'scanned',
        blocks: [
          {
            id: 'b0',
            type: 'text',
            text: chunkText,
            page: 1,
            bbox: null,
            ocrConfidence: 1.0,
          },
        ],
        sourceUri: sourcePath,
        createdAt: new Date().toISOString(),
      };
      chunks = [{ text: chunkText, index: 0 }];
    }
    if (chunks.length === 0) chunks = [{ text: chunkText, index: 0 }];
    await updateDocumentMeta(ctx, docId, { docType, modality: blockModel.modality, blockModel }, userId);
    perf.mark('save_meta');

    // 5. 分类: source 'classified', confidence 用 VLM 自报类型置信;
    //    pdfVoucher 路径类型由路由确定(无自报), 有路由 warnings 时降到 0.7。
    const typeConf = result.字段置信度['voucherType'] ?? result.字段置信度['凭证类型'];
    const classificationConfidence =
      typeof typeConf === 'number' ? typeConf : routeWarnings.length > 0 ? 0.7 : 0.9;
    await saveClassification(
      ctx,
      { documentId: docId, docType, confidence: classificationConfidence, source: 'classified', hint: docType },
      userId,
    );
    perf.mark('save_classification');

    // 6. chunk + 按类型策略嵌入(spec 2026-08-27): 单据级 = 单虚拟 KV chunk;
    //    unit 子单据 = OCR 块 chunk(含 KV 合成块)。仅合同/立项书子树进入
    //    向量库; 其余类型跳过(FTS5 召回不受影响)。空文本防御: trim 为空的块
    //    不进入 embed 输入(防单个空串导致整批 /v1/embeddings 400)。
    const chunkRowIds = await saveChunks(ctx, docId, chunks);
    perf.mark('save_chunks');
    const templateTypes = await listTemplateTypes(ctx);
    const embeddable = chunkRowIds
      .map((id, i) => ({ chunkRowId: id!, text: chunks[i]!.text }))
      .filter((x) => x.text.trim().length > 0);
    let vectorization: VectorizationStatus = { status: 'skipped', mode: 'none', chunkCount: chunks.length };
    if (!isVectorizableDocType(docType, templateTypes)) {
      vectorization = {
        status: 'skipped', mode: embedder?.kind ?? 'none', chunkCount: chunks.length,
        reason: SKIP_REASON_NOT_VECTORIZABLE,
      };
      perf.mark('embed', `skipped not-vectorizable ${docType}`);
    } else if (embeddable.length === 0) {
      vectorization = { status: 'skipped', mode: embedder?.kind ?? 'none', chunkCount: chunks.length, reason: '无有效文本块' };
      perf.mark('embed', 'skipped empty-text');
    } else if (embedder) {
      if (await isVecReady(ctx)) {
        try {
          const vecs = await embedder.embed(embeddable.map((x) => x.text));
          await saveChunkVectors(
            ctx,
            embeddable.map((x, i) => ({ chunkRowId: x.chunkRowId, vec: vecs[i] ?? [] })),
          );
          vectorization = { status: 'ok', mode: embedder.kind, chunkCount: chunks.length };
          perf.mark('embed', `ok ${embedder.kind}`);
        } catch (e) {
          vectorization = {
            status: 'failed', mode: embedder.kind, chunkCount: chunks.length,
            reason: (e as Error).message,
          };
          perf.mark('embed', `failed ${embedder.kind}`);
          console.warn('[ingestVoucherImage] vector embedding failed; FTS5 recall still available:', vectorization.reason);
        }
      } else {
        vectorization = { status: 'skipped', mode: embedder.kind, chunkCount: chunks.length, reason: 'vec_store_not_ready' };
        perf.mark('embed', 'skipped vec_store_not_ready');
      }
    } else {
      perf.mark('embed', 'skipped no-embedder');
    }

    // 7. 自动标签(byproduct, 容错)。
    let tags: string[] = [];
    try {
      tags = deriveAutoTags({ docType, blocks: blockModel.blocks });
      await saveDocumentTags(ctx, docId, tags, 'auto', userId);
      perf.mark('auto_tags', tags.join(',') || 'none');
    } catch (e) {
      perf.mark('auto_tags', 'failed');
      console.error('[ingestVoucherImage] auto-tag persistence failed:', (e as Error).message);
    }

    try {
      await setDocumentVectorization(ctx, docId, vectorization, userId);
      perf.mark('vec_meta');
    } catch (e) {
      console.error('[ingestVoucherImage] vectorization_meta persistence failed:', (e as Error).message);
    }

    // 8. saveExtraction: 标量字段原生值, 数组/对象字段 JSON 序列化(保留全部数据);
    //    sourceSpans 空数组(图片无文本块, 现有 schema 允许空数组)。
    //    field_meta 携带 字段置信度 + _warnings(交叉校验结果)。
    const fields: Record<string, { value: string | number; sourceSpans: SourceSpan[] }> = {};
    const fieldMeta: Record<string, { strength: SpanMatchStrength; confidence: number }> = {};
    for (const [k, v] of Object.entries(result.fields)) {
      if (v === null || v === undefined) continue;
      const value = typeof v === 'object' ? JSON.stringify(v) : v;
      fields[k] = { value: typeof value === 'number' ? value : String(value), sourceSpans: [] };
      const conf = result.字段置信度[k];
      fieldMeta[k] = { strength: 'none', confidence: typeof conf === 'number' ? conf : 0.9 };
    }
    const confidences = Object.values(fieldMeta).map((m) => m.confidence);
    let overallConfidence = confidences.length > 0 ? Math.min(...confidences) : 0.9;
    let needsReview = warnings.length > 0 || overallConfidence < 0.85;
    if (consensus && consensus.mismatches.length > 0) {
      // Phase 2 两遍读数分歧(设计 §5.3): 模糊拼贴照片的数字读数不可自动入
      // 台账——压低 overall_confidence, 涉及字段置信度同步压低, 强制人工复核。
      overallConfidence = Math.min(overallConfidence, CONSENSUS_MISMATCH_CONFIDENCE_CAP);
      for (const m of consensus.mismatches) {
        for (const fieldKey of m.fields) {
          const meta = fieldMeta[fieldKey];
          if (meta) meta.confidence = Math.min(meta.confidence, CONSENSUS_MISMATCH_CONFIDENCE_CAP);
        }
      }
      needsReview = true;
    }
    (fieldMeta as Record<string, unknown>)['_warnings'] = {
      strength: 'none',
      confidence: 1,
      warnings,
    };
    await saveExtraction(
      ctx,
      {
        documentId: docId,
        docType,
        fields,
        fieldMeta,
        overallConfidence,
        needsReview,
      },
      userId,
    );
    perf.mark('save_extraction', `${Object.keys(fields).length} fields`);

    // 9. Phase B: 绑定建议生成 + 落库(失败不阻断入库, 同 auto-tags 模式)。
    //    锚点 -> 与合同台账匹配 -> 多锚点评分 -> 阈值路由(auto_rule/human/none)。
    const bindingProposals: Array<{ contractNo: string; score: number; route: BindingRoute }> = [];
    try {
      const anchors = extractAnchors(result.voucherType, result.fields);
      const ledger = await listContractLedgerEntries(ctx, userId);
      // anchorWeights 接线(终审遗留②): 读 docType 激活 binds 规则的 anchorWeights,
      // 非空传第三参, null 回退缺省(不传 = WEIGHTS 缺省行为)。
      // types 复用步骤 6 已加载的 templateTypes(同请求内只查一次)。
      const types = templateTypes;
      const rules = await listActiveEdgeRules(ctx);
      const byId = new Map(types.map((t) => [t.id, t]));
      const chain = ancestorChain(byId.get(`dt-${result.voucherType}`)?.id ?? null, byId);
      const rule = matchEdgeRule({ rules, sourceChain: chain, targetChain: [''], edgeType: 'binds' });
      const weights = rule?.anchorWeights ?? undefined;
      const proposals = generateBindingProposals(anchors, ledger, weights);
      let persisted = 0;
      for (const p of proposals.filter((x) => x.route !== 'none')) {
        try {
          const bindingId = await saveBinding(
            ctx,
            {
              documentId: docId,
              contractNo: p.contractNo,
              relation: bindingRelationFor(result.voucherType),
              confidence: p.score,
              status: p.route === 'auto_rule' ? 'confirmed' : 'proposed',
              confirmationSource: p.route === 'auto_rule' ? 'auto_rule' : null,
              proposedBy: 'system',
              evidence: p.evidence,
              sourceRefs: [],
              createdBy: 'system',
            },
            userId,
          );
          persisted++;
          bindingProposals.push({ contractNo: p.contractNo, score: p.score, route: p.route });
          // 执行流水物化(hook): auto_rule 直连确认(合同号精确命中)后物化; 失败仅告警。
          if (p.route === 'auto_rule') {
            try {
              await materializeExecutionFlow(ctx, {
                documentId: docId, contractNo: p.contractNo, bindingId,
                confidence: p.score, createdBy: 'auto_rule',
              }, userId);
            } catch (e) {
              console.warn('[executionFlow] 自动确认绑定物化执行流水失败:', (e as Error).message);
            }
          }
        } catch (e) {
          console.warn('[ingestVoucherImage] binding proposal persistence failed:', (e as Error).message);
        }
      }
      perf.mark('binding_proposals', `${persisted}/${proposals.length}`);
    } catch (e) {
      perf.mark('binding_proposals', 'failed');
      console.warn('[ingestVoucherImage] binding proposal generation failed:', (e as Error).message);
    }

    // 10. 成功: parse_status='parsed'。
    await setDocumentParseStatus(ctx, docId, 'parsed', userId);
    perf.mark('stamp_parsed');
    perf.finish();

    return {
      docId,
      blockCount: blockModel.blocks.length,
      modality: blockModel.modality,
      classifiedDocType: docType,
      classificationConfidence,
      classificationSource: 'classified',
      tags,
      vectorization,
      bindingProposals,
    };
  } catch (e) {
    // VLM 失败 -> parse_status='failed'(错误可追溯), 不静默成功。
    perf.finish(`failed: ${e instanceof Error ? e.message : String(e)}`);
    await setDocumentParseStatus(ctx, docId, 'failed', userId).catch(() => {});
    throw e;
  }
}

/**
 * 图片凭证 VLM 入库(ingestFile 层分流入口)。先落占位 document 行
 * (parse_status='parsing')使 VLM 失败时可追溯(parse_status='failed'), 成功后
 * updateDocumentMeta 换成真实 block_model 并置 'parsed'。返回与 ingestFile
 * 相同的形状。
 */
async function ingestVoucherImage(input: VoucherIngestInput): Promise<VoucherPipelineResult> {
  const { ctx, sourcePath, docId, userId } = input;
  const ext = sourcePath.split('.').pop() ?? '';
  const mime = mimeForExtension(ext);
  if (!mime) {
    throw new Error(`不支持的图片扩展名 .${ext}，仅支持 jpg/jpeg/png`);
  }

  // 1. 先落占位行(parse_status='parsing'), 使后续失败可追溯。
  const placeholder: BlockModel = {
    docId,
    docType: '其他',
    modality: 'scanned',
    blocks: [],
    sourceUri: sourcePath,
    createdAt: new Date().toISOString(),
  };
  await saveDocument(ctx, placeholder, userId);
  await setDocumentParseStatus(ctx, docId, 'parsing', userId);

  return runVoucherPipeline(input);
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
  /** Lane A (2a): when set, ingest runs auto-extraction (extractGroundedFields +
   *  saveExtraction) as a fault-isolated post-ingest stage. Unset -> skipped. */
  extraction?: ExtractionDeps;
  /** Lane B: per-chunk semantic tagger. When set + taxonomy non-empty, chunks are
   *  tagged against getTaxonomy(docType) and stored on doc_chunk.tags. */
  tagger?: ChunkTagger;
  /** Phase A: 图片凭证 VLM 解析依赖(同 ToolDeps.vlm)。 */
  vlm?: VlmDeps;
}

export async function ingestFile(opts: IngestOptions): Promise<{
  docId: string;
  blockCount: number;
  modality: string;
  classifiedDocType: DocType;
  classificationConfidence: number;
  classificationSource: 'classified' | 'hint' | 'fallback';
  tags: string[];
  vectorization: VectorizationStatus;
  /** Phase B: 凭证图片分支的绑定建议(非 none 路由); 文本/PDF 路径为空数组。 */
  bindingProposals: Array<{ contractNo: string; score: number; route: BindingRoute }>;
}> {
  const { ctx, sourcePath, docType, modality, embedder, classifier, userId, extraction, tagger, vlm } = opts;
  ensureFk(ctx);
  // Path allowlist (injection defense): reject anything outside INGEST_ROOT.
  const safePath = assertWithinRoot(sourcePath);
  const docId = newDocId();

  // Phase A: 图片凭证走 VLM 分支(不经过文本解析/分类器; 合同 PDF 仍走原路径)。
  if (isVoucherImage(safePath)) {
    return ingestVoucherImage({ ctx, sourcePath: safePath, docId, embedder, userId, vlm });
  }

  // Parse (pure, no DB) — extracted into parseDocument primitive (Phase 1).
  const perf = new StageProfiler(`ingest docId=${docId}`);
  const blockModel = await parseDocument({ sourcePath: safePath, docType: docType ?? '其他', docId, modality });
  perf.mark('parse', `${blockModel.modality}, ${blockModel.blocks.length} blocks`);

  // Classify (Phase 2 routing-classify): parsed blocks -> effective docType.
  // Degrades to the hint when no classifier is wired (tests / dev offline).
  const types = await listTemplateTypes(ctx);
  const vocab = buildClassifierVocab(types);
  const cls = classifier
    ? await classifyDocument(classifier, { blocks: blockModel.blocks, hint: docType, vocab, docId })
    : classifyDocumentWithoutModel({ blocks: blockModel.blocks, hint: docType });
  perf.mark('classify', `${cls.docType} src=${cls.source} conf=${cls.confidence.toFixed(2)}`);
  // The classified docType is the source of truth from here on (design §6:
  // routing-classify picks the docType used downstream).
  blockModel.docType = cls.docType;

  await saveDocument(ctx, blockModel, userId);
  perf.mark('save_document');
  await saveClassification(
    ctx,
    { documentId: docId, docType: cls.docType, confidence: cls.confidence, source: cls.source, hint: docType },
    userId,
  );
  perf.mark('save_classification');
  const chunks = chunkBlockModel(blockModel);
  perf.mark('chunk', `${chunks.length} chunks`);
  // Lane B: tag chunks against the (closed) docType taxonomy. tagChunks never
  // throws and short-circuits to all-null when the tagger is unset or the
  // taxonomy is empty (其他), so this degrades cleanly in tests / offline.
  const taxonomy = getTaxonomy(blockModel.docType);
  const chunkTagResult = tagger
    ? await tagChunks({ chunks: chunks.map((c) => ({ text: c.text })), taxonomy, tagger })
    : chunks.map(() => null);
  perf.mark('chunk_tag', tagger ? `${chunkTagResult.filter(Boolean).length}/${chunks.length} tagged` : 'tagger-off');
  const chunkRowIds = await saveChunks(ctx, docId, chunks, chunkTagResult);
  perf.mark('save_chunks');
  let vectorization: VectorizationStatus = { status: 'skipped', mode: 'none', chunkCount: chunks.length };
  // 类型策略门禁(spec 2026-08-27): 仅合同/立项书子树嵌入; 空文本块过滤防整批 400。
  const embeddable = chunkRowIds
    .map((id, i) => ({ chunkRowId: id!, text: chunks[i]!.text }))
    .filter((x) => x.text.trim().length > 0);
  if (!isVectorizableDocType(blockModel.docType, types)) {
    vectorization = {
      status: 'skipped', mode: embedder?.kind ?? 'none', chunkCount: chunks.length,
      reason: SKIP_REASON_NOT_VECTORIZABLE,
    };
    perf.mark('embed', `skipped not-vectorizable ${blockModel.docType}`);
  } else if (embeddable.length === 0) {
    vectorization = { status: 'skipped', mode: embedder?.kind ?? 'none', chunkCount: chunks.length, reason: '无有效文本块' };
    perf.mark('embed', 'skipped empty-text');
  } else if (embedder) {
    if (await isVecReady(ctx)) {
      try {
        const vecs = await embedder.embed(embeddable.map((x) => x.text));
        await saveChunkVectors(
          ctx,
          embeddable.map((x, i) => ({ chunkRowId: x.chunkRowId, vec: vecs[i] ?? [] })),
        );
        vectorization = { status: 'ok', mode: embedder.kind, chunkCount: chunks.length };
        perf.mark('embed', `ok ${embedder.kind} n=${embeddable.length}`);
      } catch (e) {
        vectorization = {
          status: 'failed', mode: embedder.kind, chunkCount: chunks.length,
          reason: (e as Error).message,
        };
        perf.mark('embed', `failed ${embedder.kind}`);
        console.warn('[ingest] vector embedding failed; FTS5 recall still available:', vectorization.reason);
      }
    } else {
      vectorization = { status: 'skipped', mode: embedder.kind, chunkCount: chunks.length, reason: 'vec_store_not_ready' };
      perf.mark('embed', 'skipped vec_store_not_ready');
    }
  } else {
    perf.mark('embed', 'skipped no-embedder');
  }
  // Auto-tag (Phase 2): derive a small deterministic tag set from the effective
  // docType + content (design §8: auto-tags are an ingest byproduct, persisted
  // and included in the return summary). Explicit tags come from tag_document.
  // Fault-tolerant like the vector block above: by design a byproduct, so a
  // persistence failure degrades to an empty tag set instead of killing the
  // already-committed primary result. saveDocumentTags is now INSERT OR IGNORE /
  // ON CONFLICT DO NOTHING (Bug fix), so this catch only fires on GENUINE errors
  // (disk full, locked DB, schema mismatch) — logged at error level so real
  // failures are not silently swallowed.
  let tags: string[] = [];
  try {
    tags = deriveAutoTags({ docType: blockModel.docType, blocks: blockModel.blocks });
    await saveDocumentTags(ctx, docId, tags, 'auto', userId);
    perf.mark('auto_tags', tags.join(',') || 'none');
  } catch (e) {
    perf.mark('auto_tags', 'failed');
    console.error('[ingest] auto-tag persistence failed:', (e as Error).message);
  }

  // Persist the vectorization outcome onto the document row (Bug fix: previously
  // only stored in an in-memory Map written by ingest_document, so it was lost
  // on restart and never written by the /api/files upload path — which calls
  // ingestFile directly — leaving present_document_review showing 'unknown').
  try {
    await setDocumentVectorization(ctx, docId, vectorization, userId);
    perf.mark('vec_meta');
  } catch (e) {
    console.error('[ingest] vectorization_meta persistence failed:', (e as Error).message);
  }

  // Lane A (2a): auto-extraction. Additive post-ingest stage: when a model is
  // wired, run extractGroundedFields + saveExtraction automatically so the
  // document is field-ready without an explicit extract_fields call. Fully
  // fault-isolated (runAutoExtraction never throws; failures -> 'failed' status
  // on the doc row), and wrapped here too for defense-in-depth. A failure never
  // blocks ingest -- the document stays searchable via FTS5 + vectors.
  if (extraction) {
    try {
      const outcome = await runAutoExtraction({
        ctx,
        docId,
        blockModel,
        userId,
        // 接线闭环(Bug fix): 快捷路径同样挂台账回写 -- buildLedgerWritingDeps
        // 挂到 save 之后(与 processDocument / extractionBackfill 同语义), 使经
        // ingestFile 上传并抽取的合同立即进入 contract_ledger; writeContractLedger
        // 永不抛出, 不影响 outcome。
        deps: buildLedgerWritingDeps(
          buildAutoExtractionDeps({ ctx, extraction, userId }),
          { ctx, docType: blockModel.docType, userId },
        ),
      });
      perf.mark(
        'auto_extract',
        outcome.status === 'ok'
          ? `ok ${outcome.fieldCount ?? 0}f`
          : `${outcome.status}${outcome.reason ? `:${outcome.reason}` : ''} ${outcome.elapsedMs ?? 0}ms`,
      );
      // Fault isolation is silent by design; surface non-ok outcomes (timeout /
      // model error) so a silently-missing extraction is never mistaken for success.
      if (outcome.status !== 'ok') {
        console.error(`[ingestFile] auto-extraction ${outcome.status}:`, outcome.reason ?? 'no reason');
      }
    } catch (e) {
      perf.mark('auto_extract', 'exception');
      console.error('[ingestFile] auto-extraction failed:', (e as Error).message);
    }
  } else {
    perf.mark('auto_extract', 'skipped no-model');
  }

  // Model B: tool-created docs are fully parsed at the end of ingest, so stamp
  // parse_status='parsed' for consistency with the upload-then-process path.
  // Wrapped like the vectorization write above so a status write can't break ingest.
  try {
    await setDocumentParseStatus(ctx, docId, 'parsed', userId);
    perf.mark('stamp_parsed');
  } catch (e) {
    console.error('[ingest] parse_status persistence failed:', (e as Error).message);
  }
  perf.finish();

  return {
    docId,
    blockCount: blockModel.blocks.length,
    modality: blockModel.modality,
    classifiedDocType: cls.docType,
    classificationConfidence: cls.confidence,
    classificationSource: cls.source,
    tags,
    vectorization,
    // 文本/PDF 路径无凭证绑定建议。
    bindingProposals: [],
  };
}

// ---- Model B: on-demand parse of an upload stub ----------------------------
//
// Upload (POST /api/files) is STORAGE-ONLY: it creates a lightweight documents
// stub (parse_status='uploaded') and returns immediately. Parsing runs on demand
// when the document is referenced (添加到对话 triggers POST
// /api/documents/:docId/process; the chat route also backstops via
// ensureDocumentParsed). Parse/OCR failure becomes a STATE (parse_status
// 'needs_ocr' / 'failed'), NOT a thrown exception, so upload is never coupled to
// parsing.

/** Options for processDocument / ensureDocumentParsed (all deps optional). */
export interface ProcessDocumentOptions {
  docType?: DocType;
  modality?: Modality;
  embedder?: Embedder;
  classifier?: ClassifierDeps;
  extraction?: ExtractionDeps;
  tagger?: ChunkTagger;
  userId?: string;
  /** Phase A: 图片凭证 VLM 解析依赖(同 ToolDeps.vlm)。缺省用真实 extractVoucher。 */
  vlm?: VlmDeps;
  /** 方向分类探针注入(缺省真实 classifyOrientation, 需 ORIENTATION_API_URL 配置;
   *  测试注入 fake 以离线验证探针坍缩/回落路径)。 */
  orientationClassifier?: (image: OrientationImage) => Promise<OrientationResult | null>;
  /** ensureDocumentExtracted only. Default true: await the parse-stage
   *  background extraction (chat backstop needs fields ready). false (/process
   *  fast path): return as soon as parsing settles, reporting extractionStatus
   *  'pending' while the background flight runs. */
  waitExtraction?: boolean;
  /** 6b 重处理入口(POST /process {force:true}): 放行 ensureDocumentParsed 对
   *  终态 'parsed' 的短路, 重跑=覆盖重算(updateDocumentMeta 直接 UPDATE 存根)。
   *  仅 'parsed' 可被放行——'needs_ocr' 是需要用户显式选择模态重试的用户可见
   *  状态, 不受 force 影响。 */
  force?: boolean;
  /** 批量拆分器内部选项(外部调用方永不传): 已按 unit 页区间切好的块模型。
   *  存在时跳过解析/Voucher 路由, 直接进分类→落库→chunk→索引→抽取链。 */
  parsedBlockModel?: BlockModel;
  /** 批量拆分器内部选项: 多单据 container 跳过 VLM 凭证路由(整文件硬喂
   *  单据级 schema 正是批量拆分要修的 bug), 落 OCR 旧路径。 */
  skipVoucherRoute?: boolean;
  /** 批量拆分器内部选项: 固定业务类型跳过分类器(container 无业务语义,
   *  词表分类只会产噪声)。落 classifications source='hint'、confidence=1。 */
  fixedDocType?: DocType | typeof CONTAINER_DOC_TYPE;
  /** Task 9 /api/batch/:docId/resplit: 绕过幂等探针 —— 删旧子单据(级联
   *  chunks/extractions/bindings/向量)与 unit 行后重新检测拆分。仅 resplit
   *  路由传; 常规 force 重跑语义不变。 */
  forceResplit?: boolean;
}

export interface ProcessDocumentResult {
  docId: string;
  parseStatus: ParseStatus;
  blockCount?: number;
  classifiedDocType?: DocType;
  classificationConfidence?: number;
  classificationSource?: 'classified' | 'hint' | 'fallback';
  tags?: string[];
  vectorization?: VectorizationStatus;
  reason?: string;
  /** 批量拆分器(仅 BATCH_SPLIT_ENABLED 且检测 N>1 时出现): 拆分摘要。 */
  batchSplit?: {
    unitCount: number;
    childDocIds: string[];
  };
}

/**
 * In-memory single-flight registry for parse runs, keyed by docId. Concurrent
 * callers (the /process endpoint + the chat backstop) share one run per doc so
 * a document is never parsed twice at the same time.
 */
const parseFlights = new Map<string, Promise<ProcessDocumentResult>>();

/** Terminal parse states: an already-terminal doc is never re-parsed. */
function isTerminalParseStatus(status: ParseStatus | null): boolean {
  return status === 'parsed' || status === 'needs_ocr';
}

/**
 * v2.1 双分支门控(spec 2026-08-28 §4): 图像型 PDF(无文字层, digital 尝试失败或
 * 显式 scanned)在落入 MinerU OCR 之前, 渲染第 1 页做一次 VLM 表单分类。
 * 命中 voucher 路由(置信度达标 + 表单类型已映射 + 业务类型有注册 schema)时
 * 走 VLM 凭证提取并返回 parsed 结果; 其余一切情况(document/unknown/低置信/
 * VLM 未配置/任何异常)返回 null 回落 OCR——永不劣于现状。
 */
const VLM_ROUTE_CONFIDENCE_FLOOR = 0.6;

async function tryVoucherRouteForPdf(
  ctx: DbContext,
  docId: string,
  sourceUri: string,
  opts: ProcessDocumentOptions,
): Promise<ProcessDocumentResult | null> {
  if (!/\.pdf$/i.test(sourceUri)) return null;
  if (!env.VLM_BASE_URL || !env.VLM_API_KEY) return null; // 未配置 = 现状行为
  try {
    const types = await listTemplateTypes(ctx);
    const formTypes = collectFormTypes(types);
    if (formTypes.length === 0) return null;
    // 分类只需第 1 页(160 页批量件不全渲); 命中 voucher 后才全量渲染供提取。
    const [firstPage] = await renderPdfPages(sourceUri, { first: 1 });
    if (!firstPage) return null;
    const classify = opts.vlm?.classify;
    const { formType, confidence } = await classifyForm(
      { page: { mime: firstPage.mime, buffer: firstPage.buffer }, formTypes },
      classify ? { call: async (_p, page) => {
        const r = await classify({ page, formTypes });
        return JSON.stringify(r);
      } } : {},
    );
    const idx = buildFormTypeIndex(types);
    const route = idx.routeOf(formType);
    const mapped = idx.docTypeOf(formType);
    const routable =
      confidence >= VLM_ROUTE_CONFIDENCE_FLOOR &&
      route === 'voucher' &&
      mapped !== undefined &&
      mapped in VOUCHER_SCHEMAS;
    console.log(
      `[perf-route] ${docId} vlm-classify formType=${formType} conf=${confidence.toFixed(2)}`
      + ` route=${route} -> ${routable ? `voucher(${mapped})` : 'ocr-fallback'}`,
    );
    if (!routable || mapped === undefined) return null;
    const pages = await renderPdfPages(sourceUri);
    const v = await runVoucherPipeline({
      ctx, sourcePath: sourceUri, docId,
      embedder: opts.embedder, userId: opts.userId, vlm: opts.vlm,
      pdfVoucher: { docType: mapped, pages },
    });
    return {
      docId, parseStatus: 'parsed' as const, blockCount: v.blockCount,
      classifiedDocType: v.classifiedDocType, classificationConfidence: v.classificationConfidence,
      classificationSource: v.classificationSource, tags: v.tags, vectorization: v.vectorization,
    };
  } catch (e) {
    // 分类可见性(2026-09-02): 命中供应商错误表时给出短标签(欠费/限流/内容安全
    // 拦截等), 回落行为不变(仍回落 OCR, 永不劣于现状)。
    const msg = (e as Error).message;
    const cls = classifyProviderError(e);
    if (cls.code) {
      console.warn(`[perf-route] VLM 调用失败(${cls.shortLabel}), 回落 OCR: ${msg}`);
    } else {
      console.warn('[perf-route] VLM 凭证路由失败, 回落 OCR:', msg);
    }
    return null;
  }
}

/**
 * Start the parse-stage auto-extraction as a REGISTERED background flight
 * (keyed by docId in extractionFlights). Called by processDocument right
 * before returning, so:
 *  - ensureDocumentExtracted's default path shares THIS run (the chat backstop
 *    awaits fields => no duplicate model call);
 *  - /process with waitExtraction=false returns without waiting on it.
 * runAutoExtraction never throws; the catch here is pure defense. Timed via a
 * dedicated [perf] bg-extract line (processDocument's own TOTAL closes early).
 */
function startBackgroundExtraction(
  ctx: DbContext,
  docId: string,
  blockModel: BlockModel,
  extraction: ExtractionDeps,
  userId?: string,
): Promise<EnsureDocumentExtractedResult> {
  const existing = extractionFlights.get(docId);
  if (existing) return existing;
  const t0 = performance.now();
  const run = (async (): Promise<EnsureDocumentExtractedResult> => {
    try {
      const outcome = await runAutoExtraction({
        ctx,
        docId,
        blockModel,
        userId,
        // 接线闭环: 抽取成功后回写合同台账(writeContractLedger 永不抛出)。
        deps: buildLedgerWritingDeps(
          buildAutoExtractionDeps({ ctx, extraction, userId }),
          { ctx, docType: blockModel.docType, userId },
        ),
      });
      console.log(
        `[perf] bg-extract docId=${docId} ${outcome.status}`
        + ` ${outcome.elapsedMs ?? Math.round(performance.now() - t0)}ms f=${outcome.fieldCount ?? 0}`,
      );
      if (outcome.status === 'skipped') {
        // 可观测性(2026-09-02): runAutoExtraction 唯一 skipped 路径 = 单飞等待
        // 超时(默认 150s)。行为不变, 仅告警点名被跳过的 docId, 便于排查
        // 复核卡「暂无字段」是否由锁等待超时引起。
        console.warn(
          `[bg-extract] docId=${docId} 抽取被跳过(单飞等待超时 `
          + `${outcome.elapsedMs ?? Math.round(performance.now() - t0)}ms), 复核卡暂无字段, 可重新发起解析重试`,
        );
      }
      if (outcome.status !== 'ok') {
        console.error(`[bg-extract] auto-extraction ${outcome.status}:`, outcome.reason ?? 'no reason');
      }
    } catch (e) {
      console.error('[bg-extract] auto-extraction failed:', (e as Error).message);
    }
    // Read the final status (runAutoExtraction stamped ok/skipped/failed).
    const finalStatus = await getExtractionStatus(ctx, docId, userId);
    return { docId, parseStatus: 'parsed', extractionStatus: finalStatus ?? undefined };
  })().finally(() => {
    extractionFlights.delete(docId);
  });
  extractionFlights.set(docId, run);
  return run;
}

/**
 * On-demand parse of an EXISTING document stub (Model B). Upload creates a
 * lightweight documents row (parse_status='uploaded'); this fn runs the parse
 * pipeline against that stub when triggered by POST /api/documents/:docId/process
 * or by the chat backstop. OCR/parse failure becomes a STATE (parse_status
 * 'needs_ocr' / 'failed'), NOT a thrown exception — so upload is never coupled
 * to parsing. The ONLY thrown case is a missing doc row ('document_not_found').
 *
 * Mirrors ingestFile's body but operates on an EXISTING docId (the stub already
 * inserted by createDocumentStub), so it UPDATEs the row (updateDocumentMeta)
 * instead of INSERT-ing (saveDocument), and threads the same modern deps:
 * classifier, tagger (Lane B), embedder and auto-extraction (Lane A).
 */
export async function processDocument(
  ctx: DbContext,
  docId: string,
  opts: ProcessDocumentOptions = {},
): Promise<ProcessDocumentResult> {
  ensureFk(ctx);
  const perf = new StageProfiler(`process docId=${docId}`);
  // 1. Resolve the stub's source path. A missing row is the one case that throws
  //    (the caller asked to process a doc that does not exist).
  const sourceUri = await getDocumentSourceUri(ctx, docId, opts.userId);
  if (!sourceUri) throw new Error('document_not_found');
  perf.mark('resolve_source');

  // 2. Mark parsing in progress.
  await setDocumentParseStatus(ctx, docId, 'parsing', opts.userId);
  perf.mark('stamp_parsing');
  // 阶段级进度: 解析尝试开始 -> 'ocr'(单图凭证路径/OCR/数字解析统称解析段)。
  await updateDocumentParseStage(ctx, docId, 'ocr');

  // Phase A: 图片凭证走 VLM 分支(与 ingestFile 同一分流; digitalAdapter 按
  // utf-8 读图是乱码, 分类器对乱码块会失败 -> 'failed')。VLM 失败 -> 'failed'
  // STATE + reason(processDocument 契约: 失败是状态而非异常)。
  if (isVoucherImage(sourceUri)) {
    try {
      const v = await runVoucherPipeline({
        ctx, sourcePath: sourceUri, docId, embedder: opts.embedder, userId: opts.userId, vlm: opts.vlm,
      });
      await updateDocumentParseStage(ctx, docId, null);
      perf.finish();
      return {
        docId, parseStatus: 'parsed' as const, blockCount: v.blockCount,
        classifiedDocType: v.classifiedDocType, classificationConfidence: v.classificationConfidence,
        classificationSource: v.classificationSource, tags: v.tags, vectorization: v.vectorization,
      };
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      await updateDocumentParseStage(ctx, docId, null);
      perf.finish(`voucher failed: ${reason}`);
      return { docId, parseStatus: 'failed' as const, blockCount: 0, reason };
    }
  }

  // 3. Parse(v2.1 双分支): PDF 先做文字层廉价探测——图像型(无文字层或显式
  //    scanned)先过 VLM 凭证路由门控, 未命中再进 MinerU OCR; 文字层 PDF 走
  //    digital(parseDocument 内部保留 0 块 OCR 兜底)。OCR/parse 失败 -> 'needs_ocr'
  //    STATE(no throw), upload/parse 解耦保持。
  //    批量拆分器内部选项(对外路径永不传): parsedBlockModel = 已切好的子单据
  //    块模型, 跳过解析/Voucher 路由直接进分类链; skipVoucherRoute = 多单据
  //    container 守卫(整文件硬喂单据级 schema 是本次要修的 bug)。
  let blockModel: BlockModel | null = null;
  const parseErrors: unknown[] = [];
  const firstModality: Modality = opts.modality ?? 'digital';
  const isPdf = /\.pdf$/i.test(sourceUri);
  const attemptParse = async (m: Modality): Promise<BlockModel | null> => {
    const model = await parseDocument({
      sourcePath: assertWithinRoot(sourceUri),
      docType: opts.docType ?? '其他',
      docId,
      modality: m,
    });
    return model.blocks.length > 0 ? model : null;
  };

  // 图像型预判: 显式 scanned 直接算; digital 用文字层探测(null=非PDF/探测失败 -> 原路径)。
  let imageLike = firstModality === 'scanned';
  if (!imageLike && isPdf && !opts.parsedBlockModel) {
    try {
      const hasText = await pdfHasTextLayer(readFileSync(sourceUri));
      imageLike = hasText === false;
    } catch (e) {
      console.warn('[perf-route] 文字层探测失败, 保持 digital 路径:', (e as Error).message);
    }
  }

  if (opts.parsedBlockModel) {
    blockModel =
      opts.parsedBlockModel.blocks.length > 0 ? opts.parsedBlockModel : null;
    perf.mark('parse', `batch-unit sliced, ${blockModel?.blocks.length ?? 0} blocks`);
  } else if (imageLike) {
    const routed = opts.skipVoucherRoute ? null : await tryVoucherRouteForPdf(ctx, docId, sourceUri, opts);
    if (routed) {
      await updateDocumentParseStage(ctx, docId, null);
      perf.finish('voucher-routed');
      return routed;
    }
    // 未命中: 跳过注定 0 块的 digital 尝试, 直接 MinerU OCR。
    try {
      blockModel = await attemptParse('scanned');
      if (blockModel) perf.mark('ocr', `scanned, ${blockModel.blocks.length} blocks`);
    } catch (e) {
      parseErrors.push(e);
    }
  } else {
    try {
      blockModel = await attemptParse(firstModality);
      if (blockModel) perf.mark('parse', `${blockModel.modality}, ${blockModel.blocks.length} blocks`);
    } catch (e) {
      parseErrors.push(e);
    }
  }

  if (!blockModel) {
    const last = parseErrors[parseErrors.length - 1];
    const reason = last instanceof Error ? last.message : '文件解析得到 0 个内容块';
    await setDocumentParseStatus(ctx, docId, 'needs_ocr', opts.userId).catch(() => {});
    await updateDocumentParseStage(ctx, docId, null);
    perf.finish(`needs_ocr: ${reason}`);
    return { docId, parseStatus: 'needs_ocr', blockCount: 0, reason };
  }

  // Steps 4-12 mirror ingestFile's body; an unexpected error -> 'failed' STATE
  // (no throw — process-layer failures are states, not exceptions).
  try {
    // 4. Classify (Phase 2 routing-classify): parsed blocks -> effective docType.
    //    P3: fixedDocType(批量拆分器 container 内部选项)直接定类型跳过分类器,
    //    落 source='hint'、confidence=1(2026-09-01 拍板决策 1)。
    const types = await listTemplateTypes(ctx);
    const vocab = buildClassifierVocab(types);
    const cls = opts.fixedDocType
      ? { docType: opts.fixedDocType as DocType, confidence: 1, source: 'hint' as const }
      : opts.classifier
        ? await classifyDocument(opts.classifier, { blocks: blockModel.blocks, hint: opts.docType, vocab, docId })
        : classifyDocumentWithoutModel({ blocks: blockModel.blocks, hint: opts.docType });
    perf.mark('classify', `${cls.docType} src=${cls.source} conf=${cls.confidence.toFixed(2)}`);
    blockModel.docType = cls.docType;

    // 5. UPDATE the stub with the real docType/modality/block_model (replaces
    //    ingestFile's saveDocument INSERT).
    await updateDocumentMeta(
      ctx,
      docId,
      { docType: blockModel.docType, modality: blockModel.modality, blockModel },
      opts.userId,
    );
    perf.mark('save_document', 'update');

    // 6. Persist classification.
    await saveClassification(
      ctx,
      { documentId: docId, docType: cls.docType, confidence: cls.confidence, source: cls.source, hint: opts.docType },
      opts.userId,
    );
    perf.mark('save_classification');

    // 7. Chunk + tag + save chunks (Lane B, same as ingestFile). tagChunks never
    //    throws and short-circuits to all-null when the tagger is unset or the
    //    taxonomy is empty (其他).
    // 阶段级进度: 解析完成 -> 切块/索引/向量化段。
    await updateDocumentParseStage(ctx, docId, 'indexing');
    const chunks = chunkBlockModel(blockModel);
    perf.mark('chunk', `${chunks.length} chunks`);
    const taxonomy = getTaxonomy(blockModel.docType);
    const chunkTagResult = opts.tagger
      ? await tagChunks({ chunks: chunks.map((c) => ({ text: c.text })), taxonomy, tagger: opts.tagger })
      : chunks.map(() => null);
    perf.mark('chunk_tag', opts.tagger ? `${chunkTagResult.filter(Boolean).length}/${chunks.length} tagged` : 'tagger-off');
    // 重跑覆盖守卫(6b): 覆盖重算要求旧解析的 chunk 行不残留(否则 FTS/向量检索
    // 会同时命中新旧文本)。先清本文档已有 chunks(含 FTS5 行与可选 vec 行)再落
    // 新行; 首次解析/failed 重试路径该清理为无害 no-op。ingestFile 的单块补写
    // (:366)走 append 语义, 不在此列。
    await deleteChunksForDocument(ctx, docId);
    const chunkRowIds = await saveChunks(ctx, docId, chunks, chunkTagResult);
    perf.mark('save_chunks');

    // 8. Vector block (verbatim from ingestFile, incl. type-policy gate).
    let vectorization: VectorizationStatus = { status: 'skipped', mode: 'none', chunkCount: chunks.length };
    const embeddable = chunkRowIds
      .map((id, i) => ({ chunkRowId: id!, text: chunks[i]!.text }))
      .filter((x) => x.text.trim().length > 0);
    if (!isVectorizableDocType(blockModel.docType, types)) {
      vectorization = {
        status: 'skipped', mode: opts.embedder?.kind ?? 'none', chunkCount: chunks.length,
        reason: SKIP_REASON_NOT_VECTORIZABLE,
      };
      perf.mark('embed', `skipped not-vectorizable ${blockModel.docType}`);
    } else if (embeddable.length === 0) {
      vectorization = { status: 'skipped', mode: opts.embedder?.kind ?? 'none', chunkCount: chunks.length, reason: '无有效文本块' };
      perf.mark('embed', 'skipped empty-text');
    } else if (opts.embedder) {
      if (await isVecReady(ctx)) {
        try {
          const vecs = await opts.embedder.embed(embeddable.map((x) => x.text));
          await saveChunkVectors(
            ctx,
            embeddable.map((x, i) => ({ chunkRowId: x.chunkRowId, vec: vecs[i] ?? [] })),
          );
          vectorization = { status: 'ok', mode: opts.embedder.kind, chunkCount: chunks.length };
          perf.mark('embed', `ok ${opts.embedder.kind} n=${embeddable.length}`);
        } catch (e) {
          vectorization = {
            status: 'failed', mode: opts.embedder.kind, chunkCount: chunks.length,
            reason: (e as Error).message,
          };
          perf.mark('embed', `failed ${opts.embedder.kind}`);
          console.warn('[processDocument] vector embedding failed; FTS5 recall still available:', vectorization.reason);
        }
      } else {
        vectorization = { status: 'skipped', mode: opts.embedder.kind, chunkCount: chunks.length, reason: 'vec_store_not_ready' };
        perf.mark('embed', 'skipped vec_store_not_ready');
      }
    } else {
      perf.mark('embed', 'skipped no-embedder');
    }

    // 9. Auto-tag (verbatim from ingestFile; fault-tolerant byproduct).
    let tags: string[] = [];
    try {
      tags = deriveAutoTags({ docType: blockModel.docType, blocks: blockModel.blocks });
      await saveDocumentTags(ctx, docId, tags, 'auto', opts.userId);
      perf.mark('auto_tags', tags.join(',') || 'none');
    } catch (e) {
      perf.mark('auto_tags', 'failed');
      console.error('[processDocument] auto-tag persistence failed:', (e as Error).message);
    }

    // 10. Persist the vectorization outcome.
    try {
      await setDocumentVectorization(ctx, docId, vectorization, opts.userId);
      perf.mark('vec_meta');
    } catch (e) {
      console.error('[processDocument] vectorization_meta persistence failed:', (e as Error).message);
    }

    // 12. Parsed FIRST: the document becomes usable (recall/search/review card)
    //     without waiting for the extraction model. Auto-extraction moves to a
    //     background flight registered in extractionFlights below.
    await setDocumentParseStatus(ctx, docId, 'parsed', opts.userId);
    perf.mark('stamp_parsed');

    // 11b. Lane A backgrounded: kick off auto-extraction as a registered
    //      single-flight. Callers that NEED fields right away
    //      (ensureDocumentExtracted default path / chat backstop) share this
    //      same flight; the /process route skips it via waitExtraction=false.
    if (opts.extraction) {
      startBackgroundExtraction(ctx, docId, blockModel, opts.extraction, opts.userId);
      perf.mark('bg_extract_kickoff');
    } else {
      perf.mark('auto_extract', 'skipped no-model');
    }
    perf.finish();

    await updateDocumentParseStage(ctx, docId, null);
    return {
      docId,
      parseStatus: 'parsed',
      blockCount: blockModel.blocks.length,
      classifiedDocType: cls.docType,
      classificationConfidence: cls.confidence,
      classificationSource: cls.source,
      tags,
      vectorization,
    };
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    await updateDocumentParseStage(ctx, docId, null);
    perf.finish(`failed: ${reason}`);
    await setDocumentParseStatus(ctx, docId, 'failed', opts.userId).catch(() => {});
    return { docId, parseStatus: 'failed', reason };
  }
}

// ---- 批量拆分器灰度入口(spec 2026-09-01 §2 Phase 1) -----------------------
//
// 包在 processDocument 之前(由 ensureDocumentParsed 调用, 覆盖 /process 与
// chat 兜底两条入口):
//   BATCH_SPLIT_ENABLED=false        -> processDocument 旧路径, 零行为变化;
//   非 PDF / 有文字层 / VLM 未配置 / 已拆分过 -> 旧路径;
//   检测失败 / 0 或 1 份 -> 旧路径(batch_role 保持 NULL); 页数超上限 -> 显式
//   failed(BATCH_SPLIT_MAX_PAGES, reason 含实际页数与上限, 大拼贴整本慢路径
//   且混单据不拆是错误方向);
//   检测 N>1 份                      -> parent 标 container + document_units
//     落库, container 仍走旧链路解析(仅跳过 Voucher 路由: 把多单据整文件硬喂
//     单据级 schema 正是本功能要修的 bug), 再按 unit 页区间切 container 的
//     BlockModel 生成 N 个子单据(batch_role='unit'), 各自独立走现有
//     分类→抽取→审核→绑定 全链路, 不新增下游分支。
//
// Phase 2(抽取层): 图像型 unit 的 formType 经 formTypeRegistry(含检测词表
// 别名桥)映射到 voucher 路由时, 按 manifest regions 的 padded bbox 裁图 +
// 旋回候选(90/270 双候选择优)走现有 VLM 凭证抽取管线, 并做两遍读数共识
// (分歧 -> needs_review); OCR 块仍保留给 chunk/recall, 未路由 unit 维持
// Phase 1 的页区间 OCR 路径, container 行为不变。

/** 按 unit 页区间切 container 的 BlockModel(浅拷贝 + blocks 过滤)。 */
function sliceBlockModelForUnit(
  parent: BlockModel,
  childDocId: string,
  unit: DetectedUnit,
): BlockModel {
  return {
    ...parent,
    docId: childDocId,
    blocks: parent.blocks.filter((b) => b.page >= unit.pageStart && b.page <= unit.pageEnd),
  };
}

/** unit 处理状态映射: 子单据解析终态 -> document_units.status。 */
function unitStatusFor(parseStatus: ParseStatus): string {
  return parseStatus === 'parsed' ? 'processed' : parseStatus;
}

/** Task 9 修正入口覆盖项(初始拆分不传)。 */
export interface ProcessUnitChildOverrides {
  /** 重抽指定业务类型: 有注册 schema 才走凭证路由, 否则回落 OCR 块路径。 */
  docTypeOverride?: string;
  /** 重抽指定旋回方向(0/90/180/270): 候选退化为该方向单候选。 */
  rotationOverride?: number;
}

/** processUnitChild 输入(初始拆分与 /api/batch 重抽/合并重建共用)。 */
export interface ProcessUnitChildArgs {
  ctx: DbContext;
  /** container 的 sourceUri(子单据存根共享, 裁剪图渲染源)。 */
  sourceUri: string;
  parentModel: BlockModel;
  unit: DetectedUnit;
  /** document_units 行 id(回填 child 与状态、择优旋回落库)。 */
  unitRowId: string;
  opts: ProcessDocumentOptions;
  /** 预渲染整本页图(150 DPI); null = 渲染失败/未渲染 -> OCR 块路径。 */
  unitPages: RenderedPage[] | null;
  /** 凭证路由命中的业务类型; null = 未路由(overrides.docTypeOverride 优先)。 */
  routedDocType: VoucherType | null;
  /** 子单据分类 hint。 */
  hint?: DocType;
  /** unit 行当前 manifest(择优旋回写回的合并基底)。 */
  unitManifest?: Record<string, unknown>;
  /** Task 9 修正入口覆盖项。 */
  overrides?: ProcessUnitChildOverrides;
}

/** 方向分类探针结果(rotation = 分类器纠正角, score = 分类置信)。 */
export interface OrientationProbeResult {
  rotation: number;
  score: number;
}

/**
 * 方向分类探针(2026-09-04): 90/270 歧义 region 且探针配置时, 渲染该 region
 * 的原始裁剪图(旋转 0)送分类器, 返回分类器纠正角(直接透传, 与仓库 rotationDeg
 * 同语义)。null = 完全未命中(未配置/无歧义 region/渲染失败/HTTP 异常/非法角)。
 * 低置信不再在此丢弃: score 带回调用方分层(锚定模式仍可用分类器方向)。
 * rotationOverride(人工重抽)优先级最高, 不触发探针。
 */
export async function probeUnitRotation(
  unit: DetectedUnit,
  unitPages: RenderedPage[] | null,
  overrides: ProcessUnitChildOverrides | undefined,
  classify: (image: OrientationImage) => Promise<OrientationResult | null>,
): Promise<OrientationProbeResult | null> {
  if (overrides?.rotationOverride != null) return null;
  if (!env.ORIENTATION_API_URL) return null;
  if (!unitPages) return null;
  const target = unit.regions.find((r) => r.rotationDeg === 90 || r.rotationDeg === 270);
  if (!target) return null;
  try {
    // 渲染该 region 的原始裁剪图(旋转 0)送分类器; rotation_deg 即纠正角。
    const [img] = await renderUnitImages(unitPages, { ...unit, regions: [target] }, [0]);
    if (!img) return null;
    const res = await classify({ base64: img.buffer.toString('base64'), mime: img.mime });
    if (!res) return null;
    return { rotation: res.rotationDeg, score: res.score };
  } catch (e) {
    console.warn('[batch-split] 方向分类探针失败, 回落现状路径:', e instanceof Error ? e.message : e);
    return null;
  }
}

/** 分类器路径的 manifest 写回(rotationSource='classifier'/'classifier-anchor')。
 *  坍缩模式写全 chosen 值; 锚定模式 voucher 路径由 P3 择优写 chosen 值,
 *  此处仅用于非 voucher 路径(无 P3, 分类器方向即最终方向)。 */
function writeClassifierManifest(
  ctx: DbContext,
  unitRowId: string,
  baseManifest: Record<string, unknown> | undefined,
  rotations: number[],
  opts: { source?: 'classifier' | 'classifier-anchor'; score?: number } = {},
): void {
  const rotation = rotations[0] ?? 0;
  const source = opts.source ?? 'classifier';
  void updateDocumentUnitManifest(ctx, unitRowId, {
    rotationDeg: rotation,
    manifest: {
      ...baseManifest,
      chosenRotation: rotation,
      chosenRotations: rotations,
      rotationSource: source,
      ...(opts.score !== undefined ? { classifierScore: opts.score } : {}),
    },
  }).catch(() => {});
}

/**
 * 处理一个 unit -> 子单据。由 processDocumentWithBatch 的 mapLimit 循环体提取
 * (初始拆分与 Task 9 重抽/合并重建共用): 存根 -> unit 行回填 -> 凭证路由命中
 * 则裁图旋回候选走 VLM 凭证管线, 否则页区间 OCR 块路径。单个 unit 失败不抛出
 * (状态可追溯, unit 行留 failed), 返回 childId 或 null(存根创建失败)。
 * overrides 仅修正入口使用: docTypeOverride 命中注册 schema 时改走该类型,
 * rotationOverride 把旋回候选退化为单候选(人工指定即最终方向)。
 */
export async function processUnitChild(args: ProcessUnitChildArgs): Promise<string | null> {
  const { ctx, sourceUri, parentModel, unit, unitRowId, opts, unitPages, overrides } = args;
  const overrideRoute =
    overrides?.docTypeOverride && overrides.docTypeOverride in VOUCHER_SCHEMAS
      ? (overrides.docTypeOverride as VoucherType)
      : null;
  const routedDocType = overrideRoute ?? args.routedDocType;
  const hint = (overrides?.docTypeOverride as DocType | undefined) ?? args.hint ?? opts.docType;
  let childId: string;
  try {
    const stub = await createDocumentStub(ctx, { sourceUri, userId: opts.userId, docType: hint });
    childId = stub.docId;
  } catch (e) {
    console.warn('[batch-split] 子单据存根创建失败:', e instanceof Error ? e.message : e);
    return null;
  }
  await setDocumentBatchRole(ctx, childId, 'unit', opts.userId);
  await updateDocumentUnitChild(ctx, unitRowId, childId, 'processing');
  try {
    // 方向分类探针(2026-09-04): 90/270 歧义 region 且探针配置时, 用分类器
    // 纠正角替代跳动的 VLM 检测方向。三层决策(事故实证: 分类器 0.76 置信也
    // 大概率正确, 弃用落回"更不可信的检测+先验"是错误边界):
    //  - score >= ORIENTATION_MIN_SCORE: 坍缩单候选(现状);
    //  - ORIENTATION_ANCHOR_SCORE <= score < ORIENTATION_MIN_SCORE: 锚定模式——
    //    双候选但 plan0=分类器方向(择优先验自动锚到分类器方向, 共识强证据仍可推翻);
    //  - score < ORIENTATION_ANCHOR_SCORE: 现状回落(检测先验)。
    // rotationOverride(人工重抽)优先级最高, 不触发探针。
    const classify = opts.orientationClassifier ?? classifyOrientation;
    const probe = await probeUnitRotation(unit, unitPages, overrides, classify);
    const probeRotation = probe?.rotation ?? null;
    const probeScore = probe?.score ?? null;
    const collapseMode = probe != null && probe.score >= env.ORIENTATION_MIN_SCORE;
    const anchorMode =
      probe != null && probe.score >= env.ORIENTATION_ANCHOR_SCORE && probe.score < env.ORIENTATION_MIN_SCORE;
    if (probe != null) {
      console.log(
        `[batch-split] 方向分类探针 unit=${unit.unitIndex} rotation=${probe.rotation} score=${probe.score.toFixed(3)} ` +
        (collapseMode ? '坍缩单候选' : anchorMode ? '锚定模式(双候选, plan0=分类器方向)' : '低置信回落检测先验'),
      );
    }

    // 裁剪图生成(本地 CPU): 失败回落 OCR 块路径, 不让 unit 失败。
    let candidates: Array<{ rotations: number[]; images: RenderedPage[] }> | null = null;
    if (routedDocType && unitPages) {
      try {
        candidates = [];
        let plans: number[][];
        if (overrides?.rotationOverride != null) {
          plans = [unit.regions.map(() => overrides.rotationOverride!)];
        } else if (collapseMode) {
          plans = [unit.regions.map(() => probeRotation!)];
        } else if (anchorMode) {
          // 锚定模式: 双候选, plan0=分类器方向(择优先验锚的就是
          // candidates[0].rotations[0], 即自动锚到分类器方向)。
          const classifierPlan = unit.regions.map(() => probeRotation!);
          plans = [classifierPlan, ...unitRotationPlans(unit).filter((p) => p.join() !== classifierPlan.join())];
        } else {
          plans = unitRotationPlans(unit);
        }
        for (const rotations of plans) {
          candidates.push({ rotations, images: await renderUnitImages(unitPages, unit, rotations) });
        }
      } catch (e) {
        console.warn('[batch-split] unit 裁剪图生成失败, 回落 OCR 块路径:', childId, e instanceof Error ? e.message : e);
        candidates = null;
      }
    }
    if (routedDocType && candidates) {
      // 图像型 unit + voucher 路由: padded bbox 裁图 + 旋回候选(90/270 双
      // 候选, 0/180 单候选; 分类器命中时坍缩为单候选) -> 现有 VLM 凭证抽取
      // 管线; OCR 块(页区间切片)仍保留给 chunk/recall。
      const ocrBlockModel = sliceBlockModelForUnit(parentModel, childId, unit);
      await setDocumentParseStatus(ctx, childId, 'parsing', opts.userId);
      const unitVoucherInput = {
        docType: routedDocType as DocType,
        candidates,
        detection: { identifier: unit.identifier, evidence: unit.evidence },
        ocrBlockModel,
        // P3 择优旋回落库: 双候选择优胜出后写回 unit 行(fire-and-forget)。
        unitId: unitRowId,
        unitManifest: args.unitManifest,
        // 锚定模式: 随 P3 择优写回 rotationSource='classifier-anchor' + classifierScore。
        ...(anchorMode ? { classifierAnchor: { rotation: probeRotation!, score: probeScore! } } : {}),
      };
      let usedRotations = candidates[0]!.rotations;
      try {
        await runVoucherPipeline({
          ctx, sourcePath: sourceUri, docId: childId,
          embedder: opts.embedder, userId: opts.userId, vlm: opts.vlm,
          unitVoucher: unitVoucherInput,
        });
      } catch (e) {
        // 坍缩单候选(90/270)抽取失败: 补跑反方向一次(两方向都败才抛,
        // 消息含两方向, 等价现状"全部候选失败才抛"契约)。
        if (collapseMode && (probeRotation === 90 || probeRotation === 270)) {
          const opposite = probeRotation === 90 ? 270 : 90;
          const retryRotations = unit.regions.map(() => opposite);
          usedRotations = retryRotations;
          try {
            await runVoucherPipeline({
              ctx, sourcePath: sourceUri, docId: childId,
              embedder: opts.embedder, userId: opts.userId, vlm: opts.vlm,
              unitVoucher: {
                ...unitVoucherInput,
                // candidates 非空即 unitPages 非空(候选生成门控同一条件)。
                candidates: [{ rotations: retryRotations, images: await renderUnitImages(unitPages!, unit, retryRotations) }],
              },
            });
          } catch (e2) {
            const first = e instanceof Error ? e.message : String(e);
            const second = e2 instanceof Error ? e2.message : String(e2);
            throw new Error(`全部旋回候选提取失败: rot=[${probeRotation}] ${first}; rot=[${opposite}] ${second}`);
          }
        } else {
          throw e;
        }
      }
      // 坍缩路径: 写回 manifest(rotationSource='classifier')。
      if (collapseMode && unitRowId) {
        writeClassifierManifest(ctx, unitRowId, args.unitManifest, usedRotations);
      }
      await updateDocumentUnitChild(ctx, unitRowId, childId, 'processed');
      return childId;
    }
    // 非 voucher unit: OCR 块路径(无自愈); 分类器命中/锚定时用纠正角覆盖检测角。
    if (probe != null && unitRowId) {
      if (collapseMode) {
        writeClassifierManifest(ctx, unitRowId, args.unitManifest, unit.regions.map(() => probeRotation!));
      } else if (anchorMode) {
        writeClassifierManifest(ctx, unitRowId, args.unitManifest, unit.regions.map(() => probeRotation!), {
          source: 'classifier-anchor',
          score: probeScore!,
        });
      }
    }
    const res = await processDocument(ctx, childId, {
      ...opts,
      docType: hint,
      parsedBlockModel: sliceBlockModelForUnit(parentModel, childId, unit),
    });
    await updateDocumentUnitChild(ctx, unitRowId, childId, unitStatusFor(res.parseStatus));
    return childId;
  } catch (e) {
    // 单个子单据失败不阻断其余拆分(状态可追溯, unit 行留 failed)。
    console.warn('[batch-split] 子单据处理失败:', childId, e instanceof Error ? e.message : e);
    await updateDocumentUnitChild(ctx, unitRowId, childId, 'failed').catch(() => {});
    return childId;
  }
}

/**
 * 检测 formType -> 凭证路由信息(注册表映射 + UNIT_FORM_TYPE_ALIASES 桥)。
 * Task 9 修正入口按 unit 行的检测词表标签重算路由: route 命中 voucher 且
 * 业务类型有注册 schema 才非空; hint 为映射出的业务类型(可 undefined)。
 */
export function resolveUnitRouteInfo(
  formType: string,
  types: TemplateTypeRow[],
): { route: VoucherType | null; hint: DocType | undefined } {
  const formIdx = buildFormTypeIndex(types);
  const canonical =
    formIdx.docTypeOf(formType) !== undefined
      ? formType
      : UNIT_FORM_TYPE_ALIASES[formType] ?? formType;
  const mapped = formIdx.docTypeOf(canonical);
  const route =
    formIdx.routeOf(canonical) === 'voucher' && mapped !== undefined && mapped in VOUCHER_SCHEMAS
      ? (mapped as VoucherType)
      : null;
  return { route, hint: mapped };
}

export async function processDocumentWithBatch(
  ctx: DbContext,
  docId: string,
  opts: ProcessDocumentOptions = {},
): Promise<ProcessDocumentResult> {
  // 灰度总开关: 关闭 = 完全旧路径(必须与现状逐字节一致, 有测试锁定)。
  if (!env.BATCH_SPLIT_ENABLED) return processDocument(ctx, docId, opts);

  // 门控: 文档不存在 / 非 PDF / VLM 未配置 -> 旧路径(不存在时由
  // processDocument 抛 document_not_found, 保持旧契约)。
  const sourceUri = await getDocumentSourceUri(ctx, docId, opts.userId);
  if (!sourceUri || !/\.pdf$/i.test(sourceUri) || !env.VLM_BASE_URL || !env.VLM_API_KEY) {
    return processDocument(ctx, docId, opts);
  }

  // 门控二: 仅图像型 PDF 参与拆分。这是设计文档的问题域(多份扫描/拍照单据
  // 合订); 且 digital 解析不带页号(blockModelFromText 全部 page=1), 页区间
  // 切片对文字层 PDF 无意义, OCR(MinerU)才产出真实页号。显式 scanned 直接
  // 算, 其余用文字层探测(false = 图像型); 探测失败保持旧路径。
  let imageLike = opts.modality === 'scanned';
  if (!imageLike) {
    try {
      imageLike = (await pdfHasTextLayer(readFileSync(sourceUri))) === false;
    } catch {
      imageLike = false;
    }
  }
  if (!imageLike) return processDocument(ctx, docId, opts);

  // 拆分工作自此真正开始: 容器先落 parsing(此前停留在 uploaded, 前端刷新页面
  // 会丢失在途文件的解析中状态)。探针/幂等命中路径不经此处 —— 各回落分支由
  // processDocument 自管状态; ensureDocumentParsed 的终态短路在进入本函数前
  // 已返回, 不会被本戳覆盖。
  await setDocumentParseStatus(ctx, docId, 'parsing', opts.userId);

  // 幂等: 已拆分过的文件重跑(6b force / 重试)只重解析 container, 不重复生成
  // 子单据。Task 9 forceResplit(/api/batch/:docId/resplit)例外: 删旧子单据
  // (级联 chunks/extractions/bindings/向量, unit 行随 child 级联)与残留 unit
  // 行(pending 无 child)后, 走全新检测分支。
  const existingUnits = await listDocumentUnitsByParent(ctx, docId);
  if (existingUnits.length > 0 && !opts.forceResplit) {
    return processDocument(ctx, docId, { ...opts, skipVoucherRoute: true, fixedDocType: CONTAINER_DOC_TYPE });
  }
  if (existingUnits.length > 0 && opts.forceResplit) {
    for (const u of existingUnits) {
      if (u.childDocumentId) {
        await deleteDocument(ctx, u.childDocumentId, opts.userId);
      }
    }
    await clearDocumentUnits(ctx, docId);
  }

  // 版面清点。VLM/渲染失败回落旧路径(永不劣于现状); 页数超 BATCH_SPLIT_MAX_PAGES
  // 例外 —— 大拼贴整本走慢路径且混单据不拆是错误方向, 显式失败并给出
  // 含实际页数与配置上限的中文 reason(经 ProcessDocumentResult.reason 透出,
  // parse_status 落 'failed' 走现有前端失败渲染)。
  await updateDocumentParseStage(ctx, docId, 'detecting');
  let units: DetectedUnit[];
  try {
    const detection = await detectDocumentUnits(
      { sourcePath: sourceUri, maxPages: env.BATCH_SPLIT_MAX_PAGES },
      { concurrency: env.BATCH_SPLIT_CONCURRENCY, call: opts.vlm?.detectUnits },
    );
    units = detection.units;
  } catch (e) {
    if (e instanceof BatchSplitPageLimitError) {
      const reason = `文件共 ${e.pages} 页, 超过批量拆分上限 ${e.maxPages} 页, 请拆分后分批上传`;
      console.warn(`[batch-split] ${docId} ${reason}`);
      await updateDocumentParseStage(ctx, docId, null);
      await setDocumentParseStatus(ctx, docId, 'failed', opts.userId).catch(() => {});
      return { docId, parseStatus: 'failed' as const, reason };
    }
    // 可见性(2026-09-02 双供应商分类): VLM 失败此前只有笼统一条 warn, 百炼
    // 欠费/限流/内容安全拦截等运维相关原因不可见。分类命中时给出短标签;
    // 回落行为本身不变(仍走旧路径, 永不劣于现状)。
    const msg = e instanceof Error ? e.message : String(e);
    const cls = classifyProviderError(e);
    if (cls.code) {
      console.warn(`[batch-split] ${docId} VLM 调用失败(${cls.shortLabel}), 回落整本解析: ${msg}`);
    } else {
      console.warn('[batch-split] 检测失败, 回落旧路径:', msg);
    }
    return processDocument(ctx, docId, opts);
  }

  // 0/1 份: 单据级文件, 老语义(batch_role 保持 NULL), 完全旧路径。
  if (units.length <= 1) {
    return processDocument(ctx, docId, opts);
  }

  console.log(`[batch-split] ${docId} 检测到 ${units.length} 份逻辑单据, 进入拆分`);
  await setDocumentBatchRole(ctx, docId, 'container', opts.userId);
  // manifest 与 saveDocumentUnits 同源取一份, 供 unitVoucher 择优写回时合并。
  const unitManifests: Array<Record<string, unknown>> = units.map((u) => ({
    formType: u.formType,
    identifier: u.identifier,
    evidence: u.evidence,
    regions: u.regions,
    merged: u.pageEnd > u.pageStart,
  }));
  const unitIds = await saveDocumentUnits(
    ctx,
    units.map((u, i) => ({
      parentDocumentId: docId,
      unitIndex: u.unitIndex,
      docType: u.formType,
      pageStart: u.pageStart,
      pageEnd: u.pageEnd,
      bboxJson: u.bbox ? JSON.stringify(u.bbox) : undefined,
      rotationDeg: u.rotationDeg,
      detectorConfidence: u.confidence,
      manifest: unitManifests[i],
    })),
  );

  // container 旧链路解析(OCR/chunk/索引照旧), 跳过 Voucher 路由且固定「单据组」
  // (P3: 跳过分类器, container 无业务语义)。解析失败(needs_ocr/failed)时不生成
  // 子单据——没有可切的块模型, unit 行保留检测审计(status='pending')。
  const containerRes = await processDocument(ctx, docId, {
    ...opts,
    skipVoucherRoute: true,
    fixedDocType: CONTAINER_DOC_TYPE,
  });
  const childDocIds: string[] = [];
  if (containerRes.parseStatus !== 'parsed') {
    // No block model means no unit can ever be processed on this attempt.
    // Fail them now so the file tree does not show pending work until reboot.
    await failPendingUnitsByParent(ctx, docId);
    return { ...containerRes, batchSplit: { unitCount: units.length, childDocIds } };
  }

  const parentModel = await loadDocument(ctx, docId, opts.userId);
  if (!parentModel) {
    console.warn('[batch-split] container 解析成功但块模型读取失败, 跳过子单据生成');
    await failPendingUnitsByParent(ctx, docId);
    return { ...containerRes, batchSplit: { unitCount: units.length, childDocIds } };
  }

  // 子单据分类 hint + Phase 2 凭证路由: 检测 formType -> 注册表 formType
  // (检测词表与注册表不同源, 经 UNIT_FORM_TYPE_ALIASES 桥接) -> route
  // voucher 且业务类型有注册 schema 的 unit 用裁剪图走 VLM 凭证抽取。
  const types = await listTemplateTypes(ctx);
  const formIdx = buildFormTypeIndex(types);
  const registryFormType = (formType: string): string =>
    formIdx.docTypeOf(formType) !== undefined
      ? formType
      : UNIT_FORM_TYPE_ALIASES[formType] ?? formType;
  const unitRoutes = units.map((u) => {
    const canonical = registryFormType(u.formType);
    const mapped = formIdx.docTypeOf(canonical);
    if (formIdx.routeOf(canonical) !== 'voucher' || mapped === undefined || !(mapped in VOUCHER_SCHEMAS)) {
      return null;
    }
    return mapped as VoucherType;
  });

  // 裁剪图懒渲染: 存在凭证路由 unit 时才重渲整本(150 DPI, 与检测同口径)。
  // 渲染失败 -> 全部回落 OCR 块路径(Phase 2 永不劣于 Phase 1)。
  let unitPages: RenderedPage[] | null = null;
  if (unitRoutes.some(Boolean)) {
    try {
      unitPages = await renderPdfPages(sourceUri);
    } catch (e) {
      console.warn('[batch-split] unit 页图渲染失败, 凭证抽取回落 OCR 路径:', e instanceof Error ? e.message : e);
    }
  }

  // unit 级并发(BATCH_SPLIT_CONCURRENCY, 与检测同参; 宣威 8 页串行原型约
  // 9 分钟)。结果按 unit 序回填; 单个 unit 失败不阻断其余(状态可追溯)。
  // 循环体已提取为 processUnitChild(Task 9 重抽/合并重建共用, 行为等价)。
  // 阶段级进度: container 进入子单据抽取段(每个 unit 自身再走 ocr/indexing)。
  await updateDocumentParseStage(ctx, docId, 'extracting');
  const processed = await mapLimit(units, env.BATCH_SPLIT_CONCURRENCY, async (unit, i) => {
    const routedDocType = (unitPages ? unitRoutes[i] : null) ?? null;
    const hint = routedDocType ?? formIdx.docTypeOf(registryFormType(unit.formType)) ?? opts.docType;
    return processUnitChild({
      ctx, sourceUri, parentModel, unit,
      unitRowId: unitIds[i]!,
      opts,
      unitPages,
      routedDocType,
      hint,
      unitManifest: unitManifests[i],
    });
  });
  for (const childId of processed) {
    if (childId !== null) childDocIds.push(childId);
  }

  // 阶段级进度: 拆分流程终态, 清 container 的进度阶段(子单据各自已清)。
  await updateDocumentParseStage(ctx, docId, null);

  // P3 谱系图: 刷新 container 的 CONTAINS 边(内部已捕获异常折算 'failed',
  // 只 warn 不阻断返回)。
  await syncBatchLineageGraph(ctx, docId).catch(() => {});

  return { ...containerRes, batchSplit: { unitCount: units.length, childDocIds } };
}

/**
 * Single-flighted parse trigger (Model B). Safe to call from anywhere a docId is
 * referenced (the /process endpoint, the chat backstop):
 *  - a run already in flight for this docId -> await the SAME run (never double-parse);
 *  - terminal state ('parsed' | 'needs_ocr') -> return immediately (no re-parse),
 *    except a terminal-'parsed' doc with opts.force (POST /process {force:true},
 *    6b re-process): it re-runs the pipeline with overwrite-recalc semantics;
 *  - 'uploaded' / 'failed' / missing -> start a run.
 * A missing doc row propagates 'document_not_found' from processDocument.
 */
export async function ensureDocumentParsed(
  ctx: DbContext,
  docId: string,
  opts: ProcessDocumentOptions = {},
  userId?: string,
): Promise<ProcessDocumentResult> {
  const fullOpts = userId ? { ...opts, userId } : opts;

  // 1. In-flight -> share the run (single-flight).
  const inFlight = parseFlights.get(docId);
  if (inFlight) return inFlight;

  // 2. Terminal -> no-op, UNLESS an explicit force re-process targets a
  //    'parsed' doc (POST /process {force:true}, 6b): the override re-runs the
  //    full pipeline with overwrite-recalc semantics (updateDocumentMeta UPDATEs
  //    docType/modality/block_model in place). 'needs_ocr' is never bypassed —
  //    it is a user-facing state whose retry must stay an explicit decision.
  const status = await getDocumentParseStatus(ctx, docId, userId);
  const forceReprocess = opts.force === true && status === 'parsed';
  if (isTerminalParseStatus(status) && !forceReprocess) {
    return { docId, parseStatus: status! };
  }

  // 3. Re-check the map AFTER the await: a concurrent caller may have started a
  //    run while we were reading the status. parseFlights.set runs synchronously
  //    right after processDocument() is invoked, so a second caller resuming
  //    later cannot slip in between the two.
  const started = parseFlights.get(docId);
  if (started) return started;

  // 4. 'uploaded' / 'failed' / 'parsing'-without-flight / missing -> start a run.
  //    批量拆分器灰度入口包在 processDocument 之前: 开关关闭时它是纯透传
  //    (零行为变化); 开启且检测到 N>1 份逻辑单据时先拆分再逐 unit 走全链路。
  //    抛错兜底(刷新丢失解析状态修复): 进程内抛错(非崩溃)时 parse_status 仍可
  //    写 —— 在途 'parsing' 不得残留为卡死态, 落 'failed' 后向调用方原样传递
  //    (崩溃残留由启动清扫 failStaleParsingDocuments 兜底)。
  const run = processDocumentWithBatch(ctx, docId, fullOpts)
    .catch(async (e: unknown) => {
      await setDocumentParseStatus(ctx, docId, 'failed', userId).catch(() => {});
      throw e;
    })
    .finally(() => {
      parseFlights.delete(docId);
    });
  parseFlights.set(docId, run);
  return run;
}

// ---- Model B: on-demand re-extraction --------------------------------------
//
// ensureDocumentExtracted ensures a doc is BOTH parsed and field-extracted. It
// reuses ensureDocumentParsed (single-flighted parse), then re-runs
// auto-extraction ONLY when extraction_status is 'skipped'/'failed' (e.g. the
// 60s timeout that killed DOC-msslpnju-vhm9's extraction) or when the doc has
// no extraction_status AND no extraction row. Otherwise it returns fast — the
// common case (already extracted) costs one status read + one extraction-row
// probe, no model call.
// opts (incl. 6b force) flow through to ensureDocumentParsed untouched; for a
// forced re-parse of a terminal doc, processDocument itself kicks a fresh
// background extraction flight before returning, so the in-flight guard below
// observes the NEW run ('pending') rather than any stale terminal outcome.

/** Result of ensureDocumentExtracted (additive extractionStatus for the API). */
export interface EnsureDocumentExtractedResult {
  docId: string;
  parseStatus: ParseStatus | 'needs_ocr';
  extractionStatus?: string;
}

/** In-memory single-flight registry for re-extraction runs (mirror parseFlights). */
const extractionFlights = new Map<string, Promise<EnsureDocumentExtractedResult>>();

/**
 * Ensure a document is parsed AND auto-extracted.
 *  - Step 1: ensureDocumentParsed (reuses the parse single-flight; propagates
 *    'document_not_found' for unknown docs).
 *  - Step 2: re-extract when extraction_status ∈ {'skipped','failed'} OR
 *    (extraction_status NULL AND no extraction row exists). Otherwise return fast.
 *  - Re-extraction is single-flighted (extractionFlights) and fault-isolated
 *    (runAutoExtraction never throws; wrapped for defense-in-depth).
 *  - `opts.extraction` is required to actually re-extract (both callers supply
 *    it via buildIngestDeps); when absent we return early with the status as-is.
 */
export async function ensureDocumentExtracted(
  ctx: DbContext,
  docId: string,
  opts: ProcessDocumentOptions = {},
  userId?: string,
): Promise<EnsureDocumentExtractedResult> {
  // 1. Ensure parsed (parse single-flight; document_not_found propagates).
  const parsed = await ensureDocumentParsed(ctx, docId, opts, userId);

  // In-flight re-extraction for this doc? Share it (single-flight). The
  // parse-stage background flight (registered by processDocument before it
  // returned) lands here too. waitExtraction=false skips the wait: /process
  // reports 'pending' and lets the flight finish on its own.
  const inFlight = extractionFlights.get(docId);
  if (inFlight) {
    if (opts.waitExtraction === false) {
      return { docId, parseStatus: parsed.parseStatus, extractionStatus: 'pending' };
    }
    return inFlight;
  }

  // 2. Decide whether re-extraction is needed.
  const extractionStatus = await getExtractionStatus(ctx, docId, userId);
  const hasExtractionRow = (await loadLatestExtractionByDocId(ctx, docId, userId)) !== null;
  const needsReExtract =
    extractionStatus === 'skipped' ||
    extractionStatus === 'failed' ||
    (extractionStatus === null && !hasExtractionRow);

  // Fast path (waitExtraction=false, used by POST /process): NEVER make a
  // synchronous model call here — parsing settles and /process returns while
  // any needed extraction runs in a registered background flight ('pending').
  if (opts.waitExtraction === false) {
    const racing = extractionFlights.get(docId);
    if (racing) return { docId, parseStatus: parsed.parseStatus, extractionStatus: 'pending' };
    if (needsReExtract && opts.extraction && parsed.parseStatus === 'parsed') {
      const blockModel = await loadDocument(ctx, docId, userId);
      if (blockModel) {
        startBackgroundExtraction(ctx, docId, blockModel, opts.extraction, userId);
        return { docId, parseStatus: parsed.parseStatus, extractionStatus: 'pending' };
      }
    }
    return {
      docId,
      parseStatus: parsed.parseStatus,
      extractionStatus: extractionStatus ?? undefined,
    };
  }

  if (!needsReExtract) {
    return {
      docId,
      parseStatus: parsed.parseStatus,
      extractionStatus: extractionStatus ?? undefined,
    };
  }

  // 3. Re-check the map AFTER the awaits: a concurrent caller may have started
  //    a re-extraction while we were reading status/rows.
  const started = extractionFlights.get(docId);
  if (started) return started;

  // 4. Re-extract (single-flighted; same body as processDocument step 11).
  const run = (async () => {
    const blockModel = await loadDocument(ctx, docId, userId);
    if (!blockModel) {
      // No block model -> nothing to extract; leave the status as-is.
      return { docId, parseStatus: parsed.parseStatus, extractionStatus: extractionStatus ?? undefined };
    }
    if (!opts.extraction) {
      return { docId, parseStatus: parsed.parseStatus, extractionStatus: extractionStatus ?? undefined };
    }
    try {
      const outcome = await runAutoExtraction({
        ctx,
        docId,
        blockModel,
        userId,
        // 接线闭环(小修 1): 重抽取路径同样挂台账回写 -- buildLedgerWritingDeps
        // 挂到 save 之后(与 ingestFile / processDocument / extractionBackfill 同
        // 语义), 超时补抽成功的合同立即进入 contract_ledger; writeContractLedger
        // 永不抛出, 不影响 outcome。
        deps: buildLedgerWritingDeps(
          buildAutoExtractionDeps({ ctx, extraction: opts.extraction, userId }),
          { ctx, docType: blockModel.docType, userId },
        ),
      });
      if (outcome.status !== 'ok') {
        console.error(`[ensureDocumentExtracted] auto-extraction ${outcome.status}:`, outcome.reason ?? 'no reason');
      }
      console.log(`[perf] re-extract docId=${docId} ${outcome.status} ${outcome.elapsedMs ?? 0}ms f=${outcome.fieldCount ?? 0}`);
    } catch (e) {
      console.error('[ensureDocumentExtracted] auto-extraction failed:', (e as Error).message);
    }
    // Read the final status (runAutoExtraction stamped ok/skipped/failed).
    const finalStatus = await getExtractionStatus(ctx, docId, userId);
    return {
      docId,
      parseStatus: parsed.parseStatus,
      extractionStatus: finalStatus ?? undefined,
    };
  })().finally(() => {
    extractionFlights.delete(docId);
  });
  extractionFlights.set(docId, run);
  return run;
}

export function buildIngestDocumentTool(deps: ToolDeps) {
  return tool({
    description:
      '录入一份原始单据(合同/发票/提单/装箱单)。解析文件为结构化 BlockModel 并持久化, ' +
      '内置分类器自动判定单据类型(docType 为可选提示, 分类器会确认或纠正)并打自动标签, ' +
      '返回 docId、分类结果(classifiedDocType / confidence / source)、标签与向量化状态。' +
      '抽取模型可用时, 录入后自动做字段抽取(含合同台账回写), 无需再调 extract_fields; ' +
      '仅在需要重抽或抽取失败时才用 extract_fields。' +
      '用户经上传按钮上传的文件已由系统自动解析与抽取(字段/关系/标签/向量均已就绪), 禁止对它们调用本工具(其路径不在 INGEST_ROOT, 必然失败); 上下文出现其 docId 时直接用 present_document_review 呈现复核卡。仅当用户给出 INGEST_ROOT 内的本地文件路径、且该文件尚未录入时才调用本工具。' +
      '调用示例: 1) 最小调用 {sourceUri: "<INGEST_ROOT>/合同.txt", modality: "digital"}; ' +
      '2) 带类型提示 {sourceUri: "<INGEST_ROOT>/提单.txt", modality: "scanned", docType: "提单"} ' +
      '(scanned 需在同目录有 <文件名>.mineru.json)。仅接受位于服务端 INGEST_ROOT 目录内的路径, 目录外路径会被拒绝。',
    inputSchema: z.object({
      sourceUri: z.string().min(1).describe('本地文件路径 (PDF/TXT/DOCX), 必须位于服务端 INGEST_ROOT 目录内; scanned 还需配套 <sourceUri>.mineru.json'),
      docType: z.enum(['合同', '发票', '提单', '装箱单', '其他']).optional()
        .describe('可选的单据类型提示; 分类器会确认或纠正。省略时由分类器决定'),
      modality: z.enum(['digital', 'scanned']),
    }),
    execute: async ({ sourceUri, docType, modality }) => {
      const result = await ingestFile({
        ctx: deps.ctx,
        sourcePath: sourceUri,
        docType: docType as DocType | undefined,
        modality: modality as Modality,
        classifier: deps.classifier,
        embedder: deps.embedder,
        userId: deps.userId,
        extraction: deps.extraction,
        tagger: deps.tagger,
        vlm: deps.vlm,
      });
      // Vectorization outcome is now persisted inside ingestFile (Bug fix), so
      // present_document_review reads it back via getReviewSnapshot — no in-memory
      // cache to populate (which was lost on restart / never written by uploads).
      return result;
    },
  });
}

export function buildExtractFieldsTool(deps: ToolDeps) {
  return tool({
    description:
      '从已录入单据(docId)中抽取业务字段。强制原文 span 接地: 每个值必须可在 BlockModel 原文中定位, 否则不自动接受。返回带置信度的字段集 + 是否需人工复核(needsReview)。' +
      'strength=none 或置信度低于复核阈值的字段必须如实告知用户, 不得编造; 关键字段(合同号/金额/发票号/价税合计)未达自动接受阈值时, 主动建议人工复核或调 escalate_to_human。',
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
      let typeRow: { props: Record<string, unknown> } | undefined;
      try {
        const templateTypes = await listTemplateTypes(deps.ctx);
        typeRow = templateTypes.find((t) => t.kind === 'doc_type' && t.name === docType);
      } catch (e) {
        // props 读取失败降级(不阻塞抽取): 按无 props 继续。
        console.warn('[extraction] 模板 props 读取失败(降级为无 props):', e instanceof Error ? e.message : String(e));
      }
      const result = await extractGroundedFields(deps.extraction, {
        blockModel, docType: docType as DocType,
        requiredFields: Array.isArray(typeRow?.props.requiredFields) ? (typeRow.props.requiredFields as string[]) : undefined,
        fieldHints: typeRow?.props.fieldHints !== null && typeof typeRow?.props.fieldHints === 'object' && !Array.isArray(typeRow.props.fieldHints)
          ? (typeRow.props.fieldHints as Record<string, string>)
          : undefined,
      });
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
          proposedRelationships: result.proposedRelationships,
        },
        deps.userId,
      );
      // 接线闭环: 手动抽取成功后同样回写合同台账(旁路 byproduct, 永不抛出)。
      // 合同类型与自动抽取路径同一派生规则(deriveContractTypeForDoc)。
      const manualDerivation = await deriveContractTypeForDoc({
        ctx: deps.ctx,
        docType: docType as DocType,
        fields,
      });
      await writeContractLedger({
        ctx: deps.ctx,
        docId,
        docType: docType as DocType,
        fields,
        fieldMeta,
        userId: deps.userId,
        contractType: manualDerivation.contractType,
      });
      // 项目归属自动提议(spec §4.2): 与自动抽取路径同款旁路钩子(故障隔离)。
      try {
        await writeProjectProposals({
          ctx: deps.ctx,
          docType: docType as DocType,
          fields: Object.fromEntries(
            Object.entries(fields).map(([name, f]) => [
              name,
              { value: f.value, confidence: fieldMeta[name]?.confidence ?? 0 },
            ]),
          ),
          contractType: manualDerivation.contractType,
          userId: deps.userId,
        });
      } catch (e) {
        console.error('[documentEntry] 项目归属提议失败:', (e as Error).message);
      }
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
      '将已录入并抽取的单据绑定到业务实体(合同号)。L2 操作: 调用方需附带人工授权(needsApproval)。' +
      'upsert 语义: 若已存在同 (document_id, contract_no, user_id) 且 status=proposed 的系统建议, ' +
      '直接确认该建议(confirmed/human)返回 confirmedProposal=true; 否则插入新 confirmed 绑定。' +
      '每条绑定记录来源 span 与置信度, 写入审计。',
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

      // upsert: 已有 proposed 系统建议 -> 确认它(人工确认), 不插新行。
      const existing = await findBindingByDocAndContract(deps.ctx, documentId, contractNo, deps.userId);
      if (existing && existing.status === 'proposed') {
        await updateBindingStatus(deps.ctx, existing.id, 'confirmed', 'human', deps.userId);
        // 执行流水物化(hook): 确认已有 proposed 建议后物化; 失败仅告警, 绝不影响绑定结果。
        try {
          await materializeExecutionFlow(deps.ctx, {
            documentId, contractNo, bindingId: existing.id,
            confidence: existing.confidence, createdBy: 'trader-agent',
          }, deps.userId);
        } catch (e) {
          console.warn('[executionFlow] 绑定确认物化执行流水失败:', (e as Error).message);
        }
        const linkRes = linkDocumentToContract(contractNo, documentId);
        return {
          ok: true as const, bindingId: existing.id, contractNo, documentId,
          confirmedProposal: true as const, linkedToContract: linkRes.ok,
        };
      }

      const bindingId = await saveBinding(
        deps.ctx,
        {
          documentId, contractNo, relation,
          sourceRefs: [sourceSpan], confidence, createdBy: 'trader-agent',
          status: 'confirmed', confirmationSource: 'human', proposedBy: 'agent',
        },
        deps.userId,
      );
      // 执行流水物化(hook): 新建 confirmed 绑定后物化; 失败仅告警, 绝不影响绑定结果。
      try {
        await materializeExecutionFlow(deps.ctx, {
          documentId, contractNo, bindingId,
          confidence, createdBy: 'trader-agent',
        }, deps.userId);
      } catch (e) {
        console.warn('[executionFlow] 绑定确认物化执行流水失败:', (e as Error).message);
      }
      // T8 deviation (per cross-task directive): bind extends the existing
      // link_document — also reflect the binding in the in-memory contract graph.
      const linkRes = linkDocumentToContract(contractNo, documentId);
      return { ok: true as const, bindingId, contractNo, documentId, linkedToContract: linkRes.ok };
    },
  });
}

/**
 * list_binding_proposals — L1 只读工具 (Phase B)。
 * 供 agent 主动查看待确认的凭证-合同绑定建议(status 缺省 'proposed')。
 * 输出 bindingId/documentId/docType/contractNo/score/evidence.details。
 */
export function buildListBindingProposalsTool(deps: ToolDeps) {
  return tool({
    description:
      '查看凭证入库时自动生成的凭证-合同绑定建议(待人工确认)。' +
      '用途: 用户问"有哪些待确认的绑定"或需要逐条确认系统推断的凭证归属时调用。' +
      'status 可选过滤(默认 proposed); 确认操作走 bind_document(需人工授权)。' +
      '输出每条建议的 bindingId/documentId/docType/contractNo/score 与评分证据 details。',
    inputSchema: z.object({
      status: z.enum(['proposed', 'confirmed', 'rejected']).optional().default('proposed')
        .describe('绑定状态过滤, 默认 proposed(待确认)'),
    }),
    execute: async ({ status }) => {
      const rows = await listBindingProposals(deps.ctx, deps.userId, status);
      return {
        matchCount: rows.length,
        proposals: rows.map((r) => ({
          bindingId: r.id,
          documentId: r.documentId,
          docType: r.docType,
          contractNo: r.contractNo,
          score: r.confidence,
          status: r.status,
          confirmationSource: r.confirmationSource,
          evidence: r.evidence,
        })),
      };
    },
  });
}

/**
 * present_document_review — L1 presentation-first tool.
 * After ingest + extract, the model calls this to surface the post-ingest
 * "five-dimension review card" to the user: docType + classification confidence,
 * structured fields (with per-field confidence + needsReview), proposed
 * relationships, auto/explicit tags, and the vectorization status from ingest.
 * The assembled payload is what the frontend renders as a DocumentReviewCard.
 * This tool does NOT mutate data — it reads and presents. Registration into the
 * role registry / permission gate / contract happens in Task 8.
 */
export function buildPresentDocumentReviewTool(deps: ToolDeps) {
  return tool({
    description:
      '录入+抽取完成后向用户呈现「五维复核卡」: 业务类型、结构化字段(含置信度/需复核)、' +
      '待确认关系、文本TAG、向量化入库状态。一次单据录入成功后必须调用, 供用户逐项确认或纠正。' +
      '用户经上传按钮上传的文件(初始为仅存储状态)的 docId 出现在上下文时, 说明系统已自动完成解析与抽取, 无需再录入或重抽, 直接调用本工具; 文件状态为 needs_ocr 时如实告知用户需 OCR 处理。' +
      '本工具仅用于展示与触发复核, 不改变已落库数据。',
    inputSchema: z.object({
      docId: z.string().min(1).describe('已录入单据的 docId'),
    }),
    execute: async ({ docId }) => {
      const snap = await getReviewSnapshot(deps.ctx, docId, deps.userId);
      if (!snap) return { status: 'error' as const, reason: 'document_not_found' };
      // Vectorization outcome now comes from the persisted documents row (Bug
      // fix: previously read an in-memory Map that the /api/files upload path
      // never populated and that was lost on restart — always showed 'unknown').
      return {
        docId: snap.docId,
        docType: snap.docType,
        classificationConfidence: snap.classificationConfidence,
        fields: snap.fields,
        overallConfidence: snap.overallConfidence,
        proposedRelationships: snap.proposedRelationships,
        tags: snap.tags,
        chunkTags: snap.chunkTags,
        chunkTagDetails: snap.chunkTagDetails,
        vectorization: snap.vectorization,
        reviewStatus: snap.reviewStatus,
        // P3(批量拆分器): 两遍读数共识分歧 + 谱系块(老数据恒 []/null)。
        warnings: snap.warnings,
        batch: snap.batch,
      };
    },
  });
}

/**
 * update_document_fields - L2 correction tool.
 * After the user corrects fields on the review card (Task 9 UI), the model
 * calls this with { docId, corrections:[{name,value}] }. It loads the latest
 * extraction (full fields + fieldMeta), merges the corrections (un-corrected
 * fieldMeta is preserved -- confidence/span grounding survives; corrected
 * fields are overridden with confidence 1.0, human-confirmed, strength 'none'
 * and emptied sourceSpans since the value no longer derives from a source
 * span), writes back via updateExtractionFields, flips reviewStatus to
 * 'corrected', and returns the refreshed snapshot. L2 = soft gate: it only
 * runs after the user confirms a correction (the needsApproval literal is
 * stamped at registration in Task 8, mirroring bind_document -- NOT inlined
 * here so this builder stays registration-agnostic).
 */
export function buildUpdateDocumentFieldsTool(deps: ToolDeps) {
  return tool({
    description:
      '用户在复核卡上纠正字段后应用更正: 将纠正值合并到已抽取字段(保留未更正字段的置信度/原文span接地信息), ' +
      '更正字段置信度置1.0(人工确认)并标记 reviewStatus=corrected。需用户确认才执行(L2)。\n' +
      '也可同时为单据打显式标签(tags 参数, 阶段2b 吸收原 tag_document; 标签来源 explicit, 与 ingest 自动标签区分)。\n' +
      '边界(硬约束): corrections[].value 必须原样转传用户给出的文本, 禁止单位换算/数值化/格式改写。' +
      '用户说"数量 20万吨"就必须传字符串 "20万吨", 传 20 或 200000 都是错误; ' +
      '只有用户原话就是纯数字(如 "改成 16800")时才传 number。不确定原话时先向用户确认, 不要自行归一化。' +
      'corrections 与 tags 至少提供一个。',
    inputSchema: z.object({
      docId: z.string().min(1),
      corrections: z.array(z.object({
        name: z.string().min(1),
        value: z.union([z.string(), z.number()]),
      })).optional(),
      tags: z.array(z.string().min(1)).optional().describe('可选: 为单据添加显式标签(至少一个)'),
    })
      .refine((v) => (v.corrections?.length ?? 0) > 0 || (v.tags?.length ?? 0) > 0, {
        message: 'corrections 与 tags 至少提供一个',
      }),
    execute: async ({ docId, corrections, tags }, opts) => {
      // corrections 与 tags 至少一个(schema refine 已保证); 各自独立执行,
      // 合并返回 -- 单次调用可同时改字段并打标签(阶段2b 吸收 tag_document)。
      let out: Record<string, unknown> = { ok: true as const, docId };
      if (corrections && corrections.length > 0) {
        const exists = await getReviewSnapshot(deps.ctx, docId, deps.userId);
        if (!exists) return { status: 'error' as const, reason: 'document_not_found' };
        // Merge + write delegated to the shared applyDocumentCorrections (Feature:
        // in-card correction HITL route reuses the same logic). Returns null when
        // no extraction exists for the doc. Preserves the prior tool contract
        // (extraction_not_found) without duplicating the merge code here.
        const snapshot = await applyDocumentCorrections(deps.ctx, docId, corrections, deps.userId);
        if (!snapshot) return { status: 'error' as const, reason: 'extraction_not_found' };
        // 修正后的防漂移钩子(旁路): 该文档已确认绑定的执行流水按最新抽取重建。
        // 失败仅告警, 绝不影响修正主流程。
        try {
          await refreshExecutionFlowsForDocument(deps.ctx, docId, deps.userId);
        } catch (e) {
          console.warn('[executionFlow] 修正后重建执行流水失败:', docId, (e as Error).message);
        }
        out = {
          ...out,
          reviewStatus: 'corrected' as const,
          correctedFields: corrections.map((c) => c.name),
          snapshot,
        };
      }
      if (tags && tags.length > 0) {
        const tagTool = buildTagDocumentTool(deps);
        const tagRes = await tagTool.execute!({ docId, tags }, opts);
        out.tagsResult = tagRes;
      }
      return out;
    },
  });
}
