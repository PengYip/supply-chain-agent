// 本体注册表 SSOT（roadmap 2026-09-07 Item 2 / 本体建模技术备忘 §3）。
// 单文件、只 import zod：CI 门禁与前端（Item 3 经 /api/ontology/schema）共同消费，
// 新增实体/关系/枚举值只改本文件（验收 1）。领域变更上游 SSOT：
// docs/贸易企业全链路数据本体建设落地方案（精准关系语义校准终版）.docx。
import { z } from 'zod';

// ---------------------------------------------------------------------------
// 枚举（docx §6 闭集）+ 开放词汇
// ---------------------------------------------------------------------------

export const PayType = z.enum(['预付', '尾款', '进度款', '质保金']);
export const EventBizType = z.enum(['正向', '逆向']);
export const AllocateMethod = z.enum(['金额', '数量', '重量', '定额']);

// 商品码：备忘 §7 待业务确认（TradeGoods 分层），v1 开放词汇表；确认后转 z.enum 只改本文件。
export const COMMODITY_CODES: readonly string[] = [];

// meaning URI 映射：只挂已确认的 OEO/FIBO 条目（roadmap OUT：不做全量词汇导入）。
// key = 实体/关系/枚举值名，value = 外部词汇 URI。确认一个挂一个，测试校验 URI 格式。
export const MEANING_URIS: Readonly<Record<string, string>> = {};

// ---------------------------------------------------------------------------
// 实体（docx §3：4 静态 + 7 事件；v1 字段=单据/流水既有词汇最小集）
// ---------------------------------------------------------------------------

export const OntologyEntityNameSchema = z.enum([
  'TradeContract', 'TradeGoods', 'Counterparty', 'OrgUnit',
  'GoodsReceiptEvent', 'GoodsDeliveryEvent', 'SettlementEvent', 'InvoiceEvent',
  'PaymentEvent', 'CollectionEvent', 'ServiceCostEvent',
]);
export type OntologyEntityName = z.infer<typeof OntologyEntityNameSchema>;

const Currency = z.string().min(1).describe('币种代码, 如 CNY/USD');

export const ONTOLOGY_ENTITIES: Record<OntologyEntityName, z.ZodObject<z.ZodRawShape>> = {
  TradeContract: z.object({
    contractNo: z.string().min(1).describe('合同号(归一主键口径, 与 contract_ledger.contract_no 同源)'),
    title: z.string().optional(),
    contractType: z.string().describe('合同类型(开放: 采购/销售/...; 与 contract_ledger.contract_type 同源)'),
    currency: Currency.optional(),
  }),
  TradeGoods: z.object({
    name: z.string().min(1).describe('商品名'),
    commodityCode: z.string().min(1).describe('商品码; v1 开放词汇(COMMODITY_CODES), 收敛后转闭枚举'),
    spec: z.string().optional().describe('规格品位(分层待业务确认, 备忘 §7)'),
    unit: z.string().optional().describe('计量单位'),
  }),
  Counterparty: z.object({
    name: z.string().min(1).describe('企业名(归一化, 与图 Party 同源)'),
    role: z.string().describe('角色(开放: 供应商/客户/服务商, docx: 交易对手含服务商)'),
  }),
  OrgUnit: z.object({
    name: z.string().min(1).describe('内部组织名'),
    code: z.string().optional(),
  }),
  GoodsReceiptEvent: z.object({
    eventBizType: EventBizType.describe('收货(含采购退货); 逆向=负数金额'),
    amount: z.number().describe('金额; 逆向为负数(docx §6.2 自动轧差)'),
    currency: Currency,
    quantity: z.number().optional().describe('数量'),
    unit: z.string().optional(),
  }),
  GoodsDeliveryEvent: z.object({
    eventBizType: EventBizType.describe('发货(含销售退货); 逆向=负数金额'),
    amount: z.number(),
    currency: Currency,
    quantity: z.number().optional(),
    unit: z.string().optional(),
  }),
  SettlementEvent: z.object({
    eventBizType: EventBizType.describe('结算(采购/销售/补差); 补差/冲减走逆向负数'),
    amount: z.number(),
    currency: Currency,
    settledQuantity: z.number().optional().describe('结算数量(settlement_records.settled_quantity 同源)'),
    unit: z.string().optional(),
  }),
  InvoiceEvent: z.object({
    eventBizType: EventBizType.describe('发票(进项/销项/服务费); 红冲=逆向负数+REVERSE_ORIGIN 边'),
    amount: z.number(),
    currency: Currency,
    invoiceNo: z.string().min(1).describe('发票号'),
    invoiceType: z.string().describe('进项/销项/服务费(开放)'),
  }),
  PaymentEvent: z.object({
    eventBizType: EventBizType.describe('付款(预付/尾款/进度款/退款); 退款=逆向负数'),
    amount: z.number(),
    currency: Currency,
    payType: PayType.describe('流程分支开关(docx §6.1): 预付免票先行, 其余强依赖结算+发票'),
  }),
  CollectionEvent: z.object({
    eventBizType: EventBizType.describe('收款(预收/回款/退款); 退款=逆向负数'),
    amount: z.number(),
    currency: Currency,
    collectionType: z.string().optional().describe('预收/回款(开放, 非闭枚举)'),
  }),
  ServiceCostEvent: z.object({
    eventBizType: EventBizType.describe('第三方服务费; 费用冲减=逆向负数'),
    amount: z.number(),
    currency: Currency,
    costType: z.string().describe('物流/质检/仓储/报关/保险(开放)'),
  }),
};

