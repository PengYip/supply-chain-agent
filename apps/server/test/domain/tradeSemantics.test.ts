import { describe, it, expect } from 'vitest';
import {
  TRADE_VOCAB,
  bindingRelationFor,
  CHUNK_TAG_TAXONOMY,
  getTaxonomy,
  settlesRelationFor,
  QUOTA_SCOPES,
  GRAPH_TRADE_EDGES,
  type TradeVocabulary,
} from '../../src/domain/tradeSemantics.js';

describe('tradeSemantics (L1 行业词汇表)', () => {
  describe('TRADE_VOCAB.roleByField', () => {
    it('maps 甲方/乙方 to 买方/卖方', () => {
      expect(TRADE_VOCAB.roleByField['甲方']).toBe('买方');
      expect(TRADE_VOCAB.roleByField['乙方']).toBe('卖方');
    });

    it('contains 发货人/收货人/承运人 with identity values', () => {
      for (const key of ['发货人', '收货人', '承运人']) {
        expect(TRADE_VOCAB.roleByField[key]).toBe(key);
      }
    });
  });

  it('contractFields contains exactly 合同号 and 合同编号', () => {
    expect(TRADE_VOCAB.contractFields.size).toBe(2);
    expect(TRADE_VOCAB.contractFields.has('合同号')).toBe(true);
    expect(TRADE_VOCAB.contractFields.has('合同编号')).toBe(true);
  });

  it('commodityFields contains exactly 标的物 and 商品', () => {
    expect(TRADE_VOCAB.commodityFields.size).toBe(2);
    expect(TRADE_VOCAB.commodityFields.has('标的物')).toBe(true);
    expect(TRADE_VOCAB.commodityFields.has('商品')).toBe(true);
  });

  it('executesDocTypes contains exactly 发票/提单/装箱单', () => {
    expect(TRADE_VOCAB.executesDocTypes.size).toBe(3);
    expect(TRADE_VOCAB.executesDocTypes.has('发票')).toBe(true);
    expect(TRADE_VOCAB.executesDocTypes.has('提单')).toBe(true);
    expect(TRADE_VOCAB.executesDocTypes.has('装箱单')).toBe(true);
  });

  describe('bindingRelationFor', () => {
    it('maps voucher types to binding relation semantics', () => {
      expect(bindingRelationFor('货转单')).toBe('货权转移');
      expect(bindingRelationFor('付款凭证')).toBe('付款');
      expect(bindingRelationFor('化验报告')).toBe('质检');
      expect(bindingRelationFor('其他')).toBe('凭证');
    });

    it('falls back when a custom vocab omits the voucher type', () => {
      const custom: TradeVocabulary = {
        ...TRADE_VOCAB,
        bindingRelationByVoucherType: { 货转单: '交付' },
        bindingRelationFallback: '默认凭证',
      };
      expect(bindingRelationFor('货转单', custom)).toBe('交付');
      expect(bindingRelationFor('付款凭证', custom)).toBe('默认凭证');
    });
  });

  describe('CHUNK_TAG_TAXONOMY / getTaxonomy', () => {
    it('covers all docType keys (B 方案质检汇总表后 28 类)', () => {
      expect(Object.keys(CHUNK_TAG_TAXONOMY).length).toBe(28);
    });

    it('returns 13 tags for 合同', () => {
      expect(getTaxonomy('合同').length).toBe(13);
    });

    it('returns empty arrays for 货转单 and 其他', () => {
      expect(getTaxonomy('货转单')).toEqual([]);
      expect(getTaxonomy('其他')).toEqual([]);
    });
  });
});

describe('settles/quota 受控词汇(spec 2026-08-25 方案A)', () => {
  it('settlesRelationFor: 六向映射', () => {
    expect(settlesRelationFor('资金流', 'in')).toBe('收款');
    expect(settlesRelationFor('资金流', 'out')).toBe('付款');
    expect(settlesRelationFor('货物流', 'in')).toBe('收货');
    expect(settlesRelationFor('货物流', 'out')).toBe('发货');
    expect(settlesRelationFor('发票流', 'in')).toBe('收票');
    expect(settlesRelationFor('发票流', 'out')).toBe('开票');
  });

  it('白名单外流族/未知方向 -> null(宁可空缺不猜)', () => {
    expect(settlesRelationFor('质检流', 'in')).toBeNull();
    expect(settlesRelationFor('资金流', 'sideways')).toBeNull();
  });

  it('QUOTA_SCOPES 受控值', () => {
    expect(QUOTA_SCOPES).toEqual(['counterparty', 'project']);
  });

  it('GRAPH_TRADE_EDGES 边名常量', () => {
    expect(GRAPH_TRADE_EDGES.correlates).toBe('correlates');
    expect(GRAPH_TRADE_EDGES.relates).toBe('relates');
    expect(GRAPH_TRADE_EDGES.trades).toBe('trades');
    expect(GRAPH_TRADE_EDGES.settles).toBe('settles');
    expect(GRAPH_TRADE_EDGES.granted).toBe('granted');
  });
});
