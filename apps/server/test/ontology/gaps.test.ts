// apps/server/test/ontology/gaps.test.ts
// 勾稽缺口聚合(Wave 4 Task 1, 对齐原型 reportGaps 金标准)。纯只读; :memory: + migrate。
// 金标准数字逐字断言(原型复现验收): 采购 CON-0817 + 销售 CON-0512 全量 facts/edges。
import { describe, it, expect, beforeEach } from 'vitest';
import { createDb, migrate, type DbContext } from '../../src/pipeline/db/client.js';
import { insertTradeFact, insertOntologyEdge } from '../../src/ontology/repo.js';
import { computeGaps } from '../../src/ontology/gaps.js';

let ctx: DbContext;
beforeEach(() => {
  ctx = createDb(':memory:');
  migrate(ctx.sqlite);
});

const insertContract = (id: string, contractNo: string, contractType: string) => {
  ctx.sqlite.prepare(
    `INSERT INTO contract_ledger (id, contract_no, display_contract_no, doc_type, document_id,
        title, fields, field_meta, overall_confidence, needs_review, user_id, contract_type)
     VALUES (?, ?, ?, '合同', 'doc-1', '', '{}', '{}', 1, 0, '', ?)`,
  ).run(id, contractNo, contractNo, contractType);
};

/** 金标准 seed: 采购 CON-0817 + 销售 CON-0512, 返回事实 id 供后续断言。 */
async function seedGolden(): Promise<void> {
  insertContract('CL-1', 'CON-0817', '采购');
  insertContract('CL-2', 'CON-0512', '销售');

  // 采购侧: 收货 qty1600/amt3,200,000(ALLOCATE_TO 数量边)
  const receipt = await insertTradeFact(ctx, {
    entityType: 'GoodsReceiptEvent',
    payload: { eventBizType: '正向', quantity: 1600, amount: 3_200_000, currency: 'CNY', unit: '吨' },
    validAt: '2026-09-01T00:00:00Z', createdBy: 'golden',
  }, 'u1');
  await insertOntologyEdge(ctx, {
    relation: 'ALLOCATE_TO', fromType: 'GoodsReceiptEvent', fromId: receipt,
    toType: 'TradeContract', toId: 'CL-1',
    params: { quantity: 1600, method: '数量' }, validAt: '2026-09-01T00:00:00Z', createdBy: 'golden',
  }, 'u1');
  // 采购结算 + 进项票 + 三条付款(预付 1,158,000 / 尾款 1,544,000 / 预付退款 -86,000)
  await insertTradeFact(ctx, {
    entityType: 'SettlementEvent',
    payload: { eventBizType: '正向', amount: 2_444_000, currency: 'CNY', contractNo: 'CON-0817' },
    validAt: '2026-09-02T00:00:00Z', createdBy: 'golden',
  }, 'u1');
  await insertTradeFact(ctx, {
    entityType: 'InvoiceEvent',
    payload: { eventBizType: '正向', amount: 2_444_000, currency: 'CNY', invoiceNo: 'INV-IN-1', invoiceType: '进项', contractNo: 'CON-0817' },
    validAt: '2026-09-03T00:00:00Z', createdBy: 'golden',
  }, 'u1');
  await insertTradeFact(ctx, {
    entityType: 'PaymentEvent',
    payload: { eventBizType: '正向', amount: 1_158_000, currency: 'CNY', payType: '预付', contractNo: 'CON-0817' },
    validAt: '2026-09-01T00:00:00Z', createdBy: 'golden',
  }, 'u1');
  await insertTradeFact(ctx, {
    entityType: 'PaymentEvent',
    payload: { eventBizType: '正向', amount: 1_544_000, currency: 'CNY', payType: '尾款', contractNo: 'CON-0817' },
    validAt: '2026-09-04T00:00:00Z', createdBy: 'golden',
  }, 'u1');
  await insertTradeFact(ctx, {
    entityType: 'PaymentEvent',
    payload: { eventBizType: '逆向', amount: -86_000, currency: 'CNY', payType: '预付', contractNo: 'CON-0817' },
    validAt: '2026-09-05T00:00:00Z', createdBy: 'golden',
  }, 'u1');

  // 销售侧: 发货 qty390/amt764,000(ALLOCATE_TO 数量+金额边) + 结算 + 销项红冲净 + 收款两条
  const delivery = await insertTradeFact(ctx, {
    entityType: 'GoodsDeliveryEvent',
    payload: { eventBizType: '正向', quantity: 390, amount: 764_000, currency: 'CNY', unit: '吨' },
    validAt: '2026-09-01T00:00:00Z', createdBy: 'golden',
  }, 'u1');
  await insertOntologyEdge(ctx, {
    relation: 'ALLOCATE_TO', fromType: 'GoodsDeliveryEvent', fromId: delivery,
    toType: 'TradeContract', toId: 'CL-2',
    params: { quantity: 390, amount: 764_000, method: '金额' }, validAt: '2026-09-01T00:00:00Z', createdBy: 'golden',
  }, 'u1');
  await insertTradeFact(ctx, {
    entityType: 'SettlementEvent',
    payload: { eventBizType: '正向', amount: 588_000, currency: 'CNY', contractNo: 'CON-0512' },
    validAt: '2026-09-02T00:00:00Z', createdBy: 'golden',
  }, 'u1');
  await insertTradeFact(ctx, {
    entityType: 'InvoiceEvent',
    payload: { eventBizType: '正向', amount: 588_000, currency: 'CNY', invoiceNo: 'INV-OUT-1', invoiceType: '销项', contractNo: 'CON-0512' },
    validAt: '2026-09-03T00:00:00Z', createdBy: 'golden',
  }, 'u1');
  await insertTradeFact(ctx, {
    entityType: 'InvoiceEvent',
    payload: { eventBizType: '逆向', amount: -58_800, currency: 'CNY', invoiceNo: 'INV-OUT-1', invoiceType: '销项', contractNo: 'CON-0512' },
    validAt: '2026-09-04T00:00:00Z', createdBy: 'golden',
  }, 'u1');
  await insertTradeFact(ctx, {
    entityType: 'CollectionEvent',
    payload: { eventBizType: '正向', amount: 300_000, currency: 'CNY', collectionType: '回款', contractNo: 'CON-0512' },
    validAt: '2026-09-05T00:00:00Z', createdBy: 'golden',
  }, 'u1');
  await insertTradeFact(ctx, {
    entityType: 'CollectionEvent',
    payload: { eventBizType: '正向', amount: 288_000, currency: 'CNY', collectionType: '回款', contractNo: 'CON-0512' },
    validAt: '2026-09-06T00:00:00Z', createdBy: 'golden',
  }, 'u1');
}

