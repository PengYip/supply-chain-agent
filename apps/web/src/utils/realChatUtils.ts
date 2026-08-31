import type { ContextFile } from '../hooks/useFiles'

export interface ToolCallStep {
  toolCallId: string
  toolName: string
  args: unknown
  status: 'running' | 'completed' | 'failed'
  result?: unknown
  /** 失败终态（AI SDK 6 state='output-error'）时 SDK 携带的错误文本，
   *  供折叠摘要与展开详情展示。 */
  errorText?: string
  blocked?: {
    reason: string
    ticketId: string
    message?: string
  }
}

/** Display-only attachment metadata embedded in user messages as a custom
 *  `data-attachment` UI part. convertToModelMessages (AI SDK 6) silently
 *  drops `data-*` parts, so this never reaches the model — it exists purely
 *  for rendering and history persistence. docId/key are reserved hooks for
 *  the future online-preview feature. */
export interface AttachmentData {
  filename: string
  docId: string
  key: string
  fileType: string // uppercased extension, e.g. "PDF"; "FILE" when unknown
}

export interface AttachmentUIPart {
  type: 'data-attachment'
  id: string // = docId, unique within the message
  data: AttachmentData
}

/** Derive the display type label from the filename extension. */
const deriveFileType = (filename: string): string => {
  const m = /\.([a-zA-Z0-9]+)$/.exec(filename.trim())
  return m ? m[1].toUpperCase() : 'FILE'
}

/** Build the `data-attachment` part for a context file at send time. */
export const toAttachmentPart = (file: ContextFile): AttachmentUIPart => ({
  type: 'data-attachment',
  id: file.docId,
  data: {
    filename: file.filename,
    docId: file.docId,
    key: file.key,
    fileType: deriveFileType(file.filename),
  },
})

/** L3 escalate_to_human 工具参数中可读展示的字段（context 不在此展开）。 */
export type EscalateCategory = 'data_conflict' | 'data_missing' | 'low_confidence' | 'rule_boundary' | 'other'
export type EscalateSeverity = 'low' | 'medium' | 'high'

export interface EscalateInfo {
  issue: string
  category?: EscalateCategory
  severity?: EscalateSeverity
}

const ESCALATE_CATEGORY_LABELS: Record<EscalateCategory, string> = {
  data_conflict: '数据冲突',
  data_missing: '数据缺失',
  low_confidence: '置信度不足',
  rule_boundary: '规则边界',
  other: '其他',
}

/** 从工具入参里解析 escalate_to_human 的问题/分类/严重度；issue 缺失时返回
 *  null（调用方回退到 blocked.message），分类/严重度取值未知时省略对应徽章。 */
export const parseEscalateArgs = (args: unknown): EscalateInfo | null => {
  if (args === null || typeof args !== 'object') return null
  const a = args as Record<string, unknown>
  if (typeof a.issue !== 'string' || a.issue.trim() === '') return null
  const category =
    typeof a.category === 'string' && a.category in ESCALATE_CATEGORY_LABELS
      ? (a.category as EscalateCategory)
      : undefined
  const severity =
    a.severity === 'high' || a.severity === 'medium' || a.severity === 'low' ? a.severity : undefined
  return { issue: a.issue, category, severity }
}

export const escalateCategoryLabel = (category: EscalateCategory): string => ESCALATE_CATEGORY_LABELS[category]

export const severityLabel = (severity: EscalateSeverity): string =>
  severity === 'high' ? '高风险' : severity === 'medium' ? '中风险' : '低风险'

/** L3 卡片共用的严重度徽标配色：high=danger / medium=warning / low=中性。 */
export const severityBadgeClass = (severity: EscalateSeverity): string =>
  severity === 'high'
    ? 'bg-danger/10 text-danger border-danger/20'
    : severity === 'medium'
      ? 'bg-warning/10 text-warning border-warning/20'
      : 'bg-white text-ink-soft border-line'

// 按 parts 原始顺序交错的渲染段。文本段与工具段保持模型产出的时间顺序，
// 避免把工具调用统一挤到末尾（agent loop 通常是：先调工具→后总结文本）。
export type Segment =
  | { kind: 'attachment'; attachment: AttachmentData }
  | { kind: 'text'; text: string }
  | { kind: 'tool-group'; steps: ToolCallStep[] }
  | {
      kind: 'approval-request'
      approvalId: string
      toolCallId: string
      toolName: string
      args: unknown
    }

export interface RenderItem {
  id: string
  role: 'user' | 'assistant'
  segments: Segment[]
}

