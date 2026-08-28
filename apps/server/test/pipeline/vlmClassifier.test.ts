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
