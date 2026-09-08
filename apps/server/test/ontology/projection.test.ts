// apps/server/test/ontology/projection.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { createDb, migrate, type DbContext } from '../../src/pipeline/db/client.js';
import { listProjectedEntities, getProjectedEntityDetail } from '../../src/ontology/projection.js';
import { insertTradeFact, insertOntologyEdge } from '../../src/ontology/repo.js';

let ctx: DbContext;
beforeEach(() => {
  ctx = createDb(':memory:');
  migrate(ctx.sqlite);
});

const insertContract = (id: string, contractNo: string, contractType: string | null) => {
  ctx.sqlite.prepare(
    `INSERT INTO contract_ledger (id, contract_no, display_contract_no, doc_type, document_id,
        title, fields, field_meta, overall_confidence, needs_review, user_id, contract_type)
     VALUES (?, ?, ?, '合同', 'doc-1', '', '{}', '{}', 1, 0, 'u1', ?)`,
  ).run(id, contractNo, contractNo, contractType);
};

describe('projection: TradeContract <- contract_ledger (read-only)', () => {
  it('maps registry vocabulary fields + label + source', async () => {
    insertContract('C1', 'HT-2026-001', '采购');
    const res = await listProjectedEntities(ctx, 'TradeContract', {}, 'u1');
    expect(res.total).toBe(1);
    const e = res.items[0]!;
    expect(e.id).toBe('C1');
    expect(e.source).toBe('contract_ledger');
    expect(e.label).toBe('HT-2026-001');
    expect(e.fields['contractNo']).toBe('HT-2026-001');
    expect(e.fields['contractType']).toBe('采购');
    expect(e.ingestedAt).toBeTruthy();
  });

  it('nullable contract_type omitted from fields (rendered empty by UI)', async () => {
    insertContract('C2', 'HT-2026-002', null);
    const res = await listProjectedEntities(ctx, 'TradeContract', {}, 'u1');
    expect(res.items[0]!.fields).not.toHaveProperty('contractType');
  });

  it('user scoping: other-user rows invisible, shared (empty user_id) visible', async () => {
    insertContract('C3', 'HT-2026-003', '采购');
    ctx.sqlite.prepare(
      `INSERT INTO contract_ledger (id, contract_no, display_contract_no, doc_type, document_id,
          title, fields, field_meta, overall_confidence, needs_review, user_id, contract_type)
       VALUES ('C4', 'HT-2026-004', 'HT-2026-004', '合同', 'doc-2', '', '{}', '{}', 1, 0, 'u2', '销售')`,
    ).run();
    ctx.sqlite.prepare(
      `INSERT INTO contract_ledger (id, contract_no, display_contract_no, doc_type, document_id,
          title, fields, field_meta, overall_confidence, needs_review, user_id, contract_type)
       VALUES ('C5', 'HT-2026-005', 'HT-2026-005', '合同', 'doc-3', '', '{}', '{}', 1, 0, '', '采购')`,
    ).run();
    const res = await listProjectedEntities(ctx, 'TradeContract', {}, 'u1');
    expect(res.items.map((e) => e.id).sort()).toEqual(['C3', 'C5']);
  });

  it('q filter + pagination', async () => {
    for (let i = 1; i <= 25; i += 1) {
      insertContract(`C${i}`, `HT-2026-${String(i).padStart(3, '0')}`, '采购');
    }
    const page2 = await listProjectedEntities(ctx, 'TradeContract', { page: 2, pageSize: 20 }, 'u1');
    expect(page2.items).toHaveLength(5);
    expect(page2.total).toBe(25);
    const q = await listProjectedEntities(ctx, 'TradeContract', { q: 'HT-2026-003' }, 'u1');
    expect(q.total).toBe(1);
  });

  it('q filter matches entity id too (origin selector promises id search)', async () => {
    insertContract('C-DEMO-LIN', 'HT-DEMO-LIN-001', '采购');
    const byId = await listProjectedEntities(ctx, 'TradeContract', { q: 'C-DEMO-LIN' }, 'u1');
    expect(byId.total).toBe(1);
    expect(byId.items[0]!.id).toBe('C-DEMO-LIN');
  });

  it('basic filters: validAt date range + amount range (2026-09-08)', async () => {
    const pay = (amount: number, validAt: string) => insertTradeFact(ctx, {
      entityType: 'PaymentEvent',
      payload: { eventBizType: '正向', amount, currency: 'CNY', payType: '预付' },
      validAt, createdBy: 'demo',
    }, 'u1');
    await pay(100_000, '2026-06-01');
    await pay(300_000, '2026-06-15');
    await pay(500_000, '2026-07-01');
    const june = await listProjectedEntities(ctx, 'PaymentEvent', { validFrom: '2026-06-01', validTo: '2026-06-30' }, 'u1');
    expect(june.total).toBe(2);
    const big = await listProjectedEntities(ctx, 'PaymentEvent', { amountMin: 250_000 }, 'u1');
    expect(big.total).toBe(2);
    const band = await listProjectedEntities(ctx, 'PaymentEvent', { validFrom: '2026-06-10', validTo: '2026-06-30', amountMin: 200_000, amountMax: 400_000 }, 'u1');
    expect(band.items.map((e) => e.fields['amount'])).toEqual([300_000]);
    // 静态实体无业务时间：时间过滤激活时被排除而非报错
    insertContract('C9', 'HT-2026-009', '采购');
    const noContract = await listProjectedEntities(ctx, 'TradeContract', { validFrom: '2026-01-01' }, 'u1');
    expect(noContract.total).toBe(0);
  });

  it('types without a source return an empty page, not error (acceptance 4)', async () => {
    const res = await listProjectedEntities(ctx, 'TradeGoods', {}, 'u1');
    expect(res).toEqual({ items: [], total: 0, page: 1, pageSize: 20 });
  });
});

