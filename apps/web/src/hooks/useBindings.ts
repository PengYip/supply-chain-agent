import { useState, useEffect, useCallback, useRef } from 'react';
import { normalizeFlowSkips } from '../lib/flowSkip';
import { fetchTemplateContext, type TemplateContext } from '../api/templateContext';

/* ---------- 契约(与 server routes/bindings.ts 一致) ---------- */

/** overview 中每文档的绑定条目(rejected 不返回)。 */
export interface BindingListItem {
  bindingId: string;
  contractNo: string;
  relation: string;
  status: string;
  confidence: number;
  confirmationSource: string | null;
  graphStatus: { status: string; reason?: string } | null;
}

/** GET /api/bindings/overview 的文档行。 */
export interface OverviewDoc {
  docId: string;
  fileName: string;
  /** 文件所在目录(如 "/汽运业务资料/煤焦化/2.发运单据"), 根目录为 "/"。 */
  directory: string;
  docType: string;
  createdAt: string;
  bindings: BindingListItem[];
}

/** GET /api/bindings/candidates 的候选行(纯计算, 不落库)。 */
export interface BindingCandidateItem {
  contractNo: string;
  score: number;
  route: 'auto_rule' | 'human' | 'none';
  evidence: {
    partyScore: number;
    timeScore: number;
    amountScore: number;
    qtyScore: number;
    details: string[];
  } | null;
  existingBindingId: string | null;
  ledger: { contractNo: string; displayContractNo: string; title: string; docType: string } | null;
}

/** 文档锚点(凭证抽取或通用字段推断)。 */
export interface Anchors {
  contractNo?: string;
  buyer?: string;
  seller?: string;
  date?: string;
  amount?: number;
  quantityTon?: number;
}

/** GET /api/bindings/contracts 的台账行(手动绑定下拉)。 */
export interface ContractOption {
  contractNo: string;
  displayContractNo: string;
  docType: string;
  title: string;
  overallConfidence: number;
}

/** GET /api/bindings/proposals 的建议行(status=proposed)。 */
export interface ProposalItem {
  bindingId: string;
  documentId: string;
  docType: string;
  fileName: string;
  contractNo: string;
  relation: string;
  confidence: number;
  evidence: BindingCandidateItem['evidence'];
  graphStatus: BindingListItem['graphStatus'];
}

export interface CandidatesState {
  docId: string;
  hasExtraction: boolean;
  anchors: Anchors;
  list: BindingCandidateItem[];
}

/** batch-confirm 的逐条结果。 */
export interface BatchConfirmResult {
  bindingId: string;
  ok: boolean;
  graphSync?: string;
  error?: string;
}

/** 文档类型修正下拉的兜底选项（仅当前端拿不到后端列表时使用）。
 *  真实来源是 GET /api/bindings/overview 响应中的 docTypes 字段；
 *  后端返回了合法列表时以后端为准，字段缺失或格式非法时回退到这里的固定 8 项。 */
const DOC_TYPE_OPTIONS = ['合同', '发票', '提单', '装箱单', '货转单', '化验报告', '付款凭证', '其他'];

/* ---------- 响应解析(照 useGraph.ts 模式: {ok,data} 信封兼容 + 中文错误) ---------- */

async function getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, { credentials: 'include', signal });
  } catch {
    throw new Error('网络错误，请稍后重试');
  }
  await assertOk(res);
  return parseResponse<T>(res);
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
    throw new Error('网络错误，请稍后重试');
  }
  await assertOk(res);
  return parseResponse<T>(res);
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
  await assertOk(res);
  return parseResponse<T>(res);
}

/** 非 2xx 时解析服务端 error/message/detail 并抛中文错误(照 useGraph.ts:53-66 模式)。 */
async function assertOk(res: Response): Promise<void> {
  if (res.ok) return;
  let message = `请求失败（${res.status}）`;
  try {
    const data = (await res.json()) as { error?: unknown; message?: unknown; detail?: unknown };
    const serverMsg =
      typeof data.error === 'string' && data.error
        ? data.error
        : typeof data.message === 'string' && data.message
          ? data.message
          : Array.isArray(data.detail)
            ? data.detail.join('；')
            : '';
    if (serverMsg) message = serverMsg;
  } catch {
    /* 非 JSON 响应，保留状态码消息 */
  }
  throw new Error(message);
}

