// L1 贸易行业层词汇表(domain/tradeSemantics)。
//
// 本模块是 L1 行业词汇的唯一归宿: 字段角色映射(roleByField)、商品与合同
// 字段名(commodityFields/contractFields)、执行凭证类型(executesDocTypes)、
// 凭证 relation 语义(bindingRelationFor)、chunk 标签分类法(CHUNK_TAG_TAXONOMY
// /getTaxonomy)全部集中于此。pipeline 内核不得自定义业务词汇, 只准 import;
// 修改这些值等于修改 join 协议, 需带测试走。
//
// 词汇以 TradeVocabulary 接口组织、TRADE_VOCAB 为默认实例: 内核派生函数
// (deriveProposedRelationships/Edges)接受可选 vocab 注入, 默认行为不变;
// L2 租户定制(客户别名、私有字段名)落地时以自定义实例注入, 不改内核。

import type { DocType } from '../pipeline/types.js';
import type { VoucherType } from '../pipeline/schemas/vouchers.js';

/** 合同类型受控词表(主体视角): 采购=主体买进, 销售=主体卖出(spec §3.1)。 */
export type ContractType = '采购' | '销售' | '物流' | '租赁' | '服务' | '其他';

/** 领域词汇表: pipeline 内核消费的全部贸易业务语义入口。 */
export interface TradeVocabulary {
  /** 字段名 -> Party 角色(甲方/乙方/买方/卖方/发货人/...)。 */
  readonly roleByField: Readonly<Record<string, string>>;
  /** 商品(标的)字段名集合。 */
  readonly commodityFields: ReadonlySet<string>;
  /** 合同号字段名集合(含客户别名, 如 合同编号)。 */
  readonly contractFields: ReadonlySet<string>;
  /** 构成合同"执行凭证"的单据类型(design 2026-08-17 §2.2, 派生 executes 图谱边)。 */
  readonly executesDocTypes: ReadonlySet<string>;
  /** 凭证类型 -> binding relation 语义(Phase B)。 */
  readonly bindingRelationByVoucherType: Readonly<Record<VoucherType, string>>;
  /** 未知凭证类型的 relation 兜底。 */
  readonly bindingRelationFallback: string;
  /** 合同类型受控值全集(枚举校验用)。 */
  readonly contractTypes: readonly ContractType[];
  /** 文档写法 -> 受控值。'购销合同'/'买卖合同' 有意不映射: 无方向语义, 宁可空着走侧别兜底。 */
  readonly contractTypeByAlias: Readonly<Record<string, ContractType>>;
  /** 标题关键词。键序即优先级: 物流/租赁/服务(非方向)在前, 采购/销售(方向)兜底。 */
  readonly contractTypeKeywords: Readonly<
    Record<Exclude<ContractType, '其他'>, readonly string[]>
  >;
  /** 主体侧别 -> 合同类型(确定性锚点)。 */
  readonly contractTypeBySide: Readonly<Record<'buyer' | 'seller', '采购' | '销售'>>;
  /** 项目标识字段名(合同/单据上)。 */
  readonly projectFields: ReadonlySet<string>;
  /** 合同类型 -> 对手方参与项目角色(派生 participates 边用)。 */
  readonly participatesRoleByContractType: Readonly<Record<'采购' | '销售', '供应商' | '客户'>>;
}

