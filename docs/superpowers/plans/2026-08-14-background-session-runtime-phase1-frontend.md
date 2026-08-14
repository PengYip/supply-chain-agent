# Background Session Runtime - Phase 1 Frontend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate the frontend from `useChat` (connection-bound streaming) to an event-driven model (SSE subscription + background run) so that switching sessions or closing tabs does not interrupt or cross-contaminate in-flight agent runs.

**Architecture:** Two new hooks — `useSessionEvents` (EventSource lifecycle + event dispatch) and `useSessionMessages` (message state + send + chunk assembly via `readUIMessageStream`). `RealChatView` drops `useChat`/`DefaultChatTransport`/`sendAutomaticallyWhen` entirely; its render layer (`buildRenderItems`/`RealMessageItem`) stays unchanged because it only consumes a `UIMessage[]`. The sidebar shows a busy badge from `GET /api/sessions` status field.

**Tech Stack:** React 19, AI SDK 6 (`readUIMessageStream` + `UIMessageChunk` from `'ai'`), TypeScript, Tailwind, Vite.

## Global Constraints

- **AI SDK 6 only** (not v5/v7): `readUIMessageStream` and `UIMessageChunk` are imported from `'ai'`. Do NOT use `useChat`, `DefaultChatTransport`, or `convertToCoreMessages`.
- **No emoji** in code (repo convention).
- **No frontend test runner** (`apps/web` has no vitest). Verification per task = `npm run build --workspace apps/web` (tsc -b + vite build) + `npm run lint` (oxlint, run from repo root). End-to-end manual verification happens in Task F5.
- **Backend contract is fixed** (already implemented + reviewed on this branch):
  - `POST /api/chat` — fire-and-forget. Body: `{ messages: UIMessage[] (parts format), role: 'trader', contextFiles?: [{docId,filename}] }`. Send ONLY the new user message (backend merges prior history from its own store). Response: `200 {sessionId, runId, status:'busy'}` (header `x-session-id`) or `409 {error:'session_busy', activeRunId}`.
  - `GET /api/sessions/:id/events` — SSE. Each line `data: <JSON>\n\n`. Event types: `session.status`, `run.started`, `message.part` (field `part` = a `UIMessageChunk`), `run.finished`, `run.aborted`, `run.error`. 10s heartbeat `: heartbeat\n\n`. First event is a `session.status` snapshot.
  - `GET /api/sessions` — returns `{ sessions: [{id, role, createdAt, title, status}] }` where status is `'idle'|'busy'|'interrupted'`.
  - `GET /api/sessions/:id` — returns `{ id, role, messages: UIMessage[], title }`.
  - `POST /api/sessions/:id/abort` — `{ ok, aborted }`.
- **Backend `message.part` wrapper is intentional** (custom event bus, not raw AI SDK SSE protocol). Frontend parses SSE itself and feeds `part` chunks into `readUIMessageStream`. This is NOT a bug — it is the documented phase-1 design.
- **Render layer is untouched.** `buildRenderItems` (realChatUtils.ts) + `RealMessageItem` + `HumanAgentStatusBar` all stay as-is. They consume `messages`/`status` — only the source of those values changes.
- **L2/L3 approval stays on the synchronous callback path** (spec §6.9 defers approval decoupling to phase 4). `handleApprovalCallback` (POST /api/approval/callback + `readUIMessageStream`) is preserved; only its `setMessages` source changes.
- All work happens in the git worktree `D:\Users\yepeng\supply-chain-bg-runtime` on branch `feat/background-session-runtime-v2`. Do NOT touch the main repo working tree.

---

## Key Design Decisions

### D1: Two hooks, one composes the other
`useSessionMessages` internally calls `useSessionEvents`. This keeps the spec's separation (events vs messages) while avoiding double EventSource connections. `useSessionEvents` stores handlers in a ref (updated every render) so its `useEffect` only re-runs on `sessionId` change — no infinite loop from handler identity churn.

