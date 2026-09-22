import { describe, it, expect } from 'vitest';
import { FLOW_ADAPTERS, CONTRACT_TYPE_FLOW_DIRECTION } from '../../src/domain/tradeSemantics.js';
import { deriveAnchorsFromFields } from '../../src/pipeline/bindingProposal.js';

const wrap = (m: Record<string, string | number>) =>
  Object.fromEntries(Object.entries(m).map(([k, v]) => [k, { value: v }]));

describe('FLOW_ADAPTERS', () => {
  it('覆盖 spec §6 全部字段路径类型', () => {
    for (const t of ['收货单', '发货单', '汽运磅单', '火运大票', '轨道衡称重单', '派船通知单', '进项票', '销项票', '发票', '运输凭证', '重量凭证']) {
      expect(FLOW_ADAPTERS[t], t).toBeDefined();
    }
  });
  it('铁路单据族: 发货单(预告)/火运大票(运单)/轨道衡称重单(过衡)均货物流', () => {
    expect(FLOW_ADAPTERS['发货单']!.flowFamily).toBe('货物流');
    expect(FLOW_ADAPTERS['火运大票']!.flowFamily).toBe('货物流');
    expect(FLOW_ADAPTERS['轨道衡称重单']!.flowFamily).toBe('货物流');
  });
  it('wave6 火运词汇: 中间节点 运输凭证/重量凭证 接入货物流, 数量键对齐汽运磅单族', () => {
    expect(FLOW_ADAPTERS['运输凭证']!.flowFamily).toBe('货物流');
    expect(FLOW_ADAPTERS['重量凭证']!.flowFamily).toBe('货物流');
    for (const t of ['运输凭证', '重量凭证'] as const) {
      const qty = FLOW_ADAPTERS[t]!.qtyFields.map((f) => f[0]);
      for (const k of ['合计净重', '净重', '重量_吨', '数量_吨']) {
        expect(qty, `${t} 缺适配数量键 ${k}`).toContain(k);
      }
      // 方向中性(与汽运磅单/火运大票同构): 方向走主体锚点/合同类型三级链, 不编码。
      expect(FLOW_ADAPTERS[t]!.codedDirection).toBeUndefined();
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

describe('轨道衡称重单 qtyFields 吨制键族(wave7 followup)', () => {
  it('适配表含 总净重_吨/净重_吨 两键, 且 总净重_吨 在 净重_吨 之前(聚合优先)', () => {
    const qty = FLOW_ADAPTERS['轨道衡称重单']!.qtyFields;
    expect(qty).toContainEqual(['总净重_吨', '吨']);
    expect(qty).toContainEqual(['净重_吨', '吨']);
    const iTotal = qty.findIndex(([k]) => k === '总净重_吨');
    const iNet = qty.findIndex(([k]) => k === '净重_吨');
    expect(iTotal).toBeGreaterThanOrEqual(0);
    expect(iNet).toBeGreaterThan(iTotal);
  });

  it('派生: 总净重_吨 + 净重_吨 同现 -> 取总净重(页区间聚合优先)', () => {
    const a = deriveAnchorsFromFields('轨道衡称重单', wrap({ 总净重_吨: 1405.79, 净重_吨: 70.64 }));
    expect(a.quantity).toEqual({ value: 1405.79, unit: '吨', dimension: 'mass', canonical: 1405790 });
    expect(a.quantityTon).toBe(1405.79);
  });

  it('派生: 仅净重_吨(无总净重) -> 兜底取净重', () => {
    const a = deriveAnchorsFromFields('轨道衡称重单', wrap({ 净重_吨: 70.64 }));
    expect(a.quantity).toEqual({ value: 70.64, unit: '吨', dimension: 'mass', canonical: 70640 });
    expect(a.quantityTon).toBe(70.64);
  });

  it('回归: 既有 7 键仍首中(合计净重 优先于新增 总净重_吨)', () => {
    const a = deriveAnchorsFromFields('轨道衡称重单', wrap({ 合计净重: 100, 总净重_吨: 200 }));
    expect(a.quantityTon).toBe(100);
    // 仅合计净重: 无单位提示/后缀 -> dimension NULL 原值照存(既有语义)。
    const b = deriveAnchorsFromFields('轨道衡称重单', wrap({ 合计净重: 100 }));
    expect(b.quantity).toEqual({ value: 100, dimension: null, canonical: null });
  });
});

describe('运输凭证 (kg) 键族(W8 T6, 战地: mt 旧批 重量(kg)=57720 曾疑吨级异常)', () => {
  it('适配表含 重量(kg)/计费重量(kg) 两键, 且位于吨制键(数量)之后', () => {
    const qty = FLOW_ADAPTERS['运输凭证']!.qtyFields;
    expect(qty).toContainEqual(['重量(kg)', 'kg']);
    expect(qty).toContainEqual(['计费重量(kg)', 'kg']);
    const iTon = qty.findIndex(([k]) => k === '数量');
    const iKg = qty.findIndex(([k]) => k === '重量(kg)');
    expect(iKg).toBeGreaterThan(iTon); // kg 键追加在吨制键之后, 不前置
  });

  it('派生: 仅 重量(kg)=57720 -> quantityTon=57.72(kg mass canonical/1000 出吨)', () => {
    const a = deriveAnchorsFromFields('运输凭证', wrap({ '重量(kg)': 57720 }));
    expect(a.quantity).toEqual({ value: 57720, unit: 'kg', dimension: 'mass', canonical: 57720 });
    expect(a.quantityTon).toBe(57.72);
  });

  it('派生: 重量_吨 与 重量(kg) 并存 -> 吨制键优先(100 而非 95)', () => {
    const a = deriveAnchorsFromFields('运输凭证', wrap({ 重量_吨: 100, '重量(kg)': 95000 }));
    expect(a.quantity).toEqual({ value: 100, unit: '吨', dimension: 'mass', canonical: 100000 });
    expect(a.quantityTon).toBe(100);
  });
});

describe('CONTRACT_TYPE_FLOW_DIRECTION', () => {
  it('采购: 货物收/资金付/发票收; 销售: 反向', () => {
    expect(CONTRACT_TYPE_FLOW_DIRECTION['采购']).toEqual({ 资金流: 'out', 货物流: 'in', 发票流: 'in' });
    expect(CONTRACT_TYPE_FLOW_DIRECTION['销售']).toEqual({ 资金流: 'in', 货物流: 'out', 发票流: 'out' });
  });
});
