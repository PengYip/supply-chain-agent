import { describe, it, expect, beforeEach } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  tagExternal,
  assertWithinRoot,
  EXTERNAL_OPEN,
  EXTERNAL_CLOSE,
} from '../../src/harness/injectionDefense.js';
import { env } from '../../src/env.js';
import { createDb, migrate } from '../../src/pipeline/db/client.js';
import {
  buildIngestDocumentTool,
  buildExtractFieldsTool,
} from '../../src/pipeline/tools/documentEntry.js';
import { verifyDocumentFields } from '../../src/tools/hitl.js';

describe('injectionDefense - tagExternal', () => {
  it('wraps non-empty content with open+close sentinels around the content', () => {
    const out = tagExternal('HT-2024-001');
    expect(out).toContain(EXTERNAL_OPEN);
    expect(out).toContain(EXTERNAL_CLOSE);
    expect(out).toContain('HT-2024-001');
    // sentinels must bracket the content (open before, close after)
    expect(out.indexOf(EXTERNAL_OPEN)).toBeLessThan(out.indexOf('HT-2024-001'));
    expect(out.indexOf('HT-2024-001')).toBeLessThan(out.indexOf(EXTERNAL_CLOSE));
  });

  it('leaves empty string unchanged (no misleading sentinels)', () => {
    expect(tagExternal('')).toBe('');
  });
});

describe('injectionDefense - assertWithinRoot', () => {
  it('accepts a path inside INGEST_ROOT', () => {
    const inside = join(env.INGEST_ROOT, 'a.pdf');
    const resolved = assertWithinRoot(inside);
    expect(resolved).toBe(inside);
  });

  it('rejects a parent-traversal path (../../etc/passwd)', () => {
    expect(() => assertWithinRoot('../etc/passwd')).toThrow(/outside ingest root/);
  });

  it('rejects an absolute path outside the root', () => {
    // C:\Windows\system32\drivers\etc\hosts is guaranteed outside INGEST_ROOT.
    const outside = process.platform === 'win32'
      ? 'C:\\Windows\\system32\\drivers\\etc\\hosts'
      : '/etc/passwd';
    expect(() => assertWithinRoot(outside)).toThrow(/outside ingest root/);
  });

  it('is not vulnerable to a sibling prefix collision', () => {
    // A directory whose name merely starts with INGEST_ROOT's basename must be
    // rejected. e.g. root .../ingest-root must NOT match .../ingest-root-evil/x.
    const evil = env.INGEST_ROOT + '-evil\\x.pdf';
    expect(() => assertWithinRoot(evil)).toThrow(/outside ingest root/);
  });
});

// Integration: proves the defense is wired into extract_fields end-to-end.
// Reuses the same fake-LanguageModelV2 seam as the pipeline/harness tests, but
// doGenerate returns JSON the SDK parses into the grounded-extraction schema.
describe('injectionDefense - extract_fields wraps external-derived strings', () => {
  let ctx: ReturnType<typeof createDb>;

  beforeEach(() => {
    ctx = createDb(':memory:');
    migrate(ctx.sqlite);
  });

  it('wraps the extracted value and citedText in <external_content>', async () => {
    // Fixture must live under INGEST_ROOT (ingest_document path allowlist).
    const f = join(env.INGEST_ROOT, `id-${Date.now()}.txt`);
    writeFileSync(f, '合同号: HT-2024-001', 'utf-8');

    const fakeModel = {
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
                    sourceSpans: [{ blockId: 'b0', start: 5, end: 16 }],
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
    };

    const ingest = buildIngestDocumentTool({ ctx });
    const { docId } = await ingest.execute(
      { sourceUri: f, docType: '合同', modality: 'digital' },
      { messages: [], toolCallId: 't', abortSignal: undefined as any } as any,
    );

    const extract = buildExtractFieldsTool({ ctx, extraction: { model: fakeModel as any } });
    const res: any = await extract.execute(
      { docId, docType: '合同' },
      { messages: [], toolCallId: 't', abortSignal: undefined as any } as any,
    );

    // At least one returned field value carries the external-content sentinel.
    const values = (res.fields as Array<{ value: string | number }>).map((x) => String(x.value));
    expect(values.some((v) => v.includes('<external_content'))).toBe(true);

    // The wrapped value is the full tagged form around the extracted string.
    const contract = (res.fields as Array<{ name: string; value: string | number }>)
      .find((x) => x.name === '合同号')!;
    expect(String(contract.value)).toBe(tagExternal('HT-2024-001'));
  });
});

// Integration: verify_document_fields (HITL OCR tool) must also wrap its
// external-derived strings. Uses the seeded bill-of-lading doc directly.
describe('injectionDefense - verify_document_fields wraps OCR strings', () => {
  it('wraps every ocrValue in <external_content>', async () => {
    const res: any = await verifyDocumentFields.execute(
      { documentId: 'BL-2024-0920-002' },
      { messages: [], toolCallId: 't', abortSignal: undefined as any } as any,
    );
    expect(res.ok).toBe(true);
    const values = (res.fields as Array<{ ocrValue: string }>).map((f) => f.ocrValue);
    expect(values.length).toBeGreaterThan(0);
    for (const v of values) {
      expect(v).toContain('<external_content');
      expect(v).toContain(EXTERNAL_CLOSE);
    }
    // Spot-check the full tagged form for a known seeded value.
    const consignee = (res.fields as Array<{ name: string; ocrValue: string }>)
      .find((f) => f.name === '收货人')!;
    expect(consignee.ocrValue).toBe(tagExternal('华盛集团'));
  });
});
