// In-card correction HITL endpoint (Feature).
//
// The user edits fields directly on the review card and submits; this executes
// the correction IMMEDIATELY (not model-mediated), reusing the SAME merge+write
// logic as the update_document_fields L2 tool (via applyDocumentCorrections, so
// the logic lives in ONE place). Also surfaces the previously-dead 'confirmed'
// review state via a { confirm: true } body.
//
// Mounted at /api/documents in index.ts, so the routes below resolve to the
// final paths: POST /api/documents/:docId/review and
// POST /api/documents/:docId/process. requireAuth-gated in index.ts
// (app.use('/api/documents/*', requireAuth)), so a user is always attached here.

import { Hono } from 'hono';
import { existsSync } from 'node:fs';
import { z } from 'zod';
import type { AuthEnv } from '../lib/auth-middleware.js';
import { getDbContext } from '../pipeline/db/dbBackend.js';
import type { DbContext } from '../pipeline/db/client.js';
import {
  applyDocumentCorrections,
  getReviewSnapshot,
  setReviewStatus,
  updateDocumentType,
  listTemplateTypes,
  getBatchRolesForDocuments,
  listContainerUnitSummaries,
  getDocumentUnitByChild,
  getDocumentSourceUri,
} from '../pipeline/db/repositories.js';
import { ensureDocumentExtracted } from '../pipeline/tools/documentEntry.js';
import { refreshExecutionFlowsForDocument } from '../pipeline/executionFlow.js';
import { commitDocumentGraph, syncDocumentTypeToGraph } from '../pipeline/graphCommit.js';
import { buildIngestDeps, defaultEmbedder } from '../pipeline/ingestModel.js';
import { reconcileVectorizationAfterDocTypeChange } from '../pipeline/vectorReconcile.js';
import { getModalityHint } from '../pipeline/modalityHints.js';
import { renderPdfPages } from '../pipeline/pdfRender.js';
import {
  renderUnitImages,
  stackImagesVertically,
  unitFromStoredRow,
  effectiveRotationOf,
} from '../pipeline/unitImages.js';
import type { DocType, Modality } from '../pipeline/types.js';

export const reviewRoute = new Hono<AuthEnv>();

// Allowed docType hints (mirror of routes/files.ts). Used to validate the
// optional docType on POST /api/documents/:docId/process.
const ALLOWED_DOCTYPES: ReadonlySet<string> = new Set(['合同', '发票', '提单', '装箱单', '其他']);

// One DbContext reused across requests (same 'pipeline.db' file / DB as the
// agent + uploads, so corrections land where recall_documents / the review
// snapshot read them back). Same lazy-singleton shape as routes/files.ts.
let _ctx: DbContext | null = null;
function ctx(): DbContext {
  if (!_ctx) _ctx = getDbContext();
  return _ctx;
}

export interface CorrectionInput {
  name: string;
  value: string | number;
}

/**
 * POST /api/documents/:docId/review
 *
 * Apply human corrections directly from the review card (immediate execution,
 * no model round-trip), or confirm the extracted fields as-is.
 *
 * Request body (JSON):
 *   { corrections?: Array<{ name: string; value: string | number }>; confirm?: boolean }
 *
 * - corrections non-empty -> merge onto the latest extraction (corrected fields
 *   get confidence 1.0, strength 'none', cleared sourceSpans), flip
 *   reviewStatus to 'corrected', return the refreshed snapshot.
 * - confirm === true (and no corrections) -> flip reviewStatus to 'confirmed'
 *   (previously a dead state), return the snapshot.
 * - otherwise -> 400.
 *
 * Responses:
 *   200 { ok: true, docId, snapshot }
 *   400 { ok: false, error: 'provide corrections or confirm' }
 *   401 { error: 'unauthorized' }            (requireAuth, applied in index.ts)
 *   404 { ok: false, error: 'document_or_extraction_not_found' }
 *   500 { ok: false, error: <message> }
 */
