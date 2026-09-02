import { useEffect, useRef, useState } from 'react'
import type { UIMessageChunk } from 'ai'
import type { SessionStatus } from './useSessions'

/** A single SSE event off the wire (data: <JSON>). */
interface SessionEvent {
  type: string
  sessionId: string
  [key: string]: unknown
}

/** Structured run/connection error surfaced to the UI. `code` is the
 *  server-side verdict ('provider_arrears' = 模型欠费, 'run_failed' = 其他，
 *  缺省视为 run_failed); 展示文案由 UI 按 code 渲染。 */
export interface SessionError {
  code?: string
  message: string
}

export interface SessionEventHandlers {
  /** A UIMessageChunk arrived (event type 'message.part', field 'part'). */
  onChunk?: (part: UIMessageChunk) => void
  /** Session status changed (event 'session.status', including the
   * point-in-time snapshot sent on every (re)connect). */
  onStatus?: (status: SessionStatus) => void
  /** A background run started (event type 'run.started'). */
  onRunStart?: (runId: string) => void
  /** A background run finished normally (event type 'run.finished'). */
  onRunFinish?: (runId: string) => void
  /** A background run was aborted (event type 'run.aborted'). */
  onRunAborted?: (runId: string) => void
  /** A background run errored (event type 'run.error'). */
  onRunError?: (runId: string | undefined, error: SessionError) => void
}

/**
 * Subscribes to the session SSE event stream for `sessionId`. Dispatches typed
 * events to `handlers` and tracks the session status. Handlers are kept in a
 * ref so the EventSource effect only re-runs when sessionId changes (not on
 * every handler identity change).
 *
 * Switching sessionId closes the old EventSource and opens a new one. The
 * browser auto-reconnects on transient network errors; the server sends a
 * fresh status snapshot as the first event on (re)connect.
 *
 * connected: SSE 当前是否在线。瞬时断线(服务端 CD 重启/网络抖动)期间为
 * false —— EventSource 仍在自动重连, 此时 UI 显示轻提示「连接中断，正在
 * 重连」; 重连成功(onopen)或收到事件即恢复 true。永久断开(readyState
 * CLOSED)仍走既有 error 展示, 不与提示重复。
 */
export function useSessionEvents(
  sessionId: string | null,
  handlers: SessionEventHandlers,
): { status: SessionStatus; error: SessionError | null; connected: boolean } {
  const handlersRef = useRef(handlers)
  handlersRef.current = handlers
  const [status, setStatus] = useState<SessionStatus>('idle')
  const [error, setError] = useState<SessionError | null>(null)
  // 乐观初始 true: 避免挂载/切换会话时首连前的提示闪烁; onerror 即翻 false。
  const [connected, setConnected] = useState(true)

  useEffect(() => {
    if (!sessionId) {
      setStatus('idle')
      setError(null)
      setConnected(true)
      return
    }

    let closed = false
    const url = `/api/sessions/${encodeURIComponent(sessionId)}/events`
    const es = new EventSource(url)

    es.onopen = () => {
      if (!closed) setConnected(true)
    }

    es.onmessage = (ev: MessageEvent<string>) => {
      let event: SessionEvent
      try {
        event = JSON.parse(ev.data) as SessionEvent
      } catch {
        return
      }
      switch (event.type) {
        case 'session.status':
          setStatus((event.status as SessionStatus) ?? 'idle')
          handlersRef.current.onStatus?.((event.status as SessionStatus) ?? 'idle')
          break
        case 'run.started':
          handlersRef.current.onRunStart?.(event.runId as string)
          setError(null)
          break
        case 'message.part':
          handlersRef.current.onChunk?.(event.part as UIMessageChunk)
          break
        case 'run.finished':
          handlersRef.current.onRunFinish?.(event.runId as string)
          break
        case 'run.aborted':
          handlersRef.current.onRunAborted?.(event.runId as string)
          break
        case 'run.error': {
          // 老 runManager 版本（重放缓冲里的历史事件）没有 code 字段：一律
          // 回退 run_failed，UI 走 generic 路径。
          const err: SessionError = {
            code: typeof event.code === 'string' ? event.code : 'run_failed',
            message: typeof event.message === 'string' ? event.message : 'run error',
          }
          handlersRef.current.onRunError?.(event.runId as string | undefined, err)
          setError(err)
          break
        }
      }
    }

    es.onerror = () => {
      // EventSource auto-reconnects. Surface nothing on transient errors; the
      // server's reconnect snapshot event will re-sync status. Only flag an
      // error if the connection is permanently closed (readyState CLOSED).
      if (closed) return
      // 瞬时断线也翻转 connected —— 死窗口(CD 重启)期间 UI 用轻提示告知
      // 正在重连, 而不是沉默地停留在「生成中」。
      setConnected(false)
      if (es.readyState === EventSource.CLOSED) {
        setError({ message: '连接已断开' })
      }
    }

    return () => {
      closed = true
      es.close()
    }
  }, [sessionId])

  return { status, error, connected }
}
