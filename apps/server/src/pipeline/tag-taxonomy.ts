// Per-docType semantic tag taxonomy for the L4 chunk-tag recall layer (Lane B).
//
// This is the CLOSED label set the chunk tagger must draw from. `其他` has no
// fixed taxonomy (empty array) which signals the caller to SKIP LLM tagging
// for that docType (see chunkTagging.tagChunks).

import type { DocType } from './types.js';

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
