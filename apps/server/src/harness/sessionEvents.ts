// Session event bus with write-through persistence (phase 2).
// emit() assigns a monotonic per-session seq by persisting to the
// session_events replay buffer first, then fans out to live subscribers.
// The buffer only needs to outlive in-flight runs: runManager prunes it
// when the run finalizes (snapshot path covers completed runs).

import { appendSessionEvent } from './sessionStore.js';

export type SessionEvent = { type: string; sessionId: string; seq?: number; [key: string]: unknown };

const subscribers = new Map<string, Set<(e: SessionEvent) => void>>();

export function subscribe(sessionId: string, fn: (e: SessionEvent) => void): () => void {
  let set = subscribers.get(sessionId);
  if (!set) {
    set = new Set();
    subscribers.set(sessionId, set);
  }
  set.add(fn);
  return () => {
    const s = subscribers.get(sessionId);
    if (!s) return;
    s.delete(fn);
    if (s.size === 0) subscribers.delete(sessionId);
  };
}

export function emit(event: SessionEvent): void {
  // Persist first (even with zero subscribers — the replay buffer must
  // capture events emitted while nobody is listening), best-effort: a
  // persistence failure (e.g. Postgres backend without the table) must not
  // drop the live event.
  let seq: number | undefined;
  try {
    seq = appendSessionEvent(event.sessionId, event.type, event as Record<string, unknown>);
  } catch (err) {
    console.error('[sessionEvents] persist failed:', err instanceof Error ? err.message : err);
  }
  const withSeq: SessionEvent = seq === undefined ? event : { ...event, seq };
  const set = subscribers.get(event.sessionId);
  if (!set) return;
  for (const fn of set) {
    try {
      fn(withSeq);
    } catch (err) {
      // A subscriber throwing must not break other subscribers or the run.
      console.error('[sessionEvents] subscriber threw:', err instanceof Error ? err.message : err);
    }
  }
}

export function subscriberCount(sessionId: string): number {
  return subscribers.get(sessionId)?.size ?? 0;
}
