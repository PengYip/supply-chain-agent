import React from 'react'
import clsx from 'clsx'

export type RiskLevel = 'low' | 'medium' | 'high'

interface RiskMetricCardProps {
  label: string
  value: string | number
  unit?: string
  ratio?: number
  level?: RiskLevel
  hint?: string
}

const levelStyles: Record<RiskLevel, { bar: string; text: string }> = {
  low: { bar: 'bg-success', text: 'text-success' },
  medium: { bar: 'bg-warning', text: 'text-warning' },
  high: { bar: 'bg-danger', text: 'text-danger' },
}

export const RiskMetricCard: React.FC<RiskMetricCardProps> = ({
  label,
  value,
  unit,
  ratio = 0,
  level = 'low',
  hint,
}) => {
  const clampedRatio = Math.max(0, Math.min(1, ratio))
  const styles = levelStyles[level]

  return (
    <div className="rounded-xl border border-borderGray bg-white p-4">
      <div className="text-xs text-textGray">{label}</div>
      <div className="mt-1.5 flex items-baseline gap-1.5">
        <span className="text-2xl font-mono font-bold text-textDark">{value}</span>
        {unit && <span className="text-sm text-textGray">{unit}</span>}
      </div>
      <div className="mt-3">
        <div className="h-1 w-full bg-bgGray rounded-full overflow-hidden">
          <div
            className={clsx('h-full rounded-full transition-all duration-500', styles.bar)}
            style={{ width: `${clampedRatio * 100}%` }}
          />
        </div>
      </div>
      {hint && (
        <div className={clsx('mt-2 text-xs flex items-center gap-1', styles.text)}>
          <span className="w-1 h-1 rounded-full bg-current" />
          {hint}
        </div>
      )}
    </div>
  )
}
