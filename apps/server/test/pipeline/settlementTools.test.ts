import { describe, it, expect, beforeEach } from 'vitest';
import { createDb, migrate, type SqliteDbContext } from '../../src/pipeline/db/client.js';
import {
  createDocumentStub, saveExtraction, saveBinding, upsertContractLedgerEntry, upsertExecutionFlow,
} from '../../src/pipeline/db/repositories.js';
import type { ContractLedgerEntry } from '../../src/pipeline/contractLedger.js';
import {
  buildGatherSettlementEvidenceTool, buildConfirmSettlementTool,
} from '../../src/pipeline/tools/settlementTools.js';

// 结算工具对(spec 2026-08-27 §15): gather 只读取证 + confirm(L2) 落台账。
const execOpts = { messages: [], toolCallId: 't', abortSignal: undefined as any } as any;

function makeCtx(): SqliteDbContext {
  const ctx = createDb(':memory:');
  migrate(ctx.sqlite);
  return ctx;
}

const span = { blockId: 'b0', start: 0, end: 11 };

function ledger(contractNo: string): ContractLedgerEntry {
  return {
    contractNo, displayContractNo: contractNo, docType: '合同', documentId: `DOC-${contractNo}`,
    title: '焦炭采购合同', contractType: '采购',
    fields: {
      合同号: { value: contractNo, sourceSpans: [span] },
      数量: { value: 3357.46, sourceSpans: [span] },
      单位: { value: '吨', sourceSpans: [span] },
      金额: { value: 2853841, sourceSpans: [span] },
    },
    fieldMeta: {}, overallConfidence: 1, needsReview: false, userId: '',
  };
}

async function seedMassFlow(
  ctx: SqliteDbContext, docId: string, docType: string, canonical: number, contractNo = 'HT-1',
): Promise<string> {
  return upsertExecutionFlow(ctx, {
    bindingId: `BD-${docId}`, documentId: docId, contractNo,
    flowType: '货物流', direction: 'in', amount: null, quantityTon: canonical / 1000,
    unit: '吨', quantityValue: canonical / 1000, quantityDimension: 'mass',
    quantityCanonical: canonical, docType, voucherDate: '2025-03-21',
    confidence: 0.99, createdBy: 'agent',
  });
}

let ctx: SqliteDbContext;
beforeEach(() => {
  ctx = makeCtx();
});

describe('gather_settlement_evidence', () => {
  it('取齐: 合同字段 + 流水(含 docType) + 节点聚合进度 + 质量凭证 + usage 提示', async () => {
    await upsertContractLedgerEntry(ctx, ledger('HT-1'));
    const noticeDoc = await createDocumentStub(ctx, { sourceUri: 'file:///fh.pdf', docType: '发货单' });
    const weighDoc = await createDocumentStub(ctx, { sourceUri: 'file:///gdc.pdf', docType: '轨道衡称重单' });
    await seedMassFlow(ctx, noticeDoc.docId, '发货单', 3357460);
    const weighFlowId = await seedMassFlow(ctx, weighDoc.docId, '轨道衡称重单', 3357460);

    // 质量凭证: 化验报告抽取行 + confirmed 绑定。
    const labDoc = await createDocumentStub(ctx, { sourceUri: 'file:///lab.pdf', docType: '质检报告' });
    const extId = await saveExtraction(ctx, {
      documentId: labDoc.docId, docType: '化验报告',
      fields: { 全水: { value: 9.8, sourceSpans: [span] }, 灰分: { value: 10.2, sourceSpans: [span] } },
      fieldMeta: {}, overallConfidence: 0.98, needsReview: false,
    });
    await saveBinding(ctx, {
      documentId: labDoc.docId, contractNo: 'HT-1', relation: '质检',
      sourceRefs: [], confidence: 1, createdBy: 'agent', status: 'confirmed',
      confirmationSource: 'human',
    }, '');

    const t = buildGatherSettlementEvidenceTool({ ctx, userId: '' });
    const r = (await t.execute!({ contractNo: 'HT-1' }, execOpts)) as any;

    expect(r.status).toBe('ok');
    expect(r.contract.fields.数量.value).toBe(3357.46);
    expect(r.flows).toHaveLength(2);
    expect(r.flows.map((f: any) => f.docType).sort()).toEqual(['发货单', '轨道衡称重单']);
    // 节点权威: 预告+实重同批不双计。
    expect(r.executionProgress.delivered.massKg).toBe(3357460);
    expect(r.executionProgress.delivered.nodes.actualMassKg).toBe(3357460);
    // 质量凭证带抽取溯源。
    expect(r.qualityDocs).toHaveLength(1);
    expect(r.qualityDocs[0]).toMatchObject({ documentId: labDoc.docId, extractionId: extId, docType: '化验报告' });
    expect(r.qualityDocs[0].fields.全水.value).toBe(9.8);
    expect(r.usage).toContain('executionProgress');
    void weighFlowId;
  });

  it('无台账 -> contract null 但流水/进度照常返回(取证不被阻断)', async () => {
    const doc = await createDocumentStub(ctx, { sourceUri: 'file:///fh.pdf', docType: '发货单' });
    await seedMassFlow(ctx, doc.docId, '发货单', 1000000, 'HT-404');
    const t = buildGatherSettlementEvidenceTool({ ctx });
    const r = (await t.execute!({ contractNo: 'HT-404' }, execOpts)) as any;
    expect(r.contract).toBeNull();
    expect(r.executionProgress.delivered.massKg).toBe(1000000);
  });
});