describe('computeGaps golden numbers (wave4, prototype reportGaps 复现)', () => {
  it('金标准: 11 项勾稽数字逐字断言 + 四 tiles', async () => {
    await seedGolden();
    const rep = await computeGaps(ctx, {}, 'u1');

    const item = (code: string) => rep.groups.flatMap((g) => g.items).find((i) => i.code === code)!;
    // ① 已采购未销售 qty(全局口径 R18)
    expect(item('①').qty).toBe(1210);
    // ② 已收货未结算
    expect(item('②').amt).toBe(756_000);
    // ③ 已发货未结算
    expect(item('③').amt).toBe(176_000);
    // ⑦ 结算未付(结算口径)
    expect(item('⑦').amt).toBe(900_000);
    // ⑧ 收货未付
    expect(item('⑧').amt).toBe(584_000);
    // ⑨ 收票未付(⑨=⑦)
    expect(item('⑨').amt).toBe(900_000);
    // ⑩ 付无票
    expect(item('⑩').amt).toBe(172_000);
    // ⑪ 收无票
    expect(item('⑪').amt).toBe(58_800);

    // tiles: 存货 qty / 应收(发货口径⑤) / 应付(结算口径⑦) / 错配(⑩+⑪)
    const tile = (key: string) => rep.tiles.find((t) => t.key === key)!;
    expect(tile('stock').qty).toBe(1210);
    expect(tile('recv').amt).toBe(176_000);
    expect(tile('pay').amt).toBe(900_000);
    expect(tile('mis').amt).toBe(230_800);

    // checks 数组逐项有说明
    expect(rep.checks.length).toBeGreaterThanOrEqual(8);
    expect(rep.checks.some((c) => c.startsWith('①'))).toBe(true);
  });

  it('缺 amt 收货: ② null + missingInputs 标注, 不造数', async () => {
    await seedGolden();
    // 追加一笔无金额收货(购侧) -> 购收金额不完整
    const noAmtReceipt = await insertTradeFact(ctx, {
      entityType: 'GoodsReceiptEvent',
      payload: { eventBizType: '正向', quantity: 50, unit: '吨' },
      validAt: '2026-09-07T00:00:00Z', createdBy: 'golden',
    }, 'u1');
    await insertOntologyEdge(ctx, {
      relation: 'ALLOCATE_TO', fromType: 'GoodsReceiptEvent', fromId: noAmtReceipt,
      toType: 'TradeContract', toId: 'CL-1',
      params: { quantity: 50, method: '数量' }, validAt: '2026-09-07T00:00:00Z', createdBy: 'golden',
    }, 'u1');
    const rep = await computeGaps(ctx, {}, 'u1');
    const item = (code: string) => rep.groups.flatMap((g) => g.items).find((i) => i.code === code)!;
    expect(item('②').amt).toBeNull();
    expect(item('②').missingInputs?.some((m) => m.includes('购收金额'))).toBe(true);
  });

  it('projectNo 过滤: 只聚合该项目的合同(BELONGS_TO 反查)', async () => {
    await seedGolden();
    const proj = await insertTradeFact(ctx, {
      entityType: 'TradeProject',
      payload: { projectNo: 'PRJ-1', name: '年度采购' },
      validAt: '2026-09-01T00:00:00Z', createdBy: 'golden',
    }, 'u1');
    // 采购合同 CON-0817 归属 PRJ-1
    await insertOntologyEdge(ctx, {
      relation: 'BELONGS_TO', fromType: 'TradeContract', fromId: 'CL-1',
      toType: 'TradeProject', toId: proj,
      params: {}, validAt: '2026-09-01T00:00:00Z', createdBy: 'golden',
    }, 'u1');
    const rep = await computeGaps(ctx, { projectNo: 'PRJ-1' }, 'u1');
    expect(rep.scope).toBe('PRJ-1');
    // 采购侧在范围内: ②/⑦ 仍为金标准值; 销侧不在范围: ③=0(无销发货)
    const item = (code: string) => rep.groups.flatMap((g) => g.items).find((i) => i.code === code)!;
    expect(item('②').amt).toBe(756_000);
    expect(item('⑦').amt).toBe(900_000);
    expect(item('③').amt).toBe(0);
  });
});