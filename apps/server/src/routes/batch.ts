// Task 9: /api/batch 批量修正端点(批量拆分器 Phase 3, spec 2026-09-01 §P3d)。
//
//   POST /:docId/resplit                  重拆(force 越过绑定守卫)
//   POST /:docId/units/:unitId/reextract  单 unit 重抽(docType/rotationDeg 覆盖)
//   POST /:docId/units/merge              合并相邻 unit(unitIds >= 2, 同 container)
//
// 响应契约(frontend 依赖, 2026-09-01 定):
//   成功 { ok: true, ... }
//   失败 { ok: false, error: '<中文人类可读消息>', code: '<machine_code>',
//          detail?: [{ docId, unitIndex }] }  —— error 由前端直接渲染,
//          机器码走 code(前端 switch 用); unit_bound 的 detail 列出已绑定单元。
//   资源不存在/非 container/非本人 -> 404; 破坏性守卫 -> 409; 参数 -> 400。
//
// requireAuth 由 index.ts 挂载点覆盖(app.use('/api/batch/*', requireAuth))。
// 修正端点是破坏性写操作: viewer 只读, 与文件上传/移动/删除保持同一角色面。
// per-container 串行锁防止同一单据组的 resplit/reextract/merge 并发交错。

import { Hono, type MiddlewareHandler } from 'hono';
import { requireRole, type AuthEnv } from '../lib/auth-middleware.js';
import { withContainerLock } from '../lib/containerLock.js';
import { getDbContext } from '../pipeline/db/dbBackend.js';
import type { DbContext } from '../pipeline/db/client.js';
import {
  getBatchRolesForDocuments,
  getDocumentParseStatus,
  getDocumentSourceUri,
  listDocumentUnitsByParent,
  listDocumentIdsWithConfirmedBindings,
  listTemplateTypes,
  loadDocument,
  updateDocumentUnitManifest,
  deleteDocument,
  deleteDocumentUnitsByIds,
  setDocumentParseStatus,
  type DocumentUnitRow,
} from '../pipeline/db/repositories.js';
import {
  processDocumentWithBatch,
  processUnitChild,
  resolveUnitRouteInfo,
} from '../pipeline/tools/documentEntry.js';
import { buildIngestDeps } from '../pipeline/ingestModel.js';
import { syncBatchLineageGraph } from '../pipeline/batchLineageGraphSync.js';
import { renderPdfPages, type RenderedPage } from '../pipeline/pdfRender.js';
import { env } from '../env.js';
import type { DetectedUnit, UnitBBox } from '../pipeline/batchSplit.js';
import { VOUCHER_SCHEMAS, type VoucherType } from '../pipeline/schemas/vouchers.js';
import type { DocType, Modality } from '../pipeline/types.js';

export const batchRoute = new Hono<AuthEnv>();
batchRoute.use('*', requireRole('admin', 'trader'));

// DbContext per call -- getDbContext is itself a singleton in dbBackend.
// Per-call resolution keeps route modules testable against fresh per-test
// databases (same convention as routes/files.ts).
function ctx(): DbContext {
  return getDbContext();
}

/**
 * Hono adapter: serialize the complete handler by the `:docId` route param
 * (per-container async mutex lives in lib/containerLock.ts).
 */
const withContainerParamLock: MiddlewareHandler<AuthEnv> = async (c, next) => {
  // Hono's generic param lookup widens to string|undefined outside the route
  // schema; all three mounted paths declare :docId, so '' is unreachable.
  await withContainerLock(c.req.param('docId') ?? '', next);
};

interface BoundDetail {
  docId: string;
  unitIndex: number;
}

type JsonCapable = { json: (o: object, s?: number) => Response };

/** 统一错误形态: error=中文人类可读(前端直渲), code=机器码, detail=绑定明细。 */
function fail(
  c: JsonCapable,
  status: 400 | 404 | 409 | 500,
  error: string,
  code: string,
  detail?: BoundDetail[],
): Response {
  return c.json({ ok: false, error, code, ...(detail ? { detail } : {}) }, status);
}

/** 列出子单据已被确认绑定的 unit 明细(unit_bound 409 的 detail)。 */
function boundDetail(units: DocumentUnitRow[], bound: Set<string>): BoundDetail[] {
  return units
    .filter((u) => u.childDocumentId !== null && bound.has(u.childDocumentId))
    .map((u) => ({ docId: u.childDocumentId!, unitIndex: u.unitIndex }));
}

