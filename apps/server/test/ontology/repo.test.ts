import { describe, it, expect, beforeEach } from 'vitest';
import { createDb, migrate, type DbContext } from '../../src/pipeline/db/client.js';
import { asOfBusinessTime, asOfSystemTime, normalizeIsoUtc } from '../../src/ontology/asof.js';
import {
  insertTradeFact, insertOntologyEdge, listTradeFactsAsOf, listOntologyEdgesAsOf,
  getTradeFactById,
} from '../../src/ontology/repo.js';

let ctx: DbContext;
beforeEach(() => {
  ctx = createDb(':memory:');
  migrate(ctx.sqlite);
});

const INVOICE = (amount: number, eventBizType: '正向' | '逆向') => ({
  invoiceNo: 'INV-1', invoiceType: '销项', eventBizType, amount, currency: 'CNY',
});

describe('as-of predicates (memo section 4 semantics)', () => {
  it('business time: valid window [validAt, invalidAt)', () => {
    const p = asOfBusinessTime('2026-07-31T00:00:00.000Z');
    expect(p.sql).toBe('valid_at <= ? AND (invalid_at IS NULL OR invalid_at > ?)');
    expect(p.params).toEqual(['2026-07-31T00:00:00.000Z', '2026-07-31T00:00:00.000Z']);
  });

  it('system time: ingested_at only (what we knew then)', () => {
    const p = asOfSystemTime('2026-07-31T00:00:00.000Z');
    expect(p.sql).toBe('ingested_at <= ?');
    expect(p.params).toEqual(['2026-07-31T00:00:00.000Z']);
  });

  it('normalizeIsoUtc: date-only and Date objects both land on UTC ISO', () => {
    expect(normalizeIsoUtc('2026-06-15')).toBe('2026-06-15T00:00:00.000Z');
    expect(normalizeIsoUtc(new Date('2026-06-15T08:00:00+08:00'))).toBe('2026-06-15T00:00:00.000Z');
    expect(() => normalizeIsoUtc('not-a-date')).toThrow();
  });
});

describe('ontology repo write boundary', () => {
  it('insertTradeFact validates payload via the registry (event semantics enforced)', async () => {
    const id = await insertTradeFact(ctx, {
      entityType: 'InvoiceEvent', payload: INVOICE(1_000_000, '正向'),
      validAt: '2026-06-15', createdBy: 'test',
    });
    expect(id).toMatch(/^TF-/);
    await expect(insertTradeFact(ctx, {
      entityType: 'InvoiceEvent', payload: INVOICE(100, '逆向'), // 逆向正数 => 违反 6.2
      validAt: '2026-06-15', createdBy: 'test',
    })).rejects.toThrow();
    await expect(insertTradeFact(ctx, {
      entityType: 'NoSuchEntity', payload: {},
      validAt: '2026-06-15', createdBy: 'test',
    })).rejects.toThrow();
  });

  it('数量冲正：逆向收货无金额可登记（金额方向断言仅在有 amount 时生效）', async () => {
    const id = await insertTradeFact(ctx, {
      entityType: 'GoodsReceiptEvent',
      payload: { eventBizType: '逆向', quantity: 10, unit: '吨' },
      validAt: '2026-06-15', createdBy: 'test',
    });
    expect(id).toMatch(/^TF-/);
    const rows = await listTradeFactsAsOf(ctx, asOfBusinessTime('2026-09-08T00:00:00.000Z'), {});
    const row = rows.find((r) => r.id === id)!;
    expect(row.payload).toEqual({ eventBizType: '逆向', quantity: 10, unit: '吨' });
    await expect(insertTradeFact(ctx, { // 有 amount 时规则不变：逆向正数仍拒
      entityType: 'GoodsReceiptEvent',
      payload: { eventBizType: '逆向', amount: 100, currency: 'CNY' },
      validAt: '2026-06-15', createdBy: 'test',
    })).rejects.toThrow();
  });

  it('insertOntologyEdge validates relation + pair + params', async () => {
    const id = await insertOntologyEdge(ctx, {
      relation: 'WRITE_OFF', fromType: 'PaymentEvent', fromId: 'TF-P1',
      toType: 'InvoiceEvent', toId: 'TF-I1',
      params: { amount: 500, partial: true }, validAt: '2026-06-20', createdBy: 'test',
    });
    expect(id).toMatch(/^OE-/);
    await expect(insertOntologyEdge(ctx, { // 非法连接对
      relation: 'ALLOCATE_TO', fromType: 'TradeContract', fromId: 'C1',
      toType: 'InvoiceEvent', toId: 'I1', params: { amount: 1, method: '金额' },
      validAt: '2026-06-20', createdBy: 'test',
    })).rejects.toThrow();
    await expect(insertOntologyEdge(ctx, { // params 违反 strict schema
      relation: 'WRITE_OFF', fromType: 'PaymentEvent', fromId: 'TF-P1',
      toType: 'InvoiceEvent', toId: 'TF-I1',
      params: { amount: 500, bogus: 1 }, validAt: '2026-06-20', createdBy: 'test',
    })).rejects.toThrow();
  });
});

