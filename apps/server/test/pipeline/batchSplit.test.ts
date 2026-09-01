// 批量拆分器检测层单元测试(spec 2026-09-01 §3): 固定页图 + fake VLM。
// 覆盖: PNG 空白预判解码、prompt 形态、逐页清点归一化、跨页续表合并、
// 全局排序、bbox padding、超页数上限。
import { describe, it, expect } from 'vitest';
import {
  pngNonWhiteRatio,
  buildUnitDetectPrompt,
  detectDocumentUnits,
  BLANK_NON_WHITE_RATIO,
  BBOX_PADDING,
  type DetectUnitsDeps,
} from '../../src/pipeline/batchSplit.js';
import type { RenderedPage } from '../../src/pipeline/pdfRender.js';
import { buildPng } from './fixtures/png.js';

const WHITE: [number, number, number, number] = [255, 255, 255, 255];
const BLACK: [number, number, number, number] = [0, 0, 0, 255];

/** 整白页(供空白预判跳过 VLM 的用例)。 */
function blankPage(page: number): RenderedPage {
  return { page, mime: 'image/png' as const, buffer: buildPng(32, 32, () => WHITE) };
}

/** 上半黑下半白的非空白页。 */
function contentPage(page: number): RenderedPage {
  return {
    page,
    mime: 'image/png' as const,
    buffer: buildPng(32, 32, (_x, y) => (y < 16 ? BLACK : WHITE)),
  };
}

/** VLM 区域输出 fragment。 */
function regionJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    unitIndex: 1,
    formType: '质检报告',
    confidence: 0.95,
    bbox: { x: 0.01, y: 0.02, w: 0.48, h: 0.9 },
    rotationDeg: 0,
    evidence: '检测报告 HX-001',
    identifierOrNull: 'HX-001',
    ...overrides,
  });
}

function pageJson(regions: string[]): string {
  return JSON.stringify({ units: regions.map((r) => JSON.parse(r)) });
}

describe('pngNonWhiteRatio (空白页像素预判)', () => {
  it('全白 RGBA 页返回 ~0', () => {
    const png = buildPng(16, 16, () => WHITE);
    expect(pngNonWhiteRatio(png)).toBeCloseTo(0, 5);
  });

  it('半黑页返回 ~0.5', () => {
    const png = buildPng(16, 16, (_x, y) => (y < 8 ? BLACK : WHITE));
    expect(pngNonWhiteRatio(png)).toBeCloseTo(0.5, 5);
  });

  it('RGB / 灰度 / 灰度+alpha 颜色类型均可解码', () => {
    const rgb = buildPng(8, 8, () => BLACK, { colorType: 2 });
    const gray = buildPng(8, 8, () => [128, 0, 0, 0], { colorType: 0 });
    const grayA = buildPng(8, 8, () => [128, 0, 0, 255], { colorType: 4 });
    expect(pngNonWhiteRatio(rgb)).toBeCloseTo(1, 5);
    expect(pngNonWhiteRatio(gray)).toBeCloseTo(1, 5);
    expect(pngNonWhiteRatio(grayA)).toBeCloseTo(1, 5);
  });

  it('全 filter 类型(None/Sub/Up/Avg/Paeth)解出一致结果', () => {
    for (const filter of [0, 1, 2, 3, 4]) {
      const png = buildPng(12, 12, (x, y) => (x < 6 && y < 6 ? BLACK : WHITE), { filter });
      // 左上 1/4 为黑。
      expect(pngNonWhiteRatio(png)).toBeCloseTo(0.25, 5);
    }
  });

  it('透明像素(alpha=0)按白处理', () => {
    const png = buildPng(8, 8, () => [0, 0, 0, 0]);
    expect(pngNonWhiteRatio(png)).toBeCloseTo(0, 5);
  });

  it('无法解码的输入返回 null(按非空白交给 VLM, 绝不漏检)', () => {
    expect(pngNonWhiteRatio(Buffer.from('not a png'))).toBeNull();
    expect(pngNonWhiteRatio(Buffer.alloc(0))).toBeNull();
  });
});

describe('buildUnitDetectPrompt', () => {
  it('包含受控 formType 词表与 strict JSON 输出契约', () => {
    const prompt = buildUnitDetectPrompt();
    for (const t of ['汽运磅单', '质检报告', '微信聊天记录', '空白页']) {
      expect(prompt).toContain(t);
    }
    expect(prompt).toContain('rotationDeg');
    expect(prompt).toContain('identifierOrNull');
    expect(prompt).toContain('严格以 JSON 输出');
    // 关键业务语义: 一表多样品不拆分。
    expect(prompt).toContain('1 个单据');
  });
});

