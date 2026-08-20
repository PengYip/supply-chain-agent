import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import Database from 'better-sqlite3';
import type { UIMessage } from 'ai';

import type { Role } from './roleToolRegistry.js';

// File-backed SQLite (WAL) for durable agent sessions + pending approvals.
// Production swaps this for Postgres (Drizzle-compatible) -- the API below is
// the abstraction boundary.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, '../../data');
const DB_PATH = path.join(DATA_DIR, 'agent.db');

fs.mkdirSync(DATA_DIR, { recursive: true });

export const db = new Database(DB_PATH);
// busy_timeout 必须先于 WAL 设置: 并发测试 worker 同时 import 本模块时,
// 第二个进程的 journal_mode 切换会撞 SQLITE_BUSY 直接抛错(CI 上已复现)。
db.pragma('busy_timeout = 5000');
// SQLite 的 journal_mode 切换需要短暂排他锁, 且该操作不走 busy handler——
// busy_timeout 覆盖不了它(CI 2026-08-18 复现)。先读当前模式: 已是 WAL(其他
// worker 已切好, 并发导入的常态)则跳过; 确需切换时对 SQLITE_BUSY 小步重试。
if (db.pragma('journal_mode', { simple: true }) !== 'wal') {
  for (let attempt = 0; ; attempt++) {
    try {
      db.pragma('journal_mode = WAL');
      break;
    } catch (e) {
      const busy = e instanceof Error && /database is locked|SQLITE_BUSY/i.test(e.message);
      if (!busy || attempt >= 40) throw e;
      await new Promise((r) => setTimeout(r, 25 * (attempt + 1)));
    }
  }
}

db.exec(`
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  role TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  metadata_json TEXT,
  user_id TEXT
);

CREATE TABLE IF NOT EXISTS session_messages (
  session_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  model_message_json TEXT NOT NULL,
  PRIMARY KEY (session_id, seq),
  FOREIGN KEY (session_id) REFERENCES sessions(id)
);

CREATE TABLE IF NOT EXISTS pending_approvals (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  level TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  tool_call_id TEXT,
  input_json TEXT NOT NULL,
  ticket_id TEXT,
  approval_id TEXT,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (session_id) REFERENCES sessions(id)
);

CREATE TABLE IF NOT EXISTS session_events (
  session_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (session_id, seq)
);

CREATE TABLE IF NOT EXISTS session_favorites (
  session_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  user_email TEXT,
  note TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (session_id, user_id),
  FOREIGN KEY (session_id) REFERENCES sessions(id)
);
`);

// Phase 2: add user_id to pre-existing dev databases (CREATE TABLE IF NOT EXISTS
// does not add columns to an already-existing table). Idempotent + guarded.
// try/catch: vitest workers / clustered processes can race the PRAGMA check
// (check-then-act) against the same SQLite file -- same pattern as client.ts.
{
  const cols = db.prepare('PRAGMA table_info(sessions)').all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === 'user_id')) {
    try { db.exec('ALTER TABLE sessions ADD COLUMN user_id TEXT'); } catch { /* concurrent */ }
  }
}

// Background session runtime: add status / run_id / current_run_started_at to
// pre-existing dev databases. Same idempotent PRAGMA-check guard as user_id
// above (CREATE TABLE IF NOT EXISTS cannot add columns to an existing table).
// Defaults to 'idle' so legacy rows are treated as not running.
{
  const cols = db.prepare('PRAGMA table_info(sessions)').all() as Array<{ name: string }>;
  const has = (name: string): boolean => cols.some((c) => c.name === name);
  // try/catch each ALTER: concurrent module init (separate vitest workers /
  // processes sharing this file) can pass the PRAGMA check simultaneously and
  // the second ALTER would throw "duplicate column name" without it.
  if (!has('status')) {
    try { db.exec("ALTER TABLE sessions ADD COLUMN status TEXT NOT NULL DEFAULT 'idle'"); } catch { /* concurrent */ }
  }
  if (!has('run_id')) {
    try { db.exec('ALTER TABLE sessions ADD COLUMN run_id TEXT'); } catch { /* concurrent */ }
  }
  if (!has('current_run_started_at')) {
    try { db.exec('ALTER TABLE sessions ADD COLUMN current_run_started_at TEXT'); } catch { /* concurrent */ }
  }
}

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

