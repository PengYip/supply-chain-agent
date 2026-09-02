// SQLite backend for the harness session store (sessions / messages / pending
// approvals / session events / favorites). This is the DEFAULT backend
// (local dev + CI); the Postgres backend lives in sessionStorePostgres.ts and
// is selected by DB_BACKEND=postgres in sessionStore.ts (the facade).
//
// The module keeps the historical better-sqlite3 implementation verbatim (WAL
// file at apps/server/data/agent.db, prepared statements, guarded legacy
// ALTERs); only the exported API changed from sync to async so BOTH backends
// share one call-site shape (callers `await` once -- the same pattern as the
// pipeline repositories). better-sqlite3 calls stay synchronous internally.
//
// NOTE: the old module-level `export const db` (better-sqlite3 instance) was
// REMOVED in the dual-backend split -- no consumer imported it (verified by
// grep across src/ + test/), and exposing it would leak sqlite-only semantics
// through the backend-neutral facade. The handle is internal to this module.
//
// This module is only ever loaded via dynamic import from sessionStore.ts when
// DB_BACKEND != 'postgres', so a Postgres deployment never opens agent.db.

import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import Database from 'better-sqlite3';

import type { Role } from './roleToolRegistry.js';
import type { UIMessage } from 'ai';
import type {
  SessionStoreBackend,
  SessionStatus,
  ApprovalStatus,
  PendingApprovalRow,
  RecordPendingInput,
  SessionRow,
  MessageRow,
  FavoriteRow,
} from './sessionStore.js';
import { normalizeToUIMessage, parseTitle, parseMetadata } from './sessionStore.js';

// File-backed SQLite (WAL) for durable agent sessions + pending approvals.
// Production swaps this for Postgres (sessionStorePostgres.ts) -- the facade
// API in sessionStore.ts is the abstraction boundary.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, '../../data');
const DB_PATH = path.join(DATA_DIR, 'agent.db');

fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(DB_PATH);
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

// Column types intentionally mirror the Postgres DDL in
// sessionStorePostgres.ts ensureSessionTables() column-for-column (TEXT/INTEGER
// both sides; JSON blobs are stored as TEXT strings, NOT jsonb, so behavior is
// identical across backends).
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

// ---- prepared statements ----

