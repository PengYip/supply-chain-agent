import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Hono } from 'hono';
import type { AuthEnv } from '../../src/lib/auth-middleware.js';
import { createDb, migrate, type DbContext } from '../../src/pipeline/db/client.js';
import {
  createDocumentStub, saveExtraction, getReviewSnapshot,
} from '../../src/pipeline/db/repositories.js';

// The review route resolves its DbContext through getDbContext (dbBackend).
// Inject a fresh in-memory ctx per test. importOriginal preserves the other
// dbBackend exports (DB_BACKEND etc.) that transitive imports may rely on.
const { ctxHolder } = vi.hoisted(() => ({
  ctxHolder: { current: null as DbContext | null },
}));
vi.mock('../../src/pipeline/db/dbBackend.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../src/pipeline/db/dbBackend.js')>();
  return { ...mod, getDbContext: () => ctxHolder.current };
});

const { reviewRoute } = await import('../../src/routes/review.js');

// Same sub-app shape as chatBackground.test.ts: wrap the route with a user
// injection middleware (production attaches the user via attachSession).
function appAs(userId: string) {
  const app = new Hono<AuthEnv>();
  app.use('*', async (c, next) => {
    c.set('user', { id: userId, email: 't@t', role: 'trader' } as any);
    await next();
  });
  app.route('/api/documents', reviewRoute);
  return app;
}

describe('POST /api/documents/:docId/review (confirm, graph skipped path)', () => {
  beforeEach(() => {
    const ctx = createDb(':memory:');
    migrate(ctx.sqlite);
    ctxHolder.current = ctx;
  });

  it('confirm 无 NEO4J_PASSWORD -> 200 且 graphStatus.status=skipped 落库', async () => {
    const prev = process.env.NEO4J_PASSWORD;
    delete process.env.NEO4J_PASSWORD;
    try {
      const ctx = ctxHolder.current!;
      const { docId } = await createDocumentStub(ctx, { sourceUri: 'file:///inv.pdf', docType: '发票' });
      await saveExtraction(ctx, {
        documentId: docId, docType: '发票',
        fields: { 合同号: { value: 'HT-1', sourceSpans: [] } },
        fieldMeta: { 合同号: { strength: 'exact', confidence: 0.95 } },
        overallConfidence: 0.95, needsReview: false,
      });

      const res = await appAs('u1').request(`/api/documents/${docId}/review`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirm: true }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok: boolean; snapshot?: { graphStatus?: { status: string } } };
      expect(body.ok).toBe(true);
      expect(body.snapshot?.graphStatus?.status).toBe('skipped');

      // Persisted on documents.graph_status and readable back.
      const snap = await getReviewSnapshot(ctx, docId);
      expect(snap?.graphStatus?.status).toBe('skipped');
    } finally {
      if (prev !== undefined) process.env.NEO4J_PASSWORD = prev;
    }
  });
});
