import { describe, it, expect } from 'vitest';
import { createDb, migrate, type SqliteDbContext } from '../../src/pipeline/db/client.js';
import {
  buildCrossCheckTool,
  buildQueryOrdersTool,
} from '../../src/tools/queries.js';
import { seedCoreBusinessState } from '../../eval/agent/businessSeed.js';

const execOpts = {
  messages: [], toolCallId: 't', abortSignal: undefined as any,
} as any;

function makeCtx(): SqliteDbContext {
  const ctx = createDb(':memory:');
  migrate(ctx.sqlite);
  return ctx;
}

describe('query_orders (execution-flow aggregation)', () => {
  it('aggregates goods/invoice flows and identifies goods documents without invoices', async () => {
    const ctx = makeCtx();
    await seedCoreBusinessState(ctx);
    const res = (await buildQueryOrdersTool({ ctx }).execute(
      { contractNo: 'HT-2024-001' },
      execOpts,
    )) as any;

    expect(res.source).toBe('execution_flows');
    expect(res.granularity).toBe('contract-materialized-flows');
    expect(res.goods.receivedQuantity).toBe(793);
    expect(res.goods.unit).toBe('吨');
    expect(res.invoices.received.totalAmount).toBe(2835000);
    expect(res.invoices.documents.find((d: { documentId: string }) => d.documentId === 'DOC-GOODS-0881'))
      .toMatchObject({ amount: 858000, direction: 'in' });
    expect(res.missingInvoiceDocumentIds).toEqual(['DOC-GOODS-0883', 'DOC-GOODS-0884']);
    expect(res.materializedBindingCount).toBe(7);
  });

  it('returns notConfigured without a DbContext', async () => {
    const res = (await buildQueryOrdersTool().execute(
      { contractNo: 'HT-2024-001' },
      execOpts,
    )) as any;
    expect(res).toEqual({ notConfigured: true });
  });
});

describe('cross_check (ledger versus materialized flows)', () => {
  it('compares ledger amount/quantity to same-direction flow totals', async () => {
    const ctx = makeCtx();
    await seedCoreBusinessState(ctx);
    const res = (await buildCrossCheckTool({ ctx }).execute(
      { contractNo: 'HT-2024-001' },
      execOpts,
    )) as any;

    expect(res.expectedDirection).toBe('in');
    const amount = res.checks.find((c: { metric: string }) => c.metric === 'amount');
    const quantity = res.checks.find((c: { metric: string }) => c.metric === 'quantity');
    expect(amount).toMatchObject({
      status: 'complete',
      ledgerValue: 2860000,
      flowValue: 2835000,
      diff: -25000,
      diffRatio: -0.0087,
      hasAnomaly: true,
    });
    expect(quantity).toMatchObject({
      status: 'complete',
      ledgerValue: 800,
      flowValue: 793,
      diff: -7,
      diffRatio: -0.0088,
      hasAnomaly: true,
    });
    expect(res.hasAnomaly).toBe(true);
  });

  it('returns notConfigured without a DbContext', async () => {
    const res = (await buildCrossCheckTool().execute(
      { contractNo: 'HT-2024-001' },
      execOpts,
    )) as any;
    expect(res).toEqual({ notConfigured: true });
  });
});
