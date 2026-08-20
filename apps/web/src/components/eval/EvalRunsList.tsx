// apps/web/src/components/eval/EvalRunsList.tsx
import { useEffect, useState } from 'react'
import clsx from 'clsx'
import { ChevronRight, RefreshCw, FlaskConical, Play, ExternalLink } from 'lucide-react'
import type { EvalRunSummary } from '../../api/eval'
import { startEvalRun } from '../../api/evalRun'
import { useEvalDatasets } from '../../hooks/useEvalDatasets'

const VERDICT_ORDER = ['pass', 'fail', 'needs_human_review', 'sim_error', 'judge_error'] as const
const VERDICT_BAR: Record<string, string> = {
  pass: 'bg-success', fail: 'bg-danger', needs_human_review: 'bg-warning',
  sim_error: 'bg-ink-soft/40', judge_error: 'bg-ink-soft/40',
}
const VERDICT_SHORT: Record<string, string> = {
  pass: '通过', fail: '失败', needs_human_review: '复核',
  sim_error: 'sim故障', judge_error: 'judge故障',
}

function formatTime(iso: string | null, runId: string): string {
  if (!iso) return runId
  try {
    const d = new Date(iso)
    return d.toLocaleString('zh-CN', { hour12: false })
  } catch {
    return runId
  }
}

