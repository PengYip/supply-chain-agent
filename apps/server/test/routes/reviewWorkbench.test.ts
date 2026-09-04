import { describe, it, expect, beforeAll, vi } from 'vitest';
import { Hono } from 'hono';
import type { AuthEnv } from '../../src/lib/auth-middleware.js';
import { createDb, migrate, type DbContext } from '../../src/pipeline/db/client.js';
import {
  createDocumentStub,
  setDocumentBatchRole,
  saveDocumentUnits,
  saveExtraction,
} from '../../src/pipeline/db/repositories.js';

const { ctxHolder } = vi.hoisted(() => ({ ctxHolder: { current: null as DbContext | null } }));
vi.mock('../../src/pipeline/db/dbBackend.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../src/pipeline/db/dbBackend.js')>();
  return { ...mod, getDbContext: () => ctxHolder.current };
});

const { reviewRoute } = await import('../../src/routes/review.js');

beforeAll(() => {
  const ctx = createDb(':memory:');
  migrate(ctx.sqlite);
  ctxHolder.current = ctx;
});

function appAs(userId: string) {
  const app = new Hono<AuthEnv>();
  app.use('*', async (c, next) => {
    c.set('user', { id: userId, email: 't@t', role: 'trader' } as never);
    await next();
  });
  app.route('/api/documents', reviewRoute);
  return app;
}

/** 混合 container: u1 汽运磅单(高置信全过) + u2 汽运磅单(needsReview+勾稽error)
 *  + u3 化验报告(unit-list 组)。 */
async function seedMixed(userId: string): Promise<string> {
  const src = 'file:///mixed.pdf';
  const mk = async (role: 'unit' | 'container') => {
    const { docId } = await createDocumentStub(ctxHolder.current!, { sourceUri: src, userId });
    await setDocumentBatchRole(ctxHolder.current!, docId, role);
    return docId;
  };
  const [u1, u2, u3, container] = [await mk('unit'), await mk('unit'), await mk('unit'), await mk('container')];
  await saveDocumentUnits(ctxHolder.current!, [
    { parentDocumentId: container, childDocumentId: u1, unitIndex: 1, docType: '汽运磅单', pageStart: 1, pageEnd: 2 },
    { parentDocumentId: container, childDocumentId: u2, unitIndex: 2, docType: '汽运磅单', pageStart: 3, pageEnd: 3 },
    { parentDocumentId: container, childDocumentId: u3, unitIndex: 3, docType: '化验报告', pageStart: 4, pageEnd: 4 },
  ]);
  const rowsOk = [
    { 编号: 'A1', 车号: '皖A111', 毛重_吨: 40.5, 皮重_吨: 15.2, 净重_吨: 25.3, 页码: 1 },
    { 编号: 'A2', 车号: '皖A222', 毛重_吨: 35.1, 皮重_吨: 12.0, 净重_吨: 23.1, 页码: 2 },
  ];
  const rowsBad = [
    { 编号: 'B1', 车号: '皖B333', 毛重_吨: 30.0, 皮重_吨: 10.0, 净重_吨: 18.0, 页码: 3 },
  ];
  await saveExtraction(ctxHolder.current!, {
    documentId: u1, docType: '汽运磅单',
    fields: {
      明细行: { value: JSON.stringify(rowsOk), sourceSpans: [] },
      总净重_吨: { value: 48.4, sourceSpans: [] },
      页数: { value: 2, sourceSpans: [] },
      失败页: { value: '[]', sourceSpans: [] },
    },
    fieldMeta: {}, overallConfidence: 0.99, needsReview: false,
  });
  await saveExtraction(ctxHolder.current!, {
    documentId: u2, docType: '汽运磅单',
    fields: {
      明细行: { value: JSON.stringify(rowsBad), sourceSpans: [] },
      总净重_吨: { value: 18.0, sourceSpans: [] },
      页数: { value: 1, sourceSpans: [] },
      失败页: { value: '[]', sourceSpans: [] },
    },
    fieldMeta: { _warnings: ['两遍读数分歧'] } as never,
    overallConfidence: 0.6, needsReview: true,
  });
  await saveExtraction(ctxHolder.current!, {
    documentId: u3, docType: '化验报告',
    fields: { 结论: { value: '合格', sourceSpans: [] } },
    fieldMeta: {}, overallConfidence: 0.9, needsReview: false,
  });
  return container;
}

describe('GET /api/documents/:docId/review-workbench', () => {
  it('混合类型: 分组/摊平/勾稽/releaseEligible', async () => {
    const docId = await seedMixed('u1');
    const res = await appAs('u1').request(`/api/documents/${docId}/review-workbench`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      data: {
        containerTitle: string;
        groups: Array<{
          docType: string;
          kind: string;
          units: Array<{
            docId: string; releaseEligible: boolean;
            rows?: Array<Record<string, unknown>>;
            rowChecks?: Array<{ issues: Array<{ rule: string; severity: string }> }>;
            totalCheck?: { pass: boolean };
          }>;
        }>;
      };
    };
    expect(body.ok).toBe(true);
    expect(body.data.containerTitle).toBe('mixed.pdf');
    const wb = body.data.groups.find((g) => g.docType === '汽运磅单')!;
    expect(wb.kind).toBe('voucher-table');
    expect(wb.units).toHaveLength(2);
    const [hi, lo] = wb.units;
    expect(hi!.rows).toHaveLength(2);
    expect(hi!.rows![0]!.页码).toBe(1);
    expect(hi!.rowChecks![0]!.issues).toEqual([]);
    expect(hi!.releaseEligible).toBe(true);
    expect(hi!.totalCheck!.pass).toBe(true);
    expect(lo!.releaseEligible).toBe(false);
    expect(
      lo!.rowChecks![0]!.issues.some((i) => i.rule === 'gross_minus_tare' && i.severity === 'error'),
    ).toBe(true);
    const q = body.data.groups.find((g) => g.docType === '化验报告')!;
    expect(q.kind).toBe('unit-list');
    expect(q.units[0]!.rows).toBeUndefined();
  });

  it('非 container / 他人文档 / 不存在 -> 404', async () => {
    const container = await seedMixed('u1');
    const { docId: plain } = await createDocumentStub(ctxHolder.current!, {
      sourceUri: 'file:///x.pdf', userId: 'u1',
    });
    expect((await appAs('u1').request(`/api/documents/${plain}/review-workbench`)).status).toBe(404);
    expect((await appAs('u2').request(`/api/documents/${container}/review-workbench`)).status).toBe(404);
    expect((await appAs('u1').request('/api/documents/DOC-nope/review-workbench')).status).toBe(404);
  });
});