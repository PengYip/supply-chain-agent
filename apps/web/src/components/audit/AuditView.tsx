import React, { useCallback, useEffect, useState } from 'react'
import clsx from 'clsx'
import { AlertCircle, ChevronDown, ChevronRight, Loader2, RefreshCw } from 'lucide-react'
import {
  fetchAuditSummary,
  fetchLlmCalls,
  fetchOcrCalls,
  type AuditSummary,
  type LlmCallRow,
  type OcrCallRow,
} from '../../api/audit'
import { PageHeader } from '../shell/PageHeader'

/** 用量审计页（2026-08-31 spec）：LLM 与 OCR/解析调用的统计与明细。
 *  - 顶部：7d/30d 切换 + LLM/OCR 汇总卡片
 *  - 下部：两张明细表（LLM 行可展开看截断正文；OCR 行展示后端/页数/耗时） */

const PAGE_SIZE = 50

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

function fmtBytes(n: number | null): string {
  if (n == null) return '-'
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)}MB`
  if (n >= 1024) return `${(n / 1024).toFixed(0)}KB`
  return `${n}B`
}

function fmtTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}

const KIND_LABELS: Record<string, string> = {
  chat: '对话',
  title: '标题生成',
  compaction: '上下文压缩',
  extraction: '字段抽取',
}

const BACKEND_LABELS: Record<string, string> = {
  digital: '数字解析',
  mineru: 'MinerU',
  qianfan: '千帆OCR',
}

function StatCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-xl border bg-surface px-4 py-3">
      <div className="text-xs text-ink-soft">{label}</div>
      <div className="mt-1 text-xl font-semibold text-ink tabular-nums">{value}</div>
      {sub && <div className="mt-0.5 text-[11px] text-ink-soft">{sub}</div>}
    </div>
  )
}

export const AuditView: React.FC = () => {
  const [range, setRange] = useState<'7d' | '30d'>('7d')
  const [summary, setSummary] = useState<AuditSummary | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [llmRows, setLlmRows] = useState<LlmCallRow[]>([])
  const [llmTotal, setLlmTotal] = useState(0)
  const [llmOffset, setLlmOffset] = useState(0)
  const [llmKind, setLlmKind] = useState('')
  const [expandedId, setExpandedId] = useState<string | null>(null)

  const [ocrRows, setOcrRows] = useState<OcrCallRow[]>([])
  const [ocrTotal, setOcrTotal] = useState(0)
  const [ocrOffset, setOcrOffset] = useState(0)
  const [ocrBackend, setOcrBackend] = useState('')

  const [detailLoading, setDetailLoading] = useState(true)

  const loadSummary = useCallback(async (r: '7d' | '30d') => {
    setLoading(true)
    setError(null)
    try {
      setSummary(await fetchAuditSummary(r))
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }, [])

  const loadLlm = useCallback(async (offset: number, kind: string) => {
    setDetailLoading(true)
    try {
      const res = await fetchLlmCalls({ limit: PAGE_SIZE, offset, kind: kind || undefined })
      setLlmRows(res.rows)
      setLlmTotal(res.total)
    } catch {
      setLlmRows([])
      setLlmTotal(0)
    } finally {
      setDetailLoading(false)
    }
  }, [])

  const loadOcr = useCallback(async (offset: number, backend: string) => {
    setDetailLoading(true)
    try {
      const res = await fetchOcrCalls({ limit: PAGE_SIZE, offset, backend: backend || undefined })
      setOcrRows(res.rows)
      setOcrTotal(res.total)
    } catch {
      setOcrRows([])
      setOcrTotal(0)
    } finally {
      setDetailLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadSummary(range)
  }, [range, loadSummary])
  useEffect(() => {
    void loadLlm(llmOffset, llmKind)
  }, [llmOffset, llmKind, loadLlm])
  useEffect(() => {
    void loadOcr(ocrOffset, ocrBackend)
  }, [ocrOffset, ocrBackend, loadOcr])

  const refreshAll = () => {
    void loadSummary(range)
    setLlmOffset(0)
    setOcrOffset(0)
    void loadLlm(0, llmKind)
    void loadOcr(0, ocrBackend)
  }

  return (
    <div className="flex-1 flex flex-col min-w-0 bg-surface h-full">
      <PageHeader
        title="用量审计"
        subtitle="LLM 与 OCR 调用统计及明细"
        actions={
          <div className="flex items-center gap-2">
            <div className="flex rounded-lg border overflow-hidden text-xs">
              {(['7d', '30d'] as const).map((r) => (
                <button
                  key={r}
                  onClick={() => setRange(r)}
                  className={clsx(
                    'px-2.5 py-1.5 hover:bg-surface',
                    range === r ? 'bg-accent/10 text-accent font-medium' : 'text-ink-soft',
                  )}
                >
                  {r === '7d' ? '近7天' : '近30天'}
                </button>
              ))}
            </div>
            <button
              onClick={refreshAll}
              title="刷新"
              className="p-1.5 rounded-lg hover:bg-surface text-ink-soft hover:text-ink"
            >
              <RefreshCw className={clsx('w-4 h-4', loading && 'animate-spin')} />
            </button>
          </div>
        }
      />

      <div className="flex-1 overflow-auto p-4">
        <div className="max-w-5xl mx-auto space-y-4">
          {error && (
            <div className="rounded-lg border border-danger/20 bg-danger/5 px-3 py-2 text-xs text-danger flex items-center gap-1.5">
              <AlertCircle className="w-3.5 h-3.5 shrink-0" />
              <span className="break-all">{error}</span>
            </div>
          )}

          {loading && !summary ? (
            <div className="flex items-center justify-center gap-2 text-sm text-ink-soft py-12">
              <Loader2 className="w-4 h-4 animate-spin" />
              加载中...
            </div>
          ) : summary ? (
            <>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <StatCard
                  label="LLM 调用"
                  value={fmtTokens(summary.llm.totalCalls)}
                  sub={summary.llm.errorCalls > 0 ? `${summary.llm.errorCalls} 次失败` : undefined}
                />
                <StatCard
                  label="LLM Tokens"
                  value={fmtTokens(summary.llm.totalTokens)}
                  sub={`输入 ${fmtTokens(summary.llm.inputTokens)} / 输出 ${fmtTokens(summary.llm.outputTokens)}`}
                />
                <StatCard
                  label="OCR/解析 调用"
                  value={fmtTokens(summary.ocr.totalCalls)}
                  sub={summary.ocr.errorCalls > 0 ? `${summary.ocr.errorCalls} 次失败` : undefined}
                />
                <StatCard
                  label="解析页数"
                  value={fmtTokens(summary.ocr.totalPages)}
                  sub={`${summary.ocr.totalDocs} 个文档 · 均值 ${(summary.ocr.avgDurationMs / 1000).toFixed(1)}s/次`}
                />
              </div>

              {summary.llm.byKind.length > 0 && (
                <div className="rounded-xl border bg-surface p-4">
                  <div className="text-xs font-medium text-ink-soft mb-2">LLM 按调用来源</div>
                  <div className="flex flex-wrap gap-2">
                    {summary.llm.byKind.map((k) => (
                      <span key={k.kind} className="text-xs rounded-full border px-2.5 py-1">
                        {KIND_LABELS[k.kind] ?? k.kind}: {k.calls} 次 / {fmtTokens(k.totalTokens)} tokens
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {summary.ocr.byBackend.length > 0 && (
                <div className="rounded-xl border bg-surface p-4">
                  <div className="text-xs font-medium text-ink-soft mb-2">解析按后端</div>
                  <div className="flex flex-wrap gap-2">
                    {summary.ocr.byBackend.map((b) => (
                      <span key={b.backend} className="text-xs rounded-full border px-2.5 py-1">
                        {BACKEND_LABELS[b.backend] ?? b.backend}: {b.calls} 次 / {b.pages} 页 / 均值{' '}
                        {(b.avgDurationMs / 1000).toFixed(1)}s
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </>
          ) : null}

          {/* LLM 明细 */}
          <section className="rounded-xl border bg-surface">
            <div className="flex items-center justify-between px-4 py-2.5 border-b">
              <div className="text-sm font-medium">LLM 调用明细</div>
              <div className="flex items-center gap-2 text-xs text-ink-soft">
                共 {llmTotal} 条
                <select
                  value={llmKind}
                  onChange={(e) => {
                    setLlmKind(e.target.value)
                    setLlmOffset(0)
                  }}
                  className="rounded-md border bg-surface px-1.5 py-1 text-xs"
                >
                  <option value="">全部来源</option>
                  {Object.entries(KIND_LABELS).map(([k, v]) => (
                    <option key={k} value={k}>
                      {v}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <div className="divide-y">
              {llmRows.length === 0 && !detailLoading && (
                <div className="px-4 py-8 text-center text-xs text-ink-soft">暂无记录</div>
              )}
              {llmRows.map((r) => {
                const expanded = expandedId === r.id
                return (
                  <div key={r.id}>
                    <button
                      onClick={() => setExpandedId(expanded ? null : r.id)}
                      className="w-full text-left px-4 py-2.5 hover:bg-surface flex items-center gap-3 text-xs"
                    >
                      {expanded ? (
                        <ChevronDown className="w-3.5 h-3.5 shrink-0 text-ink-soft" />
                      ) : (
                        <ChevronRight className="w-3.5 h-3.5 shrink-0 text-ink-soft" />
                      )}
                      <span
                        className={clsx(
                          'shrink-0 rounded-full px-2 py-0.5',
                          r.status === 'error' ? 'bg-danger/10 text-danger' : 'bg-accent/10 text-accent',
                        )}
                      >
                        {KIND_LABELS[r.kind] ?? r.kind}
                      </span>
                      <span className="shrink-0 text-ink-soft tabular-nums">
                        {r.inputTokens ?? '-'} → {r.outputTokens ?? '-'} tok
                      </span>
                      <span className="shrink-0 text-ink-soft">{r.model ?? '-'}</span>
                      <span className="truncate text-ink-soft flex-1">
                        {(r.inputPreview ?? '').slice(0, 60) || r.error || '-'}
                      </span>
                      <span className="shrink-0 text-ink-soft tabular-nums">{fmtTime(r.createdAt)}</span>
                    </button>
                    {expanded && (
                      <div className="px-4 pb-3 space-y-2 text-xs">
                        <div className="flex gap-4 text-ink-soft">
                          <span>总 tokens: {r.totalTokens ?? '-'}</span>
                          <span>耗时: {r.durationMs != null ? `${(r.durationMs / 1000).toFixed(1)}s` : '-'}</span>
                          <span>
                            正文长度: 输入 {r.inputChars ?? 0} / 输出 {r.outputChars ?? 0} 字符
                            {((r.inputChars ?? 0) > (r.inputPreview?.length ?? 0)) || ((r.outputChars ?? 0) > (r.outputPreview?.length ?? 0))
                              ? '（已截断）'
                              : ''}
                          </span>
                        </div>
                        {r.error && <div className="text-danger break-all">错误: {r.error}</div>}
                        <div>
                          <div className="text-ink-soft mb-1">Input</div>
                          <pre className="whitespace-pre-wrap break-all rounded-lg bg-surface border p-2 max-h-48 overflow-auto">
                            {r.inputPreview || '(空)'}
                          </pre>
                        </div>
                        <div>
                          <div className="text-ink-soft mb-1">Output</div>
                          <pre className="whitespace-pre-wrap break-all rounded-lg bg-surface border p-2 max-h-48 overflow-auto">
                            {r.outputPreview || '(空)'}
                          </pre>
                        </div>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
            <Pagination
              offset={llmOffset}
              total={llmTotal}
              onPage={(o) => setLlmOffset(o)}
            />
          </section>

          {/* OCR 明细 */}
          <section className="rounded-xl border bg-surface">
            <div className="flex items-center justify-between px-4 py-2.5 border-b">
              <div className="text-sm font-medium">OCR / 解析明细</div>
              <div className="flex items-center gap-2 text-xs text-ink-soft">
                共 {ocrTotal} 条
                <select
                  value={ocrBackend}
                  onChange={(e) => {
                    setOcrBackend(e.target.value)
                    setOcrOffset(0)
                  }}
                  className="rounded-md border bg-surface px-1.5 py-1 text-xs"
                >
                  <option value="">全部后端</option>
                  {Object.entries(BACKEND_LABELS).map(([k, v]) => (
                    <option key={k} value={k}>
                      {v}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <div className="divide-y">
              {ocrRows.length === 0 && !detailLoading && (
                <div className="px-4 py-8 text-center text-xs text-ink-soft">暂无记录</div>
              )}
              {ocrRows.map((r) => (
                <div key={r.id} className="px-4 py-2.5 flex items-center gap-3 text-xs">
                  <span
                    className={clsx(
                      'shrink-0 rounded-full px-2 py-0.5',
                      r.status === 'error' ? 'bg-danger/10 text-danger' : 'bg-accent/10 text-accent',
                    )}
                  >
                    {BACKEND_LABELS[r.backend] ?? r.backend}
                  </span>
                  <span className="shrink-0">{r.docType || '其他'}</span>
                  <span className="truncate flex-1 text-ink-soft" title={r.fileName ?? ''}>
                    {r.fileName || r.docId}
                  </span>
                  <span className="shrink-0 text-ink-soft tabular-nums">
                    {r.pages != null ? `${r.pages}页` : '-'} · {r.blocks != null ? `${r.blocks}块` : '-'} · {fmtBytes(r.fileBytes)}
                  </span>
                  <span className="shrink-0 text-ink-soft tabular-nums">
                    {r.durationMs != null ? `${(r.durationMs / 1000).toFixed(1)}s` : '-'}
                  </span>
                  <span className="shrink-0 text-ink-soft tabular-nums">{fmtTime(r.createdAt)}</span>
                </div>
              ))}
            </div>
            <Pagination
              offset={ocrOffset}
              total={ocrTotal}
              onPage={(o) => setOcrOffset(o)}
            />
          </section>
        </div>
      </div>
    </div>
  )
}

const Pagination: React.FC<{ offset: number; total: number; onPage: (offset: number) => void }> = ({
  offset,
  total,
  onPage,
}) => {
  if (total <= PAGE_SIZE) return null
  const page = Math.floor(offset / PAGE_SIZE) + 1
  const pages = Math.ceil(total / PAGE_SIZE)
  return (
    <div className="flex items-center justify-end gap-3 px-4 py-2 border-t text-xs text-ink-soft">
      <button
        disabled={offset === 0}
        onClick={() => onPage(Math.max(0, offset - PAGE_SIZE))}
        className="disabled:opacity-40 hover:text-ink"
      >
        上一页
      </button>
      <span className="tabular-nums">
        {page} / {pages}
      </span>
      <button
        disabled={offset + PAGE_SIZE >= total}
        onClick={() => onPage(offset + PAGE_SIZE)}
        className="disabled:opacity-40 hover:text-ink"
      >
        下一页
      </button>
    </div>
  )
}
