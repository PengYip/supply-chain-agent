import { useEffect, useState } from 'react'

/**
 * Shape returned by the backend endpoint
 * `GET /api/sessions/:id/status` (see server agent-status route).
 * Mirrors the server `AgentStatus` type; kept local to avoid importing server code.
 */
export interface AgentStatus {
  sessionId: string
  totalCalls: number
  bySignal: { counter: number; todo: number; env: number; none: number }
  lastToolName: string | null
  lastToolAt: string | null
  pendingApprovals: number
}

/**
 * Discriminated union so the UI can render idle / data / error states
 * without crashing on 404 (no activity yet) or transient fetch failures.
 */
export type HumanAgentStatusState =
  | { status: 'idle' }
  | { status: 'ok'; data: AgentStatus }
  | { status: 'error' }

const POLL_INTERVAL_MS = 5000

/**
 * Polls the agent-status endpoint for a given chat session while a turn is
 * active. "Stop polling when no active turn" (§9.3) means stop NETWORK
 * requests — NOT clear the display. So:
 *   - no session (`sessionId` null) → idle, nothing rendered;
 *   - session exists but turn ended (`active` false) → keep the last-fetched
 *     data rendered, do NOT fetch or re-arm the interval (the previous effect's
 *     cleanup already tore down its interval/abort);
 *   - session + active turn → poll every POLL_INTERVAL_MS.
 *
 * 404 (no recorded activity yet) and network errors are treated as `idle`
 * rather than crashing the UI — the strip just shows the empty state.
 */
export function useHumanAgentStatus(
  sessionId: string | null,
  active = true,
): HumanAgentStatusState {
  const [state, setState] = useState<HumanAgentStatusState>({ status: 'idle' })

  useEffect(() => {
    if (!sessionId) {
      setState({ status: 'idle' })
      return
    }
    if (!active) {
      // Session exists but the turn ended: keep the last-known data on screen,
      // just don't poll. Returning undefined here means no cleanup is needed
      // (the prior active run's cleanup already cleared its interval/abort).
      return
    }

    let cancelled = false
    const controller = new AbortController()

    const poll = async () => {
      try {
        const res = await fetch(
          `/api/sessions/${encodeURIComponent(sessionId)}/status`,
          { signal: controller.signal },
        )
        if (cancelled) return
        // 404 = session has no recorded activity yet → stay idle, don't crash.
        if (res.status === 404) {
          setState({ status: 'idle' })
          return
        }
        if (!res.ok) {
          setState({ status: 'error' })
          return
        }
        const data = (await res.json()) as AgentStatus
        if (cancelled) return
        setState({ status: 'ok', data })
      } catch {
        if (cancelled || controller.signal.aborted) return
        setState({ status: 'error' })
      }
    }

    void poll()
    const intervalId = window.setInterval(poll, POLL_INTERVAL_MS)

    return () => {
      cancelled = true
      controller.abort()
      window.clearInterval(intervalId)
    }
  }, [sessionId, active])

  return state
}

export default useHumanAgentStatus
