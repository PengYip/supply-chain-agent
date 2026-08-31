import { useCallback, useEffect, useState } from 'react'
import { AlertCircle, Bot, Clock, FileQuestion, Loader2, MessageSquare } from 'lucide-react'
import { fetchSessionShare, type ShareMessage, type ShareSnapshot } from '../../api/share'

/** 免登录只读分享页 /share/:token。
 *  独立于 AppShell 与登录门控（App 根组件按 pathname 在认证网关之前分流到此）。
 *  只渲染 UIMessage 的 text parts（其余 part 类型静默跳过），不提供输入框、
 *  侧边栏或任何需要登录的交互。样式沿用主站语义 token，观感一致但独立成页。 */

type LoadState =
  | { phase: 'loading' }
  | { phase: 'notfound' }
  | { phase: 'error'; message: string }
  | { phase: 'ready'; data: ShareSnapshot }

interface ShareRow {
  id: string
  role: 'user' | 'assistant'
  text: string
}

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

/** ISO 时间 → 「2026-08-31 14:30」；非法值返回空串。 */
function formatSharedAt(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}

/** 汇总一条消息的 text parts；全空（纯工具调用等）返回 null，该条整条跳过。 */
function extractText(message: ShareMessage): string | null {
  const text = message.parts
    .filter((p) => p.type === 'text' && typeof p.text === 'string')
    .map((p) => p.text as string)
    .join('\n\n')
    .trim()
  return text || null
}

function toRows(messages: ShareMessage[]): ShareRow[] {
  const rows: ShareRow[] = []
  for (const m of messages) {
    if (m.role !== 'user' && m.role !== 'assistant') continue
    const text = extractText(m)
    if (text) rows.push({ id: m.id, role: m.role, text })
  }
  return rows
}

/** 单条消息：助手 = 头像 + 全宽白卡（对齐主聊天的左右结构但更简化）；
 *  用户 = 右对齐 primary 气泡。进入视口时错峰上浮（只做首屏节奏，长列表不拖沓）。 */
function ShareMessageRow({ row, index }: { row: ShareRow; index: number }) {
  if (row.role === 'user') {
    return (
      <div className="flex animate-slide-up justify-end" style={{ animationDelay: `${Math.min(index, 12) * 45}ms` }}>
        <div className="max-w-[85%] whitespace-pre-wrap break-words rounded-2xl rounded-tr-md bg-primary-500 px-4 py-2.5 text-sm leading-relaxed text-white shadow-card">
          {row.text}
        </div>
      </div>
    )
  }
  return (
    <div className="flex animate-slide-up gap-3" style={{ animationDelay: `${Math.min(index, 12) * 45}ms` }}>
      <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-primary text-white">
        <Bot className="h-3.5 w-3.5" aria-hidden />
      </div>
      <div className="min-w-0 flex-1 rounded-xl border border-line bg-white px-4 py-3 shadow-card">
        <div className="whitespace-pre-wrap break-words text-sm leading-relaxed text-ink">{row.text}</div>
      </div>
    </div>
  )
}

