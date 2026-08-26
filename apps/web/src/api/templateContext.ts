// 模板上下文 API client(照 contractSearch.ts 的 getJson 模式: 信封兼容 + 中文错误)。

export interface TemplateContractRef {
  contractNo: string;
  contractType: string | null;
  allowed: boolean;
}

export interface TemplateProjectBlock {
  code: string;
  name: string;
  contracts: TemplateContractRef[];
}

export interface TemplateContext {
  documentId: string;
  docType: string;
  /** 祖先链(自身在前): ['收货单','运输凭证','履约凭证']。 */
  typeChain: string[];
  bindsRelation: string;
  settlesVocab: string[] | null;
  allowedContractTypes: string[];
  projects: TemplateProjectBlock[];
  unassignedContracts: TemplateContractRef[];
  /** Task 0 合入后由后端提供; 缺省视为 'Contract'。 */
  bindsTargetKind?: 'Contract' | 'Project';
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

function asStrArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

function normalizeContractRef(raw: Record<string, unknown>): TemplateContractRef | null {
  const contractNo = asStr(raw.contractNo);
  if (!contractNo) return null;
  const contractType = asStr(raw.contractType) || null;
  return { contractNo, contractType, allowed: typeof raw.allowed === 'boolean' ? raw.allowed : false };
}

function normalizeProjectBlock(raw: Record<string, unknown>): TemplateProjectBlock | null {
  const code = asStr(raw.code);
  if (!code) return null;
  const contracts = Array.isArray(raw.contracts)
    ? raw.contracts
        .map((c) => (c && typeof c === 'object' ? normalizeContractRef(c as Record<string, unknown>) : null))
        .filter((x): x is TemplateContractRef => x !== null)
    : [];
  return { code, name: asStr(raw.name), contracts };
}

/** 防御性归一化(照 contractSearch.ts normalizeItem 模式): 字段缺失/类型错 -> 丢弃或默认。 */
export function normalizeTemplateContext(raw: Record<string, unknown>): TemplateContext | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const documentId = asStr(raw.documentId);
  if (!documentId) return null;
  const projects = Array.isArray(raw.projects)
    ? raw.projects
        .map((p) => (p && typeof p === 'object' ? normalizeProjectBlock(p as Record<string, unknown>) : null))
        .filter((x): x is TemplateProjectBlock => x !== null)
    : [];
  const unassignedContracts = Array.isArray(raw.unassignedContracts)
    ? raw.unassignedContracts
        .map((c) => (c && typeof c === 'object' ? normalizeContractRef(c as Record<string, unknown>) : null))
        .filter((x): x is TemplateContractRef => x !== null)
    : [];
  const bindsTargetKind = raw.bindsTargetKind === 'Project' ? 'Project' : raw.bindsTargetKind === 'Contract' ? 'Contract' : undefined;
  return {
    documentId,
    docType: asStr(raw.docType),
    typeChain: asStrArray(raw.typeChain),
    bindsRelation: asStr(raw.bindsRelation),
    settlesVocab: raw.settlesVocab === null ? null : asStrArray(raw.settlesVocab),
    allowedContractTypes: asStrArray(raw.allowedContractTypes),
    projects,
    unassignedContracts,
    ...(bindsTargetKind ? { bindsTargetKind } : {}),
  };
}

/** GET /api/templates/context?documentId=xxx; signal 供竞态废弃; 信封兼容 + 中文错误。 */
export async function fetchTemplateContext(documentId: string, signal?: AbortSignal): Promise<TemplateContext> {
  const qs = new URLSearchParams({ documentId });
  const data = await getJson<Record<string, unknown>>(`/api/templates/context?${qs.toString()}`, signal);
  const ctx = normalizeTemplateContext(data);
  if (!ctx) throw new Error('模板上下文数据异常');
  return ctx;
}