// 工具-本体映射与词汇门禁（roadmap Item 2: 映射示范 3 个既有 L2 工具）。
// 语义: 已映射工具的 inputSchema 顶层字段必须 ∈ (映射实体的字段集 ∪ 共享词汇)。
// 目的与 tool-inventory 双射门禁一致——工具输入面不能绕开本体词汇悄悄膨胀;
// 新字段先落注册表(实体 schema 或 SHARED_TOOL_FIELD_NAMES)再上工具。
import { entityFieldNames, SHARED_TOOL_FIELD_NAMES, type OntologyEntityName } from './index.js';

export interface ToolOntologyMapping {
  /** 该工具触碰的本体实体; 空数组=纯结构/共享词汇工具 */
  entities: readonly OntologyEntityName[];
  note: string;
}

export const toolOntologyMap: Readonly<Record<string, ToolOntologyMapping>> = {
  create_entity: {
    entities: ['TradeContract', 'TradeGoods', 'Counterparty', 'OrgUnit'],
    note: '图谱手工补图(Neo4j 层); 输入词汇与 4 静态实体对齐, kind/name/props 属共享词汇',
  },
  link_entities: {
    entities: [],
    note: '结构字段(srcId/dstId/kind/props/confidence/sourceSpan)全部属共享词汇; 业务关系优先走带 SSOT 的 bind/link',
  },
  bind_document: {
    entities: ['TradeContract'],
    note: '单据-合同绑定; contractNo 属 TradeContract 词汇, documentId/relation 属共享引用词汇',
  },
  create_writeoff: {
    entities: ['PaymentEvent', 'CollectionEvent', 'InvoiceEvent', 'SettlementEvent'],
    note: '核销工作台(2026-09-07 Item 5): items 容器+关系 params 词汇(amount/partial/batch)属共享词汇; srcId/dstId 属共享引用词汇',
  },
  create_offset: {
    entities: ['PaymentEvent', 'CollectionEvent', 'SettlementEvent'],
    note: '预付冲抵工作台: 词汇口径同 create_writeoff',
  },
  create_trade_event: {
    entities: ['GoodsReceiptEvent', 'GoodsDeliveryEvent', 'SettlementEvent', 'InvoiceEvent', 'PaymentEvent', 'CollectionEvent', 'ServiceCostEvent'],
    note: '事件登记(2026-09-08): entityType 判别键属共享词汇, 其余字段=7 事件实体自有词汇, validAt 属双时间轴共享词汇',
  },
};

const SHARED = new Set<string>(SHARED_TOOL_FIELD_NAMES);

/** 返回不在词汇表内的字段名列表(空=合规)。未映射工具恒为空(映射 opt-in)。 */
export function toolFieldsViolations(toolName: string, fields: readonly string[]): string[] {
  const mapping = toolOntologyMap[toolName];
  if (!mapping) return [];
  const allowed = new Set<string>(SHARED);
  for (const e of mapping.entities) {
    for (const f of entityFieldNames(e)) allowed.add(f);
  }
  return fields.filter((f) => !allowed.has(f));
}
