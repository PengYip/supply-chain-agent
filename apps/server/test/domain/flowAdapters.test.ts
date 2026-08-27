import { describe, it, expect } from 'vitest';
import { FLOW_ADAPTERS, CONTRACT_TYPE_FLOW_DIRECTION } from '../../src/domain/tradeSemantics.js';

describe('FLOW_ADAPTERS', () => {
  it('覆盖 spec §6 全部字段路径类型', () => {
    for (const t of ['收货单', '发货单', '汽运磅单', '火运大票', '派船通知单', '进项票', '销项票', '发票']) {
      expect(FLOW_ADAPTERS[t], t).toBeDefined();
    }
  });
  it('流族映射', () => {
    expect(FLOW_ADAPTERS['发货单']!.flowFamily).toBe('货物流');
    expect(FLOW_ADAPTERS['进项票']!.flowFamily).toBe('发票流');
    expect(FLOW_ADAPTERS['发票']!.flowFamily).toBe('发票流');
  });
  it('方向编码类型 codedDirection', () => {
    expect(FLOW_ADAPTERS['收货单']!.codedDirection).toBe('in');
    expect(FLOW_ADAPTERS['发货单']!.codedDirection).toBe('out');
    expect(FLOW_ADAPTERS['进项票']!.codedDirection).toBe('in');
    expect(FLOW_ADAPTERS['销项票']!.codedDirection).toBe('out');
    expect(FLOW_ADAPTERS['火运大票']!.codedDirection).toBeUndefined();
  });
  it('发货单日期别名含 dev 实测 发货日期; 磅单数量别名含 合计净重', () => {
    expect(FLOW_ADAPTERS['发货单']!.dateFields).toContain('发货日期');
    expect(FLOW_ADAPTERS['汽运磅单']!.qtyFields.map((f) => f[0])).toContain('合计净重');
  });
});

describe('CONTRACT_TYPE_FLOW_DIRECTION', () => {
  it('采购: 货物收/资金付/发票收; 销售: 反向', () => {
    expect(CONTRACT_TYPE_FLOW_DIRECTION['采购']).toEqual({ 资金流: 'out', 货物流: 'in', 发票流: 'in' });
    expect(CONTRACT_TYPE_FLOW_DIRECTION['销售']).toEqual({ 资金流: 'in', 货物流: 'out', 发票流: 'out' });
  });
});