/** 供应链贸易默认词汇表(L1 行业共性, 缓慢演进)。 */
export const TRADE_VOCAB: TradeVocabulary = {
  roleByField: {
    甲方: '买方', 乙方: '卖方', 买方: '买方', 卖方: '卖方',
    发货人: '发货人', 收货人: '收货人', 承运人: '承运人',
  },
  commodityFields: new Set(['标的物', '商品']),
  // Lane A (2a): contract-number fields also lift a Contract proposal so the
  // document can be graph-linked to its contract without an explicit bind call.
  contractFields: new Set(['合同号', '合同编号']),
  executesDocTypes: new Set(['发票', '提单', '装箱单']),
  bindingRelationByVoucherType: {
    货转单: '货权转移',
    付款凭证: '付款',
    化验报告: '质检',
    其他: '凭证',
  },
  bindingRelationFallback: '凭证',
  contractTypes: ['采购', '销售', '物流', '租赁', '服务', '其他'],
  contractTypeByAlias: {
    采购合同: '采购', 购买合同: '采购', 采购协议: '采购',
    销售合同: '销售', 出售合同: '销售', 销售协议: '销售',
    物流合同: '物流', 运输合同: '物流', 货运合同: '物流', 物流协议: '物流',
    租赁合同: '租赁', 租赁协议: '租赁',
    服务合同: '服务', 服务协议: '服务', 技术服务合同: '服务', 咨询合同: '服务',
  },
  contractTypeKeywords: {
    物流: ['物流', '运输', '货运'],
    租赁: ['租赁', '租用'],
    服务: ['服务', '咨询'],
    采购: ['采购'],
    销售: ['销售'],
  },
  contractTypeBySide: { buyer: '采购', seller: '销售' },
  projectFields: new Set(['项目编号', '项目号', '项目名称', '项目', '工程名称']),
  participatesRoleByContractType: { 采购: '供应商', 销售: '客户' },
};

/** 凭证类型 -> binding relation 语义(纯函数, 可被自定义词汇表覆盖)。 */
export function bindingRelationFor(voucherType: VoucherType, vocab: TradeVocabulary = TRADE_VOCAB): string {
  return vocab.bindingRelationByVoucherType[voucherType] ?? vocab.bindingRelationFallback;
}

// Per-docType semantic tag taxonomy for the L4 chunk-tag recall layer (Lane B).
//
// This is the CLOSED label set the chunk tagger must draw from. `其他` has no
// fixed taxonomy (empty array) which signals the caller to SKIP LLM tagging
// for that docType (see chunkTagging.tagChunks).

export const CHUNK_TAG_TAXONOMY: Record<DocType, string[]> = {
  合同: [
    '当事人信息', '标的物', '数量与计量', '价格与金额', '付款条款',
    '交付与运输', '检验与验收', '权利义务', '违约责任', '不可抗力',
    '争议解决', '期限与生效', '签署信息',
  ],
  发票: [
    '购方信息', '销方信息', '票据号', '开票日期', '品名规格',
    '数量与单位', '单价', '金额', '税额', '价税合计',
  ],
  提单: [
    '托运人', '收货人', '通知方', '船名航次', '装货港', '卸货港',
    '唛头', '货物描述', '数量与包装', '运费条款', '签发信息',
  ],
  装箱单: [
    '购方/销方', '唛头', '货物描述', '数量', '毛重', '净重',
    '体积', '包装方式', '批次号',
  ],
  // Phase A 图片凭证: 单虚拟 chunk(字段 KV 文本), 无段落语义可打标签 ->
  // 空 taxonomy 与 其他 一致(信号 tagChunks 跳过 LLM 打标)。
  货转单: [],
  化验报告: [],
  付款凭证: [],
  其他: [],
  // v2 类型划分(spec 2026-08-26 §3.1): 新类型暂无段落语义标签集, 空数组
  // 信号 tagChunks 跳过 LLM 打标(与 其他/图片凭证 同语义)。后续按需扩展。
  补充合同: [],
  立项书: [],
  履约凭证: [],
  结算单: [],
  质检报告: [],
  运输凭证: [],
  收货单: [],
  发货单: [],
  汽运磅单: [],
  火运大票: [],
  轨道衡称重单: [],
  派船通知单: [],
  资金凭证: [],
  付款单: [],
  发票凭证: [],
  进项票: [],
  销项票: [],
};

/** Return the closed tag list for a docType. Empty array for unknown/其他. */
export function getTaxonomy(docType: DocType): string[] {
  return CHUNK_TAG_TAXONOMY[docType] ?? [];
}

// ---------------------------------------------------------------------------
// 履约六向与图谱边词汇(spec 2026-08-25 方案A §3.3)。settles 边 relation 由
// execution_flows(flowType x direction)确定性派生; 新增流族必须先扩
// SETTLES_RELATION_BY_FLOW, 宁可返回 null 空缺也不猜方向语义。
// ---------------------------------------------------------------------------