reviewRoute.post('/:docId/review', async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'unauthorized' }, 401);

  let body: { corrections?: unknown; confirm?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ ok: false, error: 'invalid JSON body' }, 400);
  }

  const docId = c.req.param('docId');

  // Validate corrections shape if present: each must be { name: string, value:
  // string|number }. Unknown/extra keys are ignored. Non-array -> 400.
  let corrections: CorrectionInput[] | null = null;
  if (Array.isArray(body.corrections)) {
    const parsed: CorrectionInput[] = [];
    for (const item of body.corrections) {
      if (!item || typeof item !== 'object') {
        return c.json({ ok: false, error: 'corrections[] entries must be { name, value } objects' }, 400);
      }
      const obj = item as Record<string, unknown>;
      const name = obj.name;
      const value = obj.value;
      if (typeof name !== 'string' || name.length === 0) {
        return c.json({ ok: false, error: 'each correction requires a non-empty name' }, 400);
      }
      if (typeof value !== 'string' && typeof value !== 'number') {
        return c.json({ ok: false, error: 'each correction value must be string or number' }, 400);
      }
      parsed.push({ name, value });
    }
    if (parsed.length > 0) corrections = parsed;
  }

  const confirm = body.confirm === true;

  try {
    let snapshot;
    if (corrections && corrections.length > 0) {
      // Immediate correction (not model-mediated). applyDocumentCorrections
      // returns null when no extraction exists for the doc (also covers a
      // missing doc) -> 404.
      snapshot = await applyDocumentCorrections(ctx(), docId, corrections, user.id);
      if (!snapshot) {
        return c.json({ ok: false, error: 'document_or_extraction_not_found' }, 404);
      }
      // 修正后的防漂移钩子(旁路): 已确认绑定的执行流水按最新抽取重建。
      // 失败仅告警, 绝不影响修正主流程(与 L2 工具侧同一钩子)。
      try {
        await refreshExecutionFlowsForDocument(ctx(), docId, user.id);
      } catch (e) {
        console.warn('[executionFlow] 修正后重建执行流水失败:', docId, (e as Error).message);
      }
    } else if (confirm) {
      // Confirm-as-is: flip reviewStatus to 'confirmed' (previously a dead
      // state — this makes it reachable), then commit the derived entities/
      // edges to Neo4j (design 2026-08-17 §4). Graph commit is
      // fault-isolated: it NEVER blocks/fails the confirmation — the outcome
      // is persisted as documents.graph_status and surfaced on the snapshot.
      await setReviewStatus(ctx(), docId, 'confirmed', user.id);
      await commitDocumentGraph(ctx(), docId, user.id);
      snapshot = await getReviewSnapshot(ctx(), docId, user.id);
      if (!snapshot) {
        return c.json({ ok: false, error: 'document_or_extraction_not_found' }, 404);
      }
    } else {
      return c.json({ ok: false, error: 'provide corrections or confirm' }, 400);
    }

    return c.json({ ok: true, docId, snapshot });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[review] correction failed:', msg);
    return c.json({ ok: false, error: msg }, 500);
  }
});

/**
 * GET /api/documents/:docId/review
 *
 * Read-only current review snapshot. Chat history stores the
 * present_document_review tool result as an immutable point-in-time copy, so a
 * document confirmed AFTER the fact still reads 'pending' from restored
 * history; clients hydrate open ('pending') cards from here on load.
 *
 * Responses:
 *   200 { ok: true, docId, snapshot }
 *   401 { error: 'unauthorized' }            (requireAuth, applied in index.ts)
 *   404 { ok: false, error: 'document_or_extraction_not_found' }
 *   500 { ok: false, error: <message> }
 */
reviewRoute.get('/:docId/review', async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'unauthorized' }, 401);
  const docId = c.req.param('docId');
  try {
    const snapshot = await getReviewSnapshot(ctx(), docId, user.id);
    if (!snapshot) {
      return c.json({ ok: false, error: 'document_or_extraction_not_found' }, 404);
    }
    return c.json({ ok: true, docId, snapshot });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[review] snapshot fetch failed:', msg);
    return c.json({ ok: false, error: msg }, 500);
  }
});

