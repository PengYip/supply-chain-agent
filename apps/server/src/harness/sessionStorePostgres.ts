// Postgres backend for the harness session store. Selected by DB_BACKEND=
// postgres (exact string, same convention as pipeline/db/dbBackend.ts); SQLite
// remains the default. Connection: an INDEPENDENT long-lived pg Pool built
// from DATABASE_URL (same dev default as lib/auth.ts -- the sca-pgvector
// container). It deliberately shares nothing with the auth pool or the
// pipeline DbContext: the session store owns its own connection budget.
//
// Schema: ensureSessionTables() runs idempotent CREATE TABLE IF NOT EXISTS on
// first use (mirrors how the SQLite backend self-migrates at import). The DDL
// mirrors the SQLite DDL in sessionStoreSqlite.ts column-for-column:
//   - timestamps stay TEXT (ISO-8601 strings) so ordering and round-trips are
//     byte-identical across backends (lexicographic == chronological for ISO);
//   - JSON payloads (metadata_json / model_message_json / payload_json /
//     input_json) stay TEXT strings, NOT jsonb -- parity over pg ergonomics;
//   - seq columns are INTEGER (int4): they are small per-session counters, so
//     bigint is unnecessary.
// The SAME five tables are also declared as Drizzle pg-core tables in
// pipeline/db/postgres-schema.ts (for drizzle-kit users); the two definitions
// must stay in sync -- each file's comments point at the other.
//
// Concurrency: SQLite relied on its synchronous single-writer for the
// MAX(seq)+1 allocation in appendMessages / appendSessionEvent. Postgres has
// no such guarantee, so both run inside a transaction (BEGIN ... COMMIT) --
// the read+insert pair is serialized per connection for the same table.

import { randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';

import type { UIMessage } from 'ai';
import type { Role } from './roleToolRegistry.js';
import type {
  SessionStoreBackend,
  SessionListItem,
  SessionStatus,
  SessionStatusInfo,
  SessionInfo,
  LoadedSession,
  PendingApprovalRow,
  RecordPendingInput,
  SessionFavorite,
  SessionFavoriteSummary,
  SessionEventRow,
  SessionRow,
  MessageRow,
  FavoriteRow,
} from './sessionStore.js';
import { normalizeToUIMessage, parseTitle } from './sessionStore.js';

/** Same dev default as lib/auth.ts (sca-pgvector docker container). */
const DEFAULT_AGENT_PG_URL =
  'postgresql://sca:sca_dev_password@localhost:5433/sca';

let modulePool: Pool | null = null;

/**
 * Module-level singleton Pool for the runtime path (sessionStore.ts facade).
 * Lazy-connecting like every other pool in the codebase: constructing it never
 * opens a socket; the first query does. Kept SEPARATE from the auth pool and
 * the pipeline DbContext on purpose.
 */
export function getDefaultAgentPool(): Pool {
  modulePool ??= new Pool({
    connectionString: process.env.DATABASE_URL ?? DEFAULT_AGENT_PG_URL,
    // Session-store queries are tiny point lookups; a small dedicated budget
    // (vs. auth's max:10 / pipeline's max:10) keeps the store from crowding
    // the shared Postgres.
    max: 5,
  });
  return modulePool;
}

/**
 * Idempotent DDL for the 5 harness tables (mirrors the SQLite DDL in
 * sessionStoreSqlite.ts, plus the status/run_id/current_run_started_at
 * columns SQLite adds via guarded ALTERs -- CREATE TABLE covers them here).
 * Exported so the migration script (scripts/migrate-agent-db.ts) and the
 * integration test can ensure the schema before touching data.
 *
 * NOTE: the live agent.db also holds a legacy `authorized_tickets` table that
 * no code references -- it is intentionally NOT created here and NOT migrated.
 */
export async function ensureSessionTables(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      role TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      metadata_json TEXT,
      user_id TEXT,
      status TEXT NOT NULL DEFAULT 'idle',
      run_id TEXT,
      current_run_started_at TEXT
    );

    CREATE TABLE IF NOT EXISTS session_messages (
      session_id TEXT NOT NULL REFERENCES sessions(id),
      seq INTEGER NOT NULL,
      model_message_json TEXT NOT NULL,
      PRIMARY KEY (session_id, seq)
    );

    CREATE TABLE IF NOT EXISTS pending_approvals (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id),
      level TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      tool_call_id TEXT,
      input_json TEXT NOT NULL,
      ticket_id TEXT,
      approval_id TEXT,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS session_events (
      -- No FK on session_id (parity with SQLite): the replay buffer accepts
      -- writes for sessions without a backing row (tests, degraded modes).
      session_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (session_id, seq)
    );

    CREATE TABLE IF NOT EXISTS session_favorites (
      session_id TEXT NOT NULL REFERENCES sessions(id),
      user_id TEXT NOT NULL,
      user_email TEXT,
      note TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (session_id, user_id)
    );
  `);
}

/** BEGIN/COMMIT/ROLLBACK helper with guaranteed client release. */
async function withTransaction<T>(pool: Pool, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* connection already broken; surface the original error */
    }
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Build a SessionStoreBackend bound to a specific Pool. The runtime path uses
 * getDefaultAgentPool() via the sessionStore.ts facade; tests build their own
 * Pool against an isolated sca_test database.
 */
export function createAgentSessionStore(pool: Pool): SessionStoreBackend {
  // ensure-once per store instance (the DDL is idempotent; re-running per call
  // would waste a round-trip on every operation).
  let ensurePromise: Promise<void> | null = null;
  const ensure = (): Promise<void> => {
    ensurePromise ??= ensureSessionTables(pool);
    return ensurePromise;
  };

  // Built as a named const so methods can reference siblings (e.g.
  // purgeEmptySessionsForUser -> deleteSession). Method bodies only run after
  // the const is initialized, so the self-reference is safe.
  const store: SessionStoreBackend = {
    async createSession(role: Role, userId?: string | null): Promise<SessionInfo> {
      await ensure();
      const id = randomUUID();
      const now = new Date().toISOString();
      await pool.query(
        'INSERT INTO sessions (id, role, created_at, updated_at, user_id) VALUES ($1, $2, $3, $3, $4)',
        [id, role, now, userId ?? null],
      );
      return { id, role };
    },

    async setSessionTitle(sessionId: string, title: string): Promise<void> {
      await ensure();
      const { rows } = await pool.query<SessionRow>(
        'SELECT id, role, created_at, updated_at, metadata_json, user_id FROM sessions WHERE id = $1',
        [sessionId],
      );
      const row = rows[0];
      if (!row) return;
      let meta: Record<string, unknown> = {};
      try {
        meta = row.metadata_json ? (JSON.parse(row.metadata_json) as Record<string, unknown>) : {};
      } catch {
        meta = {};
      }
      meta.title = title;
      await pool.query(
        'UPDATE sessions SET metadata_json = $1, updated_at = $2 WHERE id = $3',
        [JSON.stringify(meta), new Date().toISOString(), sessionId],
      );
    },

    async listSessionsForUser(userId: string): Promise<SessionListItem[]> {
      await ensure();
      const { rows } = await pool.query<{
        id: string;
        role: Role;
        created_at: string;
        metadata_json: string | null;
        status: SessionStatus;
        favorited: boolean;
        message_count: number;
      }>(
        `SELECT s.id, s.role, s.created_at, s.metadata_json, s.status,
                EXISTS(
                  SELECT 1 FROM session_favorites f
                  WHERE f.session_id = s.id AND f.user_id = $1
                ) AS favorited,
                (SELECT COUNT(*)::int FROM session_messages m WHERE m.session_id = s.id) AS message_count
         FROM sessions s
         WHERE s.user_id = $1
         ORDER BY s.created_at DESC`,
        [userId],
      );
      return rows.map((r) => ({
        id: r.id,
        role: r.role,
        createdAt: r.created_at,
        title: parseTitle(r.metadata_json),
        status: r.status,
        favorited: r.favorited,
        messageCount: Number(r.message_count),
      }));
    },

    async purgeEmptySessionsForUser(userId: string): Promise<number> {
      await ensure();
      const { rows } = await pool.query<{ id: string }>(
        `SELECT s.id FROM sessions s
         WHERE s.user_id = $1
           AND NOT EXISTS (SELECT 1 FROM session_messages m WHERE m.session_id = s.id)`,
        [userId],
      );
      // Reuse deleteSession so the dependent-row cascade (favorites etc.)
      // applies, mirroring the SQLite implementation.
      for (const r of rows) await store.deleteSession(r.id);
      return rows.length;
    },

    async setSessionStatus(id: string, status: SessionStatus, runId?: string): Promise<void> {
      await ensure();
      const now = new Date().toISOString();
      const startedAt = status === 'busy' ? now : null;
      await pool.query(
        `UPDATE sessions
           SET status = $1, run_id = $2, current_run_started_at = $3, updated_at = $4
         WHERE id = $5`,
        [status, runId ?? null, startedAt, now, id],
      );
    },

    async getSessionStatus(id: string): Promise<SessionStatusInfo | null> {
      await ensure();
      const { rows } = await pool.query<{
        status: SessionStatus;
        run_id: string | null;
        current_run_started_at: string | null;
      }>('SELECT status, run_id, current_run_started_at FROM sessions WHERE id = $1', [id]);
      const row = rows[0];
      if (!row) return null;
      return {
        status: row.status,
        runId: row.run_id ?? undefined,
        startedAt: row.current_run_started_at ?? undefined,
      };
    },

    async resetBusyOnStartup(): Promise<void> {
      await ensure();
      await pool.query("UPDATE sessions SET status = 'interrupted' WHERE status = 'busy'");
    },

    async sessionBelongsTo(id: string, userId: string): Promise<boolean> {
      await ensure();
      const { rows } = await pool.query<{ user_id: string | null }>(
        'SELECT user_id FROM sessions WHERE id = $1',
        [id],
      );
      return rows.length > 0 && rows[0]!.user_id === userId;
    },

    async loadSession(id: string): Promise<LoadedSession | null> {
      await ensure();
      const sessionRes = await pool.query<SessionRow>(
        'SELECT id, role, created_at, updated_at, metadata_json, user_id FROM sessions WHERE id = $1',
        [id],
      );
      const row = sessionRes.rows[0];
      if (!row) return null;
      const msgRes = await pool.query<MessageRow>(
        'SELECT seq, model_message_json FROM session_messages WHERE session_id = $1 ORDER BY seq ASC',
        [id],
      );
      const messages = msgRes.rows.map((r) => normalizeToUIMessage(JSON.parse(r.model_message_json)));
      return { id: row.id, role: row.role, messages, title: parseTitle(row.metadata_json) };
    },

    async deleteSession(id: string): Promise<boolean> {
      await ensure();
      return withTransaction(pool, async (client) => {
        const { rows } = await client.query('SELECT 1 FROM sessions WHERE id = $1', [id]);
        if (rows.length === 0) return false;
        // Children first (FKs reference sessions.id), then the parent row --
        // same order as the SQLite transaction.
        await client.query('DELETE FROM session_messages WHERE session_id = $1', [id]);
        await client.query('DELETE FROM pending_approvals WHERE session_id = $1', [id]);
        await client.query('DELETE FROM session_favorites WHERE session_id = $1', [id]);
        await client.query('DELETE FROM sessions WHERE id = $1', [id]);
        return true;
      });
    },

    // --- session favorites (对话收藏: MVP 用户反馈通道) ---

    async setSessionFavorite(
      sessionId: string,
      userId: string,
      userEmail: string | null,
      note: string | null,
    ): Promise<SessionFavorite> {
      await ensure();
      const now = new Date().toISOString();
      await pool.query(
        `INSERT INTO session_favorites (session_id, user_id, user_email, note, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $5)
         ON CONFLICT (session_id, user_id) DO UPDATE SET
           user_email = excluded.user_email,
           note = excluded.note,
           updated_at = excluded.updated_at`,
        [sessionId, userId, userEmail, note, now],
      );
      // Mirror the SQLite return shape: built from the write args, not re-read.
      return { sessionId, userId, userEmail, note, createdAt: now, updatedAt: now };
    },

    async clearSessionFavorite(sessionId: string, userId: string): Promise<boolean> {
      await ensure();
      const { rowCount } = await pool.query(
        'DELETE FROM session_favorites WHERE session_id = $1 AND user_id = $2',
        [sessionId, userId],
      );
      return (rowCount ?? 0) > 0;
    },

    async getSessionFavorite(sessionId: string, userId: string): Promise<SessionFavorite | null> {
      await ensure();
      const { rows } = await pool.query<FavoriteRow>(
        'SELECT * FROM session_favorites WHERE session_id = $1 AND user_id = $2',
        [sessionId, userId],
      );
      const row = rows[0];
      return row ? toFavorite(row) : null;
    },

    async listSessionFavorites(userId: string): Promise<SessionFavoriteSummary[]> {
      await ensure();
      const { rows } = await pool.query<FavoriteRow & { metadata_json: string | null; status: SessionStatus }>(
        `SELECT f.*, s.metadata_json, s.status
         FROM session_favorites f
         JOIN sessions s ON s.id = f.session_id
         WHERE f.user_id = $1
         ORDER BY f.updated_at DESC`,
        [userId],
      );
      return rows.map(toFavoriteSummary);
    },

    async listAllSessionFavorites(): Promise<SessionFavoriteSummary[]> {
      await ensure();
      const { rows } = await pool.query<FavoriteRow & { metadata_json: string | null; status: SessionStatus }>(
        `SELECT f.*, s.metadata_json, s.status
         FROM session_favorites f
         JOIN sessions s ON s.id = f.session_id
         ORDER BY f.updated_at DESC`,
      );
      return rows.map(toFavoriteSummary);
    },

    async appendMessages(sessionId: string, msgs: UIMessage[]): Promise<void> {
      if (msgs.length === 0) return;
      await ensure();
      const now = new Date().toISOString();
      // MAX(seq)+1 inside a transaction: SQLite got atomicity for free from
      // its synchronous single-writer; Postgres needs the explicit BEGIN.
      await withTransaction(pool, async (client) => {
        const { rows } = await client.query<{ max_seq: number | string }>(
          'SELECT COALESCE(MAX(seq), -1) AS max_seq FROM session_messages WHERE session_id = $1',
          [sessionId],
        );
        const startSeq = Number(rows[0]?.max_seq ?? -1) + 1;
        for (let i = 0; i < msgs.length; i++) {
          await client.query(
            'INSERT INTO session_messages (session_id, seq, model_message_json) VALUES ($1, $2, $3)',
            [sessionId, startSeq + i, JSON.stringify(msgs[i])],
          );
        }
        await client.query('UPDATE sessions SET updated_at = $1 WHERE id = $2', [now, sessionId]);
      });
    },

    async replaceMessage(sessionId: string, message: UIMessage): Promise<boolean> {
      await ensure();
      // Resolve the target seq in SQL (the SQLite backend linear-scans parsed
      // JSON instead -- same lookup, different mechanics). Guard the id: a
      // missing id can never match (and node-pg rejects undefined params).
      if (!message.id) return false;
      const found = await pool.query<{ seq: number }>(
        `SELECT seq FROM session_messages
         WHERE session_id = $1 AND model_message_json::jsonb ->> 'id' = $2
         ORDER BY seq ASC
         LIMIT 1`,
        [sessionId, message.id],
      );
      const target = found.rows[0];
      if (!target) return false;
      const now = new Date().toISOString();
      await pool.query(
        'UPDATE session_messages SET model_message_json = $1 WHERE session_id = $2 AND seq = $3',
        [JSON.stringify(message), sessionId, target.seq],
      );
      await pool.query('UPDATE sessions SET updated_at = $1 WHERE id = $2', [now, sessionId]);
      return true;
    },

    // --- session event replay buffer (phase 2) ---

    async appendSessionEvent(
      sessionId: string,
      type: string,
      payload: Record<string, unknown>,
    ): Promise<number> {
      await ensure();
      return withTransaction(pool, async (client) => {
        const { rows } = await client.query<{ max_seq: number | string }>(
          'SELECT COALESCE(MAX(seq), 0) AS max_seq FROM session_events WHERE session_id = $1',
          [sessionId],
        );
        const seq = Number(rows[0]?.max_seq ?? 0) + 1;
        await client.query(
          'INSERT INTO session_events (session_id, seq, type, payload_json, created_at) VALUES ($1, $2, $3, $4, $5)',
          [sessionId, seq, type, JSON.stringify(payload), new Date().toISOString()],
        );
        return seq;
      });
    },

    async listSessionEventsSince(sessionId: string, sinceSeq: number): Promise<SessionEventRow[]> {
      await ensure();
      const { rows } = await pool.query<{ seq: number; type: string; payload_json: string }>(
        'SELECT seq, type, payload_json FROM session_events WHERE session_id = $1 AND seq > $2 ORDER BY seq ASC',
        [sessionId, sinceSeq],
      );
      return rows.map((r) => ({
        seq: Number(r.seq),
        type: r.type,
        payload: JSON.parse(r.payload_json) as Record<string, unknown>,
      }));
    },

    async pruneSessionEvents(sessionId: string): Promise<void> {
      await ensure();
      await pool.query('DELETE FROM session_events WHERE session_id = $1', [sessionId]);
    },

    async recordPendingApproval(input: RecordPendingInput): Promise<void> {
      await ensure();
      const id = input.ticketId ?? input.approvalId ?? randomUUID();
      await pool.query(
        `INSERT INTO pending_approvals
           (id, session_id, level, tool_name, tool_call_id, input_json, ticket_id, approval_id, status, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending', $9)`,
        [
          id,
          input.sessionId,
          input.level,
          input.toolName,
          input.toolCallId ?? null,
          JSON.stringify(input.input ?? {}),
          input.ticketId ?? null,
          input.approvalId ?? null,
          new Date().toISOString(),
        ],
      );
    },

    async resolveApproval(id: string, status: 'pending' | 'approved' | 'denied'): Promise<void> {
      await ensure();
      await pool.query('UPDATE pending_approvals SET status = $1 WHERE id = $2', [status, id]);
    },

    async getPending(id: string): Promise<PendingApprovalRow | null> {
      await ensure();
      const { rows } = await pool.query<PendingApprovalRow>(
        'SELECT * FROM pending_approvals WHERE id = $1',
        [id],
      );
      return rows[0] ?? null;
    },

    async listPending(sessionId: string): Promise<PendingApprovalRow[]> {
      await ensure();
      const { rows } = await pool.query<PendingApprovalRow>(
        "SELECT * FROM pending_approvals WHERE session_id = $1 AND status = 'pending' ORDER BY created_at ASC",
        [sessionId],
      );
      return rows;
    },

    async countPendingApprovals(sessionId: string): Promise<number> {
      await ensure();
      const { rows } = await pool.query<{ n: number | string }>(
        "SELECT COUNT(*) AS n FROM pending_approvals WHERE session_id = $1 AND status = 'pending'",
        [sessionId],
      );
      return Number(rows[0]?.n ?? 0);
    },
  };

  return store;

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

  function toFavoriteSummary(
    row: FavoriteRow & { metadata_json: string | null; status: SessionStatus },
  ): SessionFavoriteSummary {
    return { ...toFavorite(row), title: parseTitle(row.metadata_json), status: row.status };
  }
}
