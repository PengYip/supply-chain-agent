// 本体事件登记 L2 工具（2026-09-08）：create_trade_event。
// 对话登记 -> 审批中心批准 -> insertTradeFact 写入边界（strict zod + 逆向=负数语义规则）
// -> trade_facts -> 台账/穿透图即时可见。字段词汇=7 事件实体注册表（toolOntologyMap CI
// 门禁强制）；本工具是未来表单入口（核销工作台同构）的共享后端。批准后 execute 自动落
// side_effect_results 审计（harness/agent.ts L2 gated wrapper），本文件无需自理审计。
import { tool } from 'ai';
import { z } from 'zod';
import type { DbContext } from '../pipeline/db/client.js';
import { insertTradeFact, type TradeFactInput } from './repo.js';
import { PayType, EventBizType, DUAL_TIMELINE_FIELDS } from './index.js';
import { syncOntologyGraphSafe } from './graphSync.js';

export const TRADE_EVENT_TYPES = [
  'GoodsReceiptEvent', 'GoodsDeliveryEvent', 'SettlementEvent', 'InvoiceEvent',
  'PaymentEvent', 'CollectionEvent', 'ServiceCostEvent',
] as const;

// inputSchema SSOT：工具与表单入口（POST /api/trade-events）共用同一 zod 定义，
// 路由/web 一律经 export 消费或经 tradeEventFormSchemaJson 投影，禁止复制字段定义。
export const CreateTradeEventInputSchema = z.object({
  entityType: z.enum(TRADE_EVENT_TYPES).describe('事件类型（7 类之一）'),
  eventBizType: EventBizType.describe('业务方向：正向=正数金额；逆向（红冲/退款）=负数金额'),
  amount: z.number().optional().describe('金额；正向为正数，逆向（红冲/退款）必须为负数（如红冲 -800000）；收货/发货可省略（仅数量登记，结算价后置），省略时不得传 currency'),
  currency: z.string().min(1).optional().describe('币种（如 CNY）；与 amount 同缺同在'),
  validAt: z.string().min(1).describe('业务发生时间 ISO 日期（如 2026-06-25）'),
  invoiceNo: z.string().optional().describe('发票号（InvoiceEvent 必填，如 INV-2026-001）'),
  invoiceType: z.enum(['销项', '进项']).optional().describe('发票类型（InvoiceEvent 必填）'),
  payType: PayType.optional().describe('付款类型（PaymentEvent 必填：预付/尾款/进度款/质保金）'),
  costType: z.string().optional().describe('费用类型（ServiceCostEvent 必填，如 物流）'),
  quantity: z.number().optional().describe('数量（收货/发货必填，如 100）'),
  unit: z.string().optional().describe('单位（收货/发货/结算必填，如 吨）'),
  settledQuantity: z.number().optional().describe('结算数量（SettlementEvent 必填，如 100）'),
  documentId: z.string().min(1).optional().describe('来源单据 id（凭证据源：对话上下文/表单中有明确来源单据时传递，图上据此建立 单据-凭证溯源 边；没有就省略）'),
});

/** 表单 UX 默认值（服务端投影给表单入口；业务语义仍以注册表与写入边界为准）。 */
const TRADE_EVENT_FORM_DEFAULTS: Record<string, unknown> = { currency: 'CNY' };

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
      '不符会整单拒绝并在 detail 返回原因；' +
      '收货/发货可仅数量登记（磅单/质检单常只有数量：amount 与 currency 同时省略，' +
      '结算价后置补登；数量冲正的逆向同样无需金额），提供金额时正向必须正数、逆向必须负数；' +
      '其余事件 amount+currency 必填；' +
      '逆向事件金额必须为负数（写入边界强制）；' +
      '数字或日期不精确时先向用户确认，不要猜测。' +
      '返回 { status: "ok", id, entityType } 或 { status: "invalid", detail }。',
    inputSchema: CreateTradeEventInputSchema,
    execute: async ({ entityType, validAt, documentId, ...payload }) => {
      try {
        const id = await insertTradeFact(
          deps.ctx,
          // documentId 是溯源列(provenance), 不是实体 payload——strict 实体校验
          // 会拒绝注册表外字段, 必须在解构层摘出。
          { entityType, payload, validAt, createdBy: 'create_trade_event', documentId } as TradeFactInput,
          deps.userId,
        );
        // 落账成功后图投影 fire-and-forget(spec 2026-09-09): 永不阻塞登记主流程。
        void syncOntologyGraphSafe(deps.ctx, deps.userId);
        return { status: 'ok' as const, id, entityType };
      } catch (e) {
        return { status: 'invalid' as const, detail: e instanceof Error ? e.message : String(e) };
      }
    },
  });
}

// ---------------------------------------------------------------------------
// 表单入口投影（GET /api/trade-events/schema 数据源）：从同一 inputSchema zod
// 反射字段元数据，web 不复制任何字段/枚举定义。闭枚举值直接来自注册表 enum。
// ---------------------------------------------------------------------------

export interface TradeEventFormFieldDTO {
  name: string;
  kind: 'string' | 'number' | 'enum';
  required: boolean;
  /** 渲染微调：双时间轴字段（validAt 等）按日期控件呈现；值仍为 ISO 字符串。 */
  widget?: 'date';
  options?: readonly string[];
  description: string;
  formDefault?: unknown;
}

/** zod 字段解包：穿透 Optional/Nullable 得到内层与必填性（表单投影共用，masterData 同构复用）。 */
export function unwrapField(sch: z.ZodTypeAny): { inner: z.ZodTypeAny; required: boolean } {
  let inner = sch;
  let required = true;
  while (inner instanceof z.ZodOptional || inner instanceof z.ZodNullable) {
    if (inner instanceof z.ZodOptional) required = false;
    inner = inner.unwrap();
  }
  return { inner, required };
}

/** 字段种类判定（表单投影共用，masterData 同构复用）。 */
export function fieldKind(inner: z.ZodTypeAny): 'string' | 'number' | 'enum' | null {
  if (inner instanceof z.ZodEnum || inner instanceof z.ZodNativeEnum) return 'enum';
  if (inner instanceof z.ZodNumber) return 'number';
  if (inner instanceof z.ZodString) return 'string';
  return null;
}

export function tradeEventFormSchemaJson() {
  const fields: TradeEventFormFieldDTO[] = Object.entries(CreateTradeEventInputSchema.shape)
    .map(([name, sch]) => {
      const { inner, required } = unwrapField(sch);
      const kind = fieldKind(inner);
      if (!kind) throw new Error(`eventTools: unsupported field type for form projection: ${name}`);
      const desc = inner.description ?? sch.description ?? '';
      return {
        name,
        kind,
        required,
        ...(kind === 'string' && (DUAL_TIMELINE_FIELDS as readonly string[]).includes(name)
          ? { widget: 'date' as const }
          : {}),
        ...(kind === 'enum' ? { options: (inner as unknown as { options: readonly string[] }).options } : {}),
        description: desc,
        ...(name in TRADE_EVENT_FORM_DEFAULTS ? { formDefault: TRADE_EVENT_FORM_DEFAULTS[name] } : {}),
      };
    });
  return { tool: 'create_trade_event', fields };
}
