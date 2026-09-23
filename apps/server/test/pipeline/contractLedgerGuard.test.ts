// apps/server/test/pipeline/contractLedgerGuard.test.ts
// 台账 upsert 合同族守卫(2026-09-23 数据治理): 凭证类单据(货转单/磅单...)带
// 合同号仍建行(锚点), 但不得覆盖既有合同族行的 doc_type/fields/title——
// 否则后录入的运单会把真合同口径整体 clobber(dev 实测 5 行被污染)。
import { describe, it, expect, beforeEach } from 'vitest';
import { createDb, migrate, type DbContext } from '../../src/pipeline/db/client.js';
import { upsertContractLedgerEntry } from '../../src/pipeline/db/repositories.js';
import type { ContractLedgerEntry } from '../../src/pipeline/contractLedger.js';
import type { SourceSpan } from '../../src/pipeline/types.js';
import type { SpanMatchStrength } from '../../src/pipeline/spanValidator.js';

let ctx: DbContext;
beforeEach(() => {
  ctx = createDb(':memory:');
  migrate(ctx.sqlite);
});

const row = (over: Partial<ContractLedgerEntry>): ContractLedgerEntry => ({
  contractNo: 'HT-G1',
  displayContractNo: 'HT-G1',
  docType: '合同',
  documentId: 'DOC-C',
  title: '煤炭买卖合同',
  contractType: '采购',
  fields: {
    合同号: { value: 'HT-G1', sourceSpans: [] as SourceSpan[] },
    合同名称: { value: '煤炭买卖合同', sourceSpans: [] },
    买方: { value: '本公司', sourceSpans: [] },
  },
  fieldMeta: {
    合同号: { strength: 'exact' as SpanMatchStrength, confidence: 1 },
    合同名称: { strength: 'exact' as SpanMatchStrength, confidence: 1 },
    买方: { strength: 'exact' as SpanMatchStrength, confidence: 1 },
  },
  overallConfidence: 1,
  needsReview: false,
  userId: 'u1',
  ...over,
});

const readLedger = (contractNo: string) =>
  ctx.sqlite.prepare(
    'SELECT doc_type, document_id, title, contract_type, fields FROM contract_ledger WHERE contract_no = ?',
  ).get(contractNo) as { doc_type: string; document_id: string; title: string; contract_type: string | null; fields: string };

describe('upsertContractLedgerEntry: 合同族守卫', () => {
  it('凭证 upsert 不覆盖既有合同族行(doc_type/fields/title 保持合同口径)', async () => {
    await upsertContractLedgerEntry(ctx, row({}), 'u1');
    await upsertContractLedgerEntry(ctx, row({
      docType: '货转单',
      documentId: 'DOC-W',
      title: '',
      contractType: null,
      fields: { 合同号: { value: 'HT-G1', sourceSpans: [] } },
    }), 'u1');
    const r = readLedger('HT-G1');
    expect(r.doc_type).toBe('合同');
    expect(r.document_id).toBe('DOC-C');
    expect(r.title).toBe('煤炭买卖合同');
    expect(JSON.parse(r.fields)['买方']).toBeDefined();
  });

  it('合同 upsert 覆盖凭证行(凭证先建行, 合同单据后到 => 修复转化为合同口径)', async () => {
    await upsertContractLedgerEntry(ctx, row({
      docType: '货转单',
      documentId: 'DOC-W',
      title: '',
      contractType: null,
      fields: { 合同号: { value: 'HT-G1', sourceSpans: [] } },
    }), 'u1');
    await upsertContractLedgerEntry(ctx, row({}), 'u1');
    const r = readLedger('HT-G1');
    expect(r.doc_type).toBe('合同');
    expect(r.document_id).toBe('DOC-C');
    expect(r.title).toBe('煤炭买卖合同');
  });

  it('凭证 -> 凭证 仍可刷新(凭证-only 行的既有 upsert 语义不变)', async () => {
    await upsertContractLedgerEntry(ctx, row({
      docType: '货转单', documentId: 'DOC-W1', title: '', contractType: null,
      fields: { 合同号: { value: 'HT-G1', sourceSpans: [] } },
    }), 'u1');
    await upsertContractLedgerEntry(ctx, row({
      docType: '汽运磅单', documentId: 'DOC-W2', title: '', contractType: null,
      fields: { 合同号: { value: 'HT-G1', sourceSpans: [] } },
    }), 'u1');
    const r = readLedger('HT-G1');
    expect(r.doc_type).toBe('汽运磅单');
    expect(r.document_id).toBe('DOC-W2');
  });

  it('合同 -> 合同 仍可刷新(同合同重抽取就地更新)', async () => {
    await upsertContractLedgerEntry(ctx, row({}), 'u1');
    await upsertContractLedgerEntry(ctx, row({ title: '煤炭买卖合同（修订）' }), 'u1');
    expect(readLedger('HT-G1').title).toBe('煤炭买卖合同（修订）');
  });
});
