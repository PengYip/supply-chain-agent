// apps/web/src/api/evalDatasets.ts
export interface DatasetInfo { name: string; builtin: boolean; scenarioCount: number | null }
export interface DatasetDetail { name: string; builtin: boolean; yaml: string }

async function req(url: string, init?: RequestInit): Promise<unknown> {
  const res = await fetch(url, { credentials: 'include', ...init });
  const data = (await res.json().catch(() => null)) as { ok?: boolean; error?: string; data?: unknown } | null;
  if (!res.ok || !data?.ok) {
    const err = new Error(data?.error ?? `请求失败 (${res.status})`) as Error & { status?: number };
    err.status = res.status;
    throw err;
  }
  return data.data;
}

export function listEvalDatasets(): Promise<{ datasets: DatasetInfo[] }> {
  return req('/api/eval/datasets') as Promise<{ datasets: DatasetInfo[] }>;
}
export function getEvalDataset(name: string): Promise<DatasetDetail> {
  return req(`/api/eval/datasets/${encodeURIComponent(name)}`) as Promise<DatasetDetail>;
}
export function putEvalDataset(name: string, yaml: string): Promise<{ scenarioCount: number }> {
  return req(`/api/eval/datasets/${encodeURIComponent(name)}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ yaml }),
  }) as Promise<{ scenarioCount: number }>;
}
export function copyEvalDataset(name: string, to: string): Promise<{ name: string }> {
  return req(`/api/eval/datasets/${encodeURIComponent(name)}/copy?to=${encodeURIComponent(to)}` as never, { method: 'POST' }) as Promise<{ name: string }>;
}
export function deleteEvalDataset(name: string): Promise<void> {
  return req(`/api/eval/datasets/${encodeURIComponent(name)}`, { method: 'DELETE' }) as Promise<void>;
}