export const ENTITY_NAMES = Object.keys(ONTOLOGY_ENTITIES) as OntologyEntityName[];

/** 实体中文标签（台账导航/治理 UI 用；新增实体必须补标签，registry 测试断言全覆盖）。 */
export const ENTITY_LABELS: Record<OntologyEntityName, string> = {
  TradeContract: '贸易合同',
  TradeGoods: '商品',
  Counterparty: '交易对手',
  OrgUnit: '内部组织',
  GoodsReceiptEvent: '收货事件',
  GoodsDeliveryEvent: '发货事件',
  SettlementEvent: '结算事件',
  InvoiceEvent: '发票事件',
  PaymentEvent: '付款事件',
  CollectionEvent: '收款事件',
  ServiceCostEvent: '服务费事件',
};

// ---------------------------------------------------------------------------
// mixin 字段词汇（docx 双时间轴 + 溯源；表列名 snake_case 由仓储映射）
// ---------------------------------------------------------------------------

export const DUAL_TIMELINE_FIELDS = ['validAt', 'invalidAt', 'ingestedAt'] as const;
export const PROVENANCE_FIELDS = ['createdBy', 'sourceSpan', 'confidence'] as const;

// 工具输入共享词汇（结构/溯源字段, Task 4 CI 门禁用）。新工具字段先进本表或实体 schema。
export const SHARED_TOOL_FIELD_NAMES = [
  'id', 'kind', 'name', 'props',
  'srcId', 'dstId', 'documentId', 'contractNo', 'relation',
  'confidence', 'sourceSpan',
  ...DUAL_TIMELINE_FIELDS, ...PROVENANCE_FIELDS,
  // 核销工作台工具（create_writeoff/create_offset, 2026-09-07 Item 5）:
  // items=整单分配计划容器; amount/partial/batch=OFFSET_SETTLE/WRITE_OFF 关系 params 词汇。
  'items', 'amount', 'partial', 'batch',
  // 事件登记工具（create_trade_event, 2026-09-08）：entityType=事件事实判别键。
  'entityType',
] as const;

// ---------------------------------------------------------------------------
// 语义规则层（docx §6.2）：事件实体 逆向=负数 / 正向=正数。
// 与词汇层分离——ONTOLOGY_ENTITIES 保持纯 z.object（.shape 可直取），规则在写入边界叠加。
// ---------------------------------------------------------------------------

