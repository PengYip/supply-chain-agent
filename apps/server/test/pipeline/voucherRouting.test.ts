// v2.1 双分支路由集成测试(processDocument VLM 门控, spec 2026-08-28 §4/§6)。
// 全 hermetic: pdf-lib 生成无文字层 PDF 夹具; VLM 依赖注入 fake; OCR 兜底走
// <file>.mineru.json hermetic 模式(同 mineruAdapter.test.ts)。不依赖真实 VLM/MinerU。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
// 隔离文字层探测: vitest 下 pdf-parse(老 pdfjs CJS)对 pdf-lib 夹具行为不确定
// (interop 差异, probe 偶发 null/抛错)。路由用例统一走"图像型 PDF"前提。
// probe 自身行为由 digitalAdapter 既有测试覆盖。
vi.mock('../../src/pipeline/digitalAdapter.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/pipeline/digitalAdapter.js')>();
  return { ...actual, pdfHasTextLayer: vi.fn(async () => false as boolean | null) };
});
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PDFDocument, rgb } from 'pdf-lib';
import { createDb, migrate } from '../../src/pipeline/db/client.js';
import { env } from '../../src/env.js';
import { processDocument, type VlmDeps } from '../../src/pipeline/tools/documentEntry.js';
import type { VlmResult } from '../../src/pipeline/vlmAdapter.js';
import { createDocumentStub, listTemplateTypes } from '../../src/pipeline/db/repositories.js';
import { ensureTemplateSeed } from '../../src/pipeline/templateSeed.js';

let ctx: ReturnType<typeof createDb>;
let dir: string;
let twoPagePdf: string;

const savedEnv = {
  base: env.VLM_BASE_URL,
  key: env.VLM_API_KEY,
};

