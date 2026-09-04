import { describe, it, expect, beforeAll, vi } from 'vitest';
import { Hono } from 'hono';
import type { AuthEnv } from '../../src/lib/auth-middleware.js';
import { createDb, migrate, type DbContext } from '../../src/pipeline/db/client.js';
import { createDocumentStub, saveExtraction } from '../../src/pipeline/db/repositories.js';

// 与 reviewUnits.test.ts 同款: 路由模块 ctx() 单例 -> 整文件共用一个内存库。
const { ctxHolder } = vi.hoisted(() => ({
  ctxHolder: { current: null as DbContext | null },
}));
vi.mock('../../src/pipeline/db/dbBackend.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../src/pipeline/db/dbBackend.js')>();
  return { ...mod, getDbContext: () => ctxHolder.current };
});

const { setReviewOutcome } = await import('../../src/pipeline/db/repositories.js');
const { reviewRoute } = await import('../../src/routes/review.js');

beforeAll(() => {
  const ctx = createDb(':memory:');
  migrate(ctx.sqlite);
  ctxHolder.current = ctx;
});

function rawDoc(docId: string) {
  return ctxHolder.current!.sqlite
    .prepare('SELECT review_status, review_action, reviewed_by FROM documents WHERE id = ?')
    .get(docId) as { review_status: string; review_action: string | null; reviewed_by: string };
}

describe('setReviewOutcome', () => {
  it('同时写 review_status + review_action + 审计字段', async () => {
    const { docId } = await createDocumentStub(ctxHolder.current!, {
      sourceUri: 'file:///a.pdf', userId: 'u1',
    });
    await setReviewOutcome(ctxHolder.current!, docId, 'confirmed', 'auto-release', 'u1');
    const row = rawDoc(docId);
    expect(row.review_status).toBe('confirmed');
    expect(row.review_action).toBe('auto-release');
    expect(row.reviewed_by).toBe('u1');
  });

  it('manual 动作照写', async () => {
    const { docId } = await createDocumentStub(ctxHolder.current!, {
      sourceUri: 'file:///b.pdf', userId: 'u1',
    });
    await setReviewOutcome(ctxHolder.current!, docId, 'confirmed', 'manual', 'u1');
    expect(rawDoc(docId).review_action).toBe('manual');
  });
});

describe('POST /api/documents/:docId/review 单确认写 manual', () => {
  function appAs(userId: string) {
    const app = new Hono<AuthEnv>();
    app.use('*', async (c, next) => {
      c.set('user', { id: userId, email: 't@t', role: 'trader' } as never);
      await next();
    });
    app.route('/api/documents', reviewRoute);
    return app;
  }

  it('confirm:true -> review_action=manual', async () => {
    const { docId } = await createDocumentStub(ctxHolder.current!, {
      sourceUri: 'file:///c.pdf', userId: 'u1',
    });
    await saveExtraction(ctxHolder.current!, {
      documentId: docId, docType: '汽运磅单',
      fields: { 结论: { value: 'ok', sourceSpans: [] } },
      fieldMeta: { 结论: { strength: 'none', confidence: 0.9 } },
      overallConfidence: 0.9, needsReview: false,
    });
    const res = await appAs('u1').request(`/api/documents/${docId}/review`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: true }),
    });
    expect(res.status).toBe(200);
    expect(rawDoc(docId).review_action).toBe('manual');
  });
});