### D2: Per-run chunk stream via `readUIMessageStream`
Each background run (`run.started` → `run.finished`) owns one `ReadableStream<UIMessageChunk>`. On `run.started` we create the stream + an initial `UIMessage` (with a generated id), then async-iterate `readUIMessageStream({stream, message})` which yields complete UIMessage snapshots — each replaces the last assistant message in state. On `run.finished` we close the controller.

### D3: Mid-run rejoin is best-effort
If the user switches back to a session whose run is still busy, we GET the snapshot (may contain a partial/completed assistant message) and open a fresh EventSource. If `session.status === 'busy'` arrives with no active chunk stream, we start one for subsequent `message.part`s. Chunks emitted before rejoin are NOT replayed (phase 3 sync fills that gap). A transient duplicate assistant bubble may appear; it self-corrects on next snapshot fetch or run completion. This is an accepted phase-1 limitation.

### D4: Optimistic send with 409 rollback
`sendMessage` appends the user message optimistically, POSTs `/api/chat`. On `409 session_busy` or error, it rolls back the optimistic message and surfaces an error string. On success it does nothing else — the SSE `run.started` / `message.part` events drive the assistant message.

### D5: SoftGateCard approval routes through `/api/approval/callback`
The old `addToolApprovalResponse` (useChat) is gone. `onApprove`/`onDeny` now call the same `handleApprovalCallback` path (POST /api/approval/callback) that the bottom "模拟审批通过" button uses. Both approve and deny hit the callback; deny passes `approved: false`.

---

## File Structure

**Create:**
- `apps/web/src/hooks/useSessionEvents.ts` — EventSource lifecycle + event dispatch. Returns `{ status }`.
- `apps/web/src/hooks/useSessionMessages.ts` — message state + send + chunk assembly. Composes `useSessionEvents`. Returns `{ messages, status, error, sendMessage, setMessages }`.

**Modify:**
- `apps/web/src/hooks/useSessions.ts` — add `status` to `Session` type.
- `apps/web/src/components/SessionSidebar.tsx` — render busy badge.
- `apps/web/src/components/RealChatView.tsx` — replace useChat with the two hooks; rewire send/status/approval.
- `apps/web/src/hooks/useHumanAgentStatus.ts` — no code change (its `active` param is already a boolean; caller passes the new `isBusy`).

**Backend (deferred minors, same worktree):**
- `apps/server/src/routes/sessions.ts:131` — `runId: st?.runId ?? null`.
- `apps/server/test/harness/sessionEvents.test.ts` — add throwing-subscriber test.
- `apps/server/test/harness/runSession.test.ts` — add abort runtime test.

---

## Task F1: Session status type + sidebar busy badge

**Files:**
- Modify: `apps/web/src/hooks/useSessions.ts:3-11` (Session interface)
- Modify: `apps/web/src/components/SessionSidebar.tsx:81-119` (list item render)

**Interfaces:**
- Consumes: `GET /api/sessions` already returns `status` per item (sessions.ts:38).
- Produces: `Session.status` typed; sidebar renders a small badge when `status === 'busy'`.

- [ ] **Step 1: Add status to Session type**

In `apps/web/src/hooks/useSessions.ts`, extend the interface:

```ts
export type SessionStatus = 'idle' | 'busy' | 'interrupted';

export interface Session {
  id: string;
  role: string;
  userId: string;
  createdAt: string;
  updatedAt: string;
  title?: string;
  status?: SessionStatus;
}
```

- [ ] **Step 2: Render busy badge in SessionSidebar**

In `apps/web/src/components/SessionSidebar.tsx`, inside the `sessions.map((s) => {...})` block (after the title `<div>` at line 112), add a badge next to the title when busy. Insert into the title line:

```tsx
<div style={{ fontSize: 14, display: 'flex', alignItems: 'center', gap: 6 }}>
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
```

Keep the existing `relativeTime` line below it unchanged.

- [ ] **Step 3: Build + lint**

Run: `npm run build --workspace apps/web`
Expected: tsc + vite build succeeds (the new `status` field is optional so existing code stays valid).

