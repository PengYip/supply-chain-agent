// apps/web/src/components/eval/EvalWorkbenchView.tsx
import { useState } from 'react'
import clsx from 'clsx'
import { PageHeader } from '../shell/PageHeader'
import { useHashRoute } from '../../hooks/useHashRoute'
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

/** 评估工作台：tab 落 hash 参数（#/eval?tab=datasets，菜单重构 2026-09-23），
 *  与 projects/ontology/approvals/governance 的深链口径统一；runs/report/episode
 *  等结果内页仍为本地状态（面包屑回退式导航，不占浏览器历史）。 */
export function EvalWorkbenchView() {
  const { route, navigate } = useHashRoute()
  const tab: Tab = route.params['tab'] === 'datasets' ? 'datasets' : 'results'
  const setTab = (t: Tab) => navigate('eval', t === 'results' ? {} : { tab: t }, { replace: true })
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
    <div className="h-full flex flex-col bg-surface">
      {/* 二级工具条（视图标题由 AppTopbar 承担）：结果/数据集分段式 Tab */}
      <PageHeader
        tabs={
          <div className="flex items-center gap-1 rounded-lg bg-surface p-0.5">
            {(
              [
                { key: 'results', label: '结果' },
                { key: 'datasets', label: '数据集' },
              ] as const
            ).map((t) => (
              <button
                key={t.key}
                type="button"
                onClick={() => setTab(t.key)}
                className={clsx(
                  'rounded-md px-3 py-1 text-xs transition-colors',
                  tab === t.key ? 'bg-white font-medium text-primary shadow-sm' : 'text-ink-soft hover:text-ink',
                )}
              >
                {t.label}
              </button>
            ))}
          </div>
        }
      />
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
              <div className="p-8 text-sm text-ink-soft">运行数据不在列表中, 可能已被清理。
                <button type="button" className="ml-2 text-primary underline" onClick={() => setNav({ page: 'runs' })}>返回</button>
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
