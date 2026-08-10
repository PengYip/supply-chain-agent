import React from 'react'
import { Activity, Clock, ShieldAlert } from 'lucide-react'
import clsx from 'clsx'
import type { AgentStatusState } from '../hooks/useAgentStatus'

interface AgentStatusBarProps {
  sessionId: string | null
  status: AgentStatusState
}

/**
 * Compact functional data strip shown only in real mode (mounted inside
 * RealChatView). Polls the agent-status endpoint via `useAgentStatus` and
 * surfaces: total tool calls, bySignal breakdown, last tool + when, and
 * pending approvals (highlighted when > 0 as the human-in-the-loop signal).
 *
 * Session id capture: RealChatView's fetchWrapper already reads the
 * `x-session-id` response header from `/api/chat` and we mirror it into React
 * state so this strip can react to it. The server reuses that id for all
 * subsequent requests, so the polled path matches the chat session exactly.
 */
const SIGNAL_LABELS: { key: 'counter' | 'todo' | 'env'; label: string }[] = [
  { key: 'counter', label: '查询' },
  { key: 'todo', label: '待办' },
  { key: 'env', label: '写操作' },
]

function formatRelative(iso: string | null, now: number = Date.now()): string {
  if (!iso) return '—'
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return '—'
  const diffSec = Math.round((now - then) / 1000)
  if (diffSec < 0) return '刚刚'
  if (diffSec < 60) return `${diffSec} 秒前`
  const min = Math.floor(diffSec / 60)
  if (min < 60) return `${min} 分钟前`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr} 小时前`
  const day = Math.floor(hr / 24)
  return `${day} 天前`
}

export const AgentStatusBar: React.FC<AgentStatusBarProps> = ({ sessionId, status }) => {
  const data = status.status === 'ok' ? status.data : null
  const pending = data?.pendingApprovals ?? 0
  const hasActivity = !!data && data.totalCalls > 0

  // Idle / empty states.
  const leftLabel = !sessionId
    ? '等待会话建立'
    : status.status === 'error'
      ? '状态获取失败'
      : !hasActivity
        ? '会话就绪 · 暂无工具调用'
        : null

  return (
    <div
      className={clsx(
        'h-8 flex items-center gap-3 px-4 text-[11px] border-b shrink-0 select-none',
        pending > 0
          ? 'bg-amber/5 border-amber/30'
          : 'bg-bgGray border-borderGray',
      )}
      role="status"
      aria-live="polite"
    >
      <span className="flex items-center gap-1 text-textGray shrink-0">
        <Activity className={clsx('w-3 h-3', hasActivity && 'text-steelBlue')} />
        <span className="font-medium text-textDark">Agent 状态</span>
      </span>

      <span className="w-px h-3 bg-borderGray shrink-0" />

      {leftLabel ? (
        <span className="text-textGray truncate">{leftLabel}</span>
      ) : data ? (
        <>
          <Metric label="工具调用" value={String(data.totalCalls)} />

          <span className="w-px h-3 bg-borderGray shrink-0" />

          <span className="flex items-center gap-2 text-textGray">
            {SIGNAL_LABELS.map((s) => (
              <span key={s.key} className="flex items-center gap-0.5">
                <span className="text-textGray/70">{s.label}</span>
                <span className="font-medium text-textDark">{data.bySignal[s.key]}</span>
              </span>
            ))}
          </span>

          <span className="w-px h-3 bg-borderGray shrink-0" />

          <span className="flex items-center gap-1 text-textGray min-w-0">
            <Clock className="w-3 h-3 shrink-0" />
            <span className="truncate">
              <span className="font-medium text-textDark">{data.lastToolName ?? '—'}</span>
              <span className="text-textGray/70 ml-1">{formatRelative(data.lastToolAt)}</span>
            </span>
          </span>

          <span className="ml-auto flex items-center gap-1 shrink-0">
            <span
              className={clsx(
                'flex items-center gap-1 px-2 py-0.5 rounded-full border',
                pending > 0
                  ? 'bg-amber/10 text-amber border-amber/40 font-medium'
                  : 'bg-white text-textGray border-borderGray',
              )}
              title={pending > 0 ? '有待处理的 L2/L3 审批' : '无待审批'}
            >
              <ShieldAlert className={clsx('w-3 h-3', pending > 0 && 'animate-pulse')} />
              待审批
              <span className="font-semibold">{pending}</span>
            </span>
          </span>
        </>
      ) : null}
    </div>
  )
}

interface MetricProps {
  label: string
  value: string
}

const Metric: React.FC<MetricProps> = ({ label, value }) => (
  <span className="flex items-center gap-1 text-textGray shrink-0">
    <span className="text-textGray/70">{label}</span>
    <span className="font-semibold text-deepSea">{value}</span>
  </span>
)

export default AgentStatusBar
