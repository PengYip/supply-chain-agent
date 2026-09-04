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
} from '../../src/pipeline/db/repositories.js';
import { buildPng } from '../pipeline/fixtures/png.js';

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

/** 跨页 unit: manifest regions 覆盖页 1 和页 2。 */
async function seedTwoPageUnit(): Promise<string> {
  const pdfPath = join(dir, `pv-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.pdf`);
  await makeTwoPagePdf(pdfPath);
  const { docId: container } = await createDocumentStub(ctxHolder.current!, { sourceUri: pdfPath, userId: 'u1' });
  const { docId: child } = await createDocumentStub(ctxHolder.current!, { sourceUri: pdfPath, userId: 'u1' });
  await setDocumentBatchRole(ctxHolder.current!, child, 'unit');
  const bbox = { x: 0.05, y: 0.05, w: 0.9, h: 0.9 };
  await saveDocumentUnits(ctxHolder.current!, [{
    parentDocumentId: container, childDocumentId: child, unitIndex: 1,
    docType: '汽运磅单', pageStart: 1, pageEnd: 2, rotationDeg: 0,
    bboxJson: JSON.stringify(bbox),
    manifest: {
      regions: [
        { page: 1, bbox, rotationDeg: 0 },
        { page: 2, bbox, rotationDeg: 0 },
      ],
    },
  }]);
  return child;
}

describe('GET /api/documents/:docId/unit-preview?page=N', () => {
  beforeEach(() => {
    dir = join(tmpdir(), `unitpvpage-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    mkdirSync(dir, { recursive: true });
  });

  it('page=2 -> 200 单页 PNG', async () => {
    const child = await seedTwoPageUnit();
    const res = await appAs('u1').request(`/api/documents/${child}/unit-preview?page=2`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    const buf = Buffer.from(await res.arrayBuffer());
    expect(buf.length).toBeGreaterThan(0);
    expect(buf[0]).toBe(0x89);
  });

  it('page=3(越界) -> 400 中文原因', async () => {
    const child = await seedTwoPageUnit();
    const res = await appAs('u1').request(`/api/documents/${child}/unit-preview?page=3`);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain('不在');
  });

  it('page=abc -> 400', async () => {
    const child = await seedTwoPageUnit();
    expect((await appAs('u1').request(`/api/documents/${child}/unit-preview?page=abc`)).status).toBe(400);
  });

  it('无参数 -> 兼容旧整 unit 拼接行为', async () => {
    const child = await seedTwoPageUnit();
    const res = await appAs('u1').request(`/api/documents/${child}/unit-preview`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
  });
});