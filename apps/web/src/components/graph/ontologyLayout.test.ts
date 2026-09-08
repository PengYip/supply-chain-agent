import { describe, it, expect } from 'vitest';
import { computeOntologyLayout, layerByRelation } from './ontologyLayout';
import type { GraphEdge, GraphNode } from '../../hooks/useGraph';

function node(id: string, name: string): GraphNode {
  return { elementId: `entity:${id}`, kind: id, name, props: {} };
}
function edge(type: string, from: string, to: string): GraphEdge {
  return { elementId: `${type}:${from}:${to}`, type, srcId: `entity:${from}`, dstId: `entity:${to}`, props: {}, confidence: null };
}

describe('layerByRelation', () => {
  it('按关系方向分层：链 A->B->C 逐列推进，自环不影响层', () => {
    const nodes = [node('A', '甲'), node('B', '乙'), node('C', '丙')];
    const edges = [edge('R1', 'A', 'B'), edge('R2', 'B', 'C'), edge('R3', 'C', 'C')];
    const layer = layerByRelation(nodes, edges);
    expect(layer.get('entity:A')).toBe(0);
    expect(layer.get('entity:B')).toBe(1);
    expect(layer.get('entity:C')).toBe(2);
  });
});

describe('computeOntologyLayout', () => {
  it('全节点有有限坐标且列 x 严格递增（无纵向成列）', () => {
    const nodes = [
      node('Counterparty', '交易对手'), node('OrgUnit', '内部组织'), node('TradeGoods', '商品'),
      node('GoodsReceiptEvent', '收货事件'), node('GoodsDeliveryEvent', '发货事件'),
      node('ServiceCostEvent', '服务费事件'), node('PaymentEvent', '付款事件'),
      node('CollectionEvent', '收款事件'), node('SettlementEvent', '结算事件'),
      node('InvoiceEvent', '发票事件'), node('TradeContract', '贸易合同'),
    ];
    const edges = [
      edge('ALLOCATE_TO', 'ServiceCostEvent', 'TradeContract'),
      edge('ALLOCATE_TO', 'GoodsReceiptEvent', 'TradeContract'),
      edge('ALLOCATE_TO', 'GoodsDeliveryEvent', 'TradeContract'),
      edge('OFFSET_SETTLE', 'PaymentEvent', 'SettlementEvent'),
      edge('OFFSET_SETTLE', 'CollectionEvent', 'SettlementEvent'),
      edge('WRITE_OFF', 'PaymentEvent', 'InvoiceEvent'),
      edge('WRITE_OFF', 'CollectionEvent', 'InvoiceEvent'),
      edge('REVERSE_ORIGIN', 'InvoiceEvent', 'InvoiceEvent'),
      edge('FEEDS_INTO', 'GoodsReceiptEvent', 'SettlementEvent'),
      edge('FEEDS_INTO', 'GoodsDeliveryEvent', 'SettlementEvent'),
      edge('CORRESPONDS_TO', 'SettlementEvent', 'InvoiceEvent'),
      edge('CORRESPONDS_TO', 'ServiceCostEvent', 'InvoiceEvent'),
      edge('TRIGGERS', 'ServiceCostEvent', 'PaymentEvent'),
      edge('PROVIDE', 'Counterparty', 'ServiceCostEvent'),
    ];
    const layout = computeOntologyLayout(nodes, edges);
    expect(Object.keys(layout.positions)).toHaveLength(11);
    for (const p of Object.values(layout.positions)) {
      expect(Number.isFinite(p.x)).toBe(true);
      expect(Number.isFinite(p.y)).toBe(true);
    }
    // 关系流方向上列 x 递增：TRIGGERS ServiceCost->Payment 必须左列在前
    const xs = new Set(Object.values(layout.positions).map((p) => Math.round(p.x)));
    expect(xs.size).toBeGreaterThanOrEqual(4);
    const svc = layout.positions['entity:ServiceCostEvent']!;
    const pay = layout.positions['entity:PaymentEvent']!;
    expect(pay.x).toBeGreaterThan(svc.x);
  });
});
