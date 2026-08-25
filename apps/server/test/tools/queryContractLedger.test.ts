import { describe, it, expect } from 'vitest';
import { createDb, migrate, type SqliteDbContext } from '../../src/pipeline/db/client.js';
import { buildQueryContractTool } from '../../src/tools/queries.js';
import { buildLedgerEntryFromExtraction } from '../../src/pipeline/contractLedger.js';
import { upsertContractLedgerEntry } from '../../src/pipeline/db/repositories.js';

// 接线闭环: query_contract DB-only builder 测试。

const execOpts = {
  messages: [], toolCallId: 't', abortSignal: undefined as any,
} as any;

function makeCtx(): SqliteDbContext {
  const ctx = createDb(':memory:');
  migrate(ctx.sqlite);
  return ctx;
}

describe('query_contract (ledger-first builder)', () => {
  it('hits the contract ledger when a DbContext is wired (source=ledger, displayContractNo preserved)', async () => {
    const ctx = makeCtx();
    // 用钉死的 contractLedger builder + repositories.upsert 落一条台账。
    const entry = buildLedgerEntryFromExtraction({
      documentId: 'DOC-ledger-1',
      docType: '合同',
      fields: {
        合同号: { value: 'HT-2024-999', sourceSpans: [{ blockId: 'b0', start: 0, end: 11 }] },
        金额: { value: 2860000, sourceSpans: [{ blockId: 'b0', start: 0, end: 5 }] },
      },
      fieldMeta: {
        合同号: { strength: 'exact', confidence: 0.99 },
        金额: { strength: 'exact', confidence: 0.98 },
      },
    });
    expect(entry).not.toBeNull();
    await upsertContractLedgerEntry(ctx, entry!);

    const qc = buildQueryContractTool({ ctx });
    const res = (await qc.execute({ contractNo: 'HT-2024-999' }, execOpts)) as any;

    expect(res).toMatchObject({
      source: 'ledger',
      contractNo: 'HT-2024-999', // displayContractNo 保留原文
      docType: '合同',
      documentId: 'DOC-ledger-1',
      needsReview: false,
    });
    expect(typeof res.overallConfidence).toBe('number');
    // fields 只取 value, 去掉 sourceSpans。
    expect(res.fields).toEqual({ 合同号: 'HT-2024-999', 金额: 2860000 });
    expect(res.notFound).toBeUndefined();
  });

  it('returns notFound when the ledger has no entry', async () => {
    const ctx = makeCtx(); // 台账为空
    const qc = buildQueryContractTool({ ctx });
    const res = (await qc.execute({ contractNo: 'HT-2024-001' }, execOpts)) as any;
    expect(res).toEqual({ notFound: true, contractNo: 'HT-2024-001' });
  });

  it('returns notFound for an unknown contract', async () => {
    const ctx = makeCtx();
    const qc = buildQueryContractTool({ ctx });
    const res = (await qc.execute({ contractNo: 'ZZ-NOPE-999' }, execOpts)) as any;
    expect(res).toEqual({ notFound: true, contractNo: 'ZZ-NOPE-999' });
  });

  it('builder without ctx returns notConfigured', async () => {
    const qc = buildQueryContractTool();
    const res = (await qc.execute({ contractNo: 'HT-2024-001' }, execOpts)) as any;
    expect(res).toEqual({ notConfigured: true });
  });
});
