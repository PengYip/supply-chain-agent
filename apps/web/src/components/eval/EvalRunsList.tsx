// apps/web/src/components/eval/EvalRunsList.tsx
import clsx from 'clsx'
import { ChevronRight, RefreshCw, FlaskConical } from 'lucide-react'
import { useEvalRuns } from '../../hooks/useEvalRuns'

const VERDICT_ORDER = ['pass', 'fail', 'needs_human_review', 'sim_error', 'judge_error'] as const
const VERDICT_BAR: Record<string, string> = {
  pass: 'bg-success', fail: 'bg-danger', needs_human_review: 'bg-warning',
  sim_error: 'bg-textGray/40', judge_error: 'bg-textGray/40',
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

export function EvalRunsList({ onOpenRun }: { onOpenRun: (runId: string) => void }) {
  const { runs, loading, error, refresh } = useEvalRuns()

  if (loading) {
    return <div className="p-8 text-sm text-textGray">加载中...</div>
  }
  if (error) {
    return (
      <div className="p-8">
        <p className="text-sm text-danger mb-3">{error}</p>
        <button type="button" onClick={() => void refresh()}
          className="inline-flex items-center gap-1.5 rounded border border-borderGray bg-white px-3 py-1.5 text-sm text-deepSea hover:bg-bgGray">
          <RefreshCw className="h-3.5 w-3.5" aria-hidden /> 重试
        </button>
      </div>
    )
  }
  if (runs.length === 0) {
    return (
      <div className="p-8">
        <div className="rounded-lg border border-borderGray bg-white p-6 max-w-xl">
          <div className="flex items-center gap-2 mb-2 text-textDark font-medium">
            <FlaskConical className="h-4 w-4 text-deepSea" aria-hidden /> 还没有评估结果
          </div>
          <p className="text-sm text-textGray mb-3">在服务器上运行一次评估后, 结果会出现在这里。</p>
          <pre className="bg-bgGray rounded p-2 text-xs overflow-auto">npm run eval:agent --workspace apps/server</pre>
        </div>
      </div>
    )
  }

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-base font-medium text-textDark">评估运行</h2>
        <button type="button" onClick={() => void refresh()}
          className="inline-flex items-center gap-1.5 rounded border border-borderGray bg-white px-2.5 py-1 text-xs text-textGray hover:text-deepSea">
          <RefreshCw className="h-3 w-3" aria-hidden /> 刷新
        </button>
      </div>
      <div className="rounded-lg border border-borderGray bg-white overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-bgGray text-left text-xs text-textGray">
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
                <tr key={r.runId} className="border-t border-borderGray hover:bg-bgGray/60 cursor-pointer" onClick={() => onOpenRun(r.runId)}>
                  <td className="px-4 py-2.5 text-textDark">{formatTime(r.startedAt, r.runId)}</td>
                  <td className="px-4 py-2.5 text-textGray">{r.dataset}</td>
                  <td className="px-4 py-2.5 tabular-nums text-textGray">{r.episodeCount}</td>
                  <td className="px-4 py-2.5">
                    <div className="flex items-center gap-2">
                      <div className="flex h-2 w-32 overflow-hidden rounded" aria-hidden>
                        {VERDICT_ORDER.filter((v) => r.verdictDist[v]).map((v) => (
                          <div key={v} className={clsx('h-full', VERDICT_BAR[v])} style={{ width: `${((r.verdictDist[v] ?? 0) / total) * 100}%` }} />
                        ))}
                      </div>
                      <span className="text-xs text-textGray">
                        {VERDICT_ORDER.filter((v) => r.verdictDist[v]).map((v) => `${VERDICT_SHORT[v]} ${r.verdictDist[v]}`).join(' / ')}
                      </span>
                    </div>
                  </td>
                  <td className="px-4 py-2.5 tabular-nums text-right text-textGray">{r.totalTokens.toLocaleString()}</td>
                  <td className="px-2 py-2.5"><ChevronRight className="h-4 w-4 text-textGray" aria-hidden /></td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}
