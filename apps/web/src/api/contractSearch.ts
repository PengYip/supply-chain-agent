// 合同搜索 + 图 schema API(照 useGraph.ts 的 getJson 模式: 信封兼容 + 中文错误)。

export interface ContractSearchItem {
  contractNo: string;
  displayContractNo: string;
  title: string;
  buyer: string | null;
  seller: string | null;
  docType: string;
  overallConfidence: number;
  matchedField: 'contractNo' | 'buyer' | 'seller' | 'title';
}

export interface GraphLabelCount {
  label: string;
  count: number;
}

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

function normalizeItem(raw: Record<string, unknown>): ContractSearchItem | null {
  const contractNo = asStr(raw.contractNo);
  if (!contractNo) return null;
  const matchedField = asStr(raw.matchedField);
  return {
    contractNo,
    displayContractNo: asStr(raw.displayContractNo) || contractNo,
    title: asStr(raw.title),
    buyer: asStr(raw.buyer) || null,
    seller: asStr(raw.seller) || null,
    docType: asStr(raw.docType),
    overallConfidence: typeof raw.overallConfidence === 'number' ? raw.overallConfidence : 0,
    matchedField:
      matchedField === 'buyer' || matchedField === 'seller' || matchedField === 'title'
        ? matchedField
        : 'contractNo',
  };
}

export async function fetchContractSearch(
  q: string,
  limit = 10,
  signal?: AbortSignal,
): Promise<ContractSearchItem[]> {
  const qs = new URLSearchParams({ q, limit: String(limit) });
  const data = await getJson<{ items?: unknown[] }>(`/api/contracts/search?${qs.toString()}`, signal);
  const rawList = Array.isArray(data?.items) ? data.items : [];
  return rawList
    .map((raw) => (raw && typeof raw === 'object' ? normalizeItem(raw as Record<string, unknown>) : null))
    .filter((x): x is ContractSearchItem => x !== null);
}

/** GET /api/bindings/contracts 全量台账(项目指派搜索框的空聚焦候选)。
 *  台账行没有买方/卖方字段, 统一记 matchedField='contractNo';
 *  按综合置信度降序, 调用方自行截断展示条数。失败抛中文错误。 */
export async function fetchLedgerContracts(signal?: AbortSignal): Promise<ContractSearchItem[]> {
  const data = await getJson<{ contracts?: unknown[] }>('/api/bindings/contracts', signal);
  const rawList = Array.isArray(data?.contracts) ? data.contracts : [];
  return rawList
    .map((raw) => {
      if (!raw || typeof raw !== 'object') return null;
      const r = raw as Record<string, unknown>;
      const contractNo = asStr(r.contractNo);
      if (!contractNo) return null;
      const item: ContractSearchItem = {
        contractNo,
        displayContractNo: asStr(r.displayContractNo) || contractNo,
        title: asStr(r.title),
        buyer: null,
        seller: null,
        docType: asStr(r.docType),
        overallConfidence: typeof r.overallConfidence === 'number' ? r.overallConfidence : 0,
        matchedField: 'contractNo',
      };
      return item;
    })
    .filter((x): x is ContractSearchItem => x !== null)
    .sort((a, b) => b.overallConfidence - a.overallConfidence);
}

/** 图例计数; 失败静默降级为 [](图例退化为静态注册表)。 */
export async function fetchGraphSchema(): Promise<GraphLabelCount[]> {
  try {
    const data = await getJson<{ labels?: unknown[] }>('/api/graph/schema');
    const rawList = Array.isArray(data?.labels) ? data.labels : [];
    return rawList
      .map((raw) => {
        const r = raw as Record<string, unknown>;
        return { label: asStr(r.label), count: typeof r.count === 'number' ? r.count : 0 };
      })
      .filter((x) => x.label.length > 0);
  } catch {
    return [];
  }
}