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
};

/** Return the closed tag list for a docType. Empty array for unknown/其他. */
export function getTaxonomy(docType: DocType): string[] {
  return CHUNK_TAG_TAXONOMY[docType] ?? [];
}
