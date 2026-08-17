// Per-session background run manager. Run handles live in a process-wide Map
// (service-scoped lifetime), NOT the request scope — this is what lets a run
// keep running after the HTTP request that started it has returned.
//
// Single-flight per session (busy => conflict); different sessions run concurrently.

import { randomUUID } from 'node:crypto';
import { setSessionStatus, pruneSessionEvents } from './sessionStore.js';
import { runSessionContext } from './sessionContext.js';
import { emit } from './sessionEvents.js';

type RunHandle = {
  runId: string;
  controller: AbortController;
  done: Promise<void>;
};

const runs = new Map<string, RunHandle>();

export type StartResult = { runId: string } | { conflict: true };

export function startSessionRun(
  sessionId: string,
  userId: string | undefined,
  role: string,
  fn: (signal: AbortSignal) => Promise<void>,
): StartResult {
  const existing = runs.get(sessionId);
  if (existing) {
    // Single-flight: a run is still in-flight for this session.
    return { conflict: true };
  }
  const runId = randomUUID();
  const controller = new AbortController();
  setSessionStatus(sessionId, 'busy', runId);
  emit({ type: 'run.started', sessionId, runId, at: new Date().toISOString() });
  // Push an immediate busy status so connected SSE subscribers flip their
  // local status without waiting for a reconnect snapshot. Without this the
  // only session.status event is the final 'idle', and the frontend stays
  // 'idle' for the whole run (badge/input/polling all wrong).
  emit({ type: 'session.status', sessionId, status: 'busy', runId });

  const ctx = { sessionId, userId, runId, role };
  const done = runSessionContext(ctx, async () => {
    try {
      await fn(controller.signal);
      emit({ type: 'run.finished', sessionId, runId });
    } catch (err) {
      if (controller.signal.aborted) {
        emit({ type: 'run.aborted', sessionId, runId });
      } else {
        console.error('[runManager] run failed:', err instanceof Error ? err.message : err);
        emit({ type: 'run.error', sessionId, runId, message: err instanceof Error ? err.message : String(err) });
      }
    } finally {
      setSessionStatus(sessionId, 'idle');
      emit({ type: 'session.status', sessionId, status: 'idle' });
      // Replay buffer only needs to outlive in-flight runs. The idle event
      // above has been emitted (and persisted) before this prune, so a
      // client reconnecting after finalization gets the idle snapshot from
      // the route and (correctly) no replay; its missed tail is covered by
      // the snapshot-refresh path.
      pruneSessionEvents(sessionId);
      runs.delete(sessionId);
    }
  });

  runs.set(sessionId, { runId, controller, done });
  return { runId };
}

export function abortSessionRun(sessionId: string): boolean {
  const handle = runs.get(sessionId);
  if (!handle) return false;
  handle.controller.abort();
  return true;
}

export function isRunning(sessionId: string): boolean {
  return runs.has(sessionId);
}
