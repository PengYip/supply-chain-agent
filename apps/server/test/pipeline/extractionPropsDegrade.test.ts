import { describe, it, expect, vi } from 'vitest';
import type { BlockModel } from '../../src/pipeline/types.js';

// 降级路径测试: listTemplateTypes 抛错时抽取仍正常返回(不阻塞主流程)。
// 单独文件避免 mock repositories.js 影响 extractionProps.test.ts 的种子断言。
vi.mock('../../src/pipeline/db/repositories.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../src/pipeline/db/repositories.js')>();
  return {
    ...mod,
    listTemplateTypes: async () => { throw new Error('template table unavailable'); },
  };
});
const { buildAutoExtractionDeps } = await import('../../src/pipeline/autoExtraction.js');

function stubModel(returnObject: unknown) {
  return {
    specificationVersion: 'v2' as const,
    provider: 'fake', modelId: 'fake-model', supportedUrls: {} as Record<string, RegExp[]>,
    async doGenerate() {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(returnObject) }],
        finishReason: 'stop' as const,
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        warnings: [] as unknown[],
      };
    },
    async doStream() { throw new Error('doStream not used'); },
  } as any;
}

const blockModel = (docType: string): BlockModel => ({
  docId: 'DOC-1', docType, modality: 'digital',
  blocks: [{ id: 'b0', type: 'text', text: '合同号 HT-2024-001', page: 1, bbox: null, ocrConfidence: 1 }],
  sourceUri: 'file:///c.pdf', createdAt: '2026-08-26T00:00:00Z',
});

describe('extraction props degrade path', () => {
  it('listTemplateTypes 抛错时抽取仍正常返回(降级为无 props)', async () => {
    const model = stubModel({ fields: { 合同号: { value: 'HT-2024-001', sourceSpans: [{ blockId: 'b0', start: 3, end: 15 }] } }, llmConsistency: 0.9 });
    const deps = buildAutoExtractionDeps({
      ctx: {} as never, // listTemplateTypes 被 mock 抛错, ctx 不被使用
      extraction: { model },
    });
    const out = await deps.extract(blockModel('合同'));
    expect(out.fields['合同号']?.value).toBe('HT-2024-001');
  });
});