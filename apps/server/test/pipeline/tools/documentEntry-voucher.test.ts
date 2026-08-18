// documentEntry 图片凭证 VLM 分支集成测试 (Phase A)。
// 注入 fake VLM deps(不依赖真实 VLM 配置), 断言 document/classification/
// extraction/chunk 各写一行、needs_review 路由、VLM 抛错时 parse_status 失败。

import { describe, it, expect, beforeEach } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createDb, migrate } from '../../../src/pipeline/db/client.js';
import { env } from '../../../src/env.js';
import { buildIngestDocumentTool, type VlmDeps } from '../../../src/pipeline/tools/documentEntry.js';
import type { VlmResult } from '../../../src/pipeline/vlmAdapter.js';

let ctx: ReturnType<typeof createDb>;
let dir: string;
beforeEach(() => {
  ctx = createDb(':memory:');
  migrate(ctx.sqlite);
  dir = join(env.INGEST_ROOT, `voucher-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(dir, { recursive: true });
});

const 货转单Result: VlmResult = {
  voucherType: '货转单',
  fields: {
    编号: 'HZ-2024-0715',
    合同号: 'CJXC-CTCL-JY-2024-131-01',
    买方: '山西焦煤集团有限责任公司',
    卖方: '内蒙古伊泰煤炭股份有限公司',
    交货日期: '2024-07-15',
    交货地点: '秦皇岛港',
    交货总量_吨: 5259.54,
    明细行: [
      { 煤种: '低硫主焦煤', 数量_吨: 2629.77, 含税总价_元: 3498909.29 },
      { 煤种: '低硫主焦煤', 数量_吨: 2629.77, 含税总价_元: 1475.88 },
    ],
    合计含税总价_元: 3500385.17,
    日期: '2024-07-15',
  },
  字段置信度: {
    voucherType: 0.99,
    合同号: 0.98,
    买方: 0.97,
    卖方: 0.96,
    交货日期: 0.95,
    交货地点: 0.94,
    交货总量_吨: 0.99,
    合计含税总价_元: 0.99,
  },
};

function fakeVlm(result: VlmResult): VlmDeps {
  return { extract: async () => result };
}

function fakeVlmThrowing(message: string): VlmDeps {
  return {
    extract: async () => {
      throw new Error(message);
    },
  };
}

const execOpts = { messages: [], toolCallId: 't', abortSignal: undefined as any } as any;

function countRows(table: string): number {
  return (ctx.sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

describe('ingest_document 图片凭证 VLM 分支', () => {
  it('货转单图片: document/classification/extraction/chunk 各写一行, 单块嵌入', async () => {
    const f = join(dir, 'huozhuan.jpg');
    writeFileSync(f, Buffer.from('fake-jpeg-bytes'));
    const ingest = buildIngestDocumentTool({ ctx, vlm: fakeVlm(货转单Result) });
    const res = await ingest.execute(
      { sourceUri: f, docType: '其他', modality: 'scanned' },
      execOpts,
    );

    expect(res.docId).toBeDefined();
    expect(res.classifiedDocType).toBe('货转单');
    expect(res.modality).toBe('scanned');
    expect(res.blockCount).toBe(1);
    expect(res.classificationSource).toBe('classified');
    expect(res.classificationConfidence).toBe(0.99);

    expect(countRows('documents')).toBe(1);
    expect(countRows('classifications')).toBe(1);
    expect(countRows('extractions')).toBe(1);
    expect(countRows('doc_chunk')).toBe(1);

    // 向量化: 未注入 embedder -> skipped(mode none), 不失败。
    expect(res.vectorization.status).toBe('skipped');
    expect(res.vectorization.mode).toBe('none');

    // chunk 文本包含拍平的明细行 KV。
    const chunk = ctx.sqlite
      .prepare('SELECT chunk_text AS t FROM doc_chunk WHERE document_id = ?')
      .get(res.docId) as { t: string };
    expect(chunk.t).toContain('合同号:CJXC-CTCL-JY-2024-131-01');
    expect(chunk.t).toContain('明细行1.数量_吨:2629.77');

    // extraction: 字段 + 空 sourceSpans + 保守 overall_confidence。
    const ex = ctx.sqlite
      .prepare('SELECT fields, field_meta, overall_confidence, needs_review FROM extractions WHERE document_id = ?')
      .get(res.docId) as {
      fields: string;
      field_meta: string;
      overall_confidence: number;
      needs_review: number;
    };
    const fields = JSON.parse(ex.fields) as Record<string, { value: unknown; sourceSpans: unknown[] }>;
    expect(fields['合同号'].value).toBe('CJXC-CTCL-JY-2024-131-01');
    expect(fields['合同号'].sourceSpans).toEqual([]);
    const meta = JSON.parse(ex.field_meta) as Record<string, { warnings?: string[] }>;
    expect(meta['_warnings'].warnings).toEqual([]);
    expect(ex.overall_confidence).toBe(0.9); // min(字段置信度, 未覆盖字段默认 0.9)
    expect(ex.needs_review).toBe(0); // 无 warning 且置信度 >= 0.85

    // parse_status = parsed。
    const doc = ctx.sqlite
      .prepare('SELECT parse_status AS s FROM documents WHERE id = ?')
      .get(res.docId) as { s: string };
    expect(doc.s).toBe('parsed');
  });

  it('交叉校验 warning -> needs_review=1', async () => {
    const bad = {
      ...货转单Result,
      fields: { ...货转单Result.fields, 交货总量_吨: 9999.99 },
    };
    const f = join(dir, 'bad.jpg');
    writeFileSync(f, Buffer.from('fake-jpeg-bytes'));
    const ingest = buildIngestDocumentTool({ ctx, vlm: fakeVlm(bad) });
    const res = await ingest.execute(
      { sourceUri: f, docType: '其他', modality: 'scanned' },
      execOpts,
    );
    const ex = ctx.sqlite
      .prepare('SELECT needs_review AS n FROM extractions WHERE document_id = ?')
      .get(res.docId) as { n: number };
    expect(ex.n).toBe(1);
    const meta = ctx.sqlite
      .prepare('SELECT field_meta AS m FROM extractions WHERE document_id = ?')
      .get(res.docId) as { m: string };
    const parsed = JSON.parse(meta.m) as Record<string, { warnings?: string[] }>;
    expect(parsed['_warnings'].warnings.length).toBeGreaterThan(0);
  });

  it('VLM 抛错 -> 抛错且 parse_status=failed(可追溯, 不静默成功)', async () => {
    const f = join(dir, 'fail.jpg');
    writeFileSync(f, Buffer.from('fake-jpeg-bytes'));
    const ingest = buildIngestDocumentTool({ ctx, vlm: fakeVlmThrowing('VLM 未配置，无法解析图片凭证') });
    await expect(
      ingest.execute({ sourceUri: f, docType: '其他', modality: 'scanned' }, execOpts),
    ).rejects.toThrow('VLM 未配置，无法解析图片凭证');

    // 占位行存在且 parse_status=failed。
    const doc = ctx.sqlite
      .prepare('SELECT parse_status AS s FROM documents')
      .get() as { s: string };
    expect(doc.s).toBe('failed');
    // 失败路径不写 classification/extraction/chunk。
    expect(countRows('classifications')).toBe(0);
    expect(countRows('extractions')).toBe(0);
    expect(countRows('doc_chunk')).toBe(0);
  });

  it('zod 校验失败(必填字段缺失) -> 抛错且 parse_status=failed', async () => {
    const bad = {
      ...货转单Result,
      fields: { ...货转单Result.fields, 合同号: undefined },
    };
    const f = join(dir, 'schema-fail.jpg');
    writeFileSync(f, Buffer.from('fake-jpeg-bytes'));
    const ingest = buildIngestDocumentTool({ ctx, vlm: fakeVlm(bad) });
    await expect(
      ingest.execute({ sourceUri: f, docType: '其他', modality: 'scanned' }, execOpts),
    ).rejects.toThrow(/凭证字段校验失败/);
    const doc = ctx.sqlite
      .prepare('SELECT parse_status AS s FROM documents')
      .get() as { s: string };
    expect(doc.s).toBe('failed');
  });

  it('非图片扩展名不走 VLM 分支(仍走文本解析)', async () => {
    const f = join(dir, 'contract.txt');
    writeFileSync(f, '合同号: HT-2024-001\n金额: 2860000', 'utf-8');
    const vlm = fakeVlm(货转单Result);
    const ingest = buildIngestDocumentTool({ ctx, vlm });
    const res = await ingest.execute(
      { sourceUri: f, docType: '合同', modality: 'digital' },
      execOpts,
    );
    expect(res.classifiedDocType).toBe('合同');
    expect(res.modality).toBe('digital');
  });
});