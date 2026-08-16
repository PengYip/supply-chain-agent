// apps/web/src/components/eval/shared.tsx
// 共享渲染件: 从 EvalEpisodeDetail 提取的 TranscriptBubble / ToolCallCard /
// ApprovalCard 与 MarkdownContent 副本。视觉与 EvalEpisodeDetail 原实现逐字节一致;
// input/result/level/reason 等可选字段供直播事件 (tool_call/approval 无参数) 复用。
import clsx from 'clsx'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

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

export function TranscriptBubble({ role, text }: { role: 'user' | 'assistant' | 'system' | 'system-note'; text: string }) {
  if (role === 'system' || role === 'system-note') {
    return <div className="text-center text-xs text-textGray bg-bgGray rounded px-3 py-1.5">{text}</div>
  }
  const isUser = role === 'user'
  return (
    <div className={clsx('flex', isUser ? 'justify-end' : 'justify-start')}>
      <div className={clsx(
        'max-w-[85%] rounded-lg px-3.5 py-2',
        isUser ? 'bg-deepSea text-white' : 'bg-bgGray text-textDark',
      )}>
        {isUser ? <div className="text-sm whitespace-pre-wrap">{text}</div> : <MarkdownContent>{text}</MarkdownContent>}
      </div>
    </div>
  )
}

export function ToolCallCard({ toolName, durationMs, input, result, defaultOpen }: {
  toolName: string
  durationMs?: number | null
  input?: unknown
  result?: unknown
  defaultOpen?: boolean
}) {
  return (
    <details className="px-4 py-2" open={defaultOpen}>
      <summary className="cursor-pointer text-sm text-textDark flex items-center gap-2">
        <span className="font-mono text-xs">{toolName}</span>
        {durationMs != null && <span className="text-xs text-textGray tabular-nums">{formatMs(durationMs)}</span>}
      </summary>
      {(input !== undefined || result !== undefined) && (
        <div className="mt-2 space-y-1 text-xs">
          {input !== undefined && (
            <div><span className="text-textGray">输入: </span><code className="font-mono bg-bgGray rounded px-1">{summarize(input)}</code></div>
          )}
          {result !== undefined && (
            <div><span className="text-textGray">结果: </span><code className="font-mono bg-bgGray rounded px-1">{summarize(result)}</code></div>
          )}
        </div>
      )}
    </details>
  )
}

export function ApprovalCard({ toolName, level, decision, matchedRule, reason }: {
  toolName: string
  level?: string
  decision: string
  matchedRule?: string | null
  reason?: string
}) {
  return (
    <div className="px-4 py-2.5 text-sm">
      <div className="flex items-center gap-2 flex-wrap">
        {level && <span className="rounded bg-amber/10 text-amber border border-amber/25 px-1.5 py-0.5 text-xs">{level}</span>}
        <span className="font-mono text-xs text-textDark">{toolName}</span>
        <span className={clsx('text-xs', decision === 'approved' ? 'text-success' : 'text-danger')}>
          {decision === 'approved' ? '已批准' : '已拒绝'}
        </span>
      </div>
      {(reason !== undefined || matchedRule) && (
        <div className="mt-1 text-xs text-textGray">{reason ?? ''}{matchedRule ? ` (规则: ${matchedRule})` : ''}</div>
      )}
    </div>
  )
}
