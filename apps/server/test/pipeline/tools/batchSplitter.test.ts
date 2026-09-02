// 批量拆分器灰度入口测试(spec 2026-09-01 Phase 1 + Phase 2):
//  - BATCH_SPLIT_ENABLED=false: 完全旧路径(VLM 不被调用/无 batch_role/无
//    document_units/无子单据);
//  - 开启 + 检测 0/1 份: 旧路径;
//  - 开启 + 检测 N>1: container + N 个子单据独立走全链路, 子单据块模型按页
//    区间切片, document_units 落库含 padding bbox 与 manifest;
//  - 幂等: 已拆分文件重跑不重复生成子单据;
//  - container 解析失败: unit 行保留 pending, 不生成子单据。
//  - Phase 2(见文末 describe): formType 经注册表映射到 voucher 路由的 unit
//    用 bbox 裁剪图走 VLM 凭证抽取(旋回双候选 + 两遍读数共识), OCR 块保留
//    给 chunk/recall; 未映射 unit 维持 OCR 路径。
//
// 夹具: pdf-lib 生成 2 页"无文字层"PDF(整页嵌入 PNG 图, 上半黑), MinerU
// hermetic sidecar 提供逐页 OCR 块; VLM 清点走注入的 fake。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { loadImage } from '@napi-rs/canvas';
import { createDb, migrate } from '../../../src/pipeline/db/client.js';
import { env } from '../../../src/env.js';
import {
  createDocumentStub,
  getDocumentParseStatus,
  loadDocument,
  listDocumentUnitsByParent,
} from '../../../src/pipeline/db/repositories.js';
import { ensureDocumentParsed } from '../../../src/pipeline/tools/documentEntry.js';
import type { VlmDeps } from '../../../src/pipeline/tools/documentEntry.js';
import { ensureTemplateSeed } from '../../../src/pipeline/templateSeed.js';
import { buildPng } from '../fixtures/png.js';

let ctx: ReturnType<typeof createDb>;
let dir: string;

