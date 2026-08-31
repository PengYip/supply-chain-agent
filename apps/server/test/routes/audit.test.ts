import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Hono } from 'hono';
import type { AuthEnv, SessionUser } from '../../src/lib/auth-middleware.js';
import { createDb, migrate, type DbContext } from '../../src/pipeline/db/client.js';

// 用量审计测试(2026-08-31 spec): recordLlmCall/recordOcrCall 落库 + 查询 +
// 截断 + /api/audit 路由。scaffold 对齐 share.test.ts 的 ctxHolder mock
// (dbBackend.getDbContext -> 内存 SQLite)与 appAs 用户注入。

const { ctxHolder } = vi.hoisted(() => ({ ctxHolder: { current: null as DbContext | null } }));
vi.mock('../../src/pipeline/db/dbBackend.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../src/pipeline/db/dbBackend.js')>();
  return { ...mod, getDbContext: () => ctxHolder.current };
});

const { recordLlmCall, recordOcrCall, listLlmCalls, listOcrCalls, usageAuditSummary, flushUsageAudit } =
  await import('../../src/harness/usageAudit.js');
const { auditRoute } = await import('../../src/routes/audit.js');

function trader(id: string): SessionUser {
  return { id, email: `${id}@t`, name: null, role: 'trader' };
}

function appAs(user: SessionUser) {
  const app = new Hono<AuthEnv>();
  app.use('*', async (c, next) => {
    c.set('user', user);
    await next();
  });
  app.route('/api/audit', auditRoute);
  return app;
}

/** Flush the fire-and-forget record promises (they import dbBackend lazily). */
const flush = flushUsageAudit;

let ctx: DbContext;

beforeEach(() => {
  ctx = createDb(':memory:');
  migrate(ctx.sqlite);
  ctxHolder.current = ctx;
});

describe('usageAudit records', () => {
  it('persists llm + ocr calls and lists them newest first', async () => {
    recordLlmCall({
      sessionId: 's1', userId: 'alice', kind: 'chat', model: 'deepseek-chat',
      inputTokens: 100, outputTokens: 50, totalTokens: 150,
      inputText: '帮我查订单', outputText: '好的',
      durationMs: 1200, status: 'ok',
    });
    recordLlmCall({ sessionId: 's1', kind: 'title', model: 'm2', inputTokens: 10, outputTokens: 5, totalTokens: 15, status: 'ok' });
    recordOcrCall({
      docId: 'doc-1', docType: '合同', fileName: 'c.pdf', backend: 'qianfan',
      fileBytes: 1234, pages: 3, blocks: 12, durationMs: 5000, status: 'ok',
    });
    await flush();

    const llm = await listLlmCalls(ctx);
    expect(llm.total).toBe(2);
    expect(llm.rows[0].kind).toBe('title'); // newest first
    expect(llm.rows[1].inputPreview).toBe('帮我查订单');
    expect(llm.rows[1].totalTokens).toBe(150);
    expect(llm.rows[1].userId).toBe('alice');

    const filtered = await listLlmCalls(ctx, { kind: 'chat' });
    expect(filtered.total).toBe(1);
    expect(filtered.rows[0].kind).toBe('chat');

    const ocr = await listOcrCalls(ctx);
    expect(ocr.total).toBe(1);
    expect(ocr.rows[0].backend).toBe('qianfan');
    expect(ocr.rows[0].pages).toBe(3);
  });

  it('truncates previews to 2000 chars but keeps full length in *_chars', async () => {
    const long = 'x'.repeat(5000);
    recordLlmCall({ kind: 'chat', inputText: long, outputText: long, status: 'ok' });
    await flush();
    const { rows } = await listLlmCalls(ctx);
    expect(rows[0].inputPreview?.length).toBe(2000);
    expect(rows[0].inputChars).toBe(5000);
    expect(rows[0].outputChars).toBe(5000);
  });

  it('never throws even when the record fails (bad session id is fine; ctx errors are swallowed)', async () => {
    ctxHolder.current = null; // getDbContext returns null -> persist throws internally
    expect(() =>
      recordLlmCall({ kind: 'chat', status: 'ok' }),
    ).not.toThrow();
    await flush();
  });
});

describe('usageAudit summary', () => {
  it('aggregates llm by kind/model/day and ocr by backend/day', async () => {
    recordLlmCall({ kind: 'chat', model: 'm1', inputTokens: 10, outputTokens: 20, totalTokens: 30, status: 'ok' });
    recordLlmCall({ kind: 'chat', model: 'm1', inputTokens: 1, outputTokens: 2, totalTokens: 3, status: 'ok' });
    recordLlmCall({ kind: 'title', model: 'm2', totalTokens: 5, status: 'ok' });
    recordLlmCall({ kind: 'chat', model: 'm1', status: 'error', error: 'boom' });
    recordOcrCall({ docId: 'd1', backend: 'qianfan', pages: 10, durationMs: 1000, status: 'ok' });
    recordOcrCall({ docId: 'd2', backend: 'mineru', pages: 2, durationMs: 3000, status: 'ok' });
    await flush();

    const s = await usageAuditSummary(ctx, 7);
    expect(s.range).toBe('7d');
    expect(s.llm.totalCalls).toBe(4);
    expect(s.llm.errorCalls).toBe(1);
    expect(s.llm.totalTokens).toBe(38);
    expect(s.llm.byKind.find((k) => k.kind === 'chat')?.calls).toBe(3);
    expect(s.llm.byModel.find((m) => m.model === 'm1')?.calls).toBe(3);
    expect(s.llm.byDay.length).toBeGreaterThan(0);

    expect(s.ocr.totalCalls).toBe(2);
    expect(s.ocr.totalPages).toBe(12);
    expect(s.ocr.totalDocs).toBe(2);
    expect(s.ocr.avgDurationMs).toBe(2000);
    expect(s.ocr.byBackend.find((b) => b.backend === 'qianfan')?.pages).toBe(10);
  });
});

describe('GET /api/audit/*', () => {
  it('returns summary and paginated lists for an authenticated user', async () => {
    recordLlmCall({ kind: 'chat', model: 'm1', totalTokens: 42, inputText: 'hi', outputText: 'yo', status: 'ok' });
    recordOcrCall({ docId: 'd1', backend: 'digital', blocks: 5, status: 'ok' });
    await flush();

    const app = appAs(trader('alice'));
    const sum = await app.request('/api/audit/summary?range=7d');
    expect(sum.status).toBe(200);
    const sumBody = (await sum.json()) as { llm: { totalCalls: number }; ocr: { totalCalls: number } };
    expect(sumBody.llm.totalCalls).toBe(1);
    expect(sumBody.ocr.totalCalls).toBe(1);

    const llm = await app.request('/api/audit/llm?limit=10');
    const llmBody = (await llm.json()) as { rows: Array<{ totalTokens: number }>; total: number };
    expect(llmBody.total).toBe(1);
    expect(llmBody.rows[0].totalTokens).toBe(42);

    const ocr = await app.request('/api/audit/ocr');
    const ocrBody = (await ocr.json()) as { rows: unknown[]; total: number };
    expect(ocrBody.total).toBe(1);
  });

  it('401s without a user (requireAuth is enforced at mount; route double-checks)', async () => {
    const app = new Hono<AuthEnv>();
    app.route('/api/audit', auditRoute);
    const res = await app.request('/api/audit/summary');
    expect(res.status).toBe(401);
  });
});
