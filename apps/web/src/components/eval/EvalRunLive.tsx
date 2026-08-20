// apps/web/src/components/eval/EvalRunLive.tsx
import { useMemo } from 'react'
import clsx from 'clsx'
import { ArrowLeft, Square, RotateCcw, ExternalLink } from 'lucide-react'
import { useEvalRunLive, type LiveState } from '../../hooks/useEvalRunLive'
import { abortEvalRun } from '../../api/evalRun'
import { VerdictBadge } from './verdictBadge'
import { TranscriptBubble, ToolCallCard, ApprovalCard } from './shared'

const STATE_LABEL: Record<LiveState, string> = {
  connecting: '连接中',
  running: '运行中',
  done: '已完成',
  error: '运行失败',
  interrupted: '已中断',
}

function stateClass(state: LiveState): string {
  switch (state) {
    case 'running': return 'bg-primary/10 text-primary border-primary/30 animate-pulse-bar'
    case 'done': return 'bg-success/10 text-success border-success/25'
    case 'error': return 'bg-danger/10 text-danger border-danger/25'
    case 'interrupted': return 'bg-warning/10 text-warning border-warning/30'
    default: return 'bg-surface text-ink-soft border-line'
  }
}

export function EvalRunLive({ runId, onOpenReport, onBack }: {
  runId: string
  onOpenReport: (runId: string) => void
  onBack: () => void
}) {
  const { events, state, error, replay } = useEvalRunLive(runId)

  // 全部纯派生, 不冗余 state。
  const progress = useMemo(() => {
    let total = 0
    let done = 0
    let current: { scenarioId: string; runIndex: number } | null = null
    for (const e of events) {
      if (e.type === 'run_started') total = e.total
      else if (e.type === 'episode_done') done++
      else if (e.type === 'scenario_started') current = { scenarioId: e.scenarioId, runIndex: e.runIndex }
    }
    return { total, done, current }
  }, [events])

  const verdicts = useMemo(() => {
    const byScenario = new Map<string, Array<{ runIndex: number; verdict: string; vetoTriggered: boolean }>>()
    for (const e of events) {
      if (e.type === 'episode_done') {
        const list = byScenario.get(e.scenarioId) ?? []
        list.push({ runIndex: e.runIndex, verdict: e.verdict, vetoTriggered: e.vetoTriggered })
        byScenario.set(e.scenarioId, list)
      }
    }
    return [...byScenario.entries()]
  }, [events])

  // 当前 episode 轨迹: 最新 scenario_started 之后的 turn/tool_call/approval (场景切换自动清屏)。
  const trajectory = useMemo(() => {
    let from = 0
    for (let i = events.length - 1; i >= 0; i--) {
      if (events[i]!.type === 'scenario_started') { from = i + 1; break }
    }
    return events.slice(from).filter((e) => e.type === 'turn' || e.type === 'tool_call' || e.type === 'approval')
  }, [events])

  const handleAbort = () => {
    if (!window.confirm('确定中止本次评估运行?')) return
    // 中止成功后服务器结束进程, 状态由 SSE run_error 推移; 若 run 已结束 (404) 则忽略。
    void abortEvalRun(runId).catch(() => {})
  }

  return (
    <div className="p-6 max-w-6xl">
      <div className="flex items-center gap-3 mb-4 flex-wrap">
        <button type="button" onClick={onBack}
          className="inline-flex items-center gap-1 text-sm text-primary hover:underline">
          <ArrowLeft className="h-3.5 w-3.5" aria-hidden /> 运行列表
        </button>
        <h2 className="text-base font-medium text-ink">评估直播</h2>
        <span className="text-xs text-ink-soft font-mono">{runId}</span>
        <span className={clsx('inline-flex items-center gap-1.5 rounded border px-1.5 py-0.5 text-xs', stateClass(state))}>
          {state === 'running' && <span className="h-1.5 w-1.5 rounded-full bg-primary" aria-hidden />}
          {STATE_LABEL[state]}
        </span>
        <span className="flex-1" />
        {state === 'running' && (
          <button type="button" onClick={handleAbort}
            className="inline-flex items-center gap-1 rounded border border-danger/30 bg-white px-2.5 py-1 text-xs text-danger hover:bg-danger/5">
            <Square className="h-3 w-3" aria-hidden /> 中止
          </button>
        )}
        <button type="button" onClick={() => void replay()} title="重新拉取直播状态"
          className="inline-flex items-center gap-1 rounded border border-line bg-white px-2.5 py-1 text-xs text-ink-soft hover:text-primary">
          <RotateCcw className="h-3 w-3" aria-hidden /> 重连
        </button>
        {state === 'done' && (
          <button type="button" onClick={() => onOpenReport(runId)}
            className="inline-flex items-center gap-1 rounded bg-primary px-2.5 py-1 text-xs text-white hover:opacity-90">
            查看报告 <ExternalLink className="h-3 w-3" aria-hidden />
          </button>
        )}
      </div>

      {error && (
        <div className="mb-4 rounded border border-danger/25 bg-danger/5 px-3 py-2 text-sm text-danger">{error}</div>
      )}
      {state === 'interrupted' && !error && (
        <div className="mb-4 rounded border border-warning/30 bg-warning/5 px-3 py-2 text-sm text-warning">
          运行已中断或不存在, 可返回运行列表。
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-5">
        <div className="rounded-lg border border-line bg-white p-3">
          <div className="text-xs text-ink-soft mb-1">进度</div>
          <div className="text-lg tabular-nums text-ink">
            {progress.done}{progress.total > 0 ? ` / ${progress.total}` : ''}
          </div>
        </div>
        <div className="rounded-lg border border-line bg-white p-3">
          <div className="text-xs text-ink-soft mb-1">当前场景</div>
          <div className="text-sm font-mono text-ink">
            {progress.current ? `${progress.current.scenarioId} · 第 ${progress.current.runIndex} 轮` : '-'}
          </div>
        </div>
        <div className="rounded-lg border border-line bg-white p-3">
          <div className="text-xs text-ink-soft mb-1">事件数</div>
          <div className="text-lg tabular-nums text-ink">{events.length}</div>
        </div>
      </div>

      {verdicts.length > 0 && (
        <div className="rounded-lg border border-line bg-white p-4 mb-5">
          <div className="text-xs text-ink-soft mb-2">判定 (已完成的 episode)</div>
          <div className="flex flex-wrap gap-x-8 gap-y-3">
            {verdicts.map(([scenarioId, list]) => (
              <div key={scenarioId}>
                <div className="text-xs font-mono text-ink mb-1">{scenarioId}</div>
                <div className="flex flex-wrap gap-1">
                  {list.map((v) => (
                    <VerdictBadge key={v.runIndex} verdict={v.verdict} veto={v.vetoTriggered} />
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="rounded-lg border border-line bg-white p-4">
        <div className="text-sm font-medium text-ink mb-3">
          {progress.current ? `${progress.current.scenarioId} · 第 ${progress.current.runIndex} 轮轨迹` : '轨迹'}
        </div>
        {trajectory.length === 0 ? (
          <div className="text-sm text-ink-soft">{state === 'connecting' ? '连接中...' : '等待事件...'}</div>
        ) : (
          <div className="space-y-3">
            {trajectory.map((e, i) => {
              if (e.type === 'turn') return <TranscriptBubble key={i} role={e.role} text={e.text} />
              if (e.type === 'tool_call') return <ToolCallCard key={i} toolName={e.toolName} />
              return <ApprovalCard key={i} toolName={e.toolName} decision={e.decision} />
            })}
          </div>
        )}
      </div>
    </div>
  )
}