const SAVED_ENV = {
  enabled: env.BATCH_SPLIT_ENABLED,
  vlmUrl: env.VLM_BASE_URL,
  vlmKey: env.VLM_API_KEY,
  concurrency: env.BATCH_SPLIT_CONCURRENCY,
  maxPages: env.BATCH_SPLIT_MAX_PAGES,
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
  env.BATCH_SPLIT_CONCURRENCY = SAVED_ENV.concurrency;
  env.BATCH_SPLIT_MAX_PAGES = SAVED_ENV.maxPages;
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
    let extractCalled = 0;
    const res = await ensureDocumentParsed(ctx, docId, {
      modality: 'scanned',
      userId: 'u1',
      vlm: {
        ...fakeDetect([{ regions: [region()] }, { regions: [region()] }], { onCall: () => { vlmCalled = true; } }),
        extractTyped: async () => {
          extractCalled += 1;
          throw new Error('开关关闭不应触发 VLM 抽取');
        },
      },
    });

    expect(vlmCalled).toBe(false);
    expect(extractCalled).toBe(0);
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

  it('container 固定「单据组」跳过分类器: classifications source=hint confidence=1', async () => {
    const pdfPath = join(dir, 'p3-doctype.pdf');
    await makeTwoPagePdf(pdfPath);
    writeMineruSidecar(pdfPath, ['REPORT-A CONTRACT HT-001', 'REPORT-B CONTRACT HT-002']);
    const docId = await stubFor(pdfPath);

    const res = await ensureDocumentParsed(ctx, docId, {
      modality: 'scanned',
      userId: 'u1',
      vlm: fakeDetect([
        { regions: [region({ identifierOrNull: 'HX-A' })] },
        { regions: [region({ identifierOrNull: 'HX-B' })] },
      ]),
    });

    expect(res.parseStatus).toBe('parsed');
    // container doc_type 固定「单据组」(2026-09-01 拍板决策 1): 不再吃词表分类噪声。
    const containerRow = ctx.sqlite
      .prepare('SELECT doc_type FROM documents WHERE id = ?')
      .get(docId) as { doc_type: string };
    expect(containerRow.doc_type).toBe('单据组');
    const clsRow = ctx.sqlite
      .prepare(
        'SELECT doc_type, confidence, source FROM classifications WHERE document_id = ? ORDER BY rowid DESC LIMIT 1',
      )
      .get(docId) as { doc_type: string; confidence: number; source: string };
    expect(clsRow.doc_type).toBe('单据组');
    expect(clsRow.source).toBe('hint');
    expect(clsRow.confidence).toBe(1);
    // unit 子单据分类不受影响(既有无分类器 hint 行为: confidence 0, 类型来自 hint)。
    const [c1] = res.batchSplit!.childDocIds;
    const childCls = ctx.sqlite
      .prepare(
        'SELECT doc_type, confidence, source FROM classifications WHERE document_id = ? ORDER BY rowid DESC LIMIT 1',
      )
      .get(c1!) as { doc_type: string; confidence: number; source: string };
    expect(childCls.source).toBe('hint');
    expect(childCls.confidence).toBe(0);
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

  it('forceResplit: 删旧子单据与 unit 行后重新检测拆分(Task 9 resplit 底座)', async () => {
    const pdfPath = join(dir, 'resplit.pdf');
    await makeTwoPagePdf(pdfPath);
    writeMineruSidecar(pdfPath, ['REPORT-A CONTRACT HT-001', 'REPORT-B CONTRACT HT-002']);
    const docId = await stubFor(pdfPath);
    const plan = [
      { regions: [region({ identifierOrNull: 'HX-A' })] },
      { regions: [region({ identifierOrNull: 'HX-B' })] },
    ];
    const first = await ensureDocumentParsed(ctx, docId, {
      modality: 'scanned',
      userId: 'u1',
      vlm: fakeDetect(plan),
    });
    const firstChildren = first.batchSplit!.childDocIds;
    expect(firstChildren).toHaveLength(2);

    const second = await ensureDocumentParsed(ctx, docId, {
      modality: 'scanned',
      userId: 'u1',
      // force: ensureDocumentParsed 对终态 'parsed' 短路(6b 语义), forceResplit
      // 只是 processDocumentWithBatch 的内部选项, 不放开终态门 —— 与既有幂等
      // 重跑用例同款显式 force。
      force: true,
      forceResplit: true,
      vlm: fakeDetect(plan),
    });
    expect(second.batchSplit!.unitCount).toBe(2);
    const secondChildren = second.batchSplit!.childDocIds;
    expect(secondChildren).toHaveLength(2);
    // 旧子单据与旧行全部消失, 新子单据挂在新 unit 行下。
    for (const old of firstChildren) {
      expect(await loadDocument(ctx, old, 'u1')).toBeNull();
    }
    expect(secondChildren.every((id) => !firstChildren.includes(id!))).toBe(true);
    const units = await listDocumentUnitsByParent(ctx, docId);
    expect(units).toHaveLength(2);
    expect(units.map((u) => u.childDocumentId).sort()).toEqual([...secondChildren].sort());
  });

  it('解析终态后 parse_stage/stage_started_at 清空(进度阶段不残留)', async () => {
    const pdfPath = join(dir, 'stage-clear.pdf');
    await makeTwoPagePdf(pdfPath);
    writeMineruSidecar(pdfPath, ['REPORT-A CONTRACT HT-001', 'REPORT-B CONTRACT HT-002']);
    const docId = await stubFor(pdfPath);

    const res = await ensureDocumentParsed(ctx, docId, {
      modality: 'scanned',
      userId: 'u1',
      vlm: fakeDetect([
        { regions: [region({ identifierOrNull: 'HX-A' })] },
        { regions: [region({ identifierOrNull: 'HX-B' })] },
      ]),
    });
    expect(res.parseStatus).toBe('parsed');

    // container + 2 unit 子单据: 全部行在终态后不得残留进度阶段。
    const rows = ctx.sqlite
      .prepare('SELECT id, parse_stage, stage_started_at FROM documents')
      .all() as Array<{ id: string; parse_stage: string | null; stage_started_at: string | null }>;
    expect(rows).toHaveLength(3);
    for (const r of rows) {
      expect(r.parse_stage).toBeNull();
      expect(r.stage_started_at).toBeNull();
    }
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

  it('页数超上限: 显式失败(reason 含实际页数与上限), 不回落整本 legacy', async () => {
    env.BATCH_SPLIT_MAX_PAGES = 1; // 2 页夹具即超限(上限取自真实配置, 非硬编码)
    const pdfPath = join(dir, 'over-limit.pdf');
    await makeTwoPagePdf(pdfPath);
    writeMineruSidecar(pdfPath, ['REPORT-A CONTRACT HT-001', 'REPORT-B CONTRACT HT-002']);
    const docId = await stubFor(pdfPath);

    let detectCalls = 0;
    const res = await ensureDocumentParsed(ctx, docId, {
      modality: 'scanned',
      userId: 'u1',
      vlm: fakeDetect(
        [
          { regions: [region({ identifierOrNull: 'HX-A' })] },
          { regions: [region({ identifierOrNull: 'HX-B' })] },
        ],
        { onCall: () => { detectCalls += 1; } },
      ),
    });

    // 显式失败: failed 终态 + 中文 reason(实际页数 + 配置上限 + 指引)。
    expect(res.parseStatus).toBe('failed');
    expect(res.reason).toContain('2 页');
    expect(res.reason).toContain('上限 1');
    expect(res.reason).toContain('拆分后分批上传');
    // parse_status 落库为 failed(前端现有失败渲染可直接用)。
    expect((await getDocumentParseStatus(ctx, docId, 'u1'))).toBe('failed');
    // 不回落 legacy: 无 sidecar 解析副作用, 不产生子单据。
    expect(docRows()).toHaveLength(1);
    expect((res as { batchSplit?: unknown }).batchSplit).toBeUndefined();
    // 上限判定在逐页清点之前(render 后即拒): VLM 一次都不被调用。
    expect(detectCalls).toBe(0);
  });

  it('其他检测失败(VLM 输出坏)仍回落整本 legacy, 不显式失败', async () => {
    const pdfPath = join(dir, 'vlm-fail.pdf');
    await makeTwoPagePdf(pdfPath);
    writeMineruSidecar(pdfPath, ['REPORT-A CONTRACT HT-001', 'REPORT-B CONTRACT HT-002']);
    const docId = await stubFor(pdfPath);

    const res = await ensureDocumentParsed(ctx, docId, {
      modality: 'scanned',
      userId: 'u1',
      vlm: {
        extract: async () => {
          throw new Error('voucher extract not expected');
        },
        detectUnits: async () => {
          throw new Error('vlm 输出无法解析');
        },
      },
    });

    // 回落旧路径: 无 batchSplit 摘要, 结果是 legacy 解析的终态(此处 sidecar
    // 在 -> parsed), 绝不是页数超限式失败。
    expect(res.batchSplit).toBeUndefined();
    expect(res.parseStatus).toBe('parsed');
    expect(res.reason).toBeUndefined();
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

// ---- Phase 2(抽取层): 裁剪图 VLM 凭证抽取 + 旋回双候选 + 两遍读数共识 ------
//
// 与 Phase 1 用例的差异: 这里 ensureTemplateSeed 灌入 formTypes 映射, 使
// 检测 formType(经 UNIT_FORM_TYPE_ALIASES 桥)能路由到 voucher 抽取;
// extractTyped/extractOne 注入 fake, 断言裁剪图入参、双候选择优、
// needs_review 联动与 OCR chunk 保留。

interface ExtractionRow {
  doc_type: string;
  fields: string;
  field_meta: string;
  overall_confidence: number;
  needs_review: number;
}

function extractionRow(docId: string): ExtractionRow | undefined {
  return ctx.sqlite
    .prepare('SELECT doc_type, fields, field_meta, overall_confidence, needs_review FROM extractions WHERE document_id = ?')
    .get(docId) as ExtractionRow | undefined;
}

function chunkTexts(docId: string): string[] {
  return (ctx.sqlite
    .prepare('SELECT chunk_text FROM doc_chunk WHERE document_id = ? ORDER BY chunk_index')
    .all(docId) as Array<{ chunk_text: string }>).map((r) => r.chunk_text);
}

describe('processDocumentWithBatch Phase 2 (抽取层)', () => {
  it('voucher 路由 unit: bbox 裁剪图走 VLM 抽取, OCR 块保留给 chunk/recall, 编号一致不入复核', async () => {
    await ensureTemplateSeed(ctx);
    const pdfPath = join(dir, 'p2-routed.pdf');
    await makeTwoPagePdf(pdfPath);
    writeMineruSidecar(pdfPath, ['REPORT-A HUA-XIN', 'REPORT-B HUA-XIN']);
    const docId = await stubFor(pdfPath);

    const seenImages: Array<Array<{ width: number; height: number }>> = [];
    const vlm: VlmDeps = {
      ...fakeDetect([
        { regions: [region({ identifierOrNull: 'HX-2026-081A', bbox: { x: 0.01, y: 0.02, w: 0.45, h: 0.95 } })] },
        { regions: [region({ identifierOrNull: 'HX-2026-082B', bbox: { x: 0.51, y: 0.02, w: 0.45, h: 0.95 } })] },
      ]),
      extractTyped: async (images, docType) => {
        expect(docType).toBe('化验报告');
        const dims = [];
        for (const img of images) dims.push(await sizeOf(img.buffer));
        seenImages.push(dims);
        return {
          fields: {
            出具机构: '华新水泥质检中心',
            报告编号: 'HX-2026-081A',
            检测日期: '2026-08-28',
            重量_吨: 832.46,
          },
          字段置信度: { 出具机构: 0.95, 报告编号: 0.96, 检测日期: 0.95, 重量_吨: 0.9 },
        };
      },
    };

    const res = await ensureDocumentParsed(ctx, docId, { modality: 'scanned', userId: 'u1', vlm });

    expect(res.batchSplit!.childDocIds).toHaveLength(2);
    // 每个子单据一次多图抽取(rotationDeg=0 单候选), 入参是 bbox 裁剪图:
    // 页宽 200pt@150dpi ~= 417px, 裁剪 0.45 宽 + padding -> 远小于整页宽。
    expect(seenImages).toHaveLength(2);
    for (const dims of seenImages) {
      expect(dims).toHaveLength(1);
      expect(dims[0]!.width).toBeGreaterThan(100);
      expect(dims[0]!.width).toBeLessThan(300);
    }

    const [c1] = res.batchSplit!.childDocIds;
    // 抽取来自 VLM(裁剪图), 分类为注册表映射的 化验报告。
    const ext = extractionRow(c1!);
    expect(ext).toBeDefined();
    expect(ext!.doc_type).toBe('化验报告');
    const fields = JSON.parse(ext!.fields) as Record<string, { value: unknown }>;
    expect(fields['报告编号']!.value).toBe('HX-2026-081A');
    // 两遍读数一致 -> 不强制复核。
    expect(ext!.needs_review).toBe(0);
    expect(ext!.overall_confidence).toBeGreaterThanOrEqual(0.85);
    const meta = JSON.parse(ext!.field_meta) as Record<string, { warnings?: string[] }>;
    expect(meta['_warnings']!.warnings).toEqual([]);
    // OCR 块保留给 chunk/recall(页区间切片文本仍在), 且含凭证 KV 合成块。
    const text = chunkTexts(c1!).join('\n');
    expect(text).toContain('REPORT-A');
    expect(text).toContain('报告编号:HX-2026-081A');
    expect(text).not.toContain('REPORT-B');
  });

  it('rotationDeg=90: 双候选各抽一次, 两遍共识命中者胜出(即使其自报置信度更低)', async () => {
    await ensureTemplateSeed(ctx);
    env.BATCH_SPLIT_CONCURRENCY = 1; // 候选次序确定性(fake 按调用序回灌)
    const pdfPath = join(dir, 'p2-rot.pdf');
    await makeTwoPagePdf(pdfPath);
    writeMineruSidecar(pdfPath, ['REPORT-A', 'REPORT-B']);
    const docId = await stubFor(pdfPath);

    const widths: number[] = [];
    let call = 0;
    const vlm: VlmDeps = {
      ...fakeDetect([
        { regions: [region({ identifierOrNull: 'HX-2026-081A', rotationDeg: 90, bbox: { x: 0.05, y: 0.05, w: 0.4, h: 0.9 } })] },
        { regions: [region({ identifierOrNull: 'HX-2026-082B' })] },
      ]),
      extractTyped: async (images, docType) => {
        expect(docType).toBe('化验报告');
        widths.push((await sizeOf(images[0]!.buffer)).width);
        call += 1;
        // 候选1(检测方向 90): 读数与检测遍不一致且置信度高;
        // 候选2(反向 270): 读数一致但自报置信度略低——共识必须压过自报置信度。
        const matched = call === 2;
        return {
          fields: {
            出具机构: '华新水泥质检中心',
            报告编号: matched ? 'HX-2026-081A' : 'HX-2026-999Z',
            检测日期: '2026-08-28',
          },
          字段置信度: { 出具机构: 0.9, 报告编号: matched ? 0.87 : 0.99, 检测日期: 0.9 },
        };
      },
    };

    const res = await ensureDocumentParsed(ctx, docId, { modality: 'scanned', userId: 'u1', vlm });

    // 双候选: 同一 unit 抽了两次(两个方向的裁剪图), 第二个 unit 只抽一次。
    expect(call).toBe(3);
    expect(widths).toHaveLength(3);
    const [c1] = res.batchSplit!.childDocIds;
    const ext = extractionRow(c1!);
    const fields = JSON.parse(ext!.fields) as Record<string, { value: unknown }>;
    expect(fields['报告编号']!.value).toBe('HX-2026-081A'); // 取共识命中的候选
    expect(ext!.needs_review).toBe(0);
  });

  it('两遍读数分歧(编号+净重): 压低 overall_confidence 并强制 needs_review', async () => {
    await ensureTemplateSeed(ctx);
    const pdfPath = join(dir, 'p2-consensus.pdf');
    await makeTwoPagePdf(pdfPath);
    writeMineruSidecar(pdfPath, ['REPORT-A', 'REPORT-B']);
    const docId = await stubFor(pdfPath);

    const vlm: VlmDeps = {
      ...fakeDetect([
        { regions: [region({ formType: '汽运磅单', identifierOrNull: '10384417', evidence: '汽车衡计量单 编号10384417 净重34250kg', bbox: { x: 0.05, y: 0.05, w: 0.4, h: 0.4 } })] },
        { regions: [region({ formType: '汽运磅单', identifierOrNull: '10384418', evidence: '汽车衡计量单', bbox: { x: 0.05, y: 0.5, w: 0.4, h: 0.4 } })] },
      ]),
      extractOne: async () => ({
        // 两遍读数分歧: 编号 10394417 vs 检测遍 10384417; 净重 54.52吨 vs 34250kg。
        fields: { 编号: '10394417', 毛重_吨: 79.8, 皮重_吨: 25.28, 净重_吨: 54.52 },
      }),
    };

    const res = await ensureDocumentParsed(ctx, docId, { modality: 'scanned', userId: 'u1', vlm });
    expect(res.batchSplit!.childDocIds).toHaveLength(2);
    const [c1] = res.batchSplit!.childDocIds;
    const ext = extractionRow(c1!);
    expect(ext!.doc_type).toBe('汽运磅单');
    expect(ext!.needs_review).toBe(1);
    expect(ext!.overall_confidence).toBeLessThanOrEqual(0.5);
    const meta = JSON.parse(ext!.field_meta) as Record<string, { confidence: number; warnings?: string[] }>;
    const warnings = meta['_warnings']!.warnings!;
    expect(warnings.some((w) => w.includes('10384417') && w.includes('10394417'))).toBe(true);
    expect(warnings.some((w) => w.includes('34250') && w.includes('54.52'))).toBe(true);
    // 分歧字段的置信度同步压低。
    expect(meta['明细行']!.confidence).toBeLessThanOrEqual(0.5);
    // 重量组单图单抽: 聚合字段齐备。
    const fields = JSON.parse(ext!.fields) as Record<string, { value: unknown }>;
    expect(fields['总净重_吨']!.value).toBe(54.52);
    expect(JSON.parse(String(fields['明细行']!.value)) as unknown[]).toHaveLength(1);
  });

  it('重量组双候选择优: 反向候选读数与检测遍一致时胜出且不入复核', async () => {
    await ensureTemplateSeed(ctx);
    env.BATCH_SPLIT_CONCURRENCY = 1; // 候选次序确定性(fake 按调用序回灌)
    const pdfPath = join(dir, 'p2-weight-rot.pdf');
    await makeTwoPagePdf(pdfPath);
    writeMineruSidecar(pdfPath, ['REPORT-A', 'REPORT-B']);
    const docId = await stubFor(pdfPath);

    let call = 0;
    const vlm: VlmDeps = {
      ...fakeDetect([
        { regions: [region({ formType: '汽运磅单', identifierOrNull: '10384417', rotationDeg: 270, bbox: { x: 0.05, y: 0.05, w: 0.4, h: 0.4 } })] },
        { regions: [region({ formType: '汽运磅单', identifierOrNull: '10384418', bbox: { x: 0.05, y: 0.5, w: 0.4, h: 0.4 } })] },
      ]),
      extractOne: async () => {
        call += 1;
        // unit1 候选1(检测方向 270)读反; 候选2(90)读正; unit2 单候选读正。
        const id = call === 1 ? '10394417' : call === 2 ? '10384417' : '10384418';
        return { fields: { 编号: id, 毛重_吨: 49.8, 皮重_吨: 15.55, 净重_吨: 34.25 } };
      },
    };

    const res = await ensureDocumentParsed(ctx, docId, { modality: 'scanned', userId: 'u1', vlm });
    const [c1, c2] = res.batchSplit!.childDocIds;
    const e1 = extractionRow(c1!);
    const fields1 = JSON.parse(e1!.fields) as Record<string, { value: unknown }>;
    expect(fields1['明细行']).toBeDefined();
    const rows = JSON.parse(String(fields1['明细行']!.value)) as Array<{ 编号: string }>;
    expect(rows[0]!.编号).toBe('10384417');
    expect(e1!.needs_review).toBe(0); // 共识命中的候选, 无分歧
    expect(extractionRow(c2!)).toBeDefined();
  });

  it('未映射 formType(微信聊天记录): 不走 VLM 抽取, 维持 OCR 块路径', async () => {
    await ensureTemplateSeed(ctx);
    const pdfPath = join(dir, 'p2-unrouted.pdf');
    await makeTwoPagePdf(pdfPath);
    writeMineruSidecar(pdfPath, ['WECHAT-A 转账 5000', 'WECHAT-B 收到']);
    const docId = await stubFor(pdfPath);

    let extractCalled = 0;
    const vlm: VlmDeps = {
      ...fakeDetect([
        { regions: [region({ formType: '微信聊天记录', identifierOrNull: null })] },
        { regions: [region({ formType: '微信聊天记录', identifierOrNull: null })] },
      ]),
      extractTyped: async () => {
        extractCalled += 1;
        throw new Error('不应被调用');
      },
      extractOne: async () => {
        extractCalled += 1;
        throw new Error('不应被调用');
      },
    };

    const res = await ensureDocumentParsed(ctx, docId, { modality: 'scanned', userId: 'u1', vlm });
    expect(res.batchSplit!.childDocIds).toHaveLength(2);
    expect(extractCalled).toBe(0);
    const [c1] = res.batchSplit!.childDocIds;
    expect(chunkTexts(c1!).join('\n')).toContain('WECHAT-A');
    expect(extractionRow(c1!)).toBeUndefined(); // OCR 路径的抽取由后台 auto-extract 负责(未注入)
  });
});

async function sizeOf(buf: Buffer): Promise<{ width: number; height: number }> {
  const img = await loadImage(buf);
  return { width: img.width, height: img.height };
}
