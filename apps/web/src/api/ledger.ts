// 项目台账视图的绑定总览 API client(照 contractSearch.ts 的 getJson 模式:
// 信封兼容 + 中文错误 + 防御性归一化)。只取台账聚合需要的字段(docType/relation/status)。

async function getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, { credentials: 'include', signal });
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') throw e;
    throw new Error('网络错误，请稍后重试');
  }
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
    } catch { /* 非 JSON 响应 */ }
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

function asStr(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/** 台账聚合用的绑定行(齐套率只认 confirmed, proposed 只计数)。 */
export interface LedgerBinding {
  contractNo: string;
  relation: string;
  status: 'confirmed' | 'proposed' | string;
}

/** 台账聚合用的文档行。 */
export interface LedgerDoc {
  docId: string;
  fileName: string;
  docType: string;
  bindings: LedgerBinding[];
}

export interface LedgerOverview {
  docs: LedgerDoc[];
  docTypes: string[];
}

function normalizeBinding(raw: Record<string, unknown>): LedgerBinding | null {
  const contractNo = asStr(raw.contractNo);
  if (!contractNo) return null;
  return {
    contractNo,
    relation: asStr(raw.relation),
    status: asStr(raw.status),
  };
}

function normalizeDoc(raw: Record<string, unknown>): LedgerDoc | null {
  const docId = asStr(raw.docId);
  if (!docId) return null;
  const bindings = Array.isArray(raw.bindings)
    ? raw.bindings
        .map((b) => (b && typeof b === 'object' ? normalizeBinding(b as Record<string, unknown>) : null))
        .filter((b): b is LedgerBinding => b !== null)
    : [];
  return { docId, fileName: asStr(raw.fileName), docType: asStr(raw.docType), bindings };
}

/** GET /api/bindings/overview -> 文档绑定总览(台账视图聚合凭证齐套率的数据源)。 */
export async function fetchLedgerOverview(signal?: AbortSignal): Promise<LedgerOverview> {
  const data = await getJson<{ documents?: unknown[]; docTypes?: unknown[] }>(
    '/api/bindings/overview',
    signal,
  );
  const docs = (Array.isArray(data?.documents) ? data.documents : [])
    .map((raw) => (raw && typeof raw === 'object' ? normalizeDoc(raw as Record<string, unknown>) : null))
    .filter((d): d is LedgerDoc => d !== null);
  const docTypes = (Array.isArray(data?.docTypes) ? data.docTypes : []).filter(
    (x): x is string => typeof x === 'string' && x.length > 0,
  );
  return { docs, docTypes };
}
