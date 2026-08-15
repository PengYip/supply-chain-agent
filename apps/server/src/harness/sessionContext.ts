import { AsyncLocalStorage } from 'node:async_hooks';

// Session-scoped context for tool execute functions.
//
// AI SDK 6 tool `execute` has no slot for arbitrary request context, so an
// AsyncLocalStorage carries the current session per background run. Every run
// (chat POST and approval-callback resume alike) is started through
// RunManager.startSessionRun, which wraps the run body in runSessionContext —
// so tool executes always find their session here.

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

// Returns null when read outside any session context (e.g. a tool execute
// invoked from a standalone script).
export function getSessionId(): string | null {
  return sessionALS.getStore()?.sessionId ?? null;
}
