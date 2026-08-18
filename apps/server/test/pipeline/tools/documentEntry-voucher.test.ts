// documentEntry 图片凭证 VLM 分支集成测试 (Phase A)。
// 注入 fake VLM deps(不依赖真实 VLM 配置), 断言 document/classification/
// extraction/chunk 各写一行、needs_review 路由、VLM 抛错时 parse_status 失败。

import { describe, it, expect, beforeEach } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createDb, migrate } from '../../../src/pipeline/db/client.js';
import { env } from '../../../src/env.js';
import {
  buildIngestDocumentTool, buildBindDocumentTool, type VlmDeps,
} from '../../../src/pipeline/tools/documentEntry.js';
import type { VlmResult } from '../../../src/pipeline/vlmAdapter.js';
import { buildLedgerEntryFromExtraction } from '../../../src/pipeline/contractLedger.js';
import { upsertContractLedgerEntry } from '../../../src/pipeline/db/repositories.js';
import type { ContractLedgerEntry } from '../../../src/pipeline/contractLedger.js';

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

// ---- Phase B: 绑定建议生成 + 确认 -------------------------------------------

const span = { blockId: 'b1', start: 0, end: 10 };

/** 通过 buildLedgerEntryFromExtraction + upsert 落一条合同台账(真实写入路径)。 */
async function seedLedger(contractNo: string, fields: Record<string, string | number>): Promise<void> {
  const entry = buildLedgerEntryFromExtraction({
    documentId: 'DOC-LEDGER',
    docType: '合同',
    fields: Object.fromEntries(
      Object.entries(fields).map(([k, v]) => [k, { value: v, sourceSpans: [span] }]),
    ) as ContractLedgerEntry['fields'],
    fieldMeta: Object.fromEntries(
      Object.keys(fields).map((k) => [k, { strength: 'exact' as const, confidence: 0.95 }]),
    ),
  });
  if (!entry) throw new Error('seedLedger: 无效合同号');
  await upsertContractLedgerEntry(ctx, entry, '');
}

function bindingRow(bindingId: string): { status: string; confirmation_source: string | null; proposed_by: string | null } {
  return ctx.sqlite
    .prepare('SELECT status, confirmation_source, proposed_by FROM bindings WHERE id = ?')
    .get(bindingId) as { status: string; confirmation_source: string | null; proposed_by: string | null };
}

