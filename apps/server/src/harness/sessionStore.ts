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
db.pragma('journal_mode = WAL');

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

CREATE TABLE IF NOT EXISTS authorized_tickets (
  ticket_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  authorized_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS session_events (
  session_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (session_id, seq)
);
`);

// Phase 2: add user_id to pre-existing dev databases (CREATE TABLE IF NOT EXISTS
// does not add columns to an already-existing table). Idempotent + guarded.
{
  const cols = db.prepare('PRAGMA table_info(sessions)').all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === 'user_id')) {
    db.exec('ALTER TABLE sessions ADD COLUMN user_id TEXT');
  }
}

// Background session runtime: add status / run_id / current_run_started_at to
// pre-existing dev databases. Same idempotent PRAGMA-check guard as user_id
// above (CREATE TABLE IF NOT EXISTS cannot add columns to an existing table).
// Defaults to 'idle' so legacy rows are treated as not running.
{
  const cols = db.prepare('PRAGMA table_info(sessions)').all() as Array<{ name: string }>;
  const has = (name: string): boolean => cols.some((c) => c.name === name);
  if (!has('status')) {
    db.exec("ALTER TABLE sessions ADD COLUMN status TEXT NOT NULL DEFAULT 'idle'");
  }
  if (!has('run_id')) {
    db.exec('ALTER TABLE sessions ADD COLUMN run_id TEXT');
  }
  if (!has('current_run_started_at')) {
    db.exec('ALTER TABLE sessions ADD COLUMN current_run_started_at TEXT');
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

// ---- prepared statements ----

const stmtInsertSession = db.prepare(
  'INSERT INTO sessions (id, role, created_at, updated_at, user_id) VALUES (?, ?, ?, ?, ?)',
);
const stmtGetSession = db.prepare('SELECT * FROM sessions WHERE id = ?');
const stmtListSessionsForUser = db.prepare(
  'SELECT id, role, created_at, metadata_json, status FROM sessions WHERE user_id = ? ORDER BY created_at DESC',
);
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
const stmtInsertTicket = db.prepare(
  'INSERT OR IGNORE INTO authorized_tickets (ticket_id, session_id, authorized_at) VALUES (?, ?, ?)',
);
const stmtHasTicket = db.prepare(
  'SELECT ticket_id FROM authorized_tickets WHERE ticket_id = ? AND session_id = ?',
);
const stmtDeleteSession = db.prepare('DELETE FROM sessions WHERE id = ?');
const stmtDeleteSessionMessages = db.prepare('DELETE FROM session_messages WHERE session_id = ?');
const stmtDeleteSessionPending = db.prepare('DELETE FROM pending_approvals WHERE session_id = ?');
const stmtDeleteSessionTickets = db.prepare('DELETE FROM authorized_tickets WHERE session_id = ?');

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

/** List chat sessions owned by a user (Phase 2 data isolation). */
export function listSessionsForUser(
  userId: string,
): Array<{ id: string; role: Role; createdAt: string; title?: string; status: SessionStatus }> {
  const rows = stmtListSessionsForUser.all(userId) as Array<{
    id: string;
    role: Role;
    created_at: string;
    metadata_json: string | null;
    status: SessionStatus;
  }>;
  return rows.map((r) => ({
    id: r.id,
    role: r.role,
    createdAt: r.created_at,
    title: parseTitle(r.metadata_json),
    status: r.status,
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
 * approvals, authorized tickets). Returns true if the session existed (and was
 * deleted), false if it was already gone. Callers MUST verify ownership first
 * (sessionBelongsTo) -- this fn does not re-check.
 */
export function deleteSession(id: string): boolean {
  const row = stmtGetSession.get(id) as SessionRow | undefined;
  if (!row) return false;
  const tx = db.transaction(() => {
    stmtDeleteSessionMessages.run(id);
    stmtDeleteSessionPending.run(id);
    stmtDeleteSessionTickets.run(id);
    stmtDeleteSession.run(id);
  });
  tx();
  return true;
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

export function addAuthorizedTicket(
  ticketId: string,
  sessionId: string,
): void {
  stmtInsertTicket.run(ticketId, sessionId, new Date().toISOString());
}

export function isAuthorized(
  ticketId: string,
  sessionId: string,
): boolean {
  return stmtHasTicket.get(ticketId, sessionId) !== undefined;
}
