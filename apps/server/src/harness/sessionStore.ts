import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import Database from 'better-sqlite3';
import type { ModelMessage } from 'ai';

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
`);

// Phase 2: add user_id to pre-existing dev databases (CREATE TABLE IF NOT EXISTS
// does not add columns to an already-existing table). Idempotent + guarded.
{
  const cols = db.prepare('PRAGMA table_info(sessions)').all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === 'user_id')) {
    db.exec('ALTER TABLE sessions ADD COLUMN user_id TEXT');
  }
}

// ---- types ----

export interface SessionInfo {
  id: string;
  role: Role;
}

export interface LoadedSession {
  id: string;
  role: Role;
  messages: ModelMessage[];
}

export type ApprovalLevel = 'L2' | 'L3';
export type ApprovalStatus = 'pending' | 'approved' | 'denied';

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
  'SELECT id, role, created_at FROM sessions WHERE user_id = ? ORDER BY created_at DESC',
);
const stmtTouchSession = db.prepare(
  'UPDATE sessions SET updated_at = ? WHERE id = ?',
);
const stmtMaxSeq = db.prepare(
  'SELECT COALESCE(MAX(seq), -1) AS max_seq FROM session_messages WHERE session_id = ?',
);
const stmtInsertMessage = db.prepare(
  'INSERT INTO session_messages (session_id, seq, model_message_json) VALUES (?, ?, ?)',
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

// ---- API ----

export function createSession(role: Role, userId?: string | null): SessionInfo {
  const id = randomUUID();
  const now = new Date().toISOString();
  stmtInsertSession.run(id, role, now, now, userId ?? null);
  return { id, role };
}

/** List chat sessions owned by a user (Phase 2 data isolation). */
export function listSessionsForUser(
  userId: string,
): Array<{ id: string; role: Role; createdAt: string }> {
  const rows = stmtListSessionsForUser.all(userId) as Array<{
    id: string;
    role: Role;
    created_at: string;
  }>;
  return rows.map((r) => ({ id: r.id, role: r.role, createdAt: r.created_at }));
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
  const messages = rows.map((r) => JSON.parse(r.model_message_json) as ModelMessage);
  return { id: row.id, role: row.role, messages };
}

export function appendMessages(sessionId: string, msgs: ModelMessage[]): void {
  if (msgs.length === 0) return;
  const maxRow = stmtMaxSeq.get(sessionId) as { max_seq: number } | undefined;
  const startSeq = (maxRow?.max_seq ?? -1) + 1;
  const now = new Date().toISOString();
  const tx = db.transaction((items: ModelMessage[]) => {
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
