import React, { useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import {
  Bot,
  User,
  AlertCircle,
  CheckCircle2,
  Loader2,
  Database,
  Wrench,
  ShieldAlert,
  AlertTriangle,
  ExternalLink,
  Check,
  X,
} from 'lucide-react'
import { type RenderItem, type ToolCallStep } from '../utils/realChatUtils'
import clsx from 'clsx'
import { DocumentReviewCard, type DocumentReviewPayload } from './DocumentReviewCard'

/** Write message text to the clipboard. Primary path is navigator.clipboard
 *  (secure context); the execCommand fallback is defensive for non-secure
 *  contexts (dev on :5173 is a localhost secure context, so the fallback is
 *  rarely hit). Returns void; callers manage UI confirmation state. */
async function copyMessageText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    try {
      document.execCommand('copy')
    } catch {
      /* ignore — clipboard unavailable */
    }
    document.body.removeChild(ta)
  }
}

const formatArgs = (args: unknown): string => {
  try {
    if (!args || typeof args !== 'object') return ''
    const entries = Object.entries(args as Record<string, unknown>)
    if (entries.length === 0) return ''
    return entries.map(([k, v]) => `${k}=${String(v)}`).join(' · ')
  } catch {
    return ''
  }
}

const formatResult = (result: unknown): string => {
  if (result === undefined || result === null) return ''
  if (typeof result === 'string') return result
  if (typeof result === 'object') {
    const r = result as Record<string, unknown>
    if (r.notFound) return '数据不可得'
    if (r.contractNo && r.amount !== undefined) {
      return `合同 ${r.contractNo} · 金额 ¥${Number(r.amount).toLocaleString()} · ${r.party || ''} · ${r.quantity || ''}${r.unit || ''}`
    }
    if (Array.isArray(r.orders)) {
      const missing = Array.isArray(r.missingInvoices) ? r.missingInvoices.length : 0
      return `${r.orders.length} 笔订单${missing > 0 ? ` · ${missing} 笔缺发票` : ''}`
    }
    return JSON.stringify(result)
  }
  return String(result)
}

const MarkdownContent: React.FC<{ children: string }> = ({ children }) => {
  return (
    <div className="text-sm leading-relaxed text-textDark markdown-body">
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
          a: ({ children, href }) => <a href={href} className="text-deepSea hover:underline">{children}</a>,
          hr: () => <hr className="my-3 border-borderGray" />,
          blockquote: ({ children }) => <blockquote className="border-l-2 border-steelBlue pl-3 italic text-textGray mb-2">{children}</blockquote>,
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  )
}

const BlockedCard: React.FC<{ toolName: string; args: unknown; blocked: NonNullable<ToolCallStep['blocked']> }> = ({
  toolName,
  args,
  blocked,
}) => {
  return (
    <div className="rounded-lg border border-danger/20 bg-danger/5 p-3 mt-2">
      <div className="flex items-start gap-2.5 mb-2.5">
        <div className="w-6 h-6 rounded-full bg-danger/10 flex items-center justify-center shrink-0">
          <AlertTriangle className="w-3.5 h-3.5 text-danger" />
        </div>
        <div className="min-w-0">
          <div className="text-sm font-medium text-textDark truncate">外部审批 · {toolName}</div>
          {formatArgs(args) && (
            <div className="text-[11px] font-mono text-steelBlue bg-white/50 rounded px-1.5 py-0.5 border border-borderGray/50 inline-block mt-1 truncate max-w-full">
              {formatArgs(args)}
            </div>
          )}
        </div>
      </div>
      <div className="space-y-1 text-xs text-textDark">
        <div className="flex gap-3">
          <span className="text-textGray shrink-0">审批单号</span>
          <span className="font-mono text-danger">{blocked.ticketId}</span>
        </div>
        <div className="flex gap-3">
          <span className="text-textGray shrink-0">状态</span>
          <span>已阻断，等待财务主管审批</span>
        </div>
        {blocked.message && <p className="text-textGray leading-relaxed mt-1">{blocked.message}</p>}
      </div>
      <div className="mt-3 text-[11px] text-textGray flex items-center gap-1">
        <ExternalLink className="w-3 h-3" />
        请在飞书审批流中处理，完成后再回到对话继续。
      </div>
    </div>
  )
}