/** container 守卫: 不存在/非本人(user 过滤)/非 container -> false(一律 404)。 */
async function isOwnedContainer(docId: string, userId: string): Promise<boolean> {
  const roles = await getBatchRolesForDocuments(ctx(), [docId], userId);
  return roles.get(docId)?.batchRole === 'container';
}

/** manifest.regions -> 检测 region 形状(轻校验, 坏行丢弃)。 */
function regionsFromManifest(
  manifest: Record<string, unknown>,
): Array<{ page: number; bbox: UnitBBox; rotationDeg: number }> {
  const raw = manifest.regions;
  if (!Array.isArray(raw)) return [];
  const out: Array<{ page: number; bbox: UnitBBox; rotationDeg: number }> = [];
  for (const r of raw) {
    if (r === null || typeof r !== 'object') continue;
    const rec = r as Record<string, unknown>;
    const page = Number(rec.page);
    const bbox = rec.bbox;
    if (!Number.isFinite(page) || bbox === null || typeof bbox !== 'object') continue;
    out.push({ page, bbox: bbox as UnitBBox, rotationDeg: Number(rec.rotationDeg) || 0 });
  }
  return out;
}

/** unit 行 -> 检测期 DetectedUnit 视图(裁图/页区间切片/rebuild 用)。 */
function detectedUnitOf(row: DocumentUnitRow): DetectedUnit {
  const regions = regionsFromManifest(row.manifest);
  const identifier = row.manifest.identifier;
  const evidence = row.manifest.evidence;
  return {
    unitIndex: row.unitIndex,
    formType: row.docType,
    confidence: row.detectorConfidence,
    identifier: typeof identifier === 'string' && identifier.length > 0 ? identifier : null,
    evidence: typeof evidence === 'string' ? evidence : '',
    pageStart: row.pageStart ?? 1,
    pageEnd: row.pageEnd ?? row.pageStart ?? 1,
    bbox: null,
    rotationDeg: row.rotationDeg ?? 0,
    regions,
  };
}

/**
 * POST /api/batch/:docId/resplit   body { force?: boolean }
 *
 * 重拆: 删旧子单据(级联抽取/复核/绑定/向量, deleteDocument 级联)与全部 unit
 * 行后, 重新版面清点并按 unit 重建子单据。container 自身只复用块模型门控,
 * 重新走 processDocumentWithBatch 的检测分支。存在 confirmed 绑定的 unit 且未
 * force -> 409 unit_bound + detail。
 *
 *   200 { ok: true, docId, unitCount, childDocIds }
 *   400 not_parsed / vlm_unconfigured; 404 not_found;
 *   409 unit_bound(detail); 500 resplit_failed
 */
batchRoute.post('/:docId/resplit', withContainerParamLock, async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'unauthorized' }, 401);
  const docId = c.req.param('docId');
  let body: { force?: unknown };
  try {
    body = (await c.req.json()) as { force?: unknown };
  } catch {
    body = {};
  }
  const force = body.force === true;

  if (!(await isOwnedContainer(docId, user.id))) {
    return fail(c, 404, '单据组不存在或不可访问', 'not_found');
  }
  const parseStatus = await getDocumentParseStatus(ctx(), docId, user.id);
  if (parseStatus !== 'parsed') {
    return fail(c, 400, '单据组尚未解析完成, 无法重拆', 'not_parsed');
  }
  if (!env.VLM_BASE_URL || !env.VLM_API_KEY) {
    return fail(c, 400, 'VLM 未配置, 无法重新拆分', 'vlm_unconfigured');
  }
  const units = await listDocumentUnitsByParent(ctx(), docId);
  const bound = new Set(await listDocumentIdsWithConfirmedBindings(ctx(), user.id));
  const detail = boundDetail(units, bound);
  if (detail.length > 0 && !force) {
    return fail(c, 409, '存在已确认绑定的子单据, 重拆将删除其抽取/复核/绑定', 'unit_bound', detail);
  }
  try {
    const result = await processDocumentWithBatch(ctx(), docId, {
      ...buildIngestDeps(),
      userId: user.id,
      // container 按定义是图像型 PDF(能成为 container 就是过了拆分的图像型
      // 门控): 显式 scanned 与首次解析同路径, 不依赖文字层探测(pdf.js 对
      // 个别 PDF 探测返回 null 时会把重拆误打回 digital 旧路径)。
      modality: 'scanned' as Modality,
      forceResplit: true,
    });
    if (result.parseStatus !== 'parsed') {
      return fail(c, 500, `重拆失败: ${result.reason ?? result.parseStatus}`, 'resplit_failed');
    }
    await syncBatchLineageGraph(ctx(), docId).catch(() => {});
    return c.json({
      ok: true,
      docId,
      unitCount: result.batchSplit?.unitCount ?? 0,
      childDocIds: result.batchSplit?.childDocIds ?? [],
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[batch] resplit failed:', docId, msg);
    // 重拆已把容器置 parsing(在途状态), 抛错路径必须落终态(不留卡死 parsing)。
    await setDocumentParseStatus(ctx(), docId, 'failed', user.id).catch(() => {});
    return fail(c, 500, `重拆失败: ${msg}`, 'resplit_failed');
  }
});

