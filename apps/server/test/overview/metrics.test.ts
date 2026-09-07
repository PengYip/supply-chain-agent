import { describe, it, expect } from 'vitest';
import { isPaymentBlockReason, overReceiptViolations } from '../../src/overview/metrics.js';
import { createDb, migrate } from '../../src/pipeline/db/client.js';
import { insertTradeFact, insertOntologyEdge } from '../../src/ontology/repo.js';
import { createSession, recordPendingApproval, resolveApproval } from '../../src/harness/sessionStore.js';
import { buildOverviewMetrics } from '../../src/overview/metrics.js';

const NOW = new Date().toISOString();

async function seedContract(
  ctx: ReturnType<typeof createDb>, id: string, contractNo: string, qty: number | null, userId: string,
) {
  ctx.sqlite.prepare(
    `INSERT INTO contract_ledger (id, contract_no, display_contract_no, doc_type, document_id,
       title, fields, field_meta, overall_confidence, needs_review, user_id, contract_type)
     VALUES (?, ?, ?, '合同', 'doc-x', ?, ?, '{}', 1, 0, ?, '采购')`,
  ).run(id, contractNo, contractNo, contractNo, JSON.stringify(qty == null ? {} : { '数量': qty }), userId);
}

describe('isPaymentBlockReason', () => {
  it('reason 含「付款」判定为拦截记录；空/无关键词不判', () => {
    expect(isPaymentBlockReason('用户请求无票付款，需人工确认')).toBe(true);
    expect(isPaymentBlockReason('无票付款拦截')).toBe(true);
    expect(isPaymentBlockReason('绑定单据确认')).toBe(false);
    expect(isPaymentBlockReason(null)).toBe(false);
    expect(isPaymentBlockReason('')).toBe(false);
    expect(isPaymentBlockReason(undefined)).toBe(false);
  });
});

describe('overReceiptViolations', () => {
  const contracts = [
    { id: 'c1', contractNo: 'HT-1', qty: 100 },
    { id: 'c2', contractNo: 'HT-2', qty: 50 },
    { id: 'c3', contractNo: 'HT-3', qty: null },   // 合同数量缺失：不参与判定
    { id: 'c4', contractNo: 'HT-4', qty: 0 },      // 数量 0：不参与判定
  ];
  const receipts = [
    { id: 'r1', quantity: 60, bizType: '正向' },
    { id: 'r2', quantity: 50, bizType: '正向' },
    { id: 'r3', quantity: -10, bizType: '逆向' },  // 逆向不轧差
    { id: 'r4', quantity: null, bizType: '正向' }, // 无数量：跳过
  ];
  const edges = [
    { fromId: 'r1', toType: 'TradeContract', toId: 'c1' },
    { fromId: 'r2', toType: 'TradeContract', toId: 'c1' },
    { fromId: 'r3', toType: 'TradeContract', toId: 'c1' },
    { fromId: 'r1', toType: 'TradeContract', toId: 'c2' },
    { fromId: 'r4', toType: 'TradeContract', toId: 'c2' },
  ];

  it('超合同量收货：按合同聚合正向收货量（一份收货可分摊多合同），超量即违规', () => {
    const out = overReceiptViolations(contracts, receipts, edges);
    // c1: 60+50=110 > 100；c2: r1 分摊 60 > 50（r4 无数量跳过）
    expect(out).toEqual([
      { contractId: 'c1', contractNo: 'HT-1', contractQty: 100, receivedQty: 110 },
      { contractId: 'c2', contractNo: 'HT-2', contractQty: 50, receivedQty: 60 },
    ]);
  });

  it('非 TradeContract 目标类型的边不参与（防御 toType）', () => {
    const out = overReceiptViolations(contracts, receipts, [
      { fromId: 'r1', toType: 'SettlementEvent', toId: 'c1' },
    ]);
    expect(out).toEqual([]);
  });
});