const SoftGateCard: React.FC<{
  approvalId: string
  toolName: string
  args: unknown
  onApprove: (id: string) => void | PromiseLike<void>
  onDeny: (id: string) => void | PromiseLike<void>
}> = ({ approvalId, toolName, args, onApprove, onDeny }) => {
  const [state, setState] = useState<'idle' | 'busy' | 'approved' | 'denied'>('idle')

  const handleApprove = () => {
    if (state !== 'idle') return
    setState('busy')
    void Promise.resolve(onApprove(approvalId)).then(() => setState('approved'))
  }

  const handleDeny = () => {
    if (state !== 'idle') return
    setState('busy')
    void Promise.resolve(onDeny(approvalId)).then(() => setState('denied'))
  }

  return (
    <div className="rounded-lg border border-amber/30 bg-amber/5 p-3 mt-2">
      <div className="flex items-start gap-2.5 mb-2.5">
        <div className="w-6 h-6 rounded-full bg-amber/15 flex items-center justify-center shrink-0">
          <ShieldAlert className="w-3.5 h-3.5 text-amber" />
        </div>
        <div className="min-w-0">
          <div className="text-sm font-medium text-textDark truncate">操作确认 · {toolName}</div>
          {formatArgs(args) && (
            <div className="text-[11px] font-mono text-steelBlue bg-white/50 rounded px-1.5 py-0.5 border border-borderGray/50 inline-block mt-1 truncate max-w-full">
              {formatArgs(args)}
            </div>
          )}
        </div>
      </div>
      <p className="text-xs text-textGray mb-3 leading-relaxed">
        该操作属于 L2 写操作，执行后不可自动撤销。确认继续吗？
      </p>
      {state === 'idle' && (
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={handleApprove}
            className="inline-flex items-center gap-1 px-3 py-1.5 rounded-md bg-success text-white text-xs font-medium hover:bg-success/90 transition-colors"
          >
            <Check className="w-3.5 h-3.5" />
            确认执行
          </button>
          <button
            type="button"
            onClick={handleDeny}
            className="inline-flex items-center gap-1 px-3 py-1.5 rounded-md bg-white border border-borderGray text-textGray text-xs font-medium hover:text-textDark hover:border-textGray transition-colors"
          >
            <X className="w-3.5 h-3.5" />
            取消
          </button>
        </div>
      )}
      {state === 'busy' && (
        <div className="flex items-center gap-1.5 text-xs text-textGray">
          <Loader2 className="w-3.5 h-3.5 animate-spin" />
          处理中...
        </div>
      )}
      {state === 'approved' && (
        <div className="flex items-center gap-1.5 text-xs text-success">
          <CheckCircle2 className="w-3.5 h-3.5" />
          已确认，继续执行
        </div>
      )}
      {state === 'denied' && (
        <div className="flex items-center gap-1.5 text-xs text-textGray">
          <X className="w-3.5 h-3.5" />
          已取消
        </div>
      )}
    </div>
  )
}