beforeEach(async () => {
  // 门控的 VLM 已配置检查读 env 快照: CI 无根 .env, 此处显式置上并保存,
  // 保证用例不依赖宿主环境泄漏(VLM 未配置用例在用例内显式置 undefined)。
  savedEnv.base = env.VLM_BASE_URL;
  savedEnv.key = env.VLM_API_KEY;
  env.VLM_BASE_URL = 'https://vlm.test';
  env.VLM_API_KEY = 'test-key';
  ctx = createDb(':memory:');
  migrate(ctx.sqlite);
  await ensureTemplateSeed(ctx);
  dir = join(env.INGEST_ROOT, `route-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(dir, { recursive: true });
  const doc = await PDFDocument.create();
  for (let i = 0; i < 2; i++) {
    const p = doc.addPage([595, 842]);
    p.drawRectangle({ x: 50, y: 50, width: 495, height: 742, color: rgb(0, 0, 0) });
  }
  twoPagePdf = join(dir, 'scan.pdf');
  // useObjectStreams:false -> 经典 xref 结构, 老 pdfjs(pdf-parse 文字层探测)可解析。
  writeFileSync(twoPagePdf, await doc.save({ useObjectStreams: false }));
});

afterEach(() => {
  env.VLM_BASE_URL = savedEnv.base;
  env.VLM_API_KEY = savedEnv.key;
});

/** OCR 兜底夹具: hermetic .mineru.json(ingestWithMinerU 优先读取)。 */
function seedMineruFixture(pdfPath: string): void {
  writeFileSync(`${pdfPath}.mineru.json`, JSON.stringify({
    pdf_info: [{
      page_idx: 0,
      preproc_blocks: [{ type: 'text', lines: [{ text: '煤炭买卖合同 甲方 乙方 条款' }] }],
    }],
  }));
}

interface FakeOverrides {
  classifyResult?: { formType: string; confidence: number };
  classifyError?: string;
  /** Direct throw object (e.g. error carrying statusCode/responseBody) for classification tests. */
  classifyErrorObj?: unknown;
  extractOne?: (image: { buffer: Buffer }, docType: string) => Promise<{ fields: Record<string, unknown> }>;
  extractTyped?: (images: unknown[], docType: string) => Promise<{ fields: Record<string, unknown>; 字段置信度: Record<string, number> }>;
}

function fakeVlm(ov: FakeOverrides): VlmDeps & { classifyCalls: number; extractOneCalls: number; extractTypedCalls: number } {
  const self = {
    classifyCalls: 0,
    extractOneCalls: 0,
    extractTypedCalls: 0,
    extract: async (): Promise<VlmResult> => {
      throw new Error('单图路径不应被调用');
    },
    classify: async (input: { formTypes: string[] }) => {
      self.classifyCalls += 1;
      if (ov.classifyErrorObj) throw ov.classifyErrorObj;
      if (ov.classifyError) throw new Error(ov.classifyError);
      return ov.classifyResult ?? { formType: '其他', confidence: 0 };
    },
    extractTyped: async (images: unknown[], docType: string) => {
      self.extractTypedCalls += 1;
      if (!ov.extractTyped) throw new Error('extractTyped 不应被调用');
      return ov.extractTyped(images, docType);
    },
    extractOne: async (image: { buffer: Buffer }, docType: string) => {
      self.extractOneCalls += 1;
      if (!ov.extractOne) throw new Error('extractOne 不应被调用');
      return ov.extractOne(image, docType);
    },
  };
  return self;
}

describe('processDocument PDF VLM 门控路由', () => {
  it('voucher 命中(重量组): 逐页聚合, parsed + docType=汽运磅单 + 总净重落库', async () => {
    const { docId } = await createDocumentStub(ctx, { sourceUri: twoPagePdf, filename: 'scan.pdf' });
    const vlm = fakeVlm({
      classifyResult: { formType: '汽车过磅单票据', confidence: 0.93 },
      extractOne: async (img) => {
        const n = img.buffer[0]!;
        return {
          fields: {
            编号: `ERP${n}`, 车号: `渝A${n}000`,
            毛重_吨: 48.5, 皮重_吨: 16.0, 净重_吨: 32.5,
          },
        };
      },
    });
    const res = await processDocument(ctx, docId, { vlm });
    expect(res.parseStatus).toBe('parsed');
    expect(res.classifiedDocType).toBe('汽运磅单');
    expect(res.classificationSource).toBe('classified');
    expect(vlm.classifyCalls).toBe(1);
    expect(vlm.extractOneCalls).toBeGreaterThanOrEqual(2);

    const ex = ctx.sqlite
      .prepare('SELECT fields FROM extractions WHERE document_id = ?')
      .get(docId) as { fields: string };
    const fields = JSON.parse(ex.fields) as Record<string, { value: unknown }>;
    expect(fields['总净重_吨'].value).toBe(65);
    const doc = ctx.sqlite
      .prepare('SELECT parse_status AS s, doc_type AS d FROM documents WHERE id = ?')
      .get(docId) as { s: string; d: string };
    expect(doc.s).toBe('parsed');
    expect(doc.d).toBe('汽运磅单');
  });

  it('voucher 命中(非重量组): extractTyped 多图一次调用, docType=货转单', async () => {
    const { docId } = await createDocumentStub(ctx, { sourceUri: twoPagePdf, filename: 'hz.pdf' });
    const vlm = fakeVlm({
      classifyResult: { formType: '货权转移证明', confidence: 0.9 },
      extractTyped: async () => ({
        fields: {
          编号: 'HZ-1', 合同号: 'HT-001', 买方: '甲', 卖方: '乙',
          交货日期: '2025-01-01', 交货地点: '港', 交货总量_吨: 100,
          明细行: [{ 数量_吨: 100, 含税总价_元: 50000 }], 合计含税总价_元: 50000,
        },
        字段置信度: { 合同号: 0.95 },
      }),
    });
    const res = await processDocument(ctx, docId, { vlm });
    expect(res.parseStatus).toBe('parsed');
    expect(res.classifiedDocType).toBe('货转单');
    expect(vlm.extractTypedCalls).toBe(1);
    expect(vlm.extractOneCalls).toBe(0);
  });

  it('document 路由(合同扫描件) -> 回落 MinerU OCR 全文管线, 不调提取', async () => {
    seedMineruFixture(twoPagePdf);
    const { docId } = await createDocumentStub(ctx, { sourceUri: twoPagePdf, filename: 'contract.pdf' });
    const vlm = fakeVlm({
      classifyResult: { formType: '合同扫描件', confidence: 0.97 },
      extractOne: async () => ({ fields: {} }),
    });
    const res = await processDocument(ctx, docId, { vlm });
    expect(res.parseStatus).toBe('parsed');
    expect(vlm.classifyCalls).toBe(1);
    expect(vlm.extractOneCalls).toBe(0);
    expect(res.blockCount).toBeGreaterThan(0);
    expect(countExtractions(docId)).toBe(0); // OCR 路径不写凭证 extraction
  });

  it('低置信度 -> 回落 OCR', async () => {
    seedMineruFixture(twoPagePdf);
    const { docId } = await createDocumentStub(ctx, { sourceUri: twoPagePdf, filename: 'low.pdf' });
    const vlm = fakeVlm({
      classifyResult: { formType: '汽车过磅单票据', confidence: 0.3 },
      extractOne: async () => ({ fields: {} }),
    });
    const res = await processDocument(ctx, docId, { vlm });
    expect(res.parseStatus).toBe('parsed');
    expect(vlm.extractOneCalls).toBe(0);
  });

  it('分类抛错 -> 回落 OCR(永不劣于现状)', async () => {
    seedMineruFixture(twoPagePdf);
    const { docId } = await createDocumentStub(ctx, { sourceUri: twoPagePdf, filename: 'err.pdf' });
    const vlm = fakeVlm({ classifyError: 'VLM 超时', extractOne: async () => ({ fields: {} }) });
    const res = await processDocument(ctx, docId, { vlm });
    expect(res.parseStatus).toBe('parsed');
    expect(vlm.extractOneCalls).toBe(0);
  });

  it('分类抛错(内容安全拦截体) -> 分类告警含拦截标签后仍回落 OCR(行为不变)', async () => {
    seedMineruFixture(twoPagePdf);
    const { docId } = await createDocumentStub(ctx, { sourceUri: twoPagePdf, filename: 'blocked.pdf' });
    // 模拟 vlmCall 的真实抛错形态: 百炼 DataInspectionFailed(绿网拦截)。
    const blockedErr = Object.assign(new Error('VLM /chat/completions 失败 (400 Bad Request)'), {
      statusCode: 400,
      responseBody: JSON.stringify({
        error: { code: 'DataInspectionFailed', message: 'Output data contains inappropriate content' },
      }),
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const vlm = fakeVlm({ classifyErrorObj: blockedErr, extractOne: async () => ({ fields: {} }) });
      const res = await processDocument(ctx, docId, { vlm });
      // 回落行为不变: OCR 路径 parsed, 不进凭证提取。
      expect(res.parseStatus).toBe('parsed');
      expect(vlm.extractOneCalls).toBe(0);
      // 新增: 分类告警行含短标签与回落去向。
      const line = warnSpy.mock.calls.map((c) => c.map(String).join(' ')).find((l) => l.includes('[perf-route]'));
      expect(line).toContain('内容安全拦截');
      expect(line).toContain('回落 OCR');
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('凭证提取全页失败 -> 回落 OCR(route correction)', async () => {
    seedMineruFixture(twoPagePdf);
    const { docId } = await createDocumentStub(ctx, { sourceUri: twoPagePdf, filename: 'allfail.pdf' });
    const vlm = fakeVlm({
      classifyResult: { formType: '汽车过磅单票据', confidence: 0.95 },
      extractOne: async () => { throw new Error('VLM 提取失败'); },
    });
    const res = await processDocument(ctx, docId, { vlm });
    expect(res.parseStatus).toBe('parsed');
    expect(vlm.extractOneCalls).toBeGreaterThanOrEqual(2);
    expect(res.classifiedDocType).not.toBe('汽运磅单');
  });

  it('VLM 未配置 -> 不渲染不分类, 直接 OCR(现状零回归)', async () => {
    env.VLM_BASE_URL = undefined;
    env.VLM_API_KEY = undefined;
    seedMineruFixture(twoPagePdf);
    const { docId } = await createDocumentStub(ctx, { sourceUri: twoPagePdf, filename: 'novlm.pdf' });
    const vlm = fakeVlm({
      classifyResult: { formType: '汽车过磅单票据', confidence: 0.95 },
      extractOne: async () => ({ fields: {} }),
    });
    const res = await processDocument(ctx, docId, { vlm });
    expect(res.parseStatus).toBe('parsed');
    expect(vlm.classifyCalls).toBe(0);
    expect(vlm.extractOneCalls).toBe(0);
  });
});

function countExtractions(docId: string): number {
  return (ctx.sqlite.prepare('SELECT COUNT(*) AS n FROM extractions WHERE document_id = ?').get(docId) as { n: number }).n;
}
