import React, { useState } from 'react'
import {
  Bot,
  User,
  AlertCircle,
  CheckCircle2,
  Loader2,
  ShieldAlert,
  Check,
  X,
} from 'lucide-react'
import { type RenderItem, type Segment, formatArgs } from '../utils/realChatUtils'
import clsx from 'clsx'
import { FileAttachmentCard } from './FileAttachmentCard'
import { MarkdownContent } from './chat/MarkdownContent'
import { ToolGroupCard } from './chat/RealToolSteps'

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
      return <ToolGroupCard key={`g-${idx}`} steps={seg.steps} onOpenBindings={onOpenBindings} />
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
