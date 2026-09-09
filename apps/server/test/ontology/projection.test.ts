// apps/server/test/ontology/projection.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { createDb, migrate, type DbContext } from '../../src/pipeline/db/client.js';
import { listProjectedEntities, getProjectedEntityDetail } from '../../src/ontology/projection.js';
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
