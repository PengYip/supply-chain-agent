// 本体事件登记 L2 工具（2026-09-08）：create_trade_event。
// 对话登记 -> 审批中心批准 -> insertTradeFact 写入边界（strict zod + 逆向=负数语义规则）
// -> trade_facts -> 台账/穿透图即时可见。字段词汇=7 事件实体注册表（toolOntologyMap CI
// 门禁强制）；本工具是未来表单入口（核销工作台同构）的共享后端。批准后 execute 自动落
// side_effect_results 审计（harness/agent.ts L2 gated wrapper），本文件无需自理审计。
import { tool } from 'ai';
import { z } from 'zod';
import type { DbContext } from '../pipeline/db/client.js';
import { insertTradeFact, type TradeFactInput } from './repo.js';
import { PayType, EventBizType } from './index.js';

export const TRADE_EVENT_TYPES = [
  'GoodsReceiptEvent', 'GoodsDeliveryEvent', 'SettlementEvent', 'InvoiceEvent',
  'PaymentEvent', 'CollectionEvent', 'ServiceCostEvent',
] as const;

export function buildCreateTradeEventTool(deps: { ctx: DbContext; userId?: string }) {
  return tool({
    description:
      '登记一条业务事件事实到台账（付款/收款/收货/发货/发票/结算/服务费）。' +
      '当用户口述一笔明确的业务事实（含精确金额、币种、业务时间、方向类型）时调用，' +
      '例如"登记一笔 2026-06-25 的 30 万元预付付款" -> entityType=PaymentEvent, ' +
      'amount=300000, currency=CNY, payType=预付, eventBizType=正向, validAt=2026-06-25。' +
      '边界：一次只登记一条事实；不核销不冲抵（核销用 create_writeoff、冲抵用 create_offset）；' +
      '字段组合必须满足本体注册表（发票必须 invoiceNo+invoiceType、付款必须 payType、' +
      '收发货必须 quantity+unit、结算必须 settledQuantity+unit、服务费必须 costType），' +
      '不符会整单拒绝并在 detail 返回原因；逆向事件金额必须为负数（写入边界强制）；' +
      '数字或日期不精确时先向用户确认，不要猜测。' +
      '返回 { status: "ok", id, entityType } 或 { status: "invalid", detail }。',
    inputSchema: z.object({
      entityType: z.enum(TRADE_EVENT_TYPES).describe('事件类型（7 类之一）'),
      eventBizType: EventBizType.describe('业务方向：正向=正数金额；逆向（红冲/退款）=负数金额'),
      amount: z.number().describe('金额；正向为正数，逆向（红冲/退款）必须为负数（如红冲 -800000）'),
      currency: z.string().min(1).describe('币种（如 CNY）'),
      validAt: z.string().min(1).describe('业务发生时间 ISO 日期（如 2026-06-25）'),
      invoiceNo: z.string().optional().describe('发票号（InvoiceEvent 必填，如 INV-2026-001）'),
      invoiceType: z.enum(['销项', '进项']).optional().describe('发票类型（InvoiceEvent 必填）'),
      payType: PayType.optional().describe('付款类型（PaymentEvent 必填：预付/尾款/进度款/质保金）'),
      costType: z.string().optional().describe('费用类型（ServiceCostEvent 必填，如 物流）'),
      quantity: z.number().optional().describe('数量（收货/发货必填，如 100）'),
      unit: z.string().optional().describe('单位（收货/发货/结算必填，如 吨）'),
      settledQuantity: z.number().optional().describe('结算数量（SettlementEvent 必填，如 100）'),
    }),
    execute: async ({ entityType, validAt, ...payload }) => {
      try {
        const id = await insertTradeFact(
          deps.ctx,
          { entityType, payload, validAt, createdBy: 'create_trade_event' } as TradeFactInput,
          deps.userId,
        );
        return { status: 'ok' as const, id, entityType };
      } catch (e) {
        return { status: 'invalid' as const, detail: e instanceof Error ? e.message : String(e) };
      }
    },
  });
}