/**
 * GET /api/documents/:docId/units
 *
 * P3 谱系(批量拆分器 Phase 3): container 文档的 unit 清单摘要(检测类型/子单据
 * 类型/解析与复核状态/待复核标记), 文件树展开层级与 container 导航卡消费。
 *
 * 守卫(一次批量查询覆盖三态): 文档不存在 / 非本人(batch_role 查询按 user 过滤,
 * 他人文档不在结果里) / batch_role != 'container' -> 一律 404(照 GET /review
 * 的错误形态; 不用 getReviewSnapshot 做守卫——它的 documents SELECT 不带
 * user 过滤, 对他人文档并不返回 null)。
 *
 * Responses:
 *   200 { ok: true, docId, units: BatchUnitSummary[] }
 *   401 { error: 'unauthorized' }            (requireAuth, applied in index.ts)
 *   404 { ok: false, error: 'document_or_extraction_not_found' }
 *   500 { ok: false, error: <message> }
 */
reviewRoute.get('/:docId/units', async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'unauthorized' }, 401);
  const docId = c.req.param('docId');
  try {
    const roles = await getBatchRolesForDocuments(ctx(), [docId], user.id);
    if (roles.get(docId)?.batchRole !== 'container') {
      return c.json({ ok: false, error: 'document_or_extraction_not_found' }, 404);
    }
    const units = await listContainerUnitSummaries(ctx(), docId);
    return c.json({ ok: true, docId, units });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[review] units fetch failed:', msg);
    return c.json({ ok: false, error: msg }, 500);
  }
});

// ---- 复核原片预览(GET /:docId/unit-preview) --------------------------------
//
// 渲染成本: 需把 container PDF 渲到 unit 的末页(renderPdfPages {first})再裁剪,
// 大批量件并不便宜 -> 32 条 LRU(docId+rotation 为键)挡重复轮询。旋回变更会
// 重抽/reextract 后改写 manifest.chosenRotation, 键含 rotation 自然失效。

const PREVIEW_LRU_MAX = 32;
const previewLru = new Map<string, Buffer>();

function previewCacheGet(key: string): Buffer | null {
  const hit = previewLru.get(key);
  if (hit === undefined) return null;
  previewLru.delete(key);
  previewLru.set(key, hit);
  return hit;
}

function previewCacheSet(key: string, buf: Buffer): void {
  if (previewLru.has(key)) previewLru.delete(key);
  previewLru.set(key, buf);
  if (previewLru.size > PREVIEW_LRU_MAX) {
    const oldest = previewLru.keys().next().value;
    if (oldest !== undefined) previewLru.delete(oldest);
  }
}

/**
 * GET /api/documents/:docId/unit-preview
 *
 * 复核原片预览(复核 UX, 2026-09-01): docId 必须是批量拆分的 unit 子单据。
 * 用 document_units 存量行(页区间/bbox/manifest.regions)经 renderUnitImages
 * 裁剪 + 旋回(有效旋回 = manifest.chosenRotation ?? rotation_deg), 返回的
 * 就是抽取/VLM 所见的那张裁剪图。跨页合并 unit 的多区域纵向拼为一张。
 *
 * 响应:
 *   200 image/png(原始字节)
 *   404 { ok: false, error: '<中文原因>' }   非unit / 无unit行 / 原文件缺失 /
 *                                            渲染失败
 *   401 { error: 'unauthorized' }            (requireAuth, applied in index.ts)
 */
reviewRoute.get('/:docId/unit-preview', async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'unauthorized' }, 401);
  const docId = c.req.param('docId');
  try {
    // 与 units 端点同款三态守卫(不存在/他人文档/角色不符 -> 404), unit 侧。
    const roles = await getBatchRolesForDocuments(ctx(), [docId], user.id);
    if (roles.get(docId)?.batchRole !== 'unit') {
      return c.json({ ok: false, error: '单据不存在或不是拆分单元' }, 404);
    }
    const unit = await getDocumentUnitByChild(ctx(), docId);
    if (!unit) {
      return c.json({ ok: false, error: '未找到该单元的检测记录' }, 404);
    }
    const sourceUri = await getDocumentSourceUri(ctx(), unit.parentDocumentId, user.id);
    if (!sourceUri || !existsSync(sourceUri)) {
      return c.json({ ok: false, error: '原始文件不存在或已被清理, 无法生成预览' }, 404);
    }
    const rotation = effectiveRotationOf(unit);
    const cacheKey = `${docId}:${rotation}`;
    const cached = previewCacheGet(cacheKey);
    if (cached) {
      return c.body(new Uint8Array(cached), 200, { 'Content-Type': 'image/png' });
    }
    // 只渲染到 unit 末页(renderPdfPages 支持 first N), 裁剪按页号取图。
    const pages = await renderPdfPages(sourceUri, { first: unit.pageEnd ?? unit.pageStart ?? 1 });
    const detected = unitFromStoredRow(unit);
    const images = await renderUnitImages(pages, detected, detected.regions.map(() => rotation));
    const png = await stackImagesVertically(images);
    previewCacheSet(cacheKey, png);
    return c.body(new Uint8Array(png), 200, { 'Content-Type': 'image/png' });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn('[review] unit-preview 生成失败:', docId, msg);
    return c.json({ ok: false, error: `预览图生成失败: ${msg}` }, 404);
  }
});

