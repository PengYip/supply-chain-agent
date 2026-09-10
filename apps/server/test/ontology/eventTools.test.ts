// apps/server/test/ontology/eventTools.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { createDb, migrate, type DbContext } from '../../src/pipeline/db/client.js';
import { getTradeFactById } from '../../src/ontology/repo.js';
import { buildCreateTradeEventTool } from '../../src/ontology/eventTools.js';

let ctx: DbContext;
beforeEach(() => {
  ctx = createDb(':memory:');
  migrate(ctx.sqlite);
});

describe('create_trade_event execute', () => {
  it('付款事件落 trade_facts：payload 含必填词汇，createdBy=工具名，user_id 隔离', async () => {
    const t = buildCreateTradeEventTool({ ctx, userId: 'u1' });
    const out = await t.execute!({
      entityType: 'PaymentEvent', eventBizType: '正向', amount: 300_000,
      currency: 'CNY', validAt: '2026-06-25', payType: '预付',
    }, { toolCallId: 'call_test_1', messages: [] } as never);
    expect(out.status).toBe('ok');
    if (out.status !== 'ok') return;
    const row = await getTradeFactById(ctx, out.id, 'u1');
    expect(row?.entityType).toBe('PaymentEvent');
    expect(row?.payload).toMatchObject({ amount: 300_000, payType: '预付', eventBizType: '正向', currency: 'CNY' });
    // 其他用户不可见（共享域 '' 例外由 effectiveUserId 处理）
    expect(await getTradeFactById(ctx, out.id, 'u2')).toBeFalsy();
  });

  it('字段组合不符注册表 -> invalid 且零落库', async () => {
    const t = buildCreateTradeEventTool({ ctx, userId: 'u1' });
    const out = await t.execute!({
      entityType: 'InvoiceEvent', eventBizType: '正向', amount: 1,
      currency: 'CNY', validAt: '2026-06-20',
    }, { toolCallId: 'call_test_2', messages: [] } as never);
    expect(out.status).toBe('invalid');
    if (out.status !== 'invalid') return;
    expect(out.detail).toContain('invoiceNo');
  });

  it('逆向=负数语义由写入边界强制：正数逆向被拒', async () => {
    const t = buildCreateTradeEventTool({ ctx, userId: 'u1' });
    const out = await t.execute!({
      entityType: 'InvoiceEvent', eventBizType: '逆向', amount: 5,
      currency: 'CNY', validAt: '2026-06-20', invoiceNo: 'INV-R', invoiceType: '销项',
    }, { toolCallId: 'call_test_3', messages: [] } as never);
    expect(out.status).toBe('invalid');
  });

  it('收/发货数量-only 登记 ok（磅单常只有数量，结算价后置）', async () => {
    const t = buildCreateTradeEventTool({ ctx, userId: 'u1' });
    const out = await t.execute!({
      entityType: 'GoodsReceiptEvent', eventBizType: '正向',
      validAt: '2026-06-25', quantity: 100, unit: '吨',
    }, { toolCallId: 'call_test_4', messages: [] } as never);
    expect(out.status).toBe('ok');
    if (out.status !== 'ok') return;
    const row = await getTradeFactById(ctx, out.id, 'u1');
    expect(row?.payload).toEqual({ eventBizType: '正向', quantity: 100, unit: '吨' });
  });

  it('amount 与 currency 同缺同在：只带 amount 缺 currency -> invalid（注册表不变量经写入边界）', async () => {
    const t = buildCreateTradeEventTool({ ctx, userId: 'u1' });
    const out = await t.execute!({
      entityType: 'GoodsReceiptEvent', eventBizType: '正向', amount: 500,
      validAt: '2026-06-25', quantity: 10,
    }, { toolCallId: 'call_test_5', messages: [] } as never);
    expect(out.status).toBe('invalid');
    if (out.status !== 'invalid') return;
    expect(out.detail).toContain('currency');
  });

  it('收/发货事件带 counterpartyId/titleTransfer 透传 payload(spec 决策 #11)', async () => {
    const t = buildCreateTradeEventTool({ ctx, userId: 'u1' });
    const out = await t.execute!({
      entityType: 'GoodsDeliveryEvent', eventBizType: '正向',
      validAt: '2026-06-26', quantity: 80, unit: '吨',
      counterpartyId: 'TF-cp-9', titleTransfer: '签收转',
    }, { toolCallId: 'call_test_6', messages: [] } as never);
    expect(out.status).toBe('ok');
    if (out.status !== 'ok') return;
    const row = await getTradeFactById(ctx, out.id, 'u1');
    expect(row?.payload).toMatchObject({
      counterpartyId: 'TF-cp-9', titleTransfer: '签收转', quantity: 80, unit: '吨',
    });
    // inputSchema 投影自动带出两字段(表单入口共用同一 SSOT)
    const shape = t.inputSchema.shape as Record<string, { isOptional: () => boolean }>;
    expect(shape['counterpartyId']).toBeDefined();
    expect(shape['titleTransfer']).toBeDefined();
    expect(shape['counterpartyId']!.isOptional()).toBe(true);
    expect(shape['titleTransfer']!.isOptional()).toBe(true);
  });

  it('工具描述声明收/发货数量-only 登记路径', () => {
    const t = buildCreateTradeEventTool({ ctx });
    expect(t.description).toContain('数量');
    expect(t.description).toContain('后置');
  });

  it('付款事件带 contractNo 透传 payload(spec §15 前置①: 按合同聚合款/票)', async () => {
    const t = buildCreateTradeEventTool({ ctx, userId: 'u1' });
    const out = await t.execute!({
      entityType: 'PaymentEvent', eventBizType: '正向', amount: 500_000,
      currency: 'CNY', validAt: '2026-06-25', payType: '预付',
      contractNo: 'GMNH-JBKZ-20250303HNWH',
    }, { toolCallId: 'call_test_7', messages: [] } as never);
    expect(out.status).toBe('ok');
    if (out.status !== 'ok') return;
    const row = await getTradeFactById(ctx, out.id, 'u1');
    expect(row?.payload).toMatchObject({ contractNo: 'GMNH-JBKZ-20250303HNWH', payType: '预付' });
    // inputSchema 投影自动带出(表单入口共用同一 SSOT), 可选
    const shape = t.inputSchema.shape as Record<string, { isOptional: () => boolean }>;
    expect(shape['contractNo']).toBeDefined();
    expect(shape['contractNo']!.isOptional()).toBe(true);
  });

  it('收/发货事件带 contractNo -> invalid(strict 注册表拒绝, 归属走绑定/分摊边)', async () => {
    const t = buildCreateTradeEventTool({ ctx, userId: 'u1' });
    const out = await t.execute!({
      entityType: 'GoodsReceiptEvent', eventBizType: '正向',
      validAt: '2026-06-25', quantity: 10, unit: '吨', contractNo: 'X',
    }, { toolCallId: 'call_test_8', messages: [] } as never);
    expect(out.status).toBe('invalid');
    if (out.status !== 'invalid') return;
    expect(out.detail).toContain('contractNo');
  });
});
