// Postgres backend integration test for the harness session store
// (sessionStorePostgres.ts). Genuinely exercises createSession / loadSession /
// appendMessages / replaceMessage / favorites / pendingApprovals /
// sessionEvents against a real Postgres, via a PRIVATE Pool bound to the
// isolated test database -- it never touches the app's module-level pool.
//
// Skip-guard mirrors test/pipeline/postgres.integration.test.ts: this file is
// a no-op unless a PG target was requested (DB_BACKEND=postgres or
// PG_TEST_URL / DATABASE_URL set), so the default SQLite CI lane never breaks.
//
// TRUNCATE SAFETY GATE (same incident class as the pipeline test, 2026-08-17):
// beforeEach TRUNCATEs the 5 harness tables in the TARGET database. The
// connection string (PG_TEST_URL first, then DATABASE_URL) MUST resolve to a
// database whose name contains "test" (use the dedicated sca_test DB -- see
// docs/postgres-migration-runbook.md), or PG_TRUNCATE_OK=1 must be set
// explicitly. If PG was requested but the gate does not pass, the suite FAILS
// LOUDLY in beforeAll (it does NOT silently truncate a non-test database).

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { Pool } from 'pg';
import type { UIMessage } from 'ai';
import { createAgentSessionStore, ensureSessionTables } from '../../src/harness/sessionStorePostgres.js';

// ---- gate (mirrors postgres.integration.test.ts) --------------------------

function resolvePgTestUrl(): string | undefined {
  return process.env.PG_TEST_URL ?? process.env.DATABASE_URL ?? undefined;
}

