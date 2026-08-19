import { describe, it, expect, beforeEach } from 'vitest';
import { createDb, migrate } from '../../src/pipeline/db/client.js';
import {
  upsertExecutionFlow,
  retractExecutionFlowForBinding,
  retractExecutionFlowsForDocument,
  listConfirmedBindingsForDocument,
  listExecutionFlows,
  summarizeExecutionFlows,
  saveBinding,
  deleteDocument,
  type ExecutionFlowInput,
} from '../../src/pipeline/db/repositories.js';

let ctx: ReturnType<typeof createDb>;
beforeEach(() => {
  ctx = createDb(':memory:');
  migrate(ctx.sqlite);
});

/** 插入最小 documents 行(deleteDocument 的所有权检查需要)。 */
function insertDocumentStub(id: string, userId = ''): void {
  ctx.sqlite
    .prepare(
      `INSERT INTO documents (id, doc_type, modality, source_uri, block_model, user_id)
       VALUES (?, '其他', 'digital', 'stub://doc', 'stub', ?)`,
    )
    .run(id, userId);
}

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

  it('round-trips extractionId (溯源列), null when omitted', async () => {
    await upsertExecutionFlow(ctx, flow({ extractionId: 'EX-42' }));
    await upsertExecutionFlow(ctx, flow({ bindingId: 'BD-2' })); // extractionId omitted -> null

    const rows = await listExecutionFlows(ctx, 'HT-2024-001');
    expect(rows).toHaveLength(2);
    const traced = rows.find((r) => r.bindingId === 'BD-1')!;
    expect(traced.extractionId).toBe('EX-42');
    const untraced = rows.find((r) => r.bindingId === 'BD-2')!;
    expect(untraced.extractionId).toBeNull();
  });
});

describe('retractExecutionFlowsForDocument', () => {
  it('deletes only the given document rows and returns the count', async () => {
    await upsertExecutionFlow(ctx, flow({ documentId: 'DOC-1', bindingId: 'BD-1' }));
    await upsertExecutionFlow(ctx, flow({ documentId: 'DOC-1', bindingId: 'BD-2' }));
    await upsertExecutionFlow(ctx, flow({ documentId: 'DOC-2', bindingId: 'BD-3' }));

    expect(await retractExecutionFlowsForDocument(ctx, 'DOC-1')).toBe(2);
    expect(await listExecutionFlows(ctx, 'HT-2024-001')).toHaveLength(1); // DOC-2 row survives

    // Idempotent: nothing left, second retract reports 0.
    expect(await retractExecutionFlowsForDocument(ctx, 'DOC-1')).toBe(0);
  });

  it('respects the legacy 3-way OR user filter when scoped', async () => {
    await upsertExecutionFlow(ctx, flow({ documentId: 'DOC-1' }), 'u-a');
    await upsertExecutionFlow(ctx, flow({ documentId: 'DOC-1', bindingId: 'BD-9' }), 'u-b');

    // u-b's own row plus legacy '' rows are retractable; u-a's private row is not.
    expect(await retractExecutionFlowsForDocument(ctx, 'DOC-1', 'u-b')).toBe(1);
    const remaining = ctx.sqlite
      .prepare('SELECT binding_id AS b FROM execution_flows WHERE document_id = ?')
      .all('DOC-1') as Array<{ b: string }>;
    expect(remaining.map((r) => r.b)).toEqual(['BD-1']);
  });
});

describe('listConfirmedBindingsForDocument', () => {
  it('returns only confirmed bindings of that document, latest first', async () => {
    insertDocumentStub('DOC-1');
    insertDocumentStub('DOC-2');
    const b1 = await saveBinding(ctx, {
      documentId: 'DOC-1', contractNo: 'HT-2024-001', relation: '执行',
      sourceRefs: [], confidence: 0.9, createdBy: 'human',
    });
    // pending binding -> excluded even though same document.
    await saveBinding(ctx, {
      documentId: 'DOC-1', contractNo: 'HT-2024-001', relation: '执行',
      sourceRefs: [], confidence: 0.7, createdBy: 'agent', status: 'pending',
    });
    // confirmed but different document -> excluded.
    await saveBinding(ctx, {
      documentId: 'DOC-2', contractNo: 'HT-2024-001', relation: '执行',
      sourceRefs: [], confidence: 0.8, createdBy: 'human',
    });

    const rows = await listConfirmedBindingsForDocument(ctx, 'DOC-1');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(b1);
    expect(rows[0]!.contractNo).toBe('HT-2024-001');
    expect(rows[0]!.status).toBe('confirmed');
  });
});

describe('deleteDocument cleans execution_flows', () => {
  it('removes flow rows of the deleted document (防孤儿行)', async () => {
    insertDocumentStub('DOC-1');
    await upsertExecutionFlow(ctx, flow({ documentId: 'DOC-1', bindingId: 'BD-1' }));
    await upsertExecutionFlow(ctx, flow({ documentId: 'DOC-2', bindingId: 'BD-2' }));

    const { deleted } = await deleteDocument(ctx, 'DOC-1');
    expect(deleted).toBe(true);

    const remaining = ctx.sqlite
      .prepare('SELECT document_id AS d FROM execution_flows')
      .all() as Array<{ d: string }>;
    expect(remaining.map((r) => r.d)).toEqual(['DOC-2']);
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
