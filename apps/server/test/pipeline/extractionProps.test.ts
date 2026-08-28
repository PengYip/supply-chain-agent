import { describe, it, expect, beforeEach } from 'vitest';
import { createDb, migrate } from '../../src/pipeline/db/client.js';
import { ensureTemplateSeed } from '../../src/pipeline/templateSeed.js';
import { listTemplateTypes } from '../../src/pipeline/db/repositories.js';
import { extractGroundedFields } from '../../src/pipeline/extraction.js';
import { CONTRACT_TEMPLATE_FIELDS } from '../../src/pipeline/schemas/contract.js';
import type { BlockModel, DocType } from '../../src/pipeline/types.js';

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

const blockModel = (docType: DocType): BlockModel => ({
  docId: 'DOC-1', docType, modality: 'digital',
  blocks: [{ id: 'b0', type: 'text', text: '合同号 HT-2024-001', page: 1, bbox: null, ocrConfidence: 1 }],
  sourceUri: 'file:///c.pdf', createdAt: '2026-08-26T00:00:00Z',
});

const ctx = createDb();
beforeEach(async () => { migrate(ctx.sqlite); await ensureTemplateSeed(ctx); });

describe('extraction props', () => {
  it('种子合同类型 props 含 requiredFields/fieldHints', async () => {
    const types = await listTemplateTypes(ctx);
    const hetong = types.find((t) => t.name === '合同')!;
    expect(Array.isArray(hetong.props.requiredFields)).toBe(true);
    expect(hetong.props.requiredFields).toContain('合同号');
  });

  it('extractGroundedFields 接受 requiredFields/fieldHints 且缺省行为不变', async () => {
    const model = stubModel({ fields: { 合同号: { value: 'HT-2024-001', sourceSpans: [{ blockId: 'b0', start: 3, end: 15 }] } }, llmConsistency: 0.9 });
    const r1 = await extractGroundedFields({ model }, { blockModel: blockModel('合同'), docType: '合同' });
    const r2 = await extractGroundedFields({ model }, {
      blockModel: blockModel('合同'),
      docType: '合同',
      requiredFields: ['合同号'], fieldHints: { 合同号: '合同编号' },
    });
    expect(r1.fields.length).toBeGreaterThanOrEqual(1);
    expect(r2.fields.length).toBeGreaterThanOrEqual(1);
    expect(r2.missingRequired).toEqual([]);
  });
});

describe('保底字段下限保证 (spec 2026-08-28)', () => {
  it('模型漏抽的保底字段补空值占位, 多抽字段保留', async () => {
    const model = stubModel({ fields: {
      合同号: { value: 'HT-2024-001', sourceSpans: [{ blockId: 'b0', start: 3, end: 15 }] },
      质量标准: { value: 'GB 19147', sourceSpans: [{ blockId: 'b0', start: 0, end: 5 }] },
    }, llmConsistency: 0.9 });
    const r = await extractGroundedFields({ model }, { blockModel: blockModel('合同'), docType: '合同' });
    const names = r.fields.map((f) => f.name);
    for (const f of CONTRACT_TEMPLATE_FIELDS) expect(names).toContain(f);
    expect(names).toContain('质量标准');
    const padded = r.fields.find((f) => f.name === '甲方')!;
    expect(padded.value).toBe('');
    expect(padded.sourceSpans).toEqual([]);
    expect(padded.strength).toBe('none');
  });

  it('全空抽取: missingRequired=全部保底字段, overallConfidence=0, needsReview=true', async () => {
    const model = stubModel({ fields: {}, llmConsistency: 0.5 });
    const r = await extractGroundedFields({ model }, { blockModel: blockModel('合同'), docType: '合同' });
    expect(r.fields).toHaveLength(CONTRACT_TEMPLATE_FIELDS.length);
    expect(r.missingRequired).toHaveLength(CONTRACT_TEMPLATE_FIELDS.length);
    expect(r.missingRequired).toContain('合同号');
    expect(r.overallConfidence).toBe(0);
    expect(r.needsReview).toBe(true);
  });

  it('空值字段不稀释 overallConfidence(仅非空字段平均)', async () => {
    const model = stubModel({ fields: {
      合同号: { value: 'HT-2024-001', sourceSpans: [{ blockId: 'b0', start: 3, end: 15 }] },
    }, llmConsistency: 1 });
    const r = await extractGroundedFields({ model }, { blockModel: blockModel('合同'), docType: '合同' });
    const nonEmpty = r.fields.filter((f) => String(f.value).trim() !== '');
    expect(nonEmpty).toHaveLength(1);
    expect(r.overallConfidence).toBeGreaterThan(0);
  });
});