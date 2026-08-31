/** 用量审计 API（spec docs/superpowers/specs/2026-08-31-usage-audit-design.md）。
 *  GET /api/audit/summary?range=7d|30d — 汇总统计
 *  GET /api/audit/llm?limit&offset&kind&sessionId — LLM 明细分页
 *  GET /api/audit/ocr?limit&offset&backend — OCR 明细分页
 *  Cookie 认证、同源。失败抛 Error（优先透出服务端 message）。 */

export interface AuditSummary {
  range: '7d' | '30d'
  llm: {
    totalCalls: number
    errorCalls: number
    totalTokens: number
    inputTokens: number
    outputTokens: number
    byKind: Array<{ kind: string; calls: number; totalTokens: number }>
    byModel: Array<{ model: string; calls: number; totalTokens: number }>
    byDay: Array<{ day: string; calls: number; totalTokens: number }>
  }
  ocr: {
    totalCalls: number
    errorCalls: number
    totalPages: number
    totalDocs: number
    avgDurationMs: number
    byBackend: Array<{ backend: string; calls: number; pages: number; avgDurationMs: number }>
    byDay: Array<{ day: string; calls: number; pages: number }>
  }
}

export interface LlmCallRow {
  id: string
  sessionId: string | null
  userId: string | null
  kind: string
  model: string | null
  inputTokens: number | null
  outputTokens: number | null
  totalTokens: number | null
  inputPreview: string | null
  outputPreview: string | null
  inputChars: number | null
  outputChars: number | null
  durationMs: number | null
  finishReason: string | null
  status: string
  error: string | null
  createdAt: string
}

export interface OcrCallRow {
  id: string
  sessionId: string | null
  userId: string | null
  docId: string
  docType: string | null
  fileName: string | null
  backend: string
  fileBytes: number | null
  pages: number | null
  blocks: number | null
  durationMs: number | null
  status: string
  error: string | null
  createdAt: string
}

async function getJson<T>(url: string): Promise<T> {
  let res: Response
  try {
    res = await fetch(url, { credentials: 'include' })
  } catch {
    throw new Error('网络错误，请稍后重试')
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(body || `请求失败 (${res.status})`)
  }
  return (await res.json()) as T
}

export function fetchAuditSummary(range: '7d' | '30d'): Promise<AuditSummary> {
  return getJson(`/api/audit/summary?range=${range}`)
}

export function fetchLlmCalls(opts?: {
  limit?: number
  offset?: number
  kind?: string
  sessionId?: string
}): Promise<{ rows: LlmCallRow[]; total: number }> {
  const q = new URLSearchParams()
  if (opts?.limit) q.set('limit', String(opts.limit))
  if (opts?.offset) q.set('offset', String(opts.offset))
  if (opts?.kind) q.set('kind', opts.kind)
  if (opts?.sessionId) q.set('sessionId', opts.sessionId)
  const qs = q.toString()
  return getJson(`/api/audit/llm${qs ? `?${qs}` : ''}`)
}

export function fetchOcrCalls(opts?: {
  limit?: number
  offset?: number
  backend?: string
}): Promise<{ rows: OcrCallRow[]; total: number }> {
  const q = new URLSearchParams()
  if (opts?.limit) q.set('limit', String(opts.limit))
  if (opts?.offset) q.set('offset', String(opts.offset))
  if (opts?.backend) q.set('backend', opts.backend)
  const qs = q.toString()
  return getJson(`/api/audit/ocr${qs ? `?${qs}` : ''}`)
}
