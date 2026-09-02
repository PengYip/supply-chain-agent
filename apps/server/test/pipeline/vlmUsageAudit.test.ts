// VLM usage audit (2026-09-02): the four VLM fetch sites (vlmAdapter extractVoucher
// + typedVlmFetch, vlmClassifier vlmCall, batchSplit page detection) must each
// write an llm_calls row with the right kind, and the request body must carry
// enable_thinking:false. Scaffold mirrors usageAuditPipeline.test.ts: mock
// dbBackend.getDbContext -> in-memory SQLite so fire-and-forget recordLlmCall
// writes land where we can assert them.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createDb, migrate, type DbContext } from '../../src/pipeline/db/client.js';
import { env } from '../../src/env.js';
import { extractVoucher, extractVoucherTyped } from '../../src/pipeline/vlmAdapter.js';
import { vlmCall } from '../../src/pipeline/vlmClassifier.js';
import { detectDocumentUnits } from '../../src/pipeline/batchSplit.js';
import { buildPng } from './fixtures/png.js';

const { ctxHolder } = vi.hoisted(() => ({ ctxHolder: { current: null as DbContext | null } }));
vi.mock('../../src/pipeline/db/dbBackend.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../src/pipeline/db/dbBackend.js')>();
  return { ...mod, getDbContext: () => ctxHolder.current };
});

const { listLlmCalls, flushUsageAudit } = await import('../../src/harness/usageAudit.js');

let ctx: DbContext;

const saved = {
  base: env.VLM_BASE_URL,
  key: env.VLM_API_KEY,
  model: env.VLM_MODEL,
  timeout: env.VLM_TIMEOUT_MS,
};

beforeEach(() => {
  ctx = createDb(':memory:');
  migrate(ctx.sqlite);
  ctxHolder.current = ctx;
  env.VLM_BASE_URL = 'https://vlm.test';
  env.VLM_API_KEY = 'test-key';
  env.VLM_MODEL = 'test-model';
  env.VLM_TIMEOUT_MS = 5000;
});

afterEach(() => {
  env.VLM_BASE_URL = saved.base;
  env.VLM_API_KEY = saved.key;
  env.VLM_MODEL = saved.model;
  env.VLM_TIMEOUT_MS = saved.timeout;
  vi.unstubAllGlobals();
});

/** OpenAI-style response with usage + reasoning_tokens detail. */
function jsonResponse(content: string): Response {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => ({
      choices: [{ message: { content } }],
      usage: {
        prompt_tokens: 120,
        completion_tokens: 40,
        total_tokens: 160,
        completion_tokens_details: { reasoning_tokens: 0 },
      },
    }),
  } as unknown as Response;
}

const okVlmContent = JSON.stringify({
  voucherType: '付款凭证',
  fields: { 付款人名称: 'A', 收款人名称: 'B', 金额: 1, 入账日期: '2024-01-01' },
  字段置信度: { 金额: 0.99 },
});

describe('vlm_extract (extractVoucher)', () => {
  it('writes an llm_calls row with kind vlm_extract + mapped tokens; body has enable_thinking:false', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(okVlmContent));
    vi.stubGlobal('fetch', fetchMock);

    const result = await extractVoucher(Buffer.from('fake'), 'image/jpeg');
    expect(result.voucherType).toBe('付款凭证');

    const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string);
    expect(body.enable_thinking).toBe(false);

    await flushUsageAudit();
    const { rows, total } = await listLlmCalls(ctx);
    expect(total).toBe(1);
    const row = rows[0];
    expect(row.kind).toBe('vlm_extract');
    expect(row.model).toBe('test-model');
    expect(row.inputTokens).toBe(120);
    expect(row.outputTokens).toBe(40);
    expect(row.totalTokens).toBe(160);
    expect(row.status).toBe('ok');
    // inputText must be the prompt text only -- never the base64 image payload.
    expect(row.inputPreview).toContain('你是供应链业务凭证识别模型');
    expect(row.inputPreview).not.toContain('base64');
    expect(row.outputPreview).toContain('付款凭证');
  });
});

describe('vlm_extract (extractVoucherTyped -> typedVlmFetch)', () => {
  it('writes a vlm_extract row; body has enable_thinking:false', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(JSON.stringify({ 编号: 'E1', 车号: '渝A', 毛重_吨: 1, 皮重_吨: 0.5, 净重_吨: 0.5, 字段置信度: {} })),
    );
    vi.stubGlobal('fetch', fetchMock);

    const img = { mime: 'image/png', buffer: Buffer.alloc(64, 1) };
    const r = await extractVoucherTyped([img], '汽运磅单');
    expect(r.fields['净重_吨']).toBe(0.5);

    const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string);
    expect(body.enable_thinking).toBe(false);

    await flushUsageAudit();
    const { rows, total } = await listLlmCalls(ctx);
    expect(total).toBe(1);
    expect(rows[0].kind).toBe('vlm_extract');
    expect(rows[0].status).toBe('ok');
    expect(rows[0].inputPreview).not.toContain('base64');
  });
});

describe('vlm_classify (vlmCall)', () => {
  it('writes a vlm_classify row; body has enable_thinking:false', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse('{"formType":"汽车过磅单票据","confidence":0.92}'));
    vi.stubGlobal('fetch', fetchMock);

    const content = await vlmCall('你是供应链单据表单类型识别器', { mime: 'image/png', buffer: Buffer.from('x') });
    expect(content).toContain('formType');

    const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string);
    expect(body.enable_thinking).toBe(false);

    await flushUsageAudit();
    const { rows, total } = await listLlmCalls(ctx);
    expect(total).toBe(1);
    expect(rows[0].kind).toBe('vlm_classify');
    expect(rows[0].status).toBe('ok');
    expect(rows[0].inputPreview).not.toContain('base64');
  });
});

describe('vlm_batch_split (detectDocumentUnits default call)', () => {
  it('writes a vlm_batch_split row via the default vlmCall', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(JSON.stringify({ units: [{ unitIndex: 1, formType: '质检报告', confidence: 0.9, bbox: { x: 0.01, y: 0.02, w: 0.48, h: 0.9 }, rotationDeg: 0, evidence: 'HX-001', identifierOrNull: 'HX-001' }] })),
    );
    vi.stubGlobal('fetch', fetchMock);

    const BLACK: [number, number, number, number] = [0, 0, 0, 255];
    const page = { page: 1, mime: 'image/png' as const, buffer: buildPng(32, 32, () => BLACK) };
    const res = await detectDocumentUnits(
      { sourcePath: 'x.pdf' },
      { renderPages: async () => [page] },
    );
    expect(res.units).toHaveLength(1);

    const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string);
    expect(body.enable_thinking).toBe(false);

    await flushUsageAudit();
    const { rows, total } = await listLlmCalls(ctx);
    expect(total).toBe(1);
    expect(rows[0].kind).toBe('vlm_batch_split');
    expect(rows[0].status).toBe('ok');
    expect(rows[0].inputPreview).not.toContain('base64');
  });
});
