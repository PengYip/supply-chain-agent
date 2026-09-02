// vlmTelemetry 单元测试(2026-09-02): 纯函数 vlmSpanAttributes 的属性映射断言。
// span 发射(emitVlmUsageSpan)在单测环境无 exporter, tracer 为 no-op, 仅验证
// 不抛错(遥测 fire-and-forget 契约)。

import { describe, it, expect } from 'vitest';
import { vlmSpanAttributes, emitVlmUsageSpan } from '../../src/pipeline/vlmTelemetry.js';

describe('vlmSpanAttributes', () => {
  it('kinds 映射到 operation.name = vlm.<kind>, 固定 GenAI 语义属性', () => {
    for (const kind of ['vlm_extract', 'vlm_classify', 'vlm_batch_split'] as const) {
      const attrs = vlmSpanAttributes(kind, 'qwen3.8-max', undefined, 'prompt');
      expect(attrs['operation.name']).toBe(`vlm.${kind}`);
      expect(attrs['gen_ai.operation.name']).toBe('generate');
      expect(attrs['gen_ai.system']).toBe('bailian');
      expect(attrs['gen_ai.request.model']).toBe('qwen3.8-max');
    }
  });

  it('usage 映射: prompt_tokens -> input, completion_tokens -> output, total_tokens -> total', () => {
    const attrs = vlmSpanAttributes('vlm_extract', 'm', {
      prompt_tokens: 120,
      completion_tokens: 40,
      total_tokens: 160,
    }, 'p');
    expect(attrs['gen_ai.usage.input_tokens']).toBe(120);
    expect(attrs['gen_ai.usage.output_tokens']).toBe(40);
    expect(attrs['gen_ai.usage.total_tokens']).toBe(160);
  });

  it('usage 缺字段时不写对应属性', () => {
    const attrs = vlmSpanAttributes('vlm_classify', 'm', { prompt_tokens: 5 }, 'p');
    expect(attrs['gen_ai.usage.input_tokens']).toBe(5);
    expect(attrs['gen_ai.usage.output_tokens']).toBeUndefined();
    expect(attrs['gen_ai.usage.total_tokens']).toBeUndefined();
  });

  it('prompt 仅文本: 含 base64 的载荷字符串绝不进入属性', () => {
    const attrs = vlmSpanAttributes('vlm_extract', 'm', undefined, '你是供应链业务凭证识别模型');
    expect(attrs['gen_ai.prompt']).toBe('你是供应链业务凭证识别模型');
    expect(JSON.stringify(attrs)).not.toContain('base64');
  });

  it('成功路径带 gen_ai.completion; 错误路径(不传 content)不带', () => {
    const ok = vlmSpanAttributes('vlm_extract', 'm', undefined, 'p', '{"voucherType":"付款凭证"}');
    expect(ok['gen_ai.completion']).toBe('{"voucherType":"付款凭证"}');
    const err = vlmSpanAttributes('vlm_extract', 'm', undefined, 'p');
    expect(err['gen_ai.completion']).toBeUndefined();
  });
});

describe('emitVlmUsageSpan', () => {
  it('成功/错误路径均不抛错(no-op tracer 惰性)', () => {
    expect(() =>
      emitVlmUsageSpan({ kind: 'vlm_extract', usage: { prompt_tokens: 1 }, prompt: 'p', content: 'c' }),
    ).not.toThrow();
    expect(() =>
      emitVlmUsageSpan({ kind: 'vlm_classify', prompt: 'p', err: new Error('boom') }),
    ).not.toThrow();
    expect(() =>
      emitVlmUsageSpan({ kind: 'vlm_batch_split', prompt: 'p', err: 'string error' }),
    ).not.toThrow();
  });
});