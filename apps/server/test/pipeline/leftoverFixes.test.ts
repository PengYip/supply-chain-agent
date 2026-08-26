import { describe, it, expect, beforeEach } from 'vitest';
import { createDb, migrate } from '../../src/pipeline/db/client.js';
import { ensureTemplateSeed } from '../../src/pipeline/templateSeed.js';
import { ensureEdgeRule, createDocumentStub, saveExtraction, upsertContractLedgerEntry } from '../../src/pipeline/db/repositories.js';
import { buildBindingCandidates } from '../../src/pipeline/bindingCandidates.js';
import { generateBindingProposals } from '../../src/pipeline/bindingProposal.js';
import type { ContractLedgerEntry } from '../../src/pipeline/contractLedger.js';

const ctx = createDb();
beforeEach(async () => { migrate(ctx.sqlite); await ensureTemplateSeed(ctx); });

function ledger(no: string, fields: ContractLedgerEntry['fields']): ContractLedgerEntry {
  return {
    contractNo: no, displayContractNo: no, docType: '合同', documentId: 'DOC-C', title: '',
    contractType: null,
    fields, fieldMeta: {}, overallConfidence: 1, needsReview: false, userId: 'u1',
  };
}

describe('leftover fixes', () => {
  it('anchorWeights 接线: 规则权重传入 generateBindingProposals', async () => {
    // 给 付款凭证 binds 规则设 anchorWeights(金额权重高)
    await ensureEdgeRule(ctx, {
      id: 'er-bind-fukuan', sourceTypeId: 'dt-付款凭证', edgeType: 'binds',
      allowedVocab: ['付款'], isActive: true, anchorWeights: { party: 0.2, time: 0.1, amount: 0.7, qty: 0 },
    });
    // 直接验证 generateBindingProposals 第三参生效(与 P1 T5 同款断言)
    const anchors = { buyer: 'A公司', seller: 'B公司', date: '2026-01-10', amount: 500 };
    const ledger = [
      { contractNo: 'HT-1', fields: { 买方: { value: 'A公司', sourceSpans: [] }, 卖方: { value: 'B公司', sourceSpans: [] }, 签订日: { value: '2026-01-10', sourceSpans: [] }, 合同金额: { value: 100, sourceSpans: [] } } },
      { contractNo: 'HT-2', fields: { 买方: { value: 'A公司', sourceSpans: [] }, 卖方: { value: 'C公司', sourceSpans: [] }, 签订日: { value: '2025-12-01', sourceSpans: [] }, 合同金额: { value: 500, sourceSpans: [] } } },
    ];
    const r = generateBindingProposals(anchors as never, ledger as never, { party: 0.2, time: 0.1, amount: 0.7, qty: 0 });
    expect(r[0]?.contractNo).toBe('HT-2');
  });

  it('buildBindingCandidates 读规则 anchorWeights(金额权重高 -> HT-2 反超)', async () => {
    // 发票文档 + 抽取行(金额 500) + 台账两合同(HT-1 金额 100 / HT-2 金额 500)。
    // 发票走 buildAnchorsFromFields(读 .value), 避开 extractAnchors 的裸值形状。
    const { docId } = await createDocumentStub(ctx, { sourceUri: 'file:///inv.pdf', docType: '发票' });
    await saveExtraction(ctx, {
      documentId: docId, docType: '发票',
      fields: {
        买方: { value: 'A公司', sourceSpans: [] }, 卖方: { value: 'B公司', sourceSpans: [] },
        金额: { value: 500, sourceSpans: [] }, 日期: { value: '2026-01-10', sourceSpans: [] },
      },
      fieldMeta: {}, overallConfidence: 1, needsReview: false,
    });
    await upsertContractLedgerEntry(ctx, ledger('HT-1', { 甲方: { value: 'A公司', sourceSpans: [] }, 乙方: { value: 'B公司', sourceSpans: [] }, 签订日: { value: '2026-01-10', sourceSpans: [] }, 合同金额: { value: 100, sourceSpans: [] } }), 'u1');
    await upsertContractLedgerEntry(ctx, ledger('HT-2', { 甲方: { value: 'A公司', sourceSpans: [] }, 乙方: { value: 'C公司', sourceSpans: [] }, 签订日: { value: '2025-12-01', sourceSpans: [] }, 合同金额: { value: 500, sourceSpans: [] } }), 'u1');
    // 发票 binds 规则 anchorWeights 金额权重高(最具体命中, 覆盖兜底)
    await ensureEdgeRule(ctx, {
      id: 'er-bind-fapiao-test', sourceTypeId: 'dt-发票', edgeType: 'binds',
      allowedVocab: ['凭证'], isActive: true, anchorWeights: { party: 0.2, time: 0.1, amount: 0.7, qty: 0 },
    });
    const r = await buildBindingCandidates(ctx, docId, 'u1');
    expect(r.candidates[0]?.contractNo).toBe('HT-2');
  });
});