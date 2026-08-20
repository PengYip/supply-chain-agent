import { describe, it, expect, beforeEach } from 'vitest';
import { createDb, migrate } from '../../src/pipeline/db/client.js';
import {
  createProject, upsertProjectMembership, upsertContractLedgerEntry,
  upsertExecutionFlow, addSelfParty, type ProjectMembershipRow,
} from '../../src/pipeline/db/repositories.js';
import { buildLedgerEntryFromExtraction, type ContractLedgerEntry } from '../../src/pipeline/contractLedger.js';
import { buildRollup, rollupProject } from '../../src/pipeline/projectRollup.js';
import type { ExecutionFlowSummary } from '../../src/pipeline/db/repositories.js';

// 项目维度统计汇总(Task 11, spec 2026-08-20 §5)。buildRollup 是纯函数
// (fixtures 直构), rollupProject 是只读关系库的编排(报表不依赖图)。

const span = { blockId: 'b1', start: 0, end: 4 };

function ledger(contractNo: string, fields: Record<string, string | number>): ContractLedgerEntry {
  const names = Object.keys(fields);
  return buildLedgerEntryFromExtraction({
    documentId: `DOC-${contractNo}`,
    docType: '合同',
    fields: {
      合同号: { value: contractNo, sourceSpans: [span] },
      ...Object.fromEntries(names.map((n) => [n, { value: fields[n], sourceSpans: [span] }])),
    },
    fieldMeta: Object.fromEntries(
      ['合同号', ...names].map((n) => [n, { strength: 'exact' as const, confidence: 0.95 }]),
    ),
  })!;
}

function membership(contractNo: string, role: string | null, status: ProjectMembershipRow['status']): ProjectMembershipRow {
  return {
    id: `PM-${contractNo}`,
    contractNo,
    projectCode: 'PRJ-1',
    role,
    status,
    proposedBy: 'system',
    confirmationSource: null,
    confidence: 0.8,
    createdBy: 'system',
    userId: null,
    createdAt: '2026-08-20T00:00:00.000Z',
    graphStatus: null,
  };
}

function flowSummary(contractNo: string, flowType: string, direction: 'in' | 'out', totalAmount: number | null, totalQuantityTon: number | null = null): ExecutionFlowSummary {
  return {
    contractNo,
    flowType,
    direction,
    entryCount: 1,
    totalAmount,
    totalQuantityTon,
    lastVoucherDate: null,
  };
}

