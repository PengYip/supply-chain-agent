// Harness session store -- backend-neutral facade (dual-backend split).
//
// The session store owns 5 tables: sessions / session_messages /
// pending_approvals / session_events / session_favorites. Two interchangeable
// backends implement the exact same async API:
//   - sessionStoreSqlite.ts   (DEFAULT; better-sqlite3, apps/server/data/agent.db)
//   - sessionStorePostgres.ts (DB_BACKEND=postgres; pg Pool from DATABASE_URL)
//
// Backend selection reuses the pipeline convention (pipeline/db/dbBackend.ts):
// the exact string 'postgres' selects Postgres, anything else falls back to
// SQLite so a misconfiguration cannot select the un-provisioned backend. No new
// env vars; Postgres reads DATABASE_URL with the same dev default as auth.ts.
//
// ALL functions return Promises on BOTH backends (mirroring the pipeline
// repositories pattern: better-sqlite3 is sync internally, but callers `await`
// once and never branch per backend).
//
// Migration note: the pre-split module exported a better-sqlite3 `db` instance.
// It was removed -- no consumer imported it (verified across src/ + test/).
// SQLite-side access is internal to sessionStoreSqlite.ts.

import type { UIMessage } from 'ai';
import { randomUUID } from 'node:crypto';

import type { Role } from './roleToolRegistry.js';
import { DB_BACKEND } from '../pipeline/db/dbBackend.js';

// ---- types ----

export interface SessionInfo {
  id: string;
  role: Role;
  /** Auto-generated session title (Phase 5); stored in metadata_json. */
  title?: string;
}

export interface LoadedSession {
  id: string;
  role: Role;
  messages: UIMessage[];
  /** Auto-generated session title (Phase 5); stored in metadata_json. */
  title?: string;
  /** Parsed sessions.metadata_json blob (title, historyCompaction, ...).
   * Undefined when the row has no/invalid metadata. */
  metadata?: Record<string, unknown>;
}

export type ApprovalLevel = 'L2' | 'L3';
export type ApprovalStatus = 'pending' | 'approved' | 'denied';

/**
 * Background session runtime lifecycle state.
 * - 'idle': no agent run in flight.
 * - 'busy': a background agent run is currently executing (run_id set).
 * - 'interrupted': a run was in-flight when the process restarted; the caller
 *   must decide whether to resume or discard. Set by resetBusyOnStartup().
 */
export type SessionStatus = 'idle' | 'busy' | 'interrupted';

// Type alias (not interface) so it satisfies pg's QueryResultRow constraint in
// the Postgres backend; identical shape to the historical interface.
export type PendingApprovalRow = {
  id: string;
  session_id: string;
  level: ApprovalLevel;
  tool_name: string;
  tool_call_id: string | null;
  input_json: string;
  ticket_id: string | null;
  approval_id: string | null;
  status: ApprovalStatus;
  created_at: string;
};

/** Raw `sessions` row shape (shared by both backend modules). Declared as a
 *  type alias (not interface) so it satisfies pg's QueryResultRow index-
 *  signature constraint in sessionStorePostgres.ts. */
export type SessionRow = {
  id: string;
  role: Role;
  created_at: string;
  updated_at: string;
  metadata_json: string | null;
  user_id: string | null;
  status?: SessionStatus;
  run_id?: string | null;
  current_run_started_at?: string | null;
};

/** Raw `session_messages` row shape (shared by both backend modules; type
 *  alias for the pg QueryResultRow constraint, see SessionRow). */
export type MessageRow = {
  seq: number;
  model_message_json: string;
};

/** Raw `session_favorites` row shape (shared by both backend modules; type
 *  alias for the pg QueryResultRow constraint, see SessionRow). */
export type FavoriteRow = {
  session_id: string;
  user_id: string;
  user_email: string | null;
  note: string | null;
  created_at: string;
  updated_at: string;
};

/** One user's favorite ("收藏") of one chat session, with an optional feedback
 *  note. user_email is a write-time snapshot so the aggregated feedback view
 *  can attribute notes without a cross-store join (auth users live in
 *  Postgres, chat sessions in this store). */
export interface SessionFavorite {
  sessionId: string;
  userId: string;
  userEmail: string | null;
  note: string | null;
  createdAt: string;
  updatedAt: string;
}

/** A favorite joined with its session's list-facing fields (title/status). */
export interface SessionFavoriteSummary extends SessionFavorite {
  title?: string;
  status: SessionStatus;
}

export interface SessionEventRow {
  seq: number;
  type: string;
  payload: Record<string, unknown>;
}