/** 履约六向受控词表: settles 边 relation 的唯一取值域。 */
export type SettlesRelation = '收款' | '付款' | '收货' | '发货' | '收票' | '开票';
/** 执行流水流族(executionFlow.FLOW_TYPE_BY_DOC_TYPE 的值域)。 */
export type FlowFamily = '资金流' | '货物流' | '发票流';

/** (flowType, direction) -> 六向 relation。唯一派生规则, L1 归宿。 */
export const SETTLES_RELATION_BY_FLOW: Readonly<
  Record<FlowFamily, Readonly<Record<'in' | 'out', SettlesRelation>>>
> = {
  资金流: { in: '收款', out: '付款' },
  货物流: { in: '收货', out: '发货' },
  发票流: { in: '收票', out: '开票' },
};

/** 白名单外流族或未知方向返回 null(宁可空缺不猜)。 */
export function settlesRelationFor(flowType: string, direction: string): SettlesRelation | null {
  const family = SETTLES_RELATION_BY_FLOW[flowType as FlowFamily];
  if (!family) return null;
  return family[direction as 'in' | 'out'] ?? null;
}

/** 额度范围受控词表: counterparty=对手方授信(跨项目聚合), project=项目限额。 */
export type QuotaScope = 'counterparty' | 'project';
export const QUOTA_SCOPES: readonly QuotaScope[] = ['counterparty', 'project'];

/** 图谱新增边类型常量(spec §3.3), graph 模块与工具描述共享, 禁止散落字符串。 */
export const GRAPH_TRADE_EDGES = {
  correlates: 'correlates',
  relates: 'relates',
  amends: 'amends',
  trades: 'trades',
  settles: 'settles',
  granted: 'granted',
} as const;

// ---------------------------------------------------------------------------
// 通用履约物化层: 类型适配表(spec 2026-08-27 §4)。字段路径文档的流族/字段别名/
// 方向编码唯一归宿; 图片凭证(货转单/付款凭证/化验报告)不在此表, 走 vouchers.extractAnchors。
// 新单据类型接入 = 本表加一行, 机制不变。

/** 单据类型 -> 履约流水适配(数量/日期/金额字段按优先序, 首个命中即用)。 */
export interface FlowAdapter {
  readonly flowFamily: FlowFamily;
  /** [字段名, 单位提示?]。'_吨' 后缀命名即单位(与台账 scoreQty 词表一致)。 */
  readonly qtyFields: ReadonlyArray<readonly [string] | [string, string]>;
  readonly unitFields: readonly string[];
  readonly dateFields: readonly string[];
  readonly amountFields: readonly string[];
  /** 类型自带方向(方向编码类型), 仅主体/合同类型都判不出时的第三级兜底。 */
  readonly codedDirection?: 'in' | 'out';
}

const INVOICE_QTY: FlowAdapter['qtyFields'] = [['数量']];
const INVOICE_DATE: readonly string[] = ['开票日期', '日期'];
const INVOICE_AMOUNT: readonly string[] = ['价税合计', '价税合计小写_元', '合计金额', '金额'];

