// 批量拆分(单据组)谱系 API 客户端(照 api/documentType.ts 的 getJson/parseBody
// 惯例: {ok,data} 信封兼容 + 中文错误 + credentials:'include')。
// 读端点 GET /api/documents/:docId/units 随 Phase 3 Task 2 落地;三个修正
// 端点(/api/batch, Task 9)在此先行定型,由 Task 10 的修正入口消费。

/** 子单据解析状态(document_units.status 闭集)。 */
export type UnitStatus = 'pending' | 'processing' | 'processed' | 'needs_ocr' | 'failed';

/** 子单据复核状态(documents.review_status);子单据未生成时为 null。 */
export type UnitReviewStatus = 'pending' | 'confirmed' | 'corrected';

/** 单个拆分单元(子单据)的摘要。文件树的单据组展开行与 container 复核卡
 *  拆分清单共用同一形态(GET /:docId/units 与 review snapshot.batch.units)。 */
export interface BatchUnitSummary {
  /** document_units.id('DU-*')。 */
  unitId: string;
  /** 子单据 documents.id;拆分/抽取未完成时为 null。 */
  docId: string | null;
  /** 1 起的分段序号(检测器现状)。 */
  unitIndex: number;
  /** 检测词表标签(汽运磅单/质检报告...)。 */
  detectedFormType: string;
  /** 子单据落库业务类型;可与 detectedFormType 不同,未分类为 null。 */
  childDocType: string | null;
  unitStatus: UnitStatus;
  reviewStatus: UnitReviewStatus | null;
  /** 最新抽取 needs_review=1(低置信/读数分歧,P2 已强制复核)。 */
  needsReview: boolean;
}

/** 谱系块(review snapshot.batch)。container 侧携带子单据清单与待复核
 *  计数;unit 侧携带来源回链;普通文档为 null。 */
export interface BatchLineage {
  role: 'container' | 'unit';
  // container 侧
  unitCount?: number;
  units?: BatchUnitSummary[];
  needsReviewCount?: number;
  // unit 侧
  /** container 的 documents.id。 */
  parentDocumentId?: string;
  /** container 显示名(minio_key 派生,fallback source_uri basename)。 */
  parentFileName?: string | null;
  unitIndex?: number;
  detectedFormType?: string;
  pageStart?: number | null;
  pageEnd?: number | null;
  /** 择优后的旋回方向(双候选择优落库后即最终值)。 */
  rotationDeg?: number | null;
  regionCount?: number | null;
}

/** /api/batch 修正端点的失败载体: 409 unit_bound 时 detail 为被绑定的
 *  unit 清单(Task 10 需要向用户展示哪些单据已挂合同)。 */
export interface BatchUnitBoundDetail {
  docId: string;
  unitIndex: number;
}

/** 带 status/code/detail 的 API 错误(比裸 Error 多携带结构化上下文,
 *  修正入口据此渲染「哪些 unit 已绑定」一类提示)。 */
export class BatchApiError extends Error {
  readonly status: number;
  readonly code: string | null;
  readonly detail: unknown;
  constructor(message: string, status: number, code: string | null, detail: unknown) {
    super(message);
    this.name = 'BatchApiError';
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

/** 解析 409 unit_bound 的 detail(被绑定 unit 清单)为升序 unitIndex 数组;
 *  形状非法时返回空数组(调用方退化为只显示错误消息)。 */
export function parseBoundUnitIndexes(detail: unknown): number[] {
  if (!Array.isArray(detail)) return [];
  const out: number[] = [];
  for (const d of detail) {
    if (d && typeof d === 'object') {
      const r = d as { unitIndex?: unknown };
      if (typeof r.unitIndex === 'number') out.push(r.unitIndex);
    }
  }
  return out.sort((a, b) => a - b);
}

async function getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, { credentials: 'include', signal });
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') throw e;
    throw new BatchApiError('网络错误，请稍后重试', 0, null, null);
  }
  return parseBody<T>(res);
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(body),
    });
  } catch {
    throw new BatchApiError('网络错误，请稍后重试', 0, null, null);
  }
  return parseBody<T>(res);
}

/** 非 2xx 解析服务端 error/message/code/detail 并抛 BatchApiError(中文消息);
 *  2xx 兼容 {ok,data} 信封。 */
async function parseBody<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let message = `请求失败（${res.status}）`;
    let code: string | null = null;
    let detail: unknown = null;
    try {
      const data = (await res.json()) as {
        error?: unknown;
        message?: unknown;
        code?: unknown;
        detail?: unknown;
      };
      const serverMsg =
        typeof data.error === 'string' && data.error
          ? data.error
          : typeof data.message === 'string' && data.message
            ? data.message
            : '';
      if (serverMsg) message = serverMsg;
      if (typeof data.code === 'string' && data.code) code = data.code;
      if ('detail' in data) detail = data.detail;
    } catch {
      /* 非 JSON 响应，保留状态码消息 */
    }
    throw new BatchApiError(message, res.status, code, detail);
  }
  let data: unknown;
  try {
    data = await res.json();
  } catch {
    throw new BatchApiError('响应格式异常', res.status, null, null);
  }
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    const envelope = data as { ok?: unknown; data?: unknown };
    if (envelope.ok === true && 'data' in envelope) data = envelope.data;
  }
  return data as T;
}

const UNIT_STATUSES: readonly UnitStatus[] = [
  'pending',
  'processing',
  'processed',
  'needs_ocr',
  'failed',
];