Run: `npm run lint` (from repo root)
Expected: no new warnings in modified files.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/hooks/useSessions.ts apps/web/src/components/SessionSidebar.tsx
git commit -m "feat(web): show session busy badge in sidebar"
```

---

## Task F2: useSessionEvents hook (EventSource + dispatch)

**Files:**
- Create: `apps/web/src/hooks/useSessionEvents.ts`

**Interfaces:**
- Consumes: `GET /api/sessions/:id/events` (SSE, see Global Constraints).
- Produces: `useSessionEvents(sessionId, handlers)` returning `{ status: SessionStatus }`. `handlers` is `{ onChunk?, onRunStart?, onRunFinish?, onRunAborted?, onRunError? }`.

- [ ] **Step 1: Create the hook file**

Create `apps/web/src/hooks/useSessionEvents.ts`:

```ts
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
```

- [ ] **Step 2: Build + lint**

Run: `npm run build --workspace apps/web`
Expected: succeeds. `UIMessageChunk` and `SessionStatus` resolve; EventSource is a DOM global (lib.dom).

Run: `npm run lint`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/hooks/useSessionEvents.ts
git commit -m "feat(web): add useSessionEvents hook for SSE subscription"
```

---

## Task F3: useSessionMessages hook (snapshot + send + chunk assembly)

**Files:**
- Create: `apps/web/src/hooks/useSessionMessages.ts`

**Interfaces:**
- Consumes: `useSessionEvents` (Task F2), `GET /api/sessions/:id`, `POST /api/chat`, `readUIMessageStream` + `UIMessage` + `UIMessageChunk` from `'ai'`, `generateId` from `'ai'`.
- Produces: `useSessionMessages(sessionId)` returning `{ messages, status, error, sendMessage, setMessages }`.

- [ ] **Step 1: Create the hook file**

Create `apps/web/src/hooks/useSessionMessages.ts`:

```ts
import { useCallback, useEffect, useRef, useState } from 'react'
import { generateId, readUIMessageStream, type UIMessage, type UIMessageChunk } from 'ai'
import type { ContextFile } from './useFiles'
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

export function useSessionMessages(sessionId: string | null) {
  const [messages, setMessages] = useState<UIMessage[]>([])
  const pipelineRef = useRef<RunPipeline | null>(null)

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

    void (async () => {
      try {
        const uiStream = readUIMessageStream({ stream, message: initialMessage })
        for await (const msg of uiStream) {
          setMessages((prev) => {
            const idx = prev.findIndex((m) => m.id === msgId)
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

  const { status, error } = useSessionEvents(sessionId, {
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
    onRunFinish: () => closePipeline(),
    onRunAborted: () => closePipeline(),
    onRunError: () => closePipeline(),
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

  const sendMessage = useCallback(
    async (text: string, opts?: SendMessageOptions): Promise<{ ok?: true; runId?: string; error?: string }> => {
      if (!sessionId) return { error: 'no session' }
      const userMsg = {
        id: generateId(),
        role: 'user',
        parts: [{ type: 'text', text }],
        createdAt: new Date().toISOString(),
      } as unknown as UIMessage

      // Optimistic append.
      setMessages((prev) => [...prev, userMsg])

      try {
        const res = await fetch('/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-session-id': sessionId },
          body: JSON.stringify({
            messages: [userMsg],
            role: 'trader',
            contextFiles: (opts?.contextFiles ?? []).map((f) => ({ docId: f.docId, filename: f.filename })),
          }),
        })

        if (res.status === 409) {
          // Busy: roll back the optimistic message.
          setMessages((prev) => prev.filter((m) => m.id !== userMsg.id))
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
    },
    [sessionId],
  )

  return { messages, status: status as SessionStatus, error, sendMessage, setMessages }
}
```

- [ ] **Step 2: Verify ContextFile import path**

`ContextFile` is exported from `apps/web/src/hooks/useFiles.ts` (confirmed in RealChatView.tsx:9 import). If the type name differs, adjust the import. Run a quick check:

```bash
git grep "export.*ContextFile" apps/web/src/hooks/useFiles.ts
```

