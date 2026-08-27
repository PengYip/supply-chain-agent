import { describe, it, expect, beforeEach } from 'vitest';
import type { ContractLedgerEntry } from '../../src/pipeline/contractLedger.js';
import { createDb, migrate } from '../../src/pipeline/db/client.js';
import {
  createDocumentStub,
  upsertContractLedgerEntry,
  updateDocumentType,
  findContractLedgerByNo,
} from '../../src/pipeline/db/repositories.js';

// Bug C(用户验收): PATCH /api/documents/:docId/type 级联不完整 —— 文档
// 「补充合同」改为「合同」后, contract_ledger 行的 doc_type 仍是旧类型。
// 本文件证明 updateDocumentType 之后:
//   1) 该 document_id 对应的台账行 doc_type 跟随新类型;
//   2) 新类型为 合同 且 台账行 contract_type 为 NULL 且可重派生时, 重派生
//      contract_type(复用 deriveContractType 同一规则);
//   3) 已有 contract_type 的行不被重派生覆盖。

let ctx: ReturnType<typeof createDb>;
beforeEach(() => {
  ctx = createDb(':memory:');
  migrate(ctx.sqlite);
});

/** 构造最小合法台账条目(真 sqlite 存储, 不 mock 存储层)。 */
function ledgerEntry(args: Partial<ContractLedgerEntry> & { documentId: string }): ContractLedgerEntry {
  return {
    contractNo: args.contractNo ?? 'HT-2024-100',
    displayContractNo: args.displayContractNo ?? args.contractNo ?? 'HT-2024-100',
    docType: args.docType ?? '补充合同',
    documentId: args.documentId,
    title: args.title ?? '',
    contractType: args.contractType ?? null,
    fields:
      args.fields ??
      ({ 合同号: { value: 'HT-2024-100', sourceSpans: [] } } as ContractLedgerEntry['fields']),
    fieldMeta: args.fieldMeta ?? {},
    overallConfidence: args.overallConfidence ?? 0.9,
    needsReview: args.needsReview ?? false,
    userId: args.userId ?? 'u1',
  };
}

describe('updateDocumentType -> contract_ledger 级联(Bug C)', () => {
  it('改类型后台账行 doc_type 跟随更新(补充合同 -> 合同)', async () => {
    const { docId } = await createDocumentStub(ctx, {
      sourceUri: 'file:///c.pdf', docType: '补充合同', userId: 'u1',
    });
    await upsertContractLedgerEntry(ctx, ledgerEntry({ documentId: docId }));

    expect(await updateDocumentType(ctx, docId, '合同', 'u1')).toBe(true);

    const row = await findContractLedgerByNo(ctx, 'HT-2024-100', 'u1');
    expect(row).not.toBeNull();
    expect(row!.docType).toBe('合同');
  });

  it('新类型=合同 且 contract_type 为 NULL 且可从字段重派生时重派生 contract_type', async () => {
    const { docId } = await createDocumentStub(ctx, {
      sourceUri: 'file:///c.pdf', docType: '其他', userId: 'u1',
    });
    await upsertContractLedgerEntry(
      ctx,
      ledgerEntry({
        documentId: docId,
        docType: '其他',
        fields: {
          合同号: { value: 'HT-2024-100', sourceSpans: [] },
          合同名称: { value: '煤炭采购合同', sourceSpans: [] },
        } as ContractLedgerEntry['fields'],
      }),
    );

    expect(await updateDocumentType(ctx, docId, '合同', 'u1')).toBe(true);

    const row = await findContractLedgerByNo(ctx, 'HT-2024-100', 'u1');
    expect(row!.docType).toBe('合同');
    // 标题关键词"采购"命中 TRADE_VOCAB.contractTypeKeywords.采购。
    expect(row!.contractType).toBe('采购');
  });

  it('已有 contract_type 的行不被重派生覆盖', async () => {
    const { docId } = await createDocumentStub(ctx, {
      sourceUri: 'file:///c.pdf', docType: '补充合同', userId: 'u1',
    });
    await upsertContractLedgerEntry(
      ctx,
      ledgerEntry({
        documentId: docId,
        contractType: '销售',
        fields: {
          合同号: { value: 'HT-2024-100', sourceSpans: [] },
          合同名称: { value: '煤炭采购合同', sourceSpans: [] },
        } as ContractLedgerEntry['fields'],
      }),
    );

    expect(await updateDocumentType(ctx, docId, '合同', 'u1')).toBe(true);

    const row = await findContractLedgerByNo(ctx, 'HT-2024-100', 'u1');
    expect(row!.docType).toBe('合同');
    expect(row!.contractType).toBe('销售');
  });
});