describe('Phase B: ingestVoucherImage 绑定建议', () => {
  it('货转单自带合同号命中台账 -> binding confirmed/auto_rule + 返回值带建议', async () => {
    await seedLedger('CJXC-CTCL-JY-2024-131-01', {
      合同号: 'CJXC-CTCL-JY-2024-131-01',
      甲方: '山西焦煤集团有限责任公司',
      乙方: '内蒙古伊泰煤炭股份有限公司',
      签订日: '2024-06-01',
      金额: 3500000,
      数量: 5259,
    });
    const f = join(dir, 'hz.jpg');
    writeFileSync(f, Buffer.from('fake-jpeg-bytes'));
    const ingest = buildIngestDocumentTool({ ctx, vlm: fakeVlm(货转单Result) });
    const res = await ingest.execute(
      { sourceUri: f, docType: '其他', modality: 'scanned' },
      execOpts,
    );

    expect(res.bindingProposals).toHaveLength(1);
    expect(res.bindingProposals[0]!.route).toBe('auto_rule');
    expect(res.bindingProposals[0]!.contractNo).toBe('CJXC-CTCL-JY-2024-131-01');
    expect(res.bindingProposals[0]!.score).toBe(0.99);

    const row = ctx.sqlite
      .prepare('SELECT id AS id FROM bindings')
      .get() as { id: string };
    const b = bindingRow(row.id);
    expect(b.status).toBe('confirmed');
    expect(b.confirmation_source).toBe('auto_rule');
    expect(b.proposed_by).toBe('system');
    // evidence 落库(JSON)。
    const ev = ctx.sqlite
      .prepare('SELECT evidence AS e FROM bindings WHERE id = ?')
      .get(row.id) as { e: string };
    expect(JSON.parse(ev.e)).toHaveProperty('details');
  });

  it('付款凭证(无合同号, 主体+时间窗命中) -> binding status=proposed', async () => {
    await seedLedger('HT-2024-001', {
      合同号: 'HT-2024-001',
      甲方: '山西焦煤集团有限责任公司',
      乙方: '内蒙古伊泰煤炭股份有限公司',
      签订日: '2024-06-01',
      交货日期: '2024-07-20',
      金额: 2800000,
      数量: 5200,
    });
    const 付款凭证Result: VlmResult = {
      voucherType: '付款凭证',
      fields: {
        付款人名称: '山西焦煤集团有限责任公司',
        收款人名称: '内蒙古伊泰煤炭股份有限公司',
        金额: 2841620.27,
        金额大写: '贰佰捌拾肆万壹仟陆佰贰拾元零贰角柒分',
        入账日期: '2024-07-16',
      },
      字段置信度: {
        voucherType: 0.99,
        付款人名称: 0.98,
        收款人名称: 0.97,
        金额: 0.99,
        入账日期: 0.95,
      },
    };
    const f = join(dir, 'pay.jpg');
    writeFileSync(f, Buffer.from('fake-jpeg-bytes'));
    const ingest = buildIngestDocumentTool({ ctx, vlm: fakeVlm(付款凭证Result) });
    const res = await ingest.execute(
      { sourceUri: f, docType: '其他', modality: 'scanned' },
      execOpts,
    );

    expect(res.bindingProposals).toHaveLength(1);
    expect(res.bindingProposals[0]!.route).toBe('human');
    expect(res.bindingProposals[0]!.contractNo).toBe('HT-2024-001');

    const row = ctx.sqlite
      .prepare('SELECT id AS id, relation AS relation FROM bindings')
      .get() as { id: string; relation: string };
    expect(row.relation).toBe('付款');
    const b = bindingRow(row.id);
    expect(b.status).toBe('proposed');
    expect(b.confirmation_source).toBeNull();
    expect(b.proposed_by).toBe('system');
  });

  it('弱锚点(无匹配) -> 不落 binding 行', async () => {
    await seedLedger('HT-2024-001', {
      合同号: 'HT-2024-001',
      甲方: '山西焦煤集团有限责任公司',
      乙方: '内蒙古伊泰煤炭股份有限公司',
    });
    const weak: VlmResult = {
      voucherType: '付款凭证',
      fields: {
        付款人名称: '未知公司XYZ',
        收款人名称: '另一未知公司',
        金额: 123.45,
        入账日期: '2024-07-16',
      },
      字段置信度: { voucherType: 0.9, 付款人名称: 0.8, 收款人名称: 0.8, 金额: 0.9, 入账日期: 0.9 },
    };
    const f = join(dir, 'weak.jpg');
    writeFileSync(f, Buffer.from('fake-jpeg-bytes'));
    const ingest = buildIngestDocumentTool({ ctx, vlm: fakeVlm(weak) });
    const res = await ingest.execute(
      { sourceUri: f, docType: '其他', modality: 'scanned' },
      execOpts,
    );
    expect(res.bindingProposals).toEqual([]);
    expect(countRows('bindings')).toBe(0);
  });

  it('bind_document 确认 proposed 建议 -> 翻转 confirmed/human, 不插新行', async () => {
    await seedLedger('HT-2024-001', {
      合同号: 'HT-2024-001',
      甲方: '山西焦煤集团有限责任公司',
      乙方: '内蒙古伊泰煤炭股份有限公司',
      签订日: '2024-06-01',
      交货日期: '2024-07-20',
      金额: 2800000,
      数量: 5200,
    });
    const 付款凭证Result: VlmResult = {
      voucherType: '付款凭证',
      fields: {
        付款人名称: '山西焦煤集团有限责任公司',
        收款人名称: '内蒙古伊泰煤炭股份有限公司',
        金额: 2841620.27,
        入账日期: '2024-07-16',
      },
      字段置信度: { voucherType: 0.99, 付款人名称: 0.98, 收款人名称: 0.97, 金额: 0.99, 入账日期: 0.95 },
    };
    const f = join(dir, 'pay2.jpg');
    writeFileSync(f, Buffer.from('fake-jpeg-bytes'));
    const ingest = buildIngestDocumentTool({ ctx, vlm: fakeVlm(付款凭证Result) });
    const ing: any = await ingest.execute(
      { sourceUri: f, docType: '其他', modality: 'scanned' },
      execOpts,
    );

    const bind = buildBindDocumentTool({ ctx });
    const res = await bind.execute(
      { documentId: ing.docId, contractNo: 'HT-2024-001', relation: 'primary', confidence: 1, sourceSpan: span },
      execOpts,
    );
    expect(res.ok).toBe(true);
    expect(res.confirmedProposal).toBe(true);
    expect(countRows('bindings')).toBe(1); // upsert: 不插新行
    const b = bindingRow(res.bindingId);
    expect(b.status).toBe('confirmed');
    expect(b.confirmation_source).toBe('human');
  });
});