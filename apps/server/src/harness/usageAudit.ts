// Usage audit (2026-08-31): durable record of every LLM call and every
// document parse (digital/OCR) for the /api/audit page.
//
// Design (docs/superpowers/specs/2026-08-31-usage-audit-design.md):
//  - Two tables, dual-backend raw SQL (SQLite `?` placeholders via better-
//    sqlite3; Postgres `$n` via the pool), mirroring the quotas dual-track
//    pattern. DDL lives in db/client.ts (both backends).
//  - recordLlmCall/recordOcrCall are FIRE-AND-FORGET: they never throw, never
//    block the chat/parse hot path (same contract as title-gen). A failure
//    logs one warning line and drops the record.
//  - Body text is truncated to PREVIEW_CHARS; the *_chars columns keep the
//    full length so the UI can annotate truncation.
//  - Retention: purgeOldUsageRecords() deletes rows older than RETENTION_DAYS.

import type { DbContext } from '../pipeline/db/client.js';
import { getDbContext } from '../pipeline/db/dbBackend.js';

const PREVIEW_CHARS = 2000;
const RETENTION_DAYS = 90;

const rid = (p: string) => `${p}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

export type LlmCallKind = 'chat' | 'title' | 'compaction' | string;

export interface LlmCallRecord {
  sessionId?: string;
  userId?: string;
  kind: LlmCallKind;
  model?: string;
  inputTokens?: number | null;
  outputTokens?: number | null;
  totalTokens?: number | null;
  /** Full input text; stored truncated to PREVIEW_CHARS. */
  inputText?: string;
  /** Full output text; stored truncated to PREVIEW_CHARS. */
  outputText?: string;
  durationMs?: number | null;
  finishReason?: string | null;
  status?: 'ok' | 'error';
  error?: string | null;
}

export interface OcrCallRecord {
  sessionId?: string;
  userId?: string;
  docId: string;
  docType?: string;
  fileName?: string;
  backend: 'digital' | 'mineru' | 'qianfan' | string;
  fileBytes?: number | null;
  pages?: number | null;
  blocks?: number | null;
  durationMs?: number | null;
  status?: 'ok' | 'error';
  error?: string | null;
}

function truncate(s: string | undefined | null): { preview: string; chars: number } {
  const full = s ?? '';
  return { preview: full.slice(0, PREVIEW_CHARS), chars: full.length };
}

/** Best-effort persist; resolves true on success. */
async function persistLlmCall(ctx: DbContext, rec: LlmCallRecord): Promise<boolean> {
  const id = rid('LLM');
  const input = truncate(rec.inputText);
  const output = truncate(rec.outputText);
  const createdAt = new Date().toISOString();
  if (ctx.backend === 'postgres') {
    await ctx.pool.query(
      `INSERT INTO llm_calls
         (id, session_id, user_id, kind, model, input_tokens, output_tokens, total_tokens,
          input_preview, output_preview, input_chars, output_chars,
          duration_ms, finish_reason, status, error, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
      [id, rec.sessionId ?? null, rec.userId ?? null, rec.kind, rec.model ?? null,
        rec.inputTokens ?? null, rec.outputTokens ?? null, rec.totalTokens ?? null,
        input.preview, output.preview, input.chars, output.chars,
        rec.durationMs ?? null, rec.finishReason ?? null, rec.status ?? 'ok',
        rec.error ? rec.error.slice(0, PREVIEW_CHARS) : null, createdAt],
    );
  } else {
    ctx.sqlite
      .prepare(
        `INSERT INTO llm_calls
           (id, session_id, user_id, kind, model, input_tokens, output_tokens, total_tokens,
            input_preview, output_preview, input_chars, output_chars,
            duration_ms, finish_reason, status, error, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(id, rec.sessionId ?? null, rec.userId ?? null, rec.kind, rec.model ?? null,
        rec.inputTokens ?? null, rec.outputTokens ?? null, rec.totalTokens ?? null,
        input.preview, output.preview, input.chars, output.chars,
        rec.durationMs ?? null, rec.finishReason ?? null, rec.status ?? 'ok',
        rec.error ? rec.error.slice(0, PREVIEW_CHARS) : null, createdAt);
  }
  return true;
}

/** Pending record promises — lets tests await fire-and-forget writes. */
const pending: Array<Promise<unknown>> = [];
function track(p: Promise<unknown>): void {
  pending.push(p);
  void p.finally(() => {
    const i = pending.indexOf(p);
    if (i >= 0) pending.splice(i, 1);
  });
}

/** Await all in-flight fire-and-forget writes (test seam). */
export async function flushUsageAudit(): Promise<void> {
  await Promise.allSettled([...pending]);
}

/** Fire-and-forget LLM call audit. Never throws. */
export function recordLlmCall(rec: LlmCallRecord): void {
  track((async () => {
    try {
      await persistLlmCall(getDbContext(), rec);
    } catch (e) {
      console.warn('[usageAudit] llm record failed:', (e as Error).message);
    }
  })());
}

/** Best-effort persist; resolves true on success. */
async function persistOcrCall(ctx: DbContext, rec: OcrCallRecord): Promise<boolean> {
  const id = rid('OCR');
  const createdAt = new Date().toISOString();
  if (ctx.backend === 'postgres') {
    await ctx.pool.query(
      `INSERT INTO ocr_calls
         (id, session_id, user_id, doc_id, doc_type, file_name, backend,
          file_bytes, pages, blocks, duration_ms, status, error, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [id, rec.sessionId ?? null, rec.userId ?? null, rec.docId, rec.docType ?? null,
        rec.fileName ?? null, rec.backend, rec.fileBytes ?? null, rec.pages ?? null,
        rec.blocks ?? null, rec.durationMs ?? null, rec.status ?? 'ok',
        rec.error ? rec.error.slice(0, PREVIEW_CHARS) : null, createdAt],
    );
  } else {
    ctx.sqlite
      .prepare(
        `INSERT INTO ocr_calls
           (id, session_id, user_id, doc_id, doc_type, file_name, backend,
            file_bytes, pages, blocks, duration_ms, status, error, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(id, rec.sessionId ?? null, rec.userId ?? null, rec.docId, rec.docType ?? null,
        rec.fileName ?? null, rec.backend, rec.fileBytes ?? null, rec.pages ?? null,
        rec.blocks ?? null, rec.durationMs ?? null, rec.status ?? 'ok',
        rec.error ? rec.error.slice(0, PREVIEW_CHARS) : null, createdAt);
  }
  return true;
}

/** Fire-and-forget OCR/parse call audit. Never throws. */
export function recordOcrCall(rec: OcrCallRecord): void {
  track((async () => {
    try {
      await persistOcrCall(getDbContext(), rec);
    } catch (e) {
      console.warn('[usageAudit] ocr record failed:', (e as Error).message);
    }
  })());
}

// ---------------------------------------------------------------------------
// Queries (used by /api/audit)
// ---------------------------------------------------------------------------

export interface AuditSummary {
  range: '7d' | '30d';
  llm: {
    totalCalls: number;
    errorCalls: number;
    totalTokens: number;
    inputTokens: number;
    outputTokens: number;
    byKind: Array<{ kind: string; calls: number; totalTokens: number }>;
    byModel: Array<{ model: string; calls: number; totalTokens: number }>;
    byDay: Array<{ day: string; calls: number; totalTokens: number }>;
  };
  ocr: {
    totalCalls: number;
    errorCalls: number;
    totalPages: number;
    totalDocs: number;
    avgDurationMs: number;
    byBackend: Array<{ backend: string; calls: number; pages: number; avgDurationMs: number }>;
    byDay: Array<{ day: string; calls: number; pages: number }>;
  };
}

const DAY_EXPR_SQLITE = `substr(created_at, 1, 10)`;
const DAY_EXPR_PG = `to_char(created_at, 'YYYY-MM-DD')`;
const SINCE_SQLITE = (days: number) => `datetime('now', '-${days} days')`;
const SINCE_PG = (days: number) => `(NOW() - interval '${days} days')`;

/** Usage summary over the trailing N days (7 or 30). */
export async function usageAuditSummary(ctx: DbContext, days: 7 | 30): Promise<AuditSummary> {
  const isPg = ctx.backend === 'postgres';
  const day = isPg ? DAY_EXPR_PG : DAY_EXPR_SQLITE;
  const since = isPg ? SINCE_PG(days) : SINCE_SQLITE(days);
  const p = (n: number) => (isPg ? `$${n}` : '?');

  if (isPg) {
    const q = (sql: string) => ctx.pool.query(sql);
    const llmTot = await q(
      `SELECT COUNT(*)::int AS calls,
              COALESCE(SUM(CASE WHEN status='error' THEN 1 ELSE 0 END),0)::int AS errors,
              COALESCE(SUM(COALESCE(input_tokens,0)),0)::bigint AS input_tokens,
              COALESCE(SUM(COALESCE(output_tokens,0)),0)::bigint AS output_tokens,
              COALESCE(SUM(COALESCE(total_tokens,0)),0)::bigint AS total_tokens
       FROM llm_calls WHERE created_at >= ${since}`,
    );
    const byKind = await q(
      `SELECT kind, COUNT(*)::int AS calls, COALESCE(SUM(COALESCE(total_tokens,0)),0)::bigint AS total_tokens
       FROM llm_calls WHERE created_at >= ${since} GROUP BY kind ORDER BY total_tokens DESC`,
    );
    const byModel = await q(
      `SELECT COALESCE(model,'?') AS model, COUNT(*)::int AS calls, COALESCE(SUM(COALESCE(total_tokens,0)),0)::bigint AS total_tokens
       FROM llm_calls WHERE created_at >= ${since} GROUP BY model ORDER BY total_tokens DESC`,
    );
    const byDay = await q(
      `SELECT ${day} AS day, COUNT(*)::int AS calls, COALESCE(SUM(COALESCE(total_tokens,0)),0)::bigint AS total_tokens
       FROM llm_calls WHERE created_at >= ${since} GROUP BY ${day} ORDER BY day`,
    );
    const ocrTot = await q(
      `SELECT COUNT(*)::int AS calls,
              COALESCE(SUM(CASE WHEN status='error' THEN 1 ELSE 0 END),0)::int AS errors,
              COALESCE(SUM(COALESCE(pages,0)),0)::int AS pages,
              COUNT(DISTINCT doc_id)::int AS docs,
              COALESCE(AVG(COALESCE(duration_ms,0)),0) AS avg_ms
       FROM ocr_calls WHERE created_at >= ${since}`,
    );
    const ocrByBackend = await q(
      `SELECT backend, COUNT(*)::int AS calls, COALESCE(SUM(COALESCE(pages,0)),0)::int AS pages,
              COALESCE(AVG(COALESCE(duration_ms,0)),0) AS avg_ms
       FROM ocr_calls WHERE created_at >= ${since} GROUP BY backend ORDER BY calls DESC`,
    );
    const ocrByDay = await q(
      `SELECT ${day} AS day, COUNT(*)::int AS calls, COALESCE(SUM(COALESCE(pages,0)),0)::int AS pages
       FROM ocr_calls WHERE created_at >= ${since} GROUP BY ${day} ORDER BY day`,
    );
    const lt = llmTot.rows[0] as Record<string, number>;
    const ot = ocrTot.rows[0] as Record<string, number>;
    return {
      range: days === 7 ? '7d' : '30d',
      llm: {
        totalCalls: Number(lt.calls), errorCalls: Number(lt.errors),
        totalTokens: Number(lt.total_tokens), inputTokens: Number(lt.input_tokens), outputTokens: Number(lt.output_tokens),
        byKind: byKind.rows as never, byModel: byModel.rows as never, byDay: byDay.rows as never,
      },
      ocr: {
        totalCalls: Number(ot.calls), errorCalls: Number(ot.errors), totalPages: Number(ot.pages),
        totalDocs: Number(ot.docs), avgDurationMs: Math.round(Number(ot.avg_ms)),
        byBackend: ocrByBackend.rows as never, byDay: ocrByDay.rows as never,
      },
    };
  }

  const q = <T>(sql: string, ...params: unknown[]): T[] =>
    ctx.sqlite.prepare(sql).all(...params) as T[];
  const llmTot = q<{ calls: number; errors: number; input_tokens: number; output_tokens: number; total_tokens: number }>(
    `SELECT COUNT(*) AS calls,
            COALESCE(SUM(CASE WHEN status='error' THEN 1 ELSE 0 END),0) AS errors,
            COALESCE(SUM(COALESCE(input_tokens,0)),0) AS input_tokens,
            COALESCE(SUM(COALESCE(output_tokens,0)),0) AS output_tokens,
            COALESCE(SUM(COALESCE(total_tokens,0)),0) AS total_tokens
     FROM llm_calls WHERE created_at >= ${since}`,
  );
  const byKind = q<{ kind: string; calls: number; total_tokens: number }>(
    `SELECT kind, COUNT(*) AS calls, COALESCE(SUM(COALESCE(total_tokens,0)),0) AS total_tokens
     FROM llm_calls WHERE created_at >= ${since} GROUP BY kind ORDER BY total_tokens DESC`,
  );
  const byModel = q<{ model: string; calls: number; total_tokens: number }>(
    `SELECT COALESCE(model,'?') AS model, COUNT(*) AS calls, COALESCE(SUM(COALESCE(total_tokens,0)),0) AS total_tokens
     FROM llm_calls WHERE created_at >= ${since} GROUP BY model ORDER BY total_tokens DESC`,
  );
  const byDay = q<{ day: string; calls: number; total_tokens: number }>(
    `SELECT ${day} AS day, COUNT(*) AS calls, COALESCE(SUM(COALESCE(total_tokens,0)),0) AS total_tokens
     FROM llm_calls WHERE created_at >= ${since} GROUP BY ${day} ORDER BY day`,
  );
  const ocrTot = q<{ calls: number; errors: number; pages: number; docs: number; avg_ms: number }>(
    `SELECT COUNT(*) AS calls,
            COALESCE(SUM(CASE WHEN status='error' THEN 1 ELSE 0 END),0) AS errors,
            COALESCE(SUM(COALESCE(pages,0)),0) AS pages,
            COUNT(DISTINCT doc_id) AS docs,
            COALESCE(AVG(COALESCE(duration_ms,0)),0) AS avg_ms
     FROM ocr_calls WHERE created_at >= ${since}`,
  );
  const ocrByBackend = q<{ backend: string; calls: number; pages: number; avg_ms: number }>(
    `SELECT backend, COUNT(*) AS calls, COALESCE(SUM(COALESCE(pages,0)),0) AS pages,
            COALESCE(AVG(COALESCE(duration_ms,0)),0) AS avg_ms
     FROM ocr_calls WHERE created_at >= ${since} GROUP BY backend ORDER BY calls DESC`,
  );
  const ocrByDay = q<{ day: string; calls: number; pages: number }>(
    `SELECT ${day} AS day, COUNT(*) AS calls, COALESCE(SUM(COALESCE(pages,0)),0) AS pages
     FROM ocr_calls WHERE created_at >= ${since} GROUP BY ${day} ORDER BY day`,
  );
  const lt = llmTot[0];
  const ot = ocrTot[0];
  return {
    range: days === 7 ? '7d' : '30d',
    llm: {
      totalCalls: lt?.calls ?? 0, errorCalls: lt?.errors ?? 0,
      totalTokens: lt?.total_tokens ?? 0, inputTokens: lt?.input_tokens ?? 0, outputTokens: lt?.output_tokens ?? 0,
      byKind: byKind.map((r) => ({ kind: r.kind, calls: r.calls, totalTokens: r.total_tokens })),
      byModel: byModel.map((r) => ({ model: r.model, calls: r.calls, totalTokens: r.total_tokens })),
      byDay: byDay.map((r) => ({ day: r.day, calls: r.calls, totalTokens: r.total_tokens })),
    },
    ocr: {
      totalCalls: ot?.calls ?? 0, errorCalls: ot?.errors ?? 0, totalPages: ot?.pages ?? 0,
      totalDocs: ot?.docs ?? 0, avgDurationMs: Math.round(ot?.avg_ms ?? 0),
      byBackend: ocrByBackend.map((r) => ({ backend: r.backend, calls: r.calls, pages: r.pages, avgDurationMs: Math.round(r.avg_ms) })),
      byDay: ocrByDay.map((r) => ({ day: r.day, calls: r.calls, pages: r.pages })),
    },
  };
}

export interface LlmCallRow {
  id: string;
  sessionId: string | null;
  userId: string | null;
  kind: string;
  model: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  inputPreview: string | null;
  outputPreview: string | null;
  inputChars: number | null;
  outputChars: number | null;
  durationMs: number | null;
  finishReason: string | null;
  status: string;
  error: string | null;
  createdAt: string;
}

function llmFromPgRow(r: Record<string, unknown>): LlmCallRow {
  return {
    id: r.id as string, sessionId: (r.session_id as string) ?? null, userId: (r.user_id as string) ?? null,
    kind: r.kind as string, model: (r.model as string) ?? null,
    inputTokens: r.input_tokens as number | null, outputTokens: r.output_tokens as number | null,
    totalTokens: r.total_tokens as number | null,
    inputPreview: (r.input_preview as string) ?? null, outputPreview: (r.output_preview as string) ?? null,
    inputChars: r.input_chars as number | null, outputChars: r.output_chars as number | null,
    durationMs: r.duration_ms as number | null, finishReason: (r.finish_reason as string) ?? null,
    status: r.status as string, error: (r.error as string) ?? null,
    createdAt: r.created_at as string,
  };
}

/** Recent LLM calls, newest first. */
export async function listLlmCalls(
  ctx: DbContext,
  opts?: { limit?: number; offset?: number; kind?: string; sessionId?: string },
): Promise<{ rows: LlmCallRow[]; total: number }> {
  const limit = Math.min(Math.max(opts?.limit ?? 50, 1), 200);
  const offset = Math.max(opts?.offset ?? 0, 0);
  const isPg = ctx.backend === 'postgres';
  const p = (n: number) => (isPg ? `$${n}` : '?');
  const filters: string[] = [];
  const params: unknown[] = [];
  if (opts?.kind) { params.push(opts.kind); filters.push(`kind = ${p(params.length)}`); }
  if (opts?.sessionId) { params.push(opts.sessionId); filters.push(`session_id = ${p(params.length)}`); }
  const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
  if (isPg) {
    const total = await ctx.pool.query(`SELECT COUNT(*)::int AS n FROM llm_calls ${where}`, params);
    const res = await ctx.pool.query(
      `SELECT * FROM llm_calls ${where} ORDER BY created_at DESC LIMIT ${p(params.length + 1)} OFFSET ${p(params.length + 2)}`,
      [...params, limit, offset],
    );
    return { rows: res.rows.map(llmFromPgRow), total: (total.rows[0] as { n: number }).n };
  }
  const total = ctx.sqlite.prepare(`SELECT COUNT(*) AS n FROM llm_calls ${where}`).get(...params) as { n: number };
  const rows = ctx.sqlite
    .prepare(`SELECT * FROM llm_calls ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
    .all(...params, limit, offset) as Record<string, unknown>[];
  return {
    rows: rows.map((r) => llmFromPgRow({ ...r, created_at: String(r.created_at) })),
    total: total.n,
  };
}

export interface OcrCallRow {
  id: string;
  sessionId: string | null;
  userId: string | null;
  docId: string;
  docType: string | null;
  fileName: string | null;
  backend: string;
  fileBytes: number | null;
  pages: number | null;
  blocks: number | null;
  durationMs: number | null;
  status: string;
  error: string | null;
  createdAt: string;
}

function ocrFromPgRow(r: Record<string, unknown>): OcrCallRow {
  return {
    id: r.id as string, sessionId: (r.session_id as string) ?? null, userId: (r.user_id as string) ?? null,
    docId: r.doc_id as string, docType: (r.doc_type as string) ?? null, fileName: (r.file_name as string) ?? null,
    backend: r.backend as string, fileBytes: r.file_bytes as number | null, pages: r.pages as number | null,
    blocks: r.blocks as number | null, durationMs: r.duration_ms as number | null,
    status: r.status as string, error: (r.error as string) ?? null, createdAt: r.created_at as string,
  };
}

/** Recent OCR/parse calls, newest first. */
export async function listOcrCalls(
  ctx: DbContext,
  opts?: { limit?: number; offset?: number; backend?: string },
): Promise<{ rows: OcrCallRow[]; total: number }> {
  const limit = Math.min(Math.max(opts?.limit ?? 50, 1), 200);
  const offset = Math.max(opts?.offset ?? 0, 0);
  const isPg = ctx.backend === 'postgres';
  const p = (n: number) => (isPg ? `$${n}` : '?');
  const filters: string[] = [];
  const params: unknown[] = [];
  if (opts?.backend) { params.push(opts.backend); filters.push(`backend = ${p(params.length)}`); }
  const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
  if (isPg) {
    const total = await ctx.pool.query(`SELECT COUNT(*)::int AS n FROM ocr_calls ${where}`, params);
    const res = await ctx.pool.query(
      `SELECT * FROM ocr_calls ${where} ORDER BY created_at DESC LIMIT ${p(params.length + 1)} OFFSET ${p(params.length + 2)}`,
      [...params, limit, offset],
    );
    return { rows: res.rows.map(ocrFromPgRow), total: (total.rows[0] as { n: number }).n };
  }
  const total = ctx.sqlite.prepare(`SELECT COUNT(*) AS n FROM ocr_calls ${where}`).get(...params) as { n: number };
  const rows = ctx.sqlite
    .prepare(`SELECT * FROM ocr_calls ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
    .all(...params, limit, offset) as Record<string, unknown>[];
  return {
    rows: rows.map((r) => ocrFromPgRow({ ...r, created_at: String(r.created_at) })),
    total: total.n,
  };
}

/** Delete records older than RETENTION_DAYS. Returns deleted row count. */
export async function purgeOldUsageRecords(): Promise<number> {
  const ctx = getDbContext();
  if (ctx.backend === 'postgres') {
    const a = await ctx.pool.query(`DELETE FROM llm_calls WHERE created_at < ${SINCE_PG(RETENTION_DAYS)}`);
    const b = await ctx.pool.query(`DELETE FROM ocr_calls WHERE created_at < ${SINCE_PG(RETENTION_DAYS)}`);
    return (a.rowCount ?? 0) + (b.rowCount ?? 0);
  }
  const a = ctx.sqlite.prepare(`DELETE FROM llm_calls WHERE created_at < ${SINCE_SQLITE(RETENTION_DAYS)}`).run();
  const b = ctx.sqlite.prepare(`DELETE FROM ocr_calls WHERE created_at < ${SINCE_SQLITE(RETENTION_DAYS)}`).run();
  return a.changes + b.changes;
}
