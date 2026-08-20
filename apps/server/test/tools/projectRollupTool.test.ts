import { describe, it, expect } from 'vitest';
import { createDb, migrate, type SqliteDbContext } from '../../src/pipeline/db/client.js';
import { buildProjectRollupTool } from '../../src/tools/queries.js';
import {
  createProject, upsertProjectMembership, upsertContractLedgerEntry,
} from '../../src/pipeline/db/repositories.js';
import { buildLedgerEntryFromExtraction } from '../../src/pipeline/contractLedger.js';

// project_rollup 工具(Task 12, spec 2026-08-20 §5): L1 只读, 台账/流水聚合的
// 模型侧入口。装配照 queryContractLedger.test.ts。

const execOpts = {
  messages: [], toolCallId: 't', abortSignal: undefined as any,
} as any;

function makeCtx(): SqliteDbContext {
  const ctx = createDb(':memory:');
  migrate(ctx.sqlite);
  return ctx;
}

const span = { blockId: 'b0', start: 0, end: 11 };

function ledger(contractNo: string, amount: number) {
  return buildLedgerEntryFromExtraction({
    documentId: `DOC-${contractNo}`,
    docType: '合同',
    fields: {
      合同号: { value: contractNo, sourceSpans: [span] },
      金额: { value: amount, sourceSpans: [span] },
    },
    fieldMeta: {
      合同号: { strength: 'exact' as const, confidence: 0.95 },
      金额: { strength: 'exact' as const, confidence: 0.9 },
    },
  })!;
}

describe('project_rollup tool', () => {
  it('种好数据 -> execute 返回指标与合同摘要', async () => {
    const ctx = makeCtx();
    await createProject(ctx, { code: 'PRJ-1', name: '一', userId: 'u1' });
    await upsertContractLedgerEntry(ctx, ledger('HT-S1', 100));
    await upsertContractLedgerEntry(ctx, ledger('HT-P1', 80));
    await upsertProjectMembership(ctx, {
      contractNo: 'HT-S1', projectCode: 'PRJ-1', role: '销售', status: 'confirmed',
      proposedBy: 'human', confirmationSource: 'human', createdBy: 'u1',
    }, 'u1');
    await upsertProjectMembership(ctx, {
      contractNo: 'HT-P1', projectCode: 'PRJ-1', role: '采购', status: 'confirmed',
      proposedBy: 'human', confirmationSource: 'human', createdBy: 'u1',
    }, 'u1');

    const t = buildProjectRollupTool({ ctx, userId: 'u1' });
    const res = (await t.execute({ projectCode: 'prj-1' }, execOpts)) as any;
    expect(res.project).toEqual({ code: 'PRJ-1', name: '一' });
    expect(res.contractCount).toBe(2);
    expect(res.pendingCount).toBe(0);
    expect(res.contracts.map((c: { contractNo: string }) => c.contractNo).sort()).toEqual(['HT-P1', 'HT-S1']);
    expect(res.metrics.salesAmount).toBe(100);
    expect(res.metrics.purchaseAmount).toBe(80);
    expect(res.metrics.grossMargin).toBe(20);
    expect(res.flows).toEqual({
      资金流: { in: 0, out: 0 },
      发票流: { in: 0, out: 0 },
      货物流: { inTon: 0, outTon: 0 },
    });
    expect(Array.isArray(res.checks)).toBe(true);
  });

  it('项目不存在 -> notFound', async () => {
    const ctx = makeCtx();
    const t = buildProjectRollupTool({ ctx, userId: 'u1' });
    const res = (await t.execute({ projectCode: 'PRJ-404' }, execOpts)) as any;
    expect(res).toEqual({ notFound: true, projectCode: 'PRJ-404' });
  });

  it('不传 deps -> notConfigured', async () => {
    const t = buildProjectRollupTool();
    const res = (await t.execute({ projectCode: 'PRJ-1' }, execOpts)) as any;
    expect(res).toEqual({ notConfigured: true });
  });
});
