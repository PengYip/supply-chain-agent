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