describe('buildRollup (纯函数)', () => {
  const project = { code: 'PRJ-1', name: '一' };
  const selfNames = ['我方贸易'];

  it('指标: 2 销售 + 1 采购 + 1 物流 -> sales/purchase/expense/grossMargin', () => {
    const ledgers = new Map<string, ContractLedgerEntry | null>([
      ['HT-S1', ledger('HT-S1', { 金额: 100 })],
      ['HT-S2', ledger('HT-S2', { 金额: 120 })],
      ['HT-P1', ledger('HT-P1', { 金额: 80 })],
      ['HT-L1', ledger('HT-L1', { 金额: 5 })],
    ]);
    const r = buildRollup({
      project,
      memberships: [
        membership('HT-S1', '销售', 'confirmed'),
        membership('HT-S2', '销售', 'confirmed'),
        membership('HT-P1', '采购', 'confirmed'),
        membership('HT-L1', '物流', 'confirmed'),
        membership('HT-X1', '采购', 'proposed'), // proposed 不进合同面
        membership('HT-X2', '采购', 'rejected'),  // rejected 不进
      ],
      ledgers,
      flowSummaries: [],
      selfPartyNames: selfNames,
    });
    expect(r.metrics.salesAmount).toBe(220);
    expect(r.metrics.purchaseAmount).toBe(80);
    expect(r.metrics.expenseAmount).toBe(5);
    expect(r.metrics.grossMargin).toBe(220 - 80 - 5); // 135
    expect(r.contracts).toHaveLength(4);
    expect(r.pendingMemberships).toEqual([{ contractNo: 'HT-X1', role: '采购' }]);
  });

  it('应收/应付未清: receivable = sales - 发票out - 资金in; payable = purchase - 发票in - 资金out', () => {
    const r = buildRollup({
      project,
      memberships: [
        membership('HT-S1', '销售', 'confirmed'),
        membership('HT-P1', '采购', 'confirmed'),
      ],
      ledgers: new Map([
        ['HT-S1', ledger('HT-S1', { 金额: 220 })],
        ['HT-P1', ledger('HT-P1', { 金额: 80 })],
      ]),
      flowSummaries: [
        flowSummary('HT-S1', '发票流', 'out', 100),   // 已开票 100
        flowSummary('HT-S1', '资金流', 'in', 60),      // 已收款 60
        flowSummary('HT-P1', '发票流', 'in', 50),      // 已收票 50
        flowSummary('HT-P1', '资金流', 'out', 30),     // 已付款 30
        // 多合同同向求和:
        flowSummary('HT-S2', '发票流', 'out', 20),
      ],
      selfPartyNames: selfNames,
    });
    expect(r.flows.发票流).toEqual({ in: 50, out: 120 });
    expect(r.flows.资金流).toEqual({ in: 60, out: 30 });
    expect(r.metrics.receivableOpen).toBe(220 - 120 - 60); // 40
    expect(r.metrics.payableOpen).toBe(80 - 50 - 30);      // 0
  });

  it('货物流走 totalQuantityTon 聚合(inTon/outTon)', () => {
    const r = buildRollup({
      project,
      memberships: [membership('HT-S1', '销售', 'confirmed')],
      ledgers: new Map([['HT-S1', ledger('HT-S1', { 金额: 100 })]]),
      flowSummaries: [
        flowSummary('HT-S1', '货物流', 'out', null, 100),
        flowSummary('HT-S1', '货物流', 'in', null, 100),
        flowSummary('HT-P1', '货物流', 'in', null, 30),
      ],
      selfPartyNames: selfNames,
    });
    expect(r.flows.货物流).toEqual({ inTon: 130, outTon: 100 });
    // 净量 +30 -> qty_gap(info)
    expect(r.checks.some((c) => c.code === 'qty_gap' && c.level === 'info')).toBe(true);
    // 平衡时无 qty_gap
    const balanced = buildRollup({
      project, memberships: [], ledgers: new Map(),
      flowSummaries: [
        flowSummary('HT-S1', '货物流', 'out', null, 100),
        flowSummary('HT-S1', '货物流', 'in', null, 100),
      ],
      selfPartyNames: selfNames,
    });
    expect(balanced.checks.some((c) => c.code === 'qty_gap')).toBe(false);
  });

  it('counterparty: 台账甲方=主体 -> 对手方取乙方', () => {
    const r = buildRollup({
      project,
      memberships: [membership('HT-P1', '采购', 'confirmed')],
      ledgers: new Map([['HT-P1', ledger('HT-P1', { 甲方: '我方贸易', 乙方: '某供应商', 金额: 80 })]]),
      flowSummaries: [],
      selfPartyNames: selfNames,
    });
    expect(r.contracts[0]?.counterparty).toBe('某供应商');
    expect(r.contracts[0]?.role).toBe('采购');
    expect(r.contracts[0]?.amount).toBe(80);
  });

  it('checks: 类型-方向交叉 warn; 台账缺失/金额缺失 amount_missing', () => {
    const mismatch = buildRollup({
      project,
      memberships: [
        membership('HT-S1', '销售', 'confirmed'),
        membership('HT-P1', '采购', 'confirmed'),
      ],
      ledgers: new Map([
        ['HT-S1', ledger('HT-S1', { 金额: 100 })],
        ['HT-P1', ledger('HT-P1', { 金额: 80 })],
      ]),
      flowSummaries: [
        flowSummary('HT-S1', '发票流', 'in', 10),  // 销售合同收进项 -> warn
        flowSummary('HT-P1', '发票流', 'out', 10), // 采购合同开销项 -> warn
      ],
      selfPartyNames: selfNames,
    });
    const mismatches = mismatch.checks.filter((c) => c.code === 'type_direction_mismatch');
    expect(mismatches).toHaveLength(2);
    expect(mismatches.every((c) => c.level === 'warn')).toBe(true);

    const missing = buildRollup({
      project,
      memberships: [
        membership('HT-N1', '采购', 'confirmed'), // 台账缺失
        membership('HT-N2', '采购', 'confirmed'), // 台账在但无金额字段
      ],
      ledgers: new Map([
        ['HT-N1', null],
        ['HT-N2', ledger('HT-N2', {})],
      ]),
      flowSummaries: [],
      selfPartyNames: selfNames,
    });
    const amountMissing = missing.checks.filter((c) => c.code === 'amount_missing');
    expect(amountMissing).toHaveLength(2);
    expect(amountMissing.every((c) => c.level === 'warn')).toBe(true);
  });
});

