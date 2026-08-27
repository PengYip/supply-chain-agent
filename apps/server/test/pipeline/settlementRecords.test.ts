import { describe, it, expect, beforeEach } from 'vitest';
import { createDb, migrate } from '../../src/pipeline/db/client.js';
import {
  insertSettlementRecord,
  listSettlementRecords,
  type SettlementRecordInput,
} from '../../src/pipeline/db/repositories.js';

let ctx: ReturnType<typeof createDb>;
beforeEach(() => {
  ctx = createDb(':memory:');
  migrate(ctx.sqlite);
});

function rec(overrides: Partial<SettlementRecordInput> = {}): SettlementRecordInput {
  return {
    contractNo: 'HT-2024-001',
    contractLedgerId: 'DOC-contract',
    settledQuantity: 3357.46,
    quantityUnit: '吨',
    basePrice: 850,
    currency: 'CNY',
    totalAmount: 2853841,
    adjustments: [
      { label: '水分扣重', amount: -1234.5 },
      { label: '硫分奖罚', amount: -200 },
    ],
    basisFlowIds: ['EF-1', 'EF-2'],
    basisExtractionIds: ['EX-1'],
    notes: '按轨道衡实重+化验扣水',
    createdBy: 'agent',
    ...overrides,
  };
}

describe('settlement_records(spec 2026-08-27 §15)', () => {
  it('insert -> list roundtrip(JSON 字段还原)', async () => {
    const id = await insertSettlementRecord(ctx, rec());
    expect(id).toMatch(/^SR-/);
    const rows = await listSettlementRecords(ctx, 'HT-2024-001');
    expect(rows).toHaveLength(1);
    const r = rows[0]!;
    expect(r.status).toBe('confirmed');
    expect(r.settledQuantity).toBe(3357.46);
    expect(r.adjustments).toEqual([
      { label: '水分扣重', amount: -1234.5 },
      { label: '硫分奖罚', amount: -200 },
    ]);
    expect(r.basisFlowIds).toEqual(['EF-1', 'EF-2']);
    expect(r.basisExtractionIds).toEqual(['EX-1']);
    expect(r.userId).toBe('');
  });

  it('按合同过滤; 只增不改(两次确认 = 两行, 最新在前)', async () => {
    await insertSettlementRecord(ctx, rec({ totalAmount: 100 }));
    await insertSettlementRecord(ctx, rec({ totalAmount: 200 }));
    await insertSettlementRecord(ctx, rec({ contractNo: 'HT-OTHER' }));
    const rows = await listSettlementRecords(ctx, 'HT-2024-001');
    expect(rows).toHaveLength(2);
    expect(rows[0]!.totalAmount).toBe(200);
  });

  it('user 隔离: scoped 调用读不到他人行', async () => {
    await insertSettlementRecord(ctx, rec(), 'u1');
    expect(await listSettlementRecords(ctx, 'HT-2024-001', 'u1')).toHaveLength(1);
    expect(await listSettlementRecords(ctx, 'HT-2024-001', 'u2')).toHaveLength(0);
    // unscoped 调用可见(legacy 语义)。
    expect(await listSettlementRecords(ctx, 'HT-2024-001')).toHaveLength(1);
  });
});
