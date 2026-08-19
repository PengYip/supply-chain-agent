import { describe, it, expect, beforeEach } from 'vitest';
import { createDb, migrate } from '../../src/pipeline/db/client.js';
import {
  upsertExecutionFlow,
  retractExecutionFlowForBinding,
  listExecutionFlows,
  summarizeExecutionFlows,
  type ExecutionFlowInput,
} from '../../src/pipeline/db/repositories.js';

let ctx: ReturnType<typeof createDb>;
beforeEach(() => {
  ctx = createDb(':memory:');
  migrate(ctx.sqlite);
});

function flow(overrides: Partial<ExecutionFlowInput> = {}): ExecutionFlowInput {
  return {
    bindingId: 'BD-1',
    documentId: 'DOC-1',
    contractNo: 'HT-2024-001',
    flowType: '资金流',
    direction: 'in',
    amount: 1000,
    quantityTon: 10,
    docType: '银行回单',
    voucherDate: '2024-01-10',
    confidence: 0.95,
    createdBy: 'agent',
    ...overrides,
  };
}

describe('upsertExecutionFlow', () => {
  it('inserts a new row visible to listExecutionFlows', async () => {
    const id = await upsertExecutionFlow(ctx, flow());
    expect(id).toMatch(/^EF-/);

    const rows = await listExecutionFlows(ctx, 'HT-2024-001');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(id);
    expect(rows[0]!.bindingId).toBe('BD-1');
    expect(rows[0]!.flowType).toBe('资金流');
    expect(rows[0]!.direction).toBe('in');
    expect(rows[0]!.amount).toBe(1000);
    expect(rows[0]!.quantityTon).toBe(10);
    expect(rows[0]!.voucherDate).toBe('2024-01-10');
    expect(rows[0]!.confidence).toBe(0.95);
    expect(rows[0]!.userId).toBe('');
  });

  it('is idempotent per (binding_id, user_id): second write updates, no duplicate row', async () => {
    await upsertExecutionFlow(ctx, flow());
    await upsertExecutionFlow(ctx, flow({ amount: 2000, quantityTon: 20, voucherDate: '2024-02-01' }));

    const count = ctx.sqlite.prepare('SELECT COUNT(*) AS n FROM execution_flows').get() as { n: number };
    expect(count.n).toBe(1);

    const rows = await listExecutionFlows(ctx, 'HT-2024-001');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.amount).toBe(2000); // second write won
    expect(rows[0]!.quantityTon).toBe(20);
    expect(rows[0]!.voucherDate).toBe('2024-02-01');
  });
});

describe('retractExecutionFlowForBinding', () => {
  it('deletes the materialized row and returns true; second retract returns false', async () => {
    await upsertExecutionFlow(ctx, flow());

    expect(await retractExecutionFlowForBinding(ctx, 'BD-1')).toBe(true);
    expect(await listExecutionFlows(ctx, 'HT-2024-001')).toHaveLength(0);
    // Idempotent: nothing left to delete.
    expect(await retractExecutionFlowForBinding(ctx, 'BD-1')).toBe(false);
  });

  it('returns false when no row exists for the binding', async () => {
    expect(await retractExecutionFlowForBinding(ctx, 'BD-NOPE')).toBe(false);
  });
});

describe('summarizeExecutionFlows', () => {
  it('aggregates multiple rows across directions, ignoring null amounts in SUM', async () => {
    await upsertExecutionFlow(ctx, flow({ bindingId: 'BD-1', direction: 'in', amount: 1000, quantityTon: 10, voucherDate: '2024-01-10' }));
    await upsertExecutionFlow(ctx, flow({ bindingId: 'BD-2', direction: 'in', amount: 2000, quantityTon: 20, voucherDate: '2024-02-01' }));
    // null amount -> not counted in SUM(amount), but counted in entryCount.
    await upsertExecutionFlow(ctx, flow({ bindingId: 'BD-3', direction: 'in', amount: null, quantityTon: 30, voucherDate: '2024-03-01' }));
    await upsertExecutionFlow(ctx, flow({ bindingId: 'BD-4', direction: 'out', amount: 500, quantityTon: 5, voucherDate: '2024-01-15' }));

    const summary = await summarizeExecutionFlows(ctx, 'HT-2024-001');
    expect(summary).toHaveLength(2);

    const inRow = summary.find((s) => s.direction === 'in')!;
    expect(inRow.flowType).toBe('资金流');
    expect(inRow.entryCount).toBe(3);
    expect(inRow.totalAmount).toBe(3000); // 1000 + 2000 (null excluded)
    expect(inRow.totalQuantityTon).toBe(60); // 10 + 20 + 30
    expect(inRow.lastVoucherDate).toBe('2024-03-01');

    const outRow = summary.find((s) => s.direction === 'out')!;
    expect(outRow.entryCount).toBe(1);
    expect(outRow.totalAmount).toBe(500);
    expect(outRow.totalQuantityTon).toBe(5);
    expect(outRow.lastVoucherDate).toBe('2024-01-15');
  });

  it('returns [] for a contract with no flows', async () => {
    expect(await summarizeExecutionFlows(ctx, 'HT-NOPE')).toEqual([]);
  });
});

describe('user isolation (legacy uid filter)', () => {
  it('keeps scoped rows private: user B cannot see user A rows, user A can', async () => {
    await upsertExecutionFlow(ctx, flow(), 'u-a');

    expect(await listExecutionFlows(ctx, 'HT-2024-001', 'u-b')).toHaveLength(0);
    expect(await listExecutionFlows(ctx, 'HT-2024-001', 'u-a')).toHaveLength(1);
    // Unscoped caller skips the user filter entirely -> sees the row.
    expect(await listExecutionFlows(ctx, 'HT-2024-001')).toHaveLength(1);
  });

  it('exposes legacy rows (user_id = "") to any scoped caller (3-way OR)', async () => {
    await upsertExecutionFlow(ctx, flow()); // unscoped -> user_id ''

    const byB = await listExecutionFlows(ctx, 'HT-2024-001', 'u-b');
    expect(byB).toHaveLength(1);
    expect(byB[0]!.userId).toBe('');
  });
});
