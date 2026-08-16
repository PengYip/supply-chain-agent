// apps/web/src/components/eval/EvalRunReport.tsx
import clsx from 'clsx'
import { ArrowLeft, ChevronRight } from 'lucide-react'
import { useState } from 'react'
import type { EvalRunSummary } from '../../api/eval'
import { useEvalRunEpisodes } from '../../hooks/useEvalRunEpisodes'
import { VerdictBadge } from './verdictBadge'

function formatMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`
}

export function EvalRunReport({ runId, summary, onOpenEpisode, onBack }: {
  runId: string
  summary: EvalRunSummary
  onOpenEpisode: (scenarioId: string, runIndex: number) => void
  onBack: () => void
}) {
  const [selected, setSelected] = useState<string | null>(null)
  const { episodes, loading, error } = useEvalRunEpisodes(runId)
  const k = summary.runsPerScenario

  return (
    <div className="p-6 max-w-5xl">
      <div className="flex items-center gap-3 mb-4">
        <button type="button" onClick={onBack}
          className="inline-flex items-center gap-1 text-sm text-deepSea hover:underline">
          <ArrowLeft className="h-3.5 w-3.5" aria-hidden /> 运行列表
        </button>
        <h2 className="text-base font-medium text-textDark">运行报告</h2>
        <span className="text-xs text-textGray font-mono">{runId}</span>
      </div>

      {/* 汇总卡 */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-5">
        <div className="rounded-lg border border-borderGray bg-white p-3">
          <div className="text-xs text-textGray mb-1">判定分布</div>
          <div className="flex flex-wrap gap-1">
            {Object.entries(summary.verdictDist).map(([v, n]) => (
              <span key={v} className="inline-flex items-center gap-1 text-xs text-textDark">
                <VerdictBadge verdict={v} /> <span className="tabular-nums">{n}</span>
              </span>
            ))}
          </div>
        </div>
        <div className="rounded-lg border border-borderGray bg-white p-3">
          <div className="text-xs text-textGray mb-1">Episodes</div>
          <div className="text-lg tabular-nums text-textDark">{summary.episodeCount}</div>
          <div className="text-xs text-textGray">每场景 {k} 轮</div>
        </div>
        <div className="rounded-lg border border-borderGray bg-white p-3">
          <div className="text-xs text-textGray mb-1">总 Tokens</div>
          <div className="text-lg tabular-nums text-textDark">{summary.totalTokens.toLocaleString()}</div>
        </div>
        <div className="rounded-lg border border-borderGray bg-white p-3">
          <div className="text-xs text-textGray mb-1">总耗时</div>
          <div className="text-lg tabular-nums text-textDark">{formatMs(summary.totalWallMs)}</div>
        </div>
      </div>

      {/* 场景矩阵 */}
      <div className="rounded-lg border border-borderGray bg-white overflow-x-auto mb-5">
        <table className="w-full text-sm">
          <thead className="bg-bgGray text-left text-xs text-textGray">
            <tr>
              <th className="px-4 py-2 font-medium">场景</th>
              <th className="px-3 py-2 font-medium">Tier</th>
              <th className="px-3 py-2 font-medium">判定 (按轮)</th>
              <th className="px-3 py-2 font-medium">Pass@1</th>
              <th className="px-3 py-2 font-medium">Pass^{k}</th>
              <th className="px-3 py-2 font-medium">均分</th>
              <th className="px-3 py-2 font-medium text-right">Tokens</th>
            </tr>
          </thead>
          <tbody>
            {summary.scenarios.map((s) => (
              <tr key={s.scenarioId}
                className={clsx('border-t border-borderGray cursor-pointer hover:bg-bgGray/60', selected === s.scenarioId && 'bg-bgGray/60')}
                onClick={() => setSelected(selected === s.scenarioId ? null : s.scenarioId)}>
                <td className="px-4 py-2.5 font-mono text-xs text-textDark">{s.scenarioId}</td>
                <td className="px-3 py-2.5">
                  {s.tier == null
                    ? <span className="text-xs text-textGray">-</span>
                    : <span className="inline-block rounded bg-deepSea/10 text-deepSea border border-deepSea/20 px-1.5 py-0.5 text-xs">T{s.tier}</span>}
                </td>
                <td className="px-3 py-2.5">
                  <div className="flex flex-wrap gap-1">
                    {s.verdicts.map((v, i) => <VerdictBadge key={i} verdict={v} />)}
                  </div>
                </td>
                <td className="px-3 py-2.5 text-center">{s.passAt1
                  ? <span className="text-success font-medium">Y</span>
                  : <span className="text-textGray">N</span>}</td>
                <td className="px-3 py-2.5 text-center">{s.passConsecutiveK
                  ? <span className="text-success font-medium">Y</span>
                  : <span className="text-textGray">N</span>}</td>
                <td className="px-3 py-2.5 tabular-nums text-textDark">{s.avgRubricScore == null ? '-' : s.avgRubricScore.toFixed(2)}</td>
                <td className="px-3 py-2.5 tabular-nums text-right text-textGray">{s.totalTokens.toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* 场景筛选的 episode 列表 */}
      {selected && (
        <div className="rounded-lg border border-borderGray bg-white">
          <div className="px-4 py-2.5 border-b border-borderGray text-sm font-medium text-textDark">
            {selected} — episodes
          </div>
          {loading && <div className="px-4 py-3 text-sm text-textGray">加载中...</div>}
          {error && <div className="px-4 py-3 text-sm text-danger">{error}</div>}
          {!loading && !error && (
            <div className="divide-y divide-borderGray">
              {episodes.filter((e) => e.scenarioId === selected).map((e) => (
                <button type="button" key={`${e.scenarioId}-${e.runIndex}`}
                  onClick={() => onOpenEpisode(e.scenarioId, e.runIndex)}
                  className="w-full flex items-center gap-3 px-4 py-2.5 text-sm hover:bg-bgGray/60 text-left">
                  <span className="text-textGray w-14">第 {e.runIndex} 轮</span>
                  <VerdictBadge verdict={e.verdict} veto={e.vetoTriggered} />
                  <span className="tabular-nums text-textGray text-xs">
                    {e.rubricScore == null ? '' : `均分维度 ${e.rubricScore.toFixed(1)}`}
                  </span>
                  <span className="flex-1" />
                  <ChevronRight className="h-4 w-4 text-textGray" aria-hidden />
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