/**
 * POST /api/documents/:docId/process
 *
 * Model B: run the parse pipeline on an EXISTING upload stub
 * (parse_status='uploaded') on demand. Upload is storage-only; this is where
 * OCR / block extraction / chunking / indexing / auto-extraction actually
 * happen. Parse/OCR failure becomes a STATE (parse_status='needs_ocr' /
 * 'failed') in the response body, NOT a thrown 500 — so the caller can react
 * (e.g. prompt the user to retry as 'scanned'). requireAuth-gated in index.ts
 * (a user is always attached).
 *
 * Single-flighted via ensureDocumentExtracted: concurrent calls for the same
 * docId share one run; terminal docs ('parsed' / 'needs_ocr') return
 * immediately, and already-extracted docs (extraction_status='ok') skip the
 * model call entirely. EXCEPTION (6b re-process): {force:true} on a terminal-
 * 'parsed' doc overrides that gate and re-runs the pipeline with overwrite-
 * recalc semantics; 'needs_ocr' stays non-bypassable.
 *
 * Request body (JSON, all optional):
 *   { docType?: string; modality?: string; force?: boolean }
 *   - docType: '合同'|'发票'|'提单'|'装箱单'|'其他' (default '其他')
 *   - modality: 'digital'|'scanned' (default 'digital')
 *   - force: true -> re-parse an already-'parsed' doc (FileTree 重新处理徽标)
 *
 * Responses:
 *   200 { ok: true, docId, parseStatus: 'parsed'|'needs_ocr'|'failed',
 *        extractionStatus?: string, ... }
 *   404 { ok: false, error: 'document_not_found' }  (unknown docId)
 *   500 { ok: false, error: <message> }             (only for truly unexpected
 *        errors; parse failures are states, never 500s)
 */
reviewRoute.post('/:docId/process', async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'unauthorized' }, 401);

  let body: { docType?: unknown; modality?: unknown; force?: unknown };
  try {
    body = await c.req.json();
  } catch {
    body = {};
  }

  const docId = c.req.param('docId');
  const docTypeStr = typeof body.docType === 'string' ? body.docType : '其他';
  const docType = (ALLOWED_DOCTYPES.has(docTypeStr) ? docTypeStr : '其他') as DocType;
  // 6b 重新处理入口: force=true 时 ensureDocumentParsed 放行终态 'parsed' 的
  // 短路(覆盖重跑); 其余取值一律按缺省 false 处理。
  const force = body.force === true;
  // Model C: when the caller does NOT pass an explicit modality, prefer the
  // upload-time text-layer probe hint (if any) so a scanned PDF starts straight
  // on MinerU instead of the digital->0-blocks->OCR detour. An explicit
  // modality always wins; default stays 'digital'.
  const modalityHint = getModalityHint(docId);
  const modality: Modality =
    body.modality === 'scanned' || body.modality === 'digital'
      ? body.modality
      : (modalityHint ?? 'digital');

  try {
    // waitExtraction=false: the response returns as soon as PARSING settles
    // (OCR/classify/chunk/index). Field extraction runs in a background
    // single-flight and is reported as extractionStatus='pending' until it
    // lands; the review card / snapshot reflects 'ok' once complete. The chat
    // backstop still awaits fields via its own default-path call.
    // force 放在 spread 之后: 防未来 buildIngestDeps 引入同名键静默覆盖。
    const result = await ensureDocumentExtracted(
      ctx(),
      docId,
      { docType, modality, waitExtraction: false, ...buildIngestDeps(), force },
      user.id,
    );
    // result already carries docId + parseStatus (and the additive
    // extractionStatus), so spread it into the response.
    return c.json({ ok: true, ...result });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg === 'document_not_found') {
      return c.json({ ok: false, error: 'document_not_found' }, 404);
    }
    console.error('[review] process failed:', msg);
    return c.json({ ok: false, error: msg }, 500);
  }
});

