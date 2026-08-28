import React, { useEffect, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import {
  Bot,
  User,
  AlertCircle,
  BookOpen,
  CheckCircle2,
  Loader2,
  Database,
  Wrench,
  ShieldAlert,
  ArrowDown,
  Check,
  X,
} from 'lucide-react'
import {
  type RenderItem,
  type Segment,
  type ToolCallStep,
  parseEscalateArgs,
  escalateCategoryLabel,
  severityLabel,
  severityBadgeClass,
} from '../utils/realChatUtils'
import clsx from 'clsx'
import { FileAttachmentCard } from './FileAttachmentCard'
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
    <div className="text-sm leading-relaxed text-ink markdown-body">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          p: ({ children }) => <p className="mb-2 last:mb-0">{children}</p>,
          strong: ({ children }) => <strong className="font-bold text-ink">{children}</strong>,
          ul: ({ children }) => <ul className="list-disc pl-5 mb-2">{children}</ul>,
          ol: ({ children }) => <ol className="list-decimal pl-5 mb-2">{children}</ol>,
          li: ({ children }) => <li className="mb-0.5">{children}</li>,
          code: ({ children, className }) => {
            const isBlock = className?.includes('language-')
            if (isBlock) {
              return (
                <pre className="bg-surface rounded p-2 overflow-auto mb-2">
                  <code className="font-mono text-xs text-ink bg-transparent">{children}</code>
                </pre>
              )
            }
            return <code className="font-mono text-xs bg-surface px-1 py-0.5 rounded text-ink">{children}</code>
          },
          table: ({ children }) => <table className="w-full text-xs border-collapse border border-line mb-2">{children}</table>,
          thead: ({ children }) => <thead className="bg-surface">{children}</thead>,
          th: ({ children }) => <th className="border border-line px-2 py-1 text-left font-medium">{children}</th>,
          td: ({ children }) => <td className="border border-line px-2 py-1">{children}</td>,
          a: ({ children, href }) => <a href={href} className="text-primary hover:underline">{children}</a>,
          hr: () => <hr className="my-3 border-line" />,
          blockquote: ({ children }) => <blockquote className="border-l-2 border-primary-500 pl-3 italic text-ink-soft mb-2">{children}</blockquote>,
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  )
}

/** L3 人工复核工单的展示卡（纯信息展示，记录在时间线里）。escalate_to_human
 *  的入参渲染为可读徽章（分类/严重度）+ 问题原文；其他工具保持通用形态。
 *  交互入口不在这里：可操作的复核卡挂在输入框上方（见 RealChatView）。 */