const isBlockedOutput = (output: unknown): output is { status: 'blocked'; reason: string; ticketId: string; message?: string } => {
  if (output === null || typeof output !== 'object') return false
  const r = output as Record<string, unknown>
  return r.status === 'blocked' && r.reason === 'requires_external_approval' && typeof r.ticketId === 'string'
}

export const buildRenderItems = (messages: unknown[]): RenderItem[] => {
  const items: RenderItem[] = []

  for (const raw of messages) {
    const msg = raw as { id?: string; role?: string; parts?: unknown[] }
    const id = msg.id || `${Date.now()}-${Math.random()}`
    const role = msg.role === 'user' ? 'user' : 'assistant'
    const parts = (msg.parts || []) as Array<{
      type: string
      text?: string
      toolCallId?: string
      toolName?: string
      input?: unknown
      output?: unknown
      errorText?: string
      state?: string
      approval?: { id: string }
      data?: unknown
    }>

    const segments: Segment[] = []
    let textBuf = ''
    const flushText = () => {
      if (textBuf) {
        segments.push({ kind: 'text', text: textBuf })
        textBuf = ''
      }
    }

    for (const p of parts) {
      if (p.type === 'text' && typeof p.text === 'string') {
        textBuf += p.text
        continue
      }

      // 用户消息内嵌的文件卡片：data-attachment part（convertToModelMessages
      // 会静默丢弃 data-* parts，纯展示用途）。畸形数据跳过，不崩消息列表。
      if (p.type === 'data-attachment') {
        const d = p.data
        if (d !== null && typeof d === 'object') {
          const a = d as Record<string, unknown>
          if (typeof a.filename === 'string' && a.filename.length > 0) {
            flushText()
            segments.push({
              kind: 'attachment',
              attachment: {
                filename: a.filename,
                docId: typeof a.docId === 'string' ? a.docId : '',
                key: typeof a.key === 'string' ? a.key : '',
                fileType: typeof a.fileType === 'string' && a.fileType.length > 0 ? a.fileType : 'FILE',
              },
            })
          }
        }
        continue
      }

      // AI SDK 6 L2 软确认门：工具处于 approval-requested 状态，等待用户确认。
      if (p.state === 'approval-requested' && p.approval?.id && p.toolCallId) {
        flushText()
        segments.push({
          kind: 'approval-request',
          approvalId: p.approval.id,
          toolCallId: p.toolCallId,
          toolName: p.toolName || p.type.replace(/^tool-/, ''),
          args: p.input,
        })
        continue
      }

      // AI SDK 6: 工具调用是单个 part，type 为 `tool-${name}` 或 `dynamic-tool`，含 toolCallId。
      // 字段 input/output/state；连续的工具 part 归入同一个 tool-group，保持时间顺序。
      // 见 node_modules/ai/dist/index.d.ts UIToolInvocation (line 1720) / ToolUIPart (line 1810)。
      if (p.toolCallId && (p.type === 'dynamic-tool' || p.type.startsWith('tool-'))) {
        flushText()
        const completed = p.state === 'output-available'
        // AI SDK 6 失败终态：state='output-error' 携带 errorText。此前被并入
        // running 会导致失败的工具永远转圈，现映射为 failed 终态。
        const failed = p.state === 'output-error'
        const step: ToolCallStep = {
          toolCallId: p.toolCallId,
          toolName: p.toolName || p.type.replace(/^tool-/, ''),
          args: p.input,
          result: completed ? p.output : undefined,
          errorText: failed && typeof p.errorText === 'string' ? p.errorText : undefined,
          status: completed ? 'completed' : failed ? 'failed' : 'running',
        }

        // L3 外部审批门：工具 execute 返回 { status: 'blocked', reason: 'requires_external_approval', ticketId }
        if (completed && isBlockedOutput(p.output)) {
          step.blocked = {
            reason: p.output.reason,
            ticketId: p.output.ticketId,
            message: p.output.message,
          }
        }

        const last = segments[segments.length - 1]
        if (last && last.kind === 'tool-group') {
          last.steps.push(step)
        } else {
          segments.push({ kind: 'tool-group', steps: [step] })
        }
      }
    }
    flushText()

    if (role === 'assistant') {
      items.push({ id, role, segments })
    } else if (segments.length > 0) {
      // 用户消息保留文本段与附件卡片段（data-attachment parts）
      items.push({ id, role, segments: segments.filter((s) => s.kind === 'text' || s.kind === 'attachment') })
    }
  }
  return items
}