describe('confirm_settlement(L2, 落 settlement_records)', () => {
  it('确认路径: 校验依据流水归属 -> 落台账, 返回 record', async () => {
    await upsertContractLedgerEntry(ctx, ledger('HT-1'));
    const doc = await createDocumentStub(ctx, { sourceUri: 'file:///gdc.pdf', docType: '轨道衡称重单' });
    const flowId = await seedMassFlow(ctx, doc.docId, '轨道衡称重单', 3357460);

    const t = buildConfirmSettlementTool({ ctx, userId: '' });
    const r = (await t.execute!({
      contractNo: 'HT-1',
      settledQuantity: 3357.46,
      quantityUnit: '吨',
      basePrice: 850,
      currency: 'CNY',
      totalAmount: 2853841,
      adjustments: [{ label: '水分扣重', amount: -1234.5 }],
      basisFlowIds: [flowId],
      basisExtractionIds: [],
      notes: '按 3 月轨道衡实重',
    }, execOpts)) as any;

    expect(r.status).toBe('ok');
    expect(r.record.status).toBe('confirmed');
    const { listSettlementRecords } = await import('../../src/pipeline/db/repositories.js');
    const rows = await listSettlementRecords(ctx, 'HT-1');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.settledQuantity).toBe(3357.46);
    expect(rows[0]!.basisFlowIds).toEqual([flowId]);
    expect(rows[0]!.adjustments).toEqual([{ label: '水分扣重', amount: -1234.5 }]);
  });

  it('无台账 -> error(结算必须挂在已有合同上)', async () => {
    const t = buildConfirmSettlementTool({ ctx });
    const r = (await t.execute!({
      contractNo: 'HT-404', settledQuantity: 1, quantityUnit: '吨', basePrice: null,
      currency: null, totalAmount: 1, adjustments: [], basisFlowIds: [], basisExtractionIds: [], notes: null,
    }, execOpts)) as any;
    expect(r.status).toBe('error');
    expect(r.error).toContain('HT-404');
  });

  it('basisFlowIds 跨合同张冠李戴 -> error', async () => {
    await upsertContractLedgerEntry(ctx, ledger('HT-1'));
    const other = await createDocumentStub(ctx, { sourceUri: 'file:///x.pdf', docType: '收货单' });
    const foreignFlowId = await upsertExecutionFlow(ctx, {
      bindingId: `BD-${other.docId}`, documentId: other.docId, contractNo: 'HT-OTHER',
      flowType: '货物流', direction: 'in', amount: null, quantityTon: 1,
      quantityValue: 1, quantityDimension: 'mass', quantityCanonical: 1000,
      docType: '收货单', voucherDate: null, confidence: 1, createdBy: 'agent',
    });
    const t = buildConfirmSettlementTool({ ctx });
    const r = (await t.execute!({
      contractNo: 'HT-1', settledQuantity: 1, quantityUnit: '吨', basePrice: null,
      currency: null, totalAmount: 1, adjustments: [], basisFlowIds: [foreignFlowId],
      basisExtractionIds: [], notes: null,
    }, execOpts)) as any;
    expect(r.status).toBe('error');
    expect(r.error).toContain(foreignFlowId);
  });
});