/**
 * POST /api/batch/:docId/units/:unitId/reextract
 *   body { docType?: string; rotationDeg?: 0|90|180|270; force?: boolean }
 *
 * 单 unit 重抽: 以 overrides 走 processUnitChild 生成新子单据(docType 覆盖须在
 * 激活模板词表内; rotationDeg 覆盖退化为单候选, 并把 rotation_deg +
 * manifest.chosenRotation 落回 unit 行作为最终方向), 随后删旧子单据(unit 行
 * 已指向新子, 级联不误删)。已确认绑定未 force -> 409 unit_bound。
 *
 *   200 { ok: true, unitId, docId }   (docId = 新子单据)
 *   400 invalid_rotation / invalid_doc_type / no_child / block_model_missing
 *   404 not_found(unit 不属于该 container 一并 404); 409 unit_bound
 */
batchRoute.post('/:docId/units/:unitId/reextract', withContainerParamLock, async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'unauthorized' }, 401);
  const docId = c.req.param('docId');
  const unitId = c.req.param('unitId');
  let body: { docType?: unknown; rotationDeg?: unknown; force?: unknown };
  try {
    body = (await c.req.json()) as { docType?: unknown; rotationDeg?: unknown; force?: unknown };
  } catch {
    body = {};
  }
  const force = body.force === true;
  const docTypeOverride =
    typeof body.docType === 'string' && body.docType.trim().length > 0 ? body.docType.trim() : undefined;
  let rotationOverride: number | undefined;
  if (body.rotationDeg !== undefined && body.rotationDeg !== null) {
    const r = body.rotationDeg;
    if (r !== 0 && r !== 90 && r !== 180 && r !== 270) {
      return fail(c, 400, '旋回方向仅支持 0/90/180/270', 'invalid_rotation');
    }
    rotationOverride = r;
  }

  if (!(await isOwnedContainer(docId, user.id))) {
    return fail(c, 404, '单据组不存在或不可访问', 'not_found');
  }
  const units = await listDocumentUnitsByParent(ctx(), docId);
  const unit = units.find((u) => u.id === unitId);
  if (!unit) {
    return fail(c, 404, '单元不存在或不属于该单据组', 'not_found');
  }
  const oldChildId = unit.childDocumentId;
  if (!oldChildId) {
    return fail(c, 400, '该单元尚无子单据, 无法重抽', 'no_child');
  }
  if (docTypeOverride !== undefined) {
    const templateTypes = await listTemplateTypes(ctx());
    const valid = templateTypes.some(
      (t) => t.kind === 'doc_type' && t.isActive && !t.props.aliasOf && t.name === docTypeOverride,
    );
    if (!valid) {
      return fail(c, 400, '未知的业务类型', 'invalid_doc_type');
    }
  }
  const bound = new Set(await listDocumentIdsWithConfirmedBindings(ctx(), user.id));
  if (bound.has(oldChildId) && !force) {
    return fail(c, 409, '该单元已有确认绑定, 重抽将删除其绑定', 'unit_bound', [
      { docId: oldChildId, unitIndex: unit.unitIndex },
    ]);
  }
  const sourceUri = await getDocumentSourceUri(ctx(), docId, user.id);
  const parentModel = sourceUri ? await loadDocument(ctx(), docId, user.id) : null;
  if (!sourceUri || !parentModel) {
    return fail(c, 400, '单据组块模型缺失, 无法重建子单据', 'block_model_missing');
  }

  const types = await listTemplateTypes(ctx());
  const info = resolveUnitRouteInfo(unit.docType, types);
  const effectiveRoute = docTypeOverride
    ? docTypeOverride in VOUCHER_SCHEMAS
      ? (docTypeOverride as VoucherType)
      : null
    : info.route;
  let unitPages: RenderedPage[] | null = null;
  if (effectiveRoute) {
    try {
      unitPages = await renderPdfPages(sourceUri);
    } catch {
      unitPages = null; // 渲染失败回落 OCR 块路径
    }
  }
  const newChildId = await processUnitChild({
    ctx: ctx(),
    sourceUri,
    parentModel,
    unit: detectedUnitOf(unit),
    unitRowId: unit.id,
    opts: { ...buildIngestDeps(), userId: user.id },
    unitPages,
    routedDocType: effectiveRoute,
    hint: docTypeOverride ? (docTypeOverride as DocType) : info.hint,
    unitManifest: unit.manifest,
    overrides: { docTypeOverride, rotationOverride },
  });
  if (!newChildId) {
    return fail(c, 500, '子单据创建失败, 原子单据保留', 'child_create_failed');
  }
  // 人工指定旋回 = 最终方向: rotation_deg + manifest.chosenRotation 落库
  // (无 candidateScores —— 非择优, 是人工裁决)。fire-and-forget。
  if (rotationOverride !== undefined) {
    await updateDocumentUnitManifest(ctx(), unit.id, {
      rotationDeg: rotationOverride,
      manifest: { ...unit.manifest, chosenRotation: rotationOverride },
    }).catch(() => {});
  }
  // 旧子删除: unit 行此时已指向新子, deleteDocument 的 unit 行级联不会误删。
  await deleteDocument(ctx(), oldChildId, user.id);
  await syncBatchLineageGraph(ctx(), docId).catch(() => {});
  return c.json({ ok: true, unitId, docId: newChildId });
});