export interface RecordPendingInput {
  sessionId: string;
  level: ApprovalLevel;
  toolName: string;
  toolCallId?: string | null;
  input: unknown;
  ticketId?: string | null;
  approvalId?: string | null;
}

/** List-facing per-session row (GET /api/sessions). */
export interface SessionListItem {
  id: string;
  role: Role;
  createdAt: string;
  title?: string;
  status: SessionStatus;
  favorited: boolean;
  messageCount: number;
}

/** Status read result for getSessionStatus(). */
export interface SessionStatusInfo {
  status: SessionStatus;
  runId?: string;
  startedAt?: string;
}

/**
 * Structural contract every backend module satisfies. The facade delegates to
 * exactly one of these for the process lifetime (memoized dynamic import, so
 * the inactive backend module is never even loaded -- a Postgres deployment
 * never opens agent.db, and vice versa).
 */
export interface SessionStoreBackend {
  createSession(role: Role, userId?: string | null): Promise<SessionInfo>;
  setSessionTitle(sessionId: string, title: string): Promise<void>;
  /** Read-modify-write merge of keys into sessions.metadata_json (same
   * pattern as setSessionTitle; used by historyCompaction). */
  mergeSessionMetadata(sessionId: string, patch: Record<string, unknown>): Promise<void>;
  listSessionsForUser(userId: string): Promise<SessionListItem[]>;
  purgeEmptySessionsForUser(userId: string): Promise<number>;
  setSessionStatus(id: string, status: SessionStatus, runId?: string): Promise<void>;
  getSessionStatus(id: string): Promise<SessionStatusInfo | null>;
  resetBusyOnStartup(): Promise<void>;
  sessionBelongsTo(id: string, userId: string): Promise<boolean>;
  loadSession(id: string): Promise<LoadedSession | null>;
  deleteSession(id: string): Promise<boolean>;
  setSessionFavorite(
    sessionId: string,
    userId: string,
    userEmail: string | null,
    note: string | null,
  ): Promise<SessionFavorite>;
  clearSessionFavorite(sessionId: string, userId: string): Promise<boolean>;
  getSessionFavorite(sessionId: string, userId: string): Promise<SessionFavorite | null>;
  listSessionFavorites(userId: string): Promise<SessionFavoriteSummary[]>;
  listAllSessionFavorites(): Promise<SessionFavoriteSummary[]>;
  appendMessages(sessionId: string, msgs: UIMessage[]): Promise<void>;
  replaceMessage(sessionId: string, message: UIMessage): Promise<boolean>;
  appendSessionEvent(
    sessionId: string,
    type: string,
    payload: Record<string, unknown>,
  ): Promise<number>;
  listSessionEventsSince(sessionId: string, sinceSeq: number): Promise<SessionEventRow[]>;
  pruneSessionEvents(sessionId: string): Promise<void>;
  recordPendingApproval(input: RecordPendingInput): Promise<void>;
  resolveApproval(id: string, status: ApprovalStatus): Promise<void>;
  getPending(id: string): Promise<PendingApprovalRow | null>;
  listPending(sessionId: string): Promise<PendingApprovalRow[]>;
  countPendingApprovals(sessionId: string): Promise<number>;
}

// ---- shared helpers (used by both backends; exported for them only) ----

/** Parse the title out of a session's metadata_json blob (defensive). */
export function parseTitle(metadataJson: string | null | undefined): string | undefined {
  if (!metadataJson) return undefined;
  try {
    const meta = JSON.parse(metadataJson) as { title?: unknown };
    return typeof meta.title === 'string' ? meta.title : undefined;
  } catch {
    return undefined;
  }
}

/** Parse the full metadata_json blob into an object (defensive; undefined on
 * missing/invalid JSON). Used by both backends' loadSession so callers get
 * structured access to keys beyond `title` (e.g. historyCompaction). */
