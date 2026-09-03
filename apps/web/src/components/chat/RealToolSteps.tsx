import React, { useEffect, useRef, useState } from 'react'
import {
  AlertCircle,
  BookOpen,
  CheckCircle2,
  Loader2,
  Database,
  Wrench,
  ShieldAlert,
  ArrowDown,
  ChevronDown,
} from 'lucide-react'
import {
  type ToolCallStep,
  formatArgs,
  parseEscalateArgs,
  escalateCategoryLabel,
  severityLabel,
  severityBadgeClass,
} from '../../utils/realChatUtils'
import clsx from 'clsx'
import { DocumentReviewCard, type DocumentReviewPayload } from '../DocumentReviewCard'
import { MarkdownContent } from './MarkdownContent'
import { SettlementEvidenceCard, parseSettlementEvidence } from './SettlementEvidenceCard'
import { toolLabel } from '../../lib/toolLabels'

/** 工具调用渲染族（2026-08-31 从 RealMessageItem 原样抽取为共享组件）：
 *  主聊天与只读分享页共用，保证工具卡片的折叠行、展开详情、通用结果框、
 *  技能卡、L3 阻断卡在各处观感一致。除新增 ToolGroupCard 容器与
 *  RealToolStep 的 readOnly 开关外，组件体与抽取前的内联版本逐字相同。
 *
 *  readOnly 仅供免登录的只读宿主（分享页）使用：present_document_review 的
 *  富复核卡（DocumentReviewCard）挂载时会向需登录的复核接口拉取快照、
 *  且携带字段更正/确认等编辑交互，不能出现在公开页面 —— readOnly=true 时
 *  跳过该分支，回落到通用结果框（文本/JSON 格式化，纯展示）。默认
 *  undefined/false，主聊天路径与抽取前完全一致。 */

/** 折叠态单行摘要：只取首行并去掉首尾空白（超宽由 CSS truncate 截断）。 */
const firstSummaryLine = (s: string): string => (s.split('\n')[0] ?? '').trim()

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
    // gather_settlement_evidence 成功态的单行摘要(详细卡片见专属分支)
    if (r.status === 'ok' && typeof r.contractNo === 'string' && Array.isArray(r.flows)) {
      const settleCount = Array.isArray(r.settlements) ? r.settlements.length : 0
      return `合同 ${r.contractNo} · ${r.flows.length} 行执行流水 · ${settleCount} 笔历史结算`
    }
    return JSON.stringify(result)
  }
  return String(result)
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
            {esc ? '人工复核工单' : '操作已阻断'} · {toolLabel(toolName)}
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

/** Generic tool-result box, collapsed to a 2-line preview by default. The
 *  展开/收起 toggle is only rendered when the clamped text actually overflows
 *  (detected by measuring scrollHeight vs clientHeight while line-clamped, so
 *  short one-line results stay clean). Expanded view preserves whitespace,
 *  breaks long unbroken JSON strings, and scrolls past ~16rem instead of
 *  stretching the chat bubble. When nested inside an expanded tool-step card
 *  pass initiallyExpanded so it starts fully expanded (no double collapse). */
