import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Hono } from 'hono';
import type { AuthEnv } from '../../src/lib/auth-middleware.js';
import { createDb, migrate, type DbContext } from '../../src/pipeline/db/client.js';
import {
  createDocumentStub,
  setDocumentBatchRole,
  saveDocumentUnits,
  saveExtraction,
} from '../../src/pipeline/db/repositories.js';

// Isolated file ON PURPOSE: routes/review.ts memoizes its DbContext in a module
// singleton (`function ctx()`), so swapping the injected :memory: DB inside a
// SECOND describe of review.test.ts would silently read a stale database.
// Same isolation rationale as reviewGetSnapshot.test.ts.

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
    c.set('user', { id: userId, email: 't@t', role: 'trader' } as never);
    await next();
  });
  app.route('/api/documents', reviewRoute);
  return app;
}

describe('GET /api/documents/:docId/units (P3)', () => {
  beforeEach(() => {
    const ctx = createDb(':memory:');
    migrate(ctx.sqlite);
    ctxHolder.current = ctx;
  });

  /** container + 2 unit 子单据; unit2 的最新 extraction needs_review=1。 */
  async function seedContainer(userId: string): Promise<string> {
    const sourceUri = 'D:/ingest/batch.pdf';
    const children: string[] = [];
    for (let i = 0; i < 2; i++) {
      const { docId } = await createDocumentStub(ctxHolder.current!, { sourceUri, userId });
      await setDocumentBatchRole(ctxHolder.current!, docId, 'unit');
      children.push(docId);
    }
    const { docId } = await createDocumentStub(ctxHolder.current!, { sourceUri, userId });
    await setDocumentBatchRole(ctxHolder.current!, docId, 'container');
    await saveDocumentUnits(ctxHolder.current!, [
      { parentDocumentId: docId, childDocumentId: children[0], unitIndex: 1, docType: '汽运磅单' },
      { parentDocumentId: docId, childDocumentId: children[1], unitIndex: 2, docType: '质检报告' },
    ]);
    await saveExtraction(ctxHolder.current!, {
      documentId: children[1]!, docType: '质检报告',
      fields: { 结论: { value: '待定', sourceSpans: [] } },
      fieldMeta: { 结论: { strength: 'none', confidence: 0.3 } },
      overallConfidence: 0.3, needsReview: true,
    });
    return docId;
  }

  it('container 返回按 unitIndex 升序的 units 列表(含待复核标记)', async () => {
    const docId = await seedContainer('u1');
    const res = await appAs('u1').request(`/api/documents/${docId}/units`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      docId: string;
      units: Array<{ unitIndex: number; docId: string | null; detectedFormType: string; needsReview: boolean }>;
    };
    expect(body.ok).toBe(true);
    expect(body.docId).toBe(docId);
    expect(body.units.map((u) => u.unitIndex)).toEqual([1, 2]);
    expect(body.units[0]!.detectedFormType).toBe('汽运磅单');
    expect(body.units[0]!.docId).not.toBeNull();
    expect(body.units[1]!.needsReview).toBe(true);
  });

  it('非 container(普通文档) -> 404', async () => {
    const { docId } = await createDocumentStub(ctxHolder.current!, {
      sourceUri: 'file:///a.pdf', userId: 'u1',
    });
    const res = await appAs('u1').request(`/api/documents/${docId}/units`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(false);
  });

  it('不存在 -> 404', async () => {
    const res = await appAs('u1').request('/api/documents/DOC-nope/units');
    expect(res.status).toBe(404);
    expect(((await res.json()) as { ok: boolean }).ok).toBe(false);
  });

  it('他人文档 -> 404', async () => {
    const docId = await seedContainer('u1');
    const res = await appAs('u2').request(`/api/documents/${docId}/units`);
    expect(res.status).toBe(404);
    expect(((await res.json()) as { ok: boolean }).ok).toBe(false);
  });
});
