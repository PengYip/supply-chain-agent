import { useCallback, useEffect, useState } from 'react';

/* ---------- 契约(与 server routes/parties.ts 一致) ---------- */

/** GET /api/parties 的已配置主体行(生效名单 = db + env)。 */
export interface SelfParty {
  name: string;
  source: 'db' | 'env';
  createdAt: string | null;
}

/** 读取时计算的候选建议: 已排除生效名单, 上限 20, docCount 降序。 */
export interface PartyCandidate {
  name: string;
  docCount: number;
  lastSeenAt: string | null;
  isContractParty: boolean;
  documentIds: string[];
}

/** POST /api/parties 响应。added=false 表示名称已在名单中(幂等)。 */
export interface AddPartyResult {
  ok: boolean;
  added: boolean;
  refreshedFlows: number;
  failed: number;
}

/** DELETE /api/parties/:name 响应。removed=false 表示名称来自环境变量(前端不提供该入口)。 */
export interface RemovePartyResult {
  ok: boolean;
  removed: boolean;
}

/* ---------- 请求助手(照 useBindings.ts 模式: 中文错误 + {ok,data} 信封兼容) ---------- */

async function getJson<T>(url: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, { credentials: 'include' });
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

async function deleteJson<T>(url: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'DELETE',
      credentials: 'include',
    });
  } catch {
    throw new Error('网络错误，请稍后重试');
  }
  await assertOk(res);
  return parseResponse<T>(res);
}

/** 非 2xx 时解析服务端 error/message 并抛中文错误(照 useBindings.ts 模式)。 */
async function assertOk(res: Response): Promise<void> {
  if (res.ok) return;
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

function normalizeParty(raw: Record<string, unknown>): SelfParty | null {
  const name = asStr(raw.name);
  if (!name) return null;
  return {
    name,
    // 契约值为 'db' | 'env'; 未知值按 'env' 兜底(不提供删除入口, 宁可少删不可误删)。
    source: raw.source === 'db' ? 'db' : 'env',
    createdAt: asStr(raw.createdAt) || null,
  };
}

function normalizeCandidate(raw: Record<string, unknown>): PartyCandidate | null {
  const name = asStr(raw.name);
  if (!name) return null;
  return {
    name,
    docCount: asNum(raw.docCount),
    lastSeenAt: asStr(raw.lastSeenAt) || null,
    isContractParty: raw.isContractParty === true,
    documentIds: Array.isArray(raw.documentIds) ? raw.documentIds.map(asStr).filter(Boolean) : [],
  };
}

/* ---------- Hook ---------- */

export function useParties() {
  const [parties, setParties] = useState<SelfParty[]>([]);
  const [candidates, setCandidates] = useState<PartyCandidate[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // 忽略名单: 仅前端本地内存状态, 不落库、不随刷新持久 —— 页面重载后被忽略的
  // 候选会重新出现。规格允许: 候选是读取时确定性计算的, 忽略只是本次会话的降噪。
  const [ignored, setIgnored] = useState<Set<string>>(new Set());

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await getJson<{ parties?: unknown[]; candidates?: unknown[] }>('/api/parties');
      const rawParties = Array.isArray(data?.parties) ? data.parties : [];
      const list = rawParties
        .map((raw) => (raw && typeof raw === 'object' ? normalizeParty(raw as Record<string, unknown>) : null))
        .filter((p): p is SelfParty => p !== null);
      setParties(list);
      const rawCandidates = Array.isArray(data?.candidates) ? data.candidates : [];
      const cands = rawCandidates
        .map((raw) => (raw && typeof raw === 'object' ? normalizeCandidate(raw as Record<string, unknown>) : null))
        .filter((c): c is PartyCandidate => c !== null);
      setCandidates(cands);
    } catch (e) {
      setError(e instanceof Error ? e.message : '主体名单加载失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const addParty = useCallback(
    (name: string) => postJson<AddPartyResult>('/api/parties', { name }),
    [],
  );

  const removeParty = useCallback(
    (name: string) => deleteJson<RemovePartyResult>(`/api/parties/${encodeURIComponent(name)}`),
    [],
  );

  const ignoreCandidate = useCallback((name: string) => {
    setIgnored((prev) => {
      if (prev.has(name)) return prev;
      const next = new Set(prev);
      next.add(name);
      return next;
    });
  }, []);

  return {
    parties,
    candidates,
    ignored,
    ignoreCandidate,
    loading,
    error,
    refresh,
    addParty,
    removeParty,
  };
}

export type PartiesApi = ReturnType<typeof useParties>;
