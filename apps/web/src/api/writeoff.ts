export interface WriteoffBalanceRow {
  id: string;
  entityType: string;
  label: string;
  currency: string | null;
  amount: number;
  applied: number;
  remaining: number;
  validAt: string | null;
  status: 'none' | 'partial' | 'full';
}

export interface WriteoffMode {
  relation: string;
  description: string;
  srcTypes: string[];
  dstTypes: string[];
  funds: WriteoffBalanceRow[];
  targets: WriteoffBalanceRow[];
}

export interface WriteoffOverview {
  asOf: string;
  modes: WriteoffMode[];
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, { credentials: 'include', ...init });
  } catch {
    throw new Error('网络错误，请稍后重试');
  }
  if (!res.ok) {
    let message = `请求失败（${res.status}）`;
    try {
      const data = (await res.json()) as { error?: string; detail?: unknown; violations?: Array<{ detail: string }> };
      if (data?.violations?.length) {
        message = `校验失败：${data.violations.map((v) => v.detail).join('；')}`;
      } else if (data?.error) {
        message = data.detail ? `${data.error}：${String(data.detail).slice(0, 200)}` : data.error;
      }
    } catch { /* 非 JSON 响应 */ }
    throw new Error(message);
  }
  return (await res.json()) as T;
}

export function fetchWriteoffOverview(): Promise<WriteoffOverview> {
  return request<WriteoffOverview>('/api/writeoff/overview');
}

export interface SubmitResult {
  sessionId: string;
  runId: string;
  status: string;
}

export function submitWriteoff(
  relation: string,
  items: Array<{ srcId: string; dstId: string; amount: number; partial?: boolean; batch?: string }>,
): Promise<SubmitResult> {
  return request<SubmitResult>('/api/writeoff/submit', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ relation, items }),
  });
}