const stmtInsertSession = db.prepare(
  'INSERT INTO sessions (id, role, created_at, updated_at, user_id) VALUES (?, ?, ?, ?, ?)',
);
const stmtGetSession = db.prepare('SELECT * FROM sessions WHERE id = ?');
const stmtListSessionsForUser = db.prepare(`
  SELECT s.id, s.role, s.created_at, s.metadata_json, s.status,
         CASE WHEN f.session_id IS NULL THEN 0 ELSE 1 END AS favorited,
         (SELECT COUNT(*) FROM session_messages m WHERE m.session_id = s.id) AS message_count
  FROM sessions s
  LEFT JOIN session_favorites f ON f.session_id = s.id AND f.user_id = ?
  WHERE s.user_id = ?
  ORDER BY s.created_at DESC
`);
const stmtListEmptySessionsForUser = db.prepare(`
  SELECT s.id FROM sessions s
  WHERE s.user_id = ?
    AND NOT EXISTS (SELECT 1 FROM session_messages m WHERE m.session_id = s.id)
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

// ---- API (async wrappers over the sync better-sqlite3 calls) ----

async function createSession(role: Role, userId?: string | null) {
  const id = randomUUID();
  const now = new Date().toISOString();
  stmtInsertSession.run(id, role, now, now, userId ?? null);
  return { id, role };
}

async function setSessionTitle(sessionId: string, title: string): Promise<void> {
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

async function mergeSessionMetadata(sessionId: string, patch: Record<string, unknown>): Promise<void> {
  const row = stmtGetSession.get(sessionId) as SessionRow | undefined;
  if (!row) return;
  let meta: Record<string, unknown> = {};
  try {
    meta = row.metadata_json ? (JSON.parse(row.metadata_json) as Record<string, unknown>) : {};
  } catch {
    meta = {};
  }
  stmtUpdateMetadata.run(JSON.stringify({ ...meta, ...patch }), new Date().toISOString(), sessionId);
}

async function listSessionsForUser(userId: string) {
  const rows = stmtListSessionsForUser.all(userId, userId) as Array<{
    id: string;
    role: Role;
    created_at: string;
    metadata_json: string | null;
    status: SessionStatus;
    favorited: 0 | 1;
    message_count: number;
  }>;
  return rows.map((r) => ({
    id: r.id,
    role: r.role,
    createdAt: r.created_at,
    title: parseTitle(r.metadata_json),
    status: r.status,
    favorited: r.favorited === 1,
    messageCount: r.message_count,
  }));
}

async function purgeEmptySessionsForUser(userId: string): Promise<number> {
  const rows = stmtListEmptySessionsForUser.all(userId) as Array<{ id: string }>;
  for (const r of rows) await deleteSession(r.id);
  return rows.length;
}

async function setSessionStatus(
  id: string,
  status: SessionStatus,
  runId?: string,
): Promise<void> {
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

async function getSessionStatus(id: string) {
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

async function resetBusyOnStartup(): Promise<void> {
  db.prepare("UPDATE sessions SET status = 'interrupted' WHERE status = 'busy'").run();
}

async function listBusySessionIds(): Promise<string[]> {
  const rows = db.prepare("SELECT id FROM sessions WHERE status = 'busy'").all() as Array<{ id: string }>;
  return rows.map((r) => r.id);
}

async function sessionBelongsTo(id: string, userId: string): Promise<boolean> {
  const row = stmtGetSession.get(id) as SessionRow | undefined;
  return !!row && row.user_id === userId;
}

async function loadSession(id: string) {
  const row = stmtGetSession.get(id) as SessionRow | undefined;
  if (!row) return null;
  const rows = stmtListMessages.all(id) as MessageRow[];
  const messages = rows.map((r) => normalizeToUIMessage(JSON.parse(r.model_message_json)));
  return { id: row.id, role: row.role, messages, title: parseTitle(row.metadata_json), metadata: parseMetadata(row.metadata_json) };
}

async function deleteSession(id: string): Promise<boolean> {
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

async function setSessionFavorite(
  sessionId: string,
  userId: string,
  userEmail: string | null,
  note: string | null,
) {
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

async function clearSessionFavorite(sessionId: string, userId: string): Promise<boolean> {
  return stmtDeleteFavorite.run(sessionId, userId).changes > 0;
}

async function getSessionFavorite(sessionId: string, userId: string) {
  const row = stmtGetFavorite.get(sessionId, userId) as FavoriteRow | undefined;
  return row ? toFavorite(row) : null;
}

function toFavorite(row: FavoriteRow) {
  return {
    sessionId: row.session_id,
    userId: row.user_id,
    userEmail: row.user_email,
    note: row.note,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toFavoriteSummary(row: FavoriteRow & { metadata_json: string | null; status: SessionStatus }) {
  return { ...toFavorite(row), title: parseTitle(row.metadata_json), status: row.status };
}

async function listSessionFavorites(userId: string) {
  const rows = stmtListFavoritesForUser.all(userId) as Array<FavoriteRow & { metadata_json: string | null; status: SessionStatus }>;
  return rows.map(toFavoriteSummary);
}

async function listAllSessionFavorites() {
  const rows = stmtListAllFavorites.all() as Array<FavoriteRow & { metadata_json: string | null; status: SessionStatus }>;
  return rows.map(toFavoriteSummary);
}

async function appendMessages(sessionId: string, msgs: UIMessage[]): Promise<void> {
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

async function replaceMessage(sessionId: string, message: UIMessage): Promise<boolean> {
  // Linear scan over the session's rows parsing the stored .id is fine (sessions
  // are small; better-sqlite3 is sync). The Postgres backend implements the same
  // lookup in SQL (model_message_json::jsonb ->> 'id') -- see
  // sessionStorePostgres.ts.
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

async function appendSessionEvent(
  sessionId: string,
  type: string,
  payload: Record<string, unknown>,
): Promise<number> {
  const row = db
    .prepare('SELECT COALESCE(MAX(seq), 0) AS max_seq FROM session_events WHERE session_id = ?')
    .get(sessionId) as { max_seq: number };
  const seq = row.max_seq + 1;
  db.prepare(
    'INSERT INTO session_events (session_id, seq, type, payload_json, created_at) VALUES (?, ?, ?, ?, ?)',
  ).run(sessionId, seq, type, JSON.stringify(payload), new Date().toISOString());
  return seq;
}

async function listSessionEventsSince(sessionId: string, sinceSeq: number) {
  const rows = db
    .prepare('SELECT seq, type, payload_json FROM session_events WHERE session_id = ? AND seq > ? ORDER BY seq ASC')
    .all(sessionId, sinceSeq) as Array<{ seq: number; type: string; payload_json: string }>;
  return rows.map((r) => ({ seq: r.seq, type: r.type, payload: JSON.parse(r.payload_json) as Record<string, unknown> }));
}

async function pruneSessionEvents(sessionId: string): Promise<void> {
  db.prepare('DELETE FROM session_events WHERE session_id = ?').run(sessionId);
}

async function recordPendingApproval(input: RecordPendingInput): Promise<void> {
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

async function resolveApproval(
  id: string,
  status: ApprovalStatus,
): Promise<void> {
  stmtUpdatePendingStatus.run(status, id);
}

async function getPending(id: string): Promise<PendingApprovalRow | null> {
  const row = stmtGetPending.get(id) as PendingApprovalRow | undefined;
  return row ?? null;
}

async function listPending(sessionId: string): Promise<PendingApprovalRow[]> {
  return stmtListPending.all(sessionId) as PendingApprovalRow[];
}

async function countPendingApprovals(sessionId: string): Promise<number> {
  const row = stmtCountPending.get(sessionId) as { n: number };
  return row.n;
}

/** Backend object handed to the sessionStore.ts facade (structural contract). */
export const sqliteSessionStore: SessionStoreBackend = {
  createSession,
  setSessionTitle,
  mergeSessionMetadata,
  listSessionsForUser,
  purgeEmptySessionsForUser,
  setSessionStatus,
  getSessionStatus,
  resetBusyOnStartup,
  listBusySessionIds,
  sessionBelongsTo,
  loadSession,
  deleteSession,
  setSessionFavorite,
  clearSessionFavorite,
  getSessionFavorite,
  listSessionFavorites,
  listAllSessionFavorites,
  appendMessages,
  replaceMessage,
  appendSessionEvent,
  listSessionEventsSince,
  pruneSessionEvents,
  recordPendingApproval,
  resolveApproval,
  getPending,
  listPending,
  countPendingApprovals,
};
