import { describe, it, expect } from 'vitest';
import { flowNodeTier, NOTICE_NODE_DOC_TYPES } from '../../src/domain/tradeSemantics.js';

describe('节点权威词汇(spec 2026-08-27 §15)', () => {
  it('预告节点 = 发货单/派船通知单', () => {
    expect(flowNodeTier('发货单')).toBe('notice');
    expect(flowNodeTier('派船通知单')).toBe('notice');
    expect(NOTICE_NODE_DOC_TYPES.has('收货单')).toBe(false);
  });

  it('实重节点 = 轨道衡/磅单/大票/收货单/货转单; 未知与空值保守按实重', () => {
    for (const t of ['轨道衡称重单', '汽运磅单', '火运大票', '收货单', '货转单', '发票', '未知类型']) {
      expect(flowNodeTier(t)).toBe('actual');
    }
    expect(flowNodeTier(null)).toBe('actual');
    expect(flowNodeTier(undefined)).toBe('actual');
  });
});
