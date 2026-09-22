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

  it('侧别无法判定合同: 侧向项值照算 + missingInputs 标注合同号(W4-R1)', async () => {
    await seedGolden();
    // 追加 contract_type='框架'(开放词不命中销/采购)的合同 + 收货事实
    insertContract('CL-U', 'CON-FW', '框架');
    const rcpt = await insertTradeFact(ctx, {
      entityType: 'GoodsReceiptEvent',
      payload: { eventBizType: '正向', quantity: 100, amount: 999, currency: 'CNY', unit: '吨' },
      validAt: '2026-09-08T00:00:00Z', createdBy: 'golden',
    }, 'u1');
    await insertOntologyEdge(ctx, {
      relation: 'ALLOCATE_TO', fromType: 'GoodsReceiptEvent', fromId: rcpt,
      toType: 'TradeContract', toId: 'CL-U',
      params: { quantity: 100, method: '数量' }, validAt: '2026-09-08T00:00:00Z', createdBy: 'golden',
    }, 'u1');
    const rep = await computeGaps(ctx, {}, 'u1');
    const item = (code: string) => rep.groups.flatMap((g) => g.items).find((i) => i.code === code)!;
    // ② 值照算(未知侧收货不计入购侧合计, 保持 756,000), 但 missingInputs 提示口径缺
    expect(item('②').amt).toBe(756_000);
    expect(item('②').missingInputs?.some((m) => m.includes('CON-FW'))).toBe(true);
    // ① 全局 qty 不受侧别影响(1600+100−390=1310, R18 全局口径)
    expect(item('①').qty).toBe(1310);
  });

  it('contract_type 同时含购/销词(购销合同): 判 sideUnknown 不猜侧(W5 收尾)', async () => {
    await seedGolden();
    // 购销合同: 既有购词又有销词, 不得任一先命中就定侧(旧 sideOf 先判 销 -> sell)。
    insertContract('CL-MIX', 'CON-MIX', '购销合同');
    const rcpt = await insertTradeFact(ctx, {
      entityType: 'GoodsReceiptEvent',
      payload: { eventBizType: '正向', quantity: 100, amount: 999, currency: 'CNY', unit: '吨' },
      validAt: '2026-09-08T00:00:00Z', createdBy: 'golden',
    }, 'u1');
    await insertOntologyEdge(ctx, {
      relation: 'ALLOCATE_TO', fromType: 'GoodsReceiptEvent', fromId: rcpt,
      toType: 'TradeContract', toId: 'CL-MIX',
      params: { quantity: 100, method: '数量' }, validAt: '2026-09-08T00:00:00Z', createdBy: 'golden',
    }, 'u1');
    const dly = await insertTradeFact(ctx, {
      entityType: 'GoodsDeliveryEvent',
      payload: { eventBizType: '正向', quantity: 50, amount: 500, currency: 'CNY', unit: '吨' },
      validAt: '2026-09-08T00:00:00Z', createdBy: 'golden',
    }, 'u1');
    await insertOntologyEdge(ctx, {
      relation: 'ALLOCATE_TO', fromType: 'GoodsDeliveryEvent', fromId: dly,
      toType: 'TradeContract', toId: 'CL-MIX',
      params: { quantity: 50, amount: 500, method: '金额' }, validAt: '2026-09-08T00:00:00Z', createdBy: 'golden',
    }, 'u1');
    const rep = await computeGaps(ctx, {}, 'u1');
    const item = (code: string) => rep.groups.flatMap((g) => g.items).find((i) => i.code === code)!;
    // ③ 已发货未结算(销侧): CON-MIX 侧别不明 -> 其发货 500 不计入销侧合计
    // (若旧逻辑误定 sell, ③=176,500; 修复后 ③ 保持金标准 176,000)。
    expect(item('③').amt).toBe(176_000);
    expect(item('③').missingInputs?.some((m) => m.includes('CON-MIX'))).toBe(true);
    // ② 已收货未结算(购侧): 同款口径提示, 且未知侧收货不计入购侧合计。
    expect(item('②').amt).toBe(756_000);
    expect(item('②').missingInputs?.some((m) => m.includes('CON-MIX'))).toBe(true);
  });

  it('EPSILON 近零: ⑩ 差 0.001 -> 展示 0(W4-R1)', async () => {
    insertContract('CL-NZ', 'CON-NZ', '采购');
    const rcpt = await insertTradeFact(ctx, {
      entityType: 'GoodsReceiptEvent',
      payload: { eventBizType: '正向', quantity: 100, amount: 1000, currency: 'CNY' },
      validAt: '2026-09-01T00:00:00Z', createdBy: 't',
    }, 'u1');
    await insertOntologyEdge(ctx, {
      relation: 'ALLOCATE_TO', fromType: 'GoodsReceiptEvent', fromId: rcpt,
      toType: 'TradeContract', toId: 'CL-NZ',
      params: { quantity: 100, method: '数量' }, validAt: '2026-09-01T00:00:00Z', createdBy: 't',
    }, 'u1');
    await insertTradeFact(ctx, {
      entityType: 'InvoiceEvent',
      payload: { eventBizType: '正向', amount: 999.999, currency: 'CNY', invoiceNo: 'INV-NZ', invoiceType: '进项', contractNo: 'CON-NZ' },
      validAt: '2026-09-02T00:00:00Z', createdBy: 't',
    }, 'u1');
    await insertTradeFact(ctx, {
      entityType: 'PaymentEvent',
      payload: { eventBizType: '正向', amount: 1000, currency: 'CNY', payType: '尾款', contractNo: 'CON-NZ' },
      validAt: '2026-09-03T00:00:00Z', createdBy: 't',
    }, 'u1');
    const rep = await computeGaps(ctx, {}, 'u1');
    const item = (code: string) => rep.groups.flatMap((g) => g.items).find((i) => i.code === code)!;
    // ⑩ = |1000 − 999.999| = 0.001 < EPSILON -> 展示 0
    expect(item('⑩').amt).toBe(0);
  });
});

