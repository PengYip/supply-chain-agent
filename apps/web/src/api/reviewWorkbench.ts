// apps/web/src/api/reviewWorkbench.ts
// 集中复核工作台 API client(spec 2026-09-04)。类型镜像服务端
// routes/review.ts 的 workbench 响应; envelope 解析与 api/review.ts 同款。
import { submitReview } from './review';

export interface WorkbenchRowIssue {
  rule: string;
  severity: 'error' | 'warning';
  columns: string[];
  message: string;
}

export type WorkbenchRow = Record<string, string | number | null>;

export interface WorkbenchUnit {
  docId: string;
  title: string;
  unitIndex: number;
  reviewStatus: 'pending' | 'confirmed' | 'corrected' | null;
  reviewAction: 'manual' | 'auto-release' | null;
  overallConfidence: number;
  needsReview: boolean;
  warnings: string[];
  pageStart: number | null;
  pageEnd: number | null;
  releaseEligible: boolean;
  rows?: WorkbenchRow[];
  rowChecks?: Array<{ issues: WorkbenchRowIssue[] }>;
  totals?: { 总净重_吨?: number | null; 页数?: number | null; 失败页?: number[] };
  totalCheck?: { expected: number | null; actual: number | null; tolerance: number; pass: boolean };
}

export interface WorkbenchGroup {
  docType: string;
  kind: 'voucher-table' | 'unit-list';
  units: WorkbenchUnit[];
}

export interface WorkbenchData {
  containerDocId: string;
  containerTitle: string;
  groups: WorkbenchGroup[];
}

export async function fetchReviewWorkbench(docId: string): Promise<WorkbenchData> {
  let res: Response;
  try {
    res = await fetch(`/api/documents/${encodeURIComponent(docId)}/review-workbench`, {
      method: 'GET',
      credentials: 'include',
    });
  } catch {
    throw new Error('网络错误，请稍后重试');
  }
  if (!res.ok) throw new Error(`请求失败（${res.status}）`);
  const body = (await res.json()) as { ok: boolean; data?: WorkbenchData; error?: string };
  if (!body || body.ok !== true || !body.data) throw new Error(body.error || '响应格式异常');
  return body.data;
}

export interface ReviewBatchAction {
  docId: string;
  confirm: true;
  action: 'manual' | 'auto-release';
}

export interface ReviewBatchResult {
  docId: string;
  ok: boolean;
  error?: string;
}

export async function submitReviewBatch(
  containerDocId: string,
  actions: ReviewBatchAction[],
): Promise<ReviewBatchResult[]> {
  let res: Response;
  try {
    res = await fetch(`/api/documents/${encodeURIComponent(containerDocId)}/review-batch`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ actions }),
    });
  } catch {
    throw new Error('网络错误，请稍后重试');
  }
  if (!res.ok) throw new Error(`请求失败（${res.status}）`);
  const body = (await res.json()) as { ok: boolean; results?: ReviewBatchResult[]; error?: string };
  if (!body || body.ok !== true || !Array.isArray(body.results)) {
    throw new Error(body.error || '响应格式异常');
  }
  return body.results;
}

/** 行级编辑提交: 组装整个明细行数组走既有 corrections 契约(整字段 JSON 替换)。 */
export async function submitRowCorrections(docId: string, rows: WorkbenchRow[]): Promise<void> {
  await submitReview(docId, {
    corrections: [{ name: '明细行', value: JSON.stringify(rows) }],
  });
}

/** unit 原片 URL: page 省略 = 整 unit 纵拼(Task 6 单页裁切)。 */
export function unitPreviewPageUrl(docId: string, page?: number): string {
  const q = page != null ? `?page=${encodeURIComponent(page)}` : '';
  return `/api/documents/${encodeURIComponent(docId)}/unit-preview${q}`;
}