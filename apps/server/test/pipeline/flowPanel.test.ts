// 对账面板聚合(spec 2026-09-09 §15): buildFlowPanel 纯读聚合的单测。
// 数字必须有证据 id; 禁止推算性补数——缺数据输出 null/reason 而非编造。
import { describe, it, expect, beforeEach } from 'vitest';
import { createDb, migrate, type DbContext } from '../../src/pipeline/db/client.js';
import {
  upsertContractLedgerEntry, upsertExecutionFlow, insertSettlementRecord,
  saveGraphLink, type ExecutionFlowInput,
} from '../../src/pipeline/db/repositories.js';
import { insertTradeFact, insertOntologyEdge } from '../../src/ontology/repo.js';
import { listContractLedgerRefs } from '../../src/ontology/projection.js';
import { buildFlowPanel } from '../../src/pipeline/flowPanel.js';
import type { ContractLedgerEntry } from '../../src/pipeline/contractLedger.js';

let ctx: DbContext;
beforeEach(() => {
  ctx = createDb(':memory:');
  migrate(ctx.sqlite);
});

const f = (value: string | number) => ({ value, sourceSpans: [] as never[] });

async function seedLedger(no: string, userId: string, fields: Record<string, string | number> = {}) {
  const e: ContractLedgerEntry = {
    contractNo: no, displayContractNo: no, docType: '合同', documentId: `D-CT-${no}`,
    title: `${no} 标题`, contractType: '采购',
    fields: Object.fromEntries(
      Object.entries({ 合同号: no, ...fields }).map(([k, v]) => [k, f(v)]),
    ),
    fieldMeta: {}, overallConfidence: 1, needsReview: false, userId,
  };
  await upsertContractLedgerEntry(ctx, e, userId);
}

let flowSeq = 0;
async function seedFlow(p: Partial<ExecutionFlowInput> & { direction: 'in' | 'out'; docType: string }) {
  flowSeq += 1;
  await upsertExecutionFlow(ctx, {
    bindingId: p.bindingId ?? `B${flowSeq}`,
    documentId: p.documentId ?? 'D-FL',
    contractNo: p.contractNo ?? 'GMNH-TEST',
    flowType: p.flowType ?? '货物流',
    direction: p.direction,
    amount: p.amount ?? null,
    quantityTon: p.quantityTon ?? null,
    unit: p.unit ?? null,
    quantityValue: p.quantityValue ?? null,
    quantityDimension: p.quantityDimension ?? null,
    quantityCanonical: p.quantityCanonical ?? null,
    docType: p.docType,
    voucherDate: p.voucherDate ?? null,
    extractionId: null,
    confidence: 1,
    createdBy: 'test',
  }, p.userId ?? 'u1');
}

const t = (ton: number) => ({ quantityTon: ton, quantityCanonical: ton * 1000, quantityDimension: 'mass' as const, unit: '吨' });

