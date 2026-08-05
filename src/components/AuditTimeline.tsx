import React from 'react'
import { User, Settings, ShieldCheck, Info, Clock, CheckCircle2 } from 'lucide-react'
import { type AuditEvent, type AuditEventType } from '../data/mock'
import clsx from 'clsx'

interface AuditTimelineProps {
  events: AuditEvent[]
}

const EventIcon: React.FC<{ type: AuditEventType }> = ({ type }) => {
  const iconClass = 'w-3 h-3'
  if (type === 'user') return <User className={clsx(iconClass, 'text-white')} />
  if (type === 'approval') return <ShieldCheck className={clsx(iconClass, 'text-white')} />
  if (type === 'tool') return <Settings className={clsx(iconClass, 'text-textGray')} />
  return <Info className={clsx(iconClass, 'text-textGray')} />
}

export const AuditTimeline: React.FC<AuditTimelineProps> = ({ events }) => {
  if (events.length === 0) {
    return (
      <div className="text-center py-8 text-textGray text-sm">
        <Clock className="w-8 h-8 mx-auto mb-2 text-borderGray" />
        暂无审计记录
      </div>
    )
  }

  return (
    <div className="space-y-0">
      {events.map((event, idx) => {
        const isLast = idx === events.length - 1
        const isTool = event.type === 'tool'
        const isApproval = event.type === 'approval'
        const isUser = event.type === 'user'

        return (
          <div key={event.id} className="flex gap-3">
            <div className="flex flex-col items-center shrink-0">
              <div
                className={clsx(
                  'w-6 h-6 rounded-full flex items-center justify-center border-2',
                  isUser ? 'bg-deepSea border-deepSea'
                  : isApproval ? 'bg-amber border-amber'
                  : 'bg-white border-borderGray'
                )}
              >
                <EventIcon type={event.type} />
              </div>
              {!isLast && <div className="w-px flex-1 min-h-[28px] bg-borderGray mt-1" />}
            </div>
            <div className="flex-1 pb-4">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-textDark">{event.title}</span>
                  {event.actor && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-bgGray text-textGray">
                      {event.actor}
                    </span>
                  )}
                </div>
                <span className="text-[11px] font-mono text-textGray tabular-nums">{event.timestamp}</span>
              </div>
              {event.detail && (
                <div className={clsx(
                  'mt-1 text-xs',
                  isTool ? 'font-mono text-textGray' : 'text-textDark'
                )}>
                  {event.detail}
                </div>
              )}
              {event.meta && (
                <div className="mt-1 text-[11px] font-mono text-textGray/80 flex items-center gap-1">
                  <CheckCircle2 className="w-3 h-3" /> {event.meta}
                </div>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}

export default AuditTimeline
