// 业务视图(2026-09-01 悬空单据治理): unbound_docs 清单 + 合同点查 boundDocuments 摘要。
// 契约:
//   1. 悬空清单只含 已解析+凭证类+无有效绑定 的文档(proposed/confirmed 之一即不算悬空);
//   2. rejected-only 绑定 = 回到悬空;
//   3. uploaded 未解析占位与锚点类型(合同)不进清单;
//   4. query_business(entity="unbound_docs") 返回同一清单;
//   5. 合同点查返回 boundDocuments(confirmed/proposed 计数 + 明细)。
import { describe, it, expect, beforeEach } from 'vitest';
import { createDb, migrate, type SqliteDbContext } from '../../src/pipeline/db/client.js';
import type { DocType } from '../../src/pipeline/types.js';
import {
  createDocumentStub,
  saveBinding,
  listUnboundVoucherDocs,
  upsertContractLedgerEntry,
} from '../../src/pipeline/db/repositories.js';
import { buildQueryBusinessTool } from '../../src/pipeline/tools/queryBusiness.js';
import type { ContractLedgerEntry } from '../../src/pipeline/contractLedger.js';

const execOpts = { messages: [], toolCallId: 't', abortSignal: undefined as any } as any;
const span = { blockId: 'b0', start: 0, end: 11 };

function ledger(contractNo: string): ContractLedgerEntry {
  return {
    contractNo, displayContractNo: contractNo, docType: '合同', documentId: `DOC-${contractNo}`,
    title: '焦炭采购合同', contractType: '采购',
    fields: { 合同号: { value: contractNo, sourceSpans: [span] } },
    fieldMeta: {}, overallConfidence: 1, needsReview: false, userId: '',
  };
}

async function parsedVoucher(ctx: SqliteDbContext, uri: string, docType: DocType): Promise<string> {
  const { docId } = await createDocumentStub(ctx, { sourceUri: uri, docType });
  ctx.sqlite.prepare('UPDATE documents SET parse_status = ? WHERE id = ?').run('parsed', docId);
  return docId;
}

describe('business views: 悬空凭证清单与合同在案单据', () => {
  let ctx: SqliteDbContext;
  beforeEach(() => {
    ctx = createDb(':memory:');
    migrate(ctx.sqlite);
  });

  it('悬空清单: parsed+凭证类+无有效绑定 才入列; uploaded/合同/proposed 不入列', async () => {
    const dangling = await parsedVoucher(ctx, 'file:///lab1.pdf', '质检报告');
    await createDocumentStub(ctx, { sourceUri: 'file:///stub.pdf', docType: '质检报告' }); // uploaded 占位
    await parsedVoucher(ctx, 'file:///contract.pdf', '合同'); // 锚点类型
    const bound = await parsedVoucher(ctx, 'file:///lab2.pdf', '化验报告');
    await saveBinding(ctx, {
      documentId: bound, contractNo: 'HT-1', relation: '质检',
      sourceRefs: [], confidence: 0.8, createdBy: 'system', status: 'proposed', proposedBy: 'system',
    }, '');

    const docs = await listUnboundVoucherDocs(ctx);
    expect(docs.map((d) => d.docId)).toEqual([dangling]);
    expect(docs[0]).toMatchObject({ docType: '质检报告', sourceUri: 'file:///lab1.pdf' });
  });

  it('rejected-only 绑定 = 回到悬空', async () => {
    const doc = await parsedVoucher(ctx, 'file:///lab3.pdf', '质检报告');
    await saveBinding(ctx, {
      documentId: doc, contractNo: 'HT-1', relation: '质检',
      sourceRefs: [], confidence: 0.8, createdBy: 'system', status: 'rejected',
    }, '');
    const docs = await listUnboundVoucherDocs(ctx);
    expect(docs.map((d) => d.docId)).toEqual([doc]);
  });

  it('query_business entity=unbound_docs 返回清单与补绑指引', async () => {
    const dangling = await parsedVoucher(ctx, 'file:///lab4.pdf', '汽运磅单');
    const t = buildQueryBusinessTool({ ctx, userId: '' });
    const r = (await t.execute!({ entity: 'unbound_docs' }, execOpts)) as {
      status: string; count: number; docs: Array<{ docId: string }>; usage: string;
    };
    expect(r.status).toBe('ok');
    expect(r.count).toBe(1);
    expect(r.docs[0]!.docId).toBe(dangling);
    expect(r.usage).toContain('bind_document');
  });

  it('合同点查返回 boundDocuments 摘要(confirmed/proposed 计数+明细)', async () => {
    await upsertContractLedgerEntry(ctx, ledger('HT-9'));
    const d1 = await parsedVoucher(ctx, 'file:///a.pdf', '质检报告');
    const d2 = await parsedVoucher(ctx, 'file:///b.pdf', '化验报告');
    await saveBinding(ctx, {
      documentId: d1, contractNo: 'HT-9', relation: '质检',
      sourceRefs: [], confidence: 1, createdBy: 'agent', status: 'confirmed', confirmationSource: 'human',
    }, '');
    await saveBinding(ctx, {
      documentId: d2, contractNo: 'HT-9', relation: '质检',
      sourceRefs: [], confidence: 0.8, createdBy: 'system', status: 'proposed', proposedBy: 'system',
    }, '');

    const t = buildQueryBusinessTool({ ctx, userId: '' });
    const r = (await t.execute!({ entity: 'contract', contractNo: 'HT-9' }, execOpts)) as {
      source: string; boundDocuments: {
        count: number; confirmed: number; proposed: number;
        docs: Array<{ docId: string; status: string; docType: string }>;
      };
    };
    expect(r.source).toBe('ledger');
    expect(r.boundDocuments.count).toBe(2);
    expect(r.boundDocuments.confirmed).toBe(1);
    expect(r.boundDocuments.proposed).toBe(1);
    expect(r.boundDocuments.docs.map((d) => d.docId).sort()).toEqual([d1, d2].sort());
  });
});
