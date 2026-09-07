// apps/server/test/ontology/writeoff.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { createDb, migrate, type DbContext } from '../../src/pipeline/db/client.js';
import { insertTradeFact, insertOntologyEdge } from '../../src/ontology/repo.js';
import {
  writeoffModeRelations, listWriteoffBalances, getWriteoffOverview,
} from '../../src/ontology/writeoff.js';

let ctx: DbContext;
beforeEach(() => {
  ctx = createDb(':memory:');
  migrate(ctx.sqlite);
});

// 种子：付款 200（u1）+ 发票 A 60 / B 50 + 结算 S 80；已有核销边 p->A 40。
async function seed(u = 'u1') {
  const p = await insertTradeFact(ctx, {
    entityType: 'PaymentEvent',
    payload: { eventBizType: '正向', amount: 200, currency: 'CNY', payType: '预付' },
    validAt: '2026-06-01', createdBy: 'demo',
  }, u);
  const invA = await insertTradeFact(ctx, {
    entityType: 'InvoiceEvent',
    payload: { eventBizType: '正向', amount: 60, currency: 'CNY', invoiceNo: 'INV-A', invoiceType: '进项' },
    validAt: '2026-06-02', createdBy: 'demo',
  }, u);
  const invB = await insertTradeFact(ctx, {
    entityType: 'InvoiceEvent',
    payload: { eventBizType: '正向', amount: 50, currency: 'CNY', invoiceNo: 'INV-B', invoiceType: '进项' },
    validAt: '2026-06-03', createdBy: 'demo',
  }, u);
  const stl = await insertTradeFact(ctx, {
    entityType: 'SettlementEvent',
    payload: { eventBizType: '正向', amount: 80, currency: 'CNY' },
    validAt: '2026-06-04', createdBy: 'demo',
  }, u);
  await insertOntologyEdge(ctx, {
    relation: 'WRITE_OFF', fromType: 'PaymentEvent', fromId: p, toType: 'InvoiceEvent', toId: invA,
    params: { amount: 40, partial: true }, validAt: '2026-07-01', createdBy: 'demo',
  }, u);
  return { p, invA, invB, stl };
}

describe('writeoffModeRelations', () => {
  it('模式发现：带 amount 参数且资金侧发起的关系（映射驱动）', () => {
    expect(writeoffModeRelations()).toEqual(['OFFSET_SETTLE', 'WRITE_OFF']);
  });
});

describe('listWriteoffBalances', () => {
  it('余额 = 金额 − 核销类边累计；状态 none/partial/full', async () => {
    await seed();
    const rows = await listWriteoffBalances(ctx, 'u1');
    const p = rows.find((r) => r.entityType === 'PaymentEvent')!;
    expect(p.amount).toBe(200);
    expect(p.applied).toBe(40);
    expect(p.remaining).toBe(160);
    expect(p.status).toBe('partial');
  });

  it('发票行：A 已核 40/60 partial，B 未核 none；再补 20 后 B partial', async () => {
    const { invB, p } = await seed();
    const before = (await listWriteoffBalances(ctx, 'u1')).find((r) => r.id === invB)!;
    expect(before.status).toBe('none');
    expect(before.remaining).toBe(50);
    await insertOntologyEdge(ctx, {
      relation: 'WRITE_OFF', fromType: 'PaymentEvent', fromId: p, toType: 'InvoiceEvent', toId: invB,
      params: { amount: 50 }, validAt: '2026-07-02', createdBy: 'demo',
    }, 'u1');
    const after = (await listWriteoffBalances(ctx, 'u1')).find((r) => r.id === invB)!;
    expect(after.applied).toBe(50);
    expect(after.status).toBe('full');
  });

  it('用户隔离：u2 看不到 u1 的行', async () => {
    await seed('u1');
    const rows = await listWriteoffBalances(ctx, 'u2');
    expect(rows).toEqual([]);
  });
});

describe('getWriteoffOverview', () => {
  it('两模式各就各位：funds=资金行, targets=发票/结算行', async () => {
    await seed();
    const ov = await getWriteoffOverview(ctx, 'u1');
    expect(ov.modes.map((m) => m.relation)).toEqual(['OFFSET_SETTLE', 'WRITE_OFF']);
    const wo = ov.modes.find((m) => m.relation === 'WRITE_OFF')!;
    expect(wo.srcTypes).toEqual(['PaymentEvent', 'CollectionEvent']);
    expect(wo.dstTypes).toEqual(['InvoiceEvent']);
    expect(wo.funds.map((f) => f.entityType)).toEqual(['PaymentEvent']);
    expect(wo.targets.map((t) => t.label)).toContain('INV-A');
    const os = ov.modes.find((m) => m.relation === 'OFFSET_SETTLE')!;
    expect(os.dstTypes).toEqual(['SettlementEvent']);
    expect(os.targets.map((t) => t.entityType)).toEqual(['SettlementEvent']);
  });
});
