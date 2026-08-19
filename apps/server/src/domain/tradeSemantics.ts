// L1 贸易行业层词汇表(domain/tradeSemantics)。
//
// 本模块是 L1 行业词汇的唯一归宿: 字段角色映射(REL_ROLE_BY_FIELD)、商品与合同
// 字段名(COMMODITY_FIELDS / CONTRACT_FIELDS)、执行凭证类型(EXECUTES_DOCTYPES)、
// 凭证 relation 语义(bindingRelationFor)、chunk 标签分类法(CHUNK_TAG_TAXONOMY /
// getTaxonomy)全部集中于此。pipeline 内核不得自定义业务词汇, 只准 import;
// 修改这些值等于修改 join 协议, 需带测试走。

import type { DocType } from '../pipeline/types.js';
import type { VoucherType } from '../pipeline/schemas/vouchers.js';

/** 字段名 -> 关系角色(Party role)。 */
export const REL_ROLE_BY_FIELD: Record<string, string> = {
  甲方: '买方', 乙方: '卖方', 买方: '买方', 卖方: '卖方',
  发货人: '发货人', 收货人: '收货人', 承运人: '承运人',
};

/** 商品(标的)字段名。 */
export const COMMODITY_FIELDS = new Set(['标的物', '商品']);

// Lane A (2a): contract-number fields also lift a Contract proposal so the
// document can be graph-linked to its contract without an explicit bind call.
export const CONTRACT_FIELDS = new Set(['合同号', '合同编号']);

/** 构成合同"执行凭证"的单据类型(design 2026-08-17 §2.2)。 */
export const EXECUTES_DOCTYPES = new Set(['发票', '提单', '装箱单']);

/** 凭证类型 -> binding relation 语义(Phase B)。 */
export function bindingRelationFor(voucherType: VoucherType): string {
  switch (voucherType) {
    case '货转单':
      return '货权转移';
    case '付款凭证':
      return '付款';
    case '化验报告':
      return '质检';
    default:
      return '凭证';
  }
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
