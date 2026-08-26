import { describe, it, expect, beforeEach } from 'vitest';
import { createDb, migrate } from '../../src/pipeline/db/client.js';
import { ensureTemplateSeed } from '../../src/pipeline/templateSeed.js';
import { listTemplateTypes } from '../../src/pipeline/db/repositories.js';
import { buildClassifierVocab, classifyDocument } from '../../src/pipeline/classifier.js';
import type { Block } from '../../src/pipeline/types.js';

// stubModel 序列版(§18 模式扩展): 每次 doGenerate 依次返回 returnObjects 中的对象;
// 元素为 Error 时该次调用抛出(模拟细类/粗类失败)。
function stubModelSequence(returnObjects: Array<unknown | Error>) {
  let i = 0;
  return {
    specificationVersion: 'v2' as const,
    provider: 'fake', modelId: 'fake-model', supportedUrls: {} as Record<string, RegExp[]>,
    async doGenerate() {
      const obj = returnObjects[Math.min(i, returnObjects.length - 1)];
      i++;
      if (obj instanceof Error) throw obj;
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(obj) }],
        finishReason: 'stop' as const,
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        warnings: [] as unknown[],
      };
    },
    async doStream() { throw new Error('doStream not used by classifyDocument'); },
  } as any;
}

const blocks = (text: string): Block[] => [
  { id: 'b0', type: 'text', text, page: 1, bbox: null, ocrConfidence: 1 },
];

const ctx = createDb();
beforeEach(async () => { migrate(ctx.sqlite); await ensureTemplateSeed(ctx); });

describe('buildClassifierVocab', () => {
  it('粗类=顶层四类, 细类=履约凭证全部后代', async () => {
    const types = await listTemplateTypes(ctx);
    const vocab = buildClassifierVocab(types);
    expect(vocab.coarse).toEqual(expect.arrayContaining(['合同', '立项书', '履约凭证', '其他']));
    expect(vocab.fineByCoarse['履约凭证']).toContain('收货单');
    expect(vocab.fineByCoarse['履约凭证']).toContain('发票');
    expect(vocab.fineByCoarse['合同']).toContain('补充合同');
  });
});

describe('classifyDocument 两阶段', () => {
  // 两阶段用例需显式传 vocab(brief 原文未传, 缺省 fineByCoarse 为空导致细类阶段
  // 不执行——已补 vocab 使细类路径可测)。
  const vocab = { coarse: ['合同', '立项书', '履约凭证', '其他'], fineByCoarse: { '履约凭证': ['收货单', '发货单'] } };
  it('粗类命中后细类精化', async () => {
    const model = stubModelSequence([{ docType: '履约凭证', confidence: 0.9 }, { docType: '收货单', confidence: 0.85 }]);
    const res = await classifyDocument({ model }, { blocks: blocks('收货单...'), hint: '其他', vocab });
    expect(res.docType).toBe('收货单');
    expect(res.source).toBe('classified');
  });
  it('细类失败回退粗类', async () => {
    const model = stubModelSequence([{ docType: '履约凭证', confidence: 0.9 }, new Error('boom')]);
    const res = await classifyDocument({ model }, { blocks: blocks('...'), hint: '其他', vocab });
    expect(res.docType).toBe('履约凭证');
    expect(res.source).toBe('classified');
  });
  it('粗类失败回退 hint', async () => {
    const model = stubModelSequence([new Error('boom')]);
    const res = await classifyDocument({ model }, { blocks: blocks('...'), hint: '发票' });
    expect(res.docType).toBe('发票');
    expect(res.source).toBe('fallback');
  });
});