/**
 * POST /api/batch/:docId/units/merge   body { unitIds: string[] } (>=2, 同 container)
 *
 * 合并修正: unitIndex 升序取最小行为保留行; manifest 首个非空字段(formType/
 * identifier)+ evidence/regions 拼接 + merged:true/mergedFrom; 页码取包络;
 * 重建保留行子单据, 其余行(连同各自子单据)删除。任一参与 unit 已确认绑定 ->
 * 409(merge 无 force 语义 —— 绑定随删除会丢, 必须先解绑)。
 *
 *   200 { ok: true, mergedUnitId, docId }   (docId = 重建的新子单据)
 *   400 invalid_unit_ids(<2 / 未知 / 跨 container); 404 not_found; 409 unit_bound
 */
batchRoute.post('/:docId/units/merge', withContainerParamLock, async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'unauthorized' }, 401);
  const docId = c.req.param('docId');
  let body: { unitIds?: unknown };
  try {
    body = (await c.req.json()) as { unitIds?: unknown };
  } catch {
    body = {};
  }
  const unitIds = Array.isArray(body.unitIds)
    ? body.unitIds.filter((x): x is string => typeof x === 'string')
    : [];
  if (unitIds.length < 2) {
    return fail(c, 400, '合并至少需要选择两个单元', 'invalid_unit_ids');
  }
  if (!(await isOwnedContainer(docId, user.id))) {
    return fail(c, 404, '单据组不存在或不可访问', 'not_found');
  }
  const units = await listDocumentUnitsByParent(ctx(), docId);
  const byId = new Map(units.map((u) => [u.id, u]));
  const participants: DocumentUnitRow[] = [];
  for (const id of unitIds) {
    const u = byId.get(id);
    if (!u) {
      return fail(c, 400, '单元不存在或不属于该单据组', 'invalid_unit_ids');
    }
    participants.push(u);
  }
  const ordered = [...new Map(participants.map((p) => [p.id, p])).values()].sort(
    (a, b) => a.unitIndex - b.unitIndex,
  );
  if (ordered.length < 2) {
    return fail(c, 400, '合并至少需要两个不同单元', 'invalid_unit_ids');
  }
  const bound = new Set(await listDocumentIdsWithConfirmedBindings(ctx(), user.id));
  const detail = boundDetail(ordered, bound);
  if (detail.length > 0) {
    return fail(c, 409, '参与合并的单元存在确认绑定, 不可合并', 'unit_bound', detail);
  }
  const sourceUri = await getDocumentSourceUri(ctx(), docId, user.id);
  const parentModel = sourceUri ? await loadDocument(ctx(), docId, user.id) : null;
  if (!sourceUri || !parentModel) {
    return fail(c, 400, '单据组块模型缺失, 无法重建子单据', 'block_model_missing');
  }

  // 合并字段: 保留 unitIndex 最小行; 页码包络; manifest 首个非空 + 拼接。
  const kept = ordered[0]!;
  const pageStarts = ordered.map((p) => p.pageStart).filter((v): v is number => v !== null);
  const pageEnds = ordered.map((p) => p.pageEnd).filter((v): v is number => v !== null);
  const pageStart = pageStarts.length > 0 ? Math.min(...pageStarts) : null;
  const pageEnd = pageEnds.length > 0 ? Math.max(...pageEnds) : null;
  const regions = ordered.flatMap((p) => regionsFromManifest(p.manifest));
  const firstString = (key: string): string | null => {
    for (const p of ordered) {
      const v = p.manifest[key];
      if (typeof v === 'string' && v.length > 0) return v;
    }
    return null;
  };
  const mergedManifest: Record<string, unknown> = {
    ...kept.manifest,
    merged: true,
    mergedFrom: ordered.map((p) => p.id),
    formType: firstString('formType') ?? kept.docType,
    identifier: firstString('identifier'),
    evidence: ordered
      .map((p) => (typeof p.manifest.evidence === 'string' ? p.manifest.evidence : ''))
      .filter((s) => s.length > 0)
      .join(' ; '),
    regions,
  };
  await updateDocumentUnitManifest(ctx(), kept.id, {
    manifest: mergedManifest,
    ...(pageStart !== null ? { pageStart } : {}),
    ...(pageEnd !== null ? { pageEnd } : {}),
  });

  // 重建保留行子单据(合并后的检测视图: bbox 置 null, 区域为拼接结果)。
  const types = await listTemplateTypes(ctx());
  const info = resolveUnitRouteInfo(kept.docType, types);
  let unitPages: RenderedPage[] | null = null;
  if (info.route) {
    try {
      unitPages = await renderPdfPages(sourceUri);
    } catch {
      unitPages = null;
    }
  }
  const mergedIdentifier = mergedManifest.identifier;
  const mergedEvidence = mergedManifest.evidence;
  const mergedUnit: DetectedUnit = {
    unitIndex: kept.unitIndex,
    formType: kept.docType,
    confidence: Math.min(...ordered.map((p) => p.detectorConfidence)),
    identifier: typeof mergedIdentifier === 'string' && mergedIdentifier.length > 0 ? mergedIdentifier : null,
    evidence: typeof mergedEvidence === 'string' ? mergedEvidence : '',
    pageStart: pageStart ?? 1,
    pageEnd: pageEnd ?? pageStart ?? 1,
    bbox: null,
    rotationDeg: regions[0]?.rotationDeg ?? kept.rotationDeg ?? 0,
    regions,
  };
  const newChildId = await processUnitChild({
    ctx: ctx(),
    sourceUri,
    parentModel,
    unit: mergedUnit,
    unitRowId: kept.id,
    opts: { ...buildIngestDeps(), userId: user.id },
    unitPages,
    routedDocType: info.route,
    hint: info.hint,
    unitManifest: mergedManifest,
  });
  if (!newChildId) {
    return fail(c, 500, '子单据创建失败, 合并未完成', 'child_create_failed');
  }
  // 删被合并方 unit 行与全部参与方的旧子单据(保留行已指向新子, 级联不误删)。
  await deleteDocumentUnitsByIds(ctx(), ordered.slice(1).map((p) => p.id));
  for (const p of ordered) {
    if (p.childDocumentId) {
      await deleteDocument(ctx(), p.childDocumentId, user.id);
    }
  }
  await syncBatchLineageGraph(ctx(), docId).catch(() => {});
  return c.json({ ok: true, mergedUnitId: kept.id, docId: newChildId });
});