describe('gaps contracts 下钻(W8 T2): 逐合同行 + 合同号命名兜底锁定', () => {
  it('金标准多合同: contracts[] 每行数字/side 正确, 合同号显示 contract_no 而非行 id, 稳定排序', async () => {
    await seedGolden();
    const rep = await computeGaps(ctx, {}, 'u1');
    expect(Array.isArray(rep.contracts)).toBe(true);
    expect(rep.contracts).toHaveLength(2);
    // 排序: |settlements+invoicesIn+invoicesOut| 降序 (CON-0817 购侧 4,888,000 > CON-0512 销侧 1,117,200)
    expect(rep.contracts[0]!.contractNo).toBe('CON-0817');
    expect(rep.contracts[1]!.contractNo).toBe('CON-0512');
    // 合同号必须是 contract_no, 绝非 CL- 行 id(锁定 projection 映射)
    expect(rep.contracts.every((r) => !r.contractNo.startsWith('CL-'))).toBe(true);
    // 购侧 CON-0817
    const buy = rep.contracts.find((r) => r.contractNo === 'CON-0817')!;
    expect(buy.side).toBe('buy');
    expect(buy.receiptsQty).toBe(1600);
    expect(buy.deliveriesQty).toBe(0);
    expect(buy.settlements).toBe(2_444_000);
    expect(buy.invoicesIn).toBe(2_444_000);
    expect(buy.invoicesOut).toBe(0);
    expect(buy.payments).toBe(2_616_000); // 预付 1,158,000 + 尾款 1,544,000 − 退款 86,000
    expect(buy.collections).toBe(0);
    expect(buy.receiptsQtyMissing).toBe(false);
    expect(buy.paymentsMissing).toBe(false);
    // 销侧 CON-0512
    const sell = rep.contracts.find((r) => r.contractNo === 'CON-0512')!;
    expect(sell.side).toBe('sell');
    expect(sell.deliveriesQty).toBe(390);
    expect(sell.receiptsQty).toBe(0);
    expect(sell.settlements).toBe(588_000);
    expect(sell.invoicesOut).toBe(529_200); // 销项 588,000 − 红冲 58,800
    expect(sell.invoicesIn).toBe(0);
    expect(sell.collections).toBe(588_000);
    expect(sell.payments).toBe(0);
    expect(sell.deliveriesQtyMissing).toBe(false);
  });

  it('missing 标志: 收货缺数量 -> receiptsQtyMissing=true(注册表禁造无金额付款, paymentsMissing 为防御位)', async () => {
    insertContract('CL-M', 'CON-M', '采购');
    // 收货: 有金额无数量 -> receiptsQtyMissing
    const rcpt = await insertTradeFact(ctx, {
      entityType: 'GoodsReceiptEvent',
      payload: { eventBizType: '正向', amount: 1000, currency: 'CNY', unit: '吨' },
      validAt: '2026-09-01T00:00:00Z', createdBy: 't',
    }, 'u1');
    await insertOntologyEdge(ctx, {
      relation: 'ALLOCATE_TO', fromType: 'GoodsReceiptEvent', fromId: rcpt,
      toType: 'TradeContract', toId: 'CL-M',
      params: { amount: 1000, method: '金额' }, validAt: '2026-09-01T00:00:00Z', createdBy: 't',
    }, 'u1');
    const rep = await computeGaps(ctx, {}, 'u1');
    const row = rep.contracts.find((r) => r.contractNo === 'CON-M')!;
    expect(row.side).toBe('buy');
    expect(row.receiptsQtyMissing).toBe(true);
    expect(row.deliveriesQtyMissing).toBe(false);
    expect(row.paymentsMissing).toBe(false);
  });

  it('projectNo 范围: contracts[] 只含范围内合同(BELONGS_TO)', async () => {
    await seedGolden();
    const proj = await insertTradeFact(ctx, {
      entityType: 'TradeProject',
      payload: { projectNo: 'PRJ-1', name: '年度采购' },
      validAt: '2026-09-01T00:00:00Z', createdBy: 't',
    }, 'u1');
    await insertOntologyEdge(ctx, {
      relation: 'BELONGS_TO', fromType: 'TradeContract', fromId: 'CL-1',
      toType: 'TradeProject', toId: proj,
      params: {}, validAt: '2026-09-01T00:00:00Z', createdBy: 't',
    }, 'u1');
    const rep = await computeGaps(ctx, { projectNo: 'PRJ-1' }, 'u1');
    expect(rep.contracts).toHaveLength(1);
    expect(rep.contracts[0]!.contractNo).toBe('CON-0817');
  });
});