describe('red-invoice as-of scenario (memo section 4: three questions, three answers)', () => {
  // 6/15 收发票 100 万; 8/5 红冲重开 80 万(追溯 6/15 生效)。红冲不失效原票: 逆向负数自动轧差(docx 6.2), fixture 无 invalidAt。
  beforeEach(async () => {
    await insertTradeFact(ctx, {
      entityType: 'InvoiceEvent', payload: INVOICE(1_000_000, '正向'),
      validAt: '2026-06-15', ingestedAt: '2026-06-16',
      createdBy: 'scenario',
    });
    await insertTradeFact(ctx, {
      entityType: 'InvoiceEvent', payload: INVOICE(-1_000_000, '逆向'),
      validAt: '2026-06-15', ingestedAt: '2026-08-05', createdBy: 'scenario',
    });
    await insertTradeFact(ctx, {
      entityType: 'InvoiceEvent', payload: { ...INVOICE(800_000, '正向'), invoiceNo: 'INV-2' },
      validAt: '2026-06-15', ingestedAt: '2026-08-05', createdBy: 'scenario',
    });
  });

  const sum = (rows: Array<{ payload: Record<string, unknown> }>) =>
    rows.reduce((acc, r) => acc + (r.payload['amount'] as number), 0);

  it('Q1 最新口径(asOfBusinessTime now): 80 万', async () => {
    const rows = await listTradeFactsAsOf(ctx, asOfBusinessTime('2026-09-07T00:00:00.000Z'), {});
    expect(sum(rows)).toBe(800_000);
  });

  it('Q2 7/31 出表时账面(asOfSystemTime): 100 万——月报可复现', async () => {
    const rows = await listTradeFactsAsOf(ctx, asOfSystemTime('2026-07-31T23:59:59.000Z'), {});
    expect(sum(rows)).toBe(1_000_000);
  });

  it('Q3 6 月真实成本(asOfBusinessTime 6/30): 80 万', async () => {
    const rows = await listTradeFactsAsOf(ctx, asOfBusinessTime('2026-06-30T00:00:00.000Z'), {});
    expect(sum(rows)).toBe(800_000);
  });

  it('entityType filter narrows the slice', async () => {
    const rows = await listTradeFactsAsOf(ctx, asOfSystemTime('2026-07-31T00:00:00.000Z'), { entityType: 'PaymentEvent' });
    expect(rows).toEqual([]);
  });
});

describe('ontology edges as-of', () => {
  it('edges honor the same dual-timeline predicates', async () => {
    await insertOntologyEdge(ctx, {
      relation: 'WRITE_OFF', fromType: 'PaymentEvent', fromId: 'TF-P1',
      toType: 'InvoiceEvent', toId: 'TF-I1', params: { amount: 500 },
      validAt: '2026-06-15', createdBy: 'test',
    });
    await insertOntologyEdge(ctx, {
      relation: 'OFFSET_SETTLE', fromType: 'PaymentEvent', fromId: 'TF-P2',
      toType: 'SettlementEvent', toId: 'TF-S1', params: { amount: 300 },
      validAt: '2026-06-15', invalidAt: '2026-07-01', createdBy: 'test',
    });
    const at620 = await listOntologyEdgesAsOf(ctx, asOfBusinessTime('2026-06-20T00:00:00.000Z'), {});
    expect(at620).toHaveLength(2);
    const at715 = await listOntologyEdgesAsOf(ctx, asOfBusinessTime('2026-07-15T00:00:00.000Z'), {});
    expect(at715.map((e) => e.relation)).toEqual(['WRITE_OFF']); // OFFSET_SETTLE 已于 7/1 失效
    const filtered = await listOntologyEdgesAsOf(ctx, asOfBusinessTime('2026-07-15T00:00:00.000Z'), { relation: 'OFFSET_SETTLE' });
    expect(filtered).toEqual([]);
  });
});

describe('M-1 canonical persistence (strict write boundary)', () => {
  it('rejects payload fields outside the registry vocabulary (strict, no silent strip)', async () => {
    await expect(insertTradeFact(ctx, {
      entityType: 'InvoiceEvent',
      payload: { ...INVOICE(100, '正向'), bogus: 'x' },
      validAt: '2026-06-15', createdBy: 'test',
    })).rejects.toThrow();
  });

  it('persists exactly the parsed canonical payload (DB fields ⊆ registry vocabulary)', async () => {
    const id = await insertTradeFact(ctx, {
      entityType: 'InvoiceEvent', payload: INVOICE(100, '正向'),
      validAt: '2026-06-15', createdBy: 'test',
    });
    const rows = await listTradeFactsAsOf(ctx, asOfBusinessTime('2026-09-07T00:00:00.000Z'), {});
    const row = rows.find((r) => r.id === id)!;
    expect(row).toBeTruthy();
    expect(Object.keys(row.payload).sort())
      .toEqual(['amount', 'currency', 'eventBizType', 'invoiceNo', 'invoiceType']);
  });

  it('edges persist canonical params', async () => {
    await insertOntologyEdge(ctx, {
      relation: 'WRITE_OFF', fromType: 'PaymentEvent', fromId: 'TF-P1',
      toType: 'InvoiceEvent', toId: 'TF-I1', params: { amount: 500, batch: 'B1' },
      validAt: '2026-06-20', createdBy: 'test',
    });
    const edges = await listOntologyEdgesAsOf(ctx, asOfBusinessTime('2026-09-07T00:00:00.000Z'), {});
    expect(edges).toHaveLength(1);
    expect(edges[0]!.params).toEqual({ amount: 500, batch: 'B1' });
  });
});

describe('getTradeFactById', () => {
  it('round-trips a fact with user scoping', async () => {
    const id = await insertTradeFact(ctx, {
      entityType: 'InvoiceEvent', payload: INVOICE(100, '正向'),
      validAt: '2026-06-15', createdBy: 'test',
    }, 'u1');
    const hit = await getTradeFactById(ctx, id, 'u1');
    expect(hit?.payload['amount']).toBe(100);
    expect(await getTradeFactById(ctx, id, 'u2')).toBeNull();
  });
});
