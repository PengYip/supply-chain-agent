import React from 'react'
import { Bot, User, AlertCircle, Database, CheckCircle2, FileQuestion, Zap, Search, ArrowRight, Info } from 'lucide-react'
import { type ChatMessage, type ActionType } from '../data/mock'
import { ToolSteps } from './ToolSteps'
import { ArtifactRenderer } from './BusinessCards'
import { ApprovalCard } from './ApprovalCard'
import { ToolTagList } from './ui/ToolTag'
import { Button } from './ui/Card'
import clsx from 'clsx'

interface MessageItemProps {
  message: ChatMessage
  onAction: (label: string, type: ActionType) => void
  onConfirmPlan?: (planId: string) => void
  streamingMessageId?: string | null
}

const TraceableNumber: React.FC<{ children: React.ReactNode; source: string }> = ({ children, source }) => (
  <span className="border-b border-dotted border-steelBlue cursor-help text-textDark font-medium" title={`数据来源：${source}`}>
    {children}
  </span>
)

const PlanCardView: React.FC<{ plan: NonNullable<ChatMessage['plan']>; onConfirm?: () => void; hasActions?: boolean }> = ({ plan, onConfirm, hasActions }) => {
  const planTools = React.useMemo(() => [...new Set(plan.steps.map((s) => s.tool))], [plan])
  return (
    <div className="rounded-lg border border-warning/30 bg-warning/5 overflow-hidden">
      <div className="px-3 py-2 border-b border-warning/20 flex items-center gap-2">
        <FileQuestion className="w-4 h-4 text-warning" />
        <span className="text-sm font-medium text-textDark">{plan.title}</span>
        {plan.requiresApproval && (
          <span className="ml-auto text-xs px-1.5 py-0.5 rounded bg-warning/20 text-warning font-medium">需审批</span>
        )}
      </div>
      <div className="p-3 space-y-2">
        {plan.steps.map((step, idx) => (
          <div key={step.id} className="flex items-start gap-3">
            <div className="relative flex flex-col items-center">
              <div className={clsx(
                'w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-medium border-2 border-white',
                step.status === 'done' ? 'bg-success text-white' : 'bg-white text-textGray border-borderGray'
              )}>
                {step.status === 'done' ? <CheckCircle2 className="w-3 h-3" /> : idx + 1}
              </div>
              {idx !== plan.steps.length - 1 && <div className="w-px flex-1 min-h-[20px] bg-borderGray mt-1" />}
            </div>
            <div className="flex-1 pb-2">
              <div className="text-sm font-medium text-textDark">{step.description}</div>
              <div className="text-[11px] font-mono text-textGray mt-0.5 bg-white/50 rounded px-1.5 py-0.5 border border-borderGray/50 inline-block">
                {step.tool} | {step.params}
              </div>
            </div>
          </div>
        ))}
      </div>
      <div className="px-3 py-2 border-t border-warning/20 bg-white/50 space-y-2">
        <div className="flex items-center gap-2">
          <span className="text-[11px] text-textGray">涉及工具：</span>
          <ToolTagList tools={planTools} needsApproval={plan.requiresApproval} />
        </div>
        <div className="flex items-center justify-between">
          <div className="text-xs text-textGray flex items-center gap-1">
            <Database className="w-3 h-3" /> 涉及 {plan.businessObjects.join(' · ')}
          </div>
          {!hasActions && !plan.confirmed && onConfirm && (
          <Button variant="primary" size="sm" onClick={onConfirm}>
            确认执行
          </Button>
        )}
        {!hasActions && plan.confirmed && (
          <span className="text-xs text-success flex items-center gap-1">
            <CheckCircle2 className="w-3.5 h-3.5" /> 已确认
          </span>
        )}
        </div>
      </div>
    </div>
  )
}

