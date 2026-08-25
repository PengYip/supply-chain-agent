import { describe, it, expect, beforeEach } from 'vitest';
import { createDb, migrate } from '../../src/pipeline/db/client.js';
import {
  createProject, upsertProjectMembership, upsertContractLedgerEntry,
  saveQuota, findQuotaById,
} from '../../src/pipeline/db/repositories.js';
import { buildLedgerEntryFromExtraction, type ContractLedgerEntry } from '../../src/pipeline/contractLedger.js';
import {
  reconcileAll, reconcileQuotaOne, type ReconcileGraphIo,
} from '../../src/pipeline/reconciliation.js';

// 对账桥(spec 2026-08-25 方案A §5): R1 数量守恒/R2 开票收付/R3 额度占用。
// 全部在关系库精确聚合; 图只接收物化回写(io 注入, 单测无需 Neo4j)。

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

function makeIo() {
  const quotaWrites: Array<{ quotaId: string; used: number; remaining: number; overLimit: boolean }> = [];
  const projectWrites: Array<{ projectCode: string; grossMargin: number; quantityGap: number; receivableOpen: number; payableOpen: number }> = [];
  const io: ReconcileGraphIo = {
    writeQuotaUsage: async (i) => { quotaWrites.push(i); },
    writeProjectRollup: async (i) => { projectWrites.push(i); },
  };
  return { io, quotaWrites, projectWrites };
}

let ctx: ReturnType<typeof createDb>;
const OWNER = '中石化股份有限公司';

async function seedWorld() {
  // 台账: S1 我方卖OWNER(销售向), P1 OWNER卖我方(采购向), O1 与OWNER无关,
  // D1 OWNER 在甲方但金额缺失 -> 跳过。
  await upsertContractLedgerEntry(ctx, ledger('HT-S1', { 甲方: '我方贸易', 乙方: OWNER, 金额: 100 }));
  await upsertContractLedgerEntry(ctx, ledger('HT-P1', { 甲方: OWNER, 乙方: '我方贸易', 金额: 50 }));
  await upsertContractLedgerEntry(ctx, ledger('HT-O1', { 甲方: '别家公司', 乙方: '第三方公司', 金额: 999 }));
  await upsertContractLedgerEntry(ctx, ledger('HT-D1', { 甲方: OWNER, 乙方: '我方贸易' }));
  // 项目: 两张 confirmed membership。
  await createProject(ctx, { code: 'PRJ-1', name: '一号项目' });
  await upsertProjectMembership(ctx, { contractNo: 'HT-S1', projectCode: 'PRJ-1', role: '销售', status: 'confirmed', createdBy: 't' });
  await upsertProjectMembership(ctx, { contractNo: 'HT-P1', projectCode: 'PRJ-1', role: '采购', status: 'confirmed', createdBy: 't' });
}

beforeEach(() => {
  ctx = createDb(':memory:');
  migrate(ctx.sqlite);
});

describe('reconcileAll', () => {
  it('R3: 对手方占用=台账买/卖任一侧命中求和(缺金额跳过), 超限告警+物化回写', async () => {
    await seedWorld();
    const overId = await saveQuota(ctx, { scope: 'counterparty', ownerKey: OWNER, ownerLabel: '中石化', limitAmount: 100, createdBy: 't' });
    const okId = await saveQuota(ctx, { scope: 'counterparty', ownerKey: '别家公司', limitAmount: 2000, createdBy: 't' });
    const { io, quotaWrites } = makeIo();

    const report = await reconcileAll(ctx, undefined, io);

    const over = report.quotas.find((q) => q.quotaId === overId)!;
    expect(over.used).toBe(150); // S1(100) + P1(50); D1 无金额跳过
    expect(over.remaining).toBe(-50);
    expect(over.overLimit).toBe(true);
    const ok = report.quotas.find((q) => q.quotaId === okId)!;
    expect(ok.used).toBe(999);
    expect(ok.overLimit).toBe(false);

    expect(report.alerts.some((a) => a.code === 'quota_over_limit' && a.level === 'warn' && a.message.includes('中石化'))).toBe(true);
    // DB 物化
    const persisted = await findQuotaById(ctx, overId);
    expect(persisted?.usedAmount).toBe(150);
    expect(persisted?.computedAt).toBeTruthy();
    // io 回写
    expect(quotaWrites).toContainEqual({ quotaId: overId, used: 150, remaining: -50, overLimit: true });
  });

  it('R3: 项目限额=confirmed membership 台账金额求和; R1/R2 项目行校验与图回写', async () => {
    await seedWorld();
    const qId = await saveQuota(ctx, { scope: 'project', ownerKey: 'PRJ-1', ownerLabel: '一号项目', limitAmount: 120, createdBy: 't' });
    const { io, quotaWrites, projectWrites } = makeIo();

    const report = await reconcileAll(ctx, undefined, io);

    const q = report.quotas.find((x) => x.quotaId === qId)!;
    expect(q.used).toBe(150); // 100 + 50
    expect(q.overLimit).toBe(true);

    const prj = report.projects.find((p) => p.code === 'PRJ-1')!;
    expect(prj.grossMargin).toBe(50); // 100 - 50
    expect(prj.quantityGap).toBe(0);
    expect(prj.receivableOpen).toBe(100); // 无资金/发票流水
    expect(prj.payableOpen).toBe(50);
    const codes = prj.checks.map((c) => c.code);
    expect(codes).toContain('receivable_open');
    expect(codes).toContain('payable_open');

    expect(quotaWrites).toContainEqual({ quotaId: qId, used: 150, remaining: -30, overLimit: true });
    expect(projectWrites).toContainEqual(expect.objectContaining({ projectCode: 'PRJ-1', grossMargin: 50, receivableOpen: 100, payableOpen: 50 }));
  });

  it('空库: quotas=[] projects=[] alerts=[] 不抛', async () => {
    const { io } = makeIo();
    const report = await reconcileAll(ctx, undefined, io);
    expect(report.quotas).toEqual([]);
    expect(report.projects).toEqual([]);
    expect(report.alerts).toEqual([]);
    expect(report.generatedAt).toBeTruthy();
  });

  it('默认 io + NEO4J_PASSWORD 未设 -> 安静跳过不抛', async () => {
    delete process.env.NEO4J_PASSWORD;
    await seedWorld();
    await saveQuota(ctx, { scope: 'counterparty', ownerKey: OWNER, limitAmount: 1, createdBy: 't' });
    const report = await reconcileAll(ctx); // 默认 io
    expect(report.quotas).toHaveLength(1);
    expect(report.quotas[0]!.overLimit).toBe(true); // DB 物化照常
  });
});

describe('reconcileQuotaOne', () => {
  it('单条额度即时重算(路由 create/patch 复用)', async () => {
    await seedWorld();
    const id = await saveQuota(ctx, { scope: 'counterparty', ownerKey: '第三方公司', limitAmount: 500, createdBy: 't' });
    const { io } = makeIo();
    const row = (await findQuotaById(ctx, id))!;
    const r = await reconcileQuotaOne(ctx, row, io);
    expect(r.used).toBe(999);
    expect(r.remaining).toBe(-499);
    expect(r.overLimit).toBe(true);
    expect((await findQuotaById(ctx, id))?.usedAmount).toBe(999);
  });
});
