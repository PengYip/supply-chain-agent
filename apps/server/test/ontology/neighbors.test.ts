// apps/server/test/ontology/neighbors.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { createDb, migrate, type DbContext } from '../../src/pipeline/db/client.js';
import { getOntologyNeighbors } from '../../src/ontology/neighbors.js';
import { insertTradeFact, insertOntologyEdge } from '../../src/ontology/repo.js';

let ctx: DbContext;
beforeEach(() => {
  ctx = createDb(':memory:');
  migrate(ctx.sqlite);
});

const insertContract = (id: string, contractNo: string) => {
  ctx.sqlite.prepare(
    `INSERT INTO contract_ledger (id, contract_no, display_contract_no, doc_type, document_id,
        title, fields, field_meta, overall_confidence, needs_review, user_id, contract_type)
     VALUES (?, ?, ?, '合同', 'doc-1', '', '{}', '{}', 1, 0, '', '采购')`,
  ).run(id, contractNo, contractNo);
};

/** 验收 1 的最小拓扑(D9)：C1 <-ALLOCATE_TO- S -CORRESPONDS_TO-> I；S -TRIGGERS-> P。 */
async function seedBridge() {
  insertContract('C1', 'HT-DEMO-001');
  const s = await insertTradeFact(ctx, {
    entityType: 'ServiceCostEvent',
    payload: { eventBizType: '正向', amount: 50_000, currency: 'CNY', costType: '物流' },
    validAt: '2026-06-01', createdBy: 'test',
  }, 'u1');
  const i = await insertTradeFact(ctx, {
    entityType: 'InvoiceEvent',
    payload: { invoiceNo: 'INV-L1', invoiceType: '销项', eventBizType: '正向', amount: 800_000, currency: 'CNY' },
    validAt: '2026-06-10', createdBy: 'test',
  }, 'u1');
  const p = await insertTradeFact(ctx, {
    entityType: 'PaymentEvent',
    payload: { eventBizType: '正向', amount: 300_000, currency: 'CNY', payType: '预付' },
    validAt: '2026-06-20', createdBy: 'test',
  }, 'u1');
  await insertOntologyEdge(ctx, {
    relation: 'ALLOCATE_TO', fromType: 'ServiceCostEvent', fromId: s,
    toType: 'TradeContract', toId: 'C1',
    params: { amount: 50_000, method: '金额' }, validAt: '2026-06-01', createdBy: 'test',
  }, 'u1');
  await insertOntologyEdge(ctx, {
    relation: 'CORRESPONDS_TO', fromType: 'ServiceCostEvent', fromId: s,
    toType: 'InvoiceEvent', toId: i, validAt: '2026-06-10', createdBy: 'test',
  }, 'u1');
  await insertOntologyEdge(ctx, {
    relation: 'TRIGGERS', fromType: 'ServiceCostEvent', fromId: s,
    toType: 'PaymentEvent', toId: p, validAt: '2026-06-20', createdBy: 'test',
  }, 'u1');
  return { s, i, p };
}