describe('buildOverviewMetrics (local source)', () => {
  it('构造异常数据 -> 待审批计数/超量收货/无票付款拦截/执行率/待核销 各卡片出现', async () => {
    const ctx = createDb(':memory:');
    migrate(ctx.sqlite);
    const uid = 'ov-u1';

    // 合同：HT-1 数量 100（超量源），HT-2 数量 50（已执行未超量...实际也超量），HT-3 无数量
    await seedContract(ctx, 'c1', 'HT-1', 100, uid);
    await seedContract(ctx, 'c2', 'HT-2', 50, uid);
    await seedContract(ctx, 'c3', 'HT-3', null, uid);

    // 收货事实：r1(60)->c1,c2 分摊；r2(50)->c1 => c1=110>100, c2=60>50
    const r1 = await insertTradeFact(ctx, { entityType: 'GoodsReceiptEvent',
      payload: { eventBizType: '正向', amount: 600, currency: 'CNY', quantity: 60 },
      validAt: NOW, createdBy: 'seed' }, uid);
    const r2 = await insertTradeFact(ctx, { entityType: 'GoodsReceiptEvent',
      payload: { eventBizType: '正向', amount: 500, currency: 'CNY', quantity: 50 },
      validAt: NOW, createdBy: 'seed' }, uid);
    for (const [rid, cid] of [[r1, 'c1'], [r2, 'c1'], [r1, 'c2']] as const) {
      await insertOntologyEdge(ctx, { relation: 'ALLOCATE_TO', fromType: 'GoodsReceiptEvent',
        fromId: rid, toType: 'TradeContract', toId: cid, params: { amount: 1, method: '定额' },
        validAt: NOW, createdBy: 'seed' }, uid);
    }

    // 付款事实 + 部分核销：p1 金额 1000，核销 400 => 待核销 remaining 600
    const p1 = await insertTradeFact(ctx, { entityType: 'PaymentEvent',
      payload: { eventBizType: '正向', amount: 1000, currency: 'CNY', payType: '预付' },
      validAt: NOW, createdBy: 'seed' }, uid);
    const inv1 = await insertTradeFact(ctx, { entityType: 'InvoiceEvent',
      payload: { eventBizType: '正向', amount: 400, currency: 'CNY', invoiceNo: 'INV-1', invoiceType: '进项' },
      validAt: NOW, createdBy: 'seed' }, uid);
    await insertOntologyEdge(ctx, { relation: 'WRITE_OFF', fromType: 'PaymentEvent',
      fromId: p1, toType: 'InvoiceEvent', toId: inv1, params: { amount: 400 },
      validAt: NOW, createdBy: 'seed' }, uid);

    // 审批：1 条 pending + 1 条已决 L3（reason 含「付款」）
    const s = await createSession('trader', uid);
    await recordPendingApproval({ sessionId: s.id, level: 'L2', toolName: 'bind_document',
      toolCallId: 'call-ov-1', input: {}, approvalId: 'ap-ov-1' });
    await recordPendingApproval({ sessionId: s.id, level: 'L3', toolName: 'escalate_to_human',
      input: { issue: 'x' }, ticketId: 'ESC-OV-1' });
    await resolveApproval('ESC-OV-1', 'denied', { decidedBy: uid, reason: '无票付款，拦截' });

    const payload = await buildOverviewMetrics(ctx, uid);
    expect(payload.source).toBe('local');
    expect(payload.note).toBeNull();
    expect(payload.cards).not.toBeNull();

    expect(payload.cards!.pendingApprovals).toEqual({ status: 'ok', data: { count: 1 } });
    expect(payload.cards!.overReceipt).toEqual({ status: 'ok',
      data: { anomalies: [
        { contractId: 'c1', contractNo: 'HT-1', contractQty: 100, receivedQty: 110 },
        { contractId: 'c2', contractNo: 'HT-2', contractQty: 50, receivedQty: 60 },
      ], scannedContracts: 3 } });
    expect(payload.cards!.paymentBlocks.status).toBe('ok');
    if (payload.cards!.paymentBlocks.status === 'ok') {
      expect(payload.cards!.paymentBlocks.data.records).toHaveLength(1);
      expect(payload.cards!.paymentBlocks.data.records[0]!.ticketId).toBe('ESC-OV-1');
    }
    expect(payload.cards!.executionRate).toEqual({ status: 'ok', data: { total: 3, executed: 2, rate: 2 / 3 } });
    expect(payload.cards!.pendingWriteoff).toEqual({ status: 'ok', data: { amount: 600, rows: 1 } });
  });

  it('cube 数据源：返回预留位降级载荷（cards=null + note），不触发本地聚合', async () => {
    const { cubePlaceholderPayload } = await import('../../src/overview/metrics.js');
    const p = cubePlaceholderPayload(NOW);
    expect(p.source).toBe('cube');
    expect(p.cards).toBeNull();
    expect(p.note).toBeTruthy();
  });

  it('零数据：各卡片空态不报错（rate=null / 空数组 / 0）', async () => {
    const ctx = createDb(':memory:');
    migrate(ctx.sqlite);
    const payload = await buildOverviewMetrics(ctx, 'ov-empty');
    expect(payload.cards!.pendingApprovals).toEqual({ status: 'ok', data: { count: 0 } });
    expect(payload.cards!.overReceipt.status).toBe('ok');
    if (payload.cards!.overReceipt.status === 'ok') {
      expect(payload.cards!.overReceipt.data.anomalies).toEqual([]);
    }
    expect(payload.cards!.executionRate).toEqual({ status: 'ok', data: { total: 0, executed: 0, rate: null } });
    expect(payload.cards!.pendingWriteoff).toEqual({ status: 'ok', data: { amount: 0, rows: 0 } });
  });
});
