import { describe, it, expect } from 'vitest';
import { isPaymentBlockReason, overReceiptViolations } from '../../src/overview/metrics.js';

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
