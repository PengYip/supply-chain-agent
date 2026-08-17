import { useEffect, useRef, useState } from 'react'
import type { UIMessageChunk } from 'ai'
import type { SessionStatus } from './useSessions'

/** A single SSE event off the wire (data: <JSON>). */
interface SessionEvent {
  type: string
  sessionId: string
  [key: string]: unknown
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
  onRunError?: (runId: string | undefined, message: string) => void
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
 */
export function useSessionEvents(
  sessionId: string | null,
  handlers: SessionEventHandlers,
): { status: SessionStatus; error: string | null } {
  const handlersRef = useRef(handlers)
  handlersRef.current = handlers
  const [status, setStatus] = useState<SessionStatus>('idle')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!sessionId) {
      setStatus('idle')
      setError(null)
      return
    }

    let closed = false
    const url = `/api/sessions/${encodeURIComponent(sessionId)}/events`
    const es = new EventSource(url)

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
        case 'run.error':
          handlersRef.current.onRunError?.(
            event.runId as string | undefined,
            (event.message as string) ?? 'unknown error',
          )
          setError((event.message as string) ?? 'run error')
          break
      }
    }

    es.onerror = () => {
      // EventSource auto-reconnects. Surface nothing on transient errors; the
      // server's reconnect snapshot event will re-sync status. Only flag an
      // error if the connection is permanently closed (readyState CLOSED).
      if (closed) return
      if (es.readyState === EventSource.CLOSED) {
        setError('连接已断开')
      }
    }

    return () => {
      closed = true
      es.close()
    }
  }, [sessionId])

  return { status, error }
}
