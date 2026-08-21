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

/**
 * Start a background run for a session (single-flight: busy => conflict).
 *
 * ASYNC since the session store went dual-backend (SQLite/Postgres): the
 * 'busy' status is durably persisted (and the run.started / session.status
 * events emitted) BEFORE this fn resolves, so a caller that awaits it can
 * immediately observe status='busy'. The single-flight slot is reserved
 * SYNCHRONOUSLY (before the first await) so concurrent callers still get an
 * atomic conflict check -- the awaits cannot interleave two starts for the
 * same session. If the busy persist throws, the reservation is rolled back
 * and the error propagates to the caller (mirroring the old sync behavior
 * where a store failure failed the start).
 */
export async function startSessionRun(
  sessionId: string,
  userId: string | undefined,
  role: string,
  fn: (signal: AbortSignal) => Promise<void>,
): Promise<StartResult> {
  const existing = runs.get(sessionId);
  if (existing) {
    // Single-flight: a run is still in-flight for this session.
    return { conflict: true };
  }
  const runId = randomUUID();
  const controller = new AbortController();
  const handle: RunHandle = { runId, controller, done: Promise.resolve() };
  // Reserve the slot NOW (sync, pre-await) so a racing second start observes
  // the conflict. `done` is patched below once the real run promise exists.
  runs.set(sessionId, handle);
  try {
    await setSessionStatus(sessionId, 'busy', runId);
    await emit({ type: 'run.started', sessionId, runId, at: new Date().toISOString() });
    // Push an immediate busy status so connected SSE subscribers flip their
    // local status without waiting for a reconnect snapshot. Without this the
    // only session.status event is the final 'idle', and the frontend stays
    // 'idle' for the whole run (badge/input/polling all wrong).
    await emit({ type: 'session.status', sessionId, status: 'busy', runId });
  } catch (err) {
    runs.delete(sessionId);
    throw err;
  }

  const ctx = { sessionId, userId, runId, role };
  handle.done = runSessionContext(ctx, async () => {
    try {
      await fn(controller.signal);
      await emit({ type: 'run.finished', sessionId, runId });
    } catch (err) {
      if (controller.signal.aborted) {
        await emit({ type: 'run.aborted', sessionId, runId });
      } else {
        console.error('[runManager] run failed:', err instanceof Error ? err.message : err);
        await emit({ type: 'run.error', sessionId, runId, message: err instanceof Error ? err.message : String(err) });
      }
    } finally {
      try {
        await setSessionStatus(sessionId, 'idle');
      } catch (err) {
        // Fail-open: a status-persist failure must NOT prevent the event emit
        // or the slot release below, or the session stays conflict forever
        // while the store already says busy.
        console.error('[runManager] idle persist failed:', err instanceof Error ? err.message : err);
      }
      await emit({ type: 'session.status', sessionId, status: 'idle' });
      // Replay buffer only needs to outlive in-flight runs. The idle event
      // above has been emitted (and persisted) before this prune, so a
      // client reconnecting after finalization gets the idle snapshot from
      // the route and (correctly) no replay; its missed tail is covered by
      // the snapshot-refresh path.
      try {
        await pruneSessionEvents(sessionId);
      } catch (err) {
        // Fail-open (same policy as emit's persist guard): a prune failure in
        // degraded DB mode must NOT prevent the single-flight slot release
        // below — otherwise the session stays conflict forever while the
        // store already says idle.
        console.error('[runManager] prune failed:', err instanceof Error ? err.message : err);
      }
      runs.delete(sessionId);
    }
  });

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
