import React, { useState } from 'react'
import clsx from 'clsx'
import { Star } from 'lucide-react'
import { type Session } from '../hooks/useSessions'

interface SessionSidebarProps {
  activeSessionId: string | null
  onSelect: (id: string) => void
  sessions: Session[]
  loading: boolean
  createSession: (role?: string) => Promise<Session | null>
  deleteSession: (id: string) => Promise<void>
  /** 对话收藏: star a session (upsert, note editable later in the favorites panel). */
  favoriteSession: (id: string, note?: string | null) => Promise<void>
  unfavoriteSession: (id: string) => Promise<void>
}

function relativeTime(iso: string): string {
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return ''
  const diff = Math.max(0, Date.now() - then)
  const min = 60 * 1000
  const hour = 60 * min
  const day = 24 * hour
  if (diff < min) return '刚刚'
  if (diff < hour) return `${Math.floor(diff / min)}分钟前`
  if (diff < day) return `${Math.floor(diff / hour)}小时前`
  return `${Math.floor(diff / day)}天前`
}

/** 会话面板：作为 ChatWorkspace 的左侧可折叠面板（容器负责宽度过渡）。
 *  本组件固定 256px 宽，避免折叠动画期间内容被挤压重排。 */
export function SessionSidebar({ activeSessionId, onSelect, sessions, loading, createSession, deleteSession, favoriteSession, unfavoriteSession }: SessionSidebarProps) {
  // 全部 / 已收藏 filter over the server-joined favorited flag.
  const [showFavoritesOnly, setShowFavoritesOnly] = useState(false)
  const visible = showFavoritesOnly ? sessions.filter((s) => s.favorited) : sessions

  const handleNew = async () => {
    const s: Session | null = await createSession('trader')
    if (s) onSelect(s.id)
  }

  const handleDelete = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation()
    if (!window.confirm('确定删除此会话？删除后无法恢复。')) return
    await deleteSession(id)
  }

  const handleToggleFavorite = async (e: React.MouseEvent, s: Session) => {
    e.stopPropagation()
    if (s.favorited) {
      await unfavoriteSession(s.id)
    } else {
      // Favorite immediately (no note) — feedback note is edited afterwards in
      // the favorites panel / chat header; a blocking prompt here would get in
      // the way of quick starring.
      await favoriteSession(s.id)
    }
  }

  return (
    <div className="flex h-full w-64 flex-col overflow-hidden bg-white">
      <div className="p-3">
        <button
          type="button"
          onClick={handleNew}
          className="w-full rounded-lg bg-primary px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-primary/90"
        >
          新建会话
        </button>
        <div className="mt-2 flex gap-0.5 rounded-lg bg-surface p-1">
          {(
            [
              { label: `全部 (${sessions.length})`, active: !showFavoritesOnly, onClick: () => setShowFavoritesOnly(false) },
              { label: `已收藏 (${sessions.filter((s) => s.favorited).length})`, active: showFavoritesOnly, onClick: () => setShowFavoritesOnly(true) },
            ] as const
          ).map((tab) => (
            <button
              key={tab.label}
              type="button"
              onClick={tab.onClick}
              className={clsx(
                'flex-1 rounded-md px-1 py-1 text-xs transition-colors',
                tab.active ? 'bg-white font-medium text-primary shadow-sm' : 'text-ink-soft hover:text-ink',
              )}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        {loading ? (
          <div className="p-4 text-center text-sm text-ink-soft">加载中...</div>
        ) : visible.length === 0 ? (
          <div className="p-4 text-center text-sm text-ink-soft">
            {showFavoritesOnly ? '暂无收藏会话' : '暂无会话'}
          </div>
        ) : (
          visible.map((s) => {
            const active = s.id === activeSessionId
            return (
              <div
                key={s.id}
                onClick={() => onSelect(s.id)}
                className={clsx(
                  'group cursor-pointer border-l-2 px-3 py-2 transition-colors',
                  active ? 'border-primary bg-primary/5' : 'border-transparent hover:bg-surface',
                )}
              >
                <div className="flex min-w-0 items-center gap-1.5 text-sm">
                  <span
                    onClick={(e) => void handleToggleFavorite(e, s)}
                    title={s.favorited ? '取消收藏' : '收藏（可在收藏页补写反馈）'}
                    className={clsx(
                      'shrink-0 cursor-pointer leading-none transition-colors',
                      s.favorited ? 'text-warning hover:text-warning/80' : 'text-line hover:text-warning',
                    )}
                  >
                    <Star size={14} fill={s.favorited ? 'currentColor' : 'none'} strokeWidth={1.5} />
                  </span>
                  <span className="min-w-0 flex-1 truncate text-ink">
                    {s.title ?? '新建会话'}
                  </span>
                  {s.status === 'busy' && (
                    <span className="shrink-0 whitespace-nowrap rounded-full border border-primary/20 bg-primary/10 px-1.5 py-px text-[11px] text-primary">
                      运行中
                    </span>
                  )}
                  <span
                    onClick={(e) => void handleDelete(e, s.id)}
                    className="hidden shrink-0 cursor-pointer rounded px-1 text-[11px] text-danger transition-colors hover:bg-danger/5 group-hover:inline"
                  >
                    删除
                  </span>
                </div>
                <div className="mt-0.5 text-xs text-ink-soft">
                  {relativeTime(s.updatedAt || s.createdAt)}
                </div>
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}

export default SessionSidebar
