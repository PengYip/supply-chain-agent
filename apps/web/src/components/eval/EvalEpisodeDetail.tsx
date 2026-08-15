// apps/web/src/components/eval/EvalEpisodeDetail.tsx
import clsx from 'clsx'
import { ArrowLeft, Wrench, ShieldCheck } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { useEvalRunEpisodes } from '../../hooks/useEvalRunEpisodes'
import { VerdictBadge } from './verdictBadge'

// Markdown 渲染与 RealMessageItem.MarkdownContent 同构 (该组件未导出, 类名对齐)。
const MarkdownContent: React.FC<{ children: string }> = ({ children }) => {
  return (
    <div className="text-sm leading-relaxed text-textDark">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          p: ({ children }) => <p className="mb-2 last:mb-0">{children}</p>,
          strong: ({ children }) => <strong className="font-bold text-textDark">{children}</strong>,
          ul: ({ children }) => <ul className="list-disc pl-5 mb-2">{children}</ul>,
          ol: ({ children }) => <ol className="list-decimal pl-5 mb-2">{children}</ol>,
          li: ({ children }) => <li className="mb-0.5">{children}</li>,
          code: ({ children, className }) => {
            const isBlock = className?.includes('language-')
            if (isBlock) {
              return (
                <pre className="bg-bgGray rounded p-2 overflow-auto mb-2">
                  <code className="font-mono text-xs text-textDark bg-transparent">{children}</code>
                </pre>
              )
            }
            return <code className="font-mono text-xs bg-bgGray px-1 py-0.5 rounded text-textDark">{children}</code>
          },
          table: ({ children }) => <table className="w-full text-xs border-collapse border border-borderGray mb-2">{children}</table>,
          thead: ({ children }) => <thead className="bg-bgGray">{children}</thead>,
          th: ({ children }) => <th className="border border-borderGray px-2 py-1 text-left font-medium">{children}</th>,
          td: ({ children }) => <td className="border border-borderGray px-2 py-1">{children}</td>,
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  )
}

