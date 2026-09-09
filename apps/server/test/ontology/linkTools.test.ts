// apps/server/test/ontology/linkTools.test.ts
// link_ontology L2 工具(P4 关系入口补全)：6 种关系登记 + 注册表校验链。
// :memory: SQLite 真库, 沿 eventTools 测试范式; 不触发图(NEO4J_PASSWORD 未设)。
import { describe, it, expect, beforeEach } from 'vitest';
import { createDb, migrate, type DbContext } from '../../src/pipeline/db/client.js';
import { insertTradeFact, listOntologyEdgesAsOf } from '../../src/ontology/repo.js';
import { asOfBusinessTime } from '../../src/ontology/asof.js';
import { buildLinkOntologyTool } from '../../src/ontology/linkTools.js';

let ctx: DbContext;
beforeEach(() => {
  ctx = createDb(':memory:');
  migrate(ctx.sqlite);
});

const CALL = { toolCallId: 'call_test', messages: [] } as never;

const insertContract = (id: string, contractNo: string) => {
  ctx.sqlite.prepare(
    `INSERT INTO contract_ledger (id, contract_no, display_contract_no, doc_type, document_id,
        title, fields, field_meta, overall_confidence, needs_review, user_id, contract_type)
     VALUES (?, ?, ?, '合同', 'doc-1', '', '{}', '{}', 1, 0, '', '采购')`,
  ).run(id, contractNo, contractNo);
};

const insertFact = (entityType: 'ServiceCostEvent' | 'InvoiceEvent' | 'SettlementEvent' | 'GoodsReceiptEvent' | 'Counterparty',
  payload: Record<string, unknown>, userId = 'u1') =>
  insertTradeFact(ctx, {
    entityType, payload: payload as never, validAt: '2026-06-01', createdBy: 'test',
  }, userId);