const EVENT_ENTITY_NAMES: readonly OntologyEntityName[] = [
  'GoodsReceiptEvent', 'GoodsDeliveryEvent', 'SettlementEvent', 'InvoiceEvent',
  'PaymentEvent', 'CollectionEvent', 'ServiceCostEvent',
];

const eventAmountRule = (v: Record<string, unknown>, ctx: z.RefinementCtx) => {
  const bizType = v['eventBizType'];
  const amount = v['amount'];
  if (typeof amount !== 'number') return;
  if (bizType === '逆向' && amount >= 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['amount'],
      message: '逆向事件金额必须为负数(docx 6.2: 负数金额自动轧差)' });
  }
  if (bizType === '正向' && amount <= 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['amount'],
      message: '正向事件金额必须为正数' });
  }
};

/** 实体 phase（注册表派生：static=4 静态 / event=7 事件）。前端表单入口/台账按此
 *  区分登记面，禁止在 web 硬编码事件类型清单——新增实体只改本文件。 */
export type EntityPhase = 'static' | 'event';

export function entityPhase(name: OntologyEntityName): EntityPhase {
  return EVENT_ENTITY_NAMES.includes(name) ? 'event' : 'static';
}

/** 写入边界用的完整 schema：词汇 + 语义规则。静态实体直接返回原 schema。
 *  M-1 裁决(2026-09-07)：strict——注册表外字段快速失败(不静默剥离)；
 *  仓储持久化 parse 后的规范值，DB 内 payload 字段恒 ⊆ 注册表词汇。 */
export function entitySchema(name: OntologyEntityName): z.ZodTypeAny {
  const base = ONTOLOGY_ENTITIES[name].strict();
  return EVENT_ENTITY_NAMES.includes(name) ? base.superRefine(eventAmountRule) : base;
}

/** 字段全集 = 实体自有 ∪ 双时间轴 ∪ 溯源（CI 门禁与 Item 3 列生成共用）。 */
export function entityFieldNames(name: OntologyEntityName): Set<string> {
  const own = Object.keys(ONTOLOGY_ENTITIES[name]!.shape);
  return new Set([...own, ...DUAL_TIMELINE_FIELDS, ...PROVENANCE_FIELDS]);
}

// ---------------------------------------------------------------------------
// 关系（docx §5：4 核心 + 4 辅助 = 8 类型 / 14 连接对；带参是一等公民）
// ---------------------------------------------------------------------------

const NO_PARAMS = z.object({}).strict().describe('无参关系');

export interface OntologyRelationDef {
  name: string;
  description: string;
  pairs: ReadonlyArray<{ from: OntologyEntityName; to: OntologyEntityName }>;
  params: z.ZodObject<z.ZodRawShape>;
  meaning?: string;
}

