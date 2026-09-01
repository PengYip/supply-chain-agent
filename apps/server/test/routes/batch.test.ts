import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { Hono } from 'hono';
import type { AuthEnv } from '../../src/lib/auth-middleware.js';
import { createDb, migrate, type SqliteDbContext } from '../../src/pipeline/db/client.js';
import { env } from '../../src/env.js';
import {
  createDocumentStub,
  saveBinding,
  listDocumentUnitsByParent,
  setDocumentBatchRole,
} from '../../src/pipeline/db/repositories.js';
import { ensureDocumentParsed, type VlmDeps } from '../../src/pipeline/tools/documentEntry.js';
import { ensureTemplateSeed } from '../../src/pipeline/templateSeed.js';
import { buildPng } from '../pipeline/fixtures/png.js';

// Task 9: /api/batch 修正端点(resplit / reextract / merge)。
//
// 隔离: 路由 DbContext 经 getDbContext 解析 -> 注入内存库; buildIngestDeps
// 整体替换为 fake VLM 携带者(路由内部组装解析依赖, mock 后保持 hermetic,
// 不发真实模型调用)。

const { ctxHolder, fakeVlmHolder } = vi.hoisted(() => ({
  ctxHolder: { current: null as import('../../src/pipeline/db/client.js').DbContext | null },
  fakeVlmHolder: { current: null as unknown },
}));
vi.mock('../../src/pipeline/db/dbBackend.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../src/pipeline/db/dbBackend.js')>();
  return { ...mod, getDbContext: () => ctxHolder.current };
});
vi.mock('../../src/pipeline/ingestModel.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../src/pipeline/ingestModel.js')>();
  return {
    ...mod,
    buildIngestDeps:
      () => ({ vlm: fakeVlmHolder.current }) as unknown as ReturnType<typeof mod.buildIngestDeps>,
  };
});

const { batchRoute } = await import('../../src/routes/batch.js');

function appAs(userId: string) {
  const app = new Hono<AuthEnv>();
  app.use('*', async (c, next) => {
    c.set('user', { id: userId, email: 't@t', role: 'admin' } as never);
    await next();
  });
  app.route('/api/batch', batchRoute);
  return app;
}

const JSON_HEADERS = { 'Content-Type': 'application/json' };

let ctx: SqliteDbContext;
let dir: string;

const SAVED_ENV = {
  enabled: env.BATCH_SPLIT_ENABLED,
  vlmUrl: env.VLM_BASE_URL,
  vlmKey: env.VLM_API_KEY,
  concurrency: env.BATCH_SPLIT_CONCURRENCY,
};

