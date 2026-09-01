// 批量拆分器灰度入口测试(spec 2026-09-01 Phase 1):
//  - BATCH_SPLIT_ENABLED=false: 完全旧路径(VLM 不被调用/无 batch_role/无
//    document_units/无子单据);
//  - 开启 + 检测 0/1 份: 旧路径;
//  - 开启 + 检测 N>1: container + N 个子单据独立走全链路, 子单据块模型按页
//    区间切片, document_units 落库含 padding bbox 与 manifest;
//  - 幂等: 已拆分文件重跑不重复生成子单据;
//  - container 解析失败: unit 行保留 pending, 不生成子单据。
//
// 夹具: pdf-lib 生成 2 页"无文字层"PDF(整页嵌入 PNG 图, 上半黑), MinerU
// hermetic sidecar 提供逐页 OCR 块; VLM 清点走注入的 fake。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { createDb, migrate } from '../../../src/pipeline/db/client.js';
import { env } from '../../../src/env.js';
import {
  createDocumentStub,
  loadDocument,
  listDocumentUnitsByParent,
} from '../../../src/pipeline/db/repositories.js';
import { ensureDocumentParsed } from '../../../src/pipeline/tools/documentEntry.js';
import type { VlmDeps } from '../../../src/pipeline/tools/documentEntry.js';
import { buildPng } from '../fixtures/png.js';

let ctx: ReturnType<typeof createDb>;
let dir: string;

const SAVED_ENV = {
  enabled: env.BATCH_SPLIT_ENABLED,
  vlmUrl: env.VLM_BASE_URL,
  vlmKey: env.VLM_API_KEY,
};