- [ ] **Step 3: Build + lint**

Run: `npm run build --workspace apps/web`
Expected: succeeds. `readUIMessageStream` resolves from `'ai'` (lib-2 verified: ai@6.0.246 index.d.ts:4277).

Run: `npm run lint`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/hooks/useSessionMessages.ts
git commit -m "feat(web): add useSessionMessages hook with readUIMessageStream assembly"
```

---

## Task F4: Rewrite RealChatView (drop useChat, wire new hooks)

**Files:**
- Modify: `apps/web/src/components/RealChatView.tsx` (imports, hook usage, send, status, approval)

**Interfaces:**
- Consumes: `useSessionMessages` (Task F3), existing `buildRenderItems`, `RealMessageItem`, `useHumanAgentStatus`.
- Produces: a RealChatView that no longer imports `useChat`/`DefaultChatTransport`/`sendAutomaticallyWhen`.

This is the largest task. Work top-to-bottom through the file.

- [ ] **Step 1: Replace imports**

Remove from the import block (lines 2-4):
```ts
import { useChat } from '@ai-sdk/react'
import { DefaultChatTransport, generateId, lastAssistantMessageIsCompleteWithApprovalResponses, lastAssistantMessageIsCompleteWithToolCalls, parseJsonEventStream, readUIMessageStream, uiMessageChunkSchema } from 'ai'
import type { UIMessage, UIMessageChunk } from 'ai'
```

Replace with:
```ts
import { generateId, parseJsonEventStream, readUIMessageStream, uiMessageChunkSchema } from 'ai'
import type { UIMessage, UIMessageChunk } from 'ai'
import { useSessionMessages } from '../hooks/useSessionMessages'
```

(`generateId`, `parseJsonEventStream`, `readUIMessageStream`, `uiMessageChunkSchema` are still used by `handleApprovalCallback`. `UIMessage`/`UIMessageChunk` still used by types. Only `useChat`, `DefaultChatTransport`, and the two `lastAssistant*` helpers are dropped.)

- [ ] **Step 2: Replace the chat hook + transport block**

Delete lines 78-111 (the `sessionIdRef`, `liveSessionId`, `contextFilesRef`, `fetchWrapper`, `transport` useMemo, and the entire `useChat(...)` call including `sendAutomaticallyWhen`, plus `sendMessageRef.current = sendMessage`).

Replace with:
```ts
const { messages, status, error, sendMessage, setMessages } = useSessionMessages(sessionId)
const liveSessionId = sessionId
const isBusy = status === 'busy'
const isStreaming = isBusy
```

Keep `sendMessageRef` for the file-upload auto-message path (it calls `sendMessageRef.current({text})`). Update line 112:
```ts
sendMessageRef.current = (msg: { text: string }) => { void sendMessage(msg.text) }
```

- [ ] **Step 3: Remove the old history-load effect + status-transition effect**

Delete lines 117-155 (the `useEffect` that fetches `/api/sessions/:id` and calls `setMessages`, and the `prevStatusRef`/`onSessionChanged` transition effect). The snapshot fetch now lives inside `useSessionMessages`. Replace the sidebar-refresh-on-finish with a simpler effect keyed on status:

```ts
const prevBusyRef = useRef(false)
const onSessionChangedRef = useRef(onSessionChanged)
onSessionChangedRef.current = onSessionChanged
useEffect(() => {
  const wasBusy = prevBusyRef.current
  prevBusyRef.current = isBusy
  if (wasBusy && !isBusy) {
    // Run just finished: refresh sidebar for new title, with a delayed
    // second refresh because title-gen is a fire-and-forget second LLM call.
    onSessionChangedRef.current?.()
    const t = window.setTimeout(() => onSessionChangedRef.current?.(), 4000)
    return () => window.clearTimeout(t)
  }
}, [isBusy])
```

- [ ] **Step 4: Rewire approval handlers**

The `handleApprove`/`handleDeny` functions (lines 157-161) used `addToolApprovalResponse` (gone). Both now route through the approval callback endpoint. Replace them:

```ts
const handleApprove = (id: string) => {
  void postApproval({ approvalId: id, approved: true })
}
const handleDeny = (id: string) => {
  void postApproval({ approvalId: id, approved: false })
}
```

Extract a shared `postApproval` helper (used by both the SoftGateCard buttons and the existing bottom "模拟审批通过" button). Put it near `handleApprovalCallback`:

```ts
const postApproval = async (body: { approvalId?: string; ticketId?: string; approved: boolean }) => {
  if (!sessionId) return
  setCallbackState('loading')
  setCallbackError(null)
  try {
    const res = await fetch('/api/approval/callback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-session-id': sessionId },
      body: JSON.stringify({ ...body, reason: body.approved ? '用户确认执行' : '用户拒绝执行' }),
    })
    if (!res.ok) {
      const text = await res.text()
      throw new Error(text)
    }
    const contentType = res.headers.get('content-type') || ''
    if (!contentType.includes('text/event-stream') || !res.body) {
      setCallbackState('success')
      return
    }
    // Consume the resumed UIMessage stream and merge into messages.
    const chunkStream = parseJsonEventStream({ stream: res.body, schema: uiMessageChunkSchema })
    const parsedStream = chunkStream.pipeThrough(
      new TransformStream({
        transform(chunk, controller) {
          if (!chunk.success) {
            controller.error((chunk as { error: unknown }).error)
            return
          }
          controller.enqueue(chunk.value as UIMessageChunk)
        },
      }),
    ) as unknown as ReadableStream<UIMessageChunk>

    let streamingId: string | null = null
    for await (const raw of readUIMessageStream({ stream: parsedStream })) {
      const msg = { ...raw, id: raw.id || generateId() } as UIMessage
      if (streamingId) {
        setMessages((prev) => prev.map((m) => (m.id === streamingId ? msg : m)))
      } else {
        streamingId = msg.id
        setMessages((prev) => [...prev, msg])
      }
    }
    setCallbackState('success')
  } catch (err) {
    setCallbackError(err instanceof Error ? err.message : String(err))
    setCallbackState('error')
  }
}
```

Then simplify `handleApprovalCallback` (the bottom button) to call `postApproval`:

```ts
const handleApprovalCallback = async () => {
  if (!pendingApproval || callbackState === 'loading') return
  if (pendingApproval.kind === 'L3') {
    void postApproval({ ticketId: pendingApproval.ticketId, approved: true })
  } else {
    void postApproval({ approvalId: pendingApproval.approvalId, approved: true })
  }
}
```

- [ ] **Step 5: Rewire onSubmit**

Replace `onSubmit` (lines 298-310). It no longer calls `sendMessage({text})` from useChat; it calls the hook's `sendMessage`:

```ts
const onSubmit = (e: React.FormEvent) => {
  e.preventDefault()
  const text = input.trim()
  if (!text || isBusy) return
  setInput('')
  void sendMessage(text, { contextFiles })
  setContextFiles([])
}
```

- [ ] **Step 6: Update status badge + input disabled logic**

The top status badge (lines 326-336) currently switches on useChat `status`. Map the new `status`:

```tsx
<span className={clsx(
  'text-xs px-2 py-1 rounded-full border',
  status === 'idle' ? 'bg-success/10 text-success border-success/20'
  : status === 'interrupted' ? 'bg-amber/10 text-amber border-amber/20'
  : error ? 'bg-danger/10 text-danger border-danger/20'
  : 'bg-amber/10 text-amber border-amber/20'
)}>
  {status === 'busy' ? '生成中'
  : status === 'interrupted' ? '已中断'
  : error ? '出错'
  : '就绪'}
