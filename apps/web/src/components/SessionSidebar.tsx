import React, { useState } from 'react'
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

  const filterTab = (label: string, active: boolean, onClick: () => void) => (
    <button
      onClick={onClick}
      style={{
        flex: 1,
        padding: '5px 0',
        fontSize: 12,
        border: 'none',
        cursor: 'pointer',
        borderRadius: 4,
        color: active ? '#2563eb' : '#666',
        background: active ? '#eff6ff' : 'transparent',
        fontWeight: active ? 600 : 400,
      }}
    >
      {label}
    </button>
  )

  return (
    <div
      style={{
        width: 260,
        height: '100vh',
        borderRight: '1px solid #e0e0e0',
        overflowY: 'auto',
        display: 'flex',
        flexDirection: 'column',
        boxSizing: 'border-box',
        flexShrink: 0,
      }}
    >
      <div style={{ padding: 12 }}>
        <button
          onClick={handleNew}
          style={{
            width: '100%',
            padding: 8,
            background: '#2563eb',
            color: 'white',
            border: 'none',
            borderRadius: 4,
            cursor: 'pointer',
            marginBottom: 8,
            fontSize: 14,
          }}
        >
          新建会话
        </button>
        <div style={{ display: 'flex', gap: 4, background: '#f5f5f5', borderRadius: 4, padding: 2 }}>
          {filterTab(`全部 (${sessions.length})`, !showFavoritesOnly, () => setShowFavoritesOnly(false))}
          {filterTab(`已收藏 (${sessions.filter((s) => s.favorited).length})`, showFavoritesOnly, () => setShowFavoritesOnly(true))}
        </div>
      </div>

      <div style={{ flex: 1 }}>
        {loading ? (
          <div style={{ textAlign: 'center', color: '#888', padding: 16, fontSize: 13 }}>
            加载中...
          </div>
        ) : visible.length === 0 ? (
          <div style={{ textAlign: 'center', color: '#888', padding: 16, fontSize: 13 }}>
            {showFavoritesOnly ? '暂无收藏会话' : '暂无会话'}
          </div>
        ) : (
          visible.map((s) => {
            const active = s.id === activeSessionId
            return (
              <div
                key={s.id}
                onClick={() => onSelect(s.id)}
                style={{
                  padding: '8px 12px',
                  cursor: 'pointer',
                  borderLeft: active ? '3px solid #2563eb' : '3px solid transparent',
                  background: active ? '#f0f4ff' : undefined,
                }}
                onMouseEnter={(e) => {
                  if (!active) e.currentTarget.style.background = '#f5f5f5'
                }}
                onMouseLeave={(e) => {
                  if (!active) e.currentTarget.style.background = ''
                }}
              >
                <div style={{ overflow: 'hidden' }}>
                  <span
                    onClick={(e) => handleDelete(e, s.id)}
                    style={{
                      float: 'right',
                      fontSize: 12,
                      color: '#dc2626',
                      cursor: 'pointer',
                    }}
                  >
                    删除
                  </span>
                  <div style={{ fontSize: 14, display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span
                      onClick={(e) => void handleToggleFavorite(e, s)}
                      title={s.favorited ? '取消收藏' : '收藏（可在收藏页补写反馈）'}
                      style={{
                        flexShrink: 0,
                        cursor: 'pointer',
                        display: 'inline-flex',
                        alignItems: 'center',
                        color: s.favorited ? '#f59e0b' : '#c4c4c4',
                        lineHeight: 1,
                      }}
                      onMouseEnter={(e) => {
                        e.currentTarget.style.color = s.favorited ? '#d97706' : '#9ca3af'
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.color = s.favorited ? '#f59e0b' : '#c4c4c4'
                      }}
                    >
                      <Star size={14} fill={s.favorited ? 'currentColor' : 'none'} strokeWidth={1.5} />
                    </span>
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {s.title ?? '新建会话'}
                    </span>
                    {s.status === 'busy' && (
                      <span
                        style={{
                          fontSize: 11,
                          color: '#2563eb',
                          background: '#eff6ff',
                          border: '1px solid #bfdbfe',
                          borderRadius: 999,
                          padding: '1px 7px',
                          whiteSpace: 'nowrap',
                          flexShrink: 0,
                        }}
                      >
                        运行中
                      </span>
                    )}
                  </div>
                  <div style={{ fontSize: 12, color: '#888' }}>
                    {relativeTime(s.updatedAt || s.createdAt)}
                  </div>
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