async function parseResponse<T>(res: Response): Promise<T> {
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

/* ---------- 防御性归一化 ---------- */

function asStr(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function asNum(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function asGraphStatus(v: unknown): BindingListItem['graphStatus'] {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const raw = v as { status?: unknown; reason?: unknown };
  const status = asStr(raw.status);
  if (!status) return null;
  const reason = asStr(raw.reason);
  return reason ? { status, reason } : { status };
}

function asEvidence(v: unknown): BindingCandidateItem['evidence'] {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const raw = v as Record<string, unknown>;
  const details = Array.isArray(raw.details) ? raw.details.map(asStr).filter(Boolean) : [];
  return {
    partyScore: asNum(raw.partyScore),
    timeScore: asNum(raw.timeScore),
    amountScore: asNum(raw.amountScore),
    qtyScore: asNum(raw.qtyScore),
    details,
  };
}

function normalizeBinding(raw: Record<string, unknown>): BindingListItem | null {
  const bindingId = asStr(raw.bindingId);
  if (!bindingId) return null;
  return {
    bindingId,
    contractNo: asStr(raw.contractNo),
    relation: asStr(raw.relation),
    status: asStr(raw.status),
    confidence: asNum(raw.confidence),
    confirmationSource: typeof raw.confirmationSource === 'string' ? raw.confirmationSource : null,
    graphStatus: asGraphStatus(raw.graphStatus),
  };
}

function normalizeOverviewDoc(raw: Record<string, unknown>): OverviewDoc | null {
  const docId = asStr(raw.docId);
  if (!docId) return null;
  const bindings = Array.isArray(raw.bindings)
    ? raw.bindings
        .map((b) => (b && typeof b === 'object' ? normalizeBinding(b as Record<string, unknown>) : null))
        .filter((b): b is BindingListItem => b !== null)
    : [];
  return {
    docId,
    fileName: asStr(raw.fileName),
    directory: asStr(raw.directory) || '/',
    docType: asStr(raw.docType),
    createdAt: asStr(raw.createdAt),
    bindings,
  };
}

function normalizeRoute(v: unknown): BindingCandidateItem['route'] {
  return v === 'auto_rule' || v === 'human' ? v : 'none';
}

function normalizeCandidate(raw: Record<string, unknown>): BindingCandidateItem | null {
  const contractNo = asStr(raw.contractNo);
  if (!contractNo) return null;
  const ledgerRaw = raw.ledger;
  const ledger =
    ledgerRaw && typeof ledgerRaw === 'object' && !Array.isArray(ledgerRaw)
      ? (() => {
          const l = ledgerRaw as Record<string, unknown>;
          const no = asStr(l.contractNo);
          return no
            ? {
                contractNo: no,
                displayContractNo: asStr(l.displayContractNo) || no,
                title: asStr(l.title),
                docType: asStr(l.docType),
              }
            : null;
        })()
      : null;
  return {
    contractNo,
    score: asNum(raw.score),
    route: normalizeRoute(raw.route),
    evidence: asEvidence(raw.evidence),
    existingBindingId: typeof raw.existingBindingId === 'string' ? raw.existingBindingId : null,
    ledger,
  };
}

function normalizeProposal(raw: Record<string, unknown>): ProposalItem | null {
  const bindingId = asStr(raw.bindingId);
  const documentId = asStr(raw.documentId);
  if (!bindingId || !documentId) return null;
  return {
    bindingId,
    documentId,
    docType: asStr(raw.docType),
    fileName: asStr(raw.fileName),
    contractNo: asStr(raw.contractNo),
    relation: asStr(raw.relation),
    confidence: asNum(raw.confidence),
    evidence: asEvidence(raw.evidence),
    graphStatus: asGraphStatus(raw.graphStatus),
  };
}

function normalizeContract(raw: Record<string, unknown>): ContractOption | null {
  const contractNo = asStr(raw.contractNo);
  if (!contractNo) return null;
  return {
    contractNo,
    displayContractNo: asStr(raw.displayContractNo) || contractNo,
    docType: asStr(raw.docType),
    title: asStr(raw.title),
    overallConfidence: asNum(raw.overallConfidence),
  };
}

/* ---------- Hook ---------- */

export function useBindings() {
  const [overview, setOverview] = useState<OverviewDoc[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [proposals, setProposals] = useState<ProposalItem[]>([]);

  const [candidates, setCandidates] = useState<CandidatesState | null>(null);
  const [candidatesLoading, setCandidatesLoading] = useState(false);
  const [candidatesError, setCandidatesError] = useState<string | null>(null);

  // 模板上下文(双下拉数据源): 仅最新文档的; 切档/清除文档时置 null。
  const [templateContext, setTemplateContext] = useState<TemplateContext | null>(null);
  const [templateContextLoading, setTemplateContextLoading] = useState(false);
  const [templateContextError, setTemplateContextError] = useState<{ docId: string; message: string } | null>(null);
  const templateContextAbortRef = useRef<AbortController | null>(null);

  const [contracts, setContracts] = useState<ContractOption[]>([]);

  // 文档类型可选值: 初始为兜底常量, overview 响应携带 docTypes 时以后端为准。
  const [docTypes, setDocTypes] = useState<string[]>(DOC_TYPE_OPTIONS);

  const refreshOverview = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await getJson<{ documents?: unknown[]; docTypes?: unknown[] }>('/api/bindings/overview');
      // docTypes 防御性解析: 后端未上线该字段或格式非法时, 保持现有列表(首次即兜底常量)。
      const rawTypes = Array.isArray(data?.docTypes) ? data.docTypes : [];
      const typeList = rawTypes.map(asStr).filter(Boolean);
      if (typeList.length > 0) setDocTypes(typeList);
      const rawList = Array.isArray(data?.documents) ? data.documents : [];
      const docs = rawList
        .map((raw) => (raw && typeof raw === 'object' ? normalizeOverviewDoc(raw as Record<string, unknown>) : null))
        .filter((d): d is OverviewDoc => d !== null);
      docs.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
      setOverview(docs);
    } catch (e) {
      setError(e instanceof Error ? e.message : '总览加载失败');
    } finally {
      setLoading(false);
    }
  }, []);

  const refreshProposals = useCallback(async () => {
    try {
      const data = await getJson<{ proposals?: unknown[] }>('/api/bindings/proposals');
      const rawList = Array.isArray(data?.proposals) ? data.proposals : [];
      const rows = rawList
        .map((raw) => (raw && typeof raw === 'object' ? normalizeProposal(raw as Record<string, unknown>) : null))
        .filter((p): p is ProposalItem => p !== null);
      setProposals(rows);
    } catch {
      // 建议列表是增强信息, 失败不阻塞页面, 静默降级(统计徽章归零)。
      setProposals([]);
    }
  }, []);

  const loadContracts = useCallback(async () => {
    try {
      const data = await getJson<{ contracts?: unknown[] }>('/api/bindings/contracts');
      const rawList = Array.isArray(data?.contracts) ? data.contracts : [];
      const rows = rawList
        .map((raw) => (raw && typeof raw === 'object' ? normalizeContract(raw as Record<string, unknown>) : null))
        .filter((c): c is ContractOption => c !== null);
      setContracts(rows);
    } catch {
      // 台账加载失败只影响手动绑定表单, 不阻塞页面。
      setContracts([]);
    }
  }, []);

  useEffect(() => {
    void refreshOverview();
    void refreshProposals();
    void loadContracts();
  }, [refreshOverview, refreshProposals, loadContracts]);

  const loadCandidates = useCallback(async (docId: string) => {
    setCandidatesLoading(true);
    setCandidatesError(null);
    try {
      const data = await getJson<{ hasExtraction?: unknown; anchors?: unknown; candidates?: unknown[] }>(
        `/api/bindings/candidates?documentId=${encodeURIComponent(docId)}`,
      );
      const anchorsRaw =
        data?.anchors && typeof data.anchors === 'object' && !Array.isArray(data.anchors)
          ? (data.anchors as Record<string, unknown>)
          : {};
      const anchors: Anchors = {
        contractNo: asStr(anchorsRaw.contractNo) || undefined,
        buyer: asStr(anchorsRaw.buyer) || undefined,
        seller: asStr(anchorsRaw.seller) || undefined,
        date: asStr(anchorsRaw.date) || undefined,
        amount: typeof anchorsRaw.amount === 'number' && Number.isFinite(anchorsRaw.amount) ? anchorsRaw.amount : undefined,
        quantityTon:
          typeof anchorsRaw.quantityTon === 'number' && Number.isFinite(anchorsRaw.quantityTon)
            ? anchorsRaw.quantityTon
            : undefined,
      };
      const rawList = Array.isArray(data?.candidates) ? data.candidates : [];
      const list = rawList
        .map((raw) => (raw && typeof raw === 'object' ? normalizeCandidate(raw as Record<string, unknown>) : null))
        .filter((c): c is BindingCandidateItem => c !== null);
      setCandidates({
        docId,
        hasExtraction: data?.hasExtraction === true,
        anchors,
        list,
      });
    } catch (e) {
      setCandidates(null);
      setCandidatesError(e instanceof Error ? e.message : '候选生成失败');
    } finally {
      setCandidatesLoading(false);
    }
  }, []);

  /** 加载模板上下文(双下拉数据源)。abort 竞态防护: 后发先至丢弃。 */
  const loadTemplateContext = useCallback(async (docId: string) => {
    templateContextAbortRef.current?.abort();
    const ac = new AbortController();
    templateContextAbortRef.current = ac;
    setTemplateContextLoading(true);
    setTemplateContextError(null);
    try {
      const data = await fetchTemplateContext(docId, ac.signal);
      if (ac.signal.aborted) return;              // 后发先至丢弃
      setTemplateContext({ ...data, documentId: data.documentId || docId });
    } catch (e) {
      if (ac.signal.aborted || (e instanceof DOMException && e.name === 'AbortError')) return;
      setTemplateContext(null);
      setTemplateContextError({ docId, message: e instanceof Error ? e.message : '模板上下文加载失败' });
    } finally {
      if (!ac.signal.aborted) setTemplateContextLoading(false);
    }
  }, []);

  /* ---------- 写操作(页面二次确认后调用; 乐观更新由视图层负责) ---------- */

  const confirmBinding = useCallback(
    (bindingId: string) =>
      postJson<{ ok: boolean; bindingId: string; graphSync: string; graphReason?: string }>('/api/bindings/confirm', {
        bindingId,
      }),
    [],
  );

  const rejectBinding = useCallback(
    (bindingId: string) => postJson<{ ok: boolean; bindingId: string }>('/api/bindings/reject', { bindingId }),
    [],
  );

  const createBinding = useCallback(
    (p: { documentId: string; contractNo: string; relation: string; note?: string }) =>
      postJson<{ ok: boolean; bindingId: string; existing?: boolean; graphSync: string; graphReason?: string }>(
        '/api/bindings',
        p,
      ),
    [],
  );

  const unbindBinding = useCallback(
    (bindingId: string) =>
      postJson<{ ok: boolean; bindingId: string; graphSync: string }>('/api/bindings/unbind', { bindingId }),
    [],
  );

  const batchConfirm = useCallback(
    (bindingIds: string[]) =>
      postJson<{ results?: unknown[] }>('/api/bindings/batch-confirm', { bindingIds }).then((data) => {
        const rawList = Array.isArray(data?.results) ? data.results : [];
        return rawList.map((raw) => {
          const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
          return {
            bindingId: asStr(r.bindingId),
            ok: r.ok === true,
            graphSync: asStr(r.graphSync) || undefined,
            error: asStr(r.error) || undefined,
          } satisfies BatchConfirmResult;
        });
      }),
    [],
  );

  /** 修正文档类型(PATCH /api/documents/:docId/type), 成功返回回显 docType、刷新的流水条数
   *  与跳过明细(旧后端不带 skipped -> 空数组)。 */
  const correctDocType = useCallback(
    (docId: string, docType: string) =>
      patchJson<{
        ok: boolean;
        docType: string;
        refreshedFlows: number;
        skipped?: unknown;
      }>(`/api/documents/${encodeURIComponent(docId)}/type`, { docType }).then((data) => ({
        ...data,
        skipped: normalizeFlowSkips(data.skipped),
      })),
    [],
  );

  /** 写操作成功后的统一对账(总览 + 建议 + 当前文档候选 + 模板上下文)。 */
  const refreshAll = useCallback(
    (docId: string | null) => {
      void refreshOverview();
      void refreshProposals();
      if (docId) { void loadCandidates(docId); void loadTemplateContext(docId); }
    },
    [refreshOverview, refreshProposals, loadCandidates, loadTemplateContext],
  );

  // 组件卸载时 abort 在途模板上下文请求。
  useEffect(() => () => { templateContextAbortRef.current?.abort(); }, []);

  /** 视图层乐观更新入口：对 overview 应用补丁(失败时可用快照整体回滚)。 */
  const patchOverview = useCallback((fn: (prev: OverviewDoc[]) => OverviewDoc[]) => {
    setOverview((prev) => fn(prev));
  }, []);

  /** 视图层乐观更新入口：对建议列表应用补丁。 */
  const patchProposals = useCallback((fn: (prev: ProposalItem[]) => ProposalItem[]) => {
    setProposals((prev) => fn(prev));
  }, []);

  return {
    overview,
    loading,
    error,
    refreshOverview,
    patchOverview,
    proposals,
    refreshProposals,
    patchProposals,
    candidates,
    candidatesLoading,
    candidatesError,
    loadCandidates,
    templateContext,
    templateContextLoading,
    templateContextError,
    loadTemplateContext,
    contracts,
    docTypes,
    confirmBinding,
    rejectBinding,
    createBinding,
    unbindBinding,
    batchConfirm,
    correctDocType,
    refreshAll,
  };
}

export type BindingsApi = ReturnType<typeof useBindings>;
