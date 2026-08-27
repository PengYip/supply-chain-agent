import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Hono } from 'hono';
import type { AuthEnv } from '../../src/lib/auth-middleware.js';
import { createDb, migrate, type DbContext } from '../../src/pipeline/db/client.js';
import {
  createDocumentStub, saveExtraction, setReviewStatus,
} from '../../src/pipeline/db/repositories.js';

// Isolated file ON PURPOSE: routes/review.ts memoizes its DbContext in a module
// singleton (`function ctx()`), so swapping the injected :memory: DB inside a
// SECOND describe of review.test.ts would silently read a stale database.
// Vitest's per-file module isolation gives this suite a fresh route module +
// mock registry, which is exactly what these tests need.

const { ctxHolder } = vi.hoisted(() => ({
  ctxHolder: { current: null as DbContext | null },
}));
vi.mock('../../src/pipeline/db/dbBackend.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../src/pipeline/db/dbBackend.js')>();
  return { ...mod, getDbContext: () => ctxHolder.current };
});

const { reviewRoute } = await import('../../src/routes/review.js');

function appAs(userId: string) {
  const app = new Hono<AuthEnv>();
  app.use('*', async (c, next) => {
    c.set('user', { id: userId, email: 't@t', role: 'trader' } as any);
    await next();
  });
  app.route('/api/documents', reviewRoute);
  return app;
}

describe('GET /api/documents/:docId/review (current snapshot read)', () => {
  beforeEach(() => {
    const ctx = createDb(':memory:');
    migrate(ctx.sqlite);
    ctxHolder.current = ctx;
  });

  async function stubDoc(ctx: DbContext) {
    const { docId } = await createDocumentStub(ctx, { sourceUri: 'file:///inv.pdf', docType: '发票' });
    await saveExtraction(ctx, {
      documentId: docId, docType: '发票',
      fields: { 合同号: { value: 'HT-1', sourceSpans: [] } },
      fieldMeta: { 合同号: { strength: 'exact', confidence: 0.95 } },
      overallConfidence: 0.95, needsReview: false,
    });
    return docId;
  }

  it('读取当前快照: pending -> DB 确认后 GET 返回 confirmed(历史恢复水合依赖)', async () => {
    const ctx = ctxHolder.current!;
    const docId = await stubDoc(ctx);

    const res1 = await appAs('u1').request(`/api/documents/${docId}/review`);
    expect(res1.status).toBe(200);
    const body1 = (await res1.json()) as { ok: boolean; docId: string; snapshot?: { reviewStatus: string } };
    expect(body1.ok).toBe(true);
    expect(body1.docId).toBe(docId);
    expect(body1.snapshot?.reviewStatus).toBe('pending');

    await setReviewStatus(ctx, docId, 'confirmed', 'u1');
    const res2 = await appAs('u1').request(`/api/documents/${docId}/review`);
    expect(res2.status).toBe(200);
    const body2 = (await res2.json()) as { ok: boolean; snapshot?: { reviewStatus: string } };
    expect(body2.snapshot?.reviewStatus).toBe('confirmed');
  });

  it('未知 docId -> 404 document_or_extraction_not_found', async () => {
    const res = await appAs('u1').request('/api/documents/DOC-nope/review');
    expect(res.status).toBe(404);
    const body = (await res.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toBe('document_or_extraction_not_found');
  });

  it('无 user -> 401', async () => {
    const app = new Hono<AuthEnv>();
    app.route('/api/documents', reviewRoute);
    const res = await app.request('/api/documents/DOC-x/review');
    expect(res.status).toBe(401);
  });
});