describe('rollupProject (in-memory 集成)', () => {
  let ctx: ReturnType<typeof createDb>;
  beforeEach(() => {
    ctx = createDb(':memory:');
    migrate(ctx.sqlite);
  });

  it('端到端: 种 project/memberships/台账/流水 -> 指标', async () => {
    await addSelfParty(ctx, '我方贸易', 'u1');
    await createProject(ctx, { code: 'PRJ-1', name: '一', userId: 'u1' });
    await upsertContractLedgerEntry(ctx, ledger('HT-S1', { 甲方: '我方贸易', 乙方: '某钢厂', 金额: 100 }));
    await upsertContractLedgerEntry(ctx, ledger('HT-P1', { 甲方: '我方贸易', 乙方: '某供应商', 金额: 80 }));
    await upsertProjectMembership(ctx, {
      contractNo: 'HT-S1', projectCode: 'PRJ-1', role: '销售', status: 'confirmed',
      proposedBy: 'human', confirmationSource: 'human', createdBy: 'u1',
    }, 'u1');
    await upsertProjectMembership(ctx, {
      contractNo: 'HT-P1', projectCode: 'PRJ-1', role: '采购', status: 'confirmed',
      proposedBy: 'human', confirmationSource: 'human', createdBy: 'u1',
    }, 'u1');
    await upsertProjectMembership(ctx, {
      contractNo: 'HT-X1', projectCode: 'PRJ-1', proposedBy: 'system', createdBy: 'system',
    }, 'u1');
    await upsertExecutionFlow(ctx, {
      bindingId: 'BD-1', documentId: 'D1', contractNo: 'HT-S1', flowType: '发票流',
      direction: 'out', amount: 60, quantityTon: null, docType: '发票',
      voucherDate: null, confidence: 1, createdBy: 'u1',
    }, 'u1');
    await upsertExecutionFlow(ctx, {
      bindingId: 'BD-2', documentId: 'D2', contractNo: 'HT-P1', flowType: '资金流',
      direction: 'out', amount: 40, quantityTon: null, docType: '付款凭证',
      voucherDate: null, confidence: 1, createdBy: 'u1',
    }, 'u1');

    const r = await rollupProject(ctx, 'prj-1', 'u1');
    expect(r).not.toBeNull();
    expect(r?.project).toEqual({ code: 'PRJ-1', name: '一' });
    expect(r?.contracts).toHaveLength(2);
    expect(r?.pendingMemberships).toEqual([{ contractNo: 'HT-X1', role: null }]);
    expect(r?.metrics.salesAmount).toBe(100);
    expect(r?.metrics.purchaseAmount).toBe(80);
    expect(r?.metrics.grossMargin).toBe(20);
    expect(r?.metrics.receivableOpen).toBe(100 - 60 - 0); // 40
    expect(r?.metrics.payableOpen).toBe(80 - 0 - 40);     // 40
    expect(r?.contracts.find((c) => c.contractNo === 'HT-S1')?.counterparty).toBe('某钢厂');
  });

  it('项目不存在 -> null', async () => {
    expect(await rollupProject(ctx, 'PRJ-404', 'u1')).toBeNull();
  });
});