export const ONTOLOGY_RELATIONS: ReadonlyArray<OntologyRelationDef> = [
  {
    name: 'ALLOCATE_TO',
    description: '分摊关系(docx §5.1): 费用/履约归属合同, 成本核算。多合同分摊=多边。',
    pairs: [
      { from: 'ServiceCostEvent', to: 'TradeContract' },
      { from: 'GoodsReceiptEvent', to: 'TradeContract' },
      { from: 'GoodsDeliveryEvent', to: 'TradeContract' },
    ],
    params: z.object({
      amount: z.number().describe('分摊金额'),
      ratio: z.number().min(0).max(1).optional().describe('分摊比例'),
      method: AllocateMethod.describe('分摊方式: 金额/数量/重量/定额'),
      batch: z.string().optional().describe('批次'),
    }).strict(),
  },
  {
    name: 'OFFSET_SETTLE',
    description: '冲抵关系(docx §5.2): 预付/预收资金冲抵货值结算, 预付场景核心。',
    pairs: [
      { from: 'PaymentEvent', to: 'SettlementEvent' },
      { from: 'CollectionEvent', to: 'SettlementEvent' },
    ],
    params: z.object({
      amount: z.number().describe('冲抵金额'),
      batch: z.string().optional().describe('批次'),
    }).strict(),
  },
  {
    name: 'WRITE_OFF',
    description: '核销关系(docx §5.3): 票款匹配闭环, 多对多/部分核销。',
    pairs: [
      { from: 'PaymentEvent', to: 'InvoiceEvent' },
      { from: 'CollectionEvent', to: 'InvoiceEvent' },
    ],
    params: z.object({
      amount: z.number().describe('核销金额'),
      partial: z.boolean().optional().describe('部分核销标记'),
      batch: z.string().optional().describe('批次'),
    }).strict(),
  },
  {
    name: 'REVERSE_ORIGIN',
    description: '红冲溯源(docx §5.4): 红冲票绑定原蓝字票, 全额/部分/多次。',
    pairs: [{ from: 'InvoiceEvent', to: 'InvoiceEvent' }],
    params: z.object({
      amount: z.number().describe('红冲金额'),
      reason: z.string().optional().describe('冲抵原因'),
    }).strict(),
  },
  {
    name: 'FEEDS_INTO',
    description: '辅助(docx §5.5): 履约数据生成结算数据。',
    pairs: [
      { from: 'GoodsReceiptEvent', to: 'SettlementEvent' },
      { from: 'GoodsDeliveryEvent', to: 'SettlementEvent' },
    ],
    params: NO_PARAMS,
  },
  {
    name: 'CORRESPONDS_TO',
    description: '辅助(docx §5.5): 结算/费用对应发票（两对语义各算一条, 合计 9 关系口径）。',
    pairs: [
      { from: 'SettlementEvent', to: 'InvoiceEvent' },
      { from: 'ServiceCostEvent', to: 'InvoiceEvent' },
    ],
    params: NO_PARAMS,
  },
  {
    name: 'TRIGGERS',
    description: '辅助(docx §5.5): 第三方费用触发付款。',
    pairs: [{ from: 'ServiceCostEvent', to: 'PaymentEvent' }],
    params: NO_PARAMS,
  },
  {
    name: 'PROVIDE',
    description: '辅助(docx §5.5): 服务商与服务费关联归属。',
    pairs: [{ from: 'Counterparty', to: 'ServiceCostEvent' }],
    params: NO_PARAMS,
  },
];

export function relationDef(name: string): OntologyRelationDef {
  const def = ONTOLOGY_RELATIONS.find((r) => r.name === name);
  if (!def) throw new Error(`ontology: unknown relation "${name}"`);
  return def;
}

export function isRelationPairAllowed(name: string, from: string, to: string): boolean {
  const def = ONTOLOGY_RELATIONS.find((r) => r.name === name);
  if (!def) return false;
  return def.pairs.some((p) => p.from === from && p.to === to);
}

// ---------------------------------------------------------------------------
// 前端/治理可消费的纯 JSON 投影（Item 3 GET /api/ontology/schema 的数据源）
// ---------------------------------------------------------------------------

export function ontologySchemaJson() {
  return {
    version: '2026-09-07',
    enums: {
      PayType: PayType.options,
      EventBizType: EventBizType.options,
      AllocateMethod: AllocateMethod.options,
      commodityCodes: COMMODITY_CODES,
    },
    entities: ENTITY_NAMES.map((n) => ({
      name: n,
      label: ENTITY_LABELS[n],
      phase: entityPhase(n),
      ownFields: Object.keys(ONTOLOGY_ENTITIES[n]!.shape),
      fields: [...entityFieldNames(n)],
      meaning: MEANING_URIS[n] ?? null,
    })),
    relations: ONTOLOGY_RELATIONS.map((r) => ({
      name: r.name,
      description: r.description,
      pairs: r.pairs,
      params: Object.keys(r.params.shape),
      meaning: r.meaning ?? MEANING_URIS[r.name] ?? null,
    })),
  };
}
