import { describe, it, expect, beforeEach } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createDb, migrate } from '../../../src/pipeline/db/client.js';
import { env } from '../../../src/env.js';
import {
  buildIngestDocumentTool, buildExtractFieldsTool, buildBindDocumentTool, buildInspectExtractionTool,
  buildTagDocumentTool,
  processDocument, ensureDocumentParsed, ensureDocumentExtracted,
} from '../../../src/pipeline/tools/documentEntry.js';
import { writeDocxFixture } from '../fixtures/makeDocx.js';
import { writeXlsxFixture } from '../fixtures/makeXlsx.js';

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

  it('extract_fields 回写台账时派生 contract_type 落库(主体是卖方 -> 销售)', async () => {
    const { addSelfParty } = await import('../../../src/pipeline/db/repositories.js');
    await addSelfParty(ctx, '我方贸易', 'u1');

    const f = join(dir, 'sale.txt');
    writeFileSync(f, '合同号：HT-T2-001\n买方：某钢厂\n卖方：我方贸易\n', 'utf-8');
    const ingest = buildIngestDocumentTool({ ctx });
    const ing: any = await ingest.execute(
      { sourceUri: f, docType: '合同', modality: 'digital' },
      { messages: [], toolCallId: 't', abortSignal: undefined as any } as any,
    );

    // Stub model returning 合同号 + 买方/卖方(主体名单命中卖方 -> contractType 销售)。
    const saleModel = {
      ...stubModel,
      async doGenerate() {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                fields: {
                  合同号: { value: 'HT-T2-001', sourceSpans: [{ blockId: 'b0', start: 4, end: 14 }] },
                  买方: { value: '某钢厂', sourceSpans: [{ blockId: 'b1', start: 3, end: 6 }] },
                  卖方: { value: '我方贸易', sourceSpans: [{ blockId: 'b2', start: 3, end: 7 }] },
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
    } as any;
    const extract = buildExtractFieldsTool({ ctx, extraction: { model: saleModel } as any });
    await extract.execute(
      { docId: ing.docId, docType: '合同' },
      { messages: [], toolCallId: 't', abortSignal: undefined as any } as any,
    );

    const row = ctx.sqlite
      .prepare('SELECT contract_type FROM contract_ledger WHERE contract_no = ?')
      .get('HT-T2-001') as { contract_type: string | null };
    expect(row.contract_type).toBe('销售');
  });

  it('合同抽取含合同号+项目名称 -> projects/project_memberships 出现 proposed 行', async () => {
    const { addSelfParty } = await import('../../../src/pipeline/db/repositories.js');
    await addSelfParty(ctx, '我方贸易', 'u1');

    const f = join(dir, 'prj.txt');
    writeFileSync(f, '合同号：HT-T8-001\n甲方：我方贸易\n乙方：某供应商\n项目名称：曹妃甸项目\n', 'utf-8');
    const ingest = buildIngestDocumentTool({ ctx });
    const ing: any = await ingest.execute(
      { sourceUri: f, docType: '合同', modality: 'digital' },
      { messages: [], toolCallId: 't', abortSignal: undefined as any } as any,
    );

    const prjModel = {
      ...stubModel,
      async doGenerate() {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                fields: {
                  合同号: { value: 'HT-T8-001', sourceSpans: [{ blockId: 'b0', start: 4, end: 14 }] },
                  甲方: { value: '我方贸易', sourceSpans: [{ blockId: 'b1', start: 3, end: 7 }] },
                  乙方: { value: '某供应商', sourceSpans: [{ blockId: 'b2', start: 3, end: 7 }] },
                  项目名称: { value: '曹妃甸项目', sourceSpans: [{ blockId: 'b3', start: 5, end: 10 }] },
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
    } as any;
    const extract = buildExtractFieldsTool({ ctx, extraction: { model: prjModel } as any });
    await extract.execute(
      { docId: ing.docId, docType: '合同' },
      { messages: [], toolCallId: 't', abortSignal: undefined as any } as any,
    );

    const project = ctx.sqlite
      .prepare('SELECT code, name FROM projects')
      .get() as { code: string; name: string } | undefined;
    expect(project?.code).toBe('曹妃甸项目'); // normalizeName(名称) 兜底为 code
    expect(project?.name).toBe('曹妃甸项目');

    const membership = ctx.sqlite
      .prepare('SELECT contract_no, project_code, status, proposed_by FROM project_memberships')
      .get() as { contract_no: string; project_code: string; status: string; proposed_by: string } | undefined;
    expect(membership?.contract_no).toBe('HT-T8-001');
    expect(membership?.project_code).toBe('曹妃甸项目');
    expect(membership?.status).toBe('proposed');
    expect(membership?.proposed_by).toBe('system');
  });

  it('发票 docType 抽取 -> 两表无新行', async () => {
    const f = join(dir, 'inv.txt');
    writeFileSync(f, '发票号：INV-9\n合同号：HT-T8-002\n项目名称：某项目\n', 'utf-8');
    const ingest = buildIngestDocumentTool({ ctx });
    const ing: any = await ingest.execute(
      { sourceUri: f, docType: '发票', modality: 'digital' },
      { messages: [], toolCallId: 't', abortSignal: undefined as any } as any,
    );

    const invModel = {
      ...stubModel,
      async doGenerate() {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                fields: {
                  发票号: { value: 'INV-9', sourceSpans: [{ blockId: 'b0', start: 4, end: 9 }] },
                  合同号: { value: 'HT-T8-002', sourceSpans: [{ blockId: 'b1', start: 4, end: 14 }] },
                  项目名称: { value: '某项目', sourceSpans: [{ blockId: 'b2', start: 5, end: 8 }] },
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
    } as any;
    const extract = buildExtractFieldsTool({ ctx, extraction: { model: invModel } as any });
    await extract.execute(
      { docId: ing.docId, docType: '发票' },
      { messages: [], toolCallId: 't', abortSignal: undefined as any } as any,
    );

    expect((ctx.sqlite.prepare('SELECT COUNT(*) AS n FROM projects').get() as { n: number }).n).toBe(0);
    expect((ctx.sqlite.prepare('SELECT COUNT(*) AS n FROM project_memberships').get() as { n: number }).n).toBe(0);
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
      // Real span pointing into b0 ("发票号：INV-001"): prefix 发票号： is 4 chars
      // (full-width colon), then INV-001 occupies positions 4..11. Must resolve
      // to a non-null citedText via validateSpan so the recompute loop + the
      // break-on-first-valid-span branch both get exercised.
      fields: { 发票号: { value: 'INV-001', sourceSpans: [{ blockId: 'b0', start: 4, end: 11 }] } },
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
    // citedText is recomputed from the seeded span via validateSpan (the tool's
    // headline DRY behavior), then wrapped via tagExternal like value.
    expect(String(out.citedText)).toContain('INV-001');
    expect(String(out.citedText)).toContain('external_content');
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

  // Stub model whose doGenerate returns classifier-schema JSON (docType + confidence).
  const stubClassifierModel = {
    specificationVersion: 'v2' as const,
    provider: 'fake',
    modelId: 'fake-model',
    supportedUrls: {} as Record<string, RegExp[]>,
    async doGenerate() {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ docType: '合同', confidence: 0.88 }),
          },
        ],
        finishReason: 'stop' as const,
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        warnings: [] as unknown[],
      };
    },
    async doStream() {
      throw new Error('doStream not used by classify');
    },
  } as any;

  it('ingest_document classifies docType and overrides the hint, persisting the result', async () => {
    const f = join(dir, 'contract.txt');
    writeFileSync(f, '合同号：HT-2024-001\n买方：示例公司\n卖方：另一方公司\n', 'utf-8');
    // Pass an intentionally-wrong hint ('其他'); the classifier should override to '合同'.
    const ingest = buildIngestDocumentTool({
      ctx,
      classifier: { model: stubClassifierModel } as any,
    });
    const res: any = await ingest.execute(
      { sourceUri: f, docType: '其他', modality: 'digital' },
      { messages: [], toolCallId: 't', abortSignal: undefined as any } as any,
    );
    expect(res.docId).toBeDefined();
    expect(res.classifiedDocType).toBe('合同');
    expect(res.classificationConfidence).toBeCloseTo(0.88, 5);
    expect(res.classificationSource).toBe('classified');

    // The classified docType is what the documents row stores.
    const { loadDocument, loadClassification } = await import(
      '../../../src/pipeline/db/repositories.js'
    );
    const model = await loadDocument(ctx, res.docId);
    expect(model?.docType).toBe('合同');
    const cls = await loadClassification(ctx, res.docId);
    expect(cls?.docType).toBe('合同');
    expect(cls?.confidence).toBeCloseTo(0.88, 5);
    expect(cls?.source).toBe('classified');
    expect(cls?.hint).toBe('其他');
  });

  it('ingest_document degrades to the hint docType when no classifier is wired', async () => {
    const f = join(dir, 'bill.txt');
    writeFileSync(f, '提单号：BL-9\n', 'utf-8');
    const ingest = buildIngestDocumentTool({ ctx }); // no classifier
    const res: any = await ingest.execute(
      // docType omitted -> hint defaults to '其他'
      { sourceUri: f, modality: 'digital' },
      { messages: [], toolCallId: 't', abortSignal: undefined as any } as any,
    );
    expect(res.classifiedDocType).toBe('其他');
    expect(res.classificationSource).toBe('hint');
    // Per shipped classifier.ts: hint/degrade confidence is 0 (LOW) so a bare
    // hint is never treated as an authoritative classification.
    expect(res.classificationConfidence).toBe(0);
  });

  it('ingest_document persists + returns auto-derived tags', async () => {
    const f = join(dir, 'contract-lc.txt');
    writeFileSync(f, '合同号：HT-2024-001\n本合同采用信用证（L/C）结算，条款 CIF\n', 'utf-8');
    const ingest = buildIngestDocumentTool({ ctx }); // no classifier -> docType hint '其他'
    // Supply docType hint '合同' so auto-tag seeds with '合同' even without a classifier.
    const res: any = await ingest.execute(
      { sourceUri: f, docType: '合同', modality: 'digital' },
      { messages: [], toolCallId: 't', abortSignal: undefined as any } as any,
    );
    expect(Array.isArray(res.tags)).toBe(true);
    expect(res.tags.length).toBeGreaterThan(0);
    expect(res.tags).toContain('合同');
    expect(res.tags).toContain('信用证');

    const { listDocumentTags } = await import('../../../src/pipeline/db/repositories.js');
    const rows = await listDocumentTags(ctx, res.docId);
    const autoTags = rows.filter((r) => r.source === 'auto').map((r) => r.tag);
    expect(autoTags).toContain('合同');
    expect(autoTags).toContain('信用证');
  });

  it('ingest_document survives an auto-tag persistence failure (degrades gracefully)', async () => {
    // Fault injection: drop the document_tags table so saveDocumentTags throws
    // "no such table" mid-ingest. Auto-tags are a byproduct (design §8); a
    // persistence failure must NOT kill the already-committed primary result
    // (saveDocument/saveClassification/saveChunks have all run). Mirrors the
    // vector-embedding block's fault-tolerant try/catch pattern.
    ctx.sqlite.exec('DROP TABLE document_tags');
    const f = join(dir, 'lc.txt');
    writeFileSync(f, '合同号: HT-2024-001\n本合同采用信用证 CIF\n', 'utf-8');
    const ingest = buildIngestDocumentTool({ ctx });
    const res: any = await ingest.execute(
      { sourceUri: f, docType: '合同', modality: 'digital' },
      { messages: [], toolCallId: 't', abortSignal: undefined as any } as any,
    );
    // Primary result committed despite the tag-stage throw.
    expect(res.docId).toBeDefined();
    expect(res.classifiedDocType).toBe('合同');
    expect(res.blockCount).toBeGreaterThan(0);
    // Return shape unchanged: tags is still an array (deriveAutoTags ran
    // before the persist threw).
    expect(Array.isArray(res.tags)).toBe(true);
    // The document row itself persisted.
    const { loadDocument } = await import('../../../src/pipeline/db/repositories.js');
    const model = await loadDocument(ctx, res.docId);
    expect(model?.docType).toBe('合同');
  });

  it('tag_document (L2) adds explicit tags to an existing document', async () => {
    const f = join(dir, 'c.txt');
    writeFileSync(f, '合同号: HT-2024-001\n', 'utf-8');
    const ingest = buildIngestDocumentTool({ ctx });
    const ing: any = await ingest.execute(
      { sourceUri: f, docType: '合同', modality: 'digital' },
      { messages: [], toolCallId: 't', abortSignal: undefined as any } as any,
    );

    const tag = buildTagDocumentTool({ ctx });
    const out: any = await tag.execute(
      { docId: ing.docId, tags: ['重要', '客户A'] },
      { messages: [], toolCallId: 't', abortSignal: undefined as any } as any,
    );
    expect(out.status).toBe('ok');
    expect(out.docId).toBe(ing.docId);
    expect(out.addedTags.sort()).toEqual(['客户A', '重要']);

    const { listDocumentTags } = await import('../../../src/pipeline/db/repositories.js');
    const rows = await listDocumentTags(ctx, ing.docId);
    const explicit = rows.filter((r) => r.source === 'explicit').map((r) => r.tag).sort();
    expect(explicit).toEqual(['客户A', '重要']);
    // totalTags counts every tag row (auto + explicit).
    expect(out.totalTags).toBe(rows.length);
  });

  it('tag_document errors on unknown docId', async () => {
    const tag = buildTagDocumentTool({ ctx });
    const out: any = await tag.execute(
      { docId: 'DOC-does-not-exist', tags: ['x'] },
      { messages: [], toolCallId: 't', abortSignal: undefined as any } as any,
    );
    expect(out.status).toBe('error');
    expect(out.reason).toBe('document_not_found');
  });

  it('tag_document is idempotent on repeated identical tags', async () => {
    const f = join(dir, 'c2.txt');
    writeFileSync(f, '发票号 INV-1\n', 'utf-8');
    const ingest = buildIngestDocumentTool({ ctx });
    const ing: any = await ingest.execute(
      { sourceUri: f, docType: '发票', modality: 'digital' },
      { messages: [], toolCallId: 't', abortSignal: undefined as any } as any,
    );
    const tag = buildTagDocumentTool({ ctx });
    await tag.execute(
      { docId: ing.docId, tags: ['重点'] },
      { messages: [], toolCallId: 't', abortSignal: undefined as any } as any,
    );
    const out: any = await tag.execute(
      { docId: ing.docId, tags: ['重点'] },
      { messages: [], toolCallId: 't', abortSignal: undefined as any } as any,
    );
    // Second call adds nothing new.
    expect(out.addedTags).toEqual([]);
  });

  it('tag_document rejects an empty tag list with a clear reason', async () => {
    const f = join(dir, 'c3.txt');
    writeFileSync(f, 'x\n', 'utf-8');
    const ingest = buildIngestDocumentTool({ ctx });
    const ing: any = await ingest.execute(
      { sourceUri: f, docType: '其他', modality: 'digital' },
      { messages: [], toolCallId: 't', abortSignal: undefined as any } as any,
    );
    const tag = buildTagDocumentTool({ ctx });
    const out: any = await tag.execute(
      { docId: ing.docId, tags: [] },
      { messages: [], toolCallId: 't', abortSignal: undefined as any } as any,
    );
    expect(out.status).toBe('error');
    expect(out.reason).toBe('no_tags_provided');
  });
});

// Model B: processDocument runs the parse pipeline on an EXISTING upload stub
// (created by createDocumentStub). Upload is storage-only; parse runs on demand.
describe('processDocument (on-demand parse of an existing stub)', () => {
  it('parses a stub with real text to parseStatus=parsed and persists the BlockModel', async () => {
    const f = join(dir, 'proc.txt');
    writeFileSync(f, '合同号：HT-2024-001\n金额：100000\n', 'utf-8');
    const { createDocumentStub, getDocumentParseStatus, loadDocument } = await import(
      '../../../src/pipeline/db/repositories.js'
    );
    const { docId } = await createDocumentStub(ctx, { sourceUri: f, docType: '合同' });
    expect(await getDocumentParseStatus(ctx, docId)).toBe('uploaded');

    const res = await processDocument(ctx, docId, { docType: '合同', modality: 'digital' });

    expect(res.parseStatus).toBe('parsed');
    expect(res.blockCount).toBeGreaterThan(0);
    expect(await getDocumentParseStatus(ctx, docId)).toBe('parsed');
    // The parsed BlockModel is persisted onto the stub row (updateDocumentMeta),
    // so downstream tools (extract_fields / recall) can read it back.
    const model = await loadDocument(ctx, docId);
    expect(model?.blocks.length).toBeGreaterThan(0);
    expect(model?.docType).toBe('合同');
  });

  it('parses a .docx stub end-to-end: Chinese paragraphs + table rows persisted', async () => {
    const f = join(dir, 'proc.docx');
    await writeDocxFixture(f, {
      paragraphs: ['合同编号：HT-2026-009', '甲方：华盛集团有限公司'],
      table: [
        ['品名', '单价', '数量'],
        ['甲醇', '2450', '500'],
      ],
    });
    const { createDocumentStub, getDocumentParseStatus, loadDocument } = await import(
      '../../../src/pipeline/db/repositories.js'
    );
    const { docId } = await createDocumentStub(ctx, { sourceUri: f, docType: '合同' });

    const res = await processDocument(ctx, docId, { docType: '合同', modality: 'digital' });

    // docx is born-digital: parses cleanly without any MinerU OCR detour.
    expect(res.parseStatus).toBe('parsed');
    expect(res.blockCount).toBeGreaterThan(0);
    expect(await getDocumentParseStatus(ctx, docId)).toBe('parsed');
    const model = await loadDocument(ctx, docId);
    const texts = model!.blocks.map((b) => b.text);
    expect(texts.some((t) => t.includes('华盛集团有限公司'))).toBe(true);
    const tableRows = model!.blocks.filter((b) => b.type === 'table_row');
    // Header + GFM separator + 1 data row = 3 pipe-row blocks.
    expect(tableRows.length).toBeGreaterThanOrEqual(2);
    expect(tableRows[0].text).toContain('品名');
    expect(tableRows.some((b) => b.text.includes('甲醇'))).toBe(true);
  });

  it('parses a .xlsx stub end-to-end: sheet heading + table rows persisted', async () => {
    const f = join(dir, 'proc.xlsx');
    await writeXlsxFixture(f, [
      {
        name: '明细',
        rows: [
          ['品名', '单价', '数量'],
          ['甲醇', 2450, 500],
        ],
      },
    ]);
    const { createDocumentStub, loadDocument } = await import(
      '../../../src/pipeline/db/repositories.js'
    );
    const { docId } = await createDocumentStub(ctx, { sourceUri: f, docType: '装箱单' });

    const res = await processDocument(ctx, docId, { docType: '装箱单', modality: 'digital' });

    expect(res.parseStatus).toBe('parsed');
    expect(res.blockCount).toBeGreaterThan(0);
    const model = await loadDocument(ctx, docId);
    const texts = model!.blocks.map((b) => b.text);
    expect(texts.some((t) => t === '## Sheet: 明细')).toBe(true);
    const tableRows = model!.blocks.filter((b) => b.type === 'table_row');
    expect(tableRows.some((b) => b.text.includes('品名'))).toBe(true);
    expect(tableRows.some((b) => b.text.includes('甲醇'))).toBe(true);
  });

  it('returns needs_ocr (does NOT throw) when the file yields 0 blocks', async () => {
    // Empty .txt -> digitalAdapter skips empty lines -> 0 blocks -> parseDocument
    // throws; the digital->scanned retry (MinerU, no sidecar) also fails.
    // processDocument's try/catch around the parse must land on 'needs_ocr'.
    const f = join(dir, 'empty.txt');
    writeFileSync(f, '', 'utf-8');
    const { createDocumentStub, getDocumentParseStatus } = await import(
      '../../../src/pipeline/db/repositories.js'
    );
    const { docId } = await createDocumentStub(ctx, { sourceUri: f });

    const res = await processDocument(ctx, docId, { modality: 'digital' });

    expect(res.parseStatus).toBe('needs_ocr');
    expect(res.blockCount).toBe(0);
    expect(typeof res.reason).toBe('string');
    expect(res.reason!.length).toBeGreaterThan(0);
    expect(await getDocumentParseStatus(ctx, docId)).toBe('needs_ocr');
  });

  it('throws document_not_found when the docId does not exist', async () => {
    await expect(
      processDocument(ctx, 'DOC-does-not-exist', { modality: 'digital' }),
    ).rejects.toThrow(/document_not_found/);
  });
});

// Model B single-flight: ensureDocumentParsed shares one run per doc across
// concurrent callers and skips terminal docs (no double-parse).
describe('ensureDocumentParsed (single-flight on-demand parse)', () => {
  // Slow fake classifier: counts invocations + delays inside doGenerate so two
  // concurrent calls overlap in the classify step, letting the test observe
  // single-flight (the classifier must run exactly once across both callers).
  let classifyCalls: number;
  const slowClassifierModel = {
    specificationVersion: 'v2',
    provider: 'fake',
    modelId: 'fake-model',
    supportedUrls: {} as Record<string, RegExp[]>,
    async doGenerate() {
      classifyCalls++;
      await new Promise((r) => setTimeout(r, 30));
      return {
        content: [{ type: 'text', text: JSON.stringify({ docType: '合同', confidence: 0.88 }) }],
        finishReason: 'stop' as const,
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        warnings: [] as unknown[],
      };
    },
    async doStream() {
      throw new Error('doStream not used by classify');
    },
  } as any;

  beforeEach(() => {
    classifyCalls = 0;
  });

  it('single-flights concurrent calls: one run, shared result', async () => {
    const f = join(dir, 'sf.txt');
    writeFileSync(f, '合同号：HT-001\n', 'utf-8');
    const { createDocumentStub } = await import('../../../src/pipeline/db/repositories.js');
    const { docId } = await createDocumentStub(ctx, { sourceUri: f });

    const [r1, r2] = await Promise.all([
      ensureDocumentParsed(ctx, docId, { modality: 'digital', classifier: { model: slowClassifierModel } }),
      ensureDocumentParsed(ctx, docId, { modality: 'digital', classifier: { model: slowClassifierModel } }),
    ]);

    expect(r1.parseStatus).toBe('parsed');
    expect(r2.parseStatus).toBe('parsed');
    expect(r1.docId).toBe(docId);
    expect(r2.docId).toBe(docId);
    // Single-flight: the classifier ran exactly ONCE across both callers.
    expect(classifyCalls).toBe(1);
  });

  it('skips an already-parsed doc (no re-parse)', async () => {
    const f = join(dir, 'term.txt');
    writeFileSync(f, '发票号：INV-9\n', 'utf-8');
    const { createDocumentStub } = await import('../../../src/pipeline/db/repositories.js');
    const { docId } = await createDocumentStub(ctx, { sourceUri: f });

    const r1 = await ensureDocumentParsed(ctx, docId, { modality: 'digital' });
    expect(r1.parseStatus).toBe('parsed');

    const r2 = await ensureDocumentParsed(ctx, docId, { modality: 'digital' });
    expect(r2.parseStatus).toBe('parsed');
    // No re-parse: exactly one classification row persisted for the doc.
    const row = ctx.sqlite
      .prepare('SELECT COUNT(*) AS n FROM classifications WHERE document_id = ?')
      .get(docId) as { n: number };
    expect(row.n).toBe(1);
  });

  it('re-runs after a failed parse (state -> retry)', async () => {
    const f = join(dir, 'retry.txt');
    writeFileSync(f, '合同号：HT-R1\n', 'utf-8');
    const { createDocumentStub, getDocumentParseStatus } = await import(
      '../../../src/pipeline/db/repositories.js'
    );
    const { docId } = await createDocumentStub(ctx, { sourceUri: f });
    // Break the pipeline mid-run: drop classifications so saveClassification throws.
    ctx.sqlite.exec('DROP TABLE classifications');
    const r1 = await ensureDocumentParsed(ctx, docId, { modality: 'digital' });
    expect(r1.parseStatus).toBe('failed');

    // Fix + retry -> re-runs to parsed (migrate re-creates classifications;
    // it is idempotent guarded DDL, safe to re-run on the same connection).
    migrate(ctx.sqlite);
    const r2 = await ensureDocumentParsed(ctx, docId, { modality: 'digital' });
    expect(r2.parseStatus).toBe('parsed');
    expect(await getDocumentParseStatus(ctx, docId)).toBe('parsed');
  });

  // 6b: force re-process of a terminal-'parsed' doc (POST /process {force:true}).
  it('force:true overrides the parsed-terminal gate and re-runs the pipeline', async () => {
    const f = join(dir, 'force-rerun.txt');
    writeFileSync(f, '合同号：HT-F1\n', 'utf-8');
    const { createDocumentStub, getDocumentParseStatus } = await import(
      '../../../src/pipeline/db/repositories.js'
    );
    const { docId } = await createDocumentStub(ctx, { sourceUri: f });

    const r1 = await ensureDocumentParsed(ctx, docId, { modality: 'digital' });
    expect(r1.parseStatus).toBe('parsed');
    expect(await getDocumentParseStatus(ctx, docId)).toBe('parsed');

    // Default (no force): the terminal short-circuit holds — one classification
    // row total, i.e. the pipeline did NOT re-run.
    const again = await ensureDocumentParsed(ctx, docId, { modality: 'digital' });
    expect(again.parseStatus).toBe('parsed');
    const before = ctx.sqlite
      .prepare('SELECT COUNT(*) AS n FROM classifications WHERE document_id = ?')
      .get(docId) as { n: number };
    expect(before.n).toBe(1);
    const chunksBefore = ctx.sqlite
      .prepare('SELECT COUNT(*) AS n FROM doc_chunk WHERE document_id = ?')
      .get(docId) as { n: number };
    expect(chunksBefore.n).toBeGreaterThan(0);

    // force:true: the gate lets a 'parsed' doc through -> full pipeline re-run
    // (parse/classify/chunks overwrite-recalc) landing back on 'parsed'.
    const forced = await ensureDocumentParsed(ctx, docId, { modality: 'digital', force: true });
    expect(forced.parseStatus).toBe('parsed');
    expect(await getDocumentParseStatus(ctx, docId)).toBe('parsed');
    const after = ctx.sqlite
      .prepare('SELECT COUNT(*) AS n FROM classifications WHERE document_id = ?')
      .get(docId) as { n: number };
    expect(after.n).toBe(2);
    // 覆盖语义: 重跑后 chunk 行不翻倍 —— 旧块先清后插(deleteChunksForDocument),
    // FTS/向量检索不会同时命中新旧两代文本。
    const chunksAfter = ctx.sqlite
      .prepare('SELECT COUNT(*) AS n FROM doc_chunk WHERE document_id = ?')
      .get(docId) as { n: number };
    expect(chunksAfter.n).toBe(chunksBefore.n);
  });

  it("force:true does NOT bypass a needs_ocr doc (the override is parsed-only)", async () => {
    const f = join(dir, 'force-ocr.txt');
    writeFileSync(f, '', 'utf-8');
    const { createDocumentStub, getDocumentParseStatus } = await import(
      '../../../src/pipeline/db/repositories.js'
    );
    const { docId } = await createDocumentStub(ctx, { sourceUri: f });
    const r1 = await ensureDocumentParsed(ctx, docId, { modality: 'digital' });
    expect(r1.parseStatus).toBe('needs_ocr');

    // Feed the source real content AFTER the terminal state: if needs_ocr were
    // force-bypassable this re-parse would succeed and flip to 'parsed'.
    // Asserting it stays needs_ocr pins the gate to parsed-only.
    writeFileSync(f, '合同号：HT-F2\n', 'utf-8');
    const r2 = await ensureDocumentParsed(ctx, docId, { modality: 'digital', force: true });
    expect(r2.parseStatus).toBe('needs_ocr');
    expect(await getDocumentParseStatus(ctx, docId)).toBe('needs_ocr');
  });
});

// Model B bug fix: auto-extraction could be silently killed by the 60s timeout
// (extraction_status='skipped'), leaving the review card empty. ensureDocumentExtracted
// re-runs extraction ONLY when needed; these tests verify the decision logic
// with NO real model (fast paths never touch opts.extraction).
describe('ensureDocumentExtracted (parse + extraction assurance)', () => {
  it('returns fast when extraction_status=ok (no re-extraction, no model needed)', async () => {
    const f = join(dir, 'ext-ok.txt');
    writeFileSync(f, '合同号：HT-E1\n', 'utf-8');
    const { createDocumentStub, setDocumentParseStatus, setExtractionStatus } = await import(
      '../../../src/pipeline/db/repositories.js'
    );
    const { docId } = await createDocumentStub(ctx, { sourceUri: f });
    await setDocumentParseStatus(ctx, docId, 'parsed');
    await setExtractionStatus(ctx, docId, 'ok');

    // opts has NO extraction dep: the fast path must not require a model.
    const res = await ensureDocumentExtracted(ctx, docId, { modality: 'digital' });
    expect(res.docId).toBe(docId);
    expect(res.parseStatus).toBe('parsed');
    expect(res.extractionStatus).toBe('ok');
  });

  it('returns early (no model) when re-extraction is needed but no extraction dep is wired', async () => {
    const f = join(dir, 'ext-skip.txt');
    writeFileSync(f, '合同号：HT-E2\n', 'utf-8');
    const { createDocumentStub, setDocumentParseStatus, setExtractionStatus } = await import(
      '../../../src/pipeline/db/repositories.js'
    );
    const { docId } = await createDocumentStub(ctx, { sourceUri: f });
    await setDocumentParseStatus(ctx, docId, 'parsed');
    // 'skipped' (the timeout outcome) is in the re-extract set -> enters the
    // re-extract branch; opts.extraction is absent -> early return, status as-is.
    await setExtractionStatus(ctx, docId, 'skipped');

    const res = await ensureDocumentExtracted(ctx, docId, { modality: 'digital' });
    expect(res.parseStatus).toBe('parsed');
    expect(res.extractionStatus).toBe('skipped');
  });

  it('re-extracts when extraction_status is null AND no extraction row exists (no model -> early return)', async () => {
    const f = join(dir, 'ext-null.txt');
    writeFileSync(f, '合同号：HT-E3\n', 'utf-8');
    const { createDocumentStub, setDocumentParseStatus } = await import(
      '../../../src/pipeline/db/repositories.js'
    );
    const { docId } = await createDocumentStub(ctx, { sourceUri: f });
    await setDocumentParseStatus(ctx, docId, 'parsed');
    // extraction_status left NULL (never stamped) + no extraction rows.

    const res = await ensureDocumentExtracted(ctx, docId, { modality: 'digital' });
    expect(res.parseStatus).toBe('parsed');
    // Enters the re-extract branch but has no extraction dep -> returns early
    // with extractionStatus undefined (status is NULL).
    expect(res.extractionStatus).toBeUndefined();
  });

  it('propagates document_not_found for an unknown doc', async () => {
    await expect(
      ensureDocumentExtracted(ctx, 'DOC-does-not-exist', { modality: 'digital' }),
    ).rejects.toThrow(/document_not_found/);
  });
});

// Model A (parse-speed optimization): processDocument returns as soon as the
// document is parsed+indexed; auto-extraction continues in a BACKGROUND
// single-flight registered by processDocument itself. These tests pin down:
//  - /process-like call returns BEFORE the (delayed) extraction model finishes,
//    with no extraction row yet;
//  - a follow-up ensureDocumentExtracted SHARES that same flight (model called
//    exactly once) and resolves to extraction_status='ok';
//  - waitExtraction=false never blocks on the model and self-heals a previously
//    failed extraction via a background re-run reported as 'pending'.
describe('background auto-extraction (parse decoupled from field extraction)', () => {
  const delayedModel = () => ({
    specificationVersion: 'v2' as const,
    provider: 'fake',
    modelId: 'fake-model',
    supportedUrls: {} as Record<string, RegExp[]>,
    calls: 0,
    async doGenerate(this: { calls: number }) {
      this.calls++;
      await new Promise((r) => setTimeout(r, 80));
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
      throw new Error('doStream not used');
    },
  });

  it('processDocument returns before background extraction lands; later ensure shares the flight (single model call)', async () => {
    const f = join(dir, 'bg.txt');
    writeFileSync(f, '合同号：HT-2024-001\n金额：100000\n', 'utf-8');
    const { createDocumentStub, getExtractionStatus } = await import(
      '../../../src/pipeline/db/repositories.js'
    );
    const { docId } = await createDocumentStub(ctx, { sourceUri: f, docType: '合同' });

    const model = delayedModel();
    const res = await processDocument(ctx, docId, {
      docType: '合同', modality: 'digital', extraction: { model: model as any },
    });
    // Parsing is done; the delayed extraction can't have finished yet.
    expect(res.parseStatus).toBe('parsed');
    expect(await getExtractionStatus(ctx, docId)).toBeNull();

    // The chat-backstop path awaits the SAME background run (one model call).
    const assured = await ensureDocumentExtracted(ctx, docId, {
      modality: 'digital', extraction: { model: model as any },
    });
    expect(assured.extractionStatus).toBe('ok');
    expect(model.calls).toBe(1);
  });

  it('waitExtraction=false returns pending and kicks a background re-extract for a failed doc', async () => {
    const f = join(dir, 'bg-fail.txt');
    writeFileSync(f, '合同号：HT-2024-002\n', 'utf-8');
    const { createDocumentStub, setDocumentParseStatus, setExtractionStatus } = await import(
      '../../../src/pipeline/db/repositories.js'
    );
    const { docId } = await createDocumentStub(ctx, { sourceUri: f });
    await setDocumentParseStatus(ctx, docId, 'parsed');
    await setExtractionStatus(ctx, docId, 'failed');

    const model = delayedModel();
    const fast = await ensureDocumentExtracted(ctx, docId, {
      modality: 'digital', extraction: { model: model as any }, waitExtraction: false,
    });
    expect(fast.parseStatus).toBe('parsed');
    expect(fast.extractionStatus).toBe('pending');

    // The kicked-off background flight completes and stamps 'ok'.
    const final = await ensureDocumentExtracted(ctx, docId, {
      modality: 'digital', extraction: { model: model as any },
    });
    expect(final.extractionStatus).toBe('ok');
    expect(model.calls).toBe(1);
  });
});