const BlockedCard: React.FC<{ toolName: string; args: unknown; blocked: NonNullable<ToolCallStep['blocked']> }> = ({
  toolName,
  args,
  blocked,
}) => {
  const esc = toolName === 'escalate_to_human' ? parseEscalateArgs(args) : null
  return (
    <div className="rounded-lg border border-primary/20 bg-white p-3 mt-2">
      <div className="flex items-start gap-2.5">
        <div className="w-6 h-6 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
          <ShieldAlert className="w-3.5 h-3.5 text-primary" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-ink truncate">
            {esc ? '人工复核工单' : '操作已阻断'} · {toolName}
          </div>
          <div className="mt-1.5 flex items-center flex-wrap gap-1.5">
            <span className="text-[11px] font-mono text-primary-500 bg-surface rounded px-1.5 py-0.5 border border-line">
              {blocked.ticketId}
            </span>
            {esc?.category && (
              <span className="text-[11px] leading-none rounded-full px-2 py-1 bg-white text-primary border border-primary/20">
                {escalateCategoryLabel(esc.category)}
              </span>
            )}
            {esc?.severity && (
              <span className={clsx('text-[11px] leading-none rounded-full px-2 py-1 border', severityBadgeClass(esc.severity))}>
                {severityLabel(esc.severity)}
              </span>
            )}
          </div>
          {!esc && formatArgs(args) && (
            <div className="mt-1.5 text-[11px] font-mono text-primary-500 bg-surface/50 rounded px-1.5 py-0.5 border border-line/50 inline-block truncate max-w-full">
              {formatArgs(args)}
            </div>
          )}
          {esc && <p className="text-xs text-ink leading-relaxed mt-2 break-words">{esc.issue}</p>}
          {blocked.message && (
            <p className={clsx('leading-relaxed mt-1.5 break-words', esc ? 'text-[11px] text-ink-soft' : 'text-xs text-ink')}>
              {blocked.message}
            </p>
          )}
          <div className="text-[11px] text-ink-soft mt-2">已阻断，等待人工复核</div>
        </div>
      </div>
      <div className="mt-2.5 pt-2 border-t border-line/60 flex items-center gap-1 text-[11px] text-ink-soft">
        <ArrowDown className="w-3 h-3 shrink-0" />
        在下方复核卡中选择处理方式
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
    <div className="rounded-lg border border-warning/30 bg-warning/5 p-3 mt-2">
      <div className="flex items-start gap-2.5 mb-2.5">
        <div className="w-6 h-6 rounded-full bg-warning/15 flex items-center justify-center shrink-0">
          <ShieldAlert className="w-3.5 h-3.5 text-warning" />
        </div>
        <div className="min-w-0">
          <div className="text-sm font-medium text-ink truncate">操作确认 · {toolName}</div>
          {formatArgs(args) && (
            <div className="text-[11px] font-mono text-primary-500 bg-white/50 rounded px-1.5 py-0.5 border border-line/50 inline-block mt-1 truncate max-w-full">
              {formatArgs(args)}
            </div>
          )}
        </div>
      </div>
      <p className="text-xs text-ink-soft mb-3 leading-relaxed">
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
            className="inline-flex items-center gap-1 px-3 py-1.5 rounded-md bg-white border border-line text-ink-soft text-xs font-medium hover:text-ink hover:border-ink-soft transition-colors"
          >
            <X className="w-3.5 h-3.5" />
            取消
          </button>
        </div>
      )}
      {state === 'busy' && (
        <div className="flex items-center gap-1.5 text-xs text-ink-soft">
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
        <div className="flex items-center gap-1.5 text-xs text-ink-soft">
          <X className="w-3.5 h-3.5" />
          已取消
        </div>
      )}
    </div>
  )
}

/** Generic tool-result box, collapsed to a 2-line preview by default. The
 *  展开/收起 toggle is only rendered when the clamped text actually overflows
 *  (detected by measuring scrollHeight vs clientHeight while line-clamped, so
 *  short one-line results stay clean). Expanded view preserves whitespace,
 *  breaks long unbroken JSON strings, and scrolls past ~16rem instead of
 *  stretching the chat bubble. */