export function SharePage({ token }: { token: string }) {
  const [state, setState] = useState<LoadState>({ phase: 'loading' })

  // 初态即 loading，首次加载由 effect 触发；重试按钮在事件处理器里显式
  // 复位加载态后再调 load，避免 effect 内同步 setState。
  const load = useCallback(() => {
    fetchSessionShare(token)
      .then((data) => setState(data ? { phase: 'ready', data } : { phase: 'notfound' }))
      .catch((err) =>
        setState({ phase: 'error', message: err instanceof Error ? err.message : '加载失败' }),
      )
  }, [token])

  useEffect(() => {
    load()
  }, [load])

  const retry = useCallback(() => {
    setState({ phase: 'loading' })
    load()
  }, [load])

  // 独立标签页场景：把会话标题带到浏览器标签，便于二次传播时识别
  useEffect(() => {
    if (state.phase === 'ready') {
      document.title = `${state.data.title || '对话分享'} · 供应链贸易执行助理`
    }
  }, [state])

  const rows = state.phase === 'ready' ? toRows(state.data.messages) : []
  const sharedAt = state.phase === 'ready' ? formatSharedAt(state.data.createdAt) : ''

  return (
    <div className="flex min-h-screen flex-col bg-surface">
      {/* 轻量页头：产品标识 + 只读属性标记，不携带任何登录态入口 */}
      <header className="shrink-0 border-b border-line bg-white">
        <div className="mx-auto flex h-14 w-full max-w-[768px] items-center gap-3 px-6">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary text-white">
            <MessageSquare className="h-4 w-4" aria-hidden />
          </div>
          <div className="min-w-0 truncate text-sm font-semibold text-ink">供应链贸易执行助理</div>
          <span className="ml-auto shrink-0 rounded-full border border-line bg-surface px-2.5 py-1 text-[11px] leading-none text-ink-soft">
            只读分享
          </span>
        </div>
      </header>

      {state.phase === 'loading' && (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 py-24">
          <Loader2 className="h-5 w-5 animate-spin text-primary-500" aria-hidden />
          <p className="text-sm text-ink-soft">正在加载分享内容...</p>
        </div>
      )}

      {state.phase === 'notfound' && (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 py-24 text-center">
          <div className="flex h-14 w-14 items-center justify-center rounded-full bg-primary-50">
            <FileQuestion className="h-7 w-7 text-primary-500" aria-hidden />
          </div>
          <h1 className="text-base font-medium text-ink">分享内容不存在或已失效</h1>
          <p className="max-w-sm text-xs leading-relaxed text-ink-soft">
            链接可能已过期或被分享者删除，请联系对方重新生成分享链接
          </p>
        </div>
      )}

      {state.phase === 'error' && (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 py-24 text-center">
          <div className="flex h-14 w-14 items-center justify-center rounded-full bg-danger/10">
            <AlertCircle className="h-7 w-7 text-danger" aria-hidden />
          </div>
          <h1 className="text-base font-medium text-ink">加载失败</h1>
          <p className="max-w-sm break-all text-xs leading-relaxed text-ink-soft">{state.message}</p>
          <button
            type="button"
            onClick={retry}
            className="mt-1 rounded-lg border border-line bg-white px-3.5 py-1.5 text-xs text-ink transition-colors hover:bg-surface"
          >
            重试
          </button>
        </div>
      )}

      {state.phase === 'ready' && (
        <>
          <main className="mx-auto w-full max-w-[768px] flex-1 px-6 pb-16">
            {/* 标题区：分享元信息与消息流之间留出呼吸感 */}
            <div className="pb-6 pt-10">
              <div className="text-[11px] font-medium tracking-[0.2em] text-primary-500">对话分享</div>
              <h1 className="mt-2 text-xl font-semibold leading-snug text-ink">
                {state.data.title || '未命名对话'}
              </h1>
              {sharedAt && (
                <p className="mt-2 flex items-center gap-1.5 text-xs text-ink-soft">
                  <Clock className="h-3.5 w-3.5" aria-hidden />
                  分享于 {sharedAt}
                </p>
              )}
            </div>
            <div className="space-y-4">
              {rows.length === 0 ? (
                <div className="rounded-xl border border-dashed border-line bg-white/60 px-6 py-12 text-center text-sm text-ink-soft">
                  该对话暂无文本内容
                </div>
              ) : (
                rows.map((row, i) => <ShareMessageRow key={row.id} row={row} index={i} />)
              )}
            </div>
          </main>
          <footer className="shrink-0 border-t border-line bg-white">
            <div className="mx-auto w-full max-w-[768px] px-6 py-4 text-center text-[11px] leading-relaxed text-ink-soft">
              本页为对话只读快照 · 内容由 AI 生成，关键数字来自系统台账与文档
            </div>
          </footer>
        </>
      )}
    </div>
  )
}
