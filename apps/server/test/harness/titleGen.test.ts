import { describe, it, expect } from 'vitest';
import { generateSessionTitle, fallbackTitle } from '../../src/harness/titleGen.js';

describe('generateSessionTitle', () => {
  it('fallbackTitle truncates long first-user text and drops whitespace', () => {
    expect(fallbackTitle('')).toBe('新会话');
    expect(fallbackTitle('   ')).toBe('新会话');
    const long = '一二三四五六七八九十十一十二十三十四';
    expect(fallbackTitle(long).length).toBeLessThanOrEqual(20);
  });

  it('generateSessionTitle uses model output when non-empty, else fallback', async () => {
    const stubModel = {
      specificationVersion: 'v2' as const,
      provider: 'fake',
      modelId: 'fake-model',
      supportedUrls: {} as Record<string, RegExp[]>,
      async doGenerate() {
        return {
          content: [{ type: 'text' as const, text: '合同审核摘要' }],
          finishReason: 'stop' as const,
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          warnings: undefined,
        };
      },
      async doStream() {
        throw new Error('doStream not used by generateSessionTitle');
      },
    } as any;
    const out = await generateSessionTitle(stubModel, '帮我看下这份合同', '好的，这是要点…');
    expect(out).toBe('合同审核摘要');

    const emptyModel = {
      specificationVersion: 'v2' as const,
      provider: 'fake',
      modelId: 'fake-model',
      supportedUrls: {} as Record<string, RegExp[]>,
      async doGenerate() {
        return {
          content: [{ type: 'text' as const, text: '   ' }],
          finishReason: 'stop' as const,
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          warnings: undefined,
        };
      },
      async doStream() {
        throw new Error('doStream not used');
      },
    } as any;
    const out2 = await generateSessionTitle(emptyModel, '短问题', '回复');
    expect(out2).toBe('短问题'); // fallback to truncated first user msg
  });
});
