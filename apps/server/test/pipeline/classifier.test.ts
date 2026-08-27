import { describe, it, expect } from 'vitest';
import type { Block, DocType } from '../../src/pipeline/types.js';
import { classifyDocument, buildCoarsePrompt } from '../../src/pipeline/classifier.js';

// Reuse the stub-model seam from documentEntry.test.ts. Its doGenerate returns
// JSON that generateObject parses against the classifier zod schema.
function stubModel(returnObject: unknown) {
  return {
    specificationVersion: 'v2' as const,
    provider: 'fake',
    modelId: 'fake-model',
    supportedUrls: {} as Record<string, RegExp[]>,
    async doGenerate() {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(returnObject) }],
        finishReason: 'stop' as const,
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        warnings: [] as unknown[],
      };
    },
    async doStream() {
      throw new Error('doStream not used by classifyDocument');
    },
  } as any;
}

const blocks = (text: string): Block[] => [
  { id: 'b0', type: 'text', text, page: 1, bbox: null, ocrConfidence: 1 },
];

describe('classifyDocument', () => {
  it('returns the LLM-classified docType + confidence (两阶段: 粗类->细类)', async () => {
    // 两阶段: 粗类(履约凭证) -> 细类(发票)。发票非粗类, 需经细类阶段产出。
    const model = stubModel({ docType: '履约凭证', confidence: 0.93 });
    const res = await classifyDocument(
      { model },
      {
        blocks: blocks('这是发票号码 INV-001 的文档'), hint: '其他',
        vocab: { coarse: ['合同', '立项书', '履约凭证', '其他'], fineByCoarse: { '履约凭证': ['发票', '收货单'] } },
      },
    );
    expect(res.docType).toBe('履约凭证');
    expect(res.confidence).toBeCloseTo(0.93, 5);
    expect(res.source).toBe('classified');
  });

  it('rejects out-of-range confidence via the zod schema and falls back', async () => {
    // confidence 1.4 violates the schema's .max(1); generateObject throws on
    // zod parse failure and classifyDocument catches it -> fallback result.
    const model = stubModel({ docType: '合同', confidence: 1.4 });
    const res = await classifyDocument({ model }, { blocks: blocks('x'), hint: '其他' });
    expect(res.docType).toBe('其他');
    expect(res.confidence).toBe(0);
    expect(res.source).toBe('fallback');
  });

  it('falls back to the hint docType when the LLM output is unparseable', async () => {
    const model = stubModel({ notTheShape: true }); // fails zod parse
    const res = await classifyDocument(
      { model },
      { blocks: blocks('文本'), hint: '合同' as DocType },
    );
    expect(res.docType).toBe('合同');
    expect(res.source).toBe('fallback');
    expect(res.confidence).toBe(0);
  });

  it('returns hint docType with source "hint" when the model is absent', async () => {
    // No ClassifierDeps passed in — simulate the offline-degrade path used by
    // ingestFile when no classifier model is wired.
    // classifyDocumentWithoutModel is the degrade helper exported alongside.
    const { classifyDocumentWithoutModel } = await import('../../src/pipeline/classifier.js');
    const res = classifyDocumentWithoutModel({ blocks: blocks('x'), hint: '提单' });
    expect(res.docType).toBe('提单');
    expect(res.source).toBe('hint');
    expect(res.confidence).toBe(0);
  });
});

// Bug A(用户验收): 8 份合同全被粗类判成「补充合同」。根因: 粗类四选一
// (合同/立项书/履约凭证/其他), 但 prompt 未说明 补充合同 是合同的子类, 模型见
// 标题含"补充协议"就输出子类名或保守拐走。本组断言粗类 prompt 必须携带判别说明
// (纯字符串断言, 无需真实 LLM)。
describe('buildCoarsePrompt 粗类判别说明(Bug A)', () => {
  const prompt = buildCoarsePrompt(['合同', '立项书', '履约凭证', '其他']);

  it('声明粗类只允许输出给定取值之一', () => {
    expect(prompt).toContain('只允许输出');
    expect(prompt).toContain('合同 / 立项书 / 履约凭证 / 其他');
  });

  it('说明文件名/标题含补充协议或补充合同的仍属合同粗类', () => {
    expect(prompt).toContain('补充协议');
    expect(prompt).toContain('补充合同');
    expect(prompt).toContain('合同的子类');
  });

  it('说明出库单/收货单/结算凭证等履约类归履约凭证粗类', () => {
    expect(prompt).toContain('出库单');
    expect(prompt).toContain('收货单');
    expect(prompt).toContain('结算凭证');
    expect(prompt).toContain('履约凭证');
  });
});