const insertDoc = (id: string, docType: string) => {
  ctx.sqlite.prepare(
    `INSERT INTO documents (id, doc_type, modality, source_uri, block_model, user_id, review_status, parse_status)
     VALUES (?, ?, 'text', '/ingest/x.pdf', 'raw', 'u1', 'pending', 'uploaded')`,
  ).run(id, docType);
};

describe('projection: events <- trade_facts + receipt/delivery docs', () => {
  it('InvoiceEvent rows come from trade_facts with payload as fields, business key as label', async () => {
    await insertTradeFact(ctx, {
      entityType: 'InvoiceEvent',
      payload: { invoiceNo: 'INV-9', invoiceType: '销项', eventBizType: '正向', amount: 1000, currency: 'CNY' },
      validAt: '2026-06-15', createdBy: 'test',
    }, 'u1');
    const res = await listProjectedEntities(ctx, 'InvoiceEvent', {}, 'u1');
    expect(res.total).toBe(1);
    expect(res.items[0]!.label).toBe('INV-9');
    expect(res.items[0]!.fields['amount']).toBe(1000);
    expect(res.items[0]!.source).toBe('trade_facts');
    expect(res.items[0]!.validAt).toBeTruthy();
  });

  it('GoodsReceiptEvent unions documents(收货单) + trade_facts rows', async () => {
    insertDoc('D1', '收货单');
    insertDoc('D2', '发货单'); // 发货单不属于收货事件的源
    insertDoc('D3', '发票');   // 非收发白名单
    await insertTradeFact(ctx, {
      entityType: 'GoodsReceiptEvent',
      payload: { eventBizType: '正向', amount: 500, currency: 'CNY' },
      validAt: '2026-06-15', createdBy: 'test',
    }, 'u1');
    const res = await listProjectedEntities(ctx, 'GoodsReceiptEvent', {}, 'u1');
    expect(res.total).toBe(2);
    const docRow = res.items.find((e) => e.id === 'D1')!;
    expect(docRow.source).toBe('documents');
    expect(docRow.meta?.['sourceUri']).toBe('/ingest/x.pdf');
    expect(docRow.fields).toEqual({}); // documents 无事件字段 -> 留空渲染
    expect(res.items.some((e) => e.id === 'D2')).toBe(false);
    expect(res.items.some((e) => e.id === 'D3')).toBe(false);
  });

  it('list uses latest-business view: facts not yet valid or already invalidated are hidden', async () => {
    await insertTradeFact(ctx, {
      entityType: 'PaymentEvent',
      payload: { eventBizType: '正向', amount: 100, currency: 'CNY', payType: '预付' },
      validAt: '2099-01-01', createdBy: 'test',
    }, 'u1');
    await insertTradeFact(ctx, {
      entityType: 'CollectionEvent',
      payload: { eventBizType: '正向', amount: 200, currency: 'CNY' },
      validAt: '2026-06-01', invalidAt: '2026-06-02', createdBy: 'test',
    }, 'u1');
    expect((await listProjectedEntities(ctx, 'PaymentEvent', {}, 'u1')).total).toBe(0);
    expect((await listProjectedEntities(ctx, 'CollectionEvent', {}, 'u1')).total).toBe(0);
  });

  it('fact rows respect user scoping', async () => {
    await insertTradeFact(ctx, {
      entityType: 'InvoiceEvent',
      payload: { invoiceNo: 'INV-10', invoiceType: '销项', eventBizType: '正向', amount: 1, currency: 'CNY' },
      validAt: '2026-06-15', createdBy: 'test',
    }, 'u2');
    expect((await listProjectedEntities(ctx, 'InvoiceEvent', {}, 'u1')).total).toBe(0);
  });
});

