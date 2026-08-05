import React from 'react'
import clsx from 'clsx'

interface ToolTagProps {
  name: string
  needsApproval?: boolean
  className?: string
}

export const ToolTag: React.FC<ToolTagProps> = ({ name, needsApproval, className }) => {
  return (
    <span
      className={clsx(
        'inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-[11px] font-mono',
        needsApproval
          ? 'bg-warning/10 text-warning border border-warning/20'
          : 'bg-bgGray text-textDark border border-borderGray',
        className
      )}
    >
      <span
        className={clsx(
          'w-1.5 h-1.5 rounded-full',
          needsApproval ? 'bg-warning' : 'bg-steelBlue'
        )}
      />
      {name}
    </span>
  )
}

interface ToolTagListProps {
  tools: string[]
  needsApproval?: boolean
  className?: string
}

export const ToolTagList: React.FC<ToolTagListProps> = ({ tools, needsApproval, className }) => {
  if (!tools.length) return null
  return (
    <div className={clsx('flex flex-wrap items-center gap-1.5', className)}>
      {tools.map((tool) => (
        <ToolTag key={tool} name={tool} needsApproval={needsApproval} />
      ))}
    </div>
  )
}