export interface PendingApprovalRow {
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
}

interface SessionRow {
  id: string;
  role: Role;
  created_at: string;
  updated_at: string;
  metadata_json: string | null;
  user_id: string | null;
}

interface MessageRow {
  seq: number;
  model_message_json: string;
}

/** One user's favorite ("收藏") of one chat session, with an optional feedback
 *  note. user_email is a write-time snapshot so the aggregated feedback view
 *  can attribute notes without a cross-store join (auth users live in
 *  Postgres, chat sessions in this SQLite file). */
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

interface FavoriteRow {
  session_id: string;
  user_id: string;
  user_email: string | null;
  note: string | null;
  created_at: string;
  updated_at: string;
}

// ---- prepared statements ----

const stmtInsertSession = db.prepare(
  'INSERT INTO sessions (id, role, created_at, updated_at, user_id) VALUES (?, ?, ?, ?, ?)',
);
const stmtGetSession = db.prepare('SELECT * FROM sessions WHERE id = ?');
const stmtListSessionsForUser = db.prepare(`
  SELECT s.id, s.role, s.created_at, s.metadata_json, s.status,
         CASE WHEN f.session_id IS NULL THEN 0 ELSE 1 END AS favorited
  FROM sessions s
  LEFT JOIN session_favorites f ON f.session_id = s.id AND f.user_id = ?
  WHERE s.user_id = ?
  ORDER BY s.created_at DESC
`);
const stmtTouchSession = db.prepare(
  'UPDATE sessions SET updated_at = ? WHERE id = ?',
);
const stmtUpdateMetadata = db.prepare(
  'UPDATE sessions SET metadata_json = ?, updated_at = ? WHERE id = ?',
);
const stmtMaxSeq = db.prepare(
  'SELECT COALESCE(MAX(seq), -1) AS max_seq FROM session_messages WHERE session_id = ?',
);
const stmtInsertMessage = db.prepare(
  'INSERT INTO session_messages (session_id, seq, model_message_json) VALUES (?, ?, ?)',
);
const stmtReplaceMessage = db.prepare(
  'UPDATE session_messages SET model_message_json = ? WHERE session_id = ? AND seq = ?',
);
const stmtListMessages = db.prepare(
  'SELECT seq, model_message_json FROM session_messages WHERE session_id = ? ORDER BY seq ASC',
);
const stmtInsertPending = db.prepare(
  `INSERT INTO pending_approvals (id, session_id, level, tool_name, tool_call_id, input_json, ticket_id, approval_id, status, created_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
);
const stmtUpdatePendingStatus = db.prepare(
  'UPDATE pending_approvals SET status = ? WHERE id = ?',
);
const stmtGetPending = db.prepare('SELECT * FROM pending_approvals WHERE id = ?');
const stmtListPending = db.prepare(
  "SELECT * FROM pending_approvals WHERE session_id = ? AND status = 'pending' ORDER BY created_at ASC",
);
const stmtCountPending = db.prepare(
  "SELECT COUNT(*) AS n FROM pending_approvals WHERE session_id = ? AND status = 'pending'",
);
const stmtDeleteSession = db.prepare('DELETE FROM sessions WHERE id = ?');
const stmtDeleteSessionMessages = db.prepare('DELETE FROM session_messages WHERE session_id = ?');
const stmtDeleteSessionPending = db.prepare('DELETE FROM pending_approvals WHERE session_id = ?');
const stmtDeleteSessionFavorites = db.prepare('DELETE FROM session_favorites WHERE session_id = ?');

// --- session favorites (对话收藏/用户反馈) ---

const stmtUpsertFavorite = db.prepare(`
  INSERT INTO session_favorites (session_id, user_id, user_email, note, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?)
  ON CONFLICT (session_id, user_id) DO UPDATE SET
    user_email = excluded.user_email,
    note = excluded.note,
    updated_at = excluded.updated_at
`);
const stmtDeleteFavorite = db.prepare('DELETE FROM session_favorites WHERE session_id = ? AND user_id = ?');
const stmtGetFavorite = db.prepare('SELECT * FROM session_favorites WHERE session_id = ? AND user_id = ?');
const stmtListFavoritesForUser = db.prepare(`
  SELECT f.*, s.metadata_json, s.status
  FROM session_favorites f
  JOIN sessions s ON s.id = f.session_id
  WHERE f.user_id = ?
  ORDER BY f.updated_at DESC
`);
const stmtListAllFavorites = db.prepare(`
  SELECT f.*, s.metadata_json, s.status
  FROM session_favorites f
  JOIN sessions s ON s.id = f.session_id
  ORDER BY f.updated_at DESC
`);

// ---- API ----

export function createSession(role: Role, userId?: string | null): SessionInfo {
  const id = randomUUID();
  const now = new Date().toISOString();
  stmtInsertSession.run(id, role, now, now, userId ?? null);
  return { id, role };
}

/** Parse the title out of a session's metadata_json blob (defensive). */
function parseTitle(metadataJson: string | null | undefined): string | undefined {
  if (!metadataJson) return undefined;
  try {
    const meta = JSON.parse(metadataJson) as { title?: unknown };
    return typeof meta.title === 'string' ? meta.title : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Normalize a parsed message row to UIMessage. Legacy rows were stored as
 * ModelMessage ({role, content}) without .parts; wrap them so reload never
 * crashes convertToModelMessages. Roles outside the UIMessage union (e.g.
 * 'tool' from old server-synthesized resume rows) coerce to a valid role.
 */
function normalizeToUIMessage(raw: unknown): UIMessage {
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

/**
 * Set the session's auto-generated title. Stored inside the existing
 * metadata_json blob (no schema migration): merges `{...meta, title}` so other
 * metadata keys are preserved. No-op if the session does not exist.
 */
export function setSessionTitle(sessionId: string, title: string): void {
  const row = stmtGetSession.get(sessionId) as SessionRow | undefined;
  if (!row) return;
  let meta: Record<string, unknown> = {};
  try {
    meta = row.metadata_json ? (JSON.parse(row.metadata_json) as Record<string, unknown>) : {};
  } catch {
    meta = {};
  }
  meta.title = title;
  stmtUpdateMetadata.run(JSON.stringify(meta), new Date().toISOString(), sessionId);
}

/** List chat sessions owned by a user (Phase 2 data isolation). Includes the
 *  caller's favorite state per session so the sidebar can star rows without a
 *  second round-trip. */
export function listSessionsForUser(
  userId: string,
): Array<{ id: string; role: Role; createdAt: string; title?: string; status: SessionStatus; favorited: boolean }> {
  const rows = stmtListSessionsForUser.all(userId, userId) as Array<{
    id: string;
    role: Role;
    created_at: string;
    metadata_json: string | null;
    status: SessionStatus;
    favorited: 0 | 1;
  }>;
  return rows.map((r) => ({
    id: r.id,
    role: r.role,
    createdAt: r.created_at,
    title: parseTitle(r.metadata_json),
    status: r.status,
    favorited: r.favorited === 1,
  }));
}

/**
 * Set the background-run status of a session. When transitioning to 'busy',
 * pass a runId and the current timestamp is recorded as current_run_started_at.
 * Setting any non-'busy' status clears run_id and current_run_started_at so a
 * stale run cannot be confused with a live one. No-op if the session does not
 * exist (UPDATE matches zero rows).
 */
export function setSessionStatus(id: string, status: SessionStatus, runId?: string): void {
  const now = new Date().toISOString();
  const startedAt = status === 'busy' ? now : null;
  db.prepare(
    `UPDATE sessions
       SET status = @status,
           run_id = @runId,
           current_run_started_at = @startedAt,
           updated_at = @now
     WHERE id = @id`,
  ).run({ status, runId: runId ?? null, startedAt, now, id });
}

/**
 * Read the background-run status of a session. Returns null if the session does
 * not exist. runId/startedAt are omitted from the result when NULL in the row.
 */
export function getSessionStatus(
  id: string,
): { status: SessionStatus; runId?: string; startedAt?: string } | null {
  const row = db
    .prepare('SELECT status, run_id, current_run_started_at FROM sessions WHERE id = ?')
    .get(id) as
    | { status: SessionStatus; run_id: string | null; current_run_started_at: string | null }
    | undefined;
  if (!row) return null;
  return {
    status: row.status,
    runId: row.run_id ?? undefined,
    startedAt: row.current_run_started_at ?? undefined,
  };
}

/**
 * Boot-time recovery: any session left 'busy' from a previous process was
 * interrupted by a crash/restart. Flip it to 'interrupted' so the UI can flag
 * it and the caller can decide to resume or discard. Safe to call when there
 * are no busy rows (UPDATE matches zero rows).
 */
export function resetBusyOnStartup(): void {
  db.prepare("UPDATE sessions SET status = 'interrupted' WHERE status = 'busy'").run();
}

/**
 * Owner check for data isolation. Returns true iff the session exists AND its
 * user_id matches. A legacy session (user_id NULL, pre-Phase-2) is treated as
 * NOT owned by any authenticated user.
 */
export function sessionBelongsTo(id: string, userId: string): boolean {
  const row = stmtGetSession.get(id) as SessionRow | undefined;
  return !!row && row.user_id === userId;
}

export function loadSession(id: string): LoadedSession | null {
  const row = stmtGetSession.get(id) as SessionRow | undefined;
  if (!row) return null;
  const rows = stmtListMessages.all(id) as MessageRow[];
  const messages = rows.map((r) => normalizeToUIMessage(JSON.parse(r.model_message_json)));
  return { id: row.id, role: row.role, messages, title: parseTitle(row.metadata_json) };
}

/**
 * Delete a chat session and all of its dependent rows (messages, pending
 * approvals, favorites). Returns true if the session existed (and was
 * deleted), false if it was already gone. Callers MUST verify ownership first
 * (sessionBelongsTo) -- this fn does not re-check.
 */
export function deleteSession(id: string): boolean {
  const row = stmtGetSession.get(id) as SessionRow | undefined;
  if (!row) return false;
  const tx = db.transaction(() => {
    stmtDeleteSessionMessages.run(id);
    stmtDeleteSessionPending.run(id);
    stmtDeleteSessionFavorites.run(id);
    stmtDeleteSession.run(id);
  });
  tx();
  return true;
}

// --- session favorites (对话收藏: MVP 用户反馈通道) ---

/** Favorite a session (upsert). Re-favoriting overwrites the note and refreshes
 *  the email snapshot. Returns the stored favorite. Callers MUST verify the
 *  session exists and is owned by userId (sessionBelongsTo) -- this fn does
 *  not re-check, mirroring the other writers here. */
export function setSessionFavorite(
  sessionId: string,
  userId: string,
  userEmail: string | null,
  note: string | null,
): SessionFavorite {
  const now = new Date().toISOString();
  stmtUpsertFavorite.run(sessionId, userId, userEmail, note, now, now);
  return {
    sessionId,
    userId,
    userEmail,
    note,
    createdAt: now,
    updatedAt: now,
  };
}

/** Remove a user's favorite of a session. Returns true if a row was removed. */
export function clearSessionFavorite(sessionId: string, userId: string): boolean {
  return stmtDeleteFavorite.run(sessionId, userId).changes > 0;
}

/** Read one user's favorite of one session (null when not favorited). */
export function getSessionFavorite(sessionId: string, userId: string): SessionFavorite | null {
  const row = stmtGetFavorite.get(sessionId, userId) as FavoriteRow | undefined;
  return row ? toFavorite(row) : null;
}

function toFavorite(row: FavoriteRow): SessionFavorite {
  return {
    sessionId: row.session_id,
    userId: row.user_id,
    userEmail: row.user_email,
    note: row.note,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Map a joined favorites+sessions row to the summary shape (title from
 *  metadata_json, defensive parse). */
function toFavoriteSummary(row: FavoriteRow & { metadata_json: string | null; status: SessionStatus }): SessionFavoriteSummary {
  return { ...toFavorite(row), title: parseTitle(row.metadata_json), status: row.status };
}

/** List one user's favorites with session title/status (newest first).
 *  Favorites of since-deleted sessions drop out via the inner JOIN. */
export function listSessionFavorites(userId: string): SessionFavoriteSummary[] {
  const rows = stmtListFavoritesForUser.all(userId) as Array<FavoriteRow & { metadata_json: string | null; status: SessionStatus }>;
  return rows.map(toFavoriteSummary);
}

/** List EVERY user's favorites (admin feedback inbox). Same shape as
 *  listSessionFavorites plus the per-row userId/userEmail attribution. */
export function listAllSessionFavorites(): SessionFavoriteSummary[] {
  const rows = stmtListAllFavorites.all() as Array<FavoriteRow & { metadata_json: string | null; status: SessionStatus }>;
  return rows.map(toFavoriteSummary);
}

export function appendMessages(sessionId: string, msgs: UIMessage[]): void {
  if (msgs.length === 0) return;
  const maxRow = stmtMaxSeq.get(sessionId) as { max_seq: number } | undefined;
  const startSeq = (maxRow?.max_seq ?? -1) + 1;
  const now = new Date().toISOString();
  const tx = db.transaction((items: UIMessage[]) => {
    items.forEach((msg, i) => {
      stmtInsertMessage.run(
        sessionId,
        startSeq + i,
        JSON.stringify(msg),
      );
    });
    stmtTouchSession.run(now, sessionId);
  });
  tx(msgs);
}

/**
 * Replace a persisted message IN PLACE (same row, same seq) — used by
 * continuation-mode runs (L2 approval resume) to update the continued
 * assistant message (the approval-requested part flips to output-available /
 * output-denied) instead of appending a duplicate with the same id. Linear
 * scan over the session's rows parsing the stored .id is fine (sessions are
 * small; better-sqlite3 is sync). Returns true if a row with that message id
 * was replaced, false if no such message exists.
 */
export function replaceMessage(sessionId: string, message: UIMessage): boolean {
  const rows = stmtListMessages.all(sessionId) as MessageRow[];
  const target = rows.find((r) => {
    try {
      return (JSON.parse(r.model_message_json) as { id?: string }).id === message.id;
    } catch {
      return false;
    }
  });
  if (!target) return false;
  const now = new Date().toISOString();
  stmtReplaceMessage.run(JSON.stringify(message), sessionId, target.seq);
  stmtTouchSession.run(now, sessionId);
  return true;
}

// --- session event replay buffer (phase 2) ---
// Events are a reconnect replay buffer, not SSOT (session_messages is).
// No FK on session_id: buffer writes must not fail for sessions without a
// backing row (tests, degraded modes).

export interface SessionEventRow {
  seq: number;
  type: string;
  payload: Record<string, unknown>;
}

export function appendSessionEvent(sessionId: string, type: string, payload: Record<string, unknown>): number {
  const row = db
    .prepare('SELECT COALESCE(MAX(seq), 0) AS max_seq FROM session_events WHERE session_id = ?')
    .get(sessionId) as { max_seq: number };
  const seq = row.max_seq + 1;
  db.prepare(
    'INSERT INTO session_events (session_id, seq, type, payload_json, created_at) VALUES (?, ?, ?, ?, ?)',
  ).run(sessionId, seq, type, JSON.stringify(payload), new Date().toISOString());
  return seq;
}

export function listSessionEventsSince(sessionId: string, sinceSeq: number): SessionEventRow[] {
  const rows = db
    .prepare('SELECT seq, type, payload_json FROM session_events WHERE session_id = ? AND seq > ? ORDER BY seq ASC')
    .all(sessionId, sinceSeq) as Array<{ seq: number; type: string; payload_json: string }>;
  return rows.map((r) => ({ seq: r.seq, type: r.type, payload: JSON.parse(r.payload_json) as Record<string, unknown> }));
}

export function pruneSessionEvents(sessionId: string): void {
  db.prepare('DELETE FROM session_events WHERE session_id = ?').run(sessionId);
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

export function recordPendingApproval(input: RecordPendingInput): void {
  const id =
    input.ticketId ?? input.approvalId ?? randomUUID();
  stmtInsertPending.run(
    id,
    input.sessionId,
    input.level,
    input.toolName,
    input.toolCallId ?? null,
    JSON.stringify(input.input ?? {}),
    input.ticketId ?? null,
    input.approvalId ?? null,
    'pending',
    new Date().toISOString(),
  );
}

export function resolveApproval(
  id: string,
  status: ApprovalStatus,
): void {
  stmtUpdatePendingStatus.run(status, id);
}

export function getPending(id: string): PendingApprovalRow | null {
  const row = stmtGetPending.get(id) as PendingApprovalRow | undefined;
  return row ?? null;
}

export function listPending(sessionId: string): PendingApprovalRow[] {
  return stmtListPending.all(sessionId) as PendingApprovalRow[];
}

export function countPendingApprovals(sessionId: string): number {
  const row = stmtCountPending.get(sessionId) as { n: number };
  return row.n;
}