beforeEach(() => {
  ctx = createDb(':memory:');
  migrate(ctx.sqlite);
  ctxHolder.current = ctx;
  dir = join(env.INGEST_ROOT, `batchroute-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(dir, { recursive: true });
  env.BATCH_SPLIT_ENABLED = true;
  env.VLM_BASE_URL = 'http://vlm.invalid';
  env.VLM_API_KEY = 'test-key';
});

afterEach(() => {
  env.BATCH_SPLIT_ENABLED = SAVED_ENV.enabled;
  env.VLM_BASE_URL = SAVED_ENV.vlmUrl;
  env.VLM_API_KEY = SAVED_ENV.vlmKey;
  env.BATCH_SPLIT_CONCURRENCY = SAVED_ENV.concurrency;
});

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

function writeMineruSidecar(pdfPath: string, pageTexts: string[]): void {
  writeFileSync(
    `${pdfPath}.mineru.json`,
    JSON.stringify({
      pdf_info: pageTexts.map((text, pageIdx) => ({
        page_idx: pageIdx,
        preproc_blocks: [
          {
            type: 'text',
            bbox: [20, 20 + pageIdx * 10, 180, 60 + pageIdx * 10],
            score: 0.9,
            lines: [{ text }],
          },
        ],
      })),
    }),
  );
}

interface PagePlan {
  regions: Array<Record<string, unknown>>;
}

function region(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    unitIndex: 1,
    formType: '质检报告',
    confidence: 0.95,
    bbox: { x: 0.05, y: 0.05, w: 0.9, h: 0.9 },
    rotationDeg: 0,
    evidence: '检测报告',
    identifierOrNull: null,
    ...overrides,
  };
}

/** fake VLM: 清点按页固定区域; 凭证抽取 typed 按调用序回灌编号并计数。 */
function makeVlm(
  plan: PagePlan[],
  opts: { typedIds?: string[]; typedCalls?: number[] } = {},
): VlmDeps {
  return {
    extract: async () => {
      throw new Error('voucher extract not expected');
    },
    detectUnits: async (_prompt, page) =>
      JSON.stringify({ units: plan[page.page - 1]?.regions ?? [] }),
    extractTyped: async (_images, _docType) => {
      opts.typedCalls?.push(1);
      const idx = (opts.typedCalls?.length ?? 1) - 1;
      return {
        fields: {
          出具机构: '华新水泥质检中心',
          报告编号: opts.typedIds?.[idx] ?? `HX-GEN-${idx}`,
          检测日期: '2026-08-28',
          重量_吨: 832.46,
        },
        字段置信度: { 出具机构: 0.95, 报告编号: 0.96, 检测日期: 0.95, 重量_吨: 0.9 },
      };
    },
  };
}

const SPLIT_PLAN: PagePlan[] = [
  { regions: [region({ identifierOrNull: 'HX-2026-081A', bbox: { x: 0.01, y: 0.02, w: 0.45, h: 0.95 } })] },
  { regions: [region({ identifierOrNull: 'HX-2026-082B', bbox: { x: 0.51, y: 0.02, w: 0.45, h: 0.95 } })] },
];

/** 走真实拆分管线种一个 container(2 unit 子单据, OCR 块路径)。 */
async function seedSplitContainer(fileName: string): Promise<{ containerId: string; childIds: string[] }> {
  const pdfPath = join(dir, fileName);
  await makeTwoPagePdf(pdfPath);
  writeMineruSidecar(pdfPath, ['REPORT-A HUA-XIN', 'REPORT-B HUA-XIN']);
  const { docId } = await createDocumentStub(ctxHolder.current!, { sourceUri: pdfPath, userId: 'u1' });
  fakeVlmHolder.current = makeVlm(SPLIT_PLAN);
  const res = await ensureDocumentParsed(ctxHolder.current!, docId, {
    modality: 'scanned',
    userId: 'u1',
    vlm: fakeVlmHolder.current as VlmDeps,
  });
  return { containerId: docId, childIds: res.batchSplit!.childDocIds };
}

function docIds(): string[] {
  return (ctx.sqlite.prepare('SELECT id FROM documents').all() as Array<{ id: string }>).map((r) => r.id);
}

describe('POST /api/batch/:docId/resplit', () => {
  it('重拆: 旧子单据级联删, 新 unit 行生成, unitCount 正确', async () => {
    const { containerId, childIds } = await seedSplitContainer('rs-ok.pdf');
    fakeVlmHolder.current = makeVlm(SPLIT_PLAN);

    const res = await appAs('u1').request(`/api/batch/${containerId}/resplit`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; docId: string; unitCount: number; childDocIds: string[] };
    expect(body.ok).toBe(true);
    expect(body.docId).toBe(containerId);
    expect(body.unitCount).toBe(2);
    expect(body.childDocIds).toHaveLength(2);
    for (const old of childIds) {
      expect(body.childDocIds).not.toContain(old);
      expect(docIds()).not.toContain(old); // 旧子单据 documents 行级联删
    }
    const units = await listDocumentUnitsByParent(ctx, containerId);
    expect(units).toHaveLength(2);
    expect(units.map((u) => u.childDocumentId).sort()).toEqual([...body.childDocIds].sort());
  });

  it('任一 unit 已确认绑定且未 force -> 409 unit_bound + detail; force -> 200', async () => {
    const { containerId, childIds } = await seedSplitContainer('rs-bound.pdf');
    await saveBinding(ctx, {
      documentId: childIds[0]!,
      contractNo: 'HT-1',
      relation: 'primary',
      sourceRefs: [],
      confidence: 1,
      createdBy: 'test',
    });

    const res409 = await appAs('u1').request(`/api/batch/${containerId}/resplit`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({}),
    });
    expect(res409.status).toBe(409);
    const b409 = (await res409.json()) as {
      ok: boolean; error: string; code: string; detail: Array<{ docId: string; unitIndex: number }>;
    };
    expect(b409.ok).toBe(false);
    expect(b409.code).toBe('unit_bound');
    expect(typeof b409.error).toBe('string');
    expect(b409.error.length).toBeGreaterThan(0);
    expect(b409.detail).toEqual([{ docId: childIds[0], unitIndex: 1 }]);
    // 未执行: 子单据仍在。
    expect(docIds()).toContain(childIds[0]);

    const resForce = await appAs('u1').request(`/api/batch/${containerId}/resplit`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ force: true }),
    });
    expect(resForce.status).toBe(200);
    expect(docIds()).not.toContain(childIds[0]); // force: 旧子连绑定一并删除
  });

  it('非 container / 不存在 -> 404 (error 中文, code=not_found)', async () => {
    const { docId } = await createDocumentStub(ctxHolder.current!, { sourceUri: 'file:///a.pdf', userId: 'u1' });
    const resPlain = await appAs('u1').request(`/api/batch/${docId}/resplit`, {
      method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({}),
    });
    expect(resPlain.status).toBe(404);
    const bPlain = (await resPlain.json()) as { ok: boolean; error: string; code: string };
    expect(bPlain.ok).toBe(false);
    expect(bPlain.code).toBe('not_found');

    const resMissing = await appAs('u1').request('/api/batch/DOC-nope/resplit', {
      method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({}),
    });
    expect(resMissing.status).toBe(404);
    expect(((await resMissing.json()) as { code: string }).code).toBe('not_found');
  });
});

describe('POST /api/batch/:docId/units/:unitId/reextract', () => {
  it('rotationDeg=270: 单候选重抽(fake 抽取仅一次), rotation_deg/chosenRotation 落库, 旧子删新子生', async () => {
    await ensureTemplateSeed(ctx);
    const { containerId, childIds } = await seedSplitContainer('re-rot.pdf');
    const units = await listDocumentUnitsByParent(ctx, containerId);
    const target = units[0]!;
    const oldChild = target.childDocumentId!;
    expect(oldChild).toBe(childIds[0]);

    const typedCalls: number[] = [];
    fakeVlmHolder.current = makeVlm([], {
      typedCalls,
      typedIds: [String(target.manifest.identifier)],
    });

    const res = await appAs('u1').request(`/api/batch/${containerId}/units/${target.id}/reextract`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ rotationDeg: 270 }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; unitId: string; docId: string };
    expect(body.ok).toBe(true);
    expect(body.unitId).toBe(target.id);
    // 单候选(fake VLM 该 unit 只被抽一次)。
    expect(typedCalls).toHaveLength(1);
    // 旋回覆盖与择优标记落库(来源与拆分区展示)。
    const after = (await listDocumentUnitsByParent(ctx, containerId)).find((u) => u.id === target.id)!;
    expect(after.rotationDeg).toBe(270);
    expect(after.manifest.chosenRotation).toBe(270);
    expect(after.childDocumentId).toBe(body.docId);
    expect(body.docId).not.toBe(oldChild);
    expect(docIds()).not.toContain(oldChild); // 旧子删除
    expect(docIds()).toContain(body.docId);
  });

  it('unit 已绑定未 force -> 409 unit_bound; force -> 200', async () => {
    const { containerId } = await seedSplitContainer('re-bound.pdf');
    const units = await listDocumentUnitsByParent(ctx, containerId);
    const target = units[0]!;
    await saveBinding(ctx, {
      documentId: target.childDocumentId!,
      contractNo: 'HT-2',
      relation: 'primary',
      sourceRefs: [],
      confidence: 1,
      createdBy: 'test',
    });

    const res409 = await appAs('u1').request(`/api/batch/${containerId}/units/${target.id}/reextract`, {
      method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({}),
    });
    expect(res409.status).toBe(409);
    const b409 = (await res409.json()) as {
      ok: boolean; code: string; detail: Array<{ docId: string; unitIndex: number }>;
    };
    expect(b409.code).toBe('unit_bound');
    expect(b409.detail).toEqual([{ docId: target.childDocumentId, unitIndex: 1 }]);

    const resForce = await appAs('u1').request(`/api/batch/${containerId}/units/${target.id}/reextract`, {
      method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ force: true }),
    });
    expect(resForce.status).toBe(200);
    const bForce = (await resForce.json()) as { ok: boolean; docId: string };
    expect(bForce.ok).toBe(true);
    expect(docIds()).not.toContain(target.childDocumentId);
  });

  it('非法 rotationDeg -> 400; 未知 unit / 非 container -> 404', async () => {
    const { containerId } = await seedSplitContainer('re-bad.pdf');
    const units = await listDocumentUnitsByParent(ctx, containerId);

    const resRot = await appAs('u1').request(`/api/batch/${containerId}/units/${units[0]!.id}/reextract`, {
      method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ rotationDeg: 45 }),
    });
    expect(resRot.status).toBe(400);
    expect(((await resRot.json()) as { code: string }).code).toBe('invalid_rotation');

    const resUnit = await appAs('u1').request(`/api/batch/${containerId}/units/DU-nope/reextract`, {
      method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({}),
    });
    expect(resUnit.status).toBe(404);
    expect(((await resUnit.json()) as { code: string }).code).toBe('not_found');

    const { docId: plainId } = await createDocumentStub(ctxHolder.current!, { sourceUri: 'file:///p.pdf', userId: 'u1' });
    const resPlain = await appAs('u1').request(`/api/batch/${plainId}/units/DU-x/reextract`, {
      method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({}),
    });
    expect(resPlain.status).toBe(404);
  });
});

describe('POST /api/batch/:docId/units/merge', () => {
  it('相邻两 unit 合并: 一行(unitIndex 取小) + 页码包络 + merged manifest + 旧子删除重建', async () => {
    const { containerId, childIds } = await seedSplitContainer('mg-ok.pdf');
    const units = await listDocumentUnitsByParent(ctx, containerId);
    const [u1, u2] = units;
    fakeVlmHolder.current = makeVlm([]); // 重建走 OCR 块路径(无模板种子, 不路由)

    const res = await appAs('u1').request(`/api/batch/${containerId}/units/merge`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ unitIds: [u1!.id, u2!.id] }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; mergedUnitId: string; docId: string };
    expect(body.ok).toBe(true);
    expect(body.mergedUnitId).toBe(u1!.id); // unitIndex 最小行保留

    const after = await listDocumentUnitsByParent(ctx, containerId);
    expect(after).toHaveLength(1);
    const kept = after[0]!;
    expect(kept.id).toBe(u1!.id);
    expect(kept.pageStart).toBe(1);
    expect(kept.pageEnd).toBe(2); // 包络
    expect(kept.manifest.merged).toBe(true);
    expect(kept.manifest.mergedFrom).toEqual([u1!.id, u2!.id]);
    expect((kept.manifest.regions as unknown[])).toHaveLength(2); // regions 拼接
    expect(kept.childDocumentId).toBe(body.docId);
    // 全部旧子单据删除, 新子生成。
    for (const old of childIds) {
      expect(docIds()).not.toContain(old);
    }
    expect(docIds()).toContain(body.docId);
  });

  it('unitIds<2 / 未知 unit / 跨 container -> 400 (code=invalid_unit_ids)', async () => {
    const { containerId, childIds } = await seedSplitContainer('mg-bad.pdf');
    const units = await listDocumentUnitsByParent(ctx, containerId);

    const resFew = await appAs('u1').request(`/api/batch/${containerId}/units/merge`, {
      method: 'POST', headers: JSON_HEADERS,
      body: JSON.stringify({ unitIds: [units[0]!.id] }),
    });
    expect(resFew.status).toBe(400);
    expect(((await resFew.json()) as { code: string }).code).toBe('invalid_unit_ids');

    const resUnknown = await appAs('u1').request(`/api/batch/${containerId}/units/merge`, {
      method: 'POST', headers: JSON_HEADERS,
      body: JSON.stringify({ unitIds: [units[0]!.id, 'DU-nope'] }),
    });
    expect(resUnknown.status).toBe(400);

    // 跨 container: 另建一个 container, 借用第一个的 unit id。
    const { docId: otherId } = await createDocumentStub(ctxHolder.current!, { sourceUri: 'file:///other.pdf', userId: 'u1' });
    await setDocumentBatchRole(ctx, otherId, 'container');
    const resCross = await appAs('u1').request(`/api/batch/${otherId}/units/merge`, {
      method: 'POST', headers: JSON_HEADERS,
      body: JSON.stringify({ unitIds: [units[0]!.id, units[1]!.id] }),
    });
    expect(resCross.status).toBe(400);
    expect(((await resCross.json()) as { code: string }).code).toBe('invalid_unit_ids');
    void childIds;
  });

  it('参与 unit 已绑定 -> 409 unit_bound', async () => {
    const { containerId, childIds } = await seedSplitContainer('mg-bound.pdf');
    const units = await listDocumentUnitsByParent(ctx, containerId);
    await saveBinding(ctx, {
      documentId: childIds[1]!,
      contractNo: 'HT-3',
      relation: 'primary',
      sourceRefs: [],
      confidence: 1,
      createdBy: 'test',
    });
    const res = await appAs('u1').request(`/api/batch/${containerId}/units/merge`, {
      method: 'POST', headers: JSON_HEADERS,
      body: JSON.stringify({ unitIds: [units[0]!.id, units[1]!.id] }),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { ok: boolean; code: string; detail: Array<{ docId: string; unitIndex: number }> };
    expect(body.code).toBe('unit_bound');
    expect(body.detail).toEqual([{ docId: childIds[1], unitIndex: 2 }]);
  });
});