describe('detectDocumentUnits', () => {
  it('一页并排 2 份报告拆成 2 个 unit, 排序+padding 正确', async () => {
    const pages = [contentPage(1)];
    const deps: DetectUnitsDeps = {
      renderPages: async () => pages,
      call: async () =>
        pageJson([
          // 故意乱序: 右侧在前, 验证按 y/x 阅读顺序重排。
          regionJson({ unitIndex: 1, bbox: { x: 0.51, y: 0.05, w: 0.47, h: 0.9 }, identifierOrNull: 'HX-B' }),
          regionJson({ unitIndex: 2, bbox: { x: 0.01, y: 0.05, w: 0.47, h: 0.9 }, identifierOrNull: 'HX-A' }),
        ]),
    };
    const res = await detectDocumentUnits({ sourcePath: 'x.pdf' }, deps);
    expect(res.units).toHaveLength(2);
    expect(res.units[0]!.identifier).toBe('HX-A');
    expect(res.units[1]!.identifier).toBe('HX-B');
    expect(res.units.map((u) => u.unitIndex)).toEqual([1, 2]);
    // padding: x=0.01-0.025 -> 0(截断), w=0.47+0.05=0.52。
    expect(res.units[0]!.bbox).toMatchObject({ x: 0, y: 0.025, w: 0.52 });
    expect(res.units[0]!.bbox!.h).toBeCloseTo(0.95, 8);
    expect(res.pages).toEqual([{ page: 1, nonWhiteRatio: 0.5, blank: false, unitCount: 2 }]);
  });

  it('空白页像素预判命中时跳过 VLM 调用', async () => {
    const pages = [blankPage(1), contentPage(2)];
    const deps: DetectUnitsDeps = {
      renderPages: async () => pages,
      call: async (_prompt, page) => {
        if (page.page === 1) throw new Error('空白页不应调用 VLM');
        return pageJson([regionJson()]);
      },
    };
    const res = await detectDocumentUnits({ sourcePath: 'x.pdf' }, deps);
    expect(res.pages[0]).toMatchObject({ page: 1, blank: true, unitCount: 0 });
    expect(res.pages[0]!.nonWhiteRatio!).toBeLessThan(BLANK_NON_WHITE_RATIO);
    expect(res.units).toHaveLength(1);
    expect(res.units[0]!.pageStart).toBe(2);
  });

  it('跨页续表(相邻页+同 formType+同单号)合并为 1 个 unit', async () => {
    const pages = [contentPage(1), contentPage(2)];
    const deps: DetectUnitsDeps = {
      renderPages: async () => pages,
      call: async (_prompt, page) => pageJson([regionJson({ identifierOrNull: 'BD-10384417' })]),
    };
    const res = await detectDocumentUnits({ sourcePath: 'x.pdf' }, deps);
    expect(res.units).toHaveLength(1);
    const u = res.units[0]!;
    expect(u.pageStart).toBe(1);
    expect(u.pageEnd).toBe(2);
    expect(u.bbox).toBeNull(); // 多页合并 unit 无单一 bbox
    expect(u.regions).toHaveLength(2);
    expect(u.regions.map((r) => r.page)).toEqual([1, 2]);
  });

  it('单号为 null 的相邻同型页不合并(防两份匿名单据错并)', async () => {
    const pages = [contentPage(1), contentPage(2)];
    const deps: DetectUnitsDeps = {
      renderPages: async () => pages,
      call: async () => pageJson([regionJson({ identifierOrNull: null })]),
    };
    const res = await detectDocumentUnits({ sourcePath: 'x.pdf' }, deps);
    expect(res.units).toHaveLength(2);
  });

  it('坏区域被丢弃、非法旋转归零、"空白页" formType 忽略', async () => {
    const pages = [contentPage(1)];
    const deps: DetectUnitsDeps = {
      renderPages: async () => pages,
      call: async () =>
        pageJson([
          regionJson({ bbox: { x: 0.5, y: 0.5, w: 0.001, h: 0.001 } }), // 印章级小区域
          regionJson({ rotationDeg: 45, formType: '空白页', identifierOrNull: null }),
          regionJson({ rotationDeg: 90, identifierOrNull: 'HX-R90' }),
          regionJson({ confidence: 1.5, identifierOrNull: 'HX-CAP' }),
        ]),
    };
    const res = await detectDocumentUnits({ sourcePath: 'x.pdf' }, deps);
    expect(res.units).toHaveLength(2);
    expect(res.units.find((u) => u.identifier === 'HX-R90')!.rotationDeg).toBe(90);
    expect(res.units.find((u) => u.identifier === 'HX-CAP')!.confidence).toBe(1);
  });

  it('首次输出坏 JSON 时回灌重试一次', async () => {
    const pages = [contentPage(1)];
    let calls = 0;
    const deps: DetectUnitsDeps = {
      renderPages: async () => pages,
      call: async () => {
        calls += 1;
        return calls === 1 ? 'not json' : pageJson([regionJson()]);
      },
    };
    const res = await detectDocumentUnits({ sourcePath: 'x.pdf' }, deps);
    expect(calls).toBe(2);
    expect(res.units).toHaveLength(1);
  });

  it('页数超过上限直接抛错(由灰度入口回落旧路径)', async () => {
    const pages = [contentPage(1), contentPage(2)];
    const deps: DetectUnitsDeps = { renderPages: async () => pages, call: async () => pageJson([]) };
    await expect(detectDocumentUnits({ sourcePath: 'x.pdf', maxPages: 1 }, deps)).rejects.toThrow(/上限/);
  });

  it('padding 不越界: 边缘 bbox 截断在 [0,1]', async () => {
    const pages = [contentPage(1)];
    const deps: DetectUnitsDeps = {
      renderPages: async () => pages,
      call: async () => pageJson([regionJson({ bbox: { x: 0.95, y: 0.95, w: 0.05, h: 0.05 } })]),
    };
    const res = await detectDocumentUnits({ sourcePath: 'x.pdf' }, deps);
    const b = res.units[0]!.bbox!;
    expect(b.x).toBeGreaterThanOrEqual(0);
    expect(b.y).toBeGreaterThanOrEqual(0);
    expect(b.x + b.w).toBeLessThanOrEqual(1 + 1e-9);
    expect(b.y + b.h).toBeLessThanOrEqual(1 + 1e-9);
    expect(b.w).toBeGreaterThanOrEqual(2 * BBOX_PADDING - 0.001);
  });
});