export function EvalRunsList({ runs, loading, error, onRefresh, onOpenRun, onOpenLive, activeRunId, pendingDataset }: {
  runs: EvalRunSummary[]
  loading: boolean
  error: string | null
  onRefresh: () => void
  onOpenRun: (runId: string) => void
  onOpenLive: (runId: string) => void
  activeRunId: string | null
  pendingDataset?: string | null
}) {
  const { datasets } = useEvalDatasets()
  const [dataset, setDataset] = useState(pendingDataset ?? 'core')
  const [runsInput, setRunsInput] = useState(1)
  const [filter, setFilter] = useState('')
  const [starting, setStarting] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const [conflictRunId, setConflictRunId] = useState<string | null>(null)

  // 「从此数据集运行」预选: 编辑器触发后切到 runs 页, 下拉选中目标数据集。
  useEffect(() => {
    if (pendingDataset) setDataset(pendingDataset)
  }, [pendingDataset])

  const handleStart = async () => {
    const n = Math.min(10, Math.max(1, Math.floor(runsInput) || 1))
    setStarting(true)
    setFormError(null)
    setConflictRunId(null)
    try {
      const { runId } = await startEvalRun(dataset, n, filter.trim() || undefined)
      onOpenLive(runId)
    } catch (e) {
      const err = e as Error & { activeRunId?: string }
      setFormError(err.message || '启动失败')
      if (err.activeRunId) setConflictRunId(err.activeRunId)
    } finally {
      setStarting(false)
    }
  }

  return (
    <div className="p-6">
      {activeRunId && (
        <div className="mb-4 flex items-center gap-2 rounded-lg border border-primary/20 bg-primary/5 px-3 py-2 text-sm text-primary">
          评估进行中
          <button type="button" onClick={() => onOpenLive(activeRunId)}
            className="inline-flex items-center gap-1 text-primary underline">
            <ExternalLink className="h-3 w-3" aria-hidden /> 查看进行中的运行
          </button>
        </div>
      )}

      <div className="rounded-lg border border-line bg-white p-4 mb-4">
        <div className="flex items-end gap-3 flex-wrap">
          <div>
            <label className="block text-xs text-ink-soft mb-1" htmlFor="eval-dataset">数据集</label>
            <select id="eval-dataset" value={dataset} onChange={(e) => setDataset(e.target.value)}
              className="rounded border border-line bg-white px-2 py-1.5 text-sm text-ink">
              {datasets.map((d) => (
                <option key={d.name} value={d.name}>{d.name}{d.builtin ? ' (内置)' : ''}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs text-ink-soft mb-1" htmlFor="eval-runs">轮次 (1-10)</label>
            <input id="eval-runs" type="number" min={1} max={10} value={runsInput}
              onChange={(e) => setRunsInput(Number(e.target.value))}
              className="w-20 rounded border border-line bg-white px-2 py-1.5 text-sm text-ink tabular-nums" />
          </div>
          <div className="flex-1 min-w-[160px]">
            <label className="block text-xs text-ink-soft mb-1" htmlFor="eval-filter">场景过滤 (可选)</label>
            <input id="eval-filter" type="text" value={filter} onChange={(e) => setFilter(e.target.value)}
              placeholder="如 t1- 或 t3-pressure"
              className="w-full rounded border border-line bg-white px-2 py-1.5 text-sm text-ink" />
          </div>
          <button type="button" onClick={() => void handleStart()} disabled={starting || datasets.length === 0}
            className="inline-flex items-center gap-1.5 rounded bg-primary px-4 py-2 text-sm text-white hover:opacity-90 disabled:opacity-50">
            <Play className="h-3.5 w-3.5" aria-hidden /> {starting ? '启动中...' : '运行评估'}
          </button>
        </div>
        {formError && (
          <div className="mt-3 flex items-center gap-2 text-sm text-danger">
            {formError}
            {conflictRunId && (
              <button type="button" onClick={() => onOpenLive(conflictRunId)} className="text-primary underline">查看进行中的运行</button>
            )}
          </div>
        )}
      </div>

      {loading && <div className="p-8 text-sm text-ink-soft">加载中...</div>}

      {error && (
        <div className="p-8">
          <p className="text-sm text-danger mb-3">{error}</p>
          <button type="button" onClick={() => onRefresh()}
            className="inline-flex items-center gap-1.5 rounded border border-line bg-white px-3 py-1.5 text-sm text-primary hover:bg-surface">
            <RefreshCw className="h-3.5 w-3.5" aria-hidden /> 重试
          </button>
        </div>
      )}

      {!loading && !error && runs.length === 0 && (
        <div className="rounded-lg border border-line bg-white p-6 max-w-xl">
          <div className="flex items-center gap-2 mb-2 text-ink font-medium">
            <FlaskConical className="h-4 w-4 text-primary" aria-hidden /> 还没有评估结果
          </div>
          <p className="text-sm text-ink-soft mb-3">在服务器上运行一次评估后, 结果会出现在这里。</p>
          <pre className="bg-surface rounded p-2 text-xs overflow-auto">npm run eval:agent --workspace apps/server</pre>
        </div>
      )}

      {!loading && !error && runs.length > 0 && (
        <div>
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-base font-medium text-ink">评估运行</h2>
            <button type="button" onClick={() => onRefresh()}
              className="inline-flex items-center gap-1.5 rounded border border-line bg-white px-2.5 py-1 text-xs text-ink-soft hover:text-primary">
              <RefreshCw className="h-3 w-3" aria-hidden /> 刷新
            </button>
          </div>
          <div className="rounded-lg border border-line bg-white overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-surface text-left text-xs text-ink-soft">
                <tr>
                  <th className="px-4 py-2 font-medium">开始时间</th>
                  <th className="px-4 py-2 font-medium">数据集</th>
                  <th className="px-4 py-2 font-medium">Episodes</th>
                  <th className="px-4 py-2 font-medium">判定分布</th>
                  <th className="px-4 py-2 font-medium text-right">Tokens</th>
                  <th className="px-2 py-2" aria-label="操作" />
                </tr>
              </thead>
              <tbody>
                {runs.map((r) => {
                  const total = Math.max(1, r.episodeCount)
                  return (
                    <tr key={r.runId} className={clsx('border-t border-line hover:bg-surface/60 cursor-pointer', activeRunId === r.runId && 'bg-surface/60')} onClick={() => onOpenRun(r.runId)}>
                      <td className="px-4 py-2.5 text-ink">{formatTime(r.startedAt, r.runId)}</td>
                      <td className="px-4 py-2.5 text-ink-soft">{r.dataset}</td>
                      <td className="px-4 py-2.5 tabular-nums text-ink-soft">{r.episodeCount}</td>
                      <td className="px-4 py-2.5">
                        <div className="flex items-center gap-2">
                          <div className="flex h-2 w-32 overflow-hidden rounded" aria-hidden>
                            {VERDICT_ORDER.filter((v) => r.verdictDist[v]).map((v) => (
                              <div key={v} className={clsx('h-full', VERDICT_BAR[v])} style={{ width: `${((r.verdictDist[v] ?? 0) / total) * 100}%` }} />
                            ))}
                          </div>
                          <span className="text-xs text-ink-soft">
                            {VERDICT_ORDER.filter((v) => r.verdictDist[v]).map((v) => `${VERDICT_SHORT[v]} ${r.verdictDist[v]}`).join(' / ')}
                          </span>
                        </div>
                      </td>
                      <td className="px-4 py-2.5 tabular-nums text-right text-ink-soft">{r.totalTokens.toLocaleString()}</td>
                      <td className="px-2 py-2.5"><ChevronRight className="h-4 w-4 text-ink-soft" aria-hidden /></td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}