const ToolResultBox: React.FC<{ result: unknown }> = ({ result }) => {
  const [expanded, setExpanded] = useState(false)
  const [overflowing, setOverflowing] = useState(false)
  const textRef = useRef<HTMLSpanElement | null>(null)
  const text = formatResult(result)

  // Measure while collapsed: line-clamp caps clientHeight at 2 lines, so
  // scrollHeight beyond it means the full content is taller than the preview.
  // ResizeObserver re-checks when the bubble width changes (max-w-[85%]).
  useEffect(() => {
    const el = textRef.current
    if (!el || expanded) return
    const measure = () => setOverflowing(el.scrollHeight > el.clientHeight + 1)
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [expanded, text])

  return (
    <div className="mt-1.5 text-xs text-ink bg-surface rounded px-2 py-1.5 border border-line/50 flex items-start gap-1.5">
      <Database className="w-3 h-3 text-primary-500 shrink-0 mt-0.5" />
      <div className="min-w-0 flex-1">
        <span
          ref={textRef}
          className={clsx(
            'leading-relaxed whitespace-pre-wrap break-all',
            expanded ? 'block max-h-64 overflow-auto' : 'line-clamp-2',
          )}
        >
          {text}
        </span>
        {overflowing && (
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="mt-1 text-[11px] text-primary-500 hover:text-primary transition-colors"
          >
            {expanded ? '收起' : '展开'}
          </button>
        )}
      </div>
    </div>
  )
}

const RealToolStep: React.FC<{
  step: ToolCallStep
  /** Present-tense jump affordance for the 5-dimension review card (see
   *  DocumentReviewCard.onOpenBindings); omitted -> card renders without it. */
  onOpenBindings?: (docId: string) => void
}> = ({ step, onOpenBindings }) => {
  const isCompleted = step.status === 'completed'
  // `present_document_review` produces a rich 5-dimension review payload. When
  // present (and not an error shape), render the dedicated card instead of the
  // generic one-line result box. The error shape ({status:'error'}) and any
  // other output fall back to the generic box below.
  const reviewPayload = isReviewResult(step.toolName, step.result)
  // load_skill 成功结果走专属 SkillCard(2026-08-28 Skill 化); 失败回落通用框。
  const skillPayload = isSkillPayload(step.toolName, step.result)
  return (
    <div className="flex items-start gap-3 py-2">
      <div className="relative flex flex-col items-center">
        <div
          className={clsx(
            'w-5 h-5 rounded-full flex items-center justify-center border-2 border-white',
            isCompleted ? 'bg-success text-white' : 'bg-white text-ink-soft border-line'
          )}
        >
          {isCompleted ? <CheckCircle2 className="w-3 h-3" /> : <Loader2 className="w-3 h-3 animate-spin" />}
        </div>
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm font-medium text-ink">{step.toolName}</span>
          <span className="text-[11px] font-mono text-primary-500 bg-white/50 rounded px-1.5 py-0.5 border border-line/50 truncate max-w-full">
            {formatArgs(step.args)}
          </span>
        </div>
        {step.blocked ? (
          <BlockedCard toolName={step.toolName} args={step.args} blocked={step.blocked} />
        ) : (
          <>
            {isCompleted && step.result !== undefined && (
              skillPayload ? (
                <SkillCard payload={skillPayload} />
              ) : reviewPayload ? (
                <DocumentReviewCard payload={reviewPayload} onOpenBindings={onOpenBindings} />
              ) : (
                <ToolResultBox result={step.result} />
              )
            )}
            {!isCompleted && (
              <div className="mt-1 text-[11px] text-ink-soft flex items-center gap-1">
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

// ── load_skill 专属卡(2026-08-28 Skill 化) ────────────────────────────
// 技能装载不是业务数据查询而是装载一套标准作业流程, 用区别于通用结果框的
// 样式呈现(主色调 + 文档图标 + SKILL 徽标 + 全文 markdown 可折叠)。
// success:false(未登记名/逃逸路径)不走此卡, 回落通用框以暴露错误信息。

interface SkillPayload {
  name: string
  file?: string
  description: string
  content: string
  files: string[]
  truncated: boolean
}

function isSkillPayload(toolName: string, result: unknown): SkillPayload | null {
  if (toolName !== 'load_skill') return null
  if (result === null || typeof result !== 'object') return null
  const r = result as Record<string, unknown>
  if (r.success !== true) return null
  if (typeof r.name !== 'string' || typeof r.content !== 'string') return null
  return {
    name: r.name,
    file: typeof r.file === 'string' ? r.file : undefined,
    description: typeof r.description === 'string' ? r.description : '',
    content: r.content,
    files: Array.isArray(r.files) ? r.files.filter((f): f is string => typeof f === 'string') : [],
    truncated: r.truncated === true,
  }
}

const SkillCard: React.FC<{ payload: SkillPayload }> = ({ payload }) => {
  const [expanded, setExpanded] = useState(false)
  const isRef = payload.file !== undefined
  return (
    <div className="mt-1.5 rounded-lg border border-primary-500/30 bg-primary-500/5 px-3 py-2">
      <div className="flex items-center gap-1.5 flex-wrap">
        <BookOpen className="w-3.5 h-3.5 text-primary-500 shrink-0" />
        <span className="text-xs font-semibold text-ink">
          {isRef ? `技能参考 · ${payload.name}/${payload.file}` : `技能已装载 · ${payload.name}`}
        </span>
        <span className="text-[10px] font-mono text-primary-500 bg-white/60 rounded px-1 py-0.5 border border-primary-500/30">
          SKILL
        </span>
        {payload.truncated && (
          <span className="text-[10px] text-amber-600 bg-white/60 rounded px-1 py-0.5 border border-line">已截断</span>
        )}
      </div>
      {!isRef && payload.description && (
        <div className="mt-1 text-[11px] text-ink-soft leading-relaxed">{payload.description}</div>
      )}
      {!isRef && payload.files.length > 0 && (
        <div className="mt-1.5 flex items-center gap-1 flex-wrap">
          <span className="text-[10px] text-ink-soft">附属文件:</span>
          {payload.files.map((f) => (
            <span key={f} className="text-[10px] font-mono text-primary-500 bg-white/60 rounded px-1 py-0.5 border border-line/60">
              {f}
            </span>
          ))}
        </div>
      )}
      <div className={clsx('mt-1.5 pr-1', expanded ? 'max-h-80 overflow-auto' : 'line-clamp-3')}>
        <MarkdownContent>{payload.content}</MarkdownContent>
      </div>
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="mt-1 text-[11px] text-primary-500 hover:text-primary transition-colors"
      >
        {expanded ? '收起全文' : '展开全文'}
      </button>
    </div>
  )
}

export const RealMessageItem: React.FC<{
  item: RenderItem
  isStreaming?: boolean
  onApprove?: (id: string) => void | PromiseLike<void>
  onDeny?: (id: string) => void | PromiseLike<void>
  /** Jump to the bindings workbench for a docId (App 统一注入)。 */
  onOpenBindings?: (docId: string) => void
  /** 服务端权威的仍待处理审批 id 名单(L2 approvalId + L3 ticketId)。
   *  null = 尚未加载。持久化消息的 approval-requested part 在审批解决后
   *  不回写, 恢复会话时以此名单防已确认卡片重放。 */
  approvalsPendingIds?: Set<string> | null
}> = ({ item, isStreaming, onApprove, onDeny, onOpenBindings, approvalsPendingIds }) => {
  const isUser = item.role === 'user'
  // Copy-to-clipboard: aggregate the message's text segments into one string
  // and track which message id is in its 1.5s "已复制" confirmation window.
  const [copiedId, setCopiedId] = useState<string | null>(null)
  const fullText = item.segments
    .filter((s): s is { kind: 'text'; text: string } => s.kind === 'text')
    .map((s) => s.text)
    .join('\n\n')
  type AttachmentSegment = Extract<Segment, { kind: 'attachment' }>
  const attachmentSegments = item.segments.filter(
    (s): s is AttachmentSegment => s.kind === 'attachment',
  )
  // 用户消息含附件时：卡片堆叠在气泡上方（同一右对齐列），与参考截图一致。
  const wrapped = isUser && attachmentSegments.length > 0
  const contentSegments = wrapped
    ? item.segments.filter((s) => s.kind !== 'attachment')
    : item.segments

  // 找最后一个文本段的位置：流式光标只挂在末尾文本段上（避免中间文本段也出光标）
  const renderSegments = (segs: Segment[]) => {
    let lastTextSegmentIdx = -1
    for (let i = segs.length - 1; i >= 0; i--) {
      if (segs[i].kind === 'text') {
        lastTextSegmentIdx = i
        break
      }
    }
    return segs.map((seg, idx) => {
      if (seg.kind === 'text') {
        const isLastText = idx === lastTextSegmentIdx
        return (
          <div key={`t-${idx}`} className="text-ink">
            <MarkdownContent>{seg.text}</MarkdownContent>
            {isStreaming && !isUser && isLastText && (
              <span className="inline-flex ml-1 gap-0.5 align-middle">
                <span className="w-1 h-1 rounded-full bg-ink-soft animate-pulse-dot" style={{ animationDelay: '0ms' }} />
                <span className="w-1 h-1 rounded-full bg-ink-soft animate-pulse-dot" style={{ animationDelay: '200ms' }} />
                <span className="w-1 h-1 rounded-full bg-ink-soft animate-pulse-dot" style={{ animationDelay: '400ms' }} />
              </span>
            )}
          </div>
        )
      }

      if (seg.kind === 'approval-request') {
        // 恢复防重放门: 流式中的消息(含 L2 续跑)恒为交互卡; 空闲时以服务端
        // 名单为准 —— 已解决的渲染静态提示, 名单未加载前暂不出卡(避免已解决
        // 卡片闪现后再消失)。
        if (!isStreaming) {
          if (approvalsPendingIds === null || approvalsPendingIds === undefined) return null
          if (!approvalsPendingIds.has(seg.approvalId)) {
            return (
              <div
                key={`a-${seg.approvalId}`}
                className="mt-2 flex items-center gap-1.5 rounded-lg border border-line bg-surface/60 px-3 py-2 text-[11px] text-ink-soft"
              >
                <CheckCircle2 className="w-3.5 h-3.5 shrink-0 text-success" />
                操作确认已处理
              </div>
            )
          }
        }
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

      if (seg.kind === 'attachment') {
        return <FileAttachmentCard key={`att-${seg.attachment.docId}-${idx}`} attachment={seg.attachment} />
      }

      // tool-group：连续工具调用归一组，保持时间顺序（夹在前后文本段之间）
      return (
        <div key={`g-${idx}`} className="rounded-lg border border-line bg-surface/50 overflow-hidden mt-2">
          <div className="px-3 py-2 border-b border-line bg-primary/5 flex items-center gap-2">
            <Wrench className="w-4 h-4 text-primary-500" />
            <span className="text-xs font-medium text-ink">工具调用</span>
          </div>
          <div className="px-3 divide-y divide-line/50">
            {seg.steps.map((step) => (
              <RealToolStep key={step.toolCallId} step={step} onOpenBindings={onOpenBindings} />
            ))}
          </div>
        </div>
      )
    })
  }

  return (
    <div className={clsx('flex gap-3 animate-slide-up', isUser ? 'flex-row-reverse' : '')}>
      <div
        className={clsx(
          'w-8 h-8 rounded-lg flex items-center justify-center shrink-0',
          isUser ? 'bg-primary-500 text-white' : 'bg-primary text-white'
        )}
      >
        {isUser ? <User className="w-4 h-4" /> : <Bot className="w-4 h-4" />}
      </div>
      {wrapped ? (
        <div className="flex flex-col items-end gap-2 max-w-[85%] min-w-0">
          {attachmentSegments.map((seg, idx) => (
            <FileAttachmentCard key={`att-${seg.attachment.docId}-${idx}`} attachment={seg.attachment} />
          ))}
          <div
            className={clsx(
              'group rounded-2xl px-4 py-3 text-sm leading-relaxed shadow-sm',
              isUser ? 'bg-primary-500 text-white rounded-tr-sm' : 'bg-white border border-line text-ink rounded-tl-sm',
            )}
          >
            <div className="space-y-2">{renderSegments(contentSegments)}</div>
          </div>
        </div>
      ) : (
        <div
          className={clsx(
            'group max-w-[85%] rounded-2xl px-4 py-3 text-sm leading-relaxed shadow-sm',
            isUser ? 'bg-primary-500 text-white rounded-tr-sm' : 'bg-white border border-line text-ink rounded-tl-sm',
          )}
        >
          <div className="space-y-2">{renderSegments(item.segments)}</div>
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
                  'transition text-[11px] text-ink-soft hover:text-ink',
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
      )}
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

/** 模型服务欠费专用提示卡（run.error code='provider_arrears'）。临时 UI 状态：
 *  不持久化、不入会话历史；充值后重新发送消息即可恢复。视觉上与 ErrorMessage
 *  同位同类（danger 色系），但文案面向最终用户给出明确行动指引。 */
export const ArrearsNotice: React.FC = () => {
  return (
    <div className="flex gap-3 animate-slide-up">
      <div className="w-8 h-8 rounded-lg bg-danger/10 flex items-center justify-center shrink-0">
        <AlertCircle className="w-4 h-4 text-danger" />
      </div>
      <div className="max-w-[85%] rounded-2xl px-4 py-3 text-sm leading-relaxed bg-white border border-danger/20 rounded-tl-sm">
        <div className="font-medium text-danger">AI 模型服务欠费</div>
        <p className="text-ink mt-1">
          模型服务商账户余额不足，本轮回复未能生成。请联系管理员为 DeepSeek / 千问账户充值，充值后重新发送消息即可继续对话。
        </p>
      </div>
    </div>
  )
}
