// apps/server/test/ontology/projection.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { createDb, migrate, type DbContext } from '../../src/pipeline/db/client.js';
import { listProjectedEntities, getProjectedEntityDetail, businessKeyOf } from '../../src/ontology/projection.js';
import { insertTradeFact, insertOntologyEdge, supersedeTradeFact, listTradeFactHistory } from '../../src/ontology/repo.js';

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

  it('amountMin/amountMax 过滤排除无金额行（数量-only 收货不进金额过滤结果）', async () => {
    await insertTradeFact(ctx, {
      entityType: 'GoodsReceiptEvent',
      payload: { eventBizType: '正向', quantity: 100, unit: '吨' },
      validAt: '2026-06-15', createdBy: 't',
    }, 'u1');
    await insertTradeFact(ctx, {
      entityType: 'GoodsReceiptEvent',
      payload: { eventBizType: '正向', amount: 500, currency: 'CNY' },
      validAt: '2026-06-15', createdBy: 't',
    }, 'u1');
    const res = await listProjectedEntities(ctx, 'GoodsReceiptEvent', { amountMin: 100 }, 'u1');
    expect(res.total).toBe(1);
    expect(res.items[0]!.fields['amount']).toBe(500);
    expect(res.items[0]!.fields['quantity']).toBeUndefined();
  });

  it('types without a source return an empty page, not error (acceptance 4)', async () => {
    const res = await listProjectedEntities(ctx, 'TradeGoods', {}, 'u1');
    expect(res).toEqual({ items: [], total: 0, page: 1, pageSize: 20 });
  });
});

// ---------------------------------------------------------------------------
// 字段映射 v2(2026-09-23): fields 中文开放键 -> 注册表词汇。
// 候选键/值形态均取自 dev 库 contract_ledger.fields 实测样本。
// ---------------------------------------------------------------------------

const insertContractWithFields = (
  id: string, contractNo: string, contractType: string | null,
  fields: Record<string, unknown>, title = '',
) => {
  ctx.sqlite.prepare(
    `INSERT INTO contract_ledger (id, contract_no, display_contract_no, doc_type, document_id,
        title, fields, field_meta, overall_confidence, needs_review, user_id, contract_type)
     VALUES (?, ?, ?, '合同', 'doc-f', ?, ?, '{}', 1, 0, 'u1', ?)`,
  ).run(id, contractNo, contractNo, title, JSON.stringify(fields), contractType);
};

