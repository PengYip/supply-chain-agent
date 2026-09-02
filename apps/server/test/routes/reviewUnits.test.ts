import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PDFDocument } from 'pdf-lib';
import { Hono } from 'hono';
import type { AuthEnv } from '../../src/lib/auth-middleware.js';
import { createDb, migrate, type DbContext } from '../../src/pipeline/db/client.js';
import {
  createDocumentStub,
  setDocumentBatchRole,
  saveDocumentUnits,
  saveExtraction,
  setReviewStatus,
  listDocumentUnitsByParent,
} from '../../src/pipeline/db/repositories.js';
import { buildPng } from '../pipeline/fixtures/png.js';

// Isolated file ON PURPOSE: routes/review.ts memoizes its DbContext in a module
// singleton (`function ctx()`), so the WHOLE FILE must share ONE injected
// :memory: DB (bound in beforeAll, before the first request memoizes it) and
// isolate tests by unique doc ids instead of per-test databases. Same
// isolation rationale as reviewGetSnapshot.test.ts.

const { ctxHolder } = vi.hoisted(() => ({
  ctxHolder: { current: null as DbContext | null },
}));
vi.mock('../../src/pipeline/db/dbBackend.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../src/pipeline/db/dbBackend.js')>();
  return { ...mod, getDbContext: () => ctxHolder.current };
});

const { reviewRoute } = await import('../../src/routes/review.js');

// 整个文件共用一个内存库: 路由模块首次 ctx() 即绑定, 之后换库只读陈旧数据。
beforeAll(() => {
  const ctx = createDb(':memory:');
  migrate(ctx.sqlite);
  ctxHolder.current = ctx;
});

// unit-preview 渲染夹具: pdf-lib 生成 2 页无文字层 PDF(整页嵌图), 与
// batchSplitter 夹具同款; preview 只裁页 1 的 0.9x0.9 区域。
let dir = '';
const CONTENT_PNG = buildPng(64, 64, (_x, y) => (y < 32 ? [0, 0, 0, 255] : [255, 255, 255, 255]));

async function makeTwoPagePdf(path: string): Promise<void> {
  const pdf = await PDFDocument.create();
  const img = await pdf.embedPng(CONTENT_PNG);
  for (let p = 0; p < 2; p++) {
    const page = pdf.addPage([200, 280]);
    page.drawImage(img, { x: 0, y: 0, width: 200, height: 280 });
  }
  writeFileSync(path, await pdf.save());
}

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

  it('unit 摘要带子单据 reviewStatus 与 parseStatus(additive)', async () => {
    const docId = await seedContainer('u1');
    const units = await listDocumentUnitsByParent(ctxHolder.current!, docId);
    const c1 = units[0]!.childDocumentId!;
    // 复核确认一个子单据, 另一个保持 pending。
    await setReviewStatus(ctxHolder.current!, c1, 'confirmed', 'u1');

    const res = await appAs('u1').request(`/api/documents/${docId}/units`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      units: Array<{ docId: string | null; reviewStatus: string | null; parseStatus: string | null }>;
    };
    const reviewed = body.units.find((u) => u.docId === c1)!;
    const pending = body.units.find((u) => u.docId !== c1)!;
    expect(reviewed.reviewStatus).toBe('confirmed');
    expect(reviewed.parseStatus).toBe('uploaded');
    expect(pending.reviewStatus).toBe('pending');
    expect(pending.parseStatus).toBe('uploaded');
  });
});

// ---- GET /api/documents/:docId/unit-preview(抽取依据原片预览) --------------

describe('GET /api/documents/:docId/unit-preview', () => {
  beforeEach(() => {
    dir = join(tmpdir(), `unitpv-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    mkdirSync(dir, { recursive: true });
  });

  /** 种一个 unit: container(PDF 夹具) + 子单据 + document_units 行(区域覆盖页 1)。 */
  async function seedUnit(fileName: string): Promise<{ containerId: string; childId: string }> {
    const pdfPath = join(dir, fileName);
    await makeTwoPagePdf(pdfPath);
    const { docId: containerId } = await createDocumentStub(ctxHolder.current!, {
      sourceUri: pdfPath, userId: 'u1',
    });
    const { docId: childId } = await createDocumentStub(ctxHolder.current!, {
      sourceUri: pdfPath, userId: 'u1',
    });
    await setDocumentBatchRole(ctxHolder.current!, childId, 'unit');
    const bbox = { x: 0.05, y: 0.05, w: 0.9, h: 0.9 };
    await saveDocumentUnits(ctxHolder.current!, [
      {
        parentDocumentId: containerId, childDocumentId: childId, unitIndex: 1,
        docType: '汽运磅单', pageStart: 1, pageEnd: 1, rotationDeg: 0,
        bboxJson: JSON.stringify(bbox),
        manifest: { regions: [{ page: 1, bbox, rotationDeg: 0 }] },
      },
    ]);
    return { containerId, childId };
  }

  it('unit 原片: 200 image/png(PNG 魔数 + 非空)', async () => {
    const { childId } = await seedUnit('pv-ok.pdf');
    const res = await appAs('u1').request(`/api/documents/${childId}/unit-preview`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    const buf = Buffer.from(await res.arrayBuffer());
    expect(buf.length).toBeGreaterThan(0);
    expect(buf[0]).toBe(0x89);
    expect(buf[1]).toBe(0x50); // 'P'
    expect(buf[2]).toBe(0x4e); // 'N'
    expect(buf[3]).toBe(0x47); // 'G'
  });

  it('非 unit 文档 -> 404(中文原因)', async () => {
    const { containerId } = await seedUnit('pv-not-unit.pdf');
    const res = await appAs('u1').request(`/api/documents/${containerId}/unit-preview`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(typeof body.error).toBe('string');
    expect(body.error.length).toBeGreaterThan(0);
  });

  it('batch_role=unit 但无 unit 行 -> 404', async () => {
    const { docId: orphan } = await createDocumentStub(ctxHolder.current!, {
      sourceUri: 'file:///x.pdf', userId: 'u1',
    });
    await setDocumentBatchRole(ctxHolder.current!, orphan, 'unit');
    const res = await appAs('u1').request(`/api/documents/${orphan}/unit-preview`);
    expect(res.status).toBe(404);
    expect(((await res.json()) as { ok: boolean }).ok).toBe(false);
  });

  it('他人文档 -> 404', async () => {
    const { childId } = await seedUnit('pv-foreign.pdf');
    const res = await appAs('u2').request(`/api/documents/${childId}/unit-preview`);
    expect(res.status).toBe(404);
    expect(((await res.json()) as { ok: boolean }).ok).toBe(false);
  });
});
