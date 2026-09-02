import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createDb, migrate, type DbContext } from '../../src/pipeline/db/client.js';
import { extractGroundedFields } from '../../src/pipeline/extraction.js';
import { classifyDocument } from '../../src/pipeline/classifier.js';
import { makeLlmTagger } from '../../src/pipeline/chunkTagging.js';
import type { BlockModel, Block } from '../../src/pipeline/types.js';

// Pipeline LLM usage audit (2026-09-02): extraction / classification /
// chunk_tagging calls must each write an llm_calls row (ok + error). Scaffold
// mirrors audit.test.ts: mock dbBackend.getDbContext -> in-memory SQLite so the
// fire-and-forget recordLlmCall writes land where we can assert them.

const { ctxHolder } = vi.hoisted(() => ({ ctxHolder: { current: null as DbContext | null } }));
vi.mock('../../src/pipeline/db/dbBackend.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../src/pipeline/db/dbBackend.js')>();
  return { ...mod, getDbContext: () => ctxHolder.current };
});

const { listLlmCalls, flushUsageAudit } = await import('../../src/harness/usageAudit.js');

let ctx: DbContext;

beforeEach(() => {
  ctx = createDb(':memory:');
  migrate(ctx.sqlite);
  ctxHolder.current = ctx;
});

/** Fake LanguageModelV2 whose doGenerate returns JSON the SDK parses into the
 *  target zod schema. Mirrors classifier.test.ts / documentEntry.test.ts. */
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
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
        warnings: [] as unknown[],
      };
    },
    async doStream() {
      throw new Error('doStream not used');
    },
  } as any;
}

const blockModel: BlockModel = {
  docId: 'DOC-1',
  docType: '合同',
  modality: 'digital',
  blocks: [
    { id: 'b0', type: 'kv', text: '合同号: HT-2024-001', page: 1, bbox: null, ocrConfidence: 1 },
  ],
  sourceUri: 'u',
  createdAt: '2026-09-02T00:00:00.000Z',
};

const blocks = (text: string): Block[] => [
  { id: 'b0', type: 'text', text, page: 1, bbox: null, ocrConfidence: 1 },
];

describe('pipeline llm_calls usage audit', () => {
  it('extraction ok: writes an llm_calls row with kind/model/tokens/doc prefix', async () => {
    const model = stubModel({
      fields: { 合同号: { value: 'HT-2024-001', sourceSpans: [{ blockId: 'b0', start: 5, end: 16 }] } },
      llmConsistency: 0.9,
    });
    const res = await extractGroundedFields({ model }, { blockModel, docType: '合同' });
    expect(res.fields.length).toBeGreaterThan(0);
    await flushUsageAudit();

    const { rows, total } = await listLlmCalls(ctx);
    expect(total).toBe(1);
    const row = rows[0];
    expect(row.kind).toBe('extraction');
    expect(row.model).toBe('fake-model');
    expect(row.inputTokens).toBe(10);
    expect(row.outputTokens).toBe(5);
    expect(row.totalTokens).toBe(15);
    expect(row.status).toBe('ok');
    expect(row.inputPreview).toContain('doc:DOC-1 ');
    expect(row.inputChars).toBeGreaterThan(0);
    expect(row.outputChars).toBeGreaterThan(0);
    expect(row.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('extraction error: writes an llm_calls row with status error + message', async () => {
    const model = stubModel({ fields: { 合同号: { value: 'x', sourceSpans: [] } }, llmConsistency: 1.4 });
    // confidence 1.4 violates the schema -> generateObject throws.
    await expect(
      extractGroundedFields({ model }, { blockModel, docType: '合同' }),
    ).rejects.toThrow();
    await flushUsageAudit();

    const { rows, total } = await listLlmCalls(ctx);
    expect(total).toBe(1);
    const row = rows[0];
    expect(row.kind).toBe('extraction');
    expect(row.status).toBe('error');
    expect(row.error).toBeTruthy();
    expect(row.inputPreview).toContain('doc:DOC-1 ');
  });

  it('classification ok: writes a row per LLM stage (coarse + fine)', async () => {
    // Coarse returns 履约凭证 (valid coarse), fine returns 发票 (valid fine).
    const model = stubModel({ docType: '履约凭证', confidence: 0.93 });
    const fineModel = stubModel({ docType: '发票', confidence: 0.9 });
    let calls = 0;
    const seqModel = {
      ...model,
      async doGenerate() {
        calls += 1;
        return calls === 1 ? await model.doGenerate() : await fineModel.doGenerate();
      },
    };
    const res = await classifyDocument(
      { model: seqModel },
      {
        blocks: blocks('发票号码 INV-001'),
        hint: '其他',
        docId: 'DOC-2',
        vocab: { coarse: ['合同', '立项书', '履约凭证', '其他'], fineByCoarse: { '履约凭证': ['发票', '收货单'] } },
      },
    );
    expect(res.source).toBe('classified');
    await flushUsageAudit();

    const { rows, total } = await listLlmCalls(ctx);
    expect(total).toBe(2); // coarse + fine
    for (const row of rows) {
      expect(row.kind).toBe('classification');
      expect(row.model).toBe('fake-model');
      expect(row.status).toBe('ok');
      expect(row.inputPreview).toContain('doc:DOC-2 ');
    }
  });

  it('chunk_tagging ok: writes an llm_calls row', async () => {
    const tagger = makeLlmTagger(stubModel({ assignments: [{ chunkIndex: 0, tags: ['当事人信息'] }] }));
    const out = await tagger([{ index: 0, text: '甲方...' }], ['当事人信息', '标的物']);
    expect(out[0]).toEqual(['当事人信息']);
    await flushUsageAudit();

    const { rows, total } = await listLlmCalls(ctx);
    expect(total).toBe(1);
    const row = rows[0];
    expect(row.kind).toBe('chunk_tagging');
    expect(row.model).toBe('fake-model');
    expect(row.status).toBe('ok');
    expect(row.inputTokens).toBe(10);
  });
});