describe('projection: TradeContract 字段映射 v2 (fields 中文键 -> 注册表词汇)', () => {
  it('买卖双方: 买方/卖方直取, 缺失时回退 甲方/乙方 及变体键', async () => {
    insertContractWithFields('F1', 'HT-F1', null, {
      买方: { value: '华能荆门热电有限责任公司', sourceSpans: [] },
      卖方: { value: '浩吉铁路经营开发有限公司', sourceSpans: [] },
    });
    insertContractWithFields('F2', 'HT-F2', null, {
      甲方: { value: '甲方公司', sourceSpans: [] },
      乙方: { value: '乙方公司', sourceSpans: [] },
    });
    insertContractWithFields('F3', 'HT-F3', null, {
      '买受人（买方）': { value: '买受方公司', sourceSpans: [] },
      '出卖人（卖方）': { value: '出卖方公司', sourceSpans: [] },
    });
    const res = await listProjectedEntities(ctx, 'TradeContract', {}, 'u1');
    const byId = new Map(res.items.map((e) => [e.id, e.fields]));
    expect(byId.get('F1')!.buyerName).toBe('华能荆门热电有限责任公司');
    expect(byId.get('F1')!.sellerName).toBe('浩吉铁路经营开发有限公司');
    expect(byId.get('F2')!.buyerName).toBe('甲方公司');
    expect(byId.get('F2')!.sellerName).toBe('乙方公司');
    expect(byId.get('F3')!.buyerName).toBe('买受方公司');
    expect(byId.get('F3')!.sellerName).toBe('出卖方公司');
  });

  it('签约日期: 年月日/ISO/区间串归一为 ISO; 不完整日期不产出', async () => {
    insertContractWithFields('D1', 'HT-D1', null, {
      签订日期: { value: '2025年3月11日', sourceSpans: [] },
    });
    insertContractWithFields('D2', 'HT-D2', null, {
      签约时间: { value: '2022-08-07', sourceSpans: [] },
    });
    insertContractWithFields('D3', 'HT-D3', null, {
      签订日期: { value: '2022年 月 日', sourceSpans: [] },
    });
    // 键序优先: 签订日期 命中后不再取 签约时间
    insertContractWithFields('D4', 'HT-D4', null, {
      签订日期: { value: '2025年09月09日', sourceSpans: [] },
      签约时间: { value: '2025年10月10日', sourceSpans: [] },
    });
    const res = await listProjectedEntities(ctx, 'TradeContract', {}, 'u1');
    const byId = new Map(res.items.map((e) => [e.id, e.fields]));
    expect(byId.get('D1')!.signDate).toBe('2025-03-11');
    expect(byId.get('D2')!.signDate).toBe('2022-08-07');
    expect(byId.get('D3')!.signDate).toBeUndefined();
    expect(byId.get('D4')!.signDate).toBe('2025-09-09');
  });

  it('到期日期: 点值直取, 区间串取终点, 纯文本无日期不产出', async () => {
    insertContractWithFields('E1', 'HT-E1', null, {
      合同有效期截止: { value: '2022-08-16', sourceSpans: [] },
    });
    insertContractWithFields('E2', 'HT-E2', null, {
      合同有效期: { value: '自2022-08-07起至2022-08-16止', sourceSpans: [] },
    });
    insertContractWithFields('E3', 'HT-E3', null, {
      合同有效期限: { value: '2025年03月20日至2025年12月31日', sourceSpans: [] },
    });
    insertContractWithFields('E4', 'HT-E4', null, {
      协议有效期: { value: '自本协议生效之日起至双方权利义务履行完毕止', sourceSpans: [] },
    });
    const res = await listProjectedEntities(ctx, 'TradeContract', {}, 'u1');
    const byId = new Map(res.items.map((e) => [e.id, e.fields]));
    expect(byId.get('E1')!.expireDate).toBe('2022-08-16');
    expect(byId.get('E2')!.expireDate).toBe('2022-08-16');
    expect(byId.get('E3')!.expireDate).toBe('2025-12-31');
    expect(byId.get('E4')!.expireDate).toBeUndefined();
  });

  it('合同金额: 总价族数值化(含千分位/单位); 单价族键不映射', async () => {
    insertContractWithFields('A1', 'HT-A1', null, {
      总金额: { value: '24761756.81', sourceSpans: [] },
    });
    insertContractWithFields('A2', 'HT-A2', null, {
      含税结算总价: { value: 5095620.96, sourceSpans: [] },
    });
    insertContractWithFields('A3', 'HT-A3', null, {
      合计含税总价_元: { value: '1,234,567.89元', sourceSpans: [] },
    });
    insertContractWithFields('A4', 'HT-A4', null, {
      合同价格: { value: '958.7元/吨', sourceSpans: [] },
      合同价: { value: '16931', sourceSpans: [] },
    });
    const res = await listProjectedEntities(ctx, 'TradeContract', {}, 'u1');
    const byId = new Map(res.items.map((e) => [e.id, e.fields]));
    expect(byId.get('A1')!.contractAmount).toBe(24761756.81);
    expect(byId.get('A2')!.contractAmount).toBe(5095620.96);
    expect(byId.get('A3')!.contractAmount).toBe(1234567.89);
    expect(byId.get('A4')!.contractAmount).toBeUndefined();
  });

  it('币种: fields 包装值解包(v1 探测包装对象恒失败的回归测试)', async () => {
    insertContractWithFields('CU1', 'HT-CU1', null, {
      币种: { value: 'CNY', sourceSpans: [] },
    });
    const res = await listProjectedEntities(ctx, 'TradeContract', {}, 'u1');
    expect(res.items[0]!.fields['currency']).toBe('CNY');
  });

  it('direction: contract_type 的方向子集(采购/销售)透传, 非方向类型不产出', async () => {
    insertContractWithFields('DR1', 'HT-DR1', '采购', {});
    insertContractWithFields('DR2', 'HT-DR2', '销售', {});
    insertContractWithFields('DR3', 'HT-DR3', '物流', {});
    const res = await listProjectedEntities(ctx, 'TradeContract', {}, 'u1');
    const byId = new Map(res.items.map((e) => [e.id, e.fields]));
    expect(byId.get('DR1')!.direction).toBe('采购');
    expect(byId.get('DR2')!.direction).toBe('销售');
    expect(byId.get('DR3')!.direction).toBeUndefined();
  });

  it('title: 台账列为空时读侧兜底 fields.合同名称/标的物', async () => {
    insertContractWithFields('T1', 'HT-T1', null, {
      合同名称: { value: '煤炭买卖合同（市场）', sourceSpans: [] },
    });
    const res = await listProjectedEntities(ctx, 'TradeContract', {}, 'u1');
    expect(res.items[0]!.fields['title']).toBe('煤炭买卖合同（市场）');
  });

  it('货转单样例(dev 实测形态): 只有单据级字段也能填充本体列', async () => {
    insertContractWithFields('W1', '202609YY1586850250', null, {
      买方: { value: '华能荆门热电有限责任公司', sourceSpans: [] },
      卖方: { value: '浩吉铁路经营开发有限公司', sourceSpans: [] },
      合同号: { value: '202609YY1586850250', sourceSpans: [] },
      合计含税总价_元: { value: '3519600', sourceSpans: [] },
      交货日期: { value: '2026年9月10日', sourceSpans: [] },
    });
    const res = await listProjectedEntities(ctx, 'TradeContract', {}, 'u1');
    const f = res.items[0]!.fields;
    expect(f['buyerName']).toBe('华能荆门热电有限责任公司');
    expect(f['sellerName']).toBe('浩吉铁路经营开发有限公司');
    expect(f['contractAmount']).toBe(3519600);
    // 交货日期 != 签约日期, 不得映射 signDate
    expect(f['signDate']).toBeUndefined();
  });

  it('收/发货事件可读 label(2026-09-23): 方向+数量单位+日期, 替代裸 TF id', async () => {
    await insertTradeFact(ctx, {
      entityType: 'GoodsReceiptEvent',
      payload: { eventBizType: '正向', quantity: 3021.6, unit: '吨' },
      validAt: '2026-09-12T00:00:00.000Z', createdBy: 'materializer',
    }, 'u1');
    await insertTradeFact(ctx, {
      entityType: 'GoodsDeliveryEvent',
      payload: { eventBizType: '正向', quantity: 800, unit: '吨' },
      validAt: '2026-09-15T00:00:00.000Z', createdBy: 'materializer',
    }, 'u1');
    await insertTradeFact(ctx, {
      // 数量缺失(amount/currency 配对合法): label 退 方向+日期
      entityType: 'GoodsReceiptEvent',
      payload: { eventBizType: '正向', quantity: 5, unit: '吨' },
      validAt: '2026-09-18T00:00:00.000Z', createdBy: 'materializer',
    }, 'u1');
    const res = await listProjectedEntities(ctx, 'GoodsReceiptEvent', {}, 'u1');
    expect(res.items.some((e) => e.label === '收货 3021.6吨 2026-09-12')).toBe(true);
    const del = await listProjectedEntities(ctx, 'GoodsDeliveryEvent', {}, 'u1');
    expect(del.items.some((e) => e.label === '发货 800吨 2026-09-15')).toBe(true);
    // 其余实体不受影响: 付款事件 label 仍是业务键(contractNo)
    await insertTradeFact(ctx, {
      entityType: 'PaymentEvent',
      payload: { eventBizType: '正向', amount: 100, currency: 'CNY', payType: '预付', contractNo: 'HT-L1' },
      validAt: '2026-09-12', createdBy: 't',
    }, 'u1');
    const pay = await listProjectedEntities(ctx, 'PaymentEvent', {}, 'u1');
    expect(pay.items[0]!.label).toBe('HT-L1');
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

  it('数量-only 收货详情：timeline 有行但 netAmount 为 null（SUM 跳过无金额行，前端显示 —）', async () => {
    const id = await insertTradeFact(ctx, {
      entityType: 'GoodsReceiptEvent',
      payload: { eventBizType: '正向', quantity: 100, unit: '吨' },
      validAt: '2026-06-15', createdBy: 't',
    }, 'u1');
    const d = await getProjectedEntityDetail(ctx, 'GoodsReceiptEvent', id, {}, 'u1');
    expect(d!.timeline).toHaveLength(1);
    expect(d!.netAmount).toBeNull();
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

describe('projection: EntityDetail.relations (P4 关系可见性配套)', () => {
  it('returns edges touching the fact, both directions, with counterpart labels', async () => {
    insertContract('C1', 'HT-1', '采购');
    const svc = await insertTradeFact(ctx, {
      entityType: 'ServiceCostEvent',
      payload: { eventBizType: '正向', amount: 15_000, currency: 'CNY', costType: '物流' },
      validAt: '2026-06-01', createdBy: 'test',
    }, 'u1');
    const pay = await insertTradeFact(ctx, {
      entityType: 'PaymentEvent',
      payload: { eventBizType: '正向', amount: 15_000, currency: 'CNY', payType: '预付' },
      validAt: '2026-06-02', createdBy: 'test',
    }, 'u1');
    await insertOntologyEdge(ctx, {
      relation: 'ALLOCATE_TO', fromType: 'ServiceCostEvent', fromId: svc,
      toType: 'TradeContract', toId: 'C1',
      params: { amount: 15_000, method: '金额' }, validAt: '2026-06-01', createdBy: 'test',
    }, 'u1');
    await insertOntologyEdge(ctx, {
      relation: 'TRIGGERS', fromType: 'ServiceCostEvent', fromId: svc,
      toType: 'PaymentEvent', toId: pay,
      params: {}, validAt: '2026-06-02', createdBy: 'test',
    }, 'u1');

    const d = await getProjectedEntityDetail(ctx, 'ServiceCostEvent', svc, {}, 'u1');
    expect(d!.relations).toHaveLength(2);
    const alloc = d!.relations.find((r) => r.relation === 'ALLOCATE_TO')!;
    expect(alloc.direction).toBe('out');
    expect(alloc.counterpart).toMatchObject({ type: 'TradeContract', id: 'C1', label: 'HT-1', resolved: true });
    expect(alloc.params).toMatchObject({ amount: 15_000 });

    const trg = d!.relations.find((r) => r.relation === 'TRIGGERS')!;
    expect(trg.direction).toBe('out');
    expect(trg.counterpart.type).toBe('PaymentEvent');

    // 反向视角: 合同详情能看到入边, 对端标签=服务费业务键(costType 无业务键则 id)
    const dc = await getProjectedEntityDetail(ctx, 'TradeContract', 'C1', {}, 'u1');
    expect(dc!.relations).toHaveLength(1);
    expect(dc!.relations[0]).toMatchObject({ relation: 'ALLOCATE_TO', direction: 'in' });
    expect(dc!.relations[0]!.counterpart.type).toBe('ServiceCostEvent');
  });
});

describe('projection: Counterparty 台账归一 + 名称史 (spec 主体身份 §5)', () => {
  const party = (name: string, uscc: string, role = '供应商') => ({
    entityType: 'Counterparty' as const,
    payload: { uscc, name, role },
  });

  async function seedRenamedParty() {
    // 1/1 登记「某钢铁有限公司」, 9/1 更名「某钢铁集团股份有限公司」(supersede 换代)
    const oldId = await insertTradeFact(ctx, {
      ...party('某钢铁有限公司', '91130000MA0A0000XA'),
      validAt: '2026-01-01', ingestedAt: '2026-01-01', createdBy: 'manual',
    }, 'u1');
    const { newId } = await supersedeTradeFact(ctx, {
      prevFactId: oldId,
      next: {
        ...party('某钢铁集团股份有限公司', '91130000MA0A0000XA'),
        validAt: '2026-09-01', ingestedAt: '2026-09-01', createdBy: 'master-data-change',
      },
    }, 'u1');
    return { oldId, newId };
  }

  it('更名后列表 1 组：label=现行名, formerNames 含旧名, meta.uscc', async () => {
    const { newId } = await seedRenamedParty();
    const res = await listProjectedEntities(ctx, 'Counterparty', {}, 'u1');
    expect(res.total).toBe(1);
    const row = res.items[0]!;
    expect(row.id).toBe(newId);
    expect(row.label).toBe('某钢铁集团股份有限公司');
    expect(row.fields['formerNames']).toEqual(['某钢铁有限公司']);
    expect(row.meta?.['uscc']).toBe('91130000MA0A0000XA');
  });

  it('q 搜旧名命中该组（现名与曾用名双通道）', async () => {
    await seedRenamedParty();
    const byOld = await listProjectedEntities(ctx, 'Counterparty', { q: '某钢铁有限' }, 'u1');
    expect(byOld.total).toBe(1);
    expect(byOld.items[0]!.label).toBe('某钢铁集团股份有限公司');
    const byNew = await listProjectedEntities(ctx, 'Counterparty', { q: '集团股份' }, 'u1');
    expect(byNew.total).toBe(1);
    const byNone = await listProjectedEntities(ctx, 'Counterparty', { q: '不存在字样' }, 'u1');
    expect(byNone.total).toBe(0);
  });

  it('详情：entity=现行事实, timeline=组内名称史(valid_at 升序, 失效行可辨)', async () => {
    const { oldId, newId } = await seedRenamedParty();
    const d = await getProjectedEntityDetail(ctx, 'Counterparty', newId, {}, 'u1');
    expect(d).not.toBeNull();
    expect(d!.entity.id).toBe(newId);
    expect(d!.entity.label).toBe('某钢铁集团股份有限公司');
    expect(d!.netAmount).toBeNull();
    expect(d!.timeline).toHaveLength(2);
    const [first, second] = d!.timeline;
    expect(first!.label).toBe('某钢铁有限公司');
    expect(first!.invalidAt).not.toBeNull(); // 失效行可辨 -> 前端曾用名徽标
    expect(first!.validAt).toBe('2026-01-01T00:00:00.000Z');
    expect(second!.label).toBe('某钢铁集团股份有限公司');
    expect(second!.invalidAt).toBeNull();
    void oldId;
  });

  it('详情用旧事实 id 打开同样归一到现行主体（entity=现行事实）', async () => {
    const { oldId, newId } = await seedRenamedParty();
    const d = await getProjectedEntityDetail(ctx, 'Counterparty', oldId, {}, 'u1');
    expect(d!.entity.id).toBe(newId);
    expect(d!.entity.label).toBe('某钢铁集团股份有限公司');
    expect(d!.timeline).toHaveLength(2);
  });

  it('更名前建的关系边仍在 relations（组内全部事实端点的边 union）', async () => {
    const { oldId, newId } = await seedRenamedParty();
    const svc = await insertTradeFact(ctx, {
      entityType: 'ServiceCostEvent',
      payload: { eventBizType: '正向', amount: 15_000, currency: 'CNY', costType: '物流' },
      validAt: '2026-02-01', createdBy: 'test',
    }, 'u1');
    await insertOntologyEdge(ctx, {
      relation: 'PROVIDE', fromType: 'Counterparty', fromId: oldId,
      toType: 'ServiceCostEvent', toId: svc,
      params: {}, validAt: '2026-02-01', createdBy: 'test',
    }, 'u1');
    // 用现行事实 id 打开详情: 更名前的边不丢
    const d = await getProjectedEntityDetail(ctx, 'Counterparty', newId, {}, 'u1');
    expect(d!.relations).toHaveLength(1);
    expect(d!.relations[0]).toMatchObject({ relation: 'PROVIDE', direction: 'out' });
    expect(d!.relations[0]!.counterpart.type).toBe('ServiceCostEvent');
  });

  it('无 uscc 的存量行保持独立行（不参与归一, 读路径容忍）', async () => {
    // uscc 必填只约束写入边界; 存量无 uscc 行用直写 SQL 模拟旧数据(读侧容忍不报错)。
    const legacy = (name: string, validAt: string) => {
      ctx.sqlite.prepare(
        `INSERT INTO trade_facts (id, entity_type, payload, valid_at, invalid_at, ingested_at, created_by, user_id, document_id)
         VALUES (?, 'Counterparty', ?, ?, NULL, ?, 'manual', 'u1', NULL)`,
      ).run(`TF-${name}`, JSON.stringify({ name, role: '供应商' }), validAt, validAt);
    };
    legacy('老数据甲', '2026-01-01T00:00:00.000Z');
    legacy('老数据乙', '2026-01-02T00:00:00.000Z');
    const res = await listProjectedEntities(ctx, 'Counterparty', {}, 'u1');
    expect(res.total).toBe(2);
    for (const row of res.items) {
      expect(row.fields['formerNames']).toBeUndefined();
      expect(row.meta?.['uscc']).toBeUndefined();
    }
  });

  it('listTradeFactHistory：同 uscc 全部事实含失效行, valid_at 升序, 用户隔离', async () => {
    const { oldId, newId } = await seedRenamedParty();
    const rows = await listTradeFactHistory(ctx, { entityType: 'Counterparty', uscc: '91130000MA0A0000XA' }, 'u1');
    expect(rows.map((r) => r.id)).toEqual([oldId, newId]);
    expect(await listTradeFactHistory(ctx, { entityType: 'Counterparty', uscc: '91130000MA0A0000XA' }, 'u2')).toEqual([]);
  });

  it('多主体多代更名：各组独立归一（2 主体 3 事实 -> 2 组）', async () => {
    const a1 = await insertTradeFact(ctx, {
      ...party('甲公司一期', 'USCC-A'), validAt: '2026-01-01', ingestedAt: '2026-01-01', createdBy: 'manual',
    }, 'u1');
    await supersedeTradeFact(ctx, {
      prevFactId: a1,
      next: {
        ...party('甲公司二期', 'USCC-A'),
        validAt: '2026-05-01', ingestedAt: '2026-05-01', createdBy: 'master-data-change',
      },
    }, 'u1');
    await insertTradeFact(ctx, {
      ...party('乙公司', 'USCC-B'), validAt: '2026-02-01', ingestedAt: '2026-02-01', createdBy: 'manual',
    }, 'u1');
    const res = await listProjectedEntities(ctx, 'Counterparty', {}, 'u1');
    expect(res.total).toBe(2);
    const jia = res.items.find((r) => r.label === '甲公司二期')!;
    expect(jia.fields['formerNames']).toEqual(['甲公司一期']);
  });
});

describe('businessKeyOf (registry-driven, wave1 decision 5)', () => {
  it('resolves first non-empty key per entity priority list', () => {
    expect(businessKeyOf('InvoiceEvent', { invoiceNo: 'INV-1', contractNo: 'C-1' })).toBe('INV-1');
    expect(businessKeyOf('InvoiceEvent', { contractNo: 'C-1' })).toBe('C-1');
    expect(businessKeyOf('ServiceCostEvent', { costType: '物流' })).toBe('物流');
    expect(businessKeyOf('TradeGoods', { name: '螺纹钢' })).toBe('螺纹钢');
  });
  it('returns null for entities without declared keys or empty payloads', () => {
    expect(businessKeyOf('PaymentEvent', { amount: 5 })).toBeNull();
    expect(businessKeyOf('SettlementEvent', { amount: 1, currency: 'CNY' })).toBeNull();
  });
});