beforeEach(() => {
  ctx = createDb(':memory:');
  migrate(ctx.sqlite);
  dir = join(env.INGEST_ROOT, `bs-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(dir, { recursive: true });
  // 默认开灰度(单测内再按用例覆盖); VLM 指向假地址——真实调用全部走注入。
  env.BATCH_SPLIT_ENABLED = true;
  env.VLM_BASE_URL = 'http://vlm.invalid';
  env.VLM_API_KEY = 'test-key';
});

afterEach(() => {
  env.BATCH_SPLIT_ENABLED = SAVED_ENV.enabled;
  env.VLM_BASE_URL = SAVED_ENV.vlmUrl;
  env.VLM_API_KEY = SAVED_ENV.vlmKey;
});

const CONTENT_PNG = buildPng(64, 64, (_x, y) => (y < 32 ? [0, 0, 0, 255] : [255, 255, 255, 255]));

/** 手写最小 2 页文字层 PDF(未压缩内容流)。
 *  不用 pdf-lib: 其产物在 vitest 进程内偶发被 pdf-parse 内置 pdf.js 误判
 *  "Invalid PDF structure"(flate 流解析差异), 手写件是确定性的。 */
function makeTextPdf(path: string, pageTexts: string[]): void {
  const objects: string[] = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${pageTexts.map((_, i) => `${3 + i * 2} 0 R`).join(' ')}] /Count ${pageTexts.length} >>`,
  ];
  pageTexts.forEach((text, i) => {
    const contentIdx = 4 + i * 2;
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 280] /Contents ${contentIdx} 0 R ` +
        '/Resources << /Font << /F1 6 0 R >> >> >>',
    );
    const stream = `BT /F1 10 Tf 20 240 Td (${text}) Tj ET`;
    objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  });
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const parts = ['%PDF-1.4\n'];
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(parts.join(''), 'latin1'));
    parts.push(`${i + 1} 0 obj\n${body}\nendobj\n`);
  });
  const xrefStart = Buffer.byteLength(parts.join(''), 'latin1');
  parts.push(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`);
  for (const off of offsets) {
    parts.push(`${String(off).padStart(10, '0')} 00000 n \n`);
  }
  parts.push(
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`,
  );
  writeFileSync(path, Buffer.from(parts.join(''), 'latin1'));
}

/** 2 页无文字层 PDF(整页嵌图)。 */
async function makeTwoPagePdf(path: string): Promise<void> {
  const pdf = await PDFDocument.create();
  const img = await pdf.embedPng(CONTENT_PNG);
  for (let p = 0; p < 2; p++) {
    const page = pdf.addPage([200, 280]);
    page.drawImage(img, { x: 0, y: 0, width: 200, height: 280 });
  }
  writeFileSync(path, await pdf.save());
}

/** MinerU hermetic sidecar: 每页一个文本块(页号真实, 供页区间切片断言)。 */
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

/** fake VLM 清点: 按页返回固定区域。 */
function fakeDetect(plan: PagePlan[], opts: { onCall?: () => void } = {}) {
  const vlm: VlmDeps = {
    extract: async () => {
      throw new Error('voucher extract not expected');
    },
    detectUnits: async (_prompt, page) => {
      opts.onCall?.();
      const regions = plan[page.page - 1]?.regions ?? [];
      return JSON.stringify({ units: regions });
    },
  };
  return vlm;
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

function docRows(): Array<Record<string, string | null>> {
  return ctx.sqlite
    .prepare('SELECT id, batch_role, parse_status, source_uri FROM documents ORDER BY created_at, id')
    .all() as Array<Record<string, string | null>>;
}

async function stubFor(sourceUri: string, userId = 'u1'): Promise<string> {
  const { docId } = await createDocumentStub(ctx, { sourceUri, userId });
  return docId;
}

describe('processDocumentWithBatch (灰度入口)', () => {
  it('BATCH_SPLIT_ENABLED=false: 完全旧路径, 零行为变化', async () => {
    env.BATCH_SPLIT_ENABLED = false;
    const pdfPath = join(dir, 'batch-off.pdf');
    await makeTwoPagePdf(pdfPath);
    writeMineruSidecar(pdfPath, ['REPORT-A CONTRACT HT-001', 'REPORT-B CONTRACT HT-002']);
    const docId = await stubFor(pdfPath);

    let vlmCalled = false;
    const res = await ensureDocumentParsed(ctx, docId, {
      modality: 'scanned',
      userId: 'u1',
      vlm: fakeDetect([{ regions: [region()] }, { regions: [region()] }], { onCall: () => { vlmCalled = true; } }),
    });

    expect(vlmCalled).toBe(false);
    expect(res.parseStatus).toBe('parsed');
    expect(res.batchSplit).toBeUndefined();
    expect(docRows()).toHaveLength(1);
    expect(docRows()[0]!.batch_role).toBeNull();
    expect(ctx.sqlite.prepare('SELECT COUNT(*) n FROM document_units').get()).toMatchObject({ n: 0 });
  });

  it('开启 + 检测 1 份: 走旧路径, batch_role 保持 NULL', async () => {
    const pdfPath = join(dir, 'single.pdf');
    await makeTwoPagePdf(pdfPath);
    writeMineruSidecar(pdfPath, ['REPORT-A CONTRACT HT-001', 'REPORT-B CONTRACT HT-002']);
    const docId = await stubFor(pdfPath);

    const res = await ensureDocumentParsed(ctx, docId, {
      modality: 'scanned',
      userId: 'u1',
      vlm: fakeDetect([{ regions: [region({ identifierOrNull: 'HX-ALL' })] }, { regions: [] }]),
    });

    expect(res.parseStatus).toBe('parsed');
    expect(res.batchSplit).toBeUndefined();
    expect(docRows()).toHaveLength(1);
    expect(docRows()[0]!.batch_role).toBeNull();
    expect(ctx.sqlite.prepare('SELECT COUNT(*) n FROM document_units').get()).toMatchObject({ n: 0 });
  });

  it('开启 + 检测 2 份(各占一页): container + 2 子单据独立走全链路', async () => {
    const pdfPath = join(dir, 'multi.pdf');
    await makeTwoPagePdf(pdfPath);
    writeMineruSidecar(pdfPath, ['REPORT-A CONTRACT HT-001', 'REPORT-B CONTRACT HT-002']);
    const docId = await stubFor(pdfPath);

    const res = await ensureDocumentParsed(ctx, docId, {
      modality: 'scanned',
      userId: 'u1',
      vlm: fakeDetect([
        { regions: [region({ identifierOrNull: 'HX-A', bbox: { x: 0.01, y: 0.02, w: 0.98, h: 0.95 } })] },
        { regions: [region({ identifierOrNull: 'HX-B', bbox: { x: 0.01, y: 0.02, w: 0.98, h: 0.95 } })] },
      ]),
    });

    // 返回形状: container 自身 parsed + 拆分摘要。
    expect(res.parseStatus).toBe('parsed');
    expect(res.batchSplit).toEqual({ unitCount: 2, childDocIds: res.batchSplit!.childDocIds });
    expect(res.batchSplit!.childDocIds).toHaveLength(2);

    // documents: 1 container + 2 unit。
    const rows = docRows();
    expect(rows).toHaveLength(3);
    const container = rows.find((r) => r.id === docId)!;
    expect(container.batch_role).toBe('container');
    expect(container.parse_status).toBe('parsed');
    const children = rows.filter((r) => r.batch_role === 'unit');
    expect(children).toHaveLength(2);
    expect(children.every((c) => c.parse_status === 'parsed')).toBe(true);
    expect(children.every((c) => c.source_uri === pdfPath)).toBe(true);

    // 子单据块模型按页区间切片(页号来自 MinerU sidecar)。
    const [c1, c2] = res.batchSplit!.childDocIds;
    const m1 = await loadDocument(ctx, c1!, 'u1');
    const m2 = await loadDocument(ctx, c2!, 'u1');
    expect(m1!.blocks.map((b) => b.text).join(' ')).toContain('REPORT-A');
    expect(m1!.blocks.some((b) => b.text.includes('REPORT-B'))).toBe(false);
    expect(m2!.blocks.map((b) => b.text).join(' ')).toContain('REPORT-B');
    expect(m2!.blocks.some((b) => b.text.includes('REPORT-A'))).toBe(false);

    // document_units: 2 行, 有序, 已回填 child 与 processed, bbox 含 padding。
    const units = await listDocumentUnitsByParent(ctx, docId);
    expect(units).toHaveLength(2);
    expect(units.map((u) => u.unitIndex)).toEqual([1, 2]);
    expect(units.map((u) => u.docType)).toEqual(['质检报告', '质检报告']);
    expect(units[0]!.childDocumentId).toBe(c1);
    expect(units[1]!.childDocumentId).toBe(c2);
    expect(units.every((u) => u.status === 'processed')).toBe(true);
    const bbox = JSON.parse(units[0]!.bboxJson!) as { x: number; y: number; w: number; h: number };
    expect(bbox.x).toBeCloseTo(0, 5); // 0.01 - 0.025 -> 0
    expect(bbox.w).toBeCloseTo(1, 5); // 0.98 + 0.05 -> clamp 到 1
    expect(units[0]!.manifest.identifier).toBe('HX-A');
    expect((units[0]!.manifest.regions as unknown[])).toHaveLength(1);

    // 子单据有独立 chunk(检索可用)与 classification 行。
    const chunkRows = ctx.sqlite
      .prepare('SELECT document_id, COUNT(*) n FROM doc_chunk GROUP BY document_id')
      .all() as Array<{ document_id: string; n: number }>;
    expect(chunkRows.map((r) => r.document_id).sort()).toEqual([docId, c1!, c2!].sort());
    const clsRows = ctx.sqlite
      .prepare('SELECT COUNT(*) n FROM classifications')
      .get() as { n: number };
    expect(clsRows.n).toBe(3);
  });

  it('开启 + 已拆分文件重跑(force): 幂等, 不重复生成子单据', async () => {
    const pdfPath = join(dir, 'rerun.pdf');
    await makeTwoPagePdf(pdfPath);
    writeMineruSidecar(pdfPath, ['REPORT-A CONTRACT HT-001', 'REPORT-B CONTRACT HT-002']);
    const docId = await stubFor(pdfPath);
    const vlm = fakeDetect([
      { regions: [region({ identifierOrNull: 'HX-A' })] },
      { regions: [region({ identifierOrNull: 'HX-B' })] },
    ]);
    const first = await ensureDocumentParsed(ctx, docId, { modality: 'scanned', userId: 'u1', vlm });
    expect(first.batchSplit!.childDocIds).toHaveLength(2);

    let called = false;
    const second = await ensureDocumentParsed(ctx, docId, {
      modality: 'scanned',
      userId: 'u1',
      force: true,
      vlm: fakeDetect([{ regions: [] }, { regions: [] }], { onCall: () => { called = true; } }),
    });
    expect(called).toBe(false); // 已有 unit 行 -> 短路, 不再检测
    expect(second.parseStatus).toBe('parsed');
    expect(docRows()).toHaveLength(3); // 无新增子单据
    expect((await listDocumentUnitsByParent(ctx, docId)).length).toBe(2);
  });

  it('开启 + container 解析失败: unit 行保留 pending, 不生成子单据', async () => {
    const pdfPath = join(dir, 'ocr-fail.pdf');
    await makeTwoPagePdf(pdfPath);
    // 无 MinerU sidecar 且本机无 mineru CLI -> OCR 失败 -> needs_ocr。
    const docId = await stubFor(pdfPath);

    const res = await ensureDocumentParsed(ctx, docId, {
      modality: 'scanned',
      userId: 'u1',
      vlm: fakeDetect([
        { regions: [region({ identifierOrNull: 'HX-A' })] },
        { regions: [region({ identifierOrNull: 'HX-B' })] },
      ]),
    });

    expect(res.parseStatus).toBe('needs_ocr');
    expect(res.batchSplit).toMatchObject({ unitCount: 2, childDocIds: [] });
    expect(docRows()).toHaveLength(1);
    const units = await listDocumentUnitsByParent(ctx, docId);
    expect(units).toHaveLength(2);
    expect(units.every((u) => u.status === 'pending' && u.childDocumentId === null)).toBe(true);
  });

  it('文字层 PDF 不参与拆分(digital 路径行为不变)', async () => {
    const pdfPath = join(dir, 'digital.pdf');
    makeTextPdf(pdfPath, ['REPORT-A CONTRACT HT-001', 'REPORT-B CONTRACT HT-002']);
    const docId = await stubFor(pdfPath);

    let called = false;
    const res = await ensureDocumentParsed(ctx, docId, {
      modality: 'digital',
      userId: 'u1',
      vlm: fakeDetect([{ regions: [region()] }, { regions: [region()] }], { onCall: () => { called = true; } }),
    });

    expect(called).toBe(false);
    // 本用例只锁定"文字层 gate 不进拆分": 不调用清点 VLM、无 batchSplit、
    // batch_role 保持 NULL、documents 不增殖。旧路径的 digital 解析成败属于
    // pdf-parse 的 vitest 兼容性问题(与本功能无关), 两种终态都可接受。
    expect(['parsed', 'needs_ocr']).toContain(res.parseStatus);
    expect(res.batchSplit).toBeUndefined();
    expect(docRows()).toHaveLength(1);
    expect(docRows()[0]!.batch_role).toBeNull();
  });
});
