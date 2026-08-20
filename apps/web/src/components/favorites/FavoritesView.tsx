import React, { useCallback, useEffect, useState } from 'react'
import { Star, Loader2, AlertCircle, MessageSquare, RefreshCw } from 'lucide-react'
import clsx from 'clsx'
import {
  listFavorites,
  setFavorite,
  clearFavorite,
  type SessionFavoriteEntry,
} from '../../api/favorites'
import { authClient } from '../../lib/auth'
import { PageHeader } from '../shell/PageHeader'

/** 对话收藏反馈面板: MVP 多人试用期的反馈收件箱。
 *  - 普通用户：看到自己的收藏 + 备注，可补写/修改备注、取消收藏、跳回会话。
 *  - admin：默认聚合全员反馈（scope=all，带提交人署名），可切回仅看自己的。
 *  只有本人的收藏行可编辑/取消（服务端同样只允许本人操作自己的收藏）。 */

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

export const FavoritesView: React.FC<{
  /** Jump back to the chat view with this session active. */
  onOpenSession: (sessionId: string) => void
}> = ({ onOpenSession }) => {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [favorites, setFavorites] = useState<SessionFavoriteEntry[]>([])
  const [currentUserId, setCurrentUserId] = useState<string | null>(null)
  const [isAdmin, setIsAdmin] = useState(false)
  const [scopeAll, setScopeAll] = useState(false)
  // Inline note editor state: which sessionId is being edited + its draft.
  const [editingId, setEditingId] = useState<string | null>(null)
  const [noteDraft, setNoteDraft] = useState('')
  const [busyId, setBusyId] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    void authClient.getSession().then(({ data }) => {
      if (!alive) return
      const user = (data as { user?: { id?: string; role?: string | null } } | null)?.user
      if (user?.id) setCurrentUserId(user.id)
      const admin = user?.role === 'admin'
      setIsAdmin(admin)
      // Admin lands on the aggregated feedback inbox; everyone else on their own.
      setScopeAll(admin)
    })
    return () => {
      alive = false
    }
  }, [])

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const rows = await listFavorites(scopeAll)
      setFavorites(rows)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [scopeAll])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const startEdit = (row: SessionFavoriteEntry) => {
    setEditingId(row.sessionId)
    setNoteDraft(row.note ?? '')
  }

  const saveNote = async (sessionId: string) => {
    setBusyId(sessionId)
    try {
      await setFavorite(sessionId, noteDraft)
      setEditingId(null)
      await refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusyId(null)
    }
  }

  const unfavorite = async (sessionId: string) => {
    setBusyId(sessionId)
    try {
      await clearFavorite(sessionId)
      await refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusyId(null)
    }
  }

  const scopeTab = (label: string, active: boolean, onClick: () => void) => (
    <button
      type="button"
      onClick={onClick}
      className={clsx(
        'px-3 py-1.5 rounded-md text-xs font-medium transition-colors',
        active ? 'bg-deepSea text-white' : 'bg-white border border-borderGray text-textGray hover:text-textDark',
      )}
    >
      {label}
    </button>
  )

  return (
    <div className="flex-1 flex flex-col min-w-0 bg-bgGray h-full">
      {/* 二级工具条（视图标题由 AppTopbar 承担） */}
      <PageHeader
        actions={
          <>
            <span className="text-xs text-textGray">
              {scopeAll ? '全员收藏的会话与反馈备注（按更新时间倒序）' : '我收藏的会话与反馈备注'}
            </span>
            {isAdmin && (
              <div className="flex items-center gap-1.5">
                {scopeTab('全员反馈', scopeAll, () => setScopeAll(true))}
                {scopeTab('我的收藏', !scopeAll, () => setScopeAll(false))}
              </div>
            )}
            <button
              type="button"
              title="刷新"
              aria-label="刷新"
              onClick={() => void refresh()}
              className="p-1.5 rounded-lg hover:bg-bgGray text-textGray hover:text-textDark"
            >
              <RefreshCw className={clsx('w-4 h-4', loading && 'animate-spin')} />
            </button>
          </>
        }
      />

      {/* List */}
      <div className="flex-1 overflow-auto p-4">
        <div className="max-w-3xl mx-auto space-y-3">
          {error && (
            <div className="rounded-lg border border-danger/20 bg-danger/5 px-3 py-2 text-xs text-danger flex items-center gap-1.5">
              <AlertCircle className="w-3.5 h-3.5 shrink-0" />
              <span className="break-all">{error}</span>
            </div>
          )}
          {loading ? (
            <div className="flex items-center justify-center gap-2 text-sm text-textGray py-12">
              <Loader2 className="w-4 h-4 animate-spin" />
              加载中...
            </div>
          ) : favorites.length === 0 ? (
            <div className="flex flex-col items-center justify-center text-center px-6 py-12">
              <div className="w-12 h-12 rounded-2xl bg-amber/10 flex items-center justify-center mb-4">
                <Star className="w-6 h-6 text-amber" />
              </div>
              <h3 className="text-base font-medium text-textDark mb-2">暂无收藏</h3>
              <p className="text-sm text-textGray max-w-md">
                在对话中点击标题栏的星标即可收藏会话，并可附一条反馈备注；产品团队会在这里汇总大家的反馈。
              </p>
            </div>
          ) : (
            favorites.map((row) => {
              const own = row.userId === currentUserId
              const editing = editingId === row.sessionId
              return (
                <div
                  key={`${row.sessionId}:${row.userId}`}
                  className="rounded-lg border border-borderGray bg-white p-3"
                >
                  <div className="flex items-start gap-2.5">
                    <div className="w-6 h-6 rounded-full bg-amber/10 flex items-center justify-center shrink-0 mt-0.5">
                      <Star className="w-3.5 h-3.5 text-amber" fill="currentColor" />
                    </div>
                    <div className="min-w-0 flex-1">
                      {/* Header: title (click -> open chat) + attribution */}
                      <div className="flex items-center gap-2 flex-wrap">
                        <button
                          type="button"
                          onClick={() => onOpenSession(row.sessionId)}
                          className="text-sm font-medium text-deepSea hover:underline truncate max-w-full inline-flex items-center gap-1.5"
                        >
                          <MessageSquare className="w-3.5 h-3.5 shrink-0" />
                          <span className="truncate">{row.title ?? '未命名会话'}</span>
                        </button>
                        {row.status === 'busy' && (
                          <span className="text-[11px] leading-none text-steelBlue bg-bgGray border border-borderGray rounded-full px-2 py-1">
                            运行中
                          </span>
                        )}
                      </div>
                      <div className="mt-1 flex items-center gap-2 text-[11px] text-textGray flex-wrap">
                        {scopeAll && (
                          <span className="inline-flex items-center gap-1">
                            <span className="w-4 h-4 rounded-full bg-deepSea/10 text-deepSea flex items-center justify-center text-[9px] font-medium shrink-0">
                              {(row.userEmail ?? row.userId).charAt(0).toUpperCase()}
                            </span>
                            <span className="truncate max-w-40">{row.userEmail ?? row.userId}</span>
                          </span>
                        )}
                        <span>收藏于 {relativeTime(row.updatedAt)}</span>
                      </div>

                      {/* Note: display or inline editor (own rows only) */}
                      {editing ? (
                        <div className="mt-2">
                          <textarea
                            value={noteDraft}
                            onChange={(e) => setNoteDraft(e.target.value)}
                            disabled={busyId === row.sessionId}
                            rows={3}
                            placeholder="这条对话哪里有价值 / 有什么问题？"
                            className="w-full rounded-lg border border-borderGray bg-white p-2 text-xs text-textDark placeholder:text-textGray focus:outline-none focus:border-steelBlue resize-none disabled:opacity-70"
                          />
                          <div className="mt-1.5 flex items-center justify-end gap-2">
                            <button
                              type="button"
                              onClick={() => setEditingId(null)}
                              disabled={busyId === row.sessionId}
                              className="px-2.5 py-1 rounded-md text-[11px] text-textGray hover:text-textDark"
                            >
                              取消
                            </button>
                            <button
                              type="button"
                              onClick={() => void saveNote(row.sessionId)}
                              disabled={busyId === row.sessionId}
                              className={clsx(
                                'px-3 py-1 rounded-md text-[11px] font-medium text-white',
                                busyId === row.sessionId
                                  ? 'bg-borderGray cursor-not-allowed'
                                  : 'bg-deepSea hover:bg-deepSea/90',
                              )}
                            >
                              {busyId === row.sessionId ? '保存中...' : '保存备注'}
                            </button>
                          </div>
                        </div>
                      ) : (
                        <div className="mt-2 flex items-start justify-between gap-2">
                          <p
                            className={clsx(
                              'text-xs leading-relaxed break-words',
                              row.note ? 'text-textDark bg-bgGray/60 rounded px-2 py-1.5 border border-borderGray/50 flex-1' : 'text-textGray italic',
                            )}
                          >
                            {row.note ?? '未填写反馈备注'}
                          </p>
                          {own && (
                            <button
                              type="button"
                              onClick={() => startEdit(row)}
                              className="shrink-0 text-[11px] text-steelBlue hover:text-deepSea transition-colors mt-1.5"
                            >
                              {row.note ? '编辑' : '写反馈'}
                            </button>
                          )}
                        </div>
                      )}

                      {/* Footer actions (own rows only) */}
                      {own && !editing && (
                        <div className="mt-2 pt-2 border-t border-borderGray/60 flex items-center justify-between">
                          <button
                            type="button"
                            onClick={() => onOpenSession(row.sessionId)}
                            className="text-[11px] text-steelBlue hover:text-deepSea transition-colors"
                          >
                            打开会话
                          </button>
                          <button
                            type="button"
                            onClick={() => void unfavorite(row.sessionId)}
                            disabled={busyId === row.sessionId}
                            className="text-[11px] text-danger hover:text-danger/80 transition-colors disabled:opacity-50"
                          >
                            取消收藏
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              )
            })
          )}
        </div>
      </div>
    </div>
  )
}

export default FavoritesView
