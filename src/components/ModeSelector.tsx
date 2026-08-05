import React from 'react'
import { Search, FileQuestion, Zap } from 'lucide-react'
import { type TaskMode } from '../data/mock'
import clsx from 'clsx'

interface ModeSelectorProps {
  mode: TaskMode
  onChange: (mode: TaskMode) => void
  size?: 'sm' | 'md'
}

const MODES: { key: TaskMode; label: string; badge: string; icon: typeof Search; color: string }[] = [
  { key: 'ask', label: '查一查', badge: '只读，安全', icon: Search, color: 'success' },
  { key: 'plan', label: '想一想', badge: '需确认', icon: FileQuestion, color: 'warning' },
  { key: 'execute', label: '做一做', badge: '直接执行', icon: Zap, color: 'steelBlue' },
]

export const ModeSelector: React.FC<ModeSelectorProps> = ({ mode, onChange, size = 'md' }) => {
  return (
    <div className={clsx(
      'inline-flex items-center p-1 rounded-lg bg-bgGray border border-borderGray',
      size === 'sm' ? 'gap-0.5' : 'gap-1'
    )}>
      {MODES.map((m) => {
        const Icon = m.icon
        const active = mode === m.key
        const colorClass = active
          ? m.color === 'success'
            ? 'bg-success/10 text-success border-success/20'
            : m.color === 'warning'
            ? 'bg-warning/10 text-warning border-warning/20'
            : 'bg-steelBlue/10 text-steelBlue border-steelBlue/20'
          : 'text-textGray hover:text-textDark hover:bg-white'

        return (
          <button
            key={m.key}
            onClick={() => onChange(m.key)}
            className={clsx(
              'relative flex items-center gap-1.5 rounded-md border transition-all',
              size === 'sm' ? 'px-2 py-1 text-xs' : 'px-2.5 py-1.5 text-sm',
              active ? 'border shadow-sm font-medium' : 'border-transparent',
              colorClass
            )}
          >
            <Icon className={size === 'sm' ? 'w-3 h-3' : 'w-3.5 h-3.5'} />
            <span>{m.label}</span>
            {active && (
              <span className={clsx(
                'ml-1 px-1 rounded text-[10px]',
                m.color === 'success' ? 'bg-success/20 text-success'
                : m.color === 'warning' ? 'bg-warning/20 text-warning'
                : 'bg-steelBlue/20 text-steelBlue'
              )}>
                {m.badge}
              </span>
            )}
          </button>
        )
      })}
    </div>
  )
}
