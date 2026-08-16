// apps/web/src/api/evalRun.ts
import type { RunEvent, LiveInfo } from './evalRunTypes';

async function postJson(url: string, body: unknown): Promise<unknown> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => null)) as { ok?: boolean; error?: string; data?: unknown } | null;
  if (!res.ok || !data?.ok) {
    const err = new Error(data?.error ?? `请求失败 (${res.status})`) as Error & { status?: number; activeRunId?: string };
    err.status = res.status;
    throw err;
  }
  return data.data;
}

export async function startEvalRun(dataset: string, runs: number, filter?: string): Promise<{ runId: string }> {
  try {
    return (await postJson('/api/eval/runs', { dataset, runs, filter })) as { runId: string };
  } catch (e) {
    if ((e as { status?: number }).status === 409) {
      // Attach the active run so the UI can jump straight to its live page.
      const live = await listLive();
      if (live) (e as { activeRunId?: string }).activeRunId = live.runId;
    }
    throw e;
  }
}

async function listLive(): Promise<{ runId: string } | null> {
  try {
    const res = await fetch('/api/eval/runs', { credentials: 'include' });
    const data = (await res.json()) as { ok: boolean; data?: { activeRunId: string | null } };
    return data.data?.activeRunId ? { runId: data.data.activeRunId } : null;
  } catch {
    return null;
  }
}

export async function getEvalRunLive(runId: string): Promise<LiveInfo> {
  const res = await fetch(`/api/eval/runs/${encodeURIComponent(runId)}/live`, { credentials: 'include' });
  const data = (await res.json().catch(() => null)) as { ok?: boolean; error?: string; data?: LiveInfo } | null;
  if (!res.ok || !data?.ok) throw new Error(data?.error ?? `请求失败 (${res.status})`);
  return data.data!;
}

export async function abortEvalRun(runId: string): Promise<void> {
  const res = await fetch(`/api/eval/runs/${encodeURIComponent(runId)}`, { method: 'DELETE', credentials: 'include' });
  if (!res.ok) {
    const data = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(data?.error ?? `中止失败 (${res.status})`);
  }
}
export type { RunEvent, LiveInfo };