describe('link_ontology execute', () => {
  it('词表不含核销/冲抵：WRITE_OFF/OFFSET_SETTLE 在 schema 层被拒(引导去工作台)', () => {
    const t = buildLinkOntologyTool({ ctx, userId: 'u1' });
    const shape = t.inputSchema.shape as { relation: { options: readonly string[] } };
    expect(shape.relation.options).not.toContain('WRITE_OFF');
    expect(shape.relation.options).not.toContain('OFFSET_SETTLE');
    expect(shape.relation.options).toContain('ALLOCATE_TO');
  });

  it('ALLOCATE_TO：服务费 -> 台账合同行，params 落库，createdBy=link_ontology', async () => {
    insertContract('C1', 'HT-DEMO-001');
    const sid = await insertFact('ServiceCostEvent',
      { eventBizType: '正向', amount: 50_000, currency: 'CNY', costType: '物流' });
    const t = buildLinkOntologyTool({ ctx, userId: 'u1' });
    const out = await t.execute!({
      relation: 'ALLOCATE_TO', fromId: sid, toId: 'C1', amount: 15_000, method: '金额',
    }, CALL);
    expect(out.status).toBe('ok');
    const edges = await listOntologyEdgesAsOf(ctx, asOfBusinessTime(new Date().toISOString()), {}, 'u1');
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({
      relation: 'ALLOCATE_TO', fromType: 'ServiceCostEvent', fromId: sid,
      toType: 'TradeContract', toId: 'C1', createdBy: 'link_ontology',
    });
    expect(edges[0]!.params).toMatchObject({ amount: 15_000, method: '金额' });
  });

  it('REVERSE_ORIGIN：红冲方必须逆向(负数)、原票正向(正数)，违者整单拒绝', async () => {
    const blue = await insertFact('InvoiceEvent',
      { eventBizType: '正向', amount: 100_000, currency: 'CNY', invoiceNo: 'INV-B', invoiceType: '销项' });
    const red = await insertFact('InvoiceEvent',
      { eventBizType: '逆向', amount: -10_000, currency: 'CNY', invoiceNo: 'INV-B', invoiceType: '销项' });
    const t = buildLinkOntologyTool({ ctx, userId: 'u1' });
    const bad = await t.execute!({ relation: 'REVERSE_ORIGIN', fromId: blue, toId: red, amount: 10_000 }, CALL);
    expect(bad.status).toBe('invalid');
    const ok = await t.execute!({ relation: 'REVERSE_ORIGIN', fromId: red, toId: blue, amount: 10_000, reason: '开票有误' }, CALL);
    expect(ok.status).toBe('ok');
  });

  it('连接对白名单：FEEDS_INTO 不允许 PaymentEvent -> SettlementEvent', async () => {
    const p = await insertFact('InvoiceEvent',
      { eventBizType: '正向', amount: 1, currency: 'CNY', invoiceNo: 'INV-X', invoiceType: '销项' });
    // 用 PaymentEvent 起点更直接：
    const pay = await insertTradeFact(ctx, {
      entityType: 'PaymentEvent',
      payload: { eventBizType: '正向', amount: 1, currency: 'CNY', payType: '预付' },
      validAt: '2026-06-01', createdBy: 'test',
    }, 'u1');
    const settle = await insertFact('SettlementEvent',
      { eventBizType: '正向', amount: 1, currency: 'CNY', settledQuantity: 1, unit: '吨' });
    const t = buildLinkOntologyTool({ ctx, userId: 'u1' });
    const out = await t.execute!({ relation: 'FEEDS_INTO', fromId: pay, toId: settle }, CALL);
    expect(out.status).toBe('invalid');
    if (out.status !== 'invalid') return;
    expect(out.detail).toContain('不允许');
    void p;
  });

  it('ALLOCATE_TO 终点合同不存在 -> invalid', async () => {
    const sid = await insertFact('ServiceCostEvent',
      { eventBizType: '正向', amount: 1, currency: 'CNY', costType: '物流' });
    const t = buildLinkOntologyTool({ ctx, userId: 'u1' });
    const out = await t.execute!({ relation: 'ALLOCATE_TO', fromId: sid, toId: 'C-404', amount: 1, method: '金额' }, CALL);
    expect(out.status).toBe('invalid');
    if (out.status !== 'invalid') return;
    expect(out.detail).toContain('C-404');
  });

  it('params strict：辅助关系带 amount 被注册表拒绝（整单拒绝零落库）', async () => {
    const s = await insertFact('ServiceCostEvent',
      { eventBizType: '正向', amount: 1, currency: 'CNY', costType: '物流' });
    const p = await insertTradeFact(ctx, {
      entityType: 'PaymentEvent',
      payload: { eventBizType: '正向', amount: 1, currency: 'CNY', payType: '预付' },
      validAt: '2026-06-01', createdBy: 'test',
    }, 'u1');
    const t = buildLinkOntologyTool({ ctx, userId: 'u1' });
    const out = await t.execute!({ relation: 'TRIGGERS', fromId: s, toId: p, amount: 1 }, CALL);
    expect(out.status).toBe('invalid');
    const edges = await listOntologyEdgesAsOf(ctx, asOfBusinessTime(new Date().toISOString()), {}, 'u1');
    expect(edges).toHaveLength(0);
  });

  it('PROVIDE：对手方主数据 -> 服务费（对端为事实 id）', async () => {
    const cp = await insertTradeFact(ctx, {
      entityType: 'Counterparty',
      payload: { uscc: '91130000MA0A0000XB', name: '唐山物流有限公司', role: '服务商' },
      validAt: '2026-01-01', createdBy: 'test',
    }, 'u1');
    const s = await insertFact('ServiceCostEvent',
      { eventBizType: '正向', amount: 1, currency: 'CNY', costType: '物流' });
    const t = buildLinkOntologyTool({ ctx, userId: 'u1' });
    const out = await t.execute!({ relation: 'PROVIDE', fromId: cp, toId: s }, CALL);
    expect(out.status).toBe('ok');
  });

  it('词表含 PARENT_OF/DELIVERED_AS（spec 主体身份 2026-09-09：10 关系中除核销/冲抵外全覆盖）', () => {
    const t = buildLinkOntologyTool({ ctx, userId: 'u1' });
    const shape = t.inputSchema.shape as { relation: { options: readonly string[] } };
    expect(shape.relation.options).toContain('PARENT_OF');
    expect(shape.relation.options).toContain('DELIVERED_AS');
    expect(shape.relation.options).toHaveLength(8);
  });

  it('PARENT_OF：母公司 -> 子公司（Counterparty 事实对），ratio 落库', async () => {
    const parent = await insertTradeFact(ctx, {
      entityType: 'Counterparty',
      payload: { uscc: '91130000MA0A0000XC', name: '某控股集团', role: '客户' },
      validAt: '2026-01-01', createdBy: 'test',
    }, 'u1');
    const child = await insertTradeFact(ctx, {
      entityType: 'Counterparty',
      payload: { uscc: '91130000MA0A0000XD', name: '某钢铁子公司', role: '供应商' },
      validAt: '2026-01-01', createdBy: 'test',
    }, 'u1');
    const t = buildLinkOntologyTool({ ctx, userId: 'u1' });
    const out = await t.execute!({
      relation: 'PARENT_OF', fromId: parent, toId: child, ratio: 0.6, note: '控股',
    }, CALL);
    expect(out.status).toBe('ok');
    const edges = await listOntologyEdgesAsOf(ctx, asOfBusinessTime(new Date().toISOString()), { relation: 'PARENT_OF' }, 'u1');
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({
      relation: 'PARENT_OF', fromType: 'Counterparty', fromId: parent,
      toType: 'Counterparty', toId: child, createdBy: 'link_ontology',
    });
    expect(edges[0]!.params).toMatchObject({ ratio: 0.6, note: '控股' });
  });

  it('PARENT_OF 连接对白名单：Counterparty -> InvoiceEvent 拒绝', async () => {
    const cp = await insertTradeFact(ctx, {
      entityType: 'Counterparty',
      payload: { uscc: '91130000MA0A0000XC', name: '某控股集团', role: '客户' },
      validAt: '2026-01-01', createdBy: 'test',
    }, 'u1');
    const inv = await insertFact('InvoiceEvent',
      { eventBizType: '正向', amount: 1, currency: 'CNY', invoiceNo: 'INV-P', invoiceType: '销项' });
    const t = buildLinkOntologyTool({ ctx, userId: 'u1' });
    const out = await t.execute!({ relation: 'PARENT_OF', fromId: cp, toId: inv }, CALL);
    expect(out.status).toBe('invalid');
    if (out.status !== 'invalid') return;
    expect(out.detail).toContain('不允许');
  });

  it('DELIVERED_AS：收货事实 -> 商品 SKU 事实，batch 落库', async () => {
    const receipt = await insertTradeFact(ctx, {
      entityType: 'GoodsReceiptEvent',
      payload: { eventBizType: '正向', quantity: 100, unit: '吨' },
      validAt: '2026-06-01', createdBy: 'test',
    }, 'u1');
    const goods = await insertTradeFact(ctx, {
      entityType: 'TradeGoods',
      payload: { name: '螺纹钢', commodityCode: 'HRB400E', spec: 'HRB400E Φ12mm 9m定尺' },
      validAt: '2026-06-01', createdBy: 'test',
    }, 'u1');
    const t = buildLinkOntologyTool({ ctx, userId: 'u1' });
    const out = await t.execute!({
      relation: 'DELIVERED_AS', fromId: receipt, toId: goods, batch: 'SIF1234-20260901',
    }, CALL);
    expect(out.status).toBe('ok');
    const edges = await listOntologyEdgesAsOf(ctx, asOfBusinessTime(new Date().toISOString()), { relation: 'DELIVERED_AS' }, 'u1');
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({
      relation: 'DELIVERED_AS', fromType: 'GoodsReceiptEvent', fromId: receipt,
      toType: 'TradeGoods', toId: goods,
    });
    expect(edges[0]!.params).toMatchObject({ batch: 'SIF1234-20260901' });
  });
});
