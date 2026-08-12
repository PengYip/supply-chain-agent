import { describe, it, expect, beforeEach } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createDb, migrate } from '../../../src/pipeline/db/client.js';
import { env } from '../../../src/env.js';
import {
  buildIngestDocumentTool, buildExtractFieldsTool, buildBindDocumentTool, buildInspectExtractionTool,
} from '../../../src/pipeline/tools/documentEntry.js';

let ctx: ReturnType<typeof createDb>;
let dir: string;
beforeEach(() => {
  ctx = createDb(':memory:');
  migrate(ctx.sqlite);
  // ingest_document enforces a path allowlist (assertWithinRoot) against
  // env.INGEST_ROOT, so fixtures must live inside it. Use a fresh subdir per
  // test for isolation.
  dir = join(env.INGEST_ROOT, `dc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(dir, { recursive: true });
});

// Fake LanguageModelV2 whose doGenerate returns JSON the SDK parses into the
// grounded-extraction schema (same seam as integration-recall /
// injectionDefense tests). Returns one grounded field pointing into b0 of the
// extract_fields fixture ("合同号：HT-2024-001"); used by the return-shape test.
const stubModel = {
  specificationVersion: 'v2' as const,
  provider: 'fake',
  modelId: 'fake-model',
  supportedUrls: {} as Record<string, RegExp[]>,
  async doGenerate() {
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            fields: {
              合同号: {
                value: 'HT-2024-001',
                sourceSpans: [{ blockId: 'b0', start: 4, end: 15 }],
              },
            },
            llmConsistency: 0.95,
          }),
        },
      ],
      finishReason: 'stop' as const,
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      warnings: [] as unknown[],
    };
  },
  async doStream() {
    throw new Error('doStream not used by extract_fields');
  },
} as any;

describe('document-entry tools', () => {
  it('ingest_document parses a digital file and persists a BlockModel', async () => {
    const f = join(dir, 'c.txt');
    writeFileSync(f, '合同号: HT-2024-001\n金额: 2860000', 'utf-8');
    const ingest = buildIngestDocumentTool({ ctx });
    const res = await ingest.execute({ sourceUri: f, docType: '合同', modality: 'digital' }, {
      messages: [], toolCallId: 't', abortSignal: undefined as any,
    } as any);
    expect(res.docId).toBeDefined();
    expect(res.blockCount).toBe(2);
    expect(res.modality).toBe('digital');
  });

  it('bind_document (L2) writes a binding for the contract', async () => {
    const f = join(dir, 'c.txt');
    writeFileSync(f, '合同号: HT-2024-001', 'utf-8');
    const ingest = buildIngestDocumentTool({ ctx });
    const { docId } = await ingest.execute({ sourceUri: f, docType: '合同', modality: 'digital' }, {
      messages: [], toolCallId: 't', abortSignal: undefined as any,
    } as any);

    const bind = buildBindDocumentTool({ ctx });
    const res = await bind.execute(
      { documentId: docId, contractNo: 'HT-2024-001', relation: 'primary', confidence: 0.98 },
      { messages: [], toolCallId: 't', abortSignal: undefined as any } as any,
    );
    expect(res.ok).toBe(true);
    expect(res.bindingId).toMatch(/^BD-/);
  });

  it('ingest_document rejects a path outside INGEST_ROOT (injection defense)', async () => {
    const ingest = buildIngestDocumentTool({ ctx });
    await expect(
      ingest.execute(
        { sourceUri: '../etc/passwd', docType: '合同', modality: 'digital' },
        { messages: [], toolCallId: 't', abortSignal: undefined as any } as any,
      ),
    ).rejects.toThrow(/outside ingest root/);
  });

  it('extract_fields returns a bounded summary without citedText/sourceSpans', async () => {
    // Ingest a doc first.
    const f = join(dir, 'contract.txt');
    writeFileSync(f, '合同号：HT-2024-001\n买方：示例公司\n卖方：另一方公司\n', 'utf-8');
    const ingest = buildIngestDocumentTool({ ctx });
    const ing: any = await ingest.execute(
      { sourceUri: f, docType: '合同', modality: 'digital' },
      { messages: [], toolCallId: 't', abortSignal: undefined as any } as any,
    );
    const docId = ing.docId;

    // extract_fields with a stub model (returns one grounded field, exercising the return shape).
    const extract = buildExtractFieldsTool({ ctx, extraction: { model: stubModel } as any });
    const out: any = await extract.execute(
      { docId, docType: '合同' },
      { messages: [], toolCallId: 't', abortSignal: undefined as any } as any,
    );

    // Bounded summary contract.
    expect(typeof out.extractionId).toBe('string');
    expect(Array.isArray(out.fields)).toBe(true);
    expect(out.fields.length).toBeGreaterThan(0);
    for (const fld of out.fields) {
      expect(fld).toHaveProperty('name');
      expect(fld).toHaveProperty('value');
      expect(fld).toHaveProperty('confidence');
      expect(fld).toHaveProperty('needsReview');
      expect(fld).toHaveProperty('autoAccepted');
      // Evidence must NOT be in the default return.
      expect(fld).not.toHaveProperty('citedText');
      expect(fld).not.toHaveProperty('sourceSpans');
    }
    expect(out).toHaveProperty('overallConfidence');
    expect(out).toHaveProperty('missingRequired');
  });

  it('inspect_extraction returns persisted-field evidence on demand', async () => {
    // Seed an extraction row directly so the test does not depend on the LLM.
    const { saveExtraction } = await import('../../../src/pipeline/db/repositories.js');
    const f = join(dir, 'inv.txt');
    writeFileSync(f, '发票号：INV-001\n金额：10000\n', 'utf-8');
    const ingest = buildIngestDocumentTool({ ctx });
    const ing: any = await ingest.execute(
      { sourceUri: f, docType: '发票', modality: 'digital' },
      { messages: [], toolCallId: 't', abortSignal: undefined as any } as any,
    );

    const extractionId = await saveExtraction(ctx, {
      documentId: ing.docId,
      docType: '发票',
      fields: { 发票号: { value: 'INV-001', sourceSpans: [] } },
      fieldMeta: { 发票号: { strength: 'exact', confidence: 0.95 } },
      overallConfidence: 0.95,
      needsReview: false,
    });

    const inspect = buildInspectExtractionTool({ ctx });
    const out: any = await inspect.execute(
      { extractionId, fieldName: '发票号' },
      { messages: [], toolCallId: 't', abortSignal: undefined as any } as any,
    );

    expect(out.status).toBe('ok');
    expect(out.fieldName).toBe('发票号');
    // value is wrapped via tagExternal (output contract is 'tagged'); the raw
    // value must come through AND be sentinel-wrapped (injection defense).
    expect(String(out.value)).toContain('INV-001');
    expect(String(out.value)).toContain('external_content');
    expect(out.confidence).toBe(0.95);
    expect(Array.isArray(out.sourceSpans)).toBe(true);
  });

  it('inspect_extraction errors on unknown field and lists available fields', async () => {
    const { saveExtraction } = await import('../../../src/pipeline/db/repositories.js');
    const f = join(dir, 'c.txt');
    writeFileSync(f, 'x\n', 'utf-8');
    const ingest = buildIngestDocumentTool({ ctx });
    const ing: any = await ingest.execute(
      { sourceUri: f, docType: '其他', modality: 'digital' },
      { messages: [], toolCallId: 't', abortSignal: undefined as any } as any,
    );
    const extractionId = await saveExtraction(ctx, {
      documentId: ing.docId,
      docType: '其他',
      fields: { a: { value: '1', sourceSpans: [] } },
      fieldMeta: { a: { strength: 'none', confidence: 0.1 } },
      overallConfidence: 0.1,
      needsReview: true,
    });

    const inspect = buildInspectExtractionTool({ ctx });
    const out: any = await inspect.execute(
      { extractionId, fieldName: 'nope' },
      { messages: [], toolCallId: 't', abortSignal: undefined as any } as any,
    );
    expect(out.status).toBe('error');
    expect(out.reason).toBe('field_not_found');
    expect(out.availableFields).toEqual(['a']);
  });
});