const RealToolStep: React.FC<{ step: ToolCallStep }> = ({ step }) => {
  const isCompleted = step.status === 'completed'
  // `present_document_review` produces a rich 5-dimension review payload. When
  // present (and not an error shape), render the dedicated card instead of the
  // generic one-line result box. The error shape ({status:'error'}) and any
  // other output fall back to the generic box below.
  const reviewPayload = isReviewResult(step.toolName, step.result)
  return (
    <div className="flex items-start gap-3 py-2">
      <div className="relative flex flex-col items-center">
        <div
          className={clsx(
            'w-5 h-5 rounded-full flex items-center justify-center border-2 border-white',
            isCompleted ? 'bg-success text-white' : 'bg-white text-textGray border-borderGray'
          )}
        >
          {isCompleted ? <CheckCircle2 className="w-3 h-3" /> : <Loader2 className="w-3 h-3 animate-spin" />}
        </div>
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm font-medium text-textDark">{step.toolName}</span>
          <span className="text-[11px] font-mono text-steelBlue bg-white/50 rounded px-1.5 py-0.5 border border-borderGray/50 truncate max-w-full">
            {formatArgs(step.args)}
          </span>
        </div>
        {step.blocked ? (
          <BlockedCard toolName={step.toolName} args={step.args} blocked={step.blocked} />
        ) : (
          <>
            {isCompleted && step.result !== undefined && (
              reviewPayload ? (
                <DocumentReviewCard payload={reviewPayload} />
              ) : (
                <div className="mt-1.5 text-xs text-textDark bg-bgGray rounded px-2 py-1.5 border border-borderGray/50 flex items-start gap-1.5">
                  <Database className="w-3 h-3 text-steelBlue shrink-0 mt-0.5" />
                  <span className="leading-relaxed">{formatResult(step.result)}</span>
                </div>
              )
            )}
            {!isCompleted && (
              <div className="mt-1 text-[11px] text-textGray flex items-center gap-1">
                <Loader2 className="w-3 h-3 animate-spin" /> 等待工具返回...
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}

/** Narrow a tool step's result to the document-review payload when the tool is
 *  `present_document_review`, the result is an object carrying a `docId`, and it
 *  is not the `{status:'error'}` shape. Returns the typed payload or null. */
function isReviewResult(toolName: string, result: unknown): DocumentReviewPayload | null {
  if (toolName !== 'present_document_review') return null
  if (result === null || typeof result !== 'object') return null
  const r = result as Record<string, unknown>
  if (r.status === 'error') return null
  if (typeof r.docId !== 'string') return null
  return r as unknown as DocumentReviewPayload
}

export const RealMessageItem: React.FC<{
  item: RenderItem
  isStreaming?: boolean
  onApprove?: (id: string) => void | PromiseLike<void>
  onDeny?: (id: string) => void | PromiseLike<void>
}> = ({ item, isStreaming, onApprove, onDeny }) => {
  const isUser = item.role === 'user'
  // Copy-to-clipboard: aggregate the message's text segments into one string
  // and track which message id is in its 1.5s "已复制" confirmation window.
  const [copiedId, setCopiedId] = useState<string | null>(null)
  const fullText = item.segments
    .filter((s): s is { kind: 'text'; text: string } => s.kind === 'text')
    .map((s) => s.text)
    .join('\n\n')
  // 找最后一个文本段的位置：流式光标只挂在末尾文本段上（避免中间文本段也出光标）
  let lastTextSegmentIdx = -1
  for (let i = item.segments.length - 1; i >= 0; i--) {
    if (item.segments[i].kind === 'text') {
      lastTextSegmentIdx = i
      break
    }
  }

  return (
    <div className={clsx('flex gap-3 animate-slide-up', isUser ? 'flex-row-reverse' : '')}>
      <div
        className={clsx(
          'w-8 h-8 rounded-lg flex items-center justify-center shrink-0',
          isUser ? 'bg-steelBlue text-white' : 'bg-deepSea text-white'
        )}
      >
        {isUser ? <User className="w-4 h-4" /> : <Bot className="w-4 h-4" />}
      </div>
      <div
        className={clsx(
          'group max-w-[85%] rounded-2xl px-4 py-3 text-sm leading-relaxed shadow-sm',
          isUser ? 'bg-steelBlue text-white rounded-tr-sm' : 'bg-white border border-borderGray text-textDark rounded-tl-sm'
        )}
      >
        <div className="space-y-2">
          {item.segments.map((seg, idx) => {
            if (seg.kind === 'text') {
              const isLastText = idx === lastTextSegmentIdx
              return (
                <div key={`t-${idx}`} className="text-textDark">
                  <MarkdownContent>{seg.text}</MarkdownContent>
                  {isStreaming && !isUser && isLastText && (
                    <span className="inline-flex ml-1 gap-0.5 align-middle">
                      <span className="w-1 h-1 rounded-full bg-textGray animate-pulse-dot" style={{ animationDelay: '0ms' }} />
                      <span className="w-1 h-1 rounded-full bg-textGray animate-pulse-dot" style={{ animationDelay: '200ms' }} />
                      <span className="w-1 h-1 rounded-full bg-textGray animate-pulse-dot" style={{ animationDelay: '400ms' }} />
                    </span>
                  )}
                </div>
              )
            }

            if (seg.kind === 'approval-request') {
              return (
                <SoftGateCard
                  key={`a-${seg.approvalId}`}
                  approvalId={seg.approvalId}
                  toolName={seg.toolName}
                  args={seg.args}
                  onApprove={onApprove || (() => {})}
                  onDeny={onDeny || (() => {})}
                />
              )
            }

            // tool-group：连续工具调用归一组，保持时间顺序（夹在前后文本段之间）
            return (
              <div key={`g-${idx}`} className="rounded-lg border border-borderGray bg-bgGray/50 overflow-hidden mt-2">
                <div className="px-3 py-2 border-b border-borderGray bg-deepSea/5 flex items-center gap-2">
                  <Wrench className="w-4 h-4 text-steelBlue" />
                  <span className="text-xs font-medium text-textDark">工具调用</span>
                </div>
                <div className="px-3 divide-y divide-borderGray/50">
                  {seg.steps.map((step) => (
                    <RealToolStep key={step.toolCallId} step={step} />
                  ))}
                </div>
              </div>
            )
          })}
        </div>
        {/* Copy-to-clipboard affordance (assistant messages with text only).
            Hover-revealed via the `group` on the bubble; force-visible for the
            1.5s confirmation window after a click. */}
        {!isUser && fullText && (
          <div className="flex justify-end mt-1.5 -mb-1">
            <button
              type="button"
              onClick={async () => {
                await copyMessageText(fullText)
                setCopiedId(item.id)
                setTimeout(
                  () => setCopiedId((cur) => (cur === item.id ? null : cur)),
                  1500,
                )
              }}
              title="复制"
              className={clsx(
                'transition text-[11px] text-textGray hover:text-textDark',
                copiedId === item.id
                  ? 'opacity-100'
                  : 'opacity-0 group-hover:opacity-100',
              )}
            >
              {copiedId === item.id ? '已复制' : '复制'}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

export const ErrorMessage: React.FC<{ error: Error | null | undefined }> = ({ error }) => {
  if (!error) return null
  return (
    <div className="flex gap-3 animate-slide-up">
      <div className="w-8 h-8 rounded-lg bg-danger/10 flex items-center justify-center shrink-0">
        <AlertCircle className="w-4 h-4 text-danger" />
      </div>
      <div className="max-w-[85%] rounded-2xl px-4 py-3 text-sm leading-relaxed bg-white border border-danger/20 text-danger rounded-tl-sm">
        请求出错：{error.message}
      </div>
    </div>
  )
}