export function parseMetadata(metadataJson: string | null | undefined): Record<string, unknown> | undefined {
  if (!metadataJson) return undefined;
  try {
    const meta = JSON.parse(metadataJson) as Record<string, unknown>;
    return meta && typeof meta === 'object' ? meta : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Normalize a parsed message row to UIMessage. Legacy rows were stored as
 * ModelMessage ({role, content}) without .parts; wrap them so reload never
 * crashes convertToModelMessages. Roles outside the UIMessage union (e.g.
 * 'tool' from old server-synthesized resume rows) coerce to a valid role.
 *
 * Both backends must apply this on load (legacy-compat contract).
 */
export function normalizeToUIMessage(raw: unknown): UIMessage {
  const m = raw as { parts?: unknown; role?: unknown; content?: unknown };
  if (Array.isArray(m.parts)) return m as UIMessage;
  const roleRaw = (m.role ?? 'user') as string;
  const role: UIMessage['role'] =
    roleRaw === 'assistant' ? 'assistant' : roleRaw === 'system' ? 'system' : 'user';
  const c = m.content;
  const text =
    typeof c === 'string'
      ? c
      : Array.isArray(c)
        ? (c as Array<{ type?: string; text?: string }>)
            .filter((p) => p?.type === 'text')
            .map((p) => String(p.text ?? ''))
            .join('')
        : '';
  return { id: randomUUID(), role, parts: [{ type: 'text', text }] } as UIMessage;
}

// ---- backend dispatch ----

let backendPromise: Promise<SessionStoreBackend> | null = null;

function getBackend(): Promise<SessionStoreBackend> {
  // Memoized dynamic import: the backend module loads exactly once, and the
  // inactive backend never loads at all (keeps agent.db unopened on Postgres
  // deployments and pg Pool unconstructed on SQLite ones).
  if (!backendPromise) {
    backendPromise =
      DB_BACKEND === 'postgres'
        ? import('./sessionStorePostgres.js').then((m) => m.createAgentSessionStore(m.getDefaultAgentPool()))
        : import('./sessionStoreSqlite.js').then((m) => m.sqliteSessionStore);
  }
  return backendPromise;
}

// ---- API (backend-neutral; every fn awaits the backend once) ----

export async function createSession(role: Role, userId?: string | null): Promise<SessionInfo> {
  return (await getBackend()).createSession(role, userId);
}

/**
 * Set the session's auto-generated title. Stored inside the existing
 * metadata_json blob (no schema migration): merges `{...meta, title}` so other
 * metadata keys are preserved. No-op if the session does not exist.
 */
export async function setSessionTitle(sessionId: string, title: string): Promise<void> {
  return (await getBackend()).setSessionTitle(sessionId, title);
}

/**
 * Merge `patch` into the session's metadata_json blob (shallow, {...meta,
 * ...patch}). No schema migration; other metadata keys are preserved. No-op if
 * the session does not exist.
 */
export async function mergeSessionMetadata(
  sessionId: string,
  patch: Record<string, unknown>,
): Promise<void> {
  return (await getBackend()).mergeSessionMetadata(sessionId, patch);
}

/** List chat sessions owned by a user (Phase 2 data isolation). Includes the
 *  caller's favorite state per session so the sidebar can star rows without a
 *  second round-trip. */
export async function listSessionsForUser(userId: string): Promise<SessionListItem[]> {
  return (await getBackend()).listSessionsForUser(userId);
}

/** Delete the user's zero-message sessions (an empty session holds nothing of
 *  value) and return how many were removed. Reuses deleteSession so the
 *  dependent-row cascade (favorites etc.) applies. Called on session create so
 *  abandoned empty sessions never accumulate. */
export async function purgeEmptySessionsForUser(userId: string): Promise<number> {
  return (await getBackend()).purgeEmptySessionsForUser(userId);
}

/**
 * Set the background-run status of a session. When transitioning to 'busy',
 * pass a runId and the current timestamp is recorded as current_run_started_at.
 * Setting any non-'busy' status clears run_id and current_run_started_at so a
 * stale run cannot be confused with a live one. No-op if the session does not
 * exist (UPDATE matches zero rows).
 */
export async function setSessionStatus(
  id: string,
  status: SessionStatus,
  runId?: string,
): Promise<void> {
  return (await getBackend()).setSessionStatus(id, status, runId);
}

/**
 * Read the background-run status of a session. Returns null if the session does
 * not exist. runId/startedAt are omitted from the result when NULL in the row.
 */
export async function getSessionStatus(id: string): Promise<SessionStatusInfo | null> {
  return (await getBackend()).getSessionStatus(id);
}

/**
 * Boot-time recovery: any session left 'busy' from a previous process was
 * interrupted by a crash/restart. Flip it to 'interrupted' so the UI can flag
 * it and the caller can decide to resume or discard. Safe to call when there
 * are no busy rows (UPDATE matches zero rows).
 */
export async function resetBusyOnStartup(): Promise<void> {
  return (await getBackend()).resetBusyOnStartup();
}

/**
 * Owner check for data isolation. Returns true iff the session exists AND its
 * user_id matches. A legacy session (user_id NULL, pre-Phase-2) is treated as
 * NOT owned by any authenticated user.
 */
export async function sessionBelongsTo(id: string, userId: string): Promise<boolean> {
  return (await getBackend()).sessionBelongsTo(id, userId);
}

export async function loadSession(id: string): Promise<LoadedSession | null> {
  return (await getBackend()).loadSession(id);
}

/**
 * Delete a chat session and all of its dependent rows (messages, pending
 * approvals, favorites). Returns true if the session existed (and was
 * deleted), false if it was already gone. Callers MUST verify ownership first
 * (sessionBelongsTo) -- this fn does not re-check.
 */
export async function deleteSession(id: string): Promise<boolean> {
  return (await getBackend()).deleteSession(id);
}

// --- session favorites (对话收藏: MVP 用户反馈通道) ---

/** Favorite a session (upsert). Re-favoriting overwrites the note and refreshes
 *  the email snapshot. Returns the stored favorite. Callers MUST verify the
 *  session exists and is owned by userId (sessionBelongsTo) -- this fn does
 *  not re-check, mirroring the other writers here. */
export async function setSessionFavorite(
  sessionId: string,
  userId: string,
  userEmail: string | null,
  note: string | null,
): Promise<SessionFavorite> {
  return (await getBackend()).setSessionFavorite(sessionId, userId, userEmail, note);
}

/** Remove a user's favorite of a session. Returns true if a row was removed. */
export async function clearSessionFavorite(sessionId: string, userId: string): Promise<boolean> {
  return (await getBackend()).clearSessionFavorite(sessionId, userId);
}

/** Read one user's favorite of one session (null when not favorited). */
export async function getSessionFavorite(
  sessionId: string,
  userId: string,
): Promise<SessionFavorite | null> {
  return (await getBackend()).getSessionFavorite(sessionId, userId);
}

/** List one user's favorites with session title/status (newest first).
 *  Favorites of since-deleted sessions drop out via the inner JOIN. */
export async function listSessionFavorites(userId: string): Promise<SessionFavoriteSummary[]> {
  return (await getBackend()).listSessionFavorites(userId);
}

/** List EVERY user's favorites (admin feedback inbox). Same shape as
 *  listSessionFavorites plus the per-row userId/userEmail attribution. */
export async function listAllSessionFavorites(): Promise<SessionFavoriteSummary[]> {
  return (await getBackend()).listAllSessionFavorites();
}

export async function appendMessages(sessionId: string, msgs: UIMessage[]): Promise<void> {
  return (await getBackend()).appendMessages(sessionId, msgs);
}

/**
 * Replace a persisted message IN PLACE (same row, same seq) — used by
 * continuation-mode runs (L2 approval resume) to update the continued
 * assistant message (the approval-requested part flips to output-available /
 * output-denied) instead of appending a duplicate with the same id. The SQLite
 * backend linear-scans parsed .id values; the Postgres backend resolves the
 * seq in SQL (model_message_json::jsonb ->> 'id'). Returns true if a row with
 * that message id was replaced, false if no such message exists.
 */
export async function replaceMessage(sessionId: string, message: UIMessage): Promise<boolean> {
  return (await getBackend()).replaceMessage(sessionId, message);
}

// --- session event replay buffer (phase 2) ---
// Events are a reconnect replay buffer, not SSOT (session_messages is).
// No FK on session_id in either backend: buffer writes must not fail for
// sessions without a backing row (tests, degraded modes).

export async function appendSessionEvent(
  sessionId: string,
  type: string,
  payload: Record<string, unknown>,
): Promise<number> {
  return (await getBackend()).appendSessionEvent(sessionId, type, payload);
}

export async function listSessionEventsSince(
  sessionId: string,
  sinceSeq: number,
): Promise<SessionEventRow[]> {
  return (await getBackend()).listSessionEventsSince(sessionId, sinceSeq);
}

export async function pruneSessionEvents(sessionId: string): Promise<void> {
  return (await getBackend()).pruneSessionEvents(sessionId);
}

export async function recordPendingApproval(input: RecordPendingInput): Promise<void> {
  return (await getBackend()).recordPendingApproval(input);
}

export async function resolveApproval(id: string, status: ApprovalStatus): Promise<void> {
  return (await getBackend()).resolveApproval(id, status);
}

export async function getPending(id: string): Promise<PendingApprovalRow | null> {
  return (await getBackend()).getPending(id);
}

export async function listPending(sessionId: string): Promise<PendingApprovalRow[]> {
  return (await getBackend()).listPending(sessionId);
}

export async function countPendingApprovals(sessionId: string): Promise<number> {
  return (await getBackend()).countPendingApprovals(sessionId);
}
