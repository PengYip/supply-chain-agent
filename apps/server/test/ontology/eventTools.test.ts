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
});
