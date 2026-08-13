import React from 'react'
import { type Session } from '../hooks/useSessions'

interface SessionSidebarProps {
  activeSessionId: string | null
  onSelect: (id: string) => void
  sessions: Session[]
  loading: boolean
  createSession: (role?: string) => Promise<Session | null>
  deleteSession: (id: string) => Promise<void>
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

export function SessionSidebar({ activeSessionId, onSelect, sessions, loading, createSession, deleteSession }: SessionSidebarProps) {

  const handleNew = async () => {
    const s: Session | null = await createSession('trader')
    if (s) onSelect(s.id)
  }

  const handleDelete = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation()
    if (!window.confirm('确定删除此会话？删除后无法恢复。')) return
    await deleteSession(id)
  }

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
      </div>

      <div style={{ flex: 1 }}>
        {loading ? (
          <div style={{ textAlign: 'center', color: '#888', padding: 16, fontSize: 13 }}>
            加载中...
          </div>
        ) : sessions.length === 0 ? (
          <div style={{ textAlign: 'center', color: '#888', padding: 16, fontSize: 13 }}>
            暂无会话
          </div>
        ) : (
          sessions.map((s) => {
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
                  <div style={{ fontSize: 14 }}>{s.title ?? '新建会话'}</div>
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
