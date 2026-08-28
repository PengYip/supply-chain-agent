import { describe, it, expect, vi } from 'vitest';
import { extractWeightDoc, mapLimit } from '../../src/pipeline/pageRecords.js';
import type { RenderedPage } from '../../src/pipeline/pdfRender.js';

function page(n: number): RenderedPage {
  return { page: n, mime: 'image/png', buffer: Buffer.alloc(32, n) };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('mapLimit', () => {
  it('保序且有界并发', async () => {
    let active = 0;
    let peak = 0;
    const r = await mapLimit([1, 2, 3, 4, 5, 6], 2, async (n) => {
      active += 1;
      peak = Math.max(peak, active);
      await sleep(5);
      active -= 1;
      return n * 10;
    });
    expect(r).toEqual([10, 20, 30, 40, 50, 60]);
    expect(peak).toBeLessThanOrEqual(2);
  });
});

describe('extractWeightDoc: 汽运磅单(一页一车)', () => {
  it('逐页提取, 失败页不扩散, 总净重服务端求和', async () => {
    const extractOne = vi.fn(async (_img, docType: string) => {
      expect(docType).toBe('汽运磅单');
      return {};
    });
    // 按页注入: 1/3 页成功, 第 2 页两次都失败
    const rows: Record<string, unknown>[] = [
      { 编号: 'ERP1', 车号: '渝DD5739', 毛重_吨: 48.82, 皮重_吨: 16.18, 净重_吨: 32.64 },
      { 编号: 'ERP3', 车号: '贵F31172', 毛重_吨: 48.5, 皮重_吨: 16.02, 净重_吨: 32.48 },
    ];
    let callIdx = 0;
    extractOne.mockImplementation(async (img: { buffer: Buffer }) => {
      callIdx += 1;
      const n = img.buffer[0]!;
      if (n === 2) throw new Error('页 2 解析失败');
      return { fields: rows[n === 1 ? 0 : 1]! };
    });
    const r = await extractWeightDoc([page(1), page(2), page(3)], '汽运磅单', { extractOne, concurrency: 2 });
    expect(r.failedPages).toEqual([2]);
    expect(r.okPages).toEqual([1, 3]);
    expect(r.fields['明细行']).toEqual([
      { ...rows[0], 页码: 1 },
      { ...rows[1], 页码: 3 },
    ]);
    expect(r.fields['总净重_吨']).toBe(65.12);
    expect(r.fields['页数']).toBe(3);
    expect(r.fields['失败页']).toEqual([2]);
    expect(r.warnings.some((w) => w.includes('页 2'))).toBe(true);
    // 失败页重试过一次(extractOne 被调 2 次)
    expect(callIdx).toBe(4);
  });

  it('缺毛重/皮重/净重的行 -> 页失败(不静默丢字段)', async () => {
    const extractOne = vi.fn(async (img: { buffer: Buffer }) => {
      const n = img.buffer[0]!;
      if (n === 1) return { fields: { 编号: 'ERP1', 车号: 'x', 毛重_吨: 48.8 } };
      return { fields: { 编号: 'ERP2', 毛重_吨: 48.5, 皮重_吨: 16.0, 净重_吨: 32.5 } };
    });
    const r = await extractWeightDoc([page(1), page(2)], '汽运磅单', { extractOne });
    expect(r.failedPages).toEqual([1]);
    expect(r.okPages).toEqual([2]);
    expect(r.fields['明细行']).toEqual([
      { 编号: 'ERP2', 毛重_吨: 48.5, 皮重_吨: 16.0, 净重_吨: 32.5, 页码: 2 },
    ]);
    expect(r.fields['总净重_吨']).toBe(32.5);
  });

  it('全部页失败 -> 抛错', async () => {
    const extractOne = vi.fn().mockRejectedValue(new Error('VLM down'));
    await expect(extractWeightDoc([page(1), page(2)], '汽运磅单', { extractOne })).rejects.toThrow('全部页面提取失败');
  });
});

describe('extractWeightDoc: 轨道衡(逐车厢行跨页)', () => {
  it('跨页 rows 拼接, 表头取首个非空页, 总净重求和', async () => {
    const extractOne = vi.fn(async (img: { buffer: Buffer }) => {
      const n = img.buffer[0]!;
      if (n === 1) {
        return {
          fields: {
            编号: '2494', 称量日期: '2024-08-27',
            rows: [
              { 车型: 'C70', 车号: '1616368', 毛重_吨: 85.2, 皮重_吨: 22.4, 净重_吨: 62.8, 票重_吨: 70, 盈亏_吨: -7.2 },
            ],
          },
        };
      }
      return {
        fields: {
          rows: [
            { 车型: 'C64K', 车号: '4895414', 毛重_吨: 80.1, 皮重_吨: 20.2, 净重_吨: 59.9 },
          ],
        },
      };
    });
    const r = await extractWeightDoc([page(1), page(2)], '轨道衡称重单', { extractOne });
    expect(r.fields['编号']).toBe('2494');
    expect(r.fields['称量日期']).toBe('2024-08-27');
    expect(r.fields['明细行']).toHaveLength(2);
    expect(r.fields['明细行'][0]).toMatchObject({ 车号: '1616368', 页码: 1 });
    expect(r.fields['明细行'][1]).toMatchObject({ 车号: '4895414', 页码: 2 });
    expect(r.fields['总净重_吨']).toBe(122.7);
    expect(r.warnings).toEqual([]);
  });

  it('rows 中混入非法行 -> 整页失败(部分页可成功)', async () => {
    const extractOne = vi.fn(async (img: { buffer: Buffer }) => {
      const n = img.buffer[0]!;
      if (n === 1) return { fields: { rows: [{ 车号: 'x', 毛重_吨: '八十' }] } };
      return { fields: { rows: [{ 车型: 'C70', 车号: '1616368', 毛重_吨: 85.2, 皮重_吨: 22.4, 净重_吨: 62.8 }] } };
    });
    const r = await extractWeightDoc([page(1), page(2)], '轨道衡称重单', { extractOne });
    expect(r.failedPages).toEqual([1]);
    expect(r.okPages).toEqual([2]);
    expect(r.fields['明细行']).toHaveLength(1);
  });
});

describe('extractWeightDoc: 水尺(单页表单)', () => {
  it('取首个成功页整体字段(附页数/失败页元数据)', async () => {
    const fields = { 船名: '硕隆817', 卸货量_吨: 72079 };
    const extractOne = vi.fn().mockResolvedValue({ fields });
    const r = await extractWeightDoc([page(1)], '水尺计重单', { extractOne });
    expect(r.fields).toMatchObject(fields);
    expect(r.fields['页数']).toBe(1);
    expect(r.fields['失败页']).toEqual([]);
    expect(r.okPages).toEqual([1]);
  });

  it('第 1 页失败第 2 页成功 -> 取第 2 页并告警', async () => {
    const extractOne = vi.fn()
      .mockRejectedValueOnce(new Error('blur'))
      .mockResolvedValueOnce({ fields: { 船名: 'x', 卸货量_吨: 1 } });
    const r = await extractWeightDoc([page(1), page(2)], '水尺计重单', { extractOne });
    expect(r.fields['船名']).toBe('x');
    expect(r.failedPages).toEqual([1]);
    expect(r.warnings.length).toBeGreaterThan(0);
  });
});