const docTypeChangeSchema = z.object({ docType: z.string().min(1) });

/**
 * PATCH /api/documents/:docId/type
 *
 * 修正文档的业务类型(docType)。入库分类可能出错(如漏分类为 '其他'), 工作台
 * 让用户直接改正: 落 documents.doc_type(级联 extractions.doc_type), 然后按
 * 最新类型重建该文档全部已确认绑定的执行流水 —— refreshedFlows 计数是响应
 * 契约的一部分, 重建失败返回 500 而非静默告警。
 *
 * Request body (JSON):
 *   { docType: string }  — 必须在 DOC_TYPES 八类词汇内
 *
 * Responses:
 *   200 { ok: true, docType, refreshedFlows, skipped?, vectorization }
 *   400 { ok: false, error: 'invalid_body' | 'invalid_doc_type' }
 *   401 { error: 'unauthorized' }            (requireAuth, applied in index.ts)
 *   404 { ok: false, error: 'document_not_found' }
 *   500 { ok: false, error: <message> }
 */
reviewRoute.patch('/:docId/type', async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'unauthorized' }, 401);

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ ok: false, error: 'invalid_body' }, 400);
  }
  const parsed = docTypeChangeSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ ok: false, error: 'invalid_body' }, 400);
  }
  const docType = parsed.data.docType;
  const templateTypes = await listTemplateTypes(ctx());
  // 小修 4: 同步排除 aliasOf 别名类型(提单/装箱单=货转单别名) —— boot 迁移
  // migrateDocTypeAliases 会把设成别名的 doc_type 翻回主类型, 人工修正接口
  // 必须拒绝这类值, 否则用户改完刷新即被翻回。
  const valid = templateTypes.some(
    (t) => t.kind === 'doc_type' && t.isActive && !t.props.aliasOf && t.name === docType,
  );
  if (!valid) {
    return c.json({ ok: false, error: 'invalid_doc_type' }, 400);
  }

  const docId = c.req.param('docId');
  try {
    const updated = await updateDocumentType(ctx(), docId, docType as DocType, user.id);
    if (!updated) {
      return c.json({ ok: false, error: 'document_not_found' }, 404);
    }
    // 轻量图同步(F3): 把新 docType 幂等 MERGE 到 Neo4j Document 节点, 让图视图
    // 不再显示陈旧类型。best-effort —— 图不可达/未配置时静默跳过, 绝不阻断修正。
    try {
      await syncDocumentTypeToGraph(docId, docType);
    } catch (e) {
      console.warn('[review] docType 图同步失败:', e instanceof Error ? e.message : String(e));
    }
    // 类型修正后按最新抽取重建执行流水; refreshedFlows 计数是响应契约的一部分,
    // 失败不得告警吞掉(与修正钩子的 warn-only 语义不同)。skipped 透传跳过原因
    // (F2: 白名单外 / 方向判不出 / 无 confirmed 绑定)。
    const { materialized, skipped } = await refreshExecutionFlowsForDocument(ctx(), docId, user.id);
    // 向量回溯(spec 2026-08-27 选择性向量化): 对齐向量库与新类型——可向量化补
    // 嵌入, 不可向量化清空。reconcile 契约永不抛出; 这层 try 与图同步同款兜底。
    let vectorization;
    try {
      vectorization = await reconcileVectorizationAfterDocTypeChange(
        ctx(), docId, docType, defaultEmbedder(), user.id,
      );
    } catch (e) {
      console.warn('[review] 向量回溯失败:', e instanceof Error ? e.message : String(e));
    }
    return c.json({ ok: true, docType, refreshedFlows: materialized, skipped, vectorization });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[review] docType change failed:', msg);
    return c.json({ ok: false, error: msg }, 500);
  }
});