const UNIT_REVIEW_STATUSES: readonly UnitReviewStatus[] = [
  'pending',
  'confirmed',
  'corrected',
];

/** 防御性归一化(外部数据不入类型直接信任): unitId 缺失的行整条丢弃,
 *  枚举外的 unitStatus 兜底 pending(展示语义最保守: 尚未处理)。 */
function normalizeUnit(raw: unknown): BatchUnitSummary | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.unitId !== 'string' || !r.unitId) return null;
  return {
    unitId: r.unitId,
    docId: typeof r.docId === 'string' && r.docId ? r.docId : null,
    unitIndex: typeof r.unitIndex === 'number' ? r.unitIndex : 0,
    detectedFormType: typeof r.detectedFormType === 'string' ? r.detectedFormType : '',
    childDocType: typeof r.childDocType === 'string' && r.childDocType ? r.childDocType : null,
    unitStatus: UNIT_STATUSES.find((s) => s === r.unitStatus) ?? 'pending',
    reviewStatus: UNIT_REVIEW_STATUSES.find((s) => s === r.reviewStatus) ?? null,
    needsReview: r.needsReview === true,
  };
}

/** GET /api/documents/:docId/units — 单据组(container)的子单据清单。
 *  非容器/不存在/非本人文档时后端 404,此处抛 BatchApiError(中文消息)。 */
export async function listDocumentUnits(
  docId: string,
  signal?: AbortSignal,
): Promise<BatchUnitSummary[]> {
  const data = await getJson<{ units?: unknown }>(
    `/api/documents/${encodeURIComponent(docId)}/units`,
    signal,
  );
  const list = Array.isArray(data?.units) ? data.units : [];
  return list.map(normalizeUnit).filter((u): u is BatchUnitSummary => u !== null);
}

/** POST /api/batch/:docId/resplit 的成功返回。 */
export interface ResplitResult {
  unitCount: number;
  childDocIds: string[];
}

/** POST /api/batch/:docId/resplit — 重新拆分(Task 10 接线;存在已绑定
 *  unit 且未 force 时后端 409,经 BatchApiError.detail 携带绑定清单)。 */
export async function resplitDocument(docId: string, force = false): Promise<ResplitResult> {
  const data = await postJson<{ unitCount?: unknown; childDocIds?: unknown }>(
    `/api/batch/${encodeURIComponent(docId)}/resplit`,
    force ? { force: true } : {},
  );
  return {
    unitCount: typeof data.unitCount === 'number' ? data.unitCount : 0,
    childDocIds: Array.isArray(data.childDocIds)
      ? data.childDocIds.filter((x): x is string => typeof x === 'string')
      : [],
  };
}

/** POST /api/batch/:docId/units/:unitId/reextract 的请求体(全部可选覆盖项)。 */
export interface ReextractUnitBody {
  docType?: string;
  rotationDeg?: 0 | 90 | 180 | 270;
  force?: boolean;
}

/** POST /api/batch/:docId/units/:unitId/reextract — 单个 unit 重抽(Task 10
 *  接线);返回重建后的子单据 docId。 */
export async function reextractUnit(
  docId: string,
  unitId: string,
  body: ReextractUnitBody = {},
): Promise<{ docId: string }> {
  const data = await postJson<{ docId?: unknown }>(
    `/api/batch/${encodeURIComponent(docId)}/units/${encodeURIComponent(unitId)}/reextract`,
    body,
  );
  return { docId: typeof data.docId === 'string' ? data.docId : '' };
}

/** POST /api/batch/:docId/units/merge — 相邻 unit 合并修正(Task 10 接线)。 */
export async function mergeUnits(
  docId: string,
  unitIds: string[],
): Promise<{ mergedUnitId: string; docId: string }> {
  const data = await postJson<{ mergedUnitId?: unknown; docId?: unknown }>(
    `/api/batch/${encodeURIComponent(docId)}/units/merge`,
    { unitIds },
  );
  return {
    mergedUnitId: typeof data.mergedUnitId === 'string' ? data.mergedUnitId : '',
    docId: typeof data.docId === 'string' ? data.docId : '',
  };
}

/** unitStatus 的统一展示(文件树子行与复核卡拆分清单共用一套徽标语言)。 */
export function unitStatusBadge(status: UnitStatus): { label: string; className: string } {
  switch (status) {
    case 'processed':
      return { label: '已处理', className: 'bg-success/10 text-success' };
    case 'processing':
      return { label: '处理中', className: 'bg-primary-500/10 text-primary-500' };
    case 'needs_ocr':
      return { label: '需OCR', className: 'bg-warning/10 text-warning' };
    case 'failed':
      return { label: '失败', className: 'bg-danger/10 text-danger' };
    default:
      return { label: '待处理', className: 'bg-surface text-ink-soft' };
  }
}

/** unit reviewStatus 的统一展示;null = 子单据尚未生成。 */
export function unitReviewStatusBadge(
  status: UnitReviewStatus | null,
): { label: string; className: string } {
  switch (status) {
    case 'confirmed':
      return { label: '已确认', className: 'bg-success/10 text-success' };
    case 'corrected':
      return { label: '已更正', className: 'bg-primary-500/10 text-primary-500' };
    case 'pending':
      return { label: '待复核', className: 'bg-warning/10 text-warning' };
    default:
      return { label: '未生成', className: 'bg-surface text-ink-soft' };
  }
}
