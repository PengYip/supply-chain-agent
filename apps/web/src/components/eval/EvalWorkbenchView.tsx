// apps/web/src/components/eval/EvalWorkbenchView.tsx
import { useState } from 'react'
import { EvalRunsList } from './EvalRunsList'
import { EvalRunReport } from './EvalRunReport'
import { EvalEpisodeDetail } from './EvalEpisodeDetail'
import { useEvalRuns } from '../../hooks/useEvalRuns'

type Page =
  | { page: 'runs' }
  | { page: 'report'; runId: string }
  | { page: 'episode'; runId: string; scenarioId: string; runIndex: number }

export function EvalWorkbenchView() {
  const [nav, setNav] = useState<Page>({ page: 'runs' })
  const [activeRunId, setActiveRunId] = useState<string | null>(null)
  const { runs, loading, error, refresh } = useEvalRuns()
  const summary = nav.page !== 'runs' ? runs.find((r) => r.runId === nav.runId) : undefined

  return (
    <div className="h-full overflow-auto bg-bgGray">
      {nav.page === 'runs' && (
        <EvalRunsList
          runs={runs}
          loading={loading}
          error={error}
          onRefresh={refresh}
          activeRunId={activeRunId}
          onOpenRun={(runId) => { setActiveRunId(runId); setNav({ page: 'report', runId }) }}
        />
      )}
      {nav.page === 'report' && summary && (
        <EvalRunReport
          runId={nav.runId}
          summary={summary}
          onBack={() => setNav({ page: 'runs' })}
          onOpenEpisode={(scenarioId, runIndex) => setNav({ page: 'episode', runId: nav.runId, scenarioId, runIndex })}
        />
      )}
      {nav.page === 'episode' && summary && (
        <EvalEpisodeDetail
          runId={nav.runId}
          scenarioId={nav.scenarioId}
          runIndex={nav.runIndex}
          onBack={() => setNav({ page: 'report', runId: nav.runId })}
        />
      )}
      {(nav.page === 'episode' || nav.page === 'report') && !summary && (
        <div className="p-8 text-sm text-textGray">运行数据不在列表中, 可能已被清理。
          <button type="button" className="ml-2 text-deepSea underline" onClick={() => setNav({ page: 'runs' })}>返回</button>
        </div>
      )}
    </div>
  )
}