</span>
```

Input submit button `disabled` (line 500) and its className condition (line 503): change `isStreaming` references to `isBusy` (the local alias already set in Step 2 — `isStreaming` is kept as an alias for `isBusy` so the existing JSX at lines 284/393 that reads `isStreaming` still compiles; but prefer updating those to `isBusy` for clarity).

- [ ] **Step 7: Keep render layer untouched**

Do NOT modify `buildRenderItems`, `RealMessageItem`, `pendingApproval` (the useMemo scanning messages — it still works because `messages` is now `UIMessage[]` from the hook), `handleFileUpload`, `HumanAgentStatusBar`, or the upload/contextFiles UI. They consume `messages`/`liveSessionId`/`isStreaming` which are all still in scope.

- [ ] **Step 8: Build + lint**

Run: `npm run build --workspace apps/web`
Expected: succeeds. No references to `useChat`, `DefaultChatTransport`, `addToolApprovalResponse`, or `sendAutomaticallyWhen` remain.

Run: `npm run lint`
Expected: clean.

Verify no dangling imports:
```bash
git grep -n "useChat\|DefaultChatTransport\|addToolApprovalResponse\|sendAutomaticallyWhen\|lastAssistantMessage" apps/web/src
```
Expected: no matches.

- [ ] **Step 9: Commit**

```bash
git add apps/web/src/components/RealChatView.tsx
git commit -m "feat(web): migrate RealChatView to event-driven background session"
```

---

## Task F5: useHumanAgentStatus wiring + end-to-end manual verification

**Files:**
- Modify: `apps/web/src/components/RealChatView.tsx:288` (the `useHumanAgentStatus` call — its `active` arg)
- No change to `useHumanAgentStatus.ts` itself.

**Interfaces:**
- Consumes: `isBusy` from Task F4.

- [ ] **Step 1: Pass isBusy to useHumanAgentStatus**

In RealChatView, the call `const agentStatus = useHumanAgentStatus(liveSessionId, isStreaming)` (around line 288) should pass `isBusy`. Since Step 2 of F4 set `isStreaming = isBusy`, this already works. Verify it reads:

```ts
const agentStatus = useHumanAgentStatus(liveSessionId, isBusy)
```

- [ ] **Step 2: End-to-end manual verification**

This is the phase-1 acceptance gate for the frontend. Start both dev servers (if not already running — do NOT start a second frontend server):

```bash
npm run dev:all
```

In the browser at `http://localhost:5173`, verify each acceptance criterion:

