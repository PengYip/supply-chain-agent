/** Agent 工具的中文业务别名。技术名仅作为 title/fallback 展示。 */
const TOOL_LABELS: Record<string, string> = {
  query_business: '业务台账查询',
  query_orders: '订单查询',
  cross_check: '账实核对',
  escalate_to_human: '转人工复核',
  load_skill: '加载业务流程',
  verify_document_fields: '单据字段核验',
  ingest_document: '录入单据',
  extract_fields: '提取结构化字段',
  bind_document: '确认单据绑定',
  recall_documents: '检索单据原文',
  execute_code: '执行计算',
  inspect_extraction: '查看字段证据',
  link_documents: '关联单据',
  create_entity: '创建图谱实体',
  link_entities: '建立图谱关系',
  graph_query: '遍历业务图谱',
  graph_find_entity: '查找图谱实体',
  present_document_review: '生成单据复核卡',
  update_document_fields: '更正单据字段',
  list_binding_proposals: '查看绑定建议',
  manage_template: '管理单据模板',
  manage_quota: '管理业务额度',
  gather_settlement_evidence: '汇总结算依据',
  confirm_settlement: '确认结算入库',
}

export function toolLabel(toolName: string | null | undefined): string {
  if (!toolName) return '—'
  return TOOL_LABELS[toolName] ?? toolName
}