describe('buildFlowPanel (spec §15)', () => {
  it('合同不在台账 -> null(路由层 404)', async () => {
    expect(await buildFlowPanel(ctx, 'NOPE-1', 'u1')).toBeNull();
  });

  describe('主场景: 货/权/款/票 四泳道 + netPosition(GMNH-TEST)', () => {
    let panel: NonNullable<Awaited<ReturnType<typeof buildFlowPanel>>>;
    let receiptFactId: string;

    beforeEach(async () => {
      await seedLedger('GMNH-TEST', 'u1', {
        数量: 20000, 单位: '吨', 交货期: '2026-06-30前', 金额: 4000000,
      });
      // 货泳道: 上游发货预告(发货单 notice) + 我方实收(磅单 actual), 同量不双计
      await seedFlow({ direction: 'in', docType: '发货单', voucherDate: '2026-06-10', documentId: 'D-N1', ...t(3357.46) });
      await seedFlow({ direction: 'in', docType: '汽运磅单', voucherDate: '2026-06-20', documentId: 'D-A1', ...t(3357.46) });
      // 权泳道: 收货事件带 titleTransfer, 经 ALLOCATE_TO 归属本合同
      receiptFactId = await insertTradeFact(ctx, {
        entityType: 'GoodsReceiptEvent',
        payload: { eventBizType: '正向', quantity: 3357.46, unit: '吨', titleTransfer: '签收转' },
        validAt: '2026-06-20', createdBy: 'test', documentId: 'D-A1',
      }, 'u1');
      const ledgerId = (await listContractLedgerRefs(ctx, 'u1'))
        .find((r) => r.contractNo === 'GMNH-TEST')!.id;
      await insertOntologyEdge(ctx, {
        relation: 'ALLOCATE_TO', fromType: 'GoodsReceiptEvent', fromId: receiptFactId,
        toType: 'TradeContract', toId: ledgerId, params: { amount: 1, method: '金额' },
        validAt: '2026-06-20', createdBy: 'test',
      }, 'u1');
      // 款泳道: 付款/收款按 contractNo 归属
      await insertTradeFact(ctx, {
        entityType: 'PaymentEvent',
        payload: { eventBizType: '正向', amount: 500000, currency: 'CNY', payType: '预付', contractNo: 'GMNH-TEST' },
        validAt: '2026-06-01', createdBy: 'test',
      }, 'u1');
      await insertTradeFact(ctx, {
        entityType: 'CollectionEvent',
        payload: { eventBizType: '正向', amount: 200000, currency: 'CNY', collectionType: '预收', contractNo: 'GMNH-TEST' },
        validAt: '2026-06-15', createdBy: 'test',
      }, 'u1');
      // 结算锚点
      await insertSettlementRecord(ctx, {
        contractNo: 'GMNH-TEST', settledQuantity: 3357.46, quantityUnit: '吨',
        basePrice: 1000, currency: 'CNY', totalAmount: 3357460,
        adjustments: [], basisFlowIds: [], basisExtractionIds: [], notes: null,
        createdBy: 'test',
      }, 'u1');
      // 票泳道: 进项发票 + WRITE_OFF 部分核销
      const invoiceId = await insertTradeFact(ctx, {
        entityType: 'InvoiceEvent',
        payload: { eventBizType: '正向', amount: 300000, currency: 'CNY', invoiceNo: 'INV-1', invoiceType: '进项', contractNo: 'GMNH-TEST' },
        validAt: '2026-06-18', createdBy: 'test',
      }, 'u1');
      const paymentId = (await (await import('../../src/ontology/repo.js')).listTradeFactsAsOf(
        ctx, (await import('../../src/ontology/asof.js')).asOfBusinessTime(new Date().toISOString()),
        { entityType: 'PaymentEvent' }, 'u1',
      ))[0]!.id;
      await insertOntologyEdge(ctx, {
        relation: 'WRITE_OFF', fromType: 'PaymentEvent', fromId: paymentId,
        toType: 'InvoiceEvent', toId: invoiceId, params: { amount: 100000, partial: true },
        validAt: '2026-06-19', createdBy: 'test',
      }, 'u1');
      // 背靠背对偶: confirmed correlates + rejected 不计入
      await saveGraphLink(ctx, {
        kind: 'correlates', srcKind: 'Contract', srcKey: 'GMNH-TEST',
        dstKind: 'Contract', dstKey: 'PEER-1', status: 'confirmed', createdBy: 'test',
      }, 'u1');
      await saveGraphLink(ctx, {
        kind: 'correlates', srcKind: 'Contract', srcKey: 'GMNH-TEST',
        dstKind: 'Contract', dstKey: 'PEER-2', status: 'rejected', createdBy: 'test',
      }, 'u1');
      await seedLedger('PEER-1', 'u1');

      panel = (await buildFlowPanel(ctx, 'GMNH-TEST', 'u1'))!;
    });

    const ms = (key: string) => {
      const hit = [...panel.goods, ...panel.title.milestones, ...panel.funds, ...panel.invoice]
        .find((m) => m.key === key);
      expect(hit, `milestone ${key} 应存在`).toBeDefined();
      return hit!;
    };

    it('头部口径: 合同号/基准/进度 16.79%', () => {
      expect(panel.contractNo).toBe('GMNH-TEST');
      expect(panel.basis).toEqual({ quantity: 20000, unit: '吨' });
      expect(panel.progress).not.toBeNull();
      expect(panel.progress!).toBeCloseTo(3357.46 / 20000, 4);
    });

    it('货泳道: 上游发运/我方收货(实称) 数字+证据 id, 预告实重不双计, 在途未发生', () => {
      const up = ms('upstream-ship');
      expect(up.node).toBe('上游');
      expect(up.status).toBe('done');
      expect(up.quantity).toEqual({ value: 3357.46, unit: '吨' });
      expect(up.evidenceIds.length).toBeGreaterThan(0);
      const receipt = ms('receipt');
      expect(receipt.status).toBe('done');
      expect(receipt.quantity).toEqual({ value: 3357.46, unit: '吨' });
      // 预告==实重: 不双计 -> 在途为 0(未发生), 收货只有实称一份
      expect(ms('in-transit').status).toBe('pending');
      const total = ms('receipt').quantity!.value;
      expect(total).toBeLessThan(4000);
    });

    it('权泳道: titleTransfer 转移时点 + 归属我方', () => {
      expect(panel.title.currentHolder).toBe('我方');
      expect(panel.title.transferPoints).toHaveLength(1);
      const tp = panel.title.transferPoints[0]!;
      expect(tp.caliber).toBe('签收转');
      expect(tp.direction).toBe('in');
      expect(tp.at.startsWith('2026-06-20')).toBe(true);
      expect(tp.factId).toBe(receiptFactId);
      expect(ms('title-in').status).toBe('done');
    });

    it('款泳道: 付出/收到/结算 + 净占用', () => {
      const paid = ms('paid');
      expect(paid.amount).toEqual({ value: 500000, currency: 'CNY' });
      expect(paid.node).toBe('上游');
      expect(ms('received').amount).toEqual({ value: 200000, currency: 'CNY' });
      expect(ms('settled').amount).toEqual({ value: 3357460, currency: 'CNY' });
      expect(panel.netPosition.currencies).toEqual([
        { currency: 'CNY', paid: 500000, received: 200000, netOccupancy: 300000 },
      ]);
    });

    it('票泳道: 进项金额 + WRITE_OFF 核销状态(部分核销)', () => {
      const inv = ms('invoice-in');
      expect(inv.amount).toEqual({ value: 300000, currency: 'CNY' });
      const wo = ms('writeoff');
      expect(wo.amount).toEqual({ value: 100000, currency: 'CNY' });
      expect(wo.status).toBe('ongoing');
      expect(panel.netPosition.invoices).toEqual([
        { currency: 'CNY', inAmount: 300000, outAmount: 0 },
      ]);
    });

    it('correlates: 仅 confirmed 对偶入 chips', () => {
      expect(panel.correlates.map((c) => c.contractNo)).toEqual(['PEER-1']);
    });

    it('每个里程碑都带证据 id(数字可溯)', () => {
      for (const m of [...panel.goods, ...panel.funds, ...panel.invoice]) {
        if (m.status !== 'pending') expect(m.evidenceIds.length, m.key).toBeGreaterThan(0);
      }
    });

    it('用户隔离: 台账行按用户隔离, 其他用户连合同面板都不可见(null)', async () => {
      expect(await buildFlowPanel(ctx, 'GMNH-TEST', 'u2')).toBeNull();
    });
  });

  it('在途: 预告未被实收覆盖部分(决策 #11c), 琥珀进行中', async () => {
    await seedLedger('TRANSIT-1', 'u1', { 数量: 20000, 单位: '吨' });
    await seedFlow({ contractNo: 'TRANSIT-1', direction: 'in', docType: '发货单', voucherDate: '2026-06-10', ...t(5000) });
    await seedFlow({ contractNo: 'TRANSIT-1', direction: 'in', docType: '汽运磅单', voucherDate: '2026-06-20', ...t(3357.46) });
    const p = (await buildFlowPanel(ctx, 'TRANSIT-1', 'u1'))!;
    const transit = p.goods.find((m) => m.key === 'in-transit')!;
    expect(transit.status).toBe('ongoing');
    expect(transit.quantity).toEqual({ value: 1642.54, unit: '吨' });
  });

  it('告警-超合同发货期: 凭证日期超交货期, 红圈同步标到泳道节点', async () => {
    await seedLedger('OVERDUE-1', 'u1', { 数量: 20000, 单位: '吨', 交货期: '2026-06-30' });
    await seedFlow({ contractNo: 'OVERDUE-1', direction: 'in', docType: '轨道衡称重单', voucherDate: '2026-07-05', ...t(100) });
    const p = (await buildFlowPanel(ctx, 'OVERDUE-1', 'u1'))!;
    const alert = p.alerts.find((a) => a.code === 'delivery-overdue');
    expect(alert).toBeDefined();
    expect(alert!.message).toContain('2026-07-05');
    expect(alert!.message).toContain('2026-06-30');
    expect(alert!.evidenceIds.length).toBeGreaterThan(0);
    // 红圈联动: 被告警覆盖的里程碑 status=abnormal + milestoneKeys 指路
    const receipt = p.goods.find((m) => m.key === 'receipt')!;
    expect(receipt.status).toBe('abnormal');
    expect(alert!.milestoneKeys).toContain('receipt');
  });

  it('告警-超合同发货期: 「合同发货期」区间字段 + 中文凭证日期归一(dev 冒烟回归)', async () => {
    // 2026-09-10 dev 冒烟 GMNH-JBKZ-20250303HNWH: 台账字段名是「合同发货期」
    // (区间中文), 发货单凭证日期是 "2025年3月21日" 且无 canonical 量。
    await seedLedger('OVERDUE-2', 'u1', {
      数量: '20000吨±10%', 合同发货期: '2025年3月1日至2025年3月20日',
    });
    await seedFlow({ contractNo: 'OVERDUE-2', direction: 'in', docType: '发货单', voucherDate: '2025年3月21日', quantityTon: 3357.46, quantityValue: 3357.46 });
    await seedFlow({ contractNo: 'OVERDUE-2', direction: 'in', docType: '轨道衡称重单', voucherDate: '2025-03-21', ...t(3357.46) });
    const p = (await buildFlowPanel(ctx, 'OVERDUE-2', 'u1'))!;
    const alert = p.alerts.find((a) => a.code === 'delivery-overdue');
    expect(alert).toBeDefined();
    expect(alert!.message).toContain('2025-03-21');
    expect(alert!.message).toContain('2025-03-20');
    // 中文日期在里程碑上归一为 ISO
    expect(p.goods.find((m) => m.key === 'upstream-ship')!.date).toBe('2025-03-21');
    // 无 canonical 的预告行按 quantity_ton 兜底展示(证据=流水 id), 不影响进度口径
    expect(p.goods.find((m) => m.key === 'upstream-ship')!.quantity).toEqual({ value: 3357.46, unit: '吨' });
    // 预告==实重: 在途不双计
    expect(p.goods.find((m) => m.key === 'in-transit')!.status).toBe('pending');
  });

  it('告警-水尺差超短溢装容差: 超 3% 告警, 容差内与无水尺不告警', async () => {
    await seedLedger('SURVEY-1', 'u1', { 数量: 20000, 单位: '吨', 短溢装: '±3%' });
    await seedFlow({ contractNo: 'SURVEY-1', direction: 'in', docType: '水尺计重单', voucherDate: '2026-05-01', ...t(10000) });
    await seedFlow({ contractNo: 'SURVEY-1', direction: 'in', docType: '汽运磅单', voucherDate: '2026-05-05', ...t(9600) });
    const p = (await buildFlowPanel(ctx, 'SURVEY-1', 'u1'))!;
    const alert = p.alerts.find((a) => a.code === 'draft-survey-tolerance');
    expect(alert).toBeDefined();
    expect(alert!.message).toContain('4.00%');

    // 容差内(1%)
    await seedLedger('SURVEY-2', 'u1', { 数量: 20000, 单位: '吨', 短溢装: '±3%' });
    await seedFlow({ contractNo: 'SURVEY-2', direction: 'in', docType: '水尺计重单', voucherDate: '2026-05-01', ...t(10000) });
    await seedFlow({ contractNo: 'SURVEY-2', direction: 'in', docType: '汽运磅单', voucherDate: '2026-05-05', ...t(9900) });
    const p2 = (await buildFlowPanel(ctx, 'SURVEY-2', 'u1'))!;
    expect(p2.alerts.find((a) => a.code === 'draft-survey-tolerance')).toBeUndefined();
  });

  it('告警-票款不齐: 有款无票 / 有票无款', async () => {
    await seedLedger('MISMATCH-1', 'u1');
    await insertTradeFact(ctx, {
      entityType: 'PaymentEvent',
      payload: { eventBizType: '正向', amount: 500000, currency: 'CNY', payType: '预付', contractNo: 'MISMATCH-1' },
      validAt: '2026-06-01', createdBy: 'test',
    }, 'u1');
    const p = (await buildFlowPanel(ctx, 'MISMATCH-1', 'u1'))!;
    expect(p.alerts.find((a) => a.code === 'invoice-funds-mismatch')?.message).toContain('有款无票');
    expect(p.funds.find((m) => m.key === 'paid')!.status).toBe('abnormal');

    await seedLedger('MISMATCH-2', 'u1');
    await insertTradeFact(ctx, {
      entityType: 'InvoiceEvent',
      payload: { eventBizType: '正向', amount: 300000, currency: 'CNY', invoiceNo: 'INV-9', invoiceType: '销项', contractNo: 'MISMATCH-2' },
      validAt: '2026-06-02', createdBy: 'test',
    }, 'u1');
    const p2 = (await buildFlowPanel(ctx, 'MISMATCH-2', 'u1'))!;
    expect(p2.alerts.find((a) => a.code === 'invoice-funds-mismatch')?.message).toContain('有票无款');
  });

  it('款/票事实按 contractNo 归属, 他合同事实不串', async () => {
    await seedLedger('ISO-1', 'u1');
    await insertTradeFact(ctx, {
      entityType: 'PaymentEvent',
      payload: { eventBizType: '正向', amount: 1, currency: 'CNY', payType: '预付', contractNo: 'OTHER-X' },
      validAt: '2026-06-01', createdBy: 'test',
    }, 'u1');
    const p = (await buildFlowPanel(ctx, 'ISO-1', 'u1'))!;
    expect(p.funds.find((m) => m.key === 'paid')!.count).toBe(0);
    expect(p.alerts.find((a) => a.code === 'invoice-funds-mismatch')).toBeUndefined();
  });

  it('documents 映射: 凭证单据 id -> 文件名/minioKey(三级钻取直达)', async () => {
    await seedLedger('DOC-1', 'u1');
    await seedFlow({ contractNo: 'DOC-1', direction: 'in', docType: '汽运磅单', documentId: 'D-RES', ...t(10) });
    ctx.sqlite.prepare(
      `INSERT INTO documents (id, doc_type, modality, source_uri, block_model, minio_key, user_id)
       VALUES ('D-RES', '汽运磅单', 'pdf', '/ingest/users_u1_uuid_汽运磅单.pdf', 'text', 'users/u1/uuid_汽运磅单.pdf', 'u1')`,
    ).run();
    const p = (await buildFlowPanel(ctx, 'DOC-1', 'u1'))!;
    expect(p.documents['D-RES']?.minioKey).toContain('磅单');
  });

  it('零货权口径: 事件无 titleTransfer 时 currentHolder=null 且提示待货权凭证', async () => {
    await seedLedger('NOTITLE-1', 'u1');
    const fid = await insertTradeFact(ctx, {
      entityType: 'GoodsReceiptEvent',
      payload: { eventBizType: '正向', quantity: 10, unit: '吨' },
      validAt: '2026-06-20', createdBy: 'test',
    }, 'u1');
    const ledgerId = (await listContractLedgerRefs(ctx, 'u1'))
      .find((r) => r.contractNo === 'NOTITLE-1')!.id;
    await insertOntologyEdge(ctx, {
      relation: 'ALLOCATE_TO', fromType: 'GoodsReceiptEvent', fromId: fid,
      toType: 'TradeContract', toId: ledgerId, params: { amount: 1, method: '金额' },
      validAt: '2026-06-20', createdBy: 'test',
    }, 'u1');
    const p = (await buildFlowPanel(ctx, 'NOTITLE-1', 'u1'))!;
    expect(p.title.currentHolder).toBeNull();
    expect(p.title.note).toContain('待货权凭证');
  });
});