export const FLOW_ADAPTERS: Readonly<Record<string, FlowAdapter>> = {
  收货单: {
    flowFamily: '货物流',
    qtyFields: [['发运数量'], ['数量_吨', '吨'], ['数量']],
    unitFields: ['单位'],
    dateFields: ['收货日期', '到货日期', '发货日期', '日期'],
    amountFields: ['含税总价'],
    codedDirection: 'in',
  },
  发货单: {
    flowFamily: '货物流',
    qtyFields: [['发运数量'], ['数量_吨', '吨'], ['数量']],
    unitFields: ['单位'],
    dateFields: ['发货日期', '收货日期', '到货日期', '日期'],
    amountFields: ['含税总价'],
    codedDirection: 'out',
  },
  汽运磅单: {
    flowFamily: '货物流',
    qtyFields: [['合计净重'], ['净重'], ['合计毛重'], ['毛重'], ['重量_吨', '吨'], ['数量_吨', '吨'], ['数量']],
    unitFields: ['重量单位', '单位'],
    dateFields: ['称量日期', '发货日期', '日期'],
    amountFields: [],
  },
  火运大票: {
    flowFamily: '货物流',
    qtyFields: [['合计净重'], ['净重'], ['合计毛重'], ['毛重'], ['重量_吨', '吨'], ['数量_吨', '吨'], ['数量']],
    unitFields: ['重量单位', '单位'],
    dateFields: ['称量日期', '发货日期', '日期'],
    amountFields: [],
  },
  // 铁路物流单据族(spec 2026-08-27, 业务确认): 发货单(预告) -> 火运大票(运单) ->
  // 轨道衡称重单(过衡称重, 常伴随 样品编号/校码 等质检采样字段) -> 质检报告(质检,
  // 不物化六向)。称重单数量以 合计净重 为准, 单位来自 重量单位 字段。
  轨道衡称重单: {
    flowFamily: '货物流',
    qtyFields: [['合计净重'], ['净重'], ['合计毛重'], ['毛重'], ['重量_吨', '吨'], ['数量_吨', '吨'], ['数量']],
    unitFields: ['重量单位', '单位'],
    dateFields: ['称量日期', '发货日期', '日期'],
    amountFields: [],
  },
  派船通知单: {
    flowFamily: '货物流',
    qtyFields: [['数量'], ['数量_吨', '吨'], ['重量_吨', '吨']],
    unitFields: ['单位'],
    dateFields: ['通知日期', '发货日期', '日期'],
    amountFields: [],
  },
  进项票: {
    flowFamily: '发票流',
    qtyFields: INVOICE_QTY,
    unitFields: ['单位'],
    dateFields: INVOICE_DATE,
    amountFields: INVOICE_AMOUNT,
    codedDirection: 'in',
  },
  销项票: {
    flowFamily: '发票流',
    qtyFields: INVOICE_QTY,
    unitFields: ['单位'],
    dateFields: INVOICE_DATE,
    amountFields: INVOICE_AMOUNT,
    codedDirection: 'out',
  },
  发票: {
    flowFamily: '发票流',
    qtyFields: INVOICE_QTY,
    unitFields: ['单位'],
    dateFields: INVOICE_DATE,
    amountFields: INVOICE_AMOUNT,
  },
};

/** 合同类型 -> 六向方向兜底(主体锚点缺席时, spec §5 第 2 级)。 */
export const CONTRACT_TYPE_FLOW_DIRECTION: Readonly<
  Record<'采购' | '销售', Readonly<Record<FlowFamily, 'in' | 'out'>>>
> = {
  采购: { 资金流: 'out', 货物流: 'in', 发票流: 'in' },
  销售: { 资金流: 'in', 货物流: 'out', 发票流: 'out' },
};

// ---- 节点权威聚合(spec 2026-08-27 §15) ---------------------------------------
//
// 同一批货会经过多个物流节点并各留一张凭证(发出预告 -> 过衡/签收), 逐行 SUM 会
// 双计。进度聚合按节点分两层: 预告节点(发货单/派船通知单)只在未被实重覆盖时计入,
// 实重节点(轨道衡称重单/汽运磅单/火运大票/收货单/货转单)是数量的权威来源;
// 每个量纲取 max(实重, 预告) —— 预告被覆盖时不重复累计, 未覆盖批次仍按预告计入。
/** 预告节点单据类型(数量仅为发出预告, 可被实重覆盖)。 */
export const NOTICE_NODE_DOC_TYPES: ReadonlySet<string> = new Set(['发货单', '派船通知单']);

export type FlowNodeTier = 'notice' | 'actual';

/** 单据类型 -> 节点层级; 未知类型一律按实重处理(宁可保守计入也不静默丢量)。 */
export function flowNodeTier(docType: string | null | undefined): FlowNodeTier {
  return docType != null && NOTICE_NODE_DOC_TYPES.has(docType) ? 'notice' : 'actual';
}