1. **Send a message** in a session: user bubble appears immediately (optimistic), assistant message streams in via SSE (`message.part` events driving `readUIMessageStream`). Input is disabled while `status === 'busy'`.
2. **Switch sessions mid-run**: while session A is generating, click session B in the sidebar. Session A's run continues in the background (sidebar shows "运行中" badge on A). Session B loads its own history. Switch back to A — the completed/partial assistant message is visible (snapshot fetch).
3. **Concurrent sessions**: start a run in A, switch to B, send a message in B. Both runs proceed independently; no message cross-contamination. (Note: B's POST /chat returns 200 only if B is idle; if B was already busy it returns 409 and the optimistic message rolls back with an error shown.)
4. **Busy badge**: sidebar item for a running session shows "运行中"; it disappears when the run finishes.
5. **Abort (optional)**: if an abort button is wired (not required by spec §6.8 but the endpoint exists), POST `/api/sessions/:id/abort` stops the run and status returns to idle.

If any criterion fails, fix before proceeding. Record results in the task report.

- [ ] **Step 3: Commit (if any fixups)**

```bash
git add -A
git commit -m "fix(web): end-to-end background session verification pass"
```

(Only commit if Step 2 surfaced fixes; otherwise skip.)

---

## Task F6: Backend deferred minors (3 items)

**Files:**
- Modify: `apps/server/src/routes/sessions.ts:131`
- Modify: `apps/server/test/harness/sessionEvents.test.ts`
- Modify: `apps/server/test/harness/runSession.test.ts`

These are the 3 deferred minors from the backend final review (ora-1). They harden the contract/tests the frontend depends on.

- [ ] **Step 1: Stabilize SSE runId field (sessions.ts:131)**

In `apps/server/src/routes/sessions.ts` line 131, change:

```ts
void send({ type: 'session.status', sessionId: id, status: st?.status ?? 'idle', runId: st?.runId });
```
to:
```ts
void send({ type: 'session.status', sessionId: id, status: st?.status ?? 'idle', runId: st?.runId ?? null });
```

This ensures the `runId` field is always present (null when idle) instead of being omitted by JSON.stringify when undefined — stabilizing the SSE event contract the frontend parses.

- [ ] **Step 2: Add throwing-subscriber test (sessionEvents.test.ts)**

In `apps/server/test/harness/sessionEvents.test.ts`, add a test that a subscriber throwing does not break other subscribers or the emit call:

```ts
it('a throwing subscriber does not break others or emit', () => {
  let ok = 0
  subscribe('s-throw', () => { throw new Error('boom') })
  subscribe('s-throw', () => { ok++ })
  expect(() => emit({ type: 'x', sessionId: 's-throw' })).not.toThrow()
  expect(ok).toBe(1)
})
```

- [ ] **Step 3: Add abort runtime test (runSession.test.ts)**

In `apps/server/test/harness/runSession.test.ts`, add a test that aborting the abortSignal stops the run and the for-await exits. Use the existing fakeStreamingModel fixture:

```ts
it('abort signal stops the run and exits the consume loop', async () => {
  const { sessionId } = makeSession()
  const controller = new AbortController()
  // Start the run, then abort after a tick.
  const runPromise = runSession({
    sessionId,
    messages: [{ role: 'user', content: 'hi' }],
    abortSignal: controller.signal,
  })
  controller.abort()
  await runPromise
  // The run should resolve (not hang) after abort. If readUIMessageStream
  // threw on abort, runSession's caller (RunManager) catches it.
  const parts = emitSpy.mock.calls.filter((c) => c[0]?.type === 'message.part')
  // Aborting mid-fake-stream may yield 0 or few parts; the key assertion is
  // that runPromise resolved (no hang) — asserted by reaching this line.
  expect(parts.length).toBeLessThanOrEqual(5)
})
```

(If the existing test file's fixtures/helpers differ, adapt the test to match — the goal is covering the abort path. If `runSession` does not accept a bare `messages` of ModelMessage[] in this test setup, mirror the existing R1 test's setup.)

- [ ] **Step 4: Build + test + lint**

Run: `npm run build --workspace apps/server`
Expected: tsc succeeds.

Run: `npm test --workspace apps/server`
Expected: all pass (existing 229 + 2 new = 231 passed, 18 skipped).

Run: `npm run lint`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/routes/sessions.ts apps/server/test/harness/sessionEvents.test.ts apps/server/test/harness/runSession.test.ts
git commit -m "test(server): harden SSE runId contract + throwing-subscriber + abort runtime"
```

---

## Self-Review (run after writing, before handing off)

**Spec coverage (spec §6.8):**
- useSessionEvents hook → Task F2 ✓
- useSessionMessages hook → Task F3 ✓
- RealChatView rewrite (drop useChat) → Task F4 ✓
- Sidebar busy badge → Task F1 ✓
- Delete sendAutomaticallyWhen → Task F4 Step 2 (removed with useChat) ✓
- Switch session = switch EventSource → Task F2 (useEffect keyed on sessionId) ✓
- Abort button → marked optional in Task F5 Step 2 (endpoint exists, UI optional) ✓
- 3 deferred backend minors → Task F6 ✓

**Placeholder scan:** No TBD/TODO. All steps have code or concrete commands.

**Type consistency:** `SessionStatus` defined in useSessions.ts (F1), consumed by useSessionEvents (F2) and useSessionMessages (F3). `UIMessageChunk` from `'ai'` consistent across F2/F3/F4. `sendMessage` signature consistent between F3 (definition) and F4 Step 5 (call).

**Risk:** Task F4 is large. If the implementer finds the RealChatView rewrite has hidden coupling (e.g., `sendMessageRef` used elsewhere, or `liveSessionId` needed by a sub-component not yet read), they should report it rather than guess. The render layer (`buildRenderItems`/`RealMessageItem`) is deliberately untouched — if it breaks, the `messages` shape is wrong, not the render code.
