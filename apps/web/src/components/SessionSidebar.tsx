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
  /** 拉取最新会话列表（返回新鲜数据）。新建守卫需要权威的 messageCount。 */
  refresh: () => Promise<Session[]>
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
export function SessionSidebar({ activeSessionId, onSelect, sessions, loading, createSession, deleteSession, refresh, favoriteSession, unfavoriteSession }: SessionSidebarProps) {
  // 全部 / 已收藏 filter over the server-joined favorited flag.
  const [showFavoritesOnly, setShowFavoritesOnly] = useState(false)
  // 防抖：请求在途时吞掉重复点击（连点新建不应发出第二个 POST，连点星标
  // 不应发出第二组 favorite+refresh）。
  const [newBusy, setNewBusy] = useState(false)
  const [favBusyId, setFavBusyId] = useState<string | null>(null)
  // 空会话不进入列表（服务端在下次新建时也会清理）；当前活跃的空会话保留
  // 展示，否则正在使用的会话会凭空消失。
  const listed = sessions.filter((s) => s.id === activeSessionId || (s.messageCount ?? 0) > 0)
  const visible = showFavoritesOnly ? listed.filter((s) => s.favorited) : listed

  // 重复点击新建：若当前会话存在且还没有任何消息，直接复用它（一次不刷
  // 新的判断可能拿到过期计数，故先取权威列表再决策）。
  const handleNew = async () => {
    if (newBusy) return
    setNewBusy(true)
    try {
      const fresh = await refresh()
      const active = fresh.find((s) => s.id === activeSessionId)
      if (active && (active.messageCount ?? 0) === 0) return
      const s: Session | null = await createSession('trader')
      if (s) onSelect(s.id)
    } finally {
      setNewBusy(false)
    }
  }

  const handleDelete = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation()
    if (!window.confirm('确定删除此会话？删除后无法恢复。')) return
    await deleteSession(id)
  }

  const handleToggleFavorite = async (e: React.MouseEvent, s: Session) => {
    e.stopPropagation()
    if (favBusyId === s.id) return
    setFavBusyId(s.id)
    try {
      if (s.favorited) {
        await unfavoriteSession(s.id)
      } else {
        // Favorite immediately (no note) — feedback note is edited afterwards in
        // the favorites panel / chat header; a blocking prompt here would get in
        // the way of quick starring.
        await favoriteSession(s.id)
      }
    } finally {
      setFavBusyId(null)
    }
  }

  return (
    <div className="flex h-full w-64 flex-col overflow-hidden bg-white">
      <div className="p-3">
        <button
          type="button"
          onClick={handleNew}
          disabled={newBusy}
          className="w-full rounded-lg bg-primary px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {newBusy ? '创建中...' : '新建会话'}
        </button>
        <div className="mt-2 flex gap-0.5 rounded-lg bg-surface p-1">
          {(
            [
              { label: `全部 (${listed.length})`, active: !showFavoritesOnly, onClick: () => setShowFavoritesOnly(false) },
              { label: `已收藏 (${listed.filter((s) => s.favorited).length})`, active: showFavoritesOnly, onClick: () => setShowFavoritesOnly(true) },
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
                      favBusyId === s.id && 'cursor-wait opacity-50',
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
