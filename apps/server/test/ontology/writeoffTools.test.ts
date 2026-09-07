// apps/server/test/ontology/writeoffTools.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { createDb, migrate, type DbContext } from '../../src/pipeline/db/client.js';
import { insertTradeFact, insertOntologyEdge, listOntologyEdgesAsOf } from '../../src/ontology/repo.js';
import { asOfBusinessTime } from '../../src/ontology/asof.js';
import { buildCreateWriteoffTool, buildCreateOffsetTool } from '../../src/ontology/writeoffTools.js';

let ctx: DbContext;
beforeEach(() => {
  ctx = createDb(':memory:');
  migrate(ctx.sqlite);
});

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
  return { p, invA, invB };
}

describe('create_writeoff execute', () => {
  it('整单落边：params 含 amount/partial/batch，createdBy=工具名，user_id 隔离', async () => {
    const { p, invA, invB } = await seed();
    const t = buildCreateWriteoffTool({ ctx, userId: 'u1' });
    const out = await t.execute!({
      items: [
        { srcId: p, dstId: invA, amount: 60 },
        { srcId: p, dstId: invB, amount: 40, partial: true, batch: 'B-2026-01' },
      ],
    }, { toolCallId: 'call_test_1', messages: [] } as never);
    expect(out.status).toBe('ok');
    if (out.status !== 'ok') return;
    expect(out.totalAmount).toBe(100);
    expect(out.edges).toHaveLength(2);
    const edges = await listOntologyEdgesAsOf(ctx, asOfBusinessTime(new Date().toISOString()), { relation: 'WRITE_OFF' }, 'u1');
    expect(edges).toHaveLength(2);
    const eb = edges.find((e) => e.toId === invB)!;
    expect(eb.params).toEqual({ amount: 40, partial: true, batch: 'B-2026-01' });
    expect(eb.createdBy).toBe('create_writeoff');
  });

  it('守恒失败：整单拒绝、零边产生（多发票合并付款超资金余额）', async () => {
    const { p, invA, invB } = await seed();
    const t = buildCreateWriteoffTool({ ctx, userId: 'u1' });
    const out = await t.execute!({
      items: [
        { srcId: p, dstId: invA, amount: 60 },
        { srcId: p, dstId: invB, amount: 50 },
        { srcId: p, dstId: invA, amount: 91 },
      ],
    }, { toolCallId: 'call_test_2', messages: [] } as never);
    expect(out.status).toBe('invalid');
    if (out.status !== 'invalid') return;
    expect(out.violations.map((v: { code: string }) => v.code)).toContain('src_over_remaining');
    const edges = await listOntologyEdgesAsOf(ctx, asOfBusinessTime(new Date().toISOString()), { relation: 'WRITE_OFF' }, 'u1');
    expect(edges).toEqual([]);
  });

  it('inputSchema 拒绝非正数（zod 层）', async () => {
    const t = buildCreateWriteoffTool({ ctx, userId: 'u1' });
    const parsed = t.inputSchema.safeParse({ items: [{ srcId: 'a', dstId: 'b', amount: -5 }] });
    expect(parsed.success).toBe(false);
  });
});

describe('create_offset execute', () => {
  it('OFFSET_SETTLE 落边 + 错向连接被 pair 白名单拒绝', async () => {
    const { p, invA } = await seed();
    const stl = await insertTradeFact(ctx, {
      entityType: 'SettlementEvent',
      payload: { eventBizType: '正向', amount: 80, currency: 'CNY' },
      validAt: '2026-06-04', createdBy: 'demo',
    }, 'u1');
    const t = buildCreateOffsetTool({ ctx, userId: 'u1' });
    const ok = await t.execute!({ items: [{ srcId: p, dstId: stl, amount: 80 }] },
      { toolCallId: 'call_test_3', messages: [] } as never);
    expect(ok.status).toBe('ok');
    // Payment -> Invoice 对 OFFSET_SETTLE 非法连接对
    const bad = await t.execute!({ items: [{ srcId: p, dstId: invA, amount: 10 }] },
      { toolCallId: 'call_test_4', messages: [] } as never);
    expect(bad.status).toBe('invalid');
    if (bad.status !== 'invalid') return;
    expect(bad.violations.map((v: { code: string }) => v.code)).toContain('pair_not_allowed');
  });
});