function summarize(v: unknown): string {
  try {
    const s = JSON.stringify(v)
    return s && s.length > 200 ? `${s.slice(0, 200)}...` : (s ?? 'null')
  } catch {
    return String(v)
  }
}

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
          className="inline-flex items-center gap-1 text-sm text-deepSea hover:underline">
          <ArrowLeft className="h-3.5 w-3.5" aria-hidden /> 返回报告
        </button>
        <h2 className="text-base font-medium text-textDark font-mono text-sm">{scenarioId} · 第 {runIndex} 轮</h2>
        {droppedLines > 0 && (
          <span className="text-xs text-warning">另有 {droppedLines} 行损坏数据被跳过</span>
        )}
      </div>

      {loading && <div className="text-sm text-textGray">加载中...</div>}
      {error && <div className="text-sm text-danger">{error}</div>}
      {!loading && !error && !ep && <div className="text-sm text-textGray">episode 不存在。</div>}
      {ep && (
        <div className="flex flex-col lg:flex-row gap-4 items-start">
          {/* 左: 聊天列 + 工具/审批卡片区 */}
          <div className="flex-1 min-w-0 space-y-4">
            <div className="rounded-lg border border-borderGray bg-white p-4 space-y-3">
              {ep.transcript.map((seg, i) => {
                if (seg.role === 'system') {
                  return (
                    <div key={i} className="text-center text-xs text-textGray bg-bgGray rounded px-3 py-1.5">{seg.content}</div>
                  )
                }
                const isUser = seg.role === 'user'
                return (
                  <div key={i} className={clsx('flex', isUser ? 'justify-end' : 'justify-start')}>
                    <div className={clsx(
                      'max-w-[85%] rounded-lg px-3.5 py-2',
                      isUser ? 'bg-deepSea text-white' : 'bg-bgGray text-textDark',
                    )}>
                      {isUser ? <div className="text-sm whitespace-pre-wrap">{seg.content}</div> : <MarkdownContent>{seg.content}</MarkdownContent>}
                    </div>
                  </div>
                )
              })}
            </div>

            {ep.toolCalls.length > 0 && (
              <div className="rounded-lg border border-borderGray bg-white">
                <div className="px-4 py-2.5 border-b border-borderGray flex items-center gap-1.5 text-sm font-medium text-textDark">
                  <Wrench className="h-3.5 w-3.5 text-steelBlue" aria-hidden /> 工具调用 ({ep.toolCalls.length})
                </div>
                <div className="divide-y divide-borderGray">
                  {ep.toolCalls.map((t, i) => (
                    <details key={i} className="px-4 py-2">
                      <summary className="cursor-pointer text-sm text-textDark flex items-center gap-2">
                        <span className="font-mono text-xs">{t.toolName}</span>
                        {t.durationMs != null && <span className="text-xs text-textGray tabular-nums">{formatMs(t.durationMs)}</span>}
                      </summary>
                      <div className="mt-2 space-y-1 text-xs">
                        <div><span className="text-textGray">输入: </span><code className="font-mono bg-bgGray rounded px-1">{summarize(t.args)}</code></div>
                        <div><span className="text-textGray">结果: </span><code className="font-mono bg-bgGray rounded px-1">{summarize(t.result)}</code></div>
                      </div>
                    </details>
                  ))}
                </div>
              </div>
            )}

            {ep.approvals.length > 0 && (
              <div className="rounded-lg border border-borderGray bg-white">
                <div className="px-4 py-2.5 border-b border-borderGray flex items-center gap-1.5 text-sm font-medium text-textDark">
                  <ShieldCheck className="h-3.5 w-3.5 text-amber" aria-hidden /> 审批记录 ({ep.approvals.length})
                </div>
                <div className="divide-y divide-borderGray">
                  {ep.approvals.map((ap, i) => (
                    <div key={i} className="px-4 py-2.5 text-sm">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="rounded bg-amber/10 text-amber border border-amber/25 px-1.5 py-0.5 text-xs">{ap.level}</span>
                        <span className="font-mono text-xs text-textDark">{ap.toolName}</span>
                        <span className={clsx('text-xs', ap.decision === 'approved' ? 'text-success' : 'text-danger')}>
                          {ap.decision === 'approved' ? '已批准' : '已拒绝'}
                        </span>
                      </div>
                      <div className="mt-1 text-xs text-textGray">{ap.reason}{ap.matchedRule ? ` (规则: ${ap.matchedRule})` : ''}</div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* 右: 信息栏 */}
          <div className="w-full lg:w-80 space-y-3 shrink-0">
            <div className="rounded-lg border border-borderGray bg-white p-4">
              <div className="flex items-center gap-2 mb-3">
                <VerdictBadge verdict={ep.verdict} veto={ep.vetoTriggered} />
                <span className="text-xs text-textGray">判定</span>
              </div>
              <dl className="text-xs space-y-1.5">
                <div className="flex justify-between"><dt className="text-textGray">rubric 均分</dt><dd className="tabular-nums text-textDark">{ep.rubricScore == null ? '-' : ep.rubricScore.toFixed(1)}</dd></div>
                <div className="flex justify-between"><dt className="text-textGray">judge 置信度</dt><dd className="tabular-nums text-textDark">{ep.judgeConfidence == null ? '-' : ep.judgeConfidence.toFixed(2)}</dd></div>
                <div className="flex justify-between"><dt className="text-textGray">轮数</dt><dd className="tabular-nums text-textDark">{ep.turnsUsed}</dd></div>
                <div className="flex justify-between"><dt className="text-textGray">耗时</dt><dd className="tabular-nums text-textDark">{formatMs(ep.wallMs)}</dd></div>
                <div className="flex justify-between"><dt className="text-textGray">tokens (in/out)</dt><dd className="tabular-nums text-textDark">{ep.totalUsage.inputTokens}/{ep.totalUsage.outputTokens}</dd></div>
              </dl>
              {ep.simError && (
                <div className="mt-3 rounded border border-danger/25 bg-danger/5 p-2 text-xs text-danger">模拟器故障: {ep.simError}</div>
              )}
            </div>

            {ep.judgeDimensions.length > 0 && (
              <div className="rounded-lg border border-borderGray bg-white p-4">
                <div className="text-xs text-textGray mb-2">Judge 评分</div>
                <div className="space-y-2.5">
                  {ep.judgeDimensions.map((d, i) => (
                    <div key={i}>
                      <div className="flex items-center gap-2 text-sm">
                        <span className="text-textDark">{d.name}</span>
                        <span className="text-xs text-textGray">{d.weight}</span>
                        <span className="flex-1" />
                        <span className={clsx('tabular-nums font-medium', d.score >= 3 ? 'text-success' : d.score === 2 ? 'text-warning' : 'text-danger')}>{d.score}/4</span>
                      </div>
                      <div className="text-xs text-textGray mt-0.5">{d.rationale}</div>
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
                      <div className="text-textGray mt-0.5">{f.detail}</div>
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