describe('getOntologyNeighbors (ontology BFS)', () => {
  it('acceptance 1: invoice + payment reachable within 2 hops from the contract, not 1', async () => {
    const { i, p } = await seedBridge();
    const d2 = await getOntologyNeighbors(ctx, { type: 'TradeContract', id: 'C1', depth: 2 }, 'u1');
    expect(d2.nodes.some((n) => n.entityType === 'InvoiceEvent' && n.id === i)).toBe(true);
    expect(d2.nodes.some((n) => n.entityType === 'PaymentEvent' && n.id === p)).toBe(true);
    const d1 = await getOntologyNeighbors(ctx, { type: 'TradeContract', id: 'C1', depth: 1 }, 'u1');
    const types1 = new Set(d1.nodes.map((n) => n.entityType));
    expect(types1.has('InvoiceEvent')).toBe(false);
    expect(types1.has('PaymentEvent')).toBe(false);
  });

  it('anchor resolves via contract_ledger with contractNo label; edges carry relation + params', async () => {
    await seedBridge();
    const res = await getOntologyNeighbors(ctx, { type: 'TradeContract', id: 'C1', depth: 1 }, 'u1');
    expect(res.anchorNode.label).toBe('HT-DEMO-001');
    expect(res.anchorNode.source).toBe('contract_ledger');
    expect(res.edges).toHaveLength(1);
    expect(res.edges[0]!.relation).toBe('ALLOCATE_TO');
    expect(res.edges[0]!.params).toEqual({ amount: 50_000, method: '金额' });
    expect(res.edges[0]!.origin).toBe('ontology');
  });

  it('fact neighbors resolve with business-key label; REVERSE_ORIGIN traverses bidirectionally', async () => {
    const i1 = await insertTradeFact(ctx, {
      entityType: 'InvoiceEvent',
      payload: { invoiceNo: 'INV-L1', invoiceType: '销项', eventBizType: '正向', amount: 800_000, currency: 'CNY' },
      validAt: '2026-06-10', createdBy: 'test',
    }, 'u1');
    const i2 = await insertTradeFact(ctx, {
      entityType: 'InvoiceEvent',
      payload: { invoiceNo: 'INV-L1', invoiceType: '销项', eventBizType: '逆向', amount: -800_000, currency: 'CNY' },
      validAt: '2026-06-10', ingestedAt: '2026-08-05', createdBy: 'test',
    }, 'u1');
    await insertOntologyEdge(ctx, {
      relation: 'REVERSE_ORIGIN', fromType: 'InvoiceEvent', fromId: i2,
      toType: 'InvoiceEvent', toId: i1, params: { amount: 800_000, reason: '开票信息有误' },
      validAt: '2026-06-10', ingestedAt: '2026-08-05', createdBy: 'test',
    }, 'u1');
    // 从红冲票出发(逆向方向)也能穿到原票
    const res = await getOntologyNeighbors(ctx, { type: 'InvoiceEvent', id: i2, depth: 1 }, 'u1');
    expect(res.anchorNode.label).toBe('INV-L1');
    expect(res.nodes.map((n) => n.id)).toEqual([i1]);
    expect(res.edges[0]!.relation).toBe('REVERSE_ORIGIN');
  });

  it('type mismatch resolves to unresolved, never wrong-typed data (D8)', async () => {
    const { i } = await seedBridge();
    // 发票事实 id 配上 PaymentEvent 类型 -> 不返回 InvoiceEvent 数据
    const res = await getOntologyNeighbors(ctx, { type: 'PaymentEvent', id: i, depth: 1 }, 'u1');
    expect(res.anchorNode.source).toBe('unresolved');
    expect(res.anchorNode.entityType).toBe('PaymentEvent');
    expect(res.edges).toHaveLength(0);
  });

  it('receipt entity doc id must match doc_type (findDocRowById fix)', async () => {
    ctx.sqlite.prepare(
      `INSERT INTO documents (id, doc_type, modality, source_uri, block_model, user_id, review_status, parse_status)
       VALUES ('D1', '发货单', 'text', '/ingest/x.pdf', 'raw', 'u1', 'pending', 'uploaded')`,
    ).run();
    // 收货类型锚点查到发货单 doc id -> 未解析
    const res = await getOntologyNeighbors(ctx, { type: 'GoodsReceiptEvent', id: 'D1', depth: 1 }, 'u1');
    expect(res.anchorNode.source).toBe('unresolved');
  });

  it('user scoping: other-user edges invisible; shared-domain contract still visible', async () => {
    await seedBridge();
    const res = await getOntologyNeighbors(ctx, { type: 'TradeContract', id: 'C1', depth: 2 }, 'u2');
    expect(res.edges).toHaveLength(0);
    expect(res.nodes).toHaveLength(0);
    // 共享域('' user_id)合同对 u2 可见
    expect(res.anchorNode.source).toBe('contract_ledger');
  });

  it('as-of: invalidated edges are excluded (latest business view)', async () => {
    insertContract('C1', 'HT-DEMO-001');
    const s = await insertTradeFact(ctx, {
      entityType: 'ServiceCostEvent',
      payload: { eventBizType: '正向', amount: 50_000, currency: 'CNY', costType: '物流' },
      validAt: '2026-06-01', createdBy: 'test',
    }, 'u1');
    await insertOntologyEdge(ctx, {
      relation: 'ALLOCATE_TO', fromType: 'ServiceCostEvent', fromId: s,
      toType: 'TradeContract', toId: 'C1',
      params: { amount: 50_000, method: '金额' },
      validAt: '2026-06-01', invalidAt: '2026-07-01', createdBy: 'test',
    }, 'u1');
    const res = await getOntologyNeighbors(ctx, { type: 'TradeContract', id: 'C1', depth: 1 }, 'u1');
    expect(res.edges).toHaveLength(0);
    expect(res.nodes).toHaveLength(0);
  });

  it('truncation caps nodes/edges with flag (D4)', async () => {
    await seedBridge();
    const res = await getOntologyNeighbors(
      ctx, { type: 'TradeContract', id: 'C1', depth: 2 }, 'u1', { maxNodes: 1, maxEdges: 0 });
    expect(res.nodes.length).toBeLessThanOrEqual(1);
    expect(res.edges).toHaveLength(0);
    expect(res.truncated).toBe(true);
  });
});