export const MessageItem: React.FC<MessageItemProps> = ({
  message,
  onAction,
  onConfirmPlan,
  streamingMessageId,
}) => {
  const isUser = message.sender === 'user'
  const isSystem = message.sender === 'system'
  const isStreaming = streamingMessageId === message.id

  const toolNames = React.useMemo(() => {
    const names: string[] = []
    if (message.thinking) names.push(...message.thinking.map((s) => s.tool))
    if (message.plan) names.push(...message.plan.steps.map((s) => s.tool))
    return [...new Set(names)]
  }, [message])

  const needsApprovalToolTag = Boolean(message.approval || message.plan?.requiresApproval)

  const renderContent = (content: string) => {
    // Simple highlighting of business numbers for the main ask scenario
    if (content.includes('HT-2024') && content.includes('80%')) {
      return (
        <p>
          合同 <TraceableNumber source="合同管理系统">HT-2024</TraceableNumber> 对应订单
          <TraceableNumber source="ERP 订单系统"> 3 个</TraceableNumber>，其中
          <TraceableNumber source="ERP 订单系统"> 2 个已发货</TraceableNumber>，
          <TraceableNumber source="ERP 订单系统"> 1 个待付款</TraceableNumber>。已收款
          <TraceableNumber source="财务资金系统"> 80%</TraceableNumber>（
          <TraceableNumber source="财务资金系统">400 万</TraceableNumber> /
          <TraceableNumber source="合同管理系统">500 万</TraceableNumber>）。
        </p>
      )
    }
    return content
  }

  if (isSystem) {
    return (
      <div className="flex gap-3 animate-slide-up">
        <div className="w-8 h-8 rounded-lg bg-borderGray flex items-center justify-center shrink-0">
          <Info className="w-4 h-4 text-textGray" />
        </div>
        <div className="max-w-[85%] rounded-2xl px-4 py-3 text-sm leading-relaxed bg-bgGray border border-borderGray text-textGray rounded-tl-sm">
          {message.systemNote || message.content}
        </div>
      </div>
    )
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
          'max-w-[85%] rounded-2xl px-4 py-3 text-sm leading-relaxed shadow-sm',
          isUser ? 'bg-steelBlue text-white rounded-tr-sm' : 'bg-white border border-borderGray text-textDark rounded-tl-sm'
        )}
      >
        <div className="space-y-2">
          {isUser ? (
            <p>{message.content}</p>
          ) : (
            <>
              <div className="text-textDark">
                {renderContent(message.content)}
                {isStreaming && (
                  <span className="inline-flex ml-1 gap-0.5 align-middle">
                    <span className="w-1 h-1 rounded-full bg-textGray animate-pulse-dot" style={{ animationDelay: '0ms' }} />
                    <span className="w-1 h-1 rounded-full bg-textGray animate-pulse-dot" style={{ animationDelay: '200ms' }} />
                    <span className="w-1 h-1 rounded-full bg-textGray animate-pulse-dot" style={{ animationDelay: '400ms' }} />
                  </span>
                )}
              </div>

              {message.plan && (
                <PlanCardView
                  plan={message.plan}
                  onConfirm={message.plan.confirmed ? undefined : () => message.plan && onConfirmPlan?.(message.plan!.id)}
                  hasActions={!!message.actions?.length}
                />
              )}

              {message.artifacts && message.artifacts.length > 0 && (
                <div className="space-y-2">
                  {message.artifacts.map((artifact) => (
                    <ArtifactRenderer key={artifact.id} artifact={artifact} />
                  ))}
                </div>
              )}

              {message.approval && (
                <ApprovalCard
                  detail={message.approval}
                  tools={toolNames}
                  onClose={() => onAction('通过审批', 'approve')}
                  variant={message.approval.dutyNote ? 'readonly' : 'interactive'}
                />
              )}

              {message.uncertainty && (
                <div className="flex items-start gap-2 p-2.5 rounded-lg bg-warning/10 border border-warning/20 text-warning text-xs">
                  <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                  <span>{message.uncertainty}</span>
                </div>
              )}

              {message.thinking && message.thinking.length > 0 && (
                <ToolSteps
                  steps={message.thinking}
                  defaultOpen={isStreaming || message.thinking.some((s) => s.status === 'running')}
                />
              )}

              {message.sources && message.sources.length > 0 && (
                <div className="flex flex-wrap items-center gap-2 text-xs text-textGray pt-1">
                  <Database className="w-3 h-3" />
                  <span>来自：</span>
                  {message.sources.map((source) => (
                    <span key={source} className="px-1.5 py-0.5 rounded bg-bgGray border border-borderGray text-textGray">
                      {source}
                    </span>
                  ))}
                </div>
              )}

              {toolNames.length > 0 && (
                <div className="flex items-center gap-2 pt-1">
                  <span className="text-[11px] text-textGray">工具：</span>
                  <ToolTagList tools={toolNames} needsApproval={needsApprovalToolTag} />
                </div>
              )}

              {message.actions && message.actions.length > 0 && (
                <div className="flex flex-wrap gap-2 pt-1">
                  {message.actions.map((action) => (
                    <Button
                      key={action.label}
                      variant={
                        action.type === 'approve' || action.type === 'confirm' || action.type === 'archive'
                          ? 'primary'
                          : action.type === 'cancel' || action.type === 'retry' || action.type === 'defer'
                          ? 'ghost'
                          : 'secondary'
                      }
                      size="sm"
                      onClick={() => onAction(action.label, action.type)}
                    >
                      {(action.type === 'confirm' || action.type === 'archive') && <CheckCircle2 className="w-3.5 h-3.5 mr-1" />}
                      {action.label}
                    </Button>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}

export const EmptyStateHint: React.FC<{ onPrompt: (prompt: string) => void }> = ({ onPrompt }) => {
  return (
    <div className="flex-1 flex flex-col items-center justify-center text-center px-6 py-12">
      <div className="w-12 h-12 rounded-2xl bg-deepSea/10 flex items-center justify-center mb-4">
        <Bot className="w-6 h-6 text-deepSea" />
      </div>
      <h3 className="text-base font-medium text-textDark mb-2">开始一个新的任务</h3>
      <p className="text-sm text-textGray mb-6 max-w-md">
        选择任务模式，输入业务指令。AI 将通过工具调用真实业务系统，所有数字均可追溯。
      </p>
      <div className="flex items-center gap-6 text-sm text-textGray mb-6">
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 rounded-full bg-success/10 flex items-center justify-center"><Search className="w-3.5 h-3.5 text-success" /></div>
          <span>查一查：只读查询</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 rounded-full bg-warning/10 flex items-center justify-center"><FileQuestion className="w-3.5 h-3.5 text-warning" /></div>
          <span>想一想：计划确认</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 rounded-full bg-steelBlue/10 flex items-center justify-center"><Zap className="w-3.5 h-3.5 text-steelBlue" /></div>
          <span>做一做：直接执行</span>
        </div>
      </div>
      <div className="flex flex-wrap justify-center gap-2">
        {['查合同 HT-2024 执行情况', '帮我发起本月对账', '挂接提单到合同 HT-2024', '合同 HT-2024 尾款付款审批'].map((prompt) => (
          <button
            key={prompt}
            onClick={() => onPrompt(prompt)}
            className="flex items-center gap-1 px-3 py-1.5 rounded-full border border-borderGray bg-white text-sm text-textGray hover:border-amber hover:text-amber transition-colors"
          >
            <ArrowRight className="w-3 h-3" /> {prompt}
          </button>
        ))}
      </div>
    </div>
  )
}
