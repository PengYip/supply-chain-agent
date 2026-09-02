import { useCallback, useEffect, useRef, useState } from 'react'
import { generateId, readUIMessageStream, type UIMessage, type UIMessageChunk } from 'ai'
import type { ContextFile } from './useFiles'
import { toAttachmentPart } from '../utils/realChatUtils'
import { useSessionEvents } from './useSessionEvents'
import type { SessionStatus } from './useSessions'

/** State for the currently-streaming run's chunk pipeline. */
interface RunPipeline {
  controller: ReadableStreamDefaultController<UIMessageChunk> | null
  msgId: string
}

export interface SendMessageOptions {
  contextFiles?: ContextFile[]
}

export interface UseSessionMessagesOptions {
  /** Called when sendMessage had to create a new session (user typed on the
   *  welcome screen with no session selected). Lets the owner lift the new
   *  id into app state so the sidebar + SSE subscription follow. */
  onSessionCreated?: (sessionId: string) => void
}

export function useSessionMessages(
  sessionId: string | null,
  opts?: UseSessionMessagesOptions,
) {
  const [messages, setMessages] = useState<UIMessage[]>([])
  const pipelineRef = useRef<RunPipeline | null>(null)
  const onSessionCreatedRef = useRef(opts?.onSessionCreated)
  onSessionCreatedRef.current = opts?.onSessionCreated

  const closePipeline = useCallback(() => {
    const p = pipelineRef.current
    if (p) {
      try {
        p.controller?.close()
      } catch {
        /* already closed */
      }
      pipelineRef.current = null
    }
  }, [])

  /** Spin up a chunk stream + readUIMessageStream consumer for a new run.
   *  Each yielded UIMessage is a full snapshot — replace the matching
   *  assistant message (by id) or append it. */
  const startPipeline = useCallback(() => {
    // Close any prior pipeline first (defensive — run.started should precede
    // parts, but a rejoin after mid-run disconnect may double-fire).
    closePipeline()
    const msgId = generateId()
    pipelineRef.current = { controller: null, msgId }

    const stream = new ReadableStream<UIMessageChunk>({
      start(controller) {
        pipelineRef.current = { controller: controller as ReadableStreamDefaultController<UIMessageChunk>, msgId }
      },
    })

    const initialMessage = {
      id: msgId,
      role: 'assistant',
      parts: [],
      createdAt: new Date().toISOString(),
    } as unknown as UIMessage

    // The server assigns its own message id (runSession passes
    // generateMessageId) and the 'start' chunk overrides the seeded client id
    // inside readUIMessageStream — so dedupe must key on the id the stream
    // actually delivers, not the seed. Otherwise findIndex misses on every
    // snapshot and each one is APPENDED (duplicate React keys -> flicker, no
    // incremental text until the terminal snapshot refresh collapses it).
    let activeId = msgId
    void (async () => {
      try {
        const uiStream = readUIMessageStream({ stream, message: initialMessage })
        for await (const msg of uiStream) {
          const id = msg.id || activeId
          const prevActiveId = activeId
          activeId = id
          setMessages((prev) => {
            let idx = prev.findIndex((m) => m.id === id)
            // First snapshot after the server id replaces the seed: replace
            // the seed-keyed placeholder if one was appended (rejoin path).
            if (idx < 0 && prevActiveId !== id) {
              idx = prev.findIndex((m) => m.id === prevActiveId)
            }
            if (idx >= 0) {
              const copy = prev.slice()
              copy[idx] = msg
              return copy
            }
            return [...prev, msg]
          })
        }
      } catch (err) {
        console.error('[useSessionMessages] readUIMessageStream failed', err)
      }
    })()
  }, [closePipeline])

  /** Fetch the authoritative message list and replace local state. Used on
   *  sessionId change AND after a run reaches a terminal state (finish/
   *  abort/error) — the persisted assistant message is the source of truth
   *  and re-syncing clears any transient assembly artifacts. */
  const refreshSnapshot = useCallback(() => {
    if (!sessionId) return
    fetch(`/api/sessions/${encodeURIComponent(sessionId)}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!data) return
        const msgs = (data as { messages?: UIMessage[] }).messages
        setMessages(Array.isArray(msgs) ? msgs : [])
      })
      .catch(() => {
        /* ignore — status hook will surface connection issues */
      })
  }, [sessionId])

  const { status, error } = useSessionEvents(sessionId, {
    onStatus: (st) => {
      // Reconnect reconciliation: if a run finished while we were
      // disconnected, its events were pruned and no run.finished will ever
      // arrive on this connection — the idle snapshot is the only signal.
      // Close the stale pipeline and re-sync from the snapshot.
      if (st === 'idle' && pipelineRef.current) {
        closePipeline()
        refreshSnapshot()
      }
    },
    onRunStart: () => startPipeline(),
    onChunk: (part) => {
      // If a run is already busy but we missed run.started (rejoin), lazily
      // start the pipeline so subsequent chunks are captured.
      if (!pipelineRef.current) startPipeline()
      try {
        pipelineRef.current?.controller?.enqueue(part)
      } catch {
        /* controller closed/gone */
      }
    },
    onRunFinish: () => {
      closePipeline()
      // The persisted assistant message (server-generated id) replaces the
      // locally-assembled one — authoritative dedupe.
      refreshSnapshot()
    },
    onRunAborted: () => {
      closePipeline()
      refreshSnapshot()
    },
    onRunError: () => {
      closePipeline()
      refreshSnapshot()
    },
  })

  // Load full snapshot when sessionId changes.
  useEffect(() => {
    if (!sessionId) {
      setMessages([])
      return
    }
    let cancelled = false
    fetch(`/api/sessions/${encodeURIComponent(sessionId)}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (cancelled || !data) return
        // A run is streaming right now — the pipeline owns the trailing
        // assistant message. Replacing here would orphan it (findIndex
        // misses on the next snapshot, so the message would be APPENDED,
        // rendering a duplicate). Skip; the run-terminal refresh re-syncs.
        if (pipelineRef.current) return
        const msgs = (data as { messages?: UIMessage[] }).messages
        setMessages(Array.isArray(msgs) ? msgs : [])
      })
      .catch(() => {
        /* ignore — status hook will surface connection issues */
      })
    return () => {
      cancelled = true
    }
  }, [sessionId])

  // Tear down the pipeline on unmount / session switch.
  useEffect(() => {
    return () => closePipeline()
  }, [closePipeline, sessionId])

  // Double-send guard: status is SSE-driven (server push, ~100-500ms of
  // latency), so the composer's isBusy lags behind the actual POST. A
  // synchronous ref swallows the second Enter before any state settles.
  // lastSidRef closes the gap between lazy-create and the sessionId prop
  // arriving via navigation (onSessionCreated → App state → props round-trip)
  // so a fast second send reuses the session instead of creating another.
  const sendingRef = useRef(false)
  const lastSidRef = useRef<string | null>(null)
  useEffect(() => { lastSidRef.current = sessionId }, [sessionId])

  const sendMessage = useCallback(
    async (text: string, sendOpts?: SendMessageOptions): Promise<{ ok?: true; runId?: string; error?: string }> => {
      if (sendingRef.current) return { error: 'session_busy' }
      sendingRef.current = true
      try {
        // No session selected (welcome screen): create one first so typing
        // directly into the composer keeps working like the old useChat path.
        let sid = sessionId ?? lastSidRef.current
        if (!sid) {
          try {
            const created = await fetch('/api/sessions', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ role: 'trader' }),
            })
            if (!created.ok) return { error: 'failed to create session' }
            const s = (await created.json()) as { id?: string }
            if (!s.id) return { error: 'failed to create session' }
            sid = s.id
            lastSidRef.current = sid
            onSessionCreatedRef.current?.(sid)
          } catch (err) {
            return { error: err instanceof Error ? err.message : String(err) }
          }
        }
        // 附件以 data-attachment parts 内嵌：服务端原样持久化 UIMessage，
        // convertToModelMessages 静默丢弃 data-*，历史刷新后卡片可复现。
        const attachmentParts = (sendOpts?.contextFiles ?? []).map(toAttachmentPart)
        const userMsg = {
          id: generateId(),
          role: 'user',
          parts: [...attachmentParts, { type: 'text', text }],
          createdAt: new Date().toISOString(),
        } as unknown as UIMessage

        // Optimistic append.
        setMessages((prev) => [...prev, userMsg])

        try {
          const res = await fetch('/api/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-session-id': sid },
            body: JSON.stringify({
              messages: [userMsg],
              role: 'trader',
              contextFiles: (sendOpts?.contextFiles ?? []).map((f) => ({ docId: f.docId, filename: f.filename })),
            }),
          })

          if (res.status === 409) {
            // Busy / L2-approval-pending: roll back the optimistic message.
            setMessages((prev) => prev.filter((m) => m.id !== userMsg.id))
            const j = (await res.json().catch(() => ({}))) as { error?: string }
            if (j.error === 'approval_pending') {
              // An L2 approval card is pending: the server rejects chat until it
              // is resolved (approving stale cards / chatting past a hanging
              // tool_call would otherwise reach the provider without a
              // tool-result and brick the session).
              return { error: '存在未确认的 L2 写操作，请先处理上方的操作确认卡片' }
            }
            return { error: 'session_busy' }
          }
          if (!res.ok) {
            setMessages((prev) => prev.filter((m) => m.id !== userMsg.id))
            const j = (await res.json().catch(() => ({}))) as { error?: string }
            return { error: j.error ?? `request failed (${res.status})` }
          }
          const data = (await res.json()) as { runId?: string }
          return { ok: true, runId: data.runId }
        } catch (err) {
          setMessages((prev) => prev.filter((m) => m.id !== userMsg.id))
          return { error: err instanceof Error ? err.message : String(err) }
        }
      } finally {
        sendingRef.current = false
      }
    },
    [sessionId],
  )

  /** 请求服务端中止当前后台运行（POST /api/sessions/:id/abort）。运行由
   *  服务端 runManager 持有 —— POST /api/chat 立即返回 runId、token 经 SSE
   *  推送，客户端断开不会停止生成，因此「停止」的唯一正确途径就是该端点
   *  （abortSessionRun 触发 run 的 AbortSignal，AI SDK 把中止传播到模型流
   *  与工具调用）。中止后经 SSE run.aborted / session.status=idle 事件回流，
   *  界面自然回到空闲（onRunAborted 已做 pipeline 收尾与快照重同步）。
   *  返回 aborted 布尔：false = 会话无进行中的运行或请求失败（调用方据此
   *  复位按钮态）；对无运行的会话调用是幂等的（服务端返回 aborted=false）。 */
  const stopRun = useCallback(async (): Promise<boolean> => {
    const sid = sessionId ?? lastSidRef.current
    if (!sid) return false
    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(sid)}/abort`, {
        method: 'POST',
        credentials: 'include',
      })
      if (!res.ok) return false
      const j = (await res.json().catch(() => null)) as { aborted?: boolean } | null
      return j?.aborted === true
    } catch {
      return false
    }
  }, [sessionId])

  return { messages, status: status as SessionStatus, error, sendMessage, stopRun, setMessages }
}
