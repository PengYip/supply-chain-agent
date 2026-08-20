// apps/web/src/components/eval/EvalEpisodeDetail.tsx
import clsx from 'clsx'
import { ArrowLeft, Wrench, ShieldCheck } from 'lucide-react'
import { useEvalRunEpisodes } from '../../hooks/useEvalRunEpisodes'
import { VerdictBadge } from './verdictBadge'
import { TranscriptBubble, ToolCallCard, ApprovalCard } from './shared'

function formatMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`
}

export function EvalEpisodeDetail({ runId, scenarioId, runIndex, onBack }: {
  runId: string
  scenarioId: string
  runIndex: number
  onBack: () => void
}) {
  const { episodes, droppedLines, loading, error } = useEvalRunEpisodes(runId)
  const ep = episodes.find((e) => e.scenarioId === scenarioId && e.runIndex === runIndex)

  return (
    <div className="p-6 max-w-6xl">
      <div className="flex items-center gap-3 mb-4">
        <button type="button" onClick={onBack}
          className="inline-flex items-center gap-1 text-sm text-primary hover:underline">
          <ArrowLeft className="h-3.5 w-3.5" aria-hidden /> 返回报告
        </button>
        <h2 className="text-base font-medium text-ink font-mono text-sm">{scenarioId} · 第 {runIndex} 轮</h2>
        {droppedLines > 0 && (
          <span className="text-xs text-warning">另有 {droppedLines} 行损坏数据被跳过</span>
        )}
      </div>

      {loading && <div className="text-sm text-ink-soft">加载中...</div>}
      {error && <div className="text-sm text-danger">{error}</div>}
      {!loading && !error && !ep && <div className="text-sm text-ink-soft">episode 不存在。</div>}
      {ep && (
        <div className="flex flex-col lg:flex-row gap-4 items-start">
          {/* 左: 聊天列 + 工具/审批卡片区 */}
          <div className="flex-1 min-w-0 space-y-4">
            <div className="rounded-lg border border-line bg-white p-4 space-y-3">
              {ep.transcript.map((seg, i) => (
                <TranscriptBubble key={i} role={seg.role} text={seg.content} />
              ))}
            </div>

            {ep.toolCalls.length > 0 && (
              <div className="rounded-lg border border-line bg-white">
                <div className="px-4 py-2.5 border-b border-line flex items-center gap-1.5 text-sm font-medium text-ink">
                  <Wrench className="h-3.5 w-3.5 text-primary-500" aria-hidden /> 工具调用 ({ep.toolCalls.length})
                </div>
                <div className="divide-y divide-line">
                  {ep.toolCalls.map((t, i) => (
                    <ToolCallCard key={i} toolName={t.toolName} durationMs={t.durationMs} input={t.args} result={t.result} />
                  ))}
                </div>
              </div>
            )}

            {ep.approvals.length > 0 && (
              <div className="rounded-lg border border-line bg-white">
                <div className="px-4 py-2.5 border-b border-line flex items-center gap-1.5 text-sm font-medium text-ink">
                  <ShieldCheck className="h-3.5 w-3.5 text-warning" aria-hidden /> 审批记录 ({ep.approvals.length})
                </div>
                <div className="divide-y divide-line">
                  {ep.approvals.map((ap, i) => (
                    <ApprovalCard key={i} toolName={ap.toolName} level={ap.level} decision={ap.decision} matchedRule={ap.matchedRule} reason={ap.reason} />
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* 右: 信息栏 */}
          <div className="w-full lg:w-80 space-y-3 shrink-0">
            <div className="rounded-lg border border-line bg-white p-4">
              <div className="flex items-center gap-2 mb-3">
                <VerdictBadge verdict={ep.verdict} veto={ep.vetoTriggered} />
                <span className="text-xs text-ink-soft">判定</span>
              </div>
              <dl className="text-xs space-y-1.5">
                <div className="flex justify-between"><dt className="text-ink-soft">rubric 均分</dt><dd className="tabular-nums text-ink">{ep.rubricScore == null ? '-' : ep.rubricScore.toFixed(1)}</dd></div>
                <div className="flex justify-between"><dt className="text-ink-soft">judge 置信度</dt><dd className="tabular-nums text-ink">{ep.judgeConfidence == null ? '-' : ep.judgeConfidence.toFixed(2)}</dd></div>
                <div className="flex justify-between"><dt className="text-ink-soft">轮数</dt><dd className="tabular-nums text-ink">{ep.turnsUsed}</dd></div>
                <div className="flex justify-between"><dt className="text-ink-soft">耗时</dt><dd className="tabular-nums text-ink">{formatMs(ep.wallMs)}</dd></div>
                <div className="flex justify-between"><dt className="text-ink-soft">tokens (in/out)</dt><dd className="tabular-nums text-ink">{ep.totalUsage.inputTokens}/{ep.totalUsage.outputTokens}</dd></div>
              </dl>
              {ep.simError && (
                <div className="mt-3 rounded border border-danger/25 bg-danger/5 p-2 text-xs text-danger">模拟器故障: {ep.simError}</div>
              )}
            </div>

            {ep.judgeDimensions.length > 0 && (
              <div className="rounded-lg border border-line bg-white p-4">
                <div className="text-xs text-ink-soft mb-2">Judge 评分</div>
                <div className="space-y-2.5">
                  {ep.judgeDimensions.map((d, i) => (
                    <div key={i}>
                      <div className="flex items-center gap-2 text-sm">
                        <span className="text-ink">{d.name}</span>
                        <span className="text-xs text-ink-soft">{d.weight}</span>
                        <span className="flex-1" />
                        <span className={clsx('tabular-nums font-medium', d.score >= 3 ? 'text-success' : d.score === 2 ? 'text-warning' : 'text-danger')}>{d.score}/4</span>
                      </div>
                      <div className="text-xs text-ink-soft mt-0.5">{d.rationale}</div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {ep.verifierFailures.length > 0 && (
              <div className="rounded-lg border border-danger/25 bg-danger/5 p-4">
                <div className="text-xs text-danger mb-2">Verifier 失败</div>
                <div className="space-y-2">
                  {ep.verifierFailures.map((f, i) => (
                    <div key={i} className="text-xs">
                      <span className="font-mono text-danger">{f.check}</span>
                      <div className="text-ink-soft mt-0.5">{f.detail}</div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
