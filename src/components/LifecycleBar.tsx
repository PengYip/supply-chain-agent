import React from 'react'
import { CheckCircle2, Circle, FileText, Calculator, ShieldCheck, Truck, ShoppingCart, AlertCircle } from 'lucide-react'
import clsx from 'clsx'

interface LifecycleBarProps {
  stages: string[]
  currentStage: number
  compact?: boolean
}

const STAGE_ICONS: Record<string, React.ReactNode> = {
  '签约': <FileText className="w-3 h-3" />,
  '履约': <CheckCircle2 className="w-3 h-3" />,
  '发货': <Truck className="w-3 h-3" />,
  '结算': <Calculator className="w-3 h-3" />,
  '付款': <Calculator className="w-3 h-3" />,
  '归档': <FileText className="w-3 h-3" />,
  '发起对账': <Calculator className="w-3 h-3" />,
  '差异核对': <AlertCircle className="w-3 h-3" />,
  '确认': <CheckCircle2 className="w-3 h-3" />,
  '开票': <FileText className="w-3 h-3" />,
  '收款': <Calculator className="w-3 h-3" />,
  '建仓': <ShieldCheck className="w-3 h-3" />,
  '盯市': <AlertCircle className="w-3 h-3" />,
  '预警': <AlertCircle className="w-3 h-3" />,
  '平仓': <CheckCircle2 className="w-3 h-3" />,
  '复盘': <FileText className="w-3 h-3" />,
  '入库': <Truck className="w-3 h-3" />,
  '在库': <CheckCircle2 className="w-3 h-3" />,
  '提货': <Truck className="w-3 h-3" />,
  '出库': <Truck className="w-3 h-3" />,
  '请购': <ShoppingCart className="w-3 h-3" />,
  '比价': <Calculator className="w-3 h-3" />,
  '合同': <FileText className="w-3 h-3" />,
  '订单': <FileText className="w-3 h-3" />,
  '到货': <Truck className="w-3 h-3" />,
  '对账': <Calculator className="w-3 h-3" />,
}

export const LifecycleBar: React.FC<LifecycleBarProps> = ({ stages, currentStage, compact = false }) => {
  return (
    <div className="w-full">
      <div className="flex items-center">
        {stages.map((stage, idx) => {
          const isCompleted = idx < currentStage
          const isCurrent = idx === currentStage
          const isPending = idx > currentStage
          const isLast = idx === stages.length - 1

          return (
            <React.Fragment key={stage}>
              <div className={clsx('flex flex-col items-center', compact ? 'flex-1 min-w-0' : 'flex-1 min-w-0')}>
                <div
                  className={clsx(
                    'rounded-full flex items-center justify-center border-2 transition-colors',
                    compact ? 'w-7 h-7' : 'w-9 h-9',
                    isCompleted ? 'bg-success border-success text-white' : '',
                    isCurrent ? 'bg-amber border-amber text-white' : '',
                    isPending ? 'bg-white border-borderGray text-textGray' : ''
                  )}
                >
                  {isCompleted ? <CheckCircle2 className={compact ? 'w-3.5 h-3.5' : 'w-4 h-4'} /> : (STAGE_ICONS[stage] || <Circle className="w-3 h-3" />)}
                </div>
                <span
                  className={clsx(
                    'mt-1.5 text-center font-medium truncate w-full px-1',
                    compact ? 'text-[10px]' : 'text-xs',
                    isCompleted ? 'text-success' : isCurrent ? 'text-amber' : 'text-textGray'
                  )}
                >
                  {stage}
                </span>
              </div>
              {!isLast && (
                <div className={clsx('h-0.5 flex-1 mx-1', idx < currentStage ? 'bg-success' : 'bg-borderGray')} />
              )}
            </React.Fragment>
          )
        })}
      </div>
    </div>
  )
}

export const StageBadge: React.FC<{ stageName: string }> = ({ stageName }) => (
  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-amber/10 text-amber text-xs font-medium border border-amber/20">
    <AlertCircle className="w-3 h-3" /> 当前阶段：{stageName}
  </span>
)
