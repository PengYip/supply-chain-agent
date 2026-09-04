import { describe, it, expect, vi } from 'vitest';
import { classifyForm } from '../../src/pipeline/vlmClassifier.js';

const page = { mime: 'image/png', buffer: Buffer.from('fake') };

describe('classifyForm', () => {
  it('parses a well-formed VLM answer', async () => {
    const call = vi.fn().mockResolvedValue('{"formType":"汽车过磅单票据","confidence":0.92}');
    const r = await classifyForm({ page, formTypes: ['汽车过磅单票据', '合同扫描件'] }, { call });
    expect(r).toEqual({ formType: '汽车过磅单票据', confidence: 0.92 });
    // prompt 必须携带候选清单与 JSON 输出契约
    const prompt = call.mock.calls[0]![0] as string;
    expect(prompt).toContain('汽车过磅单票据');
    expect(prompt).toContain('JSON');
    // 判别特征: 化验报告=检验机构单批次报告; 质检汇总表=每行一个批次+合计行;
    // 汽运磅单=汽车衡/车牌号单车结构(照片也算), 严禁标轨道衡。
    expect(prompt).toContain('检验机构出具的单批次检验结果');
    expect(prompt).toContain('收货方编制的二次汇总');
    expect(prompt).toContain('每一行是一个批次(或一车)的指标');
    expect(prompt).toContain('汽车衡/地磅/车牌号');
    expect(prompt).toContain('严禁标轨道衡称重记录');
    // 标题陷阱: 标题含"化验"但版面为多行批次+合计行 -> 收货质检汇总表。
    expect(prompt).toContain('严禁仅凭标题"化验"二字判成化验报告');
    expect(prompt).toContain('CMA 标志');
    // 磅单标题变体: 计量单/过磅单/汽车衡计量单 + 省份汉字车牌最强判据。
    expect(prompt).toContain('计量单/过磅单/汽车衡计量单');
    expect(prompt).toContain('冀EB6666');
  });

  it('retries once with the error appended, then succeeds', async () => {
    const call = vi.fn()
      .mockRejectedValueOnce(new Error('JSON 解析失败'))
      .mockResolvedValueOnce('{"formType":"合同扫描件","confidence":0.8}');
    const r = await classifyForm({ page, formTypes: ['合同扫描件'] }, { call });
    expect(r.formType).toBe('合同扫描件');
    expect(call).toHaveBeenCalledTimes(2);
    expect(call.mock.calls[1]![0] as string).toContain('上次输出无法使用');
  });

  it('throws after two failures', async () => {
    const call = vi.fn().mockRejectedValue(new Error('boom'));
    await expect(classifyForm({ page, formTypes: ['x'] }, { call })).rejects.toThrow('boom');
    expect(call).toHaveBeenCalledTimes(2);
  });

  it('defaults missing confidence to 0', async () => {
    const call = vi.fn().mockResolvedValue('{"formType":"水尺计重单"}');
    const r = await classifyForm({ page, formTypes: ['水尺计重单'] }, { call });
    expect(r.confidence).toBe(0);
  });
});
