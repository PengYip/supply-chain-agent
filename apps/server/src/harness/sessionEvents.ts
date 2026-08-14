// In-memory session event bus (phase 1: no persistence).
// Phase 2 will also write each event to an `event` table with a monotonic seq.

export type SessionEvent = { type: string; sessionId: string; [key: string]: unknown };

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
  const set = subscribers.get(event.sessionId);
  if (!set) return;
  for (const fn of set) {
    try {
      fn(event);
    } catch (err) {
      // A subscriber throwing must not break other subscribers or the run.
      console.error('[sessionEvents] subscriber threw:', err instanceof Error ? err.message : err);
    }
  }
}

export function subscriberCount(sessionId: string): number {
  return subscribers.get(sessionId)?.size ?? 0;
}
