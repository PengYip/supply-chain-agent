import React, { useState } from 'react'
import { ChevronDown, ChevronUp, CheckCircle2, AlertCircle, RefreshCw, Terminal } from 'lucide-react'
import { type ThinkingStep } from '../data/mock'

interface ToolStepsProps {
  steps: ThinkingStep[]
  defaultOpen?: boolean
  title?: string
}

const StepIcon: React.FC<{ status: ThinkingStep['status'] }> = ({ status }) => {
  if (status === 'success') return <CheckCircle2 className="w-3.5 h-3.5 text-success" />
  if (status === 'retry') return <AlertCircle className="w-3.5 h-3.5 text-warning" />
  return <RefreshCw className="w-3.5 h-3.5 text-steelBlue animate-spin" />
}

export const ToolSteps: React.FC<ToolStepsProps> = ({ steps, defaultOpen = false, title = '调用工具' }) => {
  const [open, setOpen] = useState(defaultOpen)

  const successCount = steps.filter((s) => s.status === 'success').length
  const runningCount = steps.filter((s) => s.status === 'running').length

  return (
    <div className="mt-3 rounded-lg border border-borderGray bg-bgGray overflow-hidden">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center justify-between px-3 py-2 text-xs hover:bg-white/50 transition-colors"
      >
        <div className="flex items-center gap-2">
          <Terminal className="w-3.5 h-3.5 text-textGray" />
          <span className="font-medium text-textDark">{title}</span>
          <span className="text-textGray">
            {runningCount > 0 ? `执行中 ${successCount}/${steps.length}` : `已完成 ${successCount}/${steps.length}`}
          </span>
        </div>
        {open ? <ChevronUp className="w-3.5 h-3.5 text-textGray" /> : <ChevronDown className="w-3.5 h-3.5 text-textGray" />}
      </button>

      {open && (
        <div className="px-3 pb-3 space-y-2 border-t border-borderGray/50 pt-2">
          {steps.map((step, idx) => (
            <div key={step.id} className="relative pl-5">
              {idx !== steps.length - 1 && (
                <div className="absolute left-[7px] top-5 bottom-[-10px] w-px bg-borderGray" />
              )}
              <div className="absolute left-0 top-1">
                <StepIcon status={step.status} />
              </div>
              <div className="text-xs">
                <div className="flex items-center justify-between">
                  <span className="font-medium text-textDark">{step.title}</span>
                  <span className="text-textGray tabular-nums">{step.duration}ms</span>
                </div>
                <div className="mt-0.5 font-mono text-[11px] text-textGray bg-white/60 rounded px-1.5 py-1 border border-borderGray/50">
                  <span className="text-steelBlue">{step.tool}</span>
                  <span className="mx-1.5 text-borderGray">|</span>
                  <span>{step.params}</span>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
