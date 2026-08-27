// 文档类型修正 API client(照 contractSearch.ts 的 getJson 模式: 信封兼容 + 中文错误)。
// 复核卡与绑定工作台共用同一后端端点: GET /api/bindings/overview 的 docTypes
// 词表 + PATCH /api/documents/:docId/type。

import { normalizeFlowSkips, type FlowSkipEntry } from '../lib/flowSkip';

/** 词表兜底(与 useBindings 的 DOC_TYPE_OPTIONS 一致): 后端未上线 docTypes
 *  字段或格式非法时使用, 保证改类型入口始终可用。 */
export const DOC_TYPE_FALLBACK: readonly string[] = [
  '合同', '发票', '提单', '装箱单', '货转单', '化验报告', '付款凭证', '其他',
];

async function getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, { credentials: 'include', signal });
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') throw e;
    throw new Error('网络错误，请稍后重试');
  }
  return parseBody<T>(res);
}

async function patchJson<T>(url: string, body: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(body),
    });
  } catch {
    throw new Error('网络错误，请稍后重试');
  }
  return parseBody<T>(res);
}

/** 非 2xx 解析服务端 error/message 并抛中文错误; 2xx 兼容 {ok,data} 信封。 */
async function parseBody<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let message = `请求失败（${res.status}）`;
    try {
      const data = (await res.json()) as { error?: unknown; message?: unknown };
      const serverMsg =
        typeof data.error === 'string' && data.error
          ? data.error
          : typeof data.message === 'string' && data.message
            ? data.message
            : '';
      if (serverMsg) message = serverMsg;
    } catch { /* 非 JSON 响应，保留状态码消息 */ }
    throw new Error(message);
  }
  let data: unknown;
  try {
    data = await res.json();
  } catch {
    throw new Error('响应格式异常');
  }
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    const envelope = data as { ok?: unknown; data?: unknown };
    if (envelope.ok === true && 'data' in envelope) data = envelope.data;
  }
  return data as T;
}

/** GET /api/bindings/overview -> 激活的 docTypes 词表(只取该字段, 防御性解析)。 */
export async function fetchActiveDocTypes(signal?: AbortSignal): Promise<string[]> {
  const data = await getJson<{ docTypes?: unknown }>('/api/bindings/overview', signal);
  const rawList = Array.isArray(data?.docTypes) ? data.docTypes : [];
  const list = rawList.filter((x): x is string => typeof x === 'string' && x.length > 0);
  return list.length > 0 ? list : [...DOC_TYPE_FALLBACK];
}

export interface CorrectDocTypeResult {
  ok: boolean;
  docType: string;
  refreshedFlows: number;
  skipped: FlowSkipEntry[];
}

/** PATCH /api/documents/:docId/type: 修正文档类型, 返回回显类型与刷新的流水条数。 */
export async function correctDocumentType(docId: string, docType: string): Promise<CorrectDocTypeResult> {
  const data = await patchJson<{ ok: boolean; docType: string; refreshedFlows: number; skipped?: unknown }>(
    `/api/documents/${encodeURIComponent(docId)}/type`,
    { docType },
  );
  return {
    ok: data.ok === true,
    docType: typeof data.docType === 'string' ? data.docType : docType,
    refreshedFlows: typeof data.refreshedFlows === 'number' ? data.refreshedFlows : 0,
    skipped: normalizeFlowSkips(data.skipped),
  };
}
