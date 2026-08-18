import { describe, it, expect, beforeEach } from 'vitest';
import { createDb, migrate, type DbContext } from '../../src/pipeline/db/client.js';
import {
  createDocumentStub, saveExtraction, upsertContractLedgerEntry, saveBinding,
} from '../../src/pipeline/db/repositories.js';
import { buildBindingCandidates } from '../../src/pipeline/bindingCandidates.js';
import type { ContractLedgerEntry } from '../../src/pipeline/contractLedger.js';

let ctx: DbContext;
beforeEach(() => { ctx = createDb(':memory:'); migrate(ctx.sqlite); });

function ledger(no: string, fields: ContractLedgerEntry['fields']): ContractLedgerEntry {
  return {
    contractNo: no, displayContractNo: no, docType: '合同', documentId: 'DOC-C', title: '',
    fields, fieldMeta: {}, overallConfidence: 1, needsReview: false, userId: 'u1',
  };
}

describe('buildBindingCandidates', () => {
  it('无抽取 -> hasExtraction=false', async () => {
    await createDocumentStub(ctx, { sourceUri: 'file:///a.pdf', docType: '发票' });
    const r = await buildBindingCandidates(ctx, 'DOC-1', 'u1');
    expect(r.hasExtraction).toBe(false);
    expect(r.candidates).toEqual([]);
  });

  it('发票(通用锚点): 合同号精确命中 -> auto_rule 0.99 头名候选', async () => {
    const { docId } = await createDocumentStub(ctx, { sourceUri: 'file:///inv.pdf', docType: '发票' });
    await saveExtraction(ctx, {
      documentId: docId, docType: '发票',
      fields: { 合同号: { value: 'HT-A', sourceSpans: [] }, 买方: { value: '甲公司', sourceSpans: [] } },
      fieldMeta: {}, overallConfidence: 1, needsReview: false,
    });
    await upsertContractLedgerEntry(ctx, ledger('HT-A', { 甲方: { value: '甲公司', sourceSpans: [] } }), 'u1');
    const r = await buildBindingCandidates(ctx, docId, 'u1');
    expect(r.hasExtraction).toBe(true);
    expect(r.candidates[0]?.route).toBe('auto_rule');
    expect(r.candidates[0]?.score).toBe(0.99);
    expect(r.candidates[0]?.ledger?.contractNo).toBe('HT-A');
  });

  it('已落库的 proposed 行 -> existingBindingId 指向它', async () => {
    const { docId } = await createDocumentStub(ctx, { sourceUri: 'file:///v.pdf', docType: '发票' });
    await saveExtraction(ctx, {
      documentId: docId, docType: '发票',
      fields: { 合同号: { value: 'HT-B', sourceSpans: [] } },
      fieldMeta: {}, overallConfidence: 1, needsReview: false,
    });
    await upsertContractLedgerEntry(ctx, ledger('HT-B', {}), 'u1');
    const bindingId = await saveBinding(ctx, {
      documentId: docId, contractNo: 'HT-B', relation: '凭证',
      sourceRefs: [], confidence: 0.99, createdBy: 'system',
      status: 'proposed', proposedBy: 'system', evidence: null,
    }, 'u1');
    const r = await buildBindingCandidates(ctx, docId, 'u1');
    expect(r.candidates.find((c) => c.contractNo === 'HT-B')?.existingBindingId).toBe(bindingId);
  });

  it('无锚点字段 -> candidates 空, anchors 空(前端提示手动绑定)', async () => {
    const { docId } = await createDocumentStub(ctx, { sourceUri: 'file:///c.pdf', docType: '其他' });
    await saveExtraction(ctx, {
      documentId: docId, docType: '其他',
      fields: { 备注: { value: 'x', sourceSpans: [] } },
      fieldMeta: {}, overallConfidence: 1, needsReview: false,
    });
    const r = await buildBindingCandidates(ctx, docId, 'u1');
    expect(r.anchors).toEqual({});
    expect(r.candidates).toEqual([]);
  });
});
