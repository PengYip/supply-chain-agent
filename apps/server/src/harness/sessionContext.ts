import { AsyncLocalStorage } from 'node:async_hooks';

// Request-scoped session id for tool execute functions.
//
// AI SDK 6 tool `execute` has no slot for arbitrary request context, so we use a
// module-level variable set at the start of each /api/chat and
// /api/approval/callback turn. The L3 create_payment execute reads this to know
// which session a pending ticket belongs to.
//
// CAVEAT: this is a single-slot variable, safe for sequential dev requests but
// NOT concurrent ones. For real concurrency, switch to AsyncLocalStorage (the
// SessionStore API itself is already concurrent-safe).

let currentSessionId: string | null = null;

export function setSessionContext(id: string | null): void {
  currentSessionId = id;
}

export function getSessionContext(): string | null {
  return currentSessionId;
}

// --- Phase 1 background runtime: AsyncLocalStorage ---
// Transition: the legacy single-slot (above) is KEPT as a fallback for the
// current synchronous streaming chat.ts path (where tool execute runs outside
// the handler's async chain during stream pipe, so ALS would be unset there).
// The unified reader getSessionId() prefers ALS and degrades to the legacy
// slot. Task 7 deletes the legacy slot once chat.ts switches to the background
// runSession (which consumes fullStream inside runSessionContext).
//
// Tool execute functions read via getSessionId() so they work on BOTH paths:
// chat.ts legacy path -> legacy slot; Task 5 background run -> ALS.

export type SessionCtx = {
  sessionId: string;
  userId?: string;
  runId?: string;
  role: string;
};

const sessionALS = new AsyncLocalStorage<SessionCtx>();

export function runSessionContext<T>(ctx: SessionCtx, fn: () => T): T {
  return sessionALS.run(ctx, fn);
}

export function getSessionCtx(): SessionCtx {
  const ctx = sessionALS.getStore();
  if (!ctx) throw new Error('session context not set');
  return ctx;
}

// Unified reader: ALS first, legacy single-slot fallback. Returns null when
// neither is set (e.g. a tool execute invoked outside any session context).
export function getSessionId(): string | null {
  return sessionALS.getStore()?.sessionId ?? currentSessionId;
}
