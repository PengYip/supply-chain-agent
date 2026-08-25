import { describe, it, expect, beforeEach } from 'vitest';
import { createDb, migrate } from '../../src/pipeline/db/client.js';
import type { SqliteDbContext } from '../../src/pipeline/db/client.js';
import { buildQueryContractTool } from '../../src/tools/queries.js';

// query_contract 枚举模式(2026-08-25): 不带 contractNo -> 台账全量摘要。
// 点查模式行为不变(台账优先 -> seed 回退 -> notFound)。

type ExecInput = { contractNo?: string };
type ExecOut = Record<string, unknown>;

function call(t: { execute?: unknown }, input: ExecInput): Promise<ExecOut> {
  return (t.execute as (i: ExecInput) => Promise<ExecOut>)(input);
}

function insertLedgerRow(
  ctx: SqliteDbContext,
  opts: {
    id: string;
    contractNo: string;
    displayNo?: string;
    userId: string;
    docType?: string;
    title?: string;
  },
): void {
  ctx.sqlite
    .prepare(
      `INSERT INTO contract_ledger
         (id, contract_no, display_contract_no, doc_type, document_id, title,
          fields, field_meta, overall_confidence, needs_review, user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      opts.id,
      opts.contractNo,
      opts.displayNo ?? opts.contractNo,
      opts.docType ?? '合同',
      `DOC-${opts.id}`,
      opts.title ?? `测试合同 ${opts.contractNo}`,
      JSON.stringify({ 合同号: { value: opts.contractNo } }),
      JSON.stringify({}),
      0.9,
      0,
      opts.userId,
    );
}

describe('query_contract enumerate mode', () => {
  let ctx: SqliteDbContext;

  beforeEach(() => {
    ctx = createDb(':memory:');
    migrate(ctx.sqlite);
    insertLedgerRow(ctx, { id: 'L1', contractNo: 'HT-A-001', userId: 'u-a', title: '采购合同A' });
    insertLedgerRow(ctx, { id: 'L2', contractNo: 'HT-B-002', userId: 'u-a', docType: '销售合同' });
    insertLedgerRow(ctx, { id: 'L3', contractNo: 'HT-C-003', userId: 'u-b' });
  });

  it('enumerates ledger summaries scoped to the user when contractNo omitted', async () => {
    const t = buildQueryContractTool({ ctx, userId: 'u-a' });
    const out = await call(t, {});
    expect(out.source).toBe('ledger');
    expect(out.mode).toBe('enumerate');
    expect(out.count).toBe(2);
    expect(out.totalInLedger).toBe(2);
    expect(out.truncated).toBeUndefined();
    const contracts = out.contracts as Array<Record<string, unknown>>;
    expect(contracts.map((c) => c.contractNo).sort()).toEqual(['HT-A-001', 'HT-B-002']);
    for (const c of contracts) {
      expect(c.documentId).toMatch(/^DOC-L[12]$/);
      expect(c.docType).toBeTruthy();
      expect(typeof c.overallConfidence).toBe('number');
    }
  });

  it('returns notConfigured when enumerating without DB context', async () => {
    const t = buildQueryContractTool();
    const out = await call(t, {});
    expect(out.notConfigured).toBe(true);
  });

  it('flags explicit truncation beyond the limit instead of silently dropping', async () => {
    for (let i = 0; i < 55; i++) {
      insertLedgerRow(ctx, { id: `X${i}`, contractNo: `BIG-${String(i).padStart(3, '0')}`, userId: 'u-big' });
    }
    const t = buildQueryContractTool({ ctx, userId: 'u-big' });
    const out = await call(t, {});
    expect(out.truncated).toBe(true);
    expect(out.count).toBe(50);
    expect(out.totalInLedger).toBe(55);
    expect(typeof out.note).toBe('string');
  });

  it('point-query path unchanged: ledger hit, then seed fallback miss', async () => {
    const t = buildQueryContractTool({ ctx, userId: 'u-a' });
    const hit = await call(t, { contractNo: 'HT-A-001' });
    expect(hit.source).toBe('ledger');
    expect(hit.title).toBe('采购合同A');

    const miss = await call(t, { contractNo: 'NOPE-404' });
    expect(miss.notFound).toBe(true);
    expect(miss.contractNo).toBe('NOPE-404');
  });

  it('user isolation: u-b cannot enumerate u-a contracts', async () => {
    const t = buildQueryContractTool({ ctx, userId: 'u-b' });
    const out = await call(t, {});
    expect(out.count).toBe(1);
    const contracts = out.contracts as Array<Record<string, unknown>>;
    expect(contracts[0].contractNo).toBe('HT-C-003');
  });
});