describe('projection: entity detail as-of + REVERSE_ORIGIN netting', () => {
  let originalId: string;
  let reversalId: string;
  beforeEach(async () => {
    originalId = await insertTradeFact(ctx, {
      entityType: 'InvoiceEvent',
      payload: { invoiceNo: 'INV-1', invoiceType: '销项', eventBizType: '正向', amount: 1_000_000, currency: 'CNY' },
      validAt: '2026-06-15', ingestedAt: '2026-06-16', createdBy: 'demo',
    }, 'u1');
    reversalId = await insertTradeFact(ctx, {
      entityType: 'InvoiceEvent',
      payload: { invoiceNo: 'INV-1', invoiceType: '销项', eventBizType: '逆向', amount: -1_000_000, currency: 'CNY' },
      validAt: '2026-06-15', ingestedAt: '2026-08-05', createdBy: 'demo',
    }, 'u1');
    await insertOntologyEdge(ctx, {
      relation: 'REVERSE_ORIGIN', fromType: 'InvoiceEvent', fromId: reversalId,
      toType: 'InvoiceEvent', toId: originalId, params: { amount: 1_000_000 },
      validAt: '2026-06-15', ingestedAt: '2026-08-05', createdBy: 'demo',
    }, 'u1');
  });

  it('system@7/31 (当时口径): only the original fact was known -> net 1,000,000', async () => {
    const d = await getProjectedEntityDetail(ctx, 'InvoiceEvent', originalId,
      { mode: 'system', at: '2026-07-31T23:59:59.000Z' }, 'u1');
    expect(d!.timeline).toHaveLength(1);
    expect(d!.netAmount).toBe(1_000_000);
  });

  it('business@now (最新口径): original + reversal -> net 0', async () => {
    const d = await getProjectedEntityDetail(ctx, 'InvoiceEvent', originalId,
      { mode: 'business' }, 'u1');
    expect(d!.timeline.map((e) => e.id).sort()).toEqual([originalId, reversalId].sort());
    expect(d!.netAmount).toBe(0);
  });

  it('user scoping: other user gets null', async () => {
    expect(await getProjectedEntityDetail(ctx, 'InvoiceEvent', originalId, {}, 'u2')).toBeNull();
  });

  it('contract detail has no timeline (dual timeline only on facts)', async () => {
    ctx.sqlite.prepare(
      `INSERT INTO contract_ledger (id, contract_no, display_contract_no, doc_type, document_id,
          title, fields, field_meta, overall_confidence, needs_review, user_id, contract_type)
       VALUES ('C1', 'HT-1', 'HT-1', '合同', 'd1', '', '{}', '{}', 1, 0, 'u1', '采购')`,
    ).run();
    const d = await getProjectedEntityDetail(ctx, 'TradeContract', 'C1', {}, 'u1');
    expect(d!.entity.fields['contractNo']).toBe('HT-1');
    expect(d!.timeline).toEqual([]);
    expect(d!.netAmount).toBeNull();
  });
});
