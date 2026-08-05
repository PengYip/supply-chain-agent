import React, { useRef, useEffect } from 'react'
import {
  PanelRight,
  ChevronLeft,
  Bot,
  Sparkles,
  Play,
} from 'lucide-react'
import { MessageItem, EmptyStateHint } from './MessageItem'
import { Composer } from './Composer'
import { ModeSelector } from './ModeSelector'
import { type Task, type TaskMode, type ActionType } from '../data/mock'
import clsx from 'clsx'

interface ConversationViewProps {
  task: Task | null
  input: string
  onInputChange: (value: string) => void
  onSend: () => void
  mode: TaskMode
  onModeChange: (mode: TaskMode) => void
  streamingMessageId: string | null
  rightPanelOpen: boolean
  onToggleRightPanel: () => void
  onAction: (label: string, type: ActionType) => void
  onConfirmPlan: (planId: string) => void
  onPrompt: (prompt: string) => void
  showHitlDemo?: boolean
  onStartHitlDemo?: () => void
}

export const ConversationView: React.FC<ConversationViewProps> = ({
  task,
  input,
  onInputChange,
  onSend,
  mode,
  onModeChange,
  streamingMessageId,
  rightPanelOpen,
  onToggleRightPanel,
  onAction,
  onConfirmPlan,
  onPrompt,
  showHitlDemo,
  onStartHitlDemo,
}) => {
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [task?.messages.length, streamingMessageId])

  return (
    <div className="flex-1 flex flex-col min-w-0 bg-bgGray h-full">
      {/* Top strip */}
      <div className="h-14 bg-white border-b border-borderGray flex items-center justify-between px-4 shrink-0">
        <div className="flex items-center gap-3 min-w-0">
          <button
            onClick={() => {}}
            className="lg:hidden p-1.5 rounded-md hover:bg-bgGray text-textGray"
          >
            <ChevronLeft className="w-5 h-5" />
          </button>
          {task ? (
            <>
              <div className="w-8 h-8 rounded-lg bg-deepSea/10 flex items-center justify-center shrink-0">
                <Bot className="w-4 h-4 text-deepSea" />
              </div>
              <div className="min-w-0">
                <div className="text-sm font-medium text-textDark truncate">{task.title}</div>
                <div className="text-xs text-textGray flex items-center gap-2">
                  <span>{task.businessNo}</span>
                  <span className={clsx(
                    'px-1 rounded text-[10px]',
                    task.status === '进行中' ? 'bg-steelBlue/10 text-steelBlue' : 'bg-success/10 text-success'
                  )}>{task.status}</span>
                </div>
              </div>
            </>
          ) : (
            <div className="text-sm font-medium text-textGray flex items-center gap-2">
              <Sparkles className="w-4 h-4 text-amber" /> 新建任务
            </div>
          )}
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {showHitlDemo && task && (
            <button
              onClick={onStartHitlDemo}
              className="hidden sm:flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-medium bg-amber/10 text-amber border border-amber/20 hover:bg-amber/20 transition-colors"
            >
              <Play className="w-3.5 h-3.5" />
              演示：对账 + 付款 HITL 全流程
            </button>
          )}
          <ModeSelector mode={mode} onChange={onModeChange} />
          <div className="w-px h-6 bg-borderGray mx-1 hidden sm:block" />
          <button
            onClick={onToggleRightPanel}
            className={clsx(
              'hidden sm:flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-medium transition-colors',
              rightPanelOpen ? 'bg-deepSea/10 text-deepSea' : 'bg-bgGray text-textGray hover:text-textDark'
            )}
          >
            <PanelRight className="w-4 h-4" />
            {rightPanelOpen ? '收起结果' : '查看结果'}
          </button>
        </div>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-auto p-4">
        {task ? (
          <div className="max-w-3xl mx-auto space-y-5">
            {(task?.messages || []).map((msg) => (
              <MessageItem
                key={msg.id}
                message={msg}
                onAction={onAction}
                onConfirmPlan={onConfirmPlan}
                streamingMessageId={streamingMessageId}
              />
            ))}
            <div ref={bottomRef} />
          </div>
        ) : (
          <EmptyStateHint onPrompt={onPrompt} />
        )}
      </div>

      {/* Composer */}
      <Composer
        value={input}
        onChange={onInputChange}
        onSend={onSend}
        mode={mode}
        onModeChange={onModeChange}
        disabled={!!streamingMessageId}
        quickActions={task ? [] : ['查合同 HT-2024 执行情况', '帮我发起本月对账', '挂接提单到合同 HT-2024', '合同 HT-2024 尾款付款审批']}
        onQuickAction={onPrompt}
      />
    </div>
  )
}
