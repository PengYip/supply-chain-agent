// apps/web/src/components/eval/EvalWorkbenchView.tsx
import { useState } from 'react'
import clsx from 'clsx'
import { EvalRunsList } from './EvalRunsList'
import { EvalRunReport } from './EvalRunReport'
import { EvalEpisodeDetail } from './EvalEpisodeDetail'
import { EvalRunLive } from './EvalRunLive'
import { EvalDatasetEditor } from './EvalDatasetEditor'
import { useEvalRuns } from '../../hooks/useEvalRuns'

type Page =
  | { page: 'runs' }
  | { page: 'report'; runId: string }
  | { page: 'episode'; runId: string; scenarioId: string; runIndex: number }
  | { page: 'live'; runId: string }

type Tab = 'results' | 'datasets'

export function EvalWorkbenchView() {
  const [tab, setTab] = useState<Tab>('results')
  const [nav, setNav] = useState<Page>({ page: 'runs' })
  const [pendingDataset, setPendingDataset] = useState<string | null>(null)
  const { runs, activeRunId, loading, error, refresh } = useEvalRuns()
  const summary = nav.page === 'report' || nav.page === 'episode' ? runs.find((r) => r.runId === nav.runId) : undefined

  const handleRunFromDataset = (name: string) => {
    setPendingDataset(name)
    setTab('results')
    setNav({ page: 'runs' })
  }

  return (
    <div className="h-full flex flex-col bg-bgGray">
      <div className="flex items-center gap-1 px-4 pt-3 shrink-0 border-b border-borderGray">
        <button type="button" onClick={() => setTab('results')}
          className={clsx('px-3 py-1.5 text-sm rounded-t-lg border-b-2 -mb-px',
            tab === 'results' ? 'text-deepSea border-deepSea font-medium' : 'text-textGray border-transparent hover:text-deepSea')}>
          结果
        </button>
        <button type="button" onClick={() => setTab('datasets')}
          className={clsx('px-3 py-1.5 text-sm rounded-t-lg border-b-2 -mb-px',
            tab === 'datasets' ? 'text-deepSea border-deepSea font-medium' : 'text-textGray border-transparent hover:text-deepSea')}>
          数据集
        </button>
      </div>
      <div className="flex-1 min-h-0 overflow-auto">
        {tab === 'results' ? (
          <>
            {nav.page === 'runs' && (
              <EvalRunsList
                runs={runs}
                loading={loading}
                error={error}
                onRefresh={refresh}
                activeRunId={activeRunId}
                pendingDataset={pendingDataset}
                onOpenRun={(runId) => setNav({ page: 'report', runId })}
                onOpenLive={(runId) => setNav({ page: 'live', runId })}
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
            {nav.page === 'live' && (
              <EvalRunLive
                runId={nav.runId}
                onOpenReport={(runId) => setNav({ page: 'report', runId })}
                onBack={() => setNav({ page: 'runs' })}
              />
            )}
            {(nav.page === 'episode' || nav.page === 'report') && !summary && (
              <div className="p-8 text-sm text-textGray">运行数据不在列表中, 可能已被清理。
                <button type="button" className="ml-2 text-deepSea underline" onClick={() => setNav({ page: 'runs' })}>返回</button>
              </div>
            )}
          </>
        ) : (
          <EvalDatasetEditor onRunFromDataset={handleRunFromDataset} />
        )}
      </div>
    </div>
  )
}
