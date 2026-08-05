import React, { useState, useRef, useEffect } from 'react'
import { Send, Paperclip, AtSign, Zap, Search, FileQuestion } from 'lucide-react'
import { ModeSelector } from './ModeSelector'
import { Button } from './ui/Card'
import { type TaskMode } from '../data/mock'
import clsx from 'clsx'

interface ComposerProps {
  value: string
  onChange: (value: string) => void
  onSend: () => void
  mode: TaskMode
  onModeChange: (mode: TaskMode) => void
  disabled?: boolean
  quickActions?: string[]
  onQuickAction?: (prompt: string) => void
}

const MENTION_ITEMS = [
  { id: 'HT-2024', label: '合同 HT-2024', type: '合同' },
  { id: 'PO-202408', label: '订单 PO-202408', type: '订单' },
  { id: 'BL-20240815-001', label: '提单 BL-20240815-001', type: '单据' },
  { id: 'DD-202408', label: '对账 DD-202408', type: '对账' },
  { id: 'SO-202407', label: '订单 SO-202407', type: '订单' },
]

export const Composer: React.FC<ComposerProps> = ({
  value,
  onChange,
  onSend,
  mode,
  onModeChange,
  disabled,
  quickActions,
  onQuickAction,
}) => {
  const [showMentions, setShowMentions] = useState(false)
  const [mentionQuery, setMentionQuery] = useState('')
  const [cursorPosition, setCursorPosition] = useState(0)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const filteredMentions = MENTION_ITEMS.filter(
    (item) => item.label.toLowerCase().includes(mentionQuery.toLowerCase()) || item.id.toLowerCase().includes(mentionQuery.toLowerCase())
  )

  useEffect(() => {
    const lastAt = value.lastIndexOf('@', cursorPosition)
    if (lastAt !== -1 && cursorPosition > lastAt && !value.slice(lastAt + 1, cursorPosition).includes(' ')) {
      setMentionQuery(value.slice(lastAt + 1, cursorPosition))
      setShowMentions(true)
    } else {
      setShowMentions(false)
    }
  }, [value, cursorPosition])

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    onChange(e.target.value)
    setCursorPosition(e.target.selectionStart)
  }

  const insertMention = (item: (typeof MENTION_ITEMS)[0]) => {
    const lastAt = value.lastIndexOf('@', cursorPosition)
    if (lastAt === -1) return
    const before = value.slice(0, lastAt)
    const after = value.slice(cursorPosition)
    const newValue = `${before}${item.label} ${after}`
    onChange(newValue)
    setShowMentions(false)
    setTimeout(() => {
      textareaRef.current?.focus()
      const pos = before.length + item.label.length + 1
      textareaRef.current?.setSelectionRange(pos, pos)
    }, 0)
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey && !showMentions) {
      e.preventDefault()
      onSend()
    }
  }

  return (
    <div className="bg-white border-t border-borderGray p-3">
      {quickActions && quickActions.length > 0 && (
        <div className="flex flex-wrap gap-2 mb-3">
          {quickActions.map((action) => (
            <button
              key={action}
              onClick={() => onQuickAction?.(action)}
              className="px-3 py-1.5 rounded-full border border-borderGray bg-bgGray text-xs text-textGray hover:border-amber hover:text-amber transition-colors"
            >
              {action}
            </button>
          ))}
        </div>
      )}

      <div className="relative">
        {showMentions && (
          <div className="absolute bottom-full left-0 mb-2 w-64 bg-white rounded-lg shadow-xl border border-borderGray overflow-hidden z-20 animate-fade-in">
            <div className="px-3 py-2 text-xs text-textGray border-b border-borderGray bg-bgGray flex items-center gap-1">
              <AtSign className="w-3 h-3" /> 引用业务对象
            </div>
            {filteredMentions.map((item) => (
              <button
                key={item.id}
                onClick={() => insertMention(item)}
                className="w-full text-left px-3 py-2 text-sm hover:bg-bgGray transition-colors flex items-center justify-between"
              >
                <span className="text-textDark">{item.label}</span>
                <span className="text-xs text-textGray">{item.type}</span>
              </button>
            ))}
            {filteredMentions.length === 0 && (
              <div className="px-3 py-2 text-xs text-textGray">未匹配到对象</div>
            )}
          </div>
        )}

        <div className="relative flex items-end gap-2 rounded-xl border border-borderGray bg-white p-2 focus-within:border-steelBlue focus-within:ring-1 focus-within:ring-steelBlue/10 transition-all">
          <textarea
            ref={textareaRef}
            value={value}
            onChange={handleChange}
            onKeyDown={handleKeyDown}
            disabled={disabled}
            placeholder="输入指令，例如：帮我查一下合同 HT-2024 的执行情况。使用 @ 引用业务对象。"
            rows={1}
            className="flex-1 min-h-[40px] max-h-[120px] resize-none border-0 p-2 text-sm focus:outline-none bg-transparent"
            style={{ height: 'auto' }}
            onInput={(e) => {
              const target = e.target as HTMLTextAreaElement
              target.style.height = 'auto'
              target.style.height = `${Math.min(target.scrollHeight, 120)}px`
            }}
          />

          <div className="flex items-center gap-1 shrink-0">
            <button
              onClick={() => textareaRef.current?.focus()}
              className="p-2 rounded-lg text-textGray hover:bg-bgGray transition-colors"
              title="引用业务对象"
            >
              <AtSign className="w-4 h-4" />
            </button>
            <button
              className="p-2 rounded-lg text-textGray hover:bg-bgGray transition-colors"
              title="上传附件"
              onClick={() => {}}
            >
              <Paperclip className="w-4 h-4" />
            </button>
            <div className="w-px h-5 bg-borderGray mx-1" />
            <Button
              onClick={onSend}
              disabled={disabled || !value.trim()}
              variant="primary"
              size="sm"
              className="gap-1"
            >
              <Send className="w-4 h-4" />
              发送
            </Button>
          </div>
        </div>

        <div className="flex items-center justify-between mt-2 px-1">
          <div className="flex items-center gap-2">
            <ModeSelector mode={mode} onChange={onModeChange} size="sm" />
            <span className={clsx(
              'text-xs flex items-center gap-1',
              mode === 'ask' ? 'text-success' : mode === 'plan' ? 'text-warning' : 'text-steelBlue'
            )}>
              {mode === 'ask' && <><Search className="w-3 h-3" /> 只读模式，不会修改业务数据</>}
              {mode === 'plan' && <><FileQuestion className="w-3 h-3" /> 生成计划后需确认再执行</>}
              {mode === 'execute' && <><Zap className="w-3 h-3" /> 白名单操作，执行后自动生成变更记录</>}
            </span>
          </div>
          <div className="text-xs text-textGray">Enter 发送，Shift+Enter 换行</div>
        </div>
      </div>
    </div>
  )
}
