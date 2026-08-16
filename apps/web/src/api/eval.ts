// apps/web/src/api/eval.ts
/** 评估结果只读 API 客户端 (spec §5.3)。信封/错误处理对齐 api/process.ts。 */

export interface EvalScenarioRow {
  scenarioId: string
  tier: number | null
  verdicts: string[]
  passAt1: boolean
  passConsecutiveK: boolean
  avgRubricScore: number | null
  totalTokens: number
  avgWallMs: number
}

export interface EvalRunSummary {
  runId: string
  startedAt: string | null
  dataset: string
  episodeCount: number
  runsPerScenario: number
  verdictDist: Record<string, number>
  totalTokens: number
  totalWallMs: number
  scenarios: EvalScenarioRow[]
}

export type TranscriptSegment = { kind: 'text'; role: 'user' | 'assistant' | 'system'; content: string }

export interface EvalEpisodeView {
  scenarioId: string
  runIndex: number
  verdict: string
  vetoTriggered: boolean
  rubricScore: number | null
  judgeConfidence: number | null
  judgeDimensions: Array<{ name: string; weight: string; score: number; rationale: string }>
  verifierFailures: Array<{ check: string; detail: string }>
  simError: string | null
  approvals: Array<{ toolName: string; level: string; decision: string; matchedRule: string | null; reason: string }>
  toolCalls: Array<{ toolName: string; args: unknown; result: unknown; durationMs: number | null }>
  totalUsage: { inputTokens: number; outputTokens: number; totalTokens: number }
  wallMs: number
  turnsUsed: number
  transcript: TranscriptSegment[]
}

async function getJson<T>(url: string): Promise<T> {
  let res: Response
  try {
    res = await fetch(url, { credentials: 'include' })
  } catch {
    throw new Error('网络错误，请稍后重试')
  }
  if (!res.ok) {
    let message = `请求失败（${res.status}）`
    try {
      const data = (await res.json()) as { ok?: boolean; error?: string }
      if (data && data.ok === false && typeof data.error === 'string' && data.error) message = data.error
    } catch { /* 非 JSON 响应, 保留状态码消息 */ }
    throw new Error(message)
  }
  let data: unknown
  try {
    data = await res.json()
  } catch {
    throw new Error('响应格式异常')
  }
  const envelope = data as { ok: true; data: T }
  if (!envelope || envelope.ok !== true || envelope.data == null) throw new Error('响应格式异常')
  return envelope.data
}

export interface EvalRunsResponse {
  runs: EvalRunSummary[]
  activeRunId: string | null
}

export async function listEvalRuns(): Promise<EvalRunsResponse> {
  return getJson<EvalRunsResponse>('/api/eval/runs')
}

export async function getEvalRunEpisodes(runId: string): Promise<{ episodes: EvalEpisodeView[]; droppedLines: number }> {
  return getJson<{ episodes: EvalEpisodeView[]; droppedLines: number }>(
    `/api/eval/runs/${encodeURIComponent(runId)}/episodes`,
  )
}
