// apps/server/test/ontology/writeoff.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { createDb, migrate, type DbContext } from '../../src/pipeline/db/client.js';
import { insertTradeFact, insertOntologyEdge } from '../../src/ontology/repo.js';
import {
  writeoffModeRelations, listWriteoffBalances, getWriteoffOverview, validateAllocationPlan,
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

describe('validateAllocationPlan（守恒校验）', () => {
  it('部分核销：对余额 20 的发票分配 15 通过（seed 后 invA 剩余 20）', async () => {
    const { p, invA } = await seed();
    const v = await validateAllocationPlan(ctx, 'WRITE_OFF',
      [{ srcId: p, dstId: invA, amount: 15 }], 'u1');
    expect(v).toEqual([]);
  });

  it('多发票合并付款：Σ分配 ≤ 资金余额 通过；超了报 src_over_remaining', async () => {
    const { p, invA, invB } = await seed(); // p remaining 160（已核 40）
    const ok = await validateAllocationPlan(ctx, 'WRITE_OFF', [
      { srcId: p, dstId: invA, amount: 20 },
      { srcId: p, dstId: invB, amount: 50 },
    ], 'u1');
    expect(ok).toEqual([]);
    // invA remaining 20: 20+? ；资金侧 160+1 超额
    const over = await validateAllocationPlan(ctx, 'WRITE_OFF', [
      { srcId: p, dstId: invA, amount: 20 },
      { srcId: p, dstId: invB, amount: 50 },
      { srcId: p, dstId: invB, amount: 91 },
    ], 'u1');
    expect(over.map((x) => x.code)).toContain('src_over_remaining');
  });

  it('dst 超余额：发票 A 仅剩 20，分配 70 报 dst_over_remaining', async () => {
    const { p, invA } = await seed();
    const v = await validateAllocationPlan(ctx, 'WRITE_OFF',
      [{ srcId: p, dstId: invA, amount: 70 }], 'u1');
    expect(v.map((x) => x.code)).toEqual(['dst_over_remaining']);
  });

  it('冲抵不超结算额：OFFSET_SETTLE 对 Settlement 校验；错向连接报 pair_not_allowed', async () => {
    const { p, stl, invA } = await seed();
    const ok = await validateAllocationPlan(ctx, 'OFFSET_SETTLE',
      [{ srcId: p, dstId: stl, amount: 80 }], 'u1');
    expect(ok).toEqual([]);
    const bad = await validateAllocationPlan(ctx, 'OFFSET_SETTLE',
      [{ srcId: p, dstId: invA, amount: 10 }], 'u1');
    expect(bad.map((x) => x.code)).toEqual(['pair_not_allowed']);
  });

  it('未知事实/非正数/跨用户隔离', async () => {
    const { p, invA } = await seed();
    expect((await validateAllocationPlan(ctx, 'WRITE_OFF',
      [{ srcId: p, dstId: invA, amount: 0 }], 'u1')).map((x) => x.code)).toEqual(['non_positive']);
    expect((await validateAllocationPlan(ctx, 'WRITE_OFF',
      [{ srcId: 'TF-nope', dstId: invA, amount: 5 }], 'u1')).map((x) => x.code)).toEqual(['unknown_fact']);
    // u2 看不见 u1 的事实行 -> unknown_fact（隔离即校验）
    expect((await validateAllocationPlan(ctx, 'WRITE_OFF',
      [{ srcId: p, dstId: invA, amount: 5 }], 'u2')).map((x) => x.code)).toEqual(['unknown_fact', 'unknown_fact']);
  });
});