function resolvePgDbName(): string | null {
  const url = resolvePgTestUrl();
  if (!url) return null;
  try {
    const dbName = decodeURIComponent(new URL(url).pathname.replace(/^\//, ''));
    return dbName || null;
  } catch {
    return null;
  }
}

function pgTruncateAllowed(): boolean {
  const dbName = resolvePgDbName();
  return (
    (dbName !== null && dbName.includes('test')) || process.env.PG_TRUNCATE_OK === '1'
  );
}

function pgGatePassed(): boolean {
  const pgRequested =
    process.env.DB_BACKEND === 'postgres' || !!process.env.PG_TEST_URL || !!process.env.DATABASE_URL;
  return pgRequested && pgTruncateAllowed();
}

const RUN_PG = pgGatePassed();

if (!RUN_PG) {
  const targetUrl = resolvePgTestUrl();
  const dbName = resolvePgDbName();
  const pgRequested =
    process.env.DB_BACKEND === 'postgres' || !!process.env.PG_TEST_URL || !!process.env.DATABASE_URL;
  console.warn(
    [
      '====================================================================',
      '[PG 会话库集成测试已跳过] sessionStore.postgres.integration.test.ts',
      '的 beforeEach 会对 harness 5 张会话表执行 TRUNCATE。',
      `当前连接串：${targetUrl ?? '未设置（PG_TEST_URL / DATABASE_URL 均缺失）'}`,
      `解析出的库名：${dbName ?? '（无连接串或解析失败）'}`,
      pgRequested
        ? '已请求 PG 但目标库名不含 "test" 且未设置 PG_TRUNCATE_OK=1。'
        : '未请求 PG 后端（DB_BACKEND / PG_TEST_URL / DATABASE_URL 均未设置）。',
      '请使用独立测试库 sca_test（创建步骤见 docs/postgres-migration-runbook.md）。',
      '====================================================================',
    ].join('\n'),
  );
}

// ---- fixtures -------------------------------------------------------------

const uiMsg = (id: string, text: string): UIMessage =>
  ({ id, role: 'user', parts: [{ type: 'text', text }] }) as UIMessage;

describe.skipIf(!RUN_PG)('sessionStore postgres backend', () => {
  let pool: Pool;
  let store: ReturnType<typeof createAgentSessionStore>;

  beforeAll(async () => {
    // Double gate: skipIf and the actual connection target must agree (guards
    // against env changing between file load and beforeAll). Fail loudly
    // rather than truncating a non-test database.
    if (!pgGatePassed()) {
      throw new Error(
        `PG 会话库集成测试门禁未通过：目标库名 ${resolvePgDbName() ?? '（未解析）'} ` +
          '不含 "test" 且未设置 PG_TRUNCATE_OK=1，拒绝执行 TRUNCATE。',
      );
    }
    pool = new Pool({ connectionString: resolvePgTestUrl(), max: 5 });
    // Provision the 5 tables idempotently (same DDL the runtime backend and
    // scripts/migrate-agent-db.ts use) so a fresh sca_test just works.
    await ensureSessionTables(pool);
    store = createAgentSessionStore(pool);
  });

  beforeEach(async () => {
    // Isolation: wipe the harness tables between tests. Child tables first
    // (they reference sessions), then sessions. session_events has no FK.
    await pool.query(
      'TRUNCATE session_messages, pending_approvals, session_events, session_favorites, sessions',
    );
  });

  afterAll(async () => {
    if (pool) await pool.end();
  });

  // ---- sessions + messages -------------------------------------------------

  it('createSession + loadSession round-trip with messages', async () => {
    const s = await store.createSession('trader', 'pg-u1');
    expect(s.id).toBeTruthy();
    expect((await store.loadSession(s.id))?.messages).toEqual([]);

    await store.appendMessages(s.id, [uiMsg('m1', '查合同 HT-1'), uiMsg('m2', '汇总')]);
    const loaded = await store.loadSession(s.id);
    expect(loaded?.role).toBe('trader');
    expect(loaded?.messages.map((m) => m.id)).toEqual(['m1', 'm2']);

    // appendMessages assigns contiguous seq from MAX(seq)+1.
    await store.appendMessages(s.id, [uiMsg('m3', '再补一条')]);
    const again = await store.loadSession(s.id);
    expect(again?.messages).toHaveLength(3);
  });

  it('loadSession returns null for unknown id', async () => {
    expect(await store.loadSession('no-such-session')).toBeNull();
  });

  it('setSessionTitle persists into metadata_json (merge, not replace)', async () => {
    const s = await store.createSession('trader', 'pg-u1');
    await store.setSessionTitle(s.id, '柴油合同查询');
    const loaded = await store.loadSession(s.id);
    expect(loaded?.title).toBe('柴油合同查询');
  });

  it('loadSession normalizes legacy ModelMessage rows (parity with SQLite backend)', async () => {
    const s = await store.createSession('trader', 'pg-u1');
    // Hand-plant a legacy {role, content} row without .parts -- loadSession
    // must wrap it into a UIMessage instead of crashing downstream.
    await pool.query(
      'INSERT INTO session_messages (session_id, seq, model_message_json) VALUES ($1, 0, $2)',
      [s.id, JSON.stringify({ role: 'user', content: '旧格式消息' })],
    );
    const loaded = await store.loadSession(s.id);
    expect(loaded?.messages).toHaveLength(1);
    expect(loaded?.messages[0]?.parts[0]).toMatchObject({ type: 'text', text: '旧格式消息' });
  });

  it('replaceMessage updates in place by message.id; false when absent', async () => {
    const s = await store.createSession('trader', 'pg-u1');
    await store.appendMessages(s.id, [uiMsg('keep-1', 'a'), uiMsg('edit-me', 'b')]);
    const next = { id: 'edit-me', role: 'user' as const, parts: [{ type: 'text' as const, text: 'b2' }] };
    expect(await store.replaceMessage(s.id, next as UIMessage)).toBe(true);
    const loaded = await store.loadSession(s.id);
    expect(loaded?.messages).toHaveLength(2); // in place, no append
    expect(loaded?.messages[1]?.parts[0]).toMatchObject({ text: 'b2' });

    const ghost = { id: 'does-not-exist', role: 'user' as const, parts: [] };
    expect(await store.replaceMessage(s.id, ghost as UIMessage)).toBe(false);
  });

  // ---- listing / ownership / purge ------------------------------------------

  it('listSessionsForUser scopes by user, carries status/favorited/messageCount', async () => {
    const mine = await store.createSession('trader', 'pg-me');
    await store.createSession('trader', 'pg-other');
    await store.appendMessages(mine.id, [uiMsg('m1', 'x')]);
    await store.setSessionStatus(mine.id, 'busy', 'run-1');
    await store.setSessionFavorite(mine.id, 'pg-me', 'me@t', null);

    const rows = await store.listSessionsForUser('pg-me');
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.id).toBe(mine.id);
    expect(row.status).toBe('busy');
    expect(row.favorited).toBe(true);
    expect(row.messageCount).toBe(1);

    // Status lifecycle: busy -> idle clears runId (resetBusyOnStartup flips busy).
    await store.setSessionStatus(mine.id, 'idle');
    const st = await store.getSessionStatus(mine.id);
    expect(st?.status).toBe('idle');
    expect(st?.runId).toBeUndefined();
    await store.setSessionStatus(mine.id, 'busy', 'run-2');
    await store.resetBusyOnStartup();
    expect((await store.getSessionStatus(mine.id))?.status).toBe('interrupted');
  });

  it('sessionBelongsTo is owner-scoped; legacy NULL user owns nothing', async () => {
    const s = await store.createSession('trader', 'pg-owner');
    expect(await store.sessionBelongsTo(s.id, 'pg-owner')).toBe(true);
    expect(await store.sessionBelongsTo(s.id, 'pg-intruder')).toBe(false);
    const legacy = await store.createSession('trader', null);
    expect(await store.sessionBelongsTo(legacy.id, 'pg-owner')).toBe(false);
  });

  it('purgeEmptySessionsForUser removes only the caller\'s empty sessions', async () => {
    await store.createSession('trader', 'pg-purge'); // mine, empty
    const used = await store.createSession('trader', 'pg-purge'); // mine, has messages
    await store.appendMessages(used.id, [uiMsg('m1', 'x')]);
    await store.createSession('trader', 'pg-purge-other'); // someone else's, empty

    expect(await store.purgeEmptySessionsForUser('pg-purge')).toBe(1);
    expect(await store.listSessionsForUser('pg-purge')).toHaveLength(1); // the used one
    expect(await store.listSessionsForUser('pg-purge-other')).toHaveLength(1);
  });

  it('deleteSession cascades to messages/favorites/approvals; false when gone', async () => {
    const s = await store.createSession('trader', 'pg-del');
    await store.appendMessages(s.id, [uiMsg('m1', 'x')]);
    await store.setSessionFavorite(s.id, 'pg-del', 'd@t', 'note');
    await store.recordPendingApproval({
      sessionId: s.id, level: 'L3', toolName: 'escalate_to_human', input: {}, ticketId: 'ESC-del',
    });

    expect(await store.deleteSession(s.id)).toBe(true);
    expect(await store.deleteSession(s.id)).toBe(false);
    expect(await store.loadSession(s.id)).toBeNull();
    expect(await store.getSessionFavorite(s.id, 'pg-del')).toBeNull();
    expect(await store.listPending(s.id)).toEqual([]);
    const cnt = await pool.query('SELECT count(*)::int AS n FROM session_messages WHERE session_id = $1', [s.id]);
    expect(Number(cnt.rows[0].n)).toBe(0);
  });

  // ---- favorites -------------------------------------------------------------

  it('favorites upsert/read/clear/list with title join', async () => {
    const s = await store.createSession('trader', 'pg-fav');
    await store.setSessionTitle(s.id, '收藏标题');
    const fav = await store.setSessionFavorite(s.id, 'pg-fav', 'f@t', '好用');
    expect(fav.note).toBe('好用');

    // Upsert overwrites the note + email snapshot.
    await store.setSessionFavorite(s.id, 'pg-fav', 'f2@t', '更新备注');
    const got = await store.getSessionFavorite(s.id, 'pg-fav');
    expect(got?.note).toBe('更新备注');
    expect(got?.userEmail).toBe('f2@t');

    const mine = await store.listSessionFavorites('pg-fav');
    expect(mine).toHaveLength(1);
    expect(mine[0]!.title).toBe('收藏标题');
    expect(mine[0]!.status).toBe('idle');

    const all = await store.listAllSessionFavorites();
    expect(all.map((r) => r.sessionId)).toContain(s.id);

    expect(await store.clearSessionFavorite(s.id, 'pg-fav')).toBe(true);
    expect(await store.clearSessionFavorite(s.id, 'pg-fav')).toBe(false);
    expect(await store.getSessionFavorite(s.id, 'pg-fav')).toBeNull();
  });

  // ---- pending approvals -------------------------------------------------------

  it('recordPendingApproval / getPending / listPending / resolveApproval / count', async () => {
    const s = await store.createSession('trader', 'pg-ap');
    await store.recordPendingApproval({
      sessionId: s.id,
      level: 'L3',
      toolName: 'escalate_to_human',
      input: { issue: 'x' },
      ticketId: 'ESC-pg-1',
    });
    await store.recordPendingApproval({
      sessionId: s.id,
      level: 'L2',
      toolName: 'tag_document',
      input: { docId: 'd1' },
      approvalId: 'ap-pg-1',
      toolCallId: 'call-1',
    });

    expect(await store.countPendingApprovals(s.id)).toBe(2);

    const got = await store.getPending('ESC-pg-1');
    expect(got?.level).toBe('L3');
    expect(got?.ticket_id).toBe('ESC-pg-1');
    expect(JSON.parse(got!.input_json)).toEqual({ issue: 'x' });

    const listed = await store.listPending(s.id);
    expect(listed).toHaveLength(2);
    expect(listed.every((p) => p.status === 'pending')).toBe(true);

    await store.resolveApproval('ap-pg-1', 'approved');
    expect((await store.getPending('ap-pg-1'))?.status).toBe('approved');
    expect(await store.countPendingApprovals(s.id)).toBe(1); // only the L3 remains
    expect((await store.listPending(s.id)).map((p) => p.id)).toEqual(['ESC-pg-1']);
  });

  // ---- session events (replay buffer) ------------------------------------------

  it('session events: seq allocation, listSince, prune (per-session counters)', async () => {
    const a = await store.createSession('trader', 'pg-ev');
    const b = await store.createSession('trader', 'pg-ev');
    expect(await store.appendSessionEvent(a.id, 'run.started', { runId: 'r1' })).toBe(1);
    expect(await store.appendSessionEvent(a.id, 'message.part', { part: {} })).toBe(2);
    expect(await store.appendSessionEvent(b.id, 'run.started', { runId: 'r2' })).toBe(1);

    const since = await store.listSessionEventsSince(a.id, 1);
    expect(since.map((r) => r.type)).toEqual(['message.part']);
    expect(since[0]!.seq).toBe(2);
    expect(await store.listSessionEventsSince('unknown', 0)).toEqual([]);

    await store.pruneSessionEvents(a.id);
    expect(await store.listSessionEventsSince(a.id, 0)).toEqual([]);
    expect((await store.listSessionEventsSince(b.id, 0)).length).toBe(1);
  });
});