const ToolResultBox: React.FC<{ result: unknown; initiallyExpanded?: boolean }> = ({ result, initiallyExpanded = false }) => {
  const [expanded, setExpanded] = useState(initiallyExpanded)
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
  /** 只读宿主（分享页）传 true：不渲染 DocumentReviewCard（见文件头说明），
   *  其余折叠/展开交互保持可用。 */
  readOnly?: boolean
}> = ({ step, onOpenBindings, readOnly }) => {
  // 折叠态记忆在组件内 state（不持久化）：默认收起为单行「工具名 + 状态 +
  // 摘要」，点击整行切换展开；展开后保留完整输入/输出的既有渲染。
  const [open, setOpen] = useState(false)
  const isCompleted = step.status === 'completed'
  const isFailed = step.status === 'failed'

  // L3 阻断工单是面向人工的高优先级触达信息：不参与折叠，保持完整形态。
  if (step.blocked) {
    return (
      <div className="flex items-start gap-3 py-2">
        <div className="relative flex flex-col items-center">
          <div
            className={clsx(
              'w-5 h-5 rounded-full flex items-center justify-center border-2 border-white',
              isCompleted ? 'bg-success text-white' : 'bg-white text-ink-soft border-line',
            )}
          >
            {isCompleted ? <CheckCircle2 className="w-3 h-3" /> : <Loader2 className="w-3 h-3 animate-spin" />}
          </div>
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-medium text-ink shrink-0" title={step.toolName}>
              {toolLabel(step.toolName)}
            </span>
            <span className="hidden sm:inline text-[10px] font-mono text-ink-soft/70 shrink-0">
              {step.toolName}
            </span>
            <span className="text-[11px] font-mono text-primary-500 bg-white/50 rounded px-1.5 py-0.5 border border-line/50 truncate max-w-full">
              {formatArgs(step.args)}
            </span>
          </div>
          <BlockedCard toolName={step.toolName} args={step.args} blocked={step.blocked} />
        </div>
      </div>
    )
  }

  // `present_document_review` produces a rich 5-dimension review payload. When
  // present (and not an error shape), render the dedicated card instead of the
  // generic one-line result box. The error shape ({status:'error'}) and any
  // other output fall back to the generic box below.
  const reviewPayload = readOnly ? null : isReviewResult(step.toolName, step.result)
  // load_skill 成功结果走专属 SkillCard(2026-08-28 Skill 化); 失败回落通用框。
  const skillPayload = isSkillPayload(step.toolName, step.result)
  // gather_settlement_evidence 成功态走结算取证卡(结构化证据 + 溯源入口);
  // error 形状与只读宿主(分享页, 无复核弹窗总线)回落通用框。
  const settlementPayload = readOnly ? null : parseSettlementEvidence(step.toolName, step.result)

  // 折叠态状态图标与文案：运行中 / 完成 / 失败
  const statusIcon = isCompleted ? (
    <CheckCircle2 className="w-3.5 h-3.5 text-success" />
  ) : isFailed ? (
    <AlertCircle className="w-3.5 h-3.5 text-danger" />
  ) : (
    <Loader2 className="w-3.5 h-3.5 animate-spin text-ink-soft" />
  )
  const statusLabel = isCompleted ? '完成' : isFailed ? '失败' : '运行中'
  const statusLabelClass = isCompleted ? 'text-success' : isFailed ? 'text-danger' : 'text-ink-soft'

  // 单行摘要：完成取输出首行，失败取错误文本，运行中取输入参数
  const summary = isCompleted
    ? firstSummaryLine(formatResult(step.result)) || '无返回数据'
    : isFailed
      ? step.errorText || '执行失败'
      : formatArgs(step.args) || '执行中'

  return (
    <div className="py-1.5">
      {/* 折叠头：整行可点击切换，箭头随展开态旋转 */}
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="w-full text-left flex items-center gap-2 rounded-md px-1 -mx-1 py-1 transition-colors hover:bg-white/60"
      >
        <span className="shrink-0 flex items-center">{statusIcon}</span>
        <span className="text-sm font-medium text-ink shrink-0" title={step.toolName}>
          {toolLabel(step.toolName)}
        </span>
        <span className="hidden sm:inline text-[10px] font-mono text-ink-soft/70 shrink-0">
          {step.toolName}
        </span>
        <span className={clsx('text-[11px] shrink-0', statusLabelClass)}>{statusLabel}</span>
        <span className="text-[11px] text-ink-soft truncate min-w-0 flex-1">{summary}</span>
        <ChevronDown className={clsx('w-3.5 h-3.5 text-ink-soft transition-transform shrink-0', open && 'rotate-180')} />
      </button>
      {open && (
        <div className="mt-1 pl-[22px] space-y-1.5">
          {formatArgs(step.args) && (
            <div className="text-[11px] font-mono text-primary-500 bg-white/50 rounded px-1.5 py-0.5 border border-line/50 break-all">
              {formatArgs(step.args)}
            </div>
          )}
          {isCompleted && step.result !== undefined && (
            skillPayload ? (
              <SkillCard payload={skillPayload} />
            ) : reviewPayload ? (
              <DocumentReviewCard payload={reviewPayload} onOpenBindings={onOpenBindings} />
            ) : settlementPayload ? (
              <SettlementEvidenceCard payload={settlementPayload} />
            ) : (
              <ToolResultBox result={step.result} initiallyExpanded />
            )
          )}
          {isFailed && step.errorText && (
            <div className="text-[11px] text-danger bg-danger/5 border border-danger/20 rounded px-2 py-1.5 break-all">
              {step.errorText}
            </div>
          )}
          {!isCompleted && !isFailed && (
            <div className="text-[11px] text-ink-soft flex items-center gap-1">
              <Loader2 className="w-3 h-3 animate-spin" /> 等待工具返回...
            </div>
          )}
        </div>
      )}
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

/** 工具组容器：连续工具调用归一组的外框（2026-08-31 随本次抽取从
 *  RealMessageItem.renderSegments 的内联 JSX 提为组件，标记结构逐字相同）。
 *  readOnly 透传给每个 RealToolStep（见其 props 说明）。 */
export const ToolGroupCard: React.FC<{
  steps: ToolCallStep[]
  onOpenBindings?: (docId: string) => void
  readOnly?: boolean
}> = ({ steps, onOpenBindings, readOnly }) => (
  <div className="rounded-lg border border-line bg-surface/50 overflow-hidden mt-2">
    <div className="px-3 py-2 border-b border-line bg-primary/5 flex items-center gap-2">
      <Wrench className="w-4 h-4 text-primary-500" />
      <span className="text-xs font-medium text-ink">工具调用</span>
    </div>
    <div className="px-3 divide-y divide-line/50">
      {steps.map((step) => (
        <RealToolStep key={step.toolCallId} step={step} onOpenBindings={onOpenBindings} readOnly={readOnly} />
      ))}
    </div>
  </div